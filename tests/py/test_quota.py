import contextlib
import datetime
import io
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
        self.assertEqual(set(reading), {"source", "age_s", "limit_reached", "error", "windows", "app_server_error"})
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
            "error": None, "windows": [WEEKLY], "app_server_error": None,
        })

    def run_with_limits(self, limits, *args, **env):
        return run_crossfeed(["run", "--dir", str(self.root), *args], stdin=b"Brief\n", cwd=self.root,
                             env=dict(self.env, FAKE_CODEX_RATE_LIMITS=json.dumps(limits), **env))

    def test_launch_stops_before_allocation_with_exact_message_and_record(self):
        reset = datetime.datetime(2099, 11, 22, 1, 27, tzinfo=datetime.timezone.utc).timestamp()
        limits = {"secondary": {"window_minutes": 10080, "used_percent": 86, "resets_at": reset}}
        argv = self.root / "exec-argv"
        result = self.run_with_limits(limits, "--kind", "subagent", "--tier", "A",
                                      CLAUDE_CODE_SESSION_ID="session", FAKE_CODEX_ARGV=str(argv))
        reason = "Codex weekly 86% used, at or above the 85% stop (resets 2099-11-22 01:27 UTC)"
        self.assertEqual((result.returncode, result.stdout, result.stderr.decode()),
                         (75, b"", "crossfeed: not started: {}. Do this work yourself.\n".format(reason)))
        record, = load_crossfeed().read_ledger()
        self.assertEqual(record, {"v": 1, "ts": record["ts"], "type": "stop", "reason": reason,
                                  "codex_weekly": 86, "kind": "subagent", "tier": "A",
                                  "session": "session", "resume_of": None})
        self.assertFalse(argv.exists())
        self.assertFalse((self.home / "jobs").exists())

    def test_launch_thresholds_and_limit_flag(self):
        for minutes, percent, args, limited, code in (
            (360, 89.99, [], False, 0), (360, 90, ["--codex-stop", "100"], False, 75),
            (361, 84.99, [], False, 0), (361, 85, [], False, 75),
            (10080, 85, ["--codex-stop", "85.5"], False, 0),
            (10080, 85.5, ["--codex-stop", "85.5"], False, 75),
            (10080, 0.1, ["--codex-stop", "0.1"], False, 75),
            (10080, 0, ["--codex-stop", "100"], True, 75),
        ):
            with self.subTest(minutes=minutes, percent=percent, args=args, limited=limited):
                limits = {"primary": {"window_minutes": minutes, "used_percent": percent},
                          "rateLimitReachedType": "primary" if limited else None}
                result = self.run_with_limits(limits, *args)
                self.assertEqual(result.returncode, code, result.stderr)
                record = load_crossfeed().read_ledger()[-1]
                self.assertEqual(record["type"], "stop" if code == 75 else "job")
                if code == 75:
                    self.assertEqual(record["codex_weekly"], percent if minutes > 360 else None)

    def test_long_window_stop_rises_from_the_configured_stop_to_100_at_the_reset(self):
        for days, percent, args, code, stop in (
            (7, 84.9, [], 0, None), (7, 85.1, [], 75, "85"),
            (3.5, 92.4, [], 0, None), (3.5, 92.6, [], 75, "92.5"),
            (0.875, 85, [], 0, None), (0.875, 98.1, [], 0, None), (0.875, 98.2, [], 75, "98.125"),
            (0.875, 99.9, ["--codex-stop", "100"], 0, None), (0.875, 100, ["--codex-stop", "100"], 75, "100"),
        ):
            with self.subTest(days=days, percent=percent, args=args):
                reset = time.time() + days * 86400
                limits = {"secondary": {"window_minutes": 10080, "used_percent": percent, "resets_at": reset}}
                result = self.run_with_limits(limits, *args)
                self.assertEqual(result.returncode, code, result.stderr)
                if stop is not None:
                    # The wall clock moves the stop by millionths; exact values are checked with a fixed clock below.
                    self.assertIn("at or above the {}".format(stop).encode(), result.stderr)

    def test_stop_is_exact_at_the_configured_value_and_at_a_moving_threshold(self):
        crossfeed = load_crossfeed()
        now = 1_800_000_000.0
        reset = now + 0.875 * 86400

        def week(used, resets_at):
            return {"minutes": 10080, "used_percent": used, "resets_at": resets_at}

        self.assertEqual(crossfeed._window_stop(week(0, reset), 85, now), 98.125)
        self.assertIsNone(crossfeed._stop_reason([week(98.124, reset)], False, 85, now))
        self.assertTrue(crossfeed._stop_reason([week(98.125, reset)], False, 85, now).startswith(
            "Codex weekly 98.125% used, at or above the 98.125% stop (resets "))
        # The same literal fixtures as tests/ts/policy.pressure.test.ts, so the hook and the dispatcher agree.
        for stop, resets_at, expected in ((0.2, now + 2, 99.99967), (85, now + 0.875 * 86400, 98.125),
                                          (85.1234, None, 85.1234), (0.0001, None, 0.0001), (85, now + 7 * 86400, 85)):
            self.assertEqual(crossfeed._window_stop(week(0, resets_at), stop, now), expected)
        # A reset a fraction of a millisecond short of a 361-minute window: no time elapsed, as in the hook.
        self.assertEqual(crossfeed._window_stop({"minutes": 361, "used_percent": 0, "resets_at": now + 21659.999625}, 10, now), 10)
        # Values the parser accepts but milliseconds cannot hold keep the configured stop instead of raising.
        self.assertEqual(crossfeed._window_stop({"minutes": 1e308, "used_percent": 0, "resets_at": None}, 85, now), 85)
        self.assertEqual(crossfeed._window_stop(week(0, 1e308), 85, now), 85)
        windows = crossfeed.parse_rate_limits({"secondary": {"windowDurationMins": 1e308, "usedPercent": 90, "resetsAt": 1e308}})
        self.assertIn("at or above the 85% stop", crossfeed._stop_reason(windows, False, 85, now))
        self.assertIn("at or above the 85.1234% stop", crossfeed._stop_reason([week(85.1234, None)], False, 85.1234, now))
        self.assertIsNone(crossfeed._stop_reason([week(85.1231, None)], False, 85.1234, now))
        self.assertIn("at or above the 0.0001% stop", crossfeed._stop_reason([week(0.0001, None)], False, 0.0001, now))
        for stop in (0.1, 0.2, 85.5):
            for resets_at in (None, now + 7 * 86400, now + 14 * 86400):
                with self.subTest(stop=stop, resets_at=resets_at):
                    self.assertEqual(crossfeed._window_stop(week(0, resets_at), stop, now), stop)
                    self.assertIsNone(crossfeed._stop_reason([week(stop * 0.99, resets_at)], False, stop, now))
                    self.assertIn("at or above the {:g}% stop".format(stop),
                                  crossfeed._stop_reason([week(stop, resets_at)], False, stop, now))

    def test_unknown_quota_proceeds_and_resumed_launch_is_guarded(self):
        result = self.run_with_limits({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"quota is unknown", result.stderr)
        job, = load_crossfeed().read_ledger()
        limits = {"primary": {"window_minutes": 300, "used_percent": 90},
                  "secondary": {"window_minutes": 10080, "used_percent": 45}}
        result = self.run_with_limits(limits, "--resume", job["id"], "--session", "next")
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertEqual([p.name for p in (self.home / "jobs").iterdir()], [job["id"]])
        original, stop = load_crossfeed().read_ledger()
        self.assertEqual(original, job)
        self.assertEqual((stop["type"], stop["resume_of"], stop["session"], stop["codex_weekly"]),
                         ("stop", job["id"], "next", 45))

    def test_limit_flag_with_a_mix_of_expired_and_current_windows(self):
        limits = {"primary": {"window_minutes": 300, "used_percent": 100, "resets_at": 1},
                  "secondary": {"window_minutes": 10080, "used_percent": 12}}
        result = self.run_with_limits(limits)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_with_limits(dict(limits, rateLimitReachedType="primary"))
        self.assertEqual(result.returncode, 75, result.stderr)
        record = load_crossfeed().read_ledger()[-1]
        self.assertEqual((record["reason"], record["codex_weekly"]), ("Codex reported its limit", 12))

    def test_invalid_codex_stop_is_a_usage_error_before_probing(self):
        probe = self.root / "app-server.pid"
        for value in ("", "0", "-1", "101", "nan", "inf", "-inf", "bad"):
            with self.subTest(value=value):
                result = self.run_with_limits({}, "--codex-stop=" + value, FAKE_CODEX_APPSERVER_PIDFILE=str(probe))
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"--codex-stop", result.stderr)
        self.assertFalse(probe.exists())
        self.assertFalse((self.home / "jobs").exists())
        self.assertEqual(load_crossfeed().read_ledger(), [])

    def test_launch_guard_on_dated_log_windows(self):
        crossfeed = load_crossfeed()
        now = datetime.datetime(2026, 11, 21, tzinfo=datetime.timezone.utc)
        stamp = now.timestamp()
        brief = self.root / "brief"
        brief.write_bytes(b"Brief\n")
        for age, reset, percent, limited, code in (
            (604800, stamp - 1, 100, True, 0), (0, stamp, 100, True, 0),
            (604800, stamp + 1, 100, False, 75), (901, stamp + 1, 0, True, 0),
            (900, stamp + 1, 0, True, 75), (901, None, 85, True, 0),
            (900, None, 85, False, 75), (900, None, 0, True, 75),
            (-300, stamp + 1, 100, False, 75), (-301, stamp + 1, 100, True, 0),
        ):
            with self.subTest(age=age, reset=reset, limited=limited, percent=percent):
                limits = {"secondary": {"window_minutes": 10080, "used_percent": percent, "resets_at": reset},
                          "rateLimitReachedType": "secondary" if limited else None}
                stderr = io.StringIO()
                with patch.object(time, "time", return_value=stamp), \
                        patch.dict(os.environ, FAKE_CODEX_APPSERVER="error"):
                    self.write_log(age=age, limits=limits)
                    with patch.object(datetime, "datetime", wraps=datetime.datetime) as clock, \
                            contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
                        clock.now.return_value = now
                        result = crossfeed.main(["run", "--brief-file", str(brief), "--dir", str(self.root)])
                self.assertEqual(result, code, stderr.getvalue())
                self.assertEqual("quota is unknown" in stderr.getvalue(), age < -300)

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
        self.assertIn("codex app-server failed", reading["app_server_error"])
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
        reading = self.quota(mode, args=("--timeout", "1"), FAKE_CODEX_APPSERVER_PIDFILE=str(pidfile))
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

    def test_app_server_stderr_is_bounded_single_line(self):
        for mode, detail in (("multiline", "first line second line"),
                             ("long-stderr", "diagnostic"), ("non-utf8", "bad byte: \ufffd")):
            for with_log in (False, True):
                with self.subTest(mode=mode, with_log=with_log):
                    if with_log:
                        self.write_log()
                    reading = self.quota(mode)
                    self.assertEqual(reading["source"], "log" if with_log else "none")
                    error = reading["app_server_error"]
                    self.assertIn(detail, error)
                    self.assertEqual(len(error.splitlines()), 1)
                    self.assertLessEqual(len(error), 300)
                    if with_log:
                        for path in Path(self.env["CODEX_HOME"]).rglob("*.jsonl"):
                            path.unlink()

    def test_missing_codex_retains_error_with_and_without_log(self):
        for with_log in (False, True):
            with self.subTest(with_log=with_log):
                if with_log:
                    self.write_log()
                reading = self.quota(PATH="")
                self.assertEqual(reading["source"], "log" if with_log else "none")
                self.assertIn("codex was not found", reading["app_server_error"])
                self.assertIn("CROSSFEED_CODEX", reading["app_server_error"])
