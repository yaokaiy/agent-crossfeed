import datetime
import json
import os
from pathlib import Path
import random
import stat
import subprocess
import sys
from unittest.mock import patch

from helpers import CROSSFEED, CrossfeedCase, load_crossfeed, run_crossfeed


class LedgerTests(CrossfeedCase):
    def test_bucket_lockout_record(self):
        reset = "2026-11-23T22:00:00Z"
        args = ["lockout", "--reset-at", reset, "--bucket", "Fable", "--session", "s1"]
        for _ in range(2):
            result = run_crossfeed(args, env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
        crossfeed = load_crossfeed()
        record, = crossfeed.read_ledger()
        self.assertEqual(record, {"v": 1, "type": "lockout", "ts": record["ts"],
                                  "reset_at": reset, "bucket": "Fable", "session": "s1"})
        for bucket in ("Opus", None):
            result = run_crossfeed(["lockout", "--reset-at", reset] +
                                  (["--bucket", bucket] if bucket else []), env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(crossfeed.read_ledger()), 3)
        for label in ("", " \t"):
            result = run_crossfeed(["lockout", "--reset-at", reset, "--bucket", label], env=self.env)
            self.assertEqual(result.returncode, 2)
        self.assertEqual(len(crossfeed.read_ledger()), 3)

    def test_unknown_reset_is_never_deduplicated(self):
        # A later week's lockout with an unknown reset is a new lockout, for buckets as for the five-hour window.
        for bucket in ("Fable", "Fable", "Opus", None, None):
            result = run_crossfeed(["lockout", "--reset-at", "unknown"] +
                                  (["--bucket", bucket] if bucket else []), env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
        records = load_crossfeed().read_ledger()
        self.assertEqual([record.get("bucket") for record in records], ["Fable", "Fable", "Opus", None, None])

    def test_last_ignores_bucket_lockouts(self):
        crossfeed = load_crossfeed()
        crossfeed.append_ledger({"type": "lockout", "reset_at": "2026-11-19T13:00:00Z"})
        bucket = {"type": "lockout", "bucket": "Fable", "reset_at": "2026-11-19T22:00:00Z"}
        crossfeed.append_ledger(bucket)
        self.assertEqual(self.last_lockout(), {"reset_at": "2026-11-19T13:00:00Z"})
        (self.home / "ledger.jsonl").write_text(json.dumps(bucket) + "\n")
        self.assertEqual(self.last_lockout(), {"reset_at": None})
        crossfeed.append_ledger(dict(bucket, bucket=None))
        self.assertEqual(self.last_lockout(), {"reset_at": None})

    def test_downgrade_record(self):
        args = ["downgrade", "--from", "claude-fable-5-2", "--to", "opus", "--bucket", "Fable"]
        result = run_crossfeed([*args, "--percent", "62.5"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        record, = load_crossfeed().read_ledger()
        self.assertEqual(record, {"v": 1, "ts": record["ts"], "type": "downgrade",
                                  "from": "claude-fable-5-2", "to": "opus", "bucket": "Fable",
                                  "percent": 62.5, "session": None})
        for percent in ("nan", "inf", "-1", "1000.1", "abc"):
            with self.subTest(percent=percent):
                result = run_crossfeed([*args, "--percent", percent], env=self.env)
                self.assertEqual(result.returncode, 2)
        result = run_crossfeed(["downgrade", *args[3:], "--percent", "62.5"], env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(load_crossfeed().read_ledger(), [record])
        for percent in ("0", "1000"):
            result = run_crossfeed([*args, "--percent", percent, "--session", "s2"], env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(load_crossfeed().read_ledger()[-1]["session"], "s2")

    def test_concurrent_bucket_lockouts_are_deduplicated(self):
        children = []
        try:
            for bucket in ("Fable", "Opus") * 4:
                children.append(subprocess.Popen(
                    [sys.executable, "-I", str(CROSSFEED), "lockout", "--reset-at",
                     "2026-11-23T22:00:00Z", "--bucket", bucket],
                    env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            for child in children:
                stdout, stderr = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, (stdout, stderr))
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate()
        self.assertEqual(sorted(record["bucket"] for record in load_crossfeed().read_ledger()),
                         ["Fable", "Opus"])

    def test_append_and_read_round_trip(self):
        crossfeed = load_crossfeed()
        record = {"type": "job", "kind": "检查 naïve", "note": "first\r\nsecond"}
        crossfeed.append_ledger(record)
        saved, = crossfeed.read_ledger()
        self.assertEqual(saved["v"], 1)
        self.assertRegex(saved["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(saved, dict(record, v=1, ts=saved["ts"]))
        self.assertIn("检查 naïve", (self.home / "ledger.jsonl").read_text())

    def test_existing_metadata_is_preserved(self):
        crossfeed = load_crossfeed()
        record = {"type": "check", "v": 1, "ts": "2026-11-17T00:00:00Z"}
        crossfeed.append_ledger(record)
        self.assertEqual(crossfeed.read_ledger(), [record])

    def test_unparsable_lines_are_skipped(self):
        crossfeed = load_crossfeed()
        record = {"type": "job", "id": "one"}
        (self.home / "ledger.jsonl").write_text(
            "{bad\n\n" + json.dumps(record) + "\r\n", encoding="utf-8"
        )
        self.assertEqual(crossfeed.read_ledger(), [record])

    def test_missing_and_empty_ledger(self):
        crossfeed = load_crossfeed()
        self.assertEqual(crossfeed.read_ledger(), [])
        (self.home / "ledger.jsonl").touch()
        self.assertEqual(crossfeed.read_ledger(), [])

    def test_concurrent_appends_do_not_interleave(self):
        load_crossfeed()
        snippet = """
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("crossfeed", sys.argv[1])
crossfeed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crossfeed)
for number in range(200):
    crossfeed.append_ledger({"type": "job", "worker": sys.argv[2],
                         "number": number, "text": "检" * 2000})
"""
        children = []
        try:
            for worker in range(8):
                children.append(subprocess.Popen(
                    [sys.executable, "-I", "-c", snippet, str(CROSSFEED), str(worker)],
                    env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                ))
            for child in children:
                stdout, stderr = child.communicate(timeout=30)
                self.assertEqual(child.returncode, 0, (stdout, stderr))
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate()
        lines = (self.home / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1600)
        records = [json.loads(line) for line in lines]
        self.assertEqual(
            {(record["worker"], record["number"]) for record in records},
            {(str(worker), number) for worker in range(8) for number in range(200)},
        )
        self.assertTrue(all(record["text"] == "检" * 2000 for record in records))

    def test_job_ids_are_unique(self):
        crossfeed = load_crossfeed()
        now = datetime.datetime(2026, 11, 17, 1, 2, 3, tzinfo=datetime.timezone.utc)
        # Real 16-bit entropy can exceed ten collisions by chance. Fix the
        # entropy stream so this contract test is reproducible in CI.
        random_bytes = random.Random(0)

        def token_hex(size):
            self.assertEqual(size, 2)
            return random_bytes.getrandbits(8 * size).to_bytes(size, "big").hex()

        with patch.object(crossfeed.secrets, "token_hex", side_effect=token_hex):
            ids = [crossfeed.new_job_id(now) for _ in range(1000)]
        self.assertGreaterEqual(len(set(ids)), 990)
        for job_id in ids:
            self.assertRegex(job_id, r"^20261117-010203-[0-9a-f]{4}$")

    def test_job_id_uses_secret_suffix(self):
        crossfeed = load_crossfeed()
        now = datetime.datetime(2026, 11, 17, 1, 2, 3)
        with patch.object(crossfeed.secrets, "token_hex", return_value="ab12"):
            self.assertEqual(crossfeed.new_job_id(now), "20261117-010203-ab12")

    def test_home_precedence(self):
        crossfeed = load_crossfeed()
        environment = {
            "HOME": str(self.root / "user"),
            "CROSSFEED_HOME": str(self.home / "nested"),
            "CLAUDE_CONFIG_DIR": str(self.root / "claude"),
        }
        with patch.dict(os.environ, environment, clear=True):
            for key, expected in (
                ("CROSSFEED_HOME", self.home / "nested"),
                ("CLAUDE_CONFIG_DIR", self.root / "claude" / "crossfeed"),
                ("HOME", self.root / "user" / ".claude" / "crossfeed"),
            ):
                self.assertEqual(crossfeed.home(), expected)
                self.assertTrue(expected.is_dir())
                del os.environ[key]

    def test_empty_home_settings_fall_back(self):
        crossfeed = load_crossfeed()
        with patch.dict(os.environ, {
            "CROSSFEED_HOME": "", "CLAUDE_CONFIG_DIR": "", "HOME": str(self.root),
        }):
            self.assertEqual(crossfeed.home(), self.root / ".claude" / "crossfeed")

    def test_write_state_replaces_in_same_directory(self):
        crossfeed = load_crossfeed()
        job = self.home / "jobs" / "one"
        job.mkdir(parents=True)
        target = job / "state.json"
        target.write_text('{"status":"running"}', encoding="utf-8")
        state = {"status": "done", "kind": "检查 naïve"}
        replace = os.replace

        def inspect_replace(source, destination):
            self.assertEqual(Path(source).parent, job)
            self.assertEqual(Path(destination), target)
            self.assertEqual(json.loads(target.read_text()), {"status": "running"})
            self.assertEqual(json.loads(Path(source).read_text()), state)
            replace(source, destination)

        with patch.object(crossfeed.os, "replace", side_effect=inspect_replace):
            crossfeed.write_state(job, state)
        self.assertEqual(json.loads(target.read_text()), state)
        self.assertEqual(list(job.iterdir()), [target])

    def test_version(self):
        result = run_crossfeed(["--version"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"crossfeed 0.2.1\n")

    def test_data_directory_and_job_files_are_private_with_permissive_umask(self):
        self.home.rmdir()
        result = subprocess.run(
            [sys.executable, "-I", str(CROSSFEED), "run", "--dir", str(self.root)],
            input=b"Check private modes.", capture_output=True, env=self.env, umask=0, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(self.home.stat().st_mode), 0o700)
        files = [path for path in self.home.rglob("*") if path.is_file()]
        self.assertEqual({path.name for path in files},
                         {"ledger.jsonl", "brief.md", "events.jsonl", "stderr.log", "result.md", "state.json"})
        for path in files:
            with self.subTest(path=path):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_stash_and_lockout_create_private_data(self):
        for command, brief in ((["stash"], b"private brief"), (["lockout", "--reset-at", "unknown"], b"")):
            with self.subTest(command=command):
                directory = self.root / command[0]
                result = subprocess.run([sys.executable, "-I", str(CROSSFEED), *command],
                                        input=brief, capture_output=True, umask=0, timeout=10,
                                        env=dict(self.env, CROSSFEED_HOME=str(directory)))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
                for path in directory.rglob("*"):
                    if path.is_file():
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def last_lockout(self):
        result = run_crossfeed(["lockout", "--last"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return json.loads(result.stdout)

    def test_last_lockout_missing_and_empty(self):
        self.assertEqual(self.last_lockout(), {"reset_at": None})
        (self.home / "ledger.jsonl").touch()
        self.assertEqual(self.last_lockout(), {"reset_at": None})

    def test_last_lockout_skips_garbage_unknown_and_invalid(self):
        records = [None, [], "text", {"type": "lockout", "reset_at": "unknown"},
                   {"type": "lockout", "reset_at": "bad"},
                   {"type": "lockout", "reset_at": 123}, {"type": "lockout"}]
        path = self.home / "ledger.jsonl"
        path.write_bytes(b"garbage\r\n{broken\r\n" +
                         "\r\n".join(json.dumps(r) for r in records).encode())
        self.assertEqual(self.last_lockout(), {"reset_at": None})

    def test_last_lockout_uses_newest_valid_record_not_latest_reset(self):
        records = [
            {"type": "lockout", "reset_at": "2026-11-18T00:00:00Z"},
            {"type": "lockout", "reset_at": "2026-11-17T01:00:00-08:00"},
            {"type": "job", "reset_at": "2026-11-19T00:00:00Z"},
            {"type": "lockout", "reset_at": "unknown"},
            {"type": "lockout", "reset_at": "not a timestamp"},
        ]
        path = self.home / "ledger.jsonl"
        content = "\r\n".join(json.dumps(r) for r in records) + "\r\n"
        path.write_bytes(content.encode())
        self.assertEqual(self.last_lockout(), {"reset_at": records[1]["reset_at"]})
        self.assertEqual(path.read_bytes(), content.encode())

    def test_lockout_requires_exactly_one_action(self):
        for flags in ([], ["--last", "--reset-at", "unknown"]):
            with self.subTest(flags=flags):
                result = run_crossfeed(["lockout", *flags], env=self.env)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"usage:", result.stderr)
                self.assertEqual(load_crossfeed().read_ledger(), [])

    def test_last_lockout_preserves_write_and_session(self):
        stamp = "2026-11-17T09:00:00Z"
        result = run_crossfeed(["lockout", "--reset-at", stamp, "--session", "session-1"], env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last_lockout(), {"reset_at": stamp})
        self.assertEqual(load_crossfeed().read_ledger()[-1]["session"], "session-1")
