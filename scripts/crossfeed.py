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
import re
import secrets
import selectors
import shlex
import shutil
import signal
import stat
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


PREAMBLE_READ = (
    "Work only inside the given directory. Never push, commit or post to any service. "
    "Print no secrets. Answer in at most 40 lines with the conclusion, the evidence "
    "(file and line, or command output), and what is not done."
)
PREAMBLE_WRITE = PREAMBLE_READ + (
    " Change files only inside that directory and run the check the brief states."
)


# Returned by _execute_job in place of an exit status when codex was not found.
# A started process that itself exits with 127 is an ordinary failure.
CODEX_NOT_FOUND = -127

CLAUDE_PATHS = ("~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude")
MODEL_FAMILIES = ("fable", "opus", "sonnet", "haiku")
USAGE_LINE = re.compile(
    r"^\s*Current week \((?P<label>[^)]+)\):\s*(?P<pct><1|\d+(?:\.\d+)?)%\s*used\s*"
    r"(?:[·|\-]\s*)?resets\s+(?P<when>.+?)\s*$", re.IGNORECASE)


def resolve_claude() -> str:
    explicit = os.environ.get("CROSSFEED_CLAUDE")
    if explicit:
        path = Path(explicit).expanduser().absolute()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        raise FileNotFoundError("CROSSFEED_CLAUDE={!r} is not an executable file".format(explicit))
    found = shutil.which("claude")
    if found:
        return os.path.abspath(found)
    paths = [Path(path).expanduser() for path in CLAUDE_PATHS]
    for path in paths:
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise FileNotFoundError("claude was not found; looked in PATH and {}".format(
        ", ".join(str(path) for path in paths)))


def parse_reset(when: str, now: datetime.datetime) -> Optional[int]:
    match = re.fullmatch(
        r"\s*(?:([A-Za-z]{3})\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*"
        r"(am|pm)\s*\(([^)]+)\)\s*", when, re.IGNORECASE)
    if not match:
        return None
    month, day, hour, minute, meridiem, zone = match.groups()
    hour, minute = int(hour), int(minute or 0)
    if not 1 <= hour <= 12 or not 0 <= minute < 60:
        return None
    try:
        timezone = ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    local = now.astimezone(timezone)
    hour = hour % 12 + (12 if meridiem.lower() == "pm" else 0)
    if month:
        months = "jan feb mar apr may jun jul aug sep oct nov dec".split()
        if month.lower() not in months:
            return None
        for year in (local.year - 1, local.year, local.year + 1):
            try:
                reset = datetime.datetime(year, months.index(month.lower()) + 1, int(day),
                                          hour, minute, tzinfo=timezone)
            except ValueError:
                continue
            if now.timestamp() - 86400 <= reset.timestamp() <= now.timestamp() + 8 * 86400:
                return int(reset.timestamp())
        return None
    reset = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    candidates = []
    for days in (0, 1):
        for fold in (0, 1):
            candidate = (reset + datetime.timedelta(days=days)).replace(fold=fold).timestamp()
            if candidate >= now.timestamp() - 60:
                candidates.append(int(candidate))
    return min(candidates) if candidates else None


def _clean_usage_text(text):
    # CSI (including colour) and OSC terminal escapes, plus the UTF-8 BOM.
    return re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))", "", text).replace("\ufeff", "")


def parse_usage_text(text: str, now: datetime.datetime) -> list:
    buckets = []
    for line in _clean_usage_text(text).splitlines():
        match = USAGE_LINE.fullmatch(line)
        if not match:
            continue
        label = match["label"].strip()
        if not label or label.lower() == "all models":
            continue
        percent = 0.0 if match["pct"] == "<1" else float(match["pct"])
        if not math.isfinite(percent):
            continue
        buckets.append({"label": label,
                        "family": next((family for family in MODEL_FAMILIES if family in label.lower()), None),
                        "used_percent": percent, "resets_at": parse_reset(match["when"], now)})
    return buckets


def _probe_claude_usage(directory, timeout_s):
    command = [resolve_claude(), "-p", "/usage", "--output-format", "json",
               "--no-session-persistence", "--setting-sources", "project"]
    # Keep the PID: subprocess.run hides it, preventing group cleanup on timeout.
    with subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          start_new_session=True) as child:
        try:
            stdout, _ = child.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            _signal_group(child.pid, signal.SIGKILL)
            child.communicate()
            raise TimeoutError("claude usage timed out after {:g} seconds".format(timeout_s))
    if child.returncode:
        raise ValueError("claude usage exited {}".format(child.returncode))
    text = _clean_usage_text(stdout.decode("utf-8"))
    try:
        value = json.loads(text)
    except ValueError:
        pass  # Older CLI versions may print the usage text directly.
    else:
        if not isinstance(value, dict) or not isinstance(value.get("result"), str):
            raise ValueError("claude usage JSON has no result string")
        text = _clean_usage_text(value["result"])
    now = datetime.datetime.fromtimestamp(time.time(), datetime.timezone.utc)
    buckets = parse_usage_text(text, now)
    if not buckets and not re.search(r"^\s*Current session:\s*(?:<1|\d+(?:\.\d+)?)%\s*used\b",
                                     text, re.IGNORECASE | re.MULTILINE):
        raise ValueError("claude usage has no matching lines")
    return {"source": "usage", "error": None, "buckets": buckets}


def _cached_claude_usage(path, now):
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(cached, dict) or not _finite_number(cached.get("read_at")):
            return None
        result = cached.get("result")
        if not isinstance(result, dict) or result.get("source") not in ("usage", "none"):
            return None
        buckets = result.get("buckets")
        if not isinstance(buckets, list):
            return None
        if result["source"] == "none":
            if buckets or not isinstance(result.get("error"), str) or not result["error"].strip():
                return None
            if len(result["error"].splitlines()) != 1:
                return None
        elif result.get("error") is not None:
            return None
        for bucket in buckets:
            if (not isinstance(bucket, dict) or not isinstance(bucket.get("label"), str)
                    or not bucket["label"].strip() or bucket.get("family") not in (*MODEL_FAMILIES, None)
                    or not _finite_number(bucket.get("used_percent")) or bucket["used_percent"] < 0
                    or (bucket.get("resets_at") is not None and type(bucket["resets_at"]) is not int)):
                return None
            if bucket.get("resets_at") is not None and bucket["resets_at"] <= now:
                return None
        age = now - cached["read_at"]
        if 0 <= age < (300 if result["source"] == "usage" else 60):
            return dict(result, age_s=int(age))
    except (OSError, ValueError, UnicodeError):
        pass
    return None


def read_claude_usage(fresh: bool = False, timeout_s: float = 20.0) -> dict:
    if not _finite_number(timeout_s) or timeout_s <= 0:
        raise ValueError("timeout must be a positive finite number")
    try:
        directory = home().resolve()
        path = directory / "claude-usage.json"
        with _private_open(directory / "claude-usage.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            # Another session may have refreshed the cache while we waited.
            read_at = time.time()
            cached = None if fresh else _cached_claude_usage(path, read_at)
            if cached is not None:
                return cached
            try:
                result = _probe_claude_usage(directory, timeout_s)
            except (OSError, ValueError, UnicodeError) as error:
                result = {"source": "none", "buckets": [], "error": " ".join(str(error).splitlines())}
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                                 delete=False) as stream:
                    temporary = Path(stream.name)
                    os.fchmod(stream.fileno(), 0o600)
                    json.dump({"read_at": read_at, "result": result}, stream, ensure_ascii=False)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
            except OSError:
                pass  # Cache storage failure must not discard a usable live reading.
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass
    except (OSError, ValueError, UnicodeError) as error:
        result = {"source": "none", "buckets": [], "error": " ".join(str(error).splitlines())}
    return dict(result, age_s=0)


def _claude_usage(args) -> int:
    print(json.dumps(read_claude_usage(args.fresh, args.timeout), ensure_ascii=False))
    return 0


def resolve_codex(codex_bin: Optional[str] = None) -> str:
    """Find an executable, retaining its install directory through symlinks."""
    configured = os.environ.get("CROSSFEED_CODEX")
    explicit = configured or codex_bin
    if explicit:
        path = Path(os.path.abspath(os.path.expanduser(explicit)))
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        name = "CROSSFEED_CODEX" if configured else "codex executable"
        raise FileNotFoundError(
            "codex was not found: {}={!r} is not an executable regular file".format(name, explicit)
        )
    found = shutil.which("codex")
    if found:
        return os.path.abspath(found)
    if "CROSSFEED_CODEX_DIRS" in os.environ:
        directories = os.environ["CROSSFEED_CODEX_DIRS"].split(os.pathsep)
    else:
        directories = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin",
                       "~/.local/bin", "~/.npm-global/bin", "~/.bun/bin", "~/.volta/bin"]
    directories = [os.path.abspath(os.path.expanduser(entry)) for entry in directories if entry]
    for directory in directories:
        path = Path(directory) / "codex"
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise FileNotFoundError(
        "codex was not found; set CROSSFEED_CODEX to an executable file; "
        "looked in PATH={!r} and fallback directories {!r}".format(
            os.environ.get("PATH", os.defpath), directories)
    )


def _codex_environment(codex_bin):
    """Let an npm-installed codex find `node` beside it when PATH lacks that directory."""
    environment = os.environ.copy()
    directory = os.path.dirname(codex_bin)
    path = environment.get("PATH", os.defpath)
    # A directory that is already listed keeps its place: reordering PATH would
    # change which tools the job itself resolves.
    if directory not in path.split(os.pathsep):
        environment["PATH"] = directory + (os.pathsep + path if path else "")
    return environment


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


def _last_job(job_id):
    return next((record for record in reversed(read_ledger()) if isinstance(record, dict)
                 and record.get("type") == "job" and record.get("id") == job_id), None)


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
        "error": None, "windows": windows, "app_server_error": None,
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
            stdout=subprocess.PIPE, stderr=stderr, env=_codex_environment(codex_bin),
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                messages = _rpc_messages(child.stdout, selector, deadline)
                _send_rpc(child.stdin, {
                    "id": 1, "method": "initialize",
                    "params": {"clientInfo": {"name": "crossfeed", "version": "0.2.1"}},
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


def read_quota(codex_bin: Optional[str] = None, timeout_s: float = 10.0) -> dict:
    try:
        if not _finite_number(timeout_s) or timeout_s <= 0:
            raise ValueError("timeout must be a positive finite number")
        return _app_server_quota(resolve_codex(codex_bin), timeout_s)
    except (OSError, ValueError) as error:
        app_error = " ".join("codex app-server: {}".format(error).split())[:300]
    try:
        reading = _log_quota()
        reading["app_server_error"] = app_error
        return reading
    except (OSError, ValueError) as error:
        return {
            "source": "none", "age_s": 0, "limit_reached": False,
            "error": "{}; {}".format(app_error, error), "windows": [],
            "app_server_error": app_error,
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
        # Resolved apart from the launch: Popen also raises FileNotFoundError for
        # other reasons, and only a missing codex is exit code 127.
        try:
            command = [resolve_codex(), *command[1:]]
        except FileNotFoundError as error:
            errors.write((" ".join(str(error).splitlines()) + "\n").encode("utf-8"))
            return CODEX_NOT_FOUND, False
        try:
            child = subprocess.Popen(command, cwd=directory, stdin=subprocess.PIPE,
                                     stdout=events, stderr=errors, start_new_session=True, umask=0o077,
                                     env=_codex_environment(command[0]))
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
        script = shlex.quote(str(Path(__file__).resolve()))
        if record["sandbox"] == "read-only":
            print("[crossfeed] once you have checked its claims, record whether you used this result: "
                  "python3 -I {} used {} <yes|partly|no>".format(script, record["id"]))
        else:
            print("[crossfeed] record the outcome: python3 -I {} check {} -- <your check command>".format(
                script, record["id"]))
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
    if args.cause is not None and re.fullmatch(r"[A-Za-z0-9-]{1,32}", args.cause) is None:
        raise ValueError("--cause must be 1 to 32 letters, digits or hyphens")
    if args.resume is not None:
        if args.worktree:
            raise ValueError("--resume cannot be combined with --worktree")
        if args.model is not None:
            raise ValueError("--model cannot be overridden with --resume")
        if args.cause is not None:
            raise ValueError("--cause cannot be overridden with --resume")
        prior = _last_job(args.resume)
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
        args.cause = prior.get("cause")
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
        return "failed", 127 if code == CODEX_NOT_FOUND else 1
    if not result:
        errors.append("[crossfeed] Codex exited 0 without a result.")
        return "failed", 1
    return "done", 0


def _run_allocated_job(args, job_dir, now, brief, resume_thread, interrupted):
    start = time.monotonic()
    session = args.session if args.session is not None else os.environ.get("CLAUDE_CODE_SESSION_ID")
    record = {
        "type": "job", "id": job_dir.name, "session": session or None, "kind": args.kind,
        "brief_file": args.brief_file,
        "tier": args.tier, "dir": args.dir, "sandbox": "workspace-write" if args.write else "read-only",
        "worktree": args.worktree, "effort": args.effort, "model": args.model, "cause": args.cause,
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


def _reject_json_constant(constant):
    raise ValueError("invalid JSON constant: {}".format(constant))


def _decision(args) -> int:
    payload = sys.stdin.buffer.read(16385)
    if len(payload) > 16384:
        raise ValueError("decision input exceeds 16384 bytes")
    try:
        data = json.loads(payload.decode("utf-8-sig"), parse_constant=_reject_json_constant)
    except UnicodeDecodeError as error:
        raise ValueError("decision input must be UTF-8") from error
    except RecursionError as error:
        raise ValueError("decision input is nested too deeply") from error
    if not isinstance(data, dict):
        raise ValueError("decision input must be a JSON object")
    for field in ("eligible", "handed_off"):
        if not isinstance(data.get(field), bool):
            raise ValueError("decision field {} must be a boolean".format(field))
    if data["handed_off"] and not data["eligible"]:
        raise ValueError("a decision cannot hand off a call that is not eligible")
    try:
        # A number too large for a float (1e400) parses as infinity and would be written as Infinity.
        json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("decision text must be encodable as UTF-8") from error
    except RecursionError as error:
        raise ValueError("decision input is nested too deeply") from error
    record = {"type": "decision"}
    record.update((key, value) for key, value in data.items() if key not in ("type", "v", "ts"))
    append_ledger(record)
    return 0


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


USE_VERDICTS = ("yes", "partly", "no")


def _used(args) -> int:
    job = _last_job(args.job)
    if job is None:
        raise ValueError("unknown job: {}".format(args.job))
    status = job.get("status")
    if status != "done":
        raise ValueError("job {} did not finish (status {})".format(args.job, status))
    append_ledger({"type": "use", "id": args.job, "verdict": args.verdict})
    return 0


def _parse_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=datetime.timezone.utc)


def _lockout(args) -> int:
    if args.bucket is not None and not args.bucket.strip():
        raise ValueError("--bucket must not be empty")
    if args.last:
        reset_at = next((record["reset_at"] for record in reversed(read_ledger())
                         if isinstance(record, dict) and record.get("type") == "lockout"
                         and "bucket" not in record
                         and _parse_timestamp(record.get("reset_at")) is not None), None)
        print(json.dumps({"reset_at": reset_at}))
        return 0
    if args.reset_at != "unknown" and _parse_timestamp(args.reset_at) is None:
        raise ValueError("--reset-at must be an ISO-8601 timestamp or unknown")
    # The read and append share one lock, so concurrent sessions cannot duplicate a lockout.
    with _private_open(home() / "ledger.jsonl", "a", encoding="utf-8") as ledger:
        fcntl.flock(ledger, fcntl.LOCK_EX)
        if args.reset_at != "unknown" and any(
            isinstance(record, dict) and record.get("type") == "lockout"
            and (("bucket" not in record) if args.bucket is None else record.get("bucket") == args.bucket)
            and record.get("reset_at") == args.reset_at for record in read_ledger()
        ):
            return 0
        record = {"type": "lockout", "reset_at": args.reset_at, "session": args.session}
        if args.bucket is not None:
            record["bucket"] = args.bucket
        _write_ledger(ledger, record)
    return 0


def _downgrade(args) -> int:
    if not _finite_number(args.percent) or not 0 <= args.percent <= 1000:
        raise ValueError("--percent must be a finite number in [0, 1000]")
    if not all(value.strip() for value in (args.from_model, args.to_model, args.bucket)):
        raise ValueError("--from, --to and --bucket must not be empty")
    append_ledger({"type": "downgrade", "from": args.from_model, "to": args.to_model,
                   "bucket": args.bucket, "percent": args.percent, "session": args.session})
    return 0


def _first_checks(records):
    checks = {}
    for record in records:
        if (isinstance(record, dict) and record.get("type") == "check"
                and isinstance(record.get("id"), str) and record.get("verdict") in ("pass", "fail")):
            checks.setdefault(record["id"], record["verdict"])
    return checks


def _report_links(records):
    briefs = set()
    uses = {}
    for record in records:
        if not isinstance(record, dict):
            continue
        kind = record.get("type")
        if kind == "job" and isinstance(record.get("id"), str):
            brief = record.get("brief_file")
            if isinstance(brief, str) and brief:
                briefs.add(brief)
        elif (kind == "use" and isinstance(record.get("id"), str)
              and record.get("verdict") in USE_VERDICTS):
            uses[record["id"]] = record["verdict"]
    return briefs, uses


def _fold_decision(counts, record, briefs):
    eligible, handed_off = record.get("eligible"), record.get("handed_off")
    if not (isinstance(eligible, bool) and isinstance(handed_off, bool)) or (handed_off and not eligible):
        return
    counts["total"] += 1
    if not eligible:
        counts["ineligible"] += 1
    elif handed_off:
        counts["handed_off"] += 1
        brief = record.get("brief_file")
        if isinstance(brief, str) and brief in briefs:
            counts["run"] += 1
    else:
        counts["stayed"] += 1


def _fold_job(summary, record, checks, walls):
    summary["jobs"] += 1
    summary["limit_jobs"] += int(record.get("cause") == "limit")
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
    """Summarize activity since the cutoff using first checks and latest use verdicts."""
    if since.tzinfo is None:
        since = since.replace(tzinfo=datetime.timezone.utc)
    summary = {
        "lockouts": 0, "locked_s": 0, "unknown_resets": 0, "jobs": 0,
        "by_status": {"done": 0, "failed": 0, "limit": 0, "timeout": 0, "interrupted": 0},
        "by_tier": {"A": {"jobs": 0, "checked": 0, "passed": 0},
                    "B": {"jobs": 0, "checked": 0, "passed": 0}},
        "tokens": 0, "median_wall_s": None, "unchecked": 0,
        "bucket_lockouts": {}, "downgrades": {"total": 0, "by_bucket": {}}, "limit_jobs": 0,
        "decisions": {"total": 0, "ineligible": 0, "handed_off": 0, "run": 0, "stayed": 0},
        "used": {"yes": 0, "partly": 0, "no": 0, "unrated": 0},
    }
    checks = _first_checks(records)
    briefs, uses = _report_links(records)
    walls = []
    for record in records:
        if not isinstance(record, dict):
            continue
        timestamp = _parse_timestamp(record.get("ts"))
        if timestamp is None or timestamp < since:
            continue
        if record.get("type") == "lockout":
            counts = summary
            if "bucket" in record:
                bucket = record["bucket"]
                if not isinstance(bucket, str) or not bucket.strip():
                    continue
                counts = summary["bucket_lockouts"].setdefault(
                    bucket, {"lockouts": 0, "locked_s": 0, "unknown_resets": 0})
            counts["lockouts"] += 1
            reset = _parse_timestamp(record.get("reset_at"))
            if reset is None:
                counts["unknown_resets"] += 1
            else:
                counts["locked_s"] += max(0, int((reset - timestamp).total_seconds()))
        elif record.get("type") == "downgrade":
            bucket = record.get("bucket")
            if isinstance(bucket, str) and bucket.strip():
                summary["downgrades"]["total"] += 1
                counts = summary["downgrades"]["by_bucket"]
                counts[bucket] = counts.get(bucket, 0) + 1
        elif record.get("type") == "decision":
            _fold_decision(summary["decisions"], record, briefs)
        elif (record.get("type") == "job" and isinstance(record.get("id"), str)
              and record.get("status") in ("done", "failed", "limit", "timeout", "interrupted")):
            _fold_job(summary, record, checks, walls)
            if record["status"] == "done" and record.get("sandbox") == "read-only":
                summary["used"][uses.get(record["id"], "unrated")] += 1
    if walls:
        summary["median_wall_s"] = float(statistics.median(walls))
    return summary


def _report_text(summary, days):
    hours, minutes = divmod(summary["locked_s"] // 60, 60)
    limits = []
    for label, counts in sorted(summary["bucket_lockouts"].items()):
        locked_hours, locked_minutes = divmod(counts["locked_s"] // 60, 60)
        limits.append("{} {} {}, locked {}h{:02d}m".format(
            label, counts["lockouts"], "lockout" if counts["lockouts"] == 1 else "lockouts",
            locked_hours, locked_minutes))
    downgrades = summary["downgrades"]
    moved = "subagents moved to a cheaper model: {}".format(downgrades["total"])
    if downgrades["total"]:
        moved += " ({})".format("; ".join("{} {}".format(label, count)
                                         for label, count in sorted(downgrades["by_bucket"].items())))
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
        "model limits: " + ("; ".join(limits) if limits else "none"),
        moved,
        "jobs handed off because of a model limit: {}".format(summary["limit_jobs"]),
        "subagent calls: {total}; not eligible: {ineligible}; handed to Codex: {handed_off} (run: {run}); "
        "stayed on Claude: {stayed}".format(**summary["decisions"]),
        "jobs: {} (done {}, failed {}, limit {}, timeout {}, interrupted {}); codex tokens: {}; median: {}".format(
            summary["jobs"], statuses["done"], statuses["failed"], statuses["limit"], statuses["timeout"],
            statuses["interrupted"], summary["tokens"], median_text),
        "first-delivery checks: A {}/{}, B {}/{}; unchecked: {}".format(
            tier_a["passed"], tier_a["checked"], tier_b["passed"], tier_b["checked"], summary["unchecked"]),
        "read-only results used: yes {yes}, partly {partly}, no {no}; not rated: {unrated}".format(**summary["used"]),
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
    parser.add_argument("--version", action="version", version="crossfeed 0.2.1")
    subcommands = parser.add_subparsers(dest="command", required=True)
    usage = subcommands.add_parser("claude-usage")
    usage.add_argument("--fresh", action="store_true")
    usage.add_argument("--timeout", type=float, default=20.0, metavar="SECONDS")
    usage.set_defaults(handler=_claude_usage)
    stash = subcommands.add_parser("stash")
    stash.set_defaults(handler=_stash)
    decision = subcommands.add_parser("decision")
    decision.set_defaults(handler=_decision)
    check = subcommands.add_parser("check")
    check.add_argument("job")
    check.add_argument("check_command", nargs=argparse.REMAINDER)
    check.set_defaults(handler=_check)
    used = subcommands.add_parser("used")
    used.add_argument("job")
    used.add_argument("verdict", choices=USE_VERDICTS)
    used.set_defaults(handler=_used)
    lockout = subcommands.add_parser("lockout")
    lockout_action = lockout.add_mutually_exclusive_group(required=True)
    lockout_action.add_argument("--reset-at")
    lockout_action.add_argument("--last", action="store_true")
    lockout.add_argument("--session")
    lockout.add_argument("--bucket")
    lockout.set_defaults(handler=_lockout)
    downgrade = subcommands.add_parser("downgrade")
    downgrade.add_argument("--from", dest="from_model", required=True)
    downgrade.add_argument("--to", dest="to_model", required=True)
    downgrade.add_argument("--bucket", required=True)
    downgrade.add_argument("--percent", type=float, required=True)
    downgrade.add_argument("--session")
    downgrade.set_defaults(handler=_downgrade)
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
    run.add_argument("--cause")
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
