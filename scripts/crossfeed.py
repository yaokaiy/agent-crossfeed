#!/usr/bin/env python3
"""Standalone crossfeed dispatcher (Python 3.9+, standard library only)."""

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import selectors
import shlex
import signal
import stat
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Optional


PREAMBLE_READ = (
    "Work only inside the given directory. Never push, commit or post to any service. "
    "Print no secrets. Answer in at most 40 lines with the conclusion, the evidence "
    "(file and line, or command output), and what is not done."
)
PREAMBLE_WRITE = PREAMBLE_READ + (
    " Change files only inside that directory and run the check the brief states."
)


def home() -> Path:
    configured = os.environ.get("CROSSFEED_HOME")
    if configured:
        directory = Path(configured)
    elif os.environ.get("CLAUDE_CONFIG_DIR"):
        directory = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "crossfeed"
    else:
        directory = Path.home() / ".claude" / "crossfeed"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    return directory


def new_job_id(now: datetime.datetime) -> str:
    return now.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)


def _create_job_dir(now: datetime.datetime) -> Path:
    jobs = home() / "jobs"
    jobs.mkdir(mode=0o700, exist_ok=True)
    for _ in range(5):
        directory = jobs / new_job_id(now)
        try:
            os.mkdir(directory, mode=0o700)
        except FileExistsError:
            continue
        return directory
    raise FileExistsError("could not allocate a job directory after 5 attempts")


def _write_ledger(ledger, record):
    record = dict(record)
    record.setdefault("v", 1)
    record.setdefault(
        "ts", datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    ledger.write(json.dumps(record, ensure_ascii=False) + "\n")
    ledger.flush()
    os.fsync(ledger.fileno())


def _private_open(path, mode, **kwargs):
    def opener(name, flags):
        fd = os.open(name, flags, 0o600)
        try:
            os.fchmod(fd, 0o600)
        except OSError:
            os.close(fd)
            raise
        return fd

    return open(path, mode, opener=opener, **kwargs)


def append_ledger(record: dict) -> None:
    with _private_open(home() / "ledger.jsonl", "a", encoding="utf-8") as ledger:
        fcntl.flock(ledger, fcntl.LOCK_EX)
        _write_ledger(ledger, record)


def read_ledger() -> list:
    try:
        ledger = (home() / "ledger.jsonl").open(encoding="utf-8")
    except FileNotFoundError:
        return []
    records = []
    with ledger:
        for line in ledger:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def write_state(job_dir: Path, state: dict) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=job_dir, delete=False
        ) as stream:
            temporary = Path(stream.name)
            json.dump(state, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, job_dir / "state.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _finite_number(value) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def parse_rate_limits(obj: dict) -> list:
    """Normalize app-server and session-log windows, preserving zero usage."""
    if not isinstance(obj, dict):
        return []
    windows = []
    for name in ("primary", "secondary"):
        window = obj.get(name)
        if not isinstance(window, dict):
            continue
        percent = window.get("usedPercent", window.get("used_percent"))
        minutes = window.get("windowDurationMins", window.get("window_minutes"))
        if not _finite_number(percent) or not _finite_number(minutes) or minutes <= 0:
            continue
        reset = window.get("resetsAt", window.get("resets_at"))
        windows.append({
            "minutes": minutes, "used_percent": percent,
            "resets_at": reset if _finite_number(reset) else None,
        })
    return windows


def _quota_result(source, limits, age_s):
    windows = parse_rate_limits(limits)
    if not windows:
        raise ValueError("no usable rate-limit windows")
    return {
        "source": source, "age_s": round(age_s),
        "limit_reached": limits.get("rateLimitReachedType") is not None,
        "error": None, "windows": windows,
    }


def _rpc_messages(stdout, selector, deadline):
    """Read bytes so even a partial JSON line remains subject to the deadline."""
    pending = b""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not selector.select(remaining):
            raise TimeoutError("timed out waiting for a reply")
        chunk = os.read(stdout.fileno(), 65536)
        if not chunk:
            raise ValueError("closed stdout before replying")
        lines = (pending + chunk).split(b"\n")
        pending = lines.pop()
        for line in lines:
            if time.monotonic() >= deadline:
                raise TimeoutError("timed out waiting for a reply")
            try:
                message = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(message, dict):
                yield message


def _rpc_result(messages, request_id):
    for message in messages:
        if message.get("id") != request_id:
            continue
        if message.get("error") is not None:
            raise ValueError("RPC error: {}".format(message["error"]))
        result = message.get("result")
        if not isinstance(result, dict):
            raise ValueError("invalid RPC result")
        return result
    raise ValueError("no RPC response")


def _send_rpc(stdin, message):
    stdin.write((json.dumps(message) + "\n").encode("utf-8"))
    stdin.flush()


def _app_server_quota(codex_bin, timeout_s):
    deadline = time.monotonic() + timeout_s
    # A file avoids deadlocking on a full stderr pipe while waiting for stdout.
    with tempfile.TemporaryFile() as stderr:
        child = subprocess.Popen(
            [codex_bin, "app-server"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=stderr,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                messages = _rpc_messages(child.stdout, selector, deadline)
                _send_rpc(child.stdin, {
                    "id": 1, "method": "initialize",
                    "params": {"clientInfo": {"name": "crossfeed", "version": "0.1.0"}},
                })
                _rpc_result(messages, 1)
                _send_rpc(child.stdin, {"method": "initialized", "params": {}})
                _send_rpc(child.stdin, {"id": 2, "method": "account/rateLimits/read"})
                result = _rpc_result(messages, 2)
                return _quota_result("app-server", result.get("rateLimits"), 0)
        except (OSError, ValueError) as error:
            stderr.seek(0, os.SEEK_END)
            stderr.seek(max(0, stderr.tell() - 4096))
            detail = stderr.read().decode("utf-8", errors="replace").strip()
            raise ValueError("{}{}".format(error, ": " + detail if detail else "")) from error
        finally:
            try:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            finally:
                child.stdin.close()
                child.stdout.close()


def _reverse_lines(stream):
    """Scan a rollout from its tail without loading the entire log."""
    position = stream.seek(0, os.SEEK_END)
    pending = b""
    while position:
        size = min(position, 65536)
        position -= size
        stream.seek(position)
        lines = (stream.read(size) + pending).split(b"\n")
        pending = lines[0]
        yield from reversed(lines[1:])
    if pending:
        yield pending


def _event_time(event, mtime):
    stamp = event.get("timestamp")
    if not isinstance(stamp, str):
        return mtime
    try:
        parsed = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return mtime


def _log_quota():
    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    candidates = []
    for path in (codex_home / "sessions").rglob("rollout-*.jsonl"):
        try:
            candidates.append((path.stat().st_mtime, path))
        except OSError:
            continue
    for mtime, path in sorted(candidates, reverse=True)[:8]:
        try:
            with path.open("rb") as stream:
                for line in _reverse_lines(stream):
                    if b'"rate_limits"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                        if not isinstance(event, dict):
                            continue
                        payload = event.get("payload", event)
                        if not isinstance(payload, dict):
                            continue
                        return _quota_result(
                            "log", payload.get("rate_limits"),
                            time.time() - _event_time(event, mtime),
                        )
                    except (ValueError, UnicodeError):
                        continue
        except OSError:
            continue
    raise ValueError("no usable rate_limits in the newest 8 session logs")


def read_quota(codex_bin: str = "codex", timeout_s: float = 10.0) -> dict:
    try:
        if not _finite_number(timeout_s) or timeout_s <= 0:
            raise ValueError("timeout must be a positive finite number")
        return _app_server_quota(codex_bin, timeout_s)
    except (OSError, ValueError) as error:
        app_error = "{} app-server: {}".format(codex_bin, error)
    try:
        return _log_quota()
    except (OSError, ValueError) as error:
        return {
            "source": "none", "age_s": 0, "limit_reached": False,
            "error": "{}; {}".format(app_error, error), "windows": [],
        }


def cap_text(text: str, max_lines: int = 60, max_bytes: int = 8192) -> tuple:
    kept = []
    size = 0
    for line in text.splitlines(keepends=True):
        length = len(line.encode("utf-8"))
        if len(kept) >= max_lines or size + length > max_bytes:
            break
        kept.append(line)
        size += length
    capped = "".join(kept)
    return capped, len(capped) != len(text)


def parse_events(lines) -> dict:
    parsed = {"thread": None, "tokens": {"input": 0, "cached": 0, "output": 0, "reasoning": 0},
              "last_message": "", "errors": []}
    token_fields = {"input": "input_tokens", "cached": "cached_input_tokens",
                    "output": "output_tokens", "reasoning": "reasoning_output_tokens"}
    for line in lines:
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "thread.started" and isinstance(event.get("thread_id"), str):
            parsed["thread"] = event["thread_id"]
        elif kind == "item.completed":
            item = event.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message" and isinstance(item.get("text"), str):
                parsed["last_message"] = item["text"]
        elif kind == "turn.completed" and isinstance(event.get("usage"), dict):
            for name, field in token_fields.items():
                value = event["usage"].get(field)
                if type(value) is int and value >= 0:
                    parsed["tokens"][name] += value
        elif kind in ("error", "turn.failed"):
            error = event if kind == "error" else event.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                parsed["errors"].append(error["message"])
    return parsed


def is_usage_limit(errors: list) -> bool:
    return any("hit your usage limit" in message.lower() for message in errors)


def _signal_group(pid, signum):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass


def _stop_process_group(child):
    _signal_group(child.pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        child.poll()  # Reap the direct child while waiting for its descendants.
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    _signal_group(child.pid, signal.SIGKILL)
    child.wait()


@contextlib.contextmanager
def _job_interrupts():
    # A flag avoids exceptions between spawning a child and retaining its PID.
    interrupted = [False]

    def interrupt(signum, frame):
        interrupted[0] = True

    previous = {}
    try:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[signum] = signal.signal(signum, interrupt)
        yield interrupted
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _execute_job(command, directory, job_dir, brief, timeout_s, interrupted):
    with _private_open(job_dir / "events.jsonl", "wb") as events, _private_open(job_dir / "stderr.log", "wb") as errors:
        with _private_open(job_dir / "result.md", "wb"):
            pass
        try:
            child = subprocess.Popen(command, cwd=directory, stdin=subprocess.PIPE,
                                     stdout=events, stderr=errors, start_new_session=True, umask=0o077)
        except OSError as error:
            errors.write(("could not start codex: {}\n".format(error)).encode("utf-8"))
            return 1, False
        try:
            deadline = time.monotonic() + timeout_s
            pending = brief
            while True:
                if interrupted[0]:
                    _stop_process_group(child)
                    return 130, False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _stop_process_group(child)
                    return 124, True
                try:
                    child.communicate(input=pending, timeout=min(0.1, remaining))
                    if interrupted[0]:
                        _stop_process_group(child)
                        return 130, False
                    return child.returncode, False
                except subprocess.TimeoutExpired:
                    # communicate retains any unwritten input across retries.
                    pending = None
        finally:
            child.stdin.close()


def _codex_command(args, job_dir, resume_thread):
    sandbox = "workspace-write" if args.write else "read-only"
    if resume_thread:
        return ["codex", "exec", "resume", resume_thread, "--skip-git-repo-check", "--json",
                "-c", 'sandbox_mode="{}"'.format(sandbox),
                "-c", 'model_reasoning_effort="{}"'.format(args.effort),
                "-o", str(job_dir / "result.md"), "-"]
    command = ["codex", "exec", "--skip-git-repo-check", "--json", "-s", sandbox,
               "-C", args.dir, "-c", 'model_reasoning_effort="{}"'.format(args.effort),
               "-o", str(job_dir / "result.md")]
    if args.model:
        command.extend(["-m", args.model])
    if args.worktree:
        command.append("--worktree")
    return command + ["-"]


def _print_changes(change_list, error):
    if error:
        print("[crossfeed] change list unavailable: {}".format(error))
        return
    if change_list is None:
        print("[crossfeed] not a git repository: no change list")
        return
    paths = change_list["changed"]
    if paths:
        extra = " (+{} more)".format(len(paths) - 10) if len(paths) > 10 else ""
        print("[crossfeed] changed {} file(s): {}{}".format(len(paths), ", ".join(paths[:10]), extra))
    else:
        print("[crossfeed] no files changed")
    if change_list["head_moved"]:
        print("[crossfeed] WARNING: HEAD moved during the job, so a commit was made")


def _print_job(record, job_dir, result, errors, timeout_minutes, change_list, change_error, error_events):
    if record["status"] == "done":
        text, truncated = cap_text(result)
        if text and not text.endswith("\n") and len(text.encode("utf-8")) == 8192:
            text, truncated = cap_text(result, max_bytes=8191)
        if text:
            print(text, end="" if text.endswith("\n") else "\n")
        if truncated:
            print("[crossfeed] result truncated: full text in {}".format(job_dir / "result.md"))
    minutes, seconds = divmod(int(record["wall_s"]), 60)
    print("[crossfeed] job {} {} in {}m{:02d}s; tier {}; kind {}; sandbox {}; codex tokens {}".format(
        record["id"], record["status"], minutes, seconds, record["tier"], record["kind"],
        record["sandbox"], record["tokens"]["input"] + record["tokens"]["output"]))
    if record["status"] == "done" and error_events:
        print("[crossfeed] codex reported {} recoverable error event(s); see {}".format(
            error_events, job_dir / "events.jsonl"))
    if record["worktree"]:
        print("[crossfeed] worktree job: changes are in Codex's managed worktree, not in {}".format(record["dir"]))
    elif record["sandbox"] == "workspace-write":
        _print_changes(change_list, change_error)
    if record["status"] == "done":
        print("[crossfeed] full result: {}".format(job_dir / "result.md"))
        print("[crossfeed] record the outcome: python3 -I {} check {} -- <your check command>".format(
            shlex.quote(str(Path(__file__).resolve())), record["id"]))
    elif record["status"] == "failed":
        print("[crossfeed] last log lines:")
        for line in errors[-20:]:
            print(line)
    elif record["status"] == "limit":
        print("[crossfeed] Codex reported its usage limit. Do not retry on Codex; do this work on Claude.")
    elif record["status"] == "interrupted":
        print("[crossfeed] interrupted; Codex was stopped.")
    else:
        print("[crossfeed] stopped after {:g} minutes.".format(timeout_minutes))


def _git(directory, *args):
    return subprocess.run(["git", "-c", "core.quotepath=off", "-C", str(directory), *args],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _file_digest(path):
    digest = hashlib.sha1()
    try:
        mode = os.lstat(path).st_mode
        if stat.S_ISLNK(mode):
            return "link:" + os.readlink(path)
        if stat.S_ISDIR(mode):
            return _directory_digest(path)
        if not stat.S_ISREG(mode):
            return "special"
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(65536), b""):
                digest.update(chunk)
    except FileNotFoundError:
        return "deleted"
    return digest.hexdigest()


def _directory_digest(path):
    root = _git(path, "rev-parse", "--show-toplevel")
    if root.returncode or Path(os.fsdecode(root.stdout.rstrip(b"\n"))).resolve() != path.resolve():
        return "dir"
    head = _git(path, "rev-parse", "--verify", "HEAD")
    status = _git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if status.returncode:
        raise OSError("git status failed: {}".format(os.fsdecode(status.stderr).strip()))
    digest = "submodule:{}:{}".format(
        head.stdout.decode().strip() if head.returncode == 0 else "unborn",
        hashlib.sha1(status.stdout).hexdigest())
    # Porcelain does not change when an already-dirty file is edited again.
    # Include its contents, recursively including nested submodules.
    files = _status_files(path, status.stdout)
    if files:
        digest += ":" + hashlib.sha1(json.dumps(files, sort_keys=True).encode("utf-8")).hexdigest()
    return digest


def _status_files(root_path, status):
    files = {}
    entries = iter(status.split(b"\0"))
    for entry in entries:
        if not entry:
            continue
        names = [entry[3:]]
        if b"R" in entry[:2] or b"C" in entry[:2]:
            names.append(next(entries))
        for name in names:
            path = os.fsdecode(name)
            files[path] = _file_digest(root_path / path)
    return files


def snapshot(directory: str) -> Optional[dict]:
    directory = Path(directory).resolve()
    try:
        root = _git(directory, "rev-parse", "--show-toplevel")
    except FileNotFoundError:
        return None
    if root.returncode:
        return None
    root_path = Path(os.fsdecode(root.stdout.rstrip(b"\n")))
    head = _git(directory, "rev-parse", "--verify", "HEAD")
    status = _git(directory, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", str(directory))
    if status.returncode:
        raise OSError("git status failed: {}".format(os.fsdecode(status.stderr).strip()))
    return {"head": head.stdout.decode().strip() if head.returncode == 0 else None,
            "files": _status_files(root_path, status.stdout)}


def changes(before: dict, after: dict) -> dict:
    paths = before["files"].keys() | after["files"].keys()
    return {
        "changed": sorted(path for path in paths if before["files"].get(path) != after["files"].get(path)),
        "head_moved": before["head"] != after["head"],
    }


def _prepare_run(args):
    thread = None
    if args.resume is not None:
        if args.worktree:
            raise ValueError("--resume cannot be combined with --worktree")
        if args.model is not None:
            raise ValueError("--model cannot be overridden with --resume")
        prior = next((record for record in reversed(read_ledger()) if isinstance(record, dict)
                      and record.get("type") == "job" and record.get("id") == args.resume), None)
        if prior is None:
            raise ValueError("unknown job: {}".format(args.resume))
        thread = prior.get("codex_thread")
        if not isinstance(thread, str) or not thread:
            raise ValueError("job has no Codex thread: {}".format(args.resume))
        if not isinstance(prior.get("dir"), str) or not prior["dir"] or prior.get("sandbox") not in ("read-only", "workspace-write"):
            raise ValueError("job has no valid directory or sandbox: {}".format(args.resume))
        args.dir = prior["dir"]
        args.write = prior["sandbox"] == "workspace-write"
        args.model = prior.get("model")
    args.dir = str(Path(args.dir).resolve())
    if not Path(args.dir).is_dir():
        raise ValueError("directory does not exist: {}".format(args.dir))
    if not _finite_number(args.timeout) or args.timeout <= 0:
        raise ValueError("timeout must be a positive finite number")
    return thread


def _job_status(code, timed_out, result, errors):
    if timed_out:
        return "timeout", 124
    if code and is_usage_limit(errors):
        return "limit", 75
    if code:
        if not errors:
            errors.append("codex exited {} without error details".format(code))
        return "failed", 1
    if not result:
        errors.append("[crossfeed] Codex exited 0 without a result.")
        return "failed", 1
    return "done", 0


def _run_allocated_job(args, job_dir, now, brief, resume_thread, interrupted):
    start = time.monotonic()
    record = {
        "type": "job", "id": job_dir.name, "session": args.session, "kind": args.kind,
        "tier": args.tier, "dir": args.dir, "sandbox": "workspace-write" if args.write else "read-only",
        "worktree": args.worktree, "effort": args.effort, "model": args.model,
        "started": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "wall_s": 0,
        "status": "running", "exit": None,
        "tokens": {"input": 0, "cached": 0, "output": 0, "reasoning": 0},
        "codex_thread": resume_thread, "changed": None, "head_moved": False, "resume_of": args.resume,
    }
    errors = []
    error_events = 0
    result = ""
    change_list = change_error = None
    code, timed_out = 1, False
    try:
        with _private_open(job_dir / "brief.md", "wb") as stream:
            stream.write(brief)
        write_state(job_dir, record)
        before = snapshot(args.dir) if args.write and not args.worktree else None
        preamble = PREAMBLE_WRITE if args.write else PREAMBLE_READ
        code, timed_out = _execute_job(_codex_command(args, job_dir, resume_thread), args.dir, job_dir,
                                      preamble.encode("utf-8") + b"\n\n" + brief, args.timeout * 60, interrupted)
        with (job_dir / "events.jsonl").open("rb") as events:
            parsed = parse_events(events)
        error_events = len(parsed["errors"])
        record["tokens"] = parsed["tokens"]
        record["codex_thread"] = parsed["thread"] or resume_thread
        stderr = (job_dir / "stderr.log").read_text(encoding="utf-8", errors="replace")
        errors = [line for message in parsed["errors"] for line in message.splitlines()] + stderr.splitlines()
        result_path = job_dir / "result.md"
        result = result_path.read_text(encoding="utf-8", errors="replace") if result_path.exists() else ""
        after = snapshot(args.dir) if args.write and not args.worktree else None
        if before is not None and after is not None:
            change_list = changes(before, after)
            record["changed"] = len(change_list["changed"])
            record["head_moved"] = change_list["head_moved"]
    except OSError as error:
        code = 1
        errors.append("crossfeed: {}".format(error))
        if args.write and change_list is None:
            change_error = str(error)
    record["status"], record["exit"] = ("interrupted", 130) if interrupted[0] else _job_status(code, timed_out, result, errors)
    record["wall_s"] = time.monotonic() - start
    write_state(job_dir, record)
    append_ledger(record)
    _print_job(record, job_dir, result, errors, args.timeout, change_list, change_error, error_events)
    return record["exit"]


def _run(args) -> int:
    try:
        brief = Path(args.brief_file).read_bytes() if args.brief_file is not None else sys.stdin.buffer.read()
    except OSError as error:
        print("crossfeed: could not read brief: {}".format(error), file=sys.stderr)
        return 2
    if not brief.strip():
        print("crossfeed: brief must not be empty", file=sys.stderr)
        return 2
    try:
        resume_thread = _prepare_run(args)
    except ValueError as error:
        print("crossfeed: {}".format(error), file=sys.stderr)
        return 2
    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        job_dir = _create_job_dir(now)
        with _job_interrupts() as interrupted:
            return _run_allocated_job(args, job_dir, now, brief, resume_thread, interrupted)
    except OSError as error:
        print("crossfeed: {}".format(error), file=sys.stderr)
        return 1


def _stash(args) -> int:
    brief = sys.stdin.buffer.read()
    if not brief.strip():
        raise ValueError("brief must not be empty")
    directory = home().resolve() / "briefs"
    directory.mkdir(mode=0o700, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    for _ in range(5):
        path = directory / (new_job_id(now) + ".md")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(brief)
        except OSError:
            path.unlink()
            raise
        print(path)
        return 0
    raise FileExistsError("could not allocate a brief after 5 attempts")


def _check(args) -> int:
    known = any(isinstance(record, dict) and record.get("type") == "job"
                and record.get("id") == args.job for record in read_ledger())
    if not known:
        raise ValueError("unknown job: {}".format(args.job))
    command = args.check_command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        raise ValueError("check requires a command")
    try:
        code = subprocess.run(command).returncode
        if code < 0:
            code = 128 - code
    except (OSError, ValueError) as error:
        print("crossfeed: could not start check command: {}".format(error), file=sys.stderr)
        code = 127
    append_ledger({"type": "check", "id": args.job, "verdict": "pass" if code == 0 else "fail",
                   "exit": code, "cmd": Path(command[0]).name})
    return code


def _parse_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=datetime.timezone.utc)


def _lockout(args) -> int:
    if args.reset_at != "unknown" and _parse_timestamp(args.reset_at) is None:
        raise ValueError("--reset-at must be an ISO-8601 timestamp or unknown")
    # The read and append share one lock, so concurrent sessions cannot duplicate a lockout.
    with _private_open(home() / "ledger.jsonl", "a", encoding="utf-8") as ledger:
        fcntl.flock(ledger, fcntl.LOCK_EX)
        if args.reset_at != "unknown" and any(
            isinstance(record, dict) and record.get("type") == "lockout"
            and record.get("reset_at") == args.reset_at for record in read_ledger()
        ):
            return 0
        _write_ledger(ledger, {"type": "lockout", "reset_at": args.reset_at, "session": args.session})
    return 0


def _first_checks(records):
    checks = {}
    for record in records:
        if (isinstance(record, dict) and record.get("type") == "check"
                and isinstance(record.get("id"), str) and record.get("verdict") in ("pass", "fail")):
            checks.setdefault(record["id"], record["verdict"])
    return checks


def _fold_job(summary, record, checks, walls):
    summary["jobs"] += 1
    summary["by_status"][record["status"]] += 1
    verdict = checks.get(record["id"])
    if verdict is None:
        summary["unchecked"] += 1
    tier = record.get("tier")
    if tier in ("A", "B"):
        counts = summary["by_tier"][tier]
        counts["jobs"] += 1
        counts["checked"] += int(verdict is not None)
        counts["passed"] += int(verdict == "pass")
    tokens = record.get("tokens")
    if isinstance(tokens, dict):
        for name in ("input", "output"):
            value = tokens.get(name)
            if type(value) is int and value >= 0:
                summary["tokens"] += value
    wall = record.get("wall_s")
    if _finite_number(wall) and wall >= 0:
        walls.append(wall)


def fold(records: list, since: datetime.datetime) -> dict:
    """Summarize jobs and lockouts since the cutoff, retaining each job's first verdict."""
    if since.tzinfo is None:
        since = since.replace(tzinfo=datetime.timezone.utc)
    summary = {
        "lockouts": 0, "locked_s": 0, "unknown_resets": 0, "jobs": 0,
        "by_status": {"done": 0, "failed": 0, "limit": 0, "timeout": 0, "interrupted": 0},
        "by_tier": {"A": {"jobs": 0, "checked": 0, "passed": 0},
                    "B": {"jobs": 0, "checked": 0, "passed": 0}},
        "tokens": 0, "median_wall_s": None, "unchecked": 0,
    }
    checks = _first_checks(records)
    walls = []
    for record in records:
        if not isinstance(record, dict):
            continue
        timestamp = _parse_timestamp(record.get("ts"))
        if timestamp is None or timestamp < since:
            continue
        if record.get("type") == "lockout":
            summary["lockouts"] += 1
            reset = _parse_timestamp(record.get("reset_at"))
            if reset is None:
                summary["unknown_resets"] += 1
            else:
                summary["locked_s"] += max(0, int((reset - timestamp).total_seconds()))
        elif (record.get("type") == "job" and isinstance(record.get("id"), str)
              and record.get("status") in ("done", "failed", "limit", "timeout", "interrupted")):
            _fold_job(summary, record, checks, walls)
    if walls:
        summary["median_wall_s"] = float(statistics.median(walls))
    return summary


def _report_text(summary, days):
    hours, minutes = divmod(summary["locked_s"] // 60, 60)
    median = summary["median_wall_s"]
    if median is None:
        median_text = "n/a"
    else:
        wall_minutes, seconds = divmod(int(median), 60)
        median_text = "{}m{:02d}s".format(wall_minutes, seconds)
    statuses = summary["by_status"]
    tier_a, tier_b = summary["by_tier"]["A"], summary["by_tier"]["B"]
    return "\n".join([
        "crossfeed report, last {} days".format(days),
        "lockouts: {}; locked: {}h{:02d}m; unknown resets: {}".format(
            summary["lockouts"], hours, minutes, summary["unknown_resets"]),
        "jobs: {} (done {}, failed {}, limit {}, timeout {}, interrupted {}); codex tokens: {}; median: {}".format(
            summary["jobs"], statuses["done"], statuses["failed"], statuses["limit"], statuses["timeout"],
            statuses["interrupted"], summary["tokens"], median_text),
        "first-delivery checks: A {}/{}, B {}/{}; unchecked: {}".format(
            tier_a["passed"], tier_a["checked"], tier_b["passed"], tier_b["checked"], summary["unchecked"]),
    ])


def _report(args) -> int:
    if args.days <= 0:
        raise ValueError("--days must be a positive integer")
    try:
        since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=args.days)
    except OverflowError as error:
        raise ValueError("--days is too large") from error
    summary = fold(read_ledger(), since)
    print(json.dumps(summary) if args.json else _report_text(summary, args.days))
    return 0


def main(argv) -> int:
    parser = argparse.ArgumentParser(prog="crossfeed")
    parser.add_argument("--version", action="version", version="crossfeed 0.1.0")
    subcommands = parser.add_subparsers(dest="command", required=True)
    stash = subcommands.add_parser("stash")
    stash.set_defaults(handler=_stash)
    check = subcommands.add_parser("check")
    check.add_argument("job")
    check.add_argument("check_command", nargs=argparse.REMAINDER)
    check.set_defaults(handler=_check)
    lockout = subcommands.add_parser("lockout")
    lockout.add_argument("--reset-at", required=True)
    lockout.add_argument("--session")
    lockout.set_defaults(handler=_lockout)
    report = subcommands.add_parser("report")
    report.add_argument("--days", type=int, default=7)
    report.add_argument("--json", action="store_true")
    report.set_defaults(handler=_report)
    run = subcommands.add_parser("run")
    run.add_argument("--kind", default="task")
    run.add_argument("--tier", choices=("A", "B"), default="B")
    run.add_argument("--dir", default=os.getcwd())
    run.add_argument("--write", action="store_true")
    run.add_argument("--worktree", action="store_true")
    run.add_argument("--effort", choices=("low", "medium", "high", "xhigh", "max"), default="high")
    run.add_argument("--model", default=None)
    run.add_argument("--timeout", type=float, default=30)
    run.add_argument("--resume")
    run.add_argument("--session")
    run.add_argument("--brief-file")
    quota = subcommands.add_parser("quota")
    quota.add_argument("--timeout", type=float, default=10.0, metavar="SECONDS")
    args = parser.parse_args(argv)
    if args.command == "run":
        return _run(args)
    if args.command == "quota":
        print(json.dumps(read_quota(timeout_s=args.timeout), ensure_ascii=False))
        return 0
    try:
        return args.handler(args)
    except ValueError as error:
        print("crossfeed: {}".format(error), file=sys.stderr)
        return 2
    except OSError as error:
        print("crossfeed: {}".format(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
