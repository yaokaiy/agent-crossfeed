"""Local stand-in for the Codex app-server protocol."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def reply(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def app_server():
    mode = os.environ.get("FAKE_CODEX_APPSERVER", "ok")
    pidfile = os.environ.get("FAKE_CODEX_PIDFILE")
    if pidfile:
        Path(pidfile).write_text(str(os.getpid()), encoding="utf-8")
    if mode in ("multiline", "long-stderr", "non-utf8"):
        detail = {"multiline": b"first line\r\nsecond line\n",
                  "long-stderr": b"diagnostic " * 1000,
                  "non-utf8": b"bad byte: \xff\n"}[mode]
        sys.stderr.buffer.write(detail)
        sys.stderr.buffer.flush()
        return 1
    if mode == "error":
        print("codex app-server failed", file=sys.stderr)
        return 1
    if mode == "stubborn":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    initialized = False
    for line in sys.stdin:
        if mode in ("hang", "stubborn", "partial"):
            if mode == "partial":
                print('{"id":1', end="", flush=True)
            continue
        request = json.loads(line)
        method = request["method"]
        if method == "initialize":
            assert request == {
                "id": 1, "method": "initialize",
                "params": {"clientInfo": {"name": "crossfeed", "version": "0.2.2"}},
            }
            if mode == "garbage":
                print("not json: 检查 naïve\r", flush=True)
                reply({"method": "future/notification", "params": {}})
                reply(["unknown", "event"])
                reply({"id": 999, "result": {}})
            reply({"id": 1, "result": {"userAgent": "fake-codex"}})
        elif method == "initialized":
            assert request == {"method": "initialized", "params": {}}
            initialized = True
        elif method == "account/rateLimits/read":
            assert initialized
            assert request == {"id": 2, "method": "account/rateLimits/read"}
            if mode == "logged-out":
                reply({"id": 2, "error": {"code": -32000, "message": "Not logged in"}})
                continue
            if mode == "unknown":
                reply({"id": 2, "result": {"futureRateLimits": {}}})
                continue
            limits = json.loads(os.environ.get("FAKE_CODEX_RATE_LIMITS", "null"))
            if "FAKE_CODEX_RATE_LIMITS" not in os.environ:
                limits = {
                    "primary": None,
                    "secondary": {
                        "usedPercent": 18.0, "windowDurationMins": 10080,
                        "resetsAt": 1900000000,
                    },
                    "rateLimitReachedType": None,
                }
            reply({"id": 2, "result": {"rateLimits": limits}})
    return 0


def execute():
    mode = os.environ.get("FAKE_CODEX", "ok")
    if os.environ.get("FAKE_CODEX_ARGV"):
        Path(os.environ["FAKE_CODEX_ARGV"]).write_text(json.dumps(sys.argv), encoding="utf-8")
    if os.environ.get("FAKE_CODEX_CWD"):
        Path(os.environ["FAKE_CODEX_CWD"]).write_text(os.getcwd(), encoding="utf-8")
    result = Path(sys.argv[sys.argv.index("-o") + 1])
    brief = sys.stdin.buffer.read()
    if mode == "hang":
        child = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(600)"])
        def terminate(signum, frame):
            child.wait()
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, terminate)
        Path(os.environ["FAKE_CODEX_PIDFILE"]).write_text(str(child.pid), encoding="utf-8")
        time.sleep(600)
        return 0
    if mode == "fail":
        reply({"type": "error", "message": "boom"})
        return 1
    if mode == "logged-out":
        print("Not logged in: run codex login", file=sys.stderr)
        return 1
    if mode == "limit":
        reply({"type": "turn.failed", "error": {"message": "You’ve hit your usage limit. Try again later."}})
        return 1
    if mode in ("recoverable", "recoverable-noresult"):
        reply({"type": "error", "message": "stream disconnected\nreconnecting"})
        reply({"type": "error", "message": "retrying stream"})
        print("informational diagnostic", file=sys.stderr)
        if mode == "recoverable-noresult":
            return 0
    if mode in ("recovered-limit", "limit-with-result"):
        reply({"type": "error", "message": "You've hit your usage limit. Try again later."})
    if mode in ("noresult", "emptyresult", "unknown"):
        if mode == "emptyresult":
            result.touch()
        if mode == "unknown":
            reply({"type": "future.event", "message": "success"})
        return 0
    if mode == "inspect-state":
        assert json.loads(result.with_name("state.json").read_text())["status"] == "running"
    if mode == "stderr-note":
        print("informational Codex diagnostic", file=sys.stderr)
    directory = Path(sys.argv[sys.argv.index("-C") + 1]) if "-C" in sys.argv else Path.cwd()
    if mode == "special-files":
        for name in ("zero-link", "outside-link", "pipe"):
            (directory / name).unlink()
        (directory / "zero-link").symlink_to("/dev/null")
        (directory / "outside-link").symlink_to("missing-outside")
        (directory / "pipe").write_bytes(b"now a regular file")
    if mode == "dirty-submodule":
        with (directory / "submodule" / "tracked.txt").open("ab") as stream:
            stream.write(b"changed again\n")
    if mode in ("write", "dirty", "commit"):
        (directory / "new file ü.txt").write_text("new file\n", encoding="utf-8")
        with (directory / "tracked.txt").open("a", encoding="utf-8") as tracked:
            tracked.write("changed\n")
        if mode == "dirty":
            with (directory / "dirty.txt").open("a", encoding="utf-8") as dirty:
                dirty.write("changed again\n")
        if mode == "commit":
            # Test-only synthetic history: no git commit, hooks, or signing.
            def git(*args, data=None):
                return subprocess.run(["git", "-C", str(directory), *args], input=data,
                                      capture_output=True, check=True).stdout.strip().decode()

            git("add", "-u")
            tree = git("write-tree")
            parent = git("rev-parse", "HEAD")
            commit = git("commit-tree", tree, "-p", parent, data=b"synthetic HEAD movement\n")
            git("update-ref", "HEAD", commit)
    if mode == "many-files":
        for number in range(12):
            (directory / "file-{:02d}.txt".format(number)).write_text("new\n", encoding="utf-8")
    if mode == "garbage":
        print("non-JSON line", flush=True)
        reply({"type": "new.unknown.event"})
        reply(["future", "event"])
    reply({"type": "thread.started", "thread_id": "fake-thread-1"})
    text = "ok: " + brief.decode("utf-8", errors="replace").splitlines()[-1][:40]
    reply({"type": "item.completed", "item": {"type": "agent_message", "text": text}})
    if mode == "echo":
        result.write_bytes(brief)
    elif mode == "big":
        result.write_text("line of result\n" * 10000, encoding="utf-8")
    elif mode == "boundary":
        result.write_bytes(b"x" * 8192)
    else:
        result.write_text(text, encoding="utf-8")
    reply({"type": "turn.completed", "usage": {
        "input_tokens": 12000, "cached_input_tokens": 500, "cache_write_input_tokens": 99,
        "output_tokens": 321, "reasoning_output_tokens": 21,
    }})
    if mode == "garbage":
        print("trailing garbage", flush=True)
    return 1 if mode == "limit-with-result" else 0


if __name__ == "__main__":
    if os.environ.get("FAKE_CODEX_PATH"):
        Path(os.environ["FAKE_CODEX_PATH"]).write_text(os.environ.get("PATH", ""), encoding="utf-8")
    if sys.argv[1:] == ["app-server"]:
        sys.exit(app_server())
    if sys.argv[1:2] == ["exec"]:
        sys.exit(execute())
    sys.exit("fake codex: unsupported command")
