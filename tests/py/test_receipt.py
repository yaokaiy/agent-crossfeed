import json
import os

from helpers import CrossfeedCase, load_crossfeed, run_crossfeed


STARTED = "2026-01-01T12:00:00.500001Z"
STARTED_NS = 1_767_268_800_500_001_000


class ReceiptTests(CrossfeedCase):
    def setUp(self):
        super().setUp()
        self.crossfeed = load_crossfeed()

    def job(self, job_id, result, **fields):
        record = {"type": "job", "id": job_id, "kind": "review", "status": "done", "round": 1,
                  "artifact": "draft", "started": STARTED, "model": "review-model", "sandbox": "read-only"}
        record.update(fields)
        self.crossfeed.append_ledger(record)
        directory = self.home / "jobs" / job_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "brief.md").write_text("Review draft", encoding="utf-8")
        if result is not None:
            (directory / "result.md").write_text(result, encoding="utf-8")
        return directory

    def receipt(self, *args, artifact="draft"):
        return run_crossfeed(["receipt", artifact, *args], env=self.env, cwd=self.root)

    def test_no_match_ignores_other_kinds_and_unfinished_jobs(self):
        self.job("research", "READY", kind="research")
        self.job("failure", "READY", status="failed")
        result = self.receipt("--json")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"crossfeed: no review job for artifact draft\n")

    def test_invalid_artifact_is_a_usage_error(self):
        result = self.receipt(artifact="bad/id")
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"crossfeed: artifact ID", result.stderr)

    def test_json_receipt_has_latest_result_and_use_verdict(self):
        self.job("older", "READY", ts="2026-01-01T12:10:00Z")
        directory = self.job("latest", '{"verdict": "blocked", "explanation": "READY elsewhere"}',
                             round=2, ts="2026-01-01T12:01:00Z")
        self.job("failed", "READY", status="failed", round=3)
        self.job("other", "READY", artifact="other-draft")
        for job, verdict in (("latest", "no"), ("latest", "partly"), ("older", "yes")):
            rated = run_crossfeed(["used", job, verdict], env=self.env)
            self.assertEqual(rated.returncode, 0, rated.stderr)
        result = self.receipt("--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout), {
            "id": "latest", "artifact": "draft", "kind": "review", "round": 2,
            "started": STARTED, "ts": "2026-01-01T12:01:00Z", "model": "review-model",
            "verdict": "blocked", "used": "partly", "done_rounds": 2,
            "brief_path": str(directory / "brief.md"), "result_path": str(directory / "result.md"),
            "paths": [], "stale": False, "stale_paths": [],
        })

    def test_prose_results_have_no_verdict(self):
        for number, text in enumerate((
            "READY",
            "Verdict: READY",
            "Verdict: not yet ready.",
            "Not only ready, but safe to release.",
        )):
            with self.subTest(text=text):
                self.job(str(number), text)
                result = self.receipt("--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(json.loads(result.stdout)["verdict"])

    def test_verdict_requires_a_json_object_with_a_verdict_string(self):
        for number, content in enumerate((
            None, "", '{"verdict": "READY"', '"READY"', "{}", '{"verdict": 1}',
        )):
            with self.subTest(content=content):
                self.job(str(number), content)
                result = self.receipt("--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(json.loads(result.stdout)["verdict"])

    def test_invalid_utf8_and_lone_surrogates_have_no_verdict(self):
        directory = self.job("bytes", None)
        (directory / "result.md").write_bytes(b'{"verdict": "READY", "note": "\xed\xa0\x80"}')
        self.job("surrogate", '{"verdict": "\\ud800"}')
        for job_id in ("bytes", "surrogate"):
            with self.subTest(job=job_id):
                self.job(job_id, None)
                for mode in (["--json"], []):
                    result = self.receipt(*mode)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    if mode:
                        self.assertIsNone(json.loads(result.stdout)["verdict"])
                    else:
                        self.assertIn(b"verdict: none", result.stdout)

    def test_receipt_compares_paths_at_the_nanosecond_boundary(self):
        self.job("job", "READY")
        for path, offset_ns in (("before.md", -1), ("equal.md", 0), ("after.md", 1)):
            target = self.root / path
            target.touch()
            mtime_ns = STARTED_NS + offset_ns
            os.utime(target, ns=(mtime_ns, mtime_ns))
            self.assertEqual(target.stat().st_mtime_ns, mtime_ns)
        fresh = self.receipt("--path", "before.md", "--path", "equal.md")
        self.assertEqual(fresh.returncode, 0, fresh.stderr)
        self.assertIn(b"fresh: before.md\n", fresh.stdout)
        self.assertIn(b"fresh: equal.md\n", fresh.stdout)
        paths = ["--path", "before.md", "--path", "after.md"]
        stale = self.receipt(*paths)
        self.assertEqual(stale.returncode, 3, stale.stderr)
        self.assertIn(b"fresh: before.md\n", stale.stdout)
        self.assertIn(b"stale: after.md modified after job start\n", stale.stdout)
        stale = self.receipt(*paths, "--json")
        self.assertEqual(stale.returncode, 3, stale.stderr)
        receipt = json.loads(stale.stdout)
        self.assertEqual(receipt["paths"], ["before.md", "after.md"])
        self.assertIs(receipt["stale"], True)
        self.assertEqual(receipt["stale_paths"], ["after.md"])

    def test_receipt_compares_paths_against_whole_second_job_start(self):
        started = "2026-01-01T12:00:00Z"
        started_ns = 1_767_268_800_000_000_000
        self.job("legacy-start", '{"verdict": "READY"}', started=started)
        draft = self.root / "draft.md"
        draft.touch()
        for offset_ns, exit_code, stale_paths in ((0, 0, []), (1, 3, [draft.name])):
            with self.subTest(offset_ns=offset_ns):
                mtime_ns = started_ns + offset_ns
                os.utime(draft, ns=(mtime_ns, mtime_ns))
                self.assertEqual(draft.stat().st_mtime_ns, mtime_ns)
                result = self.receipt("--path", draft.name, "--json")
                self.assertEqual(result.returncode, exit_code, result.stderr)
                receipt = json.loads(result.stdout)
                self.assertEqual((receipt["id"], receipt["started"]), ("legacy-start", started))
                self.assertIs(receipt["stale"], bool(stale_paths))
                self.assertEqual(receipt["stale_paths"], stale_paths)

    def test_missing_path_is_a_usage_error(self):
        self.job("job", "READY")
        for artifact in ("draft", "unknown"):
            result = self.receipt("--path", "missing.md", "--json", artifact=artifact)
            self.assertEqual(result.returncode, 2)
            self.assertIn(b"crossfeed: could not stat path missing.md", result.stderr)
            self.assertEqual(result.stdout, b"")

    def test_empty_path_is_a_usage_error(self):
        self.job("job", "READY")
        result = self.receipt("--path", "", "--json")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"crossfeed: --path must not be empty\n")
        self.assertEqual(result.stdout, b"")

    def test_kind_any_selects_the_latest_job_with_rounds_for_its_kind(self):
        self.job("research-one", "READY", kind="research")
        self.job("review", "READY")
        self.job("research-two", "READY", kind="research", round=2)
        for flags, job_id, kind, rounds in (([], "review", "review", 1),
                                          (["--kind", "any"], "research-two", "research", 2),
                                          (["--kind", "research"], "research-two", "research", 2)):
            with self.subTest(flags=flags):
                result = self.receipt("--json", *flags)
                self.assertEqual(result.returncode, 0, result.stderr)
                receipt = json.loads(result.stdout)
                self.assertEqual((receipt["id"], receipt["kind"], receipt["done_rounds"]), (job_id, kind, rounds))

    def test_legacy_job_still_folds_in_report_and_is_skipped_by_receipt(self):
        self.job("labelled", "READY")
        self.crossfeed.append_ledger({"type": "job", "id": "legacy", "kind": "review", "status": "done",
                                      "started": "2026-01-01T12:00:00Z", "sandbox": "read-only"})
        report = run_crossfeed(["report", "--json"], env=self.env)
        self.assertEqual(report.returncode, 0, report.stderr)
        self.assertEqual(json.loads(report.stdout)["by_status"]["done"], 2)
        result = self.receipt("--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual((receipt["id"], receipt["done_rounds"]), ("labelled", 1))


if __name__ == "__main__":
    import unittest

    unittest.main()
