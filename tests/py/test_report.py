import datetime
import json
from pathlib import Path
import subprocess
import sys

from helpers import CROSSFEED, CrossfeedCase, load_crossfeed, run_crossfeed


UTC = datetime.timezone.utc


class ReportTests(CrossfeedCase):
    def test_report_separates_limits(self):
        records = [
            {"type": "lockout", "ts": self.stamp,
             "reset_at": (self.now + datetime.timedelta(hours=2)).isoformat()},
            {"type": "lockout", "ts": self.stamp, "bucket": "Opus",
             "reset_at": (self.now + datetime.timedelta(hours=25, minutes=5)).isoformat()},
            {"type": "lockout", "ts": self.stamp, "bucket": "Fable",
             "reset_at": (self.now + datetime.timedelta(hours=112)).isoformat()},
            {"type": "lockout", "ts": self.stamp, "bucket": "Fable", "reset_at": "unknown"},
        ]
        records += [{"type": "downgrade", "ts": self.stamp, "from": "fable", "to": "opus",
                     "bucket": "Fable", "percent": 62.5, "session": None} for _ in range(3)]
        records += [dict(self.job("one"), cause="limit"), dict(self.job("two"), cause="limit"), self.job("three")]
        self.write_records(records)
        result = run_crossfeed(["report"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.decode().splitlines()
        self.assertEqual(lines[1:5], [
            "lockouts: 1; locked: 2h00m; unknown resets: 0",
            "model limits: Fable 2 lockouts, locked 112h00m; Opus 1 lockout, locked 25h05m",
            "subagents moved to a cheaper model: 3 (Fable 3)",
            "jobs handed off because of: model limit 2, account week 0, Codex surplus 0",
        ])
        result = run_crossfeed(["report", "--json"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary, load_crossfeed().fold(records, self.now - datetime.timedelta(days=7)))
        self.assertEqual((summary["lockouts"], summary["locked_s"], summary["unknown_resets"]), (1, 7200, 0))
        self.assertEqual(summary["bucket_lockouts"], {
            "Fable": {"lockouts": 2, "locked_s": 112 * 3600, "unknown_resets": 1},
            "Opus": {"lockouts": 1, "locked_s": 25 * 3600 + 300, "unknown_resets": 0},
        })
        self.assertEqual(summary["downgrades"], {"total": 3, "by_bucket": {"Fable": 3}})
        self.assertEqual(summary["limit_jobs"], 2)

    def test_legacy_report_includes_zero_model_counts(self):
        for records in ([], self.sample_records()):
            with self.subTest(empty=not records):
                self.write_records(records)
                result = run_crossfeed(["report"], env=self.env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.decode().splitlines()[2:5], [
                    "model limits: none", "subagents moved to a cheaper model: 0",
                    "jobs handed off because of: model limit 0, account week 0, Codex surplus 0",
                ])

    def test_limit_report_cutoff_and_malformed_buckets(self):
        since = self.now - datetime.timedelta(days=7)
        old = (since - datetime.timedelta(seconds=1)).isoformat()
        records = [
            {"type": "lockout", "ts": old, "bucket": "Fable", "reset_at": "unknown"},
            {"type": "downgrade", "ts": old, "bucket": "Fable"},
            dict(self.job("old", ts=old), cause="limit"),
            {"type": "lockout", "ts": since.isoformat(), "bucket": "Fable", "reset_at": old},
        ]
        for bucket in (None, [], {}, "", 1):
            records += [{"type": kind, "ts": self.stamp, "bucket": bucket, "reset_at": "unknown"}
                        for kind in ("lockout", "downgrade")]
        summary = load_crossfeed().fold(records, since)
        self.assertEqual(summary["lockouts"], 0)
        self.assertEqual(summary["bucket_lockouts"], {"Fable": {"lockouts": 1, "locked_s": 0, "unknown_resets": 0}})
        self.assertEqual(summary["downgrades"], {"total": 0, "by_bucket": {}})
        self.assertEqual(summary["limit_jobs"], 0)

    def setUp(self):
        super().setUp()
        self.now = datetime.datetime.now(UTC).replace(microsecond=0)
        self.stamp = self.now.strftime("%Y-%m-%dT%H:%M:%SZ")

    def job(self, job_id="one", tier="A", status="done", ts=None, wall_s=365, tokens=None):
        return {
            "v": 1, "type": "job", "ts": ts or self.stamp, "id": job_id,
            "session": "session-one", "kind": "检查 naïve", "tier": tier, "dir": str(self.root),
            "sandbox": "read-only", "worktree": False, "effort": "high", "model": None,
            "started": ts or self.stamp, "wall_s": wall_s, "status": status,
            "exit": {"done": 0, "failed": 1, "limit": 75, "timeout": 124, "interrupted": 130}[status],
            "tokens": tokens or {"input": 150000, "cached": 999, "output": 50000, "reasoning": 123},
            "codex_thread": "thread-" + job_id, "changed": None, "head_moved": False, "resume_of": None,
        }

    def write_records(self, records):
        (self.home / "ledger.jsonl").write_text(
            "".join(json.dumps(record, ensure_ascii=False) + "\r\n" for record in records), encoding="utf-8")

    def check_record(self, job_id, verdict, ts=None):
        return {"v": 1, "type": "check", "ts": ts or self.stamp, "id": job_id,
                "verdict": verdict, "exit": 0 if verdict == "pass" else 1, "cmd": ["true"]}

    def test_check_pass_and_fail(self):
        self.write_records([self.job()])
        for command, code, verdict in (("true", 0, "pass"), ("false", 1, "fail")):
            with self.subTest(command=command):
                result = run_crossfeed(["check", "one", "--", command], env=self.env)
                self.assertEqual(result.returncode, code, result.stderr)
                record = load_crossfeed().read_ledger()[-1]
                self.assertEqual(set(record), {"v", "type", "ts", "id", "verdict", "exit", "cmd"})
                self.assertEqual(record["type"], "check")
                self.assertEqual(record["v"], 1)
                self.assertRegex(record["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
                self.assertEqual(record["id"], "one")
                self.assertEqual(record["verdict"], verdict)
                self.assertEqual(record["exit"], code)
                self.assertEqual(record["cmd"], command)

    def test_check_unknown_job_exit_2(self):
        # A check record or a job directory alone does not establish a job.
        (self.home / "jobs" / "unknown").mkdir(parents=True)
        self.write_records([self.check_record("unknown", "pass")])
        marker = self.root / "should-not-run"
        command = [sys.executable, "-I", "-c", "import pathlib, sys; pathlib.Path(sys.argv[1]).touch()", str(marker)]
        result = run_crossfeed(["check", "unknown", "--", *command], env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"unknown job", result.stderr)
        self.assertFalse(marker.exists())
        self.assertEqual(len(load_crossfeed().read_ledger()), 1)

    def test_check_missing_command_is_fail_127(self):
        self.write_records([self.job()])
        missing = str(self.root / "missing-command")
        result = run_crossfeed(["check", "one", "--", missing], env=self.env)
        self.assertEqual(result.returncode, 127)
        self.assertIn(b"missing-command", result.stderr)
        record = load_crossfeed().read_ledger()[-1]
        self.assertEqual(record["verdict"], "fail")
        self.assertEqual(record["exit"], 127)

    def test_check_requires_command(self):
        self.write_records([self.job()])
        result = run_crossfeed(["check", "one", "--"], env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"command", result.stderr)
        self.assertEqual(len(load_crossfeed().read_ledger()), 1)

    def test_check_signal_exit_is_normalized(self):
        self.write_records([self.job()])
        command = [sys.executable, "-I", "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"]
        result = run_crossfeed(["check", "one", "--", *command], env=self.env)
        self.assertEqual(result.returncode, 143)
        record = load_crossfeed().read_ledger()[-1]
        self.assertEqual(record["verdict"], "fail")
        self.assertEqual(record["exit"], 143)

    def test_check_preserves_arguments_output_and_current_directory(self):
        self.write_records([self.job()])
        working = self.root / "check working directory"
        working.mkdir()
        argument = "检查 naïve\r\n$(touch pwned) `touch pwned`; echo nope"
        program = (
            "import os, sys; "
            "sys.stdout.buffer.write(sys.argv[1].encode('utf-8')); "
            "sys.stderr.buffer.write(b'check stderr\\r\\n'); "
            "open('cwd.txt', 'w').write(os.getcwd()); sys.exit(7)"
        )
        command = [sys.executable, "-I", "-c", program, argument]
        result = run_crossfeed(["check", "one", "--", *command], env=self.env, cwd=working)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, argument.encode("utf-8"))
        self.assertEqual(result.stderr, b"check stderr\r\n")
        self.assertEqual((working / "cwd.txt").read_text(), str(working.resolve()))
        self.assertFalse((working / "pwned").exists())
        self.assertEqual(load_crossfeed().read_ledger()[-1]["cmd"], Path(command[0]).name)

    def test_check_arguments_leave_no_secret_under_data_directory(self):
        self.write_records([self.job()])
        command = [sys.executable, "-I", "-c", "pass", "Bearer SECRET"]
        result = run_crossfeed(["check", "one", "--", *command], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(load_crossfeed().read_ledger()[-1]["cmd"], Path(sys.executable).name)
        for path in self.home.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"SECRET", path.read_bytes(), str(path))

    def test_used_appends_verdict_for_done_job(self):
        self.write_records([self.job(status="failed"), self.job()])
        for verdict in ("yes", "partly", "no"):
            with self.subTest(verdict=verdict):
                result = run_crossfeed(["used", "one", verdict], env=self.env)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))
                record = load_crossfeed().read_ledger()[-1]
                self.assertRegex(record["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
                self.assertEqual(record, {"v": 1, "ts": record["ts"], "type": "use",
                                          "id": "one", "verdict": verdict})
        self.assertEqual(len(load_crossfeed().read_ledger()), 5)

    def test_used_rejects_unknown_and_unfinished_jobs(self):
        self.write_records([self.job(), self.job(status="failed"), self.check_record("unknown", "pass")])
        ledger = self.home / "ledger.jsonl"
        original = ledger.read_bytes()
        for job_id, error in (("unknown", b"crossfeed: unknown job: unknown\n"),
                              ("one", b"crossfeed: job one did not finish (status failed)\n")):
            with self.subTest(job=job_id):
                result = run_crossfeed(["used", job_id, "yes"], env=self.env)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (2, b"", error))
                self.assertEqual(ledger.read_bytes(), original)

    def test_used_rejects_invalid_verdict(self):
        records = [self.job()]
        self.write_records(records)
        result = run_crossfeed(["used", "one", "maybe"], env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"invalid choice", result.stderr)
        self.assertEqual(load_crossfeed().read_ledger(), records)

    def test_first_check_wins(self):
        for verdicts, passed in ((("pass", "fail"), 1), (("fail", "pass"), 0)):
            with self.subTest(verdicts=verdicts):
                self.write_records([self.job(), *(self.check_record("one", verdict) for verdict in verdicts)])
                result = run_crossfeed(["report", "--json"], env=self.env)
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(report["by_tier"]["A"], {"jobs": 1, "checked": 1, "passed": passed})
                self.assertEqual(report["unchecked"], 0)

    def test_lockout_is_deduplicated(self):
        reset_at = (self.now + datetime.timedelta(hours=1)).isoformat()
        for session in ("one", "two"):
            result = run_crossfeed(["lockout", "--reset-at", reset_at, "--session", session], env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
        records = load_crossfeed().read_ledger()
        self.assertEqual(len(records), 1)
        self.assertEqual(set(records[0]), {"v", "type", "ts", "reset_at", "session"})
        self.assertEqual(records[0]["type"], "lockout")
        self.assertEqual(records[0]["reset_at"], reset_at)
        self.assertEqual(records[0]["session"], "one")
        for _ in range(2):
            result = run_crossfeed(["lockout", "--reset-at", "unknown"], env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
        records = load_crossfeed().read_ledger()
        self.assertEqual(len(records), 3)
        self.assertIsNone(records[-1]["session"])
        report = load_crossfeed().fold(records, self.now - datetime.timedelta(days=1))
        self.assertEqual(report["lockouts"], 3)
        self.assertEqual(report["unknown_resets"], 2)

    def test_concurrent_lockouts_are_deduplicated(self):
        reset_at = (self.now + datetime.timedelta(hours=1)).isoformat()
        children = []
        try:
            for _ in range(8):
                children.append(subprocess.Popen(
                    [sys.executable, "-I", str(CROSSFEED), "lockout", "--reset-at", reset_at],
                    env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            for child in children:
                stdout, stderr = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, (stdout, stderr))
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate()
        self.assertEqual(len(load_crossfeed().read_ledger()), 1)

    def sample_records(self):
        records = [self.job(str(index), tier="A" if index < 8 else "B",
                            status="done" if index < 12 else "failed" if index == 12 else "timeout")
                   for index in range(14)]
        records[-1]["tokens"]["input"] = 250000
        records += [self.check_record(str(index), "pass" if index < 5 else "fail") for index in range(6)]
        records += [self.check_record("8", "pass"), self.check_record("9", "pass")]
        started = self.now - datetime.timedelta(hours=1)
        records.append({"v": 1, "type": "lockout", "ts": started.isoformat(),
                        "reset_at": (started + datetime.timedelta(minutes=52)).isoformat(), "session": "one"})
        return records

    def balance_records(self):
        records = self.sample_records()
        del records[0]["model"]  # A legacy record with neither a model nor a resume link.
        del records[0]["resume_of"]
        records[0]["cause"] = "limit"
        records[1].update(cause="limit", resume_of="0", model_source="resume")
        records[2].update(cause="account-week", model="gpt-6.2-astra", model_source="judgment")
        records[3].update(cause="account-week", resume_of="2", model="gpt-6.2-astra", model_source="resume")
        records[4].update(cause="codex-surplus", model="custom", model_source="flag")
        records[5].update(cause="codex-surplus", resume_of="4", model="custom", model_source="resume")
        records.extend([
            {"type": "stop", "ts": self.stamp, "resume_of": "0", "kind": "task", "tier": "B",
             "session": None, "reason": "Codex reported its limit", "codex_weekly": None},
            *({"type": "nudge", "ts": self.stamp, "session": "one", "kind": kind, "reasons": [], "calls": calls}
              for kind, calls in (("balance-on", None), ("balance-off", None), ("stretch", 12), ("stretch", 12))),
        ])
        return records

    def test_report_text(self):
        self.write_records(self.balance_records())
        result = run_crossfeed(["report"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.decode(),
                         "crossfeed report, last 7 days\n"
                         "lockouts: 1; locked: 0h52m; unknown resets: 0\n"
                         "model limits: none\n"
                         "subagents moved to a cheaper model: 0\n"
                         "jobs handed off because of: model limit 1, account week 1, Codex surplus 1\n"
                         "subagent calls: 0; not eligible: 0; handed to Codex: 0 (run: 0); stayed on Claude: 0\n"
"jobs: 14 (done 12, failed 1, limit 0, timeout 1, interrupted 0); codex tokens: 2900000; median: 6m05s\n"
                         "jobs by model: Codex default 10, custom 2, gpt-6.2-astra 2\n"
                         "launches stopped at the Codex stop: 1\n"
                         "nudges: balance on 1, balance off 1, stretch 2\n"
                         "first-delivery checks: A 5/6, B 2/2; unchecked: 6\n"
                         "read-only results used: yes 0, partly 0, no 0; not rated: 12\n")

    def test_report_json_and_fold(self):
        records = self.balance_records()
        self.write_records(records)
        expected = {
            "lockouts": 1, "locked_s": 3120, "unknown_resets": 0, "jobs": 14,
            "by_status": {"done": 12, "failed": 1, "limit": 0, "timeout": 1, "interrupted": 0},
            "by_tier": {"A": {"jobs": 8, "checked": 6, "passed": 5},
                        "B": {"jobs": 6, "checked": 2, "passed": 2}},
            "tokens": 2900000, "median_wall_s": 365.0, "unchecked": 6,
            "bucket_lockouts": {}, "downgrades": {"total": 0, "by_bucket": {}},
            "limit_jobs": 1, "account_week_jobs": 1, "codex_surplus_jobs": 1,
            "by_model": {"Codex default": 10, "custom": 2, "gpt-6.2-astra": 2},
            "stops": 1, "nudges": {"balance-on": 1, "balance-off": 1, "stretch": 2},
            "decisions": {"total": 0, "ineligible": 0, "handed_off": 0, "run": 0, "stayed": 0},
            "used": {"yes": 0, "partly": 0, "no": 0, "unrated": 12},
        }
        result = run_crossfeed(["report", "--json"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), expected)
        original = json.dumps(records)
        self.assertEqual(load_crossfeed().fold(records, self.now - datetime.timedelta(days=7)), expected)
        self.assertEqual(json.dumps(records), original)

    def test_report_empty_ledger(self):
        for exists in (False, True):
            with self.subTest(exists=exists):
                if exists:
                    (self.home / "ledger.jsonl").touch()
                result = run_crossfeed(["report"], env=self.env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.decode(),
                                 "crossfeed report, last 7 days\n"
                                 "lockouts: 0; locked: 0h00m; unknown resets: 0\n"
                                 "model limits: none\n"
                                 "subagents moved to a cheaper model: 0\n"
                                 "jobs handed off because of: model limit 0, account week 0, Codex surplus 0\n"
                                 "subagent calls: 0; not eligible: 0; handed to Codex: 0 (run: 0); stayed on Claude: 0\n"
"jobs: 0 (done 0, failed 0, limit 0, timeout 0, interrupted 0); codex tokens: 0; median: n/a\n"
                                 "jobs by model: none\n"
                                 "launches stopped at the Codex stop: 0\n"
                                 "nudges: balance on 0, balance off 0, stretch 0\n"
                                 "first-delivery checks: A 0/0, B 0/0; unchecked: 0\n"
                                 "read-only results used: yes 0, partly 0, no 0; not rated: 0\n")

    def test_report_decisions_and_used(self):
        old = (self.now - datetime.timedelta(days=8)).isoformat()
        decision = {"type": "decision", "ts": self.stamp, "eligible": True, "handed_off": True}
        self.write_records([
            dict(decision, brief_file="old.md"),
            dict(decision, brief_file="missing.md"),
            dict(decision, brief_file=""),
            dict(decision, brief_file=[]),
            dict(decision, eligible=False, handed_off=False, brief_file="old.md"),
            dict(decision, handed_off=False, brief_file="old.md"),
            dict(decision, ts=old),
            dict(decision, ts="invalid"),
            dict(decision, eligible=1),
            dict(decision, handed_off="true"),
            dict(decision, eligible=False, handed_off=True),
            {"type": "decision", "ts": self.stamp, "handed_off": False},
            dict(self.job("old", status="failed", ts=old), brief_file="old.md"),
            dict(self.job("revision"), brief_file=""),
            {"type": "job", "brief_file": "missing.md", "status": "done"},
            self.job("accepted"), self.job("declined"), self.job("unrated"),
            self.job("old-done", ts=old),
            dict(self.job("write"), sandbox="workspace-write"), self.job("failed", status="failed"),
            dict(self.job("running"), status="running"),
            {"type": "use", "id": "revision", "verdict": "no", "ts": self.stamp},
            {"type": "use", "id": "revision", "verdict": "partly", "ts": old},
            {"type": "use", "id": "revision", "verdict": "invalid", "ts": self.stamp},
            {"type": "use", "id": "declined", "verdict": "no", "ts": self.stamp},
            *({"type": "use", "id": job_id, "verdict": "yes", "ts": self.stamp}
              for job_id in ("accepted", "write", "failed", "running", "old-done")),
        ])
        result = run_crossfeed(["report", "--json"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["decisions"], {"total": 6, "ineligible": 1, "handed_off": 4, "run": 1, "stayed": 1})
        self.assertEqual(summary["used"], {"yes": 1, "partly": 1, "no": 1, "unrated": 1})
        result = run_crossfeed(["report"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.decode().splitlines()
        self.assertEqual(lines[4:6], [
            "jobs handed off because of: model limit 0, account week 0, Codex surplus 0",
            "subagent calls: 6; not eligible: 1; handed to Codex: 4 (run: 1); stayed on Claude: 1",
        ])
        self.assertEqual(lines[-2:], [
            "first-delivery checks: A 0/0, B 0/0; unchecked: 6",
            "read-only results used: yes 1, partly 1, no 1; not rated: 1",
        ])

    def test_report_counts_interrupted_after_timeout(self):
        self.write_records([self.job(status="interrupted")])
        result = run_crossfeed(["report", "--json"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["jobs"], 1)
        self.assertEqual(report["by_status"], {"done": 0, "failed": 0, "limit": 0, "timeout": 0, "interrupted": 1})
        result = run_crossfeed(["report"], env=self.env)
        self.assertIn(b"timeout 0, interrupted 1)", result.stdout)

    def test_report_ignores_records_older_than_days(self):
        old = (self.now - datetime.timedelta(days=8)).isoformat()
        recent = (self.now - datetime.timedelta(days=2)).isoformat()
        self.write_records([
            self.job("old", ts=old), self.job("recent", ts=recent), self.job("today"),
            self.check_record("old", "pass"),
            {"type": "lockout", "ts": old, "reset_at": "unknown", "session": None},
            {"type": "stop", "ts": old}, {"type": "nudge", "ts": old, "kind": "stretch"},
        ])
        for days, count in ((7, 2), (1, 1)):
            with self.subTest(days=days):
                result = run_crossfeed(["report", "--days", str(days), "--json"], env=self.env)
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(report["jobs"], count)
                self.assertEqual(report["unchecked"], count)
                self.assertEqual(report["lockouts"], 0)
                self.assertEqual(report["stops"], 0)
                self.assertEqual(report["nudges"]["stretch"], 0)

    def test_fold_includes_exact_cutoff_and_uses_first_ledger_check(self):
        since = self.now - datetime.timedelta(days=7)
        earlier = since - datetime.timedelta(seconds=1)
        records = [self.job(ts=since.isoformat()), self.job("old", ts=earlier.isoformat()),
                   self.check_record("one", "fail", ts=earlier.isoformat()), self.check_record("one", "pass")]
        report = load_crossfeed().fold(records, since)
        self.assertEqual(report["jobs"], 1)
        self.assertEqual(report["by_tier"]["A"], {"jobs": 1, "checked": 1, "passed": 0})

    def test_locked_time_never_negative(self):
        records = [{"type": "lockout", "ts": self.stamp,
                    "reset_at": (self.now - datetime.timedelta(seconds=10)).isoformat()}]
        report = load_crossfeed().fold(records, self.now - datetime.timedelta(days=1))
        self.assertEqual(report["lockouts"], 1)
        self.assertEqual(report["locked_s"], 0)

    def test_fold_handles_empty_and_malformed_records(self):
        records = [None, [], {}, {"type": "future", "ts": self.stamp},
                   {"type": "job", "ts": "not-a-date"}, self.job(wall_s=0,
                   tokens={"input": 0, "cached": 100, "output": 0, "reasoning": 20})]
        report = load_crossfeed().fold(records, self.now - datetime.timedelta(days=1))
        self.assertEqual(report["jobs"], 1)
        self.assertEqual(report["tokens"], 0)
        self.assertEqual(report["median_wall_s"], 0)
        self.assertEqual(report["unchecked"], 1)

    def test_median_for_even_job_count(self):
        report = load_crossfeed().fold([self.job("a", wall_s=10), self.job("b", wall_s=21)], self.now)
        self.assertEqual(report["median_wall_s"], 15.5)

    def test_invalid_reset_and_days_are_usage_errors(self):
        for value in ("", "not-a-date"):
            result = run_crossfeed(["lockout", "--reset-at", value], env=self.env)
            self.assertEqual(result.returncode, 2)
        for value in ("0", "-1", "nan"):
            result = run_crossfeed(["report", "--days", value], env=self.env)
            self.assertEqual(result.returncode, 2)
        self.assertEqual(load_crossfeed().read_ledger(), [])
