#!/usr/bin/env python3
"""Standalone crossfeed dispatcher (Python 3.9+, standard library only)."""

import argparse
import contextlib
import datetime
import errno
import fcntl
from functools import partial
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
import threading
import time
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


PREAMBLE_RULES = (
    "The given directory is your workspace: make any changes only inside it. You may read "
    "the files and directories the brief names, wherever they are. "
    "Never push, commit or post to any service. Print no secrets."
)
PREAMBLE_STAGE = PREAMBLE_RULES + " Answer in the form the brief asks for."
PREAMBLE_FORMAT = (
    " Answer in at most 40 lines with the conclusion, the evidence "
    "(file and line, or command output), and what is not done."
)
READ_ROLE = " Do not change any project file. You may write temporary files."
WRITE_ROLE = " Change files only inside that directory and run the check the brief states."
PREAMBLE_READ = PREAMBLE_RULES + PREAMBLE_FORMAT + READ_ROLE
PREAMBLE_WRITE = PREAMBLE_RULES + PREAMBLE_FORMAT + WRITE_ROLE
_STAGE_STDERR_LOCK = threading.Lock()


# Returned by _execute_job in place of an exit status when codex was not found.
# A started process that itself exits with 127 is an ordinary failure.
CODEX_NOT_FOUND = -127

CLAUDE_PATHS = ("~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude")
MODEL_FAMILIES = ("fable", "opus", "sonnet", "haiku")
ARTIFACT_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")
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


def _write_ledger_rows(ledger, records):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for record in records:
        record = dict(record)
        record.setdefault("v", 1)
        record.setdefault("ts", stamp)
        ledger.write(json.dumps(record, ensure_ascii=False) + "\n")
    ledger.flush()
    os.fsync(ledger.fileno())


def _write_ledger(ledger, record):
    _write_ledger_rows(ledger, (record,))


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


@contextlib.contextmanager
def _run_slot(count):
    directory = home() / "slots"
    directory.mkdir(mode=0o700, exist_ok=True)
    while True:
        for number in range(1, count + 1):
            with _private_open(directory / "slot-{}".format(number), "ab") as slot:
                try:
                    fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN):
                        raise
                else:
                    # The open descriptor owns the lock, including across quota preflight.
                    yield
                    return
        time.sleep(0.1)


@contextlib.contextmanager
def _run_heartbeat(seconds):
    if seconds is None:
        yield
        return
    stopped = threading.Event()

    def emit():
        while not stopped.wait(seconds):
            if not _stage_stderr("crossfeed: heartbeat"):
                return

    worker = threading.Thread(target=emit, daemon=True)
    worker.start()
    try:
        yield
    finally:
        stopped.set()
        worker.join()


def _stage_stderr(line):
    try:
        with _STAGE_STDERR_LOCK:
            os.write(sys.stderr.fileno(), (line + "\n").encode("utf-8", errors="replace"))
        return True
    except OSError:
        return False


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


def _artifact_jobs(records, artifact):
    return [record for record in records if isinstance(record, dict)
            and record.get("type") == "job" and record.get("artifact") == artifact
            and record.get("status") == "done" and isinstance(record.get("id"), str)
            and isinstance(record.get("kind"), str)]


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
                    "params": {"clientInfo": {"name": "crossfeed", "version": "0.5.1"}},
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


def _codex_home():
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def _log_quota():
    candidates = []
    for path in (_codex_home() / "sessions").rglob("rollout-*.jsonl"):
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


def _stop_process_group(child, grace=5):
    _signal_group(child.pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        child.poll()  # Reap the direct child while waiting for its descendants.
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        except PermissionError:
            # A signal-zero probe can be denied while the group leader is exiting on macOS.
            pass
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    _signal_group(child.pid, signal.SIGKILL)
    child.wait()


class _JobInterrupted(BaseException):
    pass


class _JobSignals:
    requested = False
    interruptible = False

    def request(self, signum, frame):
        self.requested = True
        if self.interruptible:
            raise _JobInterrupted

    @contextlib.contextmanager
    def check(self, enabled):
        # Only unwind where the caller already owns any running children.
        try:
            self.interruptible = enabled
            if enabled and self.requested:
                raise _JobInterrupted
            yield
        finally:
            self.interruptible = False


@contextlib.contextmanager
def _job_interrupts():
    interrupted = _JobSignals()
    previous = {}
    try:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[signum] = signal.signal(signum, interrupted.request)
        yield interrupted
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _file_change_paths(item):
    if not isinstance(item, dict) or item.get("type") != "file_change" or item.get("status") != "completed":
        return []
    entries = item.get("changes")
    if not isinstance(entries, list):
        return []
    paths = []
    for entry in entries:
        path = entry.get("path") if isinstance(entry, dict) else None
        if not _record_text(path) or not path.strip() or "\0" in path:
            return []
        paths.append(path)
    return paths


def _edited_paths(directory, edited):
    """Codex's own edit paths, relative to the job directory when inside it, like the observed changes."""
    base = os.path.realpath(directory)
    shown = set()
    for path in edited:
        parent, name = os.path.split(path)
        full = os.path.join(os.path.realpath(parent), name) if os.path.isabs(path) else None
        if full is not None and os.path.commonpath((full, base)) == base:
            shown.add(os.path.relpath(full, base))
        else:
            shown.add(path)
    return sorted(shown)


def _item_progress(item):
    if not isinstance(item, dict):
        return None
    kind = item.get("type")
    if kind == "command_execution":
        command, code = item.get("command"), item.get("exit_code")
        if isinstance(command, str) and command.strip() and type(code) is int:
            return "ran {} (exit {})".format(command, code)
    elif kind == "web_search":
        query = item.get("query")
        if isinstance(query, str) and query.strip():
            return "searched " + query
    elif kind == "file_change":
        paths = _file_change_paths(item)
        if paths:
            return "changed " + ", ".join(paths)
    elif kind == "mcp_tool_call":
        server, tool = item.get("server"), item.get("tool")
        if all(isinstance(part, str) and part.strip() for part in (server, tool)):
            return "called {}.{}".format(server, tool)
    return None


def _follow_events(events, edited, progress, record, final=False):
    end = os.fstat(events.fileno()).st_size
    while events.tell() < end and (line := events.readline(end - events.tell())):
        if not final and not line.endswith(b"\n"):
            events.seek(-len(line), os.SEEK_CUR)
            return
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "thread.started" and _record_text(event.get("thread_id")):
            record["codex_thread"] = event["thread_id"]
        elif event.get("type") == "item.completed":
            item = event.get("item")
            edited.update(_file_change_paths(item))
            text = _item_progress(item) if progress else None
            if text:
                _stage_stderr("crossfeed: progress " + " ".join(text.splitlines())[:200])


def _thread_from_events(path, limit=65536):
    """The thread id Codex reported first, read back from the job's event log."""
    try:
        with path.open("rb") as stream:
            head = stream.read(limit)
    except OSError:
        return None
    for line in head.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if isinstance(event, dict) and event.get("type") == "thread.started" and _record_text(event.get("thread_id")):
            return event["thread_id"]
    return None


def _execute_job(args, job_dir, brief, resume_thread, interrupted, finish_interrupted, edited, record, launch):
    events_path = job_dir / "events.jsonl"
    with contextlib.ExitStack() as files:
        events = files.enter_context(_private_open(events_path, "wb"))
        errors = files.enter_context(_private_open(job_dir / "stderr.log", "wb"))
        reader = files.enter_context(events_path.open("rb"))
        progress = args.heartbeat is not None
        with _private_open(job_dir / "result.md", "wb"):
            pass
        # Resolved apart from the launch: Popen also raises FileNotFoundError for
        # other reasons, and only a missing codex is exit code 127.
        try:
            codex_bin = resolve_codex()
        except FileNotFoundError as error:
            errors.write((" ".join(str(error).splitlines()) + "\n").encode("utf-8"))
            return CODEX_NOT_FOUND, False, False
        env = _codex_environment(codex_bin)
        if interrupted.requested:
            return 130, False, False
        command = _codex_command(args, job_dir, resume_thread, codex_bin)
        try:
            child = subprocess.Popen(command, cwd=args.dir, stdin=subprocess.PIPE,
                                     stdout=events, stderr=errors, start_new_session=True, umask=0o077,
                                     env=env)
        except OSError as error:
            errors.write(("could not start codex: {}\n".format(error)).encode("utf-8"))
            return 1, False, False
        launch["started"] = True
        try:
            try:
                deadline = time.monotonic() + args.timeout * 60
                pending = brief
                while not interrupted.requested:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        with interrupted.check(args.json):
                            _stop_process_group(child)
                            _follow_events(reader, edited, progress, record, final=True)
                        return 124, True, True
                    try:
                        child.communicate(input=pending, timeout=min(0.1, remaining))
                        if not interrupted.requested:
                            with interrupted.check(args.json):
                                _follow_events(reader, edited, progress, record, final=True)
                            return child.returncode, False, True
                    except subprocess.TimeoutExpired:
                        # communicate retains any unwritten input across retries.
                        pending = None
                        with interrupted.check(args.json):
                            _follow_events(reader, edited, progress, record)
            except _JobInterrupted:
                pass
            try:
                # The host can kill a JSON stage dispatcher within seconds of its signal.
                if finish_interrupted is not None:
                    _follow_events(reader, edited, False, record)
                    finish_interrupted()
            finally:
                _stop_process_group(child, grace=0.25 if args.json else 5)
            if not args.json:
                _follow_events(reader, edited, False, record, final=True)
            return 130, False, True
        finally:
            child.stdin.close()


def _codex_command(args, job_dir, resume_thread, codex_bin):
    if resume_thread:
        command = [codex_bin, "exec", "resume", resume_thread, "--skip-git-repo-check", "--json"]
    else:
        command = [codex_bin, "exec", "--skip-git-repo-check", "--json", "-C", args.dir]
        if args.model:
            command.extend(["-m", args.model])
        if args.worktree:
            command.append("--worktree")
    command.extend(["-c", 'model_reasoning_effort="{}"'.format(args.effort),
                    "-c", 'project_doc_fallback_filenames=["CLAUDE.md"]', "-o", str(job_dir / "result.md")])
    if args.output_schema is not None:
        command.extend(["--output-schema", args.output_schema])
    return command + ["-"]


def _job_writes(record):
    return record.get("write", record.get("sandbox") == "workspace-write") is True


def _shown_paths(paths):
    extra = " (+{} more)".format(len(paths) - 10) if len(paths) > 10 else ""
    return (", ".join(paths[:10]) or "none") + extra


def _print_changes(changes, unavailable_reason, show, write):
    edited = changes["codex_edited"]
    show("[crossfeed] codex edits: " + _shown_paths(edited))
    if edited and not write:
        show("[crossfeed] warning: this read job edited {} file(s): {}".format(len(edited), _shown_paths(edited)))
    if not write:
        return
    observed = changes["observed"]
    if observed == "unavailable":
        show("[crossfeed] workspace changes: unavailable ({})".format(unavailable_reason))
    else:
        show("[crossfeed] workspace changes during the run: " + _shown_paths(observed))
    if changes["head_moved"]:
        show("[crossfeed] warning: HEAD moved during the run")


def _print_job(record, job_dir, capped, errors, timeout_minutes, change_list, unavailable_reason, error_events, output):
    show = partial(print, file=output)
    if record["status"] == "done":
        text, truncated = capped
        if text:
            show(text, end="" if text.endswith("\n") else "\n")
        if truncated:
            show("[crossfeed] result truncated: full text in {}".format(job_dir / "result.md"))
    minutes, seconds = divmod(int(record["wall_s"]), 60)
    write = _job_writes(record)
    show("[crossfeed] job {} {} in {}m{:02d}s; tier {}; kind {}; {}; codex tokens {}".format(
        record["id"], record["status"], minutes, seconds, record["tier"], record["kind"],
        "write" if write else "read", record["tokens"]["input"] + record["tokens"]["output"]))
    if record["artifact"] is not None:
        show("[crossfeed] artifact {} round {}".format(record["artifact"], record["round"]))
    if record["status"] == "done" and error_events:
        show("[crossfeed] codex reported {} recoverable error event(s); see {}".format(
            error_events, job_dir / "events.jsonl"))
    if record["worktree"]:
        show("[crossfeed] worktree job: changes are in Codex's managed worktree, not in {}".format(record["dir"]))
    _print_changes(change_list, unavailable_reason, show, write)
    if record["status"] == "done":
        show("[crossfeed] full result: {}".format(job_dir / "result.md"))
        script = shlex.quote(str(Path(__file__).resolve()))
        if not write:
            show("[crossfeed] once you have checked its claims, record whether you used this result: "
                  "python3 -I {} used {} <yes|partly|no>".format(script, record["id"]))
        else:
            show("[crossfeed] record the outcome: python3 -I {} check {} -- <your check command>".format(
                script, record["id"]))
    elif record["status"] == "failed":
        show("[crossfeed] last log lines:")
        for line in errors[-20:]:
            show(line)
    elif record["status"] == "limit":
        show("[crossfeed] Codex reported its usage limit. Do not retry on Codex; do this work on Claude.")
    elif record["status"] == "interrupted":
        show("[crossfeed] interrupted; Codex was stopped.")
    else:
        show("[crossfeed] stopped after {:g} minutes.".format(timeout_minutes))


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
    return ("executable:" if mode & stat.S_IXUSR else "") + digest.hexdigest()


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


def _judgment_model():
    slug = os.environ.get("CROSSFEED_JUDGMENT_MODEL", "gpt-6.2-astra")
    if not slug:
        return None
    try:
        with (_codex_home() / "models_cache.json").open(encoding="utf-8-sig") as stream:
            cache = json.load(stream, parse_constant=_reject_json_constant)
    except (OSError, ValueError, RecursionError):
        return None
    models = cache.get("models") if isinstance(cache, dict) else None
    if isinstance(models, list) and any(isinstance(model, dict) and model.get("slug") == slug
                                        for model in models):
        return slug
    return None


def _validate_artifact(artifact):
    if ARTIFACT_ID.fullmatch(artifact) is None:
        raise ValueError("artifact ID must be 1 to 64 ASCII letters, digits, dots, underscores or hyphens")


def _input_file(value, flag):
    try:
        path = Path(value).expanduser().resolve()
        if path.is_file():
            return path
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError("{} could not resolve file: {}".format(flag, value)) from error
    raise ValueError("{} requires an existing file: {}".format(flag, value))


def _read_role(path):
    try:
        with path.open("rb") as stream:
            payload = stream.read(65537)
    except OSError as error:
        raise ValueError("--role-file could not be read: {}".format(path)) from error
    if len(payload) > 65536:
        raise ValueError("--role-file exceeds 64 KiB")
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("--role-file must be UTF-8") from error
    opening = re.match(r"---(?:\r?\n|\Z)", text)
    if opening:
        closing = re.search(r"^---(?:\r?\n|\Z)", text[opening.end():], re.MULTILINE)
        if closing is None:
            raise ValueError("--role-file has unterminated frontmatter")
        text = text[opening.end() + closing.end():]
    if not text.strip():
        raise ValueError("--role-file must contain a role")
    return text.encode("utf-8")


def _output_schema_path(value):
    path = _input_file(value, "--output-schema")
    try:
        with path.open(encoding="utf-8") as stream:
            schema = json.load(stream, parse_constant=_reject_json_constant)
    except (OSError, ValueError, RecursionError) as error:
        raise ValueError("--output-schema must contain a JSON object: {}".format(path)) from error
    if not isinstance(schema, dict):
        raise ValueError("--output-schema must contain a JSON object: {}".format(path))
    return str(path)


def _prepare_run(args):
    thread = None
    if args.slots is not None and args.slots < 1:
        raise ValueError("--slots must be at least 1")
    if args.heartbeat is not None:
        if not args.json:
            raise ValueError("--heartbeat requires --json")
        if args.heartbeat < 1:
            raise ValueError("--heartbeat must be at least 1")
    if not _finite_number(args.codex_stop) or not 0 < args.codex_stop <= 100:
        raise ValueError("--codex-stop must be a finite percent greater than 0 and at most 100")
    if args.cause is not None and re.fullmatch(r"[A-Za-z0-9-]{1,32}", args.cause) is None:
        raise ValueError("--cause must be 1 to 32 letters, digits or hyphens")
    if args.artifact is not None:
        _validate_artifact(args.artifact)
    if args.resume is not None:
        if args.worktree:
            raise ValueError("--resume cannot be combined with --worktree")
        if args.model is not None:
            raise ValueError("--model cannot be overridden with --resume")
        if args.cause is not None:
            raise ValueError("--cause cannot be overridden with --resume")
        if args.role_file is not None:
            raise ValueError("--role-file cannot be combined with --resume")
        prior = _last_job(args.resume)
        if prior is None:
            raise ValueError("unknown job: {}".format(args.resume))
        thread = prior.get("codex_thread")
        # An interrupt records the end before stopping Codex and folding its log.
        if not thread and prior.get("status") == "interrupted" and re.fullmatch(r"\d{8}-\d{6}-[a-f0-9]{4}", args.resume):
            try:
                with (home() / "jobs" / args.resume / "events.jsonl").open("rb") as events:
                    thread = parse_events(events)["thread"]
            except OSError:
                pass
        if not isinstance(thread, str) or not thread:
            raise ValueError("job has no Codex thread: {}".format(args.resume))
        if not isinstance(prior.get("dir"), str) or not prior["dir"]:
            raise ValueError("job has no valid directory: {}".format(args.resume))
        args.dir = prior["dir"]
        args.write = _job_writes(prior)
        args.model = prior.get("model")
        args.model_source = "resume"
        args.cause = prior.get("cause")
        prior_artifact = prior.get("artifact")
        if prior_artifact is not None:
            if args.artifact is not None and args.artifact != prior_artifact:
                raise ValueError("--artifact cannot be overridden with --resume")
            args.artifact = prior_artifact
    elif args.model:
        args.model_source = "flag"
    else:
        judgment = args.kind in ("review", "research") or (args.kind == "subagent" and args.tier == "B")
        args.model = _judgment_model() if judgment else None
        args.model_source = "judgment" if args.model else "codex-default"
    args.dir = str(Path(args.dir).resolve())
    if not Path(args.dir).is_dir():
        raise ValueError("directory does not exist: {}".format(args.dir))
    if not _finite_number(args.timeout) or args.timeout <= 0:
        raise ValueError("timeout must be a positive finite number")
    return thread


def _job_status(code, timed_out, result, errors):
    if timed_out:
        return "timeout", 124
    if code == CODEX_NOT_FOUND:
        return "failed", 127
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


def _finish_job(job_dir, record):
    if record["artifact"] is None:
        write_state(job_dir, record)
        append_ledger(record)
        return
    # Count and append under the same lock so rounds follow ledger order.
    with _private_open(home() / "ledger.jsonl", "a", encoding="utf-8") as ledger:
        fcntl.flock(ledger, fcntl.LOCK_EX)
        completed = _artifact_jobs(read_ledger(), record["artifact"])
        record["round"] = 1 + sum(job["kind"] == record["kind"] for job in completed)
        write_state(job_dir, record)
        _write_ledger(ledger, record)


def _print_run_json(status, exit_code, job_dir=None, result="", change_list=None, error=None):
    response = {
        "id": job_dir.name if job_dir is not None else None,
        "status": status, "exit": exit_code,
        "result_path": os.path.abspath(job_dir / "result.md") if job_dir is not None else None,
        "result": result, "codex_edited": [],
    }
    if change_list is not None:
        response.update(change_list)
    if error is not None:
        response["error"] = error
    print(json.dumps(response))
    return exit_code


def _snapshot_or_unavailable(directory):
    try:
        return snapshot(directory), None
    except Exception as error:
        return None, str(error)


def _run_allocated_job(args, job_dir, now, brief, role, resume_thread, interrupted, launch):
    start = time.monotonic()
    record = {
        "type": "job", "id": job_dir.name, "session": args.session or None, "kind": args.kind,
        "brief_file": args.brief_file, "artifact": args.artifact, "round": None,
        "role_file": args.role_file, "output_schema": args.output_schema,
        "tier": args.tier, "dir": args.dir, "write": args.write,
        "sandbox": "workspace-write" if args.write else "read-only",
        "worktree": args.worktree, "effort": args.effort, "model": args.model,
        "model_source": args.model_source, "cause": args.cause,
        "started": now.strftime("%Y-%m-%dT%H:%M:%S.%fZ"), "wall_s": 0,
        "status": "running", "exit": None,
        "tokens": {"input": 0, "cached": 0, "output": 0, "reasoning": 0},
        "codex_thread": resume_thread, "resume_of": args.resume,
    }
    errors = []
    error_events = 0
    result = ""
    change_list = {"codex_edited": []}
    if args.write:
        change_list.update(observed="unavailable", head_moved=False)
    record.update(change_list)
    unavailable_reason = "managed worktree" if args.worktree else "not a git repository"
    edited = set()
    code, timed_out = 1, False
    finalized = False

    def finish(status, exit_code):
        nonlocal finalized
        record["status"], record["exit"] = status, exit_code
        record["wall_s"] = time.monotonic() - start
        record.update(change_list, codex_edited=_edited_paths(args.dir, edited))
        if not record.get("codex_thread"):
            # A signal can land between reading thread.started and saving it.
            record["codex_thread"] = _thread_from_events(job_dir / "events.jsonl")
        _finish_job(job_dir, record)
        finalized = True

    def finish_interrupted():
        finish("interrupted", 130)

    try:
        before = None
        with interrupted.check(args.json):
            with _private_open(job_dir / "brief.md", "wb") as stream:
                stream.write(brief)
            write_state(job_dir, record)
            if args.write and not args.worktree:
                before, snapshot_error = _snapshot_or_unavailable(args.dir)
                unavailable_reason = snapshot_error or unavailable_reason
        preamble = PREAMBLE_STAGE if args.json else PREAMBLE_WRITE if args.write else PREAMBLE_READ
        if args.json:
            preamble += WRITE_ROLE if args.write else READ_ROLE
        prompt = b"\n\n".join((preamble.encode("utf-8"), brief) if role is None
                             else (preamble.encode("utf-8"), role, brief))
        code, timed_out, _ = _execute_job(args, job_dir, prompt, resume_thread,
                                         interrupted, finish_interrupted if args.json else None, edited, record, launch)
        with interrupted.check(args.json):
            with (job_dir / "events.jsonl").open("rb") as events:
                parsed = parse_events(events)
            error_events = len(parsed["errors"])
            record["tokens"] = parsed["tokens"]
            record["codex_thread"] = parsed["thread"] or record["codex_thread"]
            stderr = (job_dir / "stderr.log").read_text(encoding="utf-8", errors="replace")
            errors = [line for message in parsed["errors"] for line in message.splitlines()] + stderr.splitlines()
            result_path = job_dir / "result.md"
            result = result_path.read_text(encoding="utf-8", errors="replace") if result_path.exists() else ""
            if before is not None and launch["started"]:
                after, snapshot_error = _snapshot_or_unavailable(args.dir)
                if after is not None:
                    observed = changes(before, after)
                    change_list.update(observed=observed["changed"], head_moved=observed["head_moved"])
                else:
                    unavailable_reason = snapshot_error or unavailable_reason
    except _JobInterrupted:
        pass
    except OSError as error:
        code = 1
        errors.append("crossfeed: {}".format(error))
    if not finalized:
        if interrupted.requested:
            finish_interrupted()
        else:
            finish(*_job_status(code, timed_out, result, errors))
    capped = cap_text(result) if record["status"] == "done" else ("", False)
    text, _ = capped
    if text and not text.endswith("\n") and len(text.encode("utf-8")) == 8192:
        capped = cap_text(result, max_bytes=8191)
    change_list["codex_edited"] = record["codex_edited"]
    if args.json:
        refused = not launch["started"] and record["status"] != "interrupted"
        status = "not-started" if refused else record["status"]
        return _print_run_json(status, record["exit"], job_dir, capped[0], change_list,
                               error="\n".join(errors) if refused and errors else None)
    _print_job(record, job_dir, capped, errors, args.timeout, change_list, unavailable_reason, error_events, sys.stdout)
    return record["exit"]


def _fine(x):
    """Round a quota stop to a millionth of a percentage point, with the same operations as `fine` in
    hooks/policy.ts, so the hook and the dispatcher draw the same line."""
    return math.floor(x * 1e6 + 0.5) / 1e6


def _window_stop(window, stop, now):
    """The use at which a window stops new jobs. A window over 6 hours keeps 100 - stop points
    for the user's own Codex work over a whole window, shrinking with the time left to use them,
    so its stop rises from `stop` at the window's start to 100 at its reset."""
    if window["minutes"] <= 360:
        return 90
    # Whole milliseconds, clamped then rounded as in the hook, so a window with none elapsed stops at
    # exactly `stop` and huge values never reach an integer conversion.
    length = window["minutes"] * 60000
    if not math.isfinite(length):
        return _fine(stop)
    reset = window.get("resets_at")
    left = length if reset is None else math.floor(min(length, max(0, (reset - now) * 1000)) + 0.5)
    return _fine(stop + (100 - stop) * (length - left) / length)


def _stop_reason(windows, limit_reached, stop, now):
    if limit_reached and windows:
        return "Codex reported its limit"
    for window in windows:
        short = window["minutes"] <= 360
        threshold = _window_stop(window, stop, now)
        if window["used_percent"] < threshold:
            continue
        label = "{:g}-hour".format(window["minutes"] / 60) if short else "weekly"
        reason = "Codex {} {}% used, at or above the {}% stop".format(
            label, str(window["used_percent"]).removesuffix(".0"),
            "{:.6f}".format(threshold).rstrip("0").rstrip("."))
        if window.get("resets_at") is not None:
            try:
                reset = datetime.datetime.fromtimestamp(window["resets_at"], datetime.timezone.utc)
                reason += reset.strftime(" (resets %Y-%m-%d %H:%M UTC)")
            except (OSError, OverflowError, ValueError):
                pass  # Unprintable timestamps don't invalidate the quota percentage.
        return reason
    return None


def _launch_stopped(args, quota, now):
    if quota["source"] == "none" or quota["age_s"] < -300:
        if not args.json:
            print("crossfeed: Codex quota is unknown; proceeding.", file=sys.stderr)
        return None
    fresh = quota["age_s"] <= 900
    windows = []
    for window in quota["windows"]:
        reset = window.get("resets_at")
        if (reset is None and fresh) or (reset is not None and reset > now):
            windows.append(window)
    reason = _stop_reason(windows, fresh and quota["limit_reached"], args.codex_stop, now)
    if reason is None:
        return None
    weekly = max((w for w in windows if w["minutes"] > 360), key=lambda w: w["minutes"], default=None)
    append_ledger({"type": "stop", "session": args.session or None, "kind": args.kind, "tier": args.tier,
                   "resume_of": args.resume, "reason": reason,
                   "codex_weekly": weekly["used_percent"] if weekly else None})
    return "not started: {}. Do this work yourself.".format(reason)


def _run(args) -> int:
    def not_started(code, reason):
        if args.json:
            return _print_run_json("not-started", code, error=reason)
        print("crossfeed: {}".format(reason), file=sys.stderr)
        return code

    try:
        brief = Path(args.brief_file).read_bytes() if args.brief_file is not None else sys.stdin.buffer.read()
    except OSError as error:
        return not_started(2, "could not read brief: {}".format(error))
    if not brief.strip():
        return not_started(2, "brief must not be empty")
    try:
        resume_thread = _prepare_run(args)
        role = None
        if args.role_file is not None:
            path = _input_file(args.role_file, "--role-file")
            role = _read_role(path)
            args.role_file = str(path)
        if args.output_schema is not None:
            args.output_schema = _output_schema_path(args.output_schema)
    except ValueError as error:
        return not_started(2, str(error))
    with _run_heartbeat(args.heartbeat):
        job_dir = None
        # Set at the process-creation boundary: any failure before it, here or in
        # the job's own setup and bookkeeping, is a non-start.
        launch = {"started": False}
        try:
            with _run_slot(args.slots) if args.slots is not None else contextlib.nullcontext():
                quota = read_quota()
                now = datetime.datetime.now(datetime.timezone.utc)
                refusal = _launch_stopped(args, quota, now.timestamp())
                if refusal is not None:
                    return not_started(75, refusal)
                with _job_interrupts() as interrupted:
                    job_dir = _create_job_dir(now)
                    return _run_allocated_job(args, job_dir, now, brief, role, resume_thread, interrupted, launch)
        except OSError as error:
            if args.json and job_dir is not None and launch["started"]:
                return _print_run_json("failed", 1, job_dir, error=str(error))
            return not_started(1, str(error))


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


def _read_record_input(name):
    payload = sys.stdin.buffer.read(16385)
    if len(payload) > 16384:
        raise ValueError("{} input exceeds 16384 bytes".format(name))
    try:
        data = json.loads(payload.decode("utf-8-sig"), parse_constant=_reject_json_constant)
        # Reject unpaired surrogates and numbers like 1e400 before opening the ledger.
        json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("{} input must be UTF-8".format(name)) from error
    except UnicodeEncodeError as error:
        raise ValueError("{} text must be encodable as UTF-8".format(name)) from error
    except RecursionError as error:
        raise ValueError("{} input is nested too deeply".format(name)) from error
    if not isinstance(data, dict):
        raise ValueError("{} input must be a JSON object".format(name))
    return data


def _decision(args) -> int:
    data = _read_record_input("decision")
    for field in ("eligible", "handed_off"):
        if not isinstance(data.get(field), bool):
            raise ValueError("decision field {} must be a boolean".format(field))
    if data["handed_off"] and not data["eligible"]:
        raise ValueError("a decision cannot hand off a call that is not eligible")
    week = data.setdefault("account_week", None)
    if week is not None:
        if (not isinstance(week, dict) or not _finite_number(week.get("percent"))
                or week.get("state") not in ("ok", "ahead", "full", "unknown")
                or (week.get("line") is not None and not _finite_number(week["line"]))):
            raise ValueError("invalid decision account_week")
        week.setdefault("line", None)
    surplus = data.setdefault("codex_surplus", None)
    if surplus is not None:
        if not _finite_number(surplus):
            raise ValueError("decision codex_surplus must be a number or null")
        data["codex_surplus"] = round(surplus, 1)
    record = {"type": "decision"}
    record.update((key, value) for key, value in data.items() if key not in ("type", "v", "ts"))
    append_ledger(record)
    return 0


NUDGE_KINDS = ("balance-on", "balance-off", "stretch")


def _nudge(args) -> int:
    data = _read_record_input("nudge")
    if data.get("kind") not in NUDGE_KINDS:
        raise ValueError("nudge kind must be balance-on, balance-off or stretch")
    reasons = data.get("reasons")
    if not isinstance(reasons, list) or not all(isinstance(reason, str) for reason in reasons):
        raise ValueError("nudge reasons must be a list of strings")
    if "calls" not in data or (data["calls"] is not None and type(data["calls"]) is not int):
        raise ValueError("nudge calls must be an integer or null")
    append_ledger({"type": "nudge", "session": data.get("session"), "kind": data["kind"],
                   "reasons": reasons, "calls": data["calls"]})
    return 0


SPAWN_ORIGINS = ("workflow", "fork", "teammate", "resume", "agent-tool", "other")
SPAWN_OUTCOMES = ("started", "refused", "unconfirmed", "stage-codex", "stage-fallback", "stage-failed")
BREAKER_OUTCOMES = ("stopped", "denied", "error")
WAKE_TRIGGERS = ("pace", "breaker")
WAKE_OUTCOMES = ("prompt", "notice")


def _record_text(value, allow_empty=False):
    if not isinstance(value, str) or (not value and not allow_empty):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _background_record(data):
    """Validate and project rows onto the fields written by the plugin."""
    if not isinstance(data, dict):
        return None
    kind, session = data.get("type"), data.get("session")
    if session is not None and not _record_text(session):
        return None
    row = {"type": kind, "session": session}
    if kind == "spawn":
        origin, outcome = data.get("origin"), data.get("outcome")
        run_id, index, model = data.get("run_id"), data.get("agent_index"), data.get("model")
        if (origin not in SPAWN_ORIGINS or outcome not in SPAWN_OUTCOMES
                or (run_id is not None and not _record_text(run_id, allow_empty=True))
                or (index is not None and (type(index) is not int or index < 1))
                or (model is not None and not _record_text(model, allow_empty=True))):
            return None
        if "codex_edited" in data:
            count = data["codex_edited"]
            if type(count) is not int or count < 0:
                return None
            row["codex_edited"] = count
        return dict(row, origin=origin, outcome=outcome, run_id=run_id, agent_index=index, model=model)
    if kind == "breaker":
        task_id, run_id = data.get("task_id"), data.get("run_id")
        outcome, reason = data.get("outcome"), data.get("reason")
        if (not _record_text(task_id) or outcome not in BREAKER_OUTCOMES
                or (run_id is not None and not _record_text(run_id))
                or (reason is not None and not _record_text(reason))):
            return None
        return dict(row, task_id=task_id, run_id=run_id, outcome=outcome, reason=reason)
    if kind == "wake":
        trigger, outcome = data.get("trigger"), data.get("outcome")
        if trigger in WAKE_TRIGGERS and outcome in WAKE_OUTCOMES:
            return dict(row, trigger=trigger, outcome=outcome)
    return None


def _record(args) -> int:
    rows = []
    skipped = 0
    for number, line in enumerate(sys.stdin.buffer):
        try:
            row = _background_record(json.loads(line.decode("utf-8-sig" if number == 0 else "utf-8"),
                                                parse_constant=_reject_json_constant))
        except (ValueError, RecursionError):
            row = None
        if row is None:
            skipped += 1
        else:
            rows.append(row)
    if rows:
        with _private_open(home() / "ledger.jsonl", "a", encoding="utf-8") as ledger:
            fcntl.flock(ledger, fcntl.LOCK_EX)
            _write_ledger_rows(ledger, rows)
    print(json.dumps({"written": len(rows), "skipped": skipped}))
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


def _result_verdict(path):
    try:
        # Strict UTF-8: json.loads on bytes would accept encoded surrogates.
        value = json.loads(path.read_bytes().decode("utf-8-sig"), parse_constant=_reject_json_constant)
    except (OSError, ValueError, RecursionError):
        return None
    verdict = value.get("verdict") if isinstance(value, dict) else None
    if not isinstance(verdict, str):
        return None
    try:
        verdict.encode("utf-8")  # an escaped lone surrogate cannot be printed
    except UnicodeEncodeError:
        return None
    return verdict


def _receipt(args) -> int:
    _validate_artifact(args.artifact)
    path_mtimes_ns = []
    for path in args.path:
        if not path:
            raise ValueError("--path must not be empty")
        try:
            mtime_ns = Path(path).stat().st_mtime_ns
        except (OSError, ValueError) as error:
            raise ValueError("could not stat path {}: {}".format(path, error)) from error
        path_mtimes_ns.append((path, mtime_ns))
    records = read_ledger()
    matches = [job for job in _artifact_jobs(records, args.artifact)
               if args.kind == "any" or job["kind"] == args.kind]
    if not matches:
        print("crossfeed: no {} job for artifact {}".format(args.kind, args.artifact), file=sys.stderr)
        return 1
    job = matches[-1]
    stale_paths = []
    if path_mtimes_ns:
        started = _parse_timestamp(job.get("started"))
        if started is None:
            raise ValueError("job {} has no valid started time".format(job["id"]))
        elapsed = started - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
        started_ns = (elapsed.days * 86400 + elapsed.seconds) * 1_000_000_000 + elapsed.microseconds * 1000
        stale_paths = [path for path, mtime_ns in path_mtimes_ns if mtime_ns > started_ns]
    directory = home().absolute() / "jobs" / job["id"]
    brief_path, result_path = directory / "brief.md", directory / "result.md"
    _, uses = _report_links(records)
    receipt = {
        "id": job["id"], "artifact": args.artifact, "kind": job["kind"], "round": job.get("round"),
        "started": job.get("started"), "ts": job.get("ts"), "model": job.get("model"),
        "verdict": _result_verdict(result_path), "used": uses.get(job["id"]),
        "done_rounds": sum(match["kind"] == job["kind"] for match in matches),
        "brief_path": str(brief_path), "result_path": str(result_path),
        "paths": args.path, "stale": bool(stale_paths), "stale_paths": stale_paths,
    }
    if args.json:
        print(json.dumps(receipt))
    else:
        for field in ("id", "artifact", "kind", "round", "started", "ts", "model", "verdict", "used",
                      "done_rounds", "brief_path", "result_path"):
            value = receipt[field]
            print("{}: {}".format(field, value if value is not None else "none"))
        stale = set(stale_paths)
        for path in args.path:
            print("stale: {} modified after job start".format(path) if path in stale else "fresh: {}".format(path))
    return 3 if stale_paths else 0


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
    if record.get("resume_of") is None:
        cause = record.get("cause")
        summary["limit_jobs"] += int(cause == "limit")
        summary["account_week_jobs"] += int(cause == "account-week")
        summary["codex_surplus_jobs"] += int(cause == "codex-surplus")
    model = record.get("model")
    if not isinstance(model, str) or not model:
        model = "Codex default"
    by_model = summary["by_model"]
    by_model[model] = by_model.get(model, 0) + 1
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
        "bucket_lockouts": {}, "downgrades": {"total": 0, "by_bucket": {}},
        "limit_jobs": 0, "account_week_jobs": 0, "codex_surplus_jobs": 0,
        "by_model": {}, "stops": 0, "nudges": dict.fromkeys(NUDGE_KINDS, 0),
        "spawns": None, "breaker": None, "wakes": None,
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
        if timestamp is None:
            continue
        kind = record.get("type")
        if kind in ("spawn", "breaker", "wake"):
            row = _background_record(record)
            if row is None:
                continue
            if summary["spawns"] is None:
                summary["spawns"] = {}
                summary["breaker"] = dict.fromkeys(BREAKER_OUTCOMES, 0)
                summary["wakes"] = {trigger: dict.fromkeys(WAKE_OUTCOMES, 0) for trigger in WAKE_TRIGGERS}
            if timestamp >= since:
                if kind == "spawn":
                    counts = summary["spawns"].setdefault(row["origin"], dict.fromkeys(SPAWN_OUTCOMES, 0))
                    counts[row["outcome"]] += 1
                elif kind == "breaker":
                    summary["breaker"][row["outcome"]] += 1
                else:
                    summary["wakes"][row["trigger"]][row["outcome"]] += 1
            continue
        if timestamp < since:
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
        elif record.get("type") == "stop":
            summary["stops"] += 1
        elif record.get("type") == "nudge" and record.get("kind") in NUDGE_KINDS:
            summary["nudges"][record["kind"]] += 1
        elif (record.get("type") == "job" and isinstance(record.get("id"), str)
              and record.get("status") in ("done", "failed", "limit", "timeout", "interrupted")):
            _fold_job(summary, record, checks, walls)
            if record["status"] == "done" and not _job_writes(record):
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
    models = ", ".join("{} {}".format(model, count) for model, count in sorted(summary["by_model"].items()))
    tier_a, tier_b = summary["by_tier"]["A"], summary["by_tier"]["B"]
    spawns, breaker, wakes = summary["spawns"], summary["breaker"], summary["wakes"]
    if spawns is None:
        background = ["agent starts: unavailable", "breaker stops: unavailable", "wake-ups: unavailable"]
    else:
        origins = ["{} ({})".format(origin, ", ".join(
            "{} {}".format(outcome, counts[outcome]) for outcome in SPAWN_OUTCOMES))
                   for origin, counts in sorted(spawns.items())]
        wake_counts = ["{} (prompt {}, notice {})".format(trigger, counts["prompt"], counts["notice"])
                       for trigger, counts in wakes.items()]
        background = [
            "agent starts: " + (", ".join(origins) or "none"),
            "breaker stops: {stopped} stopped, {denied} denied, {error} errors".format(**breaker),
            "wake-ups: " + ", ".join(wake_counts),
        ]
    return "\n".join([
        "crossfeed report, last {} days".format(days),
        "lockouts: {}; locked: {}h{:02d}m; unknown resets: {}".format(
            summary["lockouts"], hours, minutes, summary["unknown_resets"]),
        "model limits: " + ("; ".join(limits) if limits else "none"),
        moved,
        "jobs handed off because of: model limit {limit_jobs}, account week {account_week_jobs}, "
        "Codex surplus {codex_surplus_jobs}".format(**summary),
        "subagent calls: {total}; not eligible: {ineligible}; handed to Codex: {handed_off} (run: {run}); "
        "stayed on Claude: {stayed}".format(**summary["decisions"]),
        *background,
        "jobs: {} (done {}, failed {}, limit {}, timeout {}, interrupted {}); codex tokens: {}; median: {}".format(
            summary["jobs"], statuses["done"], statuses["failed"], statuses["limit"], statuses["timeout"],
            statuses["interrupted"], summary["tokens"], median_text),
        "jobs by model: " + (models or "none"),
        "launches stopped at the Codex stop: {}".format(summary["stops"]),
        "nudges: balance on {balance-on}, balance off {balance-off}, stretch {stretch}".format(**summary["nudges"]),
        "first-delivery checks: A {}/{}, B {}/{}; unchecked: {}".format(
            tier_a["passed"], tier_a["checked"], tier_b["passed"], tier_b["checked"], summary["unchecked"]),
        "read job results used: yes {yes}, partly {partly}, no {no}; not rated: {unrated}".format(**summary["used"]),
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
    parser.add_argument("--version", action="version", version="crossfeed 0.5.1")
    subcommands = parser.add_subparsers(dest="command", required=True)
    usage = subcommands.add_parser("claude-usage")
    usage.add_argument("--fresh", action="store_true")
    usage.add_argument("--timeout", type=float, default=20.0, metavar="SECONDS")
    usage.set_defaults(handler=_claude_usage)
    stash = subcommands.add_parser("stash")
    stash.set_defaults(handler=_stash)
    decision = subcommands.add_parser("decision")
    decision.set_defaults(handler=_decision)
    nudge = subcommands.add_parser("nudge")
    nudge.set_defaults(handler=_nudge)
    record = subcommands.add_parser("record")
    record.set_defaults(handler=_record)
    check = subcommands.add_parser("check")
    check.add_argument("job")
    check.add_argument("check_command", nargs=argparse.REMAINDER)
    check.set_defaults(handler=_check)
    used = subcommands.add_parser("used")
    used.add_argument("job")
    used.add_argument("verdict", choices=USE_VERDICTS)
    used.set_defaults(handler=_used)
    receipt = subcommands.add_parser("receipt")
    receipt.add_argument("artifact", metavar="ID")
    receipt.add_argument("--kind", default="review")
    receipt.add_argument("--path", action="append", default=[])
    receipt.add_argument("--json", action="store_true")
    receipt.set_defaults(handler=_receipt)
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
    run.add_argument("--codex-stop", type=float, default=85, metavar="PERCENT")
    run.add_argument("--cause")
    run.add_argument("--timeout", type=float, default=30)
    run.add_argument("--resume")
    run.add_argument("--session", default=os.environ.get("CLAUDE_CODE_SESSION_ID"))
    run.add_argument("--brief-file")
    run.add_argument("--artifact", metavar="ID")
    run.add_argument("--role-file", metavar="PATH")
    run.add_argument("--output-schema", metavar="PATH")
    run.add_argument("--json", action="store_true")
    run.add_argument("--slots", type=int, metavar="N")
    run.add_argument("--heartbeat", type=int, metavar="SECONDS")
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
