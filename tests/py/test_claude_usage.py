import datetime
import json
import os
import stat
import subprocess
import sys
import time
from unittest.mock import patch
from zoneinfo import ZoneInfo

from helpers import CROSSFEED, CrossfeedCase, load_crossfeed, run_crossfeed


UTC = datetime.timezone.utc
OBSERVED = """You are currently using your subscription to power your Claude Code usage

Current session: 69% used · resets Nov 19 at 1:29am (America/Los_Angeles)
Current week (all models): 56% used · resets Nov 23 at 1:59pm (America/Los_Angeles)
Current week (Fable): 100% used · resets Nov 23 at 1:59pm (America/Los_Angeles)

What's contributing to your usage?
...
"""


class ClaudeUsageTests(CrossfeedCase):
    def setUp(self):
        super().setUp()
        self.crossfeed = load_crossfeed()
        self.fixture = self.root / "usage.txt"
        self.log = self.root / "claude.jsonl"
        self.env.update(FAKE_CLAUDE_STDOUT=str(self.fixture), FAKE_CLAUDE_LOG=str(self.log))
        os.environ.update(self.env)
        self.fixture.write_text(json.dumps({"type": "result", "result": OBSERVED}), encoding="utf-8")
        self.now = datetime.datetime(2026, 11, 19, 12, tzinfo=UTC)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def cli(self, *args, **environment):
        result = run_crossfeed(["claude-usage", *args], env=dict(self.env, **environment))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return json.loads(result.stdout)

    def test_parses_the_observed_output(self):
        expected = [{"label": "Fable", "family": "fable", "used_percent": 100.0,
                     "resets_at": int(datetime.datetime(2026, 11, 23, 13, 59,
                                                        tzinfo=ZoneInfo("America/Los_Angeles")).timestamp())}]
        self.assertEqual(self.crossfeed.parse_usage_text(OBSERVED, self.now), expected)
        with patch.object(self.crossfeed.time, "time", return_value=self.now.timestamp()):
            reading = self.crossfeed.read_claude_usage()
        self.assertEqual(reading, {"source": "usage", "age_s": 0, "error": None, "buckets": expected})

    def test_command_line(self):
        self.cli()
        call, = self.calls()
        self.assertEqual(call["argv"], ["-p", "/usage", "--output-format", "json",
                                        "--no-session-persistence", "--setting-sources", "project"])
        self.assertEqual(call["cwd"], str(self.home.resolve()))
        self.assertEqual(call["stdin"], "")

    def test_input_variants(self):
        cases = [(OBSERVED.replace("\n", "\r\n"), "Fable", "fable", 100.0),
                 ("\ufeff" + OBSERVED, "Fable", "fable", 100.0),
                 (OBSERVED.replace("Current week (Fable)", "\x1b[32mCurrent week (Fable)")
                  .replace("\n\nWhat's", "\x1b[0m\n\nWhat's"), "Fable", "fable", 100.0)]
        for label, family in (("Fable · beta", "fable"), ("Sonnet only", "sonnet"),
                              ("Gizmo", None), ("OPUS", "opus"), ("Haiku", "haiku")):
            cases.append((OBSERVED.replace("(Fable)", "(" + label + ")"), label, family, 100.0))
        for percent, expected in (("<1", 0.0), ("12.5", 12.5), ("104", 104.0)):
            cases.append((OBSERVED.replace("100%", percent + "%"), "Fable", "fable", expected))
        for separator in ("-", "|", ""):
            cases.append((OBSERVED.replace("· resets", separator + " resets"), "Fable", "fable", 100.0))
        for text, label, family, percent in cases:
            with self.subTest(text=text):
                self.fixture.write_text(json.dumps({"result": text}), encoding="utf-8")
                reading = self.cli("--fresh")
                self.assertEqual(reading["source"], "usage")
                bucket, = reading["buckets"]
                self.assertEqual((bucket["label"], bucket["family"], bucket["used_percent"]),
                                 (label, family, percent))
        self.fixture.write_text("\ufeff" + json.dumps({"result": OBSERVED}), encoding="utf-8")
        self.assertEqual(self.cli("--fresh")["source"], "usage")
        self.fixture.write_text(OBSERVED, encoding="utf-8")
        self.assertEqual(self.cli("--fresh")["source"], "usage")
        for value in ({}, {"result": None}, {"result": 1}, [], "a string"):
            with self.subTest(value=value):
                self.fixture.write_text(json.dumps(value), encoding="utf-8")
                reading = self.cli("--fresh")
                self.assertEqual(reading["source"], "none")
                self.assertTrue(reading["error"])

    def test_no_model_scoped_line(self):
        text = "\n".join(line for line in OBSERVED.splitlines() if "(Fable)" not in line)
        self.fixture.write_text(text, encoding="utf-8")
        self.assertEqual(self.cli(), {"source": "usage", "age_s": 0, "error": None, "buckets": []})
        for text in ("", " \r\n", OBSERVED.splitlines()[0], "unrecognized output"):
            with self.subTest(text=text):
                self.fixture.write_text(text, encoding="utf-8")
                reading = self.cli("--fresh")
                self.assertEqual(reading["source"], "none")
                self.assertEqual(reading["buckets"], [])
                self.assertTrue(reading["error"])

    def test_parse_reset(self):
        cases = [
            ("Nov 23 at 1:59pm (America/Los_Angeles)", "2026-11-19T12:00:00+00:00", "2026-11-23T21:59:00+00:00"),
            ("2pm (America/Los_Angeles)", "2026-11-19T10:00:00-08:00", "2026-11-19T14:00:00-08:00"),
            ("2pm (America/Los_Angeles)", "2026-11-19T15:00:00-08:00", "2026-11-20T14:00:00-08:00"),
            ("1:59pm (UTC)", "2026-11-19T14:00:00+00:00", "2026-11-19T13:59:00+00:00"),
            ("Jan 2 at 9am (UTC)", "2026-12-31T10:00:00+00:00", "2027-01-02T09:00:00+00:00"),
            ("Dec 30 at 9am (UTC)", "2026-12-31T10:00:00+00:00", None),
            ("Dec 31 at 9am (UTC)", "2026-12-30T10:00:00+00:00", "2026-12-31T09:00:00+00:00"),
            ("Nov 1 at 2pm (America/Los_Angeles)", "2026-10-31T10:00:00-07:00", "2026-11-01T14:00:00-08:00"),
            ("2pm (America/Los_Angeles)", "2026-10-31T15:00:00-07:00", "2026-11-01T14:00:00-08:00"),
            ("1:30am (America/Los_Angeles)", "2026-11-01T08:45:00+00:00", "2026-11-01T09:30:00+00:00"),
            ("1:30am (America/Los_Angeles)", "2026-11-01T08:20:00+00:00", "2026-11-01T08:30:00+00:00"),
            ("Nov 23 at 1:59pm (Mars/Olympus)", "2026-11-19T12:00:00+00:00", None),
        ]
        for when in ("soon", "", "Feb 30 at 1pm (UTC)", "0pm (UTC)", "13pm (UTC)",
                     "1:60pm (UTC)", "Nov 30 at 1pm (UTC)", "2pm (/etc/passwd)"):
            cases.append((when, "2026-11-19T12:00:00+00:00", None))
        for when, now, expected in cases:
            with self.subTest(when=when, now=now):
                reset = self.crossfeed.parse_reset(when, datetime.datetime.fromisoformat(now))
                self.assertEqual(reset, int(datetime.datetime.fromisoformat(expected).timestamp())
                                 if expected else None)

    def test_resolve_claude(self):
        self.assertEqual(self.crossfeed.resolve_claude(), str(self.claude_shim))
        with patch.dict(os.environ, {"CROSSFEED_CLAUDE": ""}):
            self.assertEqual(self.crossfeed.resolve_claude(), str(self.claude_shim))
        with patch.dict(os.environ, {"CROSSFEED_CLAUDE": str(self.claude_shim), "PATH": ""}):
            self.assertEqual(self.crossfeed.resolve_claude(), str(self.claude_shim))
        paths = tuple(str(self.root / name) for name in ("local", "homebrew", "usr-local"))
        with patch.object(self.crossfeed, "CLAUDE_PATHS", paths), patch.dict(os.environ, {"PATH": ""}):
            os.symlink(self.claude_shim, paths[1])
            self.assertEqual(self.crossfeed.resolve_claude(), paths[1])

    def test_failures(self):
        paths = tuple(str(self.root / name) for name in ("local", "homebrew", "usr-local"))
        with patch.object(self.crossfeed, "CLAUDE_PATHS", paths), patch.dict(os.environ, {"PATH": ""}):
            reading = self.crossfeed.read_claude_usage(fresh=True)
        self.assertEqual(reading["source"], "none")
        for path in paths:
            self.assertIn(path, reading["error"])
        reading = self.cli("--fresh", CROSSFEED_CLAUDE=str(self.fixture))
        self.assertEqual(reading["source"], "none")
        self.assertIn(str(self.fixture), reading["error"])
        reading = self.cli("--fresh", FAKE_CLAUDE_EXIT="3")
        self.assertEqual(reading["source"], "none")
        self.assertIn("3", reading["error"])
        started = time.monotonic()
        reading = self.cli("--fresh", "--timeout", "1", FAKE_CLAUDE_SLEEP="5")
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(reading["source"], "none")
        self.assertIn("tim", reading["error"].lower())
        with self.assertRaises(ProcessLookupError):
            os.kill(self.calls()[-1]["pid"], 0)

    def test_concurrent_reads_probe_once(self):
        self.fixture.write_text("Current week (Fable): 50% used · resets unknown", encoding="utf-8")
        command = [sys.executable, "-I", str(CROSSFEED), "claude-usage"]
        environment = dict(self.env, FAKE_CLAUDE_SLEEP="1")
        processes = []
        try:
            for _ in range(2):
                processes.append(subprocess.Popen(
                    command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, env=environment))
            readings = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(len(stdout.splitlines()), 1)
                readings.append(json.loads(stdout))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate()
        self.assertEqual(len(self.calls()), 1)
        self.assertTrue(readings[0]["buckets"])
        self.assertEqual(readings[0]["source"], "usage")
        self.assertEqual(readings[1]["source"], "usage")
        self.assertEqual(readings[0]["buckets"], readings[1]["buckets"])
        self.assertEqual(stat.S_IMODE((self.home / "claude-usage.lock").stat().st_mode), 0o600)

    def test_cache_expires_at_a_bucket_reset(self):
        now = int(self.now.timestamp())
        cache = self.home / "claude-usage.json"
        for reset in (now - 5, now):
            with self.subTest(reset=reset):
                cache.write_text(json.dumps({
                    "read_at": now - 10,
                    "result": {"source": "usage", "error": None, "buckets": [
                        {"label": "Sonnet", "family": "sonnet", "used_percent": 20.0,
                         "resets_at": None},
                        {"label": "Fable", "family": "fable", "used_percent": 100.0,
                         "resets_at": reset},
                    ]},
                }), encoding="utf-8")
                calls = len(self.calls())
                with patch.object(self.crossfeed.time, "time", return_value=now):
                    reading = self.crossfeed.read_claude_usage()
                self.assertEqual(len(self.calls()), calls + 1)
                self.assertEqual(reading["source"], "usage")
                self.assertEqual(reading["age_s"], 0)
                self.assertEqual(reading["buckets"], self.crossfeed.parse_usage_text(OBSERVED, self.now))

    def test_cache(self):
        first = self.cli()
        time.sleep(1.05)
        second = self.cli()
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(second["buckets"], first["buckets"])
        self.assertGreaterEqual(second["age_s"], 1)
        self.cli("--fresh")
        self.assertEqual(len(self.calls()), 2)
        cache = self.home / "claude-usage.json"
        self.assertEqual(stat.S_IMODE(cache.stat().st_mode), 0o600)
        cached = json.loads(cache.read_text())
        self.assertEqual(set(cached), {"read_at", "result"})
        self.assertNotIn("age_s", cached["result"])
        for broken in ("not json", "", "[]", '{"read_at":0,"result":{}}'):
            with self.subTest(broken=broken):
                cache.write_text(broken)
                self.assertEqual(self.cli()["source"], "usage")
                self.assertEqual(json.loads(cache.read_text())["result"]["source"], "usage")
        with patch.object(self.crossfeed.time, "time", return_value=1000):
            self.crossfeed.read_claude_usage(fresh=True)
        calls = len(self.calls())
        with patch.object(self.crossfeed.time, "time", return_value=1299):
            self.assertEqual(self.crossfeed.read_claude_usage()["age_s"], 299)
        self.assertEqual(len(self.calls()), calls)
        with patch.object(self.crossfeed.time, "time", return_value=1300):
            self.crossfeed.read_claude_usage()
        self.assertEqual(len(self.calls()), calls + 1)
        with patch.dict(os.environ, {"FAKE_CLAUDE_EXIT": "3"}):
            with patch.object(self.crossfeed.time, "time", return_value=2000):
                self.assertEqual(self.crossfeed.read_claude_usage(fresh=True)["source"], "none")
            calls = len(self.calls())
            with patch.object(self.crossfeed.time, "time", return_value=2059):
                self.assertEqual(self.crossfeed.read_claude_usage()["age_s"], 59)
            self.assertEqual(len(self.calls()), calls)
            with patch.object(self.crossfeed.time, "time", return_value=2060):
                self.crossfeed.read_claude_usage()
            self.assertEqual(len(self.calls()), calls + 1)

    def test_invalid_timeout(self):
        for value in ("0", "-1", "nan", "inf", "abc"):
            with self.subTest(value=value):
                result = run_crossfeed(["claude-usage", "--timeout", value], env=self.env)
                self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])
