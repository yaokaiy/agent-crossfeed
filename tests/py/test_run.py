import datetime
import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import time
from unittest.mock import patch

from helpers import CROSSFEED, CrossfeedCase, load_crossfeed, run_crossfeed


class JobDirectoryTests(CrossfeedCase):
    def test_collision_allocates_another_directory(self):
        crossfeed = load_crossfeed()
        existing = self.home / "jobs" / "20261117-010203-aaaa"
        existing.mkdir(parents=True)
        marker = existing / "brief.md"
        marker.write_bytes(b"original job")
        with patch.object(crossfeed, "new_job_id", side_effect=[existing.name, "20261117-010203-bbbb"]):
            directory = crossfeed._create_job_dir(datetime.datetime(2026, 11, 17, 1, 2, 3))
        self.assertEqual(directory.name, "20261117-010203-bbbb")
        self.assertTrue(directory.is_dir())
        self.assertEqual(marker.read_bytes(), b"original job")

    def test_allocation_stops_after_five_collisions(self):
        crossfeed = load_crossfeed()
        existing = self.home / "jobs" / "20261117-010203-aaaa"
        existing.mkdir(parents=True)
        with patch.object(crossfeed, "new_job_id", return_value=existing.name) as ids:
            with self.assertRaises(FileExistsError):
                crossfeed._create_job_dir(datetime.datetime(2026, 11, 17, 1, 2, 3))
        self.assertEqual(ids.call_count, 5)
        self.assertEqual(list(existing.iterdir()), [])


class RunTests(CrossfeedCase):
    def test_run_records_cause(self):
        for args, cause in ((["--cause", "limit"], "limit"), ([], None),
                            (["--cause", "Ab9-" * 8], "Ab9-" * 8)):
            with self.subTest(cause=cause):
                result = self.run_job(args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.records()[-1]["cause"], cause)
                self.assertEqual(json.loads((self.job_dir() / "state.json").read_text())["cause"], cause)
        records = self.records()
        argv = self.root / "must-not-start.json"
        for cause in ("a b", "", "a" * 33, "a_b", "é", "limit\n"):
            with self.subTest(cause=cause):
                result = self.run_job(["--cause", cause], FAKE_CODEX_ARGV=str(argv))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.records(), records)
                self.assertFalse(argv.exists())

    def test_resume_preserves_cause_and_rejects_override(self):
        self.assertEqual(self.run_job(["--cause", "limit"]).returncode, 0)
        first = self.records()[-1]
        result = self.run_job(["--resume", first["id"]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]["cause"], "limit")
        for cause in ("limit", "other"):
            result = self.run_job(["--resume", first["id"], "--cause", cause])
            self.assertEqual(result.returncode, 2)
            self.assertIn(b"--cause", result.stderr)
        self.assertEqual(len(self.records()), 2)

    def run_job(self, args=(), brief=b"Implement the parser. Check: python3 -m unittest\n", mode="ok", **env):
        return run_crossfeed(["run", "--dir", str(self.root), *args], stdin=brief,
                         env=dict(self.env, FAKE_CODEX=mode, **env), cwd=self.root)

    def records(self):
        return load_crossfeed().read_ledger()

    def job_dir(self):
        return self.home / "jobs" / self.records()[-1]["id"]

    def test_ok_job(self):
        result = self.run_job(["--tier", "A", "--kind", "subagent", "--session", "session-1"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"ok:", result.stdout)
        record, = self.records()
        self.assertEqual(set(record), {
            "v", "type", "ts", "id", "session", "kind", "tier", "dir", "sandbox", "worktree",
            "effort", "model", "cause", "started", "wall_s", "status", "exit", "tokens", "codex_thread",
            "changed", "head_moved", "resume_of",
        })
        self.assertEqual(record["type"], "job")
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["exit"], 0)
        self.assertEqual(record["tier"], "A")
        self.assertEqual(record["kind"], "subagent")
        self.assertEqual(record["session"], "session-1")
        self.assertEqual(record["tokens"], {"input": 12000, "cached": 500, "output": 321, "reasoning": 21})
        self.assertTrue(record["codex_thread"])
        self.assertEqual(record["effort"], "high")
        self.assertEqual(record["sandbox"], "read-only")
        self.assertEqual(record["dir"], str(self.root.resolve()))
        self.assertIsNone(record["resume_of"])
        self.assertIsNone(record["changed"])
        self.assertFalse(record["head_moved"])
        state = json.loads((self.job_dir() / "state.json").read_text())
        self.assertEqual(state["status"], "done")
        self.assertEqual({path.name for path in self.job_dir().iterdir()},
                         {"brief.md", "events.jsonl", "stderr.log", "result.md", "state.json"})
        lines = result.stdout.decode().splitlines()
        self.assertIn("codex tokens 12321", lines[-3])
        self.assertTrue(lines[-2].startswith("[crossfeed] full result: "))
        self.assertIn("[crossfeed] record the outcome: python3 -I", lines[-1])
        self.assertIn(" check {} -- <your check command>".format(record["id"]), lines[-1])

    def test_argv_passed_to_codex(self):
        argv_file = self.root / "argv.json"
        for args, sandbox in (([], "read-only"),
                              (["--write", "--effort", "xhigh", "--model", "m", "--worktree"], "workspace-write")):
            with self.subTest(sandbox=sandbox):
                result = self.run_job(args, FAKE_CODEX_ARGV=str(argv_file))
                self.assertEqual(result.returncode, 0, result.stderr)
                argv = json.loads(argv_file.read_text())
                self.assertEqual(argv[1:4], ["exec", "--skip-git-repo-check", "--json"])
                self.assertEqual(argv[argv.index("-s") + 1], sandbox)
                self.assertEqual(argv[argv.index("-C") + 1], str(self.root.resolve()))
                self.assertEqual(argv[-1], "-")
                if args:
                    self.assertIn('model_reasoning_effort="xhigh"', argv)
                    self.assertEqual(argv[argv.index("-m") + 1], "m")
                    self.assertIn("--worktree", argv)
                else:
                    self.assertIn('model_reasoning_effort="high"', argv)
                    self.assertNotIn("-m", argv)

    def test_empty_brief_is_usage_error(self):
        for brief in (b"", b"  \r\n"):
            with self.subTest(brief=brief):
                result = self.run_job(brief=brief)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"brief", result.stderr.lower())
                self.assertEqual(self.records(), [])
                self.assertFalse((self.home / "jobs").exists())

    def test_brief_reaches_codex_unchanged(self):
        brief = "$(touch pwned)\r\n`touch pwned`\r\nCROSSFEED_BRIEF_EOF\r\n检查 naïve\r\n".encode()
        for args, preamble in (([], "PREAMBLE_READ"), (["--write"], "PREAMBLE_WRITE")):
            with self.subTest(args=args):
                result = self.run_job(args, brief=brief, mode="echo")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.job_dir() / "brief.md").read_bytes(), brief)
                self.assertEqual((self.job_dir() / "result.md").read_bytes(),
                                 getattr(load_crossfeed(), preamble).encode() + b"\n\n" + brief)
                self.assertFalse((self.root / "pwned").exists())

    def test_failure_has_log_lines(self):
        result = self.run_job(mode="fail")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"[crossfeed] last log lines:", result.stdout)
        self.assertIn(b"boom", result.stdout)
        self.assertNotIn(b"ok:", result.stdout)
        self.assertEqual(self.records()[-1]["status"], "failed")

    def test_logged_out_has_clear_failure(self):
        result = self.run_job(mode="logged-out")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"Not logged in", result.stdout)
        self.assertIn(b"[crossfeed] last log lines:", result.stdout)

    def test_limit_exit_75(self):
        result = self.run_job(mode="limit")
        self.assertEqual(result.returncode, 75)
        self.assertIn(b"Do not retry on Codex; do this work on Claude.", result.stdout)
        self.assertEqual(self.records()[-1]["status"], "limit")

    def test_recoverable_error_events_keep_success_and_print_notice(self):
        for args in ([], ["--write"]):
            with self.subTest(args=args):
                result = self.run_job(args, mode="recoverable")
                self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
                self.assertEqual(self.records()[-1]["status"], "done")
                self.assertIn(b"ok:", result.stdout)
                lines = result.stdout.decode().splitlines()
                job_line = next(index for index, line in enumerate(lines) if line.startswith("[crossfeed] job "))
                notice = "[crossfeed] codex reported 2 recoverable error event(s); see {}".format(
                    self.job_dir() / "events.jsonl")
                self.assertEqual(lines[job_line + 1], notice)
                self.assertEqual(lines.count(notice), 1)

    def test_recoverable_error_without_result_still_fails(self):
        result = self.run_job(mode="recoverable-noresult")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.records()[-1]["status"], "failed")
        self.assertIn(b"[crossfeed] Codex exited 0 without a result.", result.stdout)
        self.assertNotIn(b"recoverable error event(s)", result.stdout)

    def test_usage_limit_requires_nonzero_exit(self):
        result = self.run_job(mode="recovered-limit")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertEqual(self.records()[-1]["status"], "done")
        self.assertIn(b"1 recoverable error event(s)", result.stdout)
        result = self.run_job(mode="limit-with-result")
        self.assertEqual(result.returncode, 75)
        self.assertEqual(self.records()[-1]["status"], "limit")
        self.assertNotIn(b"ok:", result.stdout)
        self.assertNotIn(b"recoverable error event(s)", result.stdout)

    def test_timeout_kills_process_group(self):
        pidfile = self.root / "child.pid"
        start = time.monotonic()
        try:
            result = self.run_job(["--timeout", "0.05"], mode="hang", FAKE_CODEX_PIDFILE=str(pidfile))
            self.assertEqual(result.returncode, 124, (result.stdout, result.stderr))
            self.assertLess(time.monotonic() - start, 15)
            self.assertIn(b"stopped after 0.05 minutes.", result.stdout)
            self.assertEqual(self.records()[-1]["status"], "timeout")
            self.assertTrue(pidfile.exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pidfile.read_text()), 0)
        finally:
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_dispatcher_signals_stop_the_entire_group_and_record_interrupted(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum):
                pidfile = self.root / (str(signum) + ".pid")
                dispatcher = subprocess.Popen(
                    [sys.executable, "-I", str(CROSSFEED), "run", "--dir", str(self.root)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=dict(self.env, FAKE_CODEX="hang", FAKE_CODEX_PIDFILE=str(pidfile)))
                group = None
                try:
                    dispatcher.stdin.write(b"Hang until interrupted.\n")
                    dispatcher.stdin.close()
                    dispatcher.stdin = None
                    deadline = time.monotonic() + 20
                    while not pidfile.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(pidfile.exists(), "fake Codex never started")
                    descendant = int(pidfile.read_text())
                    group = os.getpgid(descendant)
                    dispatcher.send_signal(signum)
                    stdout, stderr = dispatcher.communicate(timeout=30)
                    self.assertEqual(dispatcher.returncode, 130, (stdout, stderr))
                    self.assertIn(b"[crossfeed] job ", stdout)
                    self.assertIn(b"[crossfeed] interrupted; Codex was stopped.\n", stdout)
                    self.assertNotIn(b"Traceback", stderr)
                    record = self.records()[-1]
                    self.assertEqual((record["status"], record["exit"]), ("interrupted", 130))
                    state = json.loads((self.job_dir() / "state.json").read_text())
                    self.assertEqual((state["status"], state["exit"]), ("interrupted", 130))
                    with self.assertRaises(ProcessLookupError):
                        os.kill(descendant, 0)
                    with self.assertRaises(ProcessLookupError):
                        os.killpg(group, 0)
                finally:
                    if group is not None:
                        try:
                            os.killpg(group, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    if dispatcher.poll() is None:
                        dispatcher.kill()
                    dispatcher.communicate()

    def test_big_result_is_capped(self):
        result = self.run_job(mode="big")
        self.assertEqual(result.returncode, 0, result.stderr)
        text = result.stdout.split(b"[crossfeed]", 1)[0]
        self.assertLessEqual(len(text.splitlines()), 60)
        self.assertLessEqual(len(text), 8192)
        self.assertIn(b"[crossfeed] result truncated: full text in", result.stdout)
        self.assertEqual(len((self.job_dir() / "result.md").read_bytes().splitlines()), 10000)

    def test_output_separator_counts_toward_byte_cap(self):
        result = self.run_job(mode="boundary")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLessEqual(len(result.stdout.split(b"[crossfeed]", 1)[0]), 8192)
        self.assertIn(b"[crossfeed] result truncated:", result.stdout)
        self.assertEqual((self.job_dir() / "result.md").read_bytes(), b"x" * 8192)

    def test_exit_zero_without_result_is_failure(self):
        for mode in ("noresult", "emptyresult", "unknown"):
            with self.subTest(mode=mode):
                result = self.run_job(mode=mode)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(b"[crossfeed] Codex exited 0 without a result.", result.stdout)
                self.assertEqual(self.records()[-1]["status"], "failed")

    def test_garbage_events_tolerated(self):
        result = self.run_job(mode="garbage")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"ok:", result.stdout)
        self.assertEqual(self.records()[-1]["tokens"]["input"], 12000)

    def test_stderr_diagnostics_do_not_turn_success_into_failure(self):
        result = self.run_job(mode="stderr-note")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertEqual(self.records()[-1]["status"], "done")
        self.assertIn(b"informational Codex diagnostic", (self.job_dir() / "stderr.log").read_bytes())

    def test_no_codex_on_path(self):
        empty_bin = self.root / "empty"
        empty_bin.mkdir()
        result = self.run_job(PATH=str(empty_bin))
        self.assertEqual(result.returncode, 127)
        self.assertIn(b"codex", result.stdout)
        self.assertIn(b"[crossfeed] last log lines:", result.stdout)
        self.assertEqual(self.records()[-1]["status"], "failed")

        self.assertEqual(self.records()[-1]["exit"], 127)
        detail = (self.job_dir() / "stderr.log").read_text()
        self.assertEqual(len(detail.splitlines()), 1)
        self.assertIn("codex was not found", detail)
        self.assertIn(str(empty_bin), detail)
        self.assertIn("CROSSFEED_CODEX", detail)

    def test_running_state_exists_before_codex_starts(self):
        result = self.run_job(mode="inspect-state")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertIn(b"ok:", result.stdout)

    def test_invalid_directory_and_timeout_are_usage_errors(self):
        for args in (["--dir", str(self.root / "missing")], ["--timeout", "0"],
                     ["--timeout", "nan"], ["--timeout", "-1"]):
            with self.subTest(args=args):
                result = self.run_job(args)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.records(), [])

    def test_collision_exhaustion_exits_one_without_overwriting(self):
        crossfeed = load_crossfeed()
        existing = self.home / "jobs" / "20261117-010203-aaaa"
        existing.mkdir(parents=True)
        marker = existing / "brief.md"
        marker.write_bytes(b"original")
        stderr = io.StringIO()
        stdin = io.TextIOWrapper(io.BytesIO(b"new brief"))
        with patch.object(crossfeed, "new_job_id", return_value=existing.name), \
                patch.object(sys, "stdin", stdin), contextlib.redirect_stderr(stderr):
            code = crossfeed.main(["run", "--dir", str(self.root)])
        self.assertEqual(code, 1)
        self.assertIn("5 attempts", stderr.getvalue())
        self.assertEqual(marker.read_bytes(), b"original")
        self.assertEqual(self.records(), [])

    def test_default_directory_is_current_directory(self):
        result = run_crossfeed(["run"], stdin=b"brief", env=self.env, cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        record, = self.records()
        self.assertEqual(record["dir"], str(self.root.resolve()))
        self.assertEqual(record["tier"], "B")
        self.assertEqual(record["kind"], "task")


class EventTests(CrossfeedCase):
    def test_cap_text_utf8(self):
        crossfeed = load_crossfeed()
        text = ("检" * 100 + "\r\n") * 60
        capped, truncated = crossfeed.cap_text(text)
        self.assertTrue(truncated)
        self.assertLessEqual(len(capped.encode("utf-8")), 8192)
        self.assertEqual(capped.encode().decode(), capped)
        self.assertTrue(capped.endswith("\r\n"))
        self.assertTrue(text.startswith(capped))
        self.assertEqual(crossfeed.cap_text("检" * 3000), ("", True))
        self.assertEqual(crossfeed.cap_text(""), ("", False))
        self.assertEqual(crossfeed.cap_text("naïve\nlast", max_lines=1), ("naïve\n", True))
        self.assertEqual(crossfeed.cap_text("abc", max_bytes=3), ("abc", False))

    def test_parse_events_keeps_last_message_and_sums_usage(self):
        crossfeed = load_crossfeed()
        events = [
            {"type": "thread.started", "thread_id": "thread-1"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "first"}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "检查 naïve"}},
            {"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 3,
             "cache_write_input_tokens": 99, "output_tokens": 4, "reasoning_output_tokens": 2}},
            {"type": "turn.completed", "usage": {"input_tokens": 2, "output_tokens": 1}},
            {"type": "error", "message": "boom"},
            {"type": "turn.failed", "error": {"message": "Not logged in"}},
        ]
        parsed = crossfeed.parse_events([json.dumps(event) for event in events])
        self.assertEqual(parsed, {"thread": "thread-1", "tokens": {
            "input": 12, "cached": 3, "output": 5, "reasoning": 2,
        }, "last_message": "检查 naïve", "errors": ["boom", "Not logged in"]})

    def test_parse_events_ignores_unknown_and_malformed_shapes(self):
        crossfeed = load_crossfeed()
        lines = ["", "bad\r\n", "null", "[]", '"text"', '{"type":"future"}',
                 '{"type":"item.completed","item":null}', '{"type":"turn.failed","error":[]}',
                 '{"type":"turn.completed","usage":{"input_tokens":"bad"}}']
        self.assertEqual(crossfeed.parse_events(lines), {
            "thread": None, "tokens": {"input": 0, "cached": 0, "output": 0, "reasoning": 0},
            "last_message": "", "errors": [],
        })

    def test_usage_limit_accepts_both_apostrophes(self):
        crossfeed = load_crossfeed()
        for message in ("You've hit your usage limit", "You’ve hit your usage limit", "HIT YOUR USAGE LIMIT"):
            self.assertTrue(crossfeed.is_usage_limit([message]))
        self.assertFalse(crossfeed.is_usage_limit(["rate limit: try later", "Not logged in"]))
