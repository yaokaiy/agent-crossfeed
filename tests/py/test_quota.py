import datetime
import json
import os
from pathlib import Path
import subprocess
import time
from unittest.mock import patch

from helpers import CrossfeedCase, load_crossfeed, run_crossfeed


WEEKLY = {"minutes": 10080, "used_percent": 18.0, "resets_at": 1900000000}
LOG_LIMITS = {
    "primary": None,
    "secondary": {"window_minutes": 10080, "used_percent": 18.0, "resets_at": 1900000000},
}


class QuotaTests(CrossfeedCase):
    def quota(self, mode="ok", args=(), **environment):
        env = dict(self.env, FAKE_CODEX_APPSERVER=mode, **environment)
        result = run_crossfeed(["quota", *args], env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        reading = json.loads(result.stdout)
        self.assertIs(type(reading["age_s"]), int)
        self.assertEqual(set(reading), {"source", "age_s", "limit_reached", "error", "windows"})
        return reading

    def write_log(self, name="rollout-test.jsonl", age=120, timestamp=True, limits=None):
        directory = Path(self.env["CODEX_HOME"]) / "sessions" / "2026" / "11" / "17"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        event = {"type": "event_msg", "payload": {
            "type": "token_count", "rate_limits": LOG_LIMITS if limits is None else limits,
        }}
        if timestamp:
            event["timestamp"] = datetime.datetime.fromtimestamp(
                time.time() - age, datetime.timezone.utc
            ).isoformat().replace("+00:00", "Z")
        path.write_text(json.dumps(event) + "\r\n", encoding="utf-8")
        return path

    def test_app_server_reading(self):
        self.assertEqual(self.quota(), {
            "source": "app-server", "age_s": 0, "limit_reached": False,
            "error": None, "windows": [WEEKLY],
        })

    def test_garbage_lines_are_ignored(self):
        reading = self.quota("garbage")
        self.assertEqual(reading["source"], "app-server")
        self.assertEqual(reading["windows"], [WEEKLY])

    def test_falls_back_to_log(self):
        path = self.write_log(age=600)
        old_event = path.read_text()
        self.write_log(age=120)
        latest_event = path.read_text()
        path.write_text(old_event + latest_event + '{bad "rate_limits"\r\n' +
                        '{"payload":{"text":"检查 naïve"}}\r\n', encoding="utf-8")
        reading = self.quota("error")
        self.assertEqual(reading["source"], "log")
        self.assertEqual(reading["windows"], [WEEKLY])
        self.assertIsNone(reading["error"])
        self.assertFalse(reading["limit_reached"])
        self.assertGreaterEqual(reading["age_s"], 115)
        self.assertLessEqual(reading["age_s"], 130)

    def test_log_without_timestamp_uses_mtime(self):
        path = self.write_log(timestamp=False)
        modified = time.time() - 300
        os.utime(path, (modified, modified))
        reading = self.quota("error")
        self.assertEqual(reading["source"], "log")
        self.assertGreaterEqual(reading["age_s"], 295)
        self.assertLessEqual(reading["age_s"], 310)

    def test_log_age_is_rounded(self):
        crossfeed = load_crossfeed()
        path = self.write_log(timestamp=False)
        os.utime(path, (1000, 1000))
        with patch.dict(os.environ, self.env), patch.object(crossfeed.time, "time", return_value=1120.6):
            reading = crossfeed.read_quota(str(self.root / "missing-codex"))
        self.assertEqual(reading["source"], "log")
        self.assertIs(type(reading["age_s"]), int)
        self.assertEqual(reading["age_s"], 121)

    def test_only_newest_eight_logs_are_scanned(self):
        usable = self.write_log(name="rollout-old.jsonl")
        now = time.time()
        os.utime(usable, (now - 100, now - 100))
        for index in range(8):
            path = usable.with_name("rollout-{}.jsonl".format(index))
            path.write_text("\n", encoding="utf-8")
            os.utime(path, (now - index, now - index))
        self.assertEqual(self.quota("error")["source"], "none")
        usable.touch()
        self.assertEqual(self.quota("error")["source"], "log")

    def test_fallback_skips_newer_logs_without_readings(self):
        usable = self.write_log()
        empty = usable.with_name("rollout-empty.jsonl")
        empty.touch()
        self.assertEqual(self.quota("error")["windows"], [WEEKLY])

    def assert_child_stopped(self, mode):
        pidfile = self.root / "child.pid"
        start = time.monotonic()
        reading = self.quota(mode, args=("--timeout", "1"), FAKE_CODEX_PIDFILE=str(pidfile))
        self.assertLess(time.monotonic() - start, 20)
        self.assertEqual(reading["source"], "none")
        self.assertIn("timed out", reading["error"])
        self.assertTrue(pidfile.exists(), "fake must have started")
        pid = int(pidfile.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        processes = subprocess.run(["/bin/ps", "-axo", "command="], capture_output=True)
        self.assertEqual(processes.returncode, 0, processes.stderr)
        self.assertNotIn(str(self.shim).encode(), processes.stdout)

    def test_hang_times_out_and_leaves_no_child(self):
        self.assert_child_stopped("hang")

    def test_partial_line_cannot_bypass_timeout(self):
        self.assert_child_stopped("partial")

    def test_child_ignoring_terminate_is_killed(self):
        self.assert_child_stopped("stubborn")

    def test_no_codex_on_path(self):
        empty_bin = self.root / "empty-bin"
        empty_bin.mkdir()
        reading = self.quota(PATH=str(empty_bin))
        self.assertEqual(reading["source"], "none")
        self.assertEqual(reading["windows"], [])
        self.assertIn("codex", reading["error"])

    def test_logged_out_is_explicit_unknown(self):
        reading = self.quota("logged-out")
        self.assertEqual(reading["source"], "none")
        self.assertEqual(reading["windows"], [])
        self.assertIn("Not logged in", reading["error"])

    def test_unknown_protocol_response_is_not_success(self):
        reading = self.quota("unknown")
        self.assertEqual(reading["source"], "none")
        self.assertEqual(reading["windows"], [])
        self.assertTrue(reading["error"])

    def test_limit_reached_flag(self):
        limits = {"primary": {"usedPercent": 100, "windowDurationMins": 300},
                  "rateLimitReachedType": "primary"}
        reading = self.quota(FAKE_CODEX_RATE_LIMITS=json.dumps(limits))
        self.assertTrue(reading["limit_reached"])
        self.assertEqual(reading["windows"], [
            {"minutes": 300, "used_percent": 100, "resets_at": None},
        ])

    def test_empty_app_server_reading_falls_back(self):
        self.write_log()
        for limits in (None, {}, {"primary": None, "secondary": {}}):
            with self.subTest(limits=limits):
                self.assertEqual(self.quota(
                    FAKE_CODEX_RATE_LIMITS=json.dumps(limits)
                )["source"], "log")

    def test_parse_both_shapes(self):
        crossfeed = load_crossfeed()
        app_limits = {"secondary": {
            "usedPercent": 18.0, "windowDurationMins": 10080, "resetsAt": 1900000000,
        }}
        self.assertEqual(crossfeed.parse_rate_limits(app_limits), [WEEKLY])
        self.assertEqual(crossfeed.parse_rate_limits(LOG_LIMITS), [WEEKLY])
        self.assertEqual(crossfeed.parse_rate_limits({"primary": {
            "used_percent": 0, "window_minutes": 300,
        }}), [{"minutes": 300, "used_percent": 0, "resets_at": None}])

    def test_parse_drops_incomplete_windows(self):
        crossfeed = load_crossfeed()
        for value in (None, {}, [], "", {"primary": None},
                      {"primary": {"windowDurationMins": 300}},
                      {"secondary": {"used_percent": None, "window_minutes": 10080}}):
            with self.subTest(value=value):
                self.assertEqual(crossfeed.parse_rate_limits(value), [])

    def test_malformed_numbers_are_not_capacity(self):
        crossfeed = load_crossfeed()
        for percent in ("", "18", True, float("nan"), float("inf")):
            with self.subTest(percent=percent):
                self.assertEqual(crossfeed.parse_rate_limits({"primary": {
                    "usedPercent": percent, "windowDurationMins": 300,
                }}), [])
        for minutes in (None, "", 0, -1, True):
            with self.subTest(minutes=minutes):
                self.assertEqual(crossfeed.parse_rate_limits({"primary": {
                    "usedPercent": 18, "windowDurationMins": minutes,
                }}), [])

    def test_oversized_json_numbers_do_not_crash_quota(self):
        for field in ("usedPercent", "windowDurationMins", "resetsAt"):
            with self.subTest(field=field):
                window = {"usedPercent": 18, "windowDurationMins": 10080}
                window[field] = 10 ** 400
                reading = self.quota(FAKE_CODEX_RATE_LIMITS=json.dumps({"primary": window}))
                if field == "resetsAt":
                    self.assertEqual(reading["source"], "app-server")
                    self.assertEqual(reading["windows"], [
                        {"minutes": 10080, "used_percent": 18, "resets_at": None},
                    ])
                else:
                    self.assertEqual(reading["source"], "none")
                    self.assertEqual(reading["windows"], [])
                    self.assertTrue(reading["error"])

    def test_log_without_rate_limits(self):
        path = self.write_log()
        for content in ("", "\r\n", '{"payload":{"type":"token_count"}}\n'):
            with self.subTest(content=content):
                path.write_text(content, encoding="utf-8")
                reading = self.quota("error")
                self.assertEqual(reading["source"], "none")
                self.assertEqual(reading["windows"], [])
                self.assertTrue(reading["error"])

    def test_read_quota_accepts_explicit_binary_and_timeout(self):
        crossfeed = load_crossfeed()
        with patch.dict(os.environ, self.env):
            reading = crossfeed.read_quota(str(self.shim), timeout_s=1)
        self.assertEqual(reading["source"], "app-server")
        self.assertEqual(reading["windows"], [WEEKLY])
