import concurrent.futures
import io
import contextlib
import os
from pathlib import Path
import stat
import sys
import unittest
from unittest.mock import patch

from helpers import CrossfeedCase, load_crossfeed, run_crossfeed


class BriefTests(CrossfeedCase):
    def test_stash_round_trip_and_mode(self):
        brief = "检查 naïve\r\nCROSSFEED_BRIEF_EOF\r\n$(touch pwned)\r\n".encode()
        result = run_crossfeed(["stash"], stdin=brief, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        path = Path(os.fsdecode(result.stdout.rstrip(b"\n")))
        self.assertTrue(path.is_absolute())
        self.assertEqual(path.parent, self.home.resolve() / "briefs")
        self.assertRegex(path.name, r"^\d{8}-\d{6}-[0-9a-f]{4}\.md$")
        self.assertEqual(path.read_bytes(), brief)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_stash_empty_writes_nothing(self):
        for brief in (b"", b" \t\r\n"):
            with self.subTest(brief=brief):
                result = run_crossfeed(["stash"], stdin=brief, env=self.env)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"brief", result.stderr)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(list(self.home.iterdir()), [])

    def test_concurrent_stashes_have_different_files(self):
        briefs = [b"first\r\n", "第二\r\n".encode()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda brief: run_crossfeed(["stash"], stdin=brief, env=self.env), briefs))
        paths = []
        for brief, result in zip(briefs, results):
            self.assertEqual(result.returncode, 0, result.stderr)
            path = Path(os.fsdecode(result.stdout.strip()))
            self.assertEqual(path.read_bytes(), brief)
            paths.append(path)
        self.assertNotEqual(*paths)

    def test_stash_collision_does_not_overwrite(self):
        directory = self.home / "briefs"
        directory.mkdir()
        original = directory / "20261117-010203-aaaa.md"
        original.write_bytes(b"original")
        crossfeed = load_crossfeed()
        stdin = io.TextIOWrapper(io.BytesIO(b"new"))
        stdout = io.StringIO()
        with patch.object(crossfeed, "new_job_id", side_effect=[original.stem, "20261117-010203-bbbb"]), \
                patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(stdout):
            self.assertEqual(crossfeed.main(["stash"]), 0)
        self.assertEqual(original.read_bytes(), b"original")
        self.assertEqual(Path(stdout.getvalue().strip()).read_bytes(), b"new")

    def test_brief_file_missing_empty_and_whitespace(self):
        path = self.root / "brief.md"
        for brief in (None, b"", b" \r\n\t"):
            with self.subTest(brief=brief):
                if brief is not None:
                    path.write_bytes(brief)
                result = run_crossfeed(["run", "--brief-file", str(path)], stdin=b"ignore stdin", env=self.env)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"could not read brief" if brief is None else b"brief must not be empty", result.stderr)
                self.assertEqual(list(self.home.iterdir()), [])

    @unittest.skipIf(os.geteuid() == 0, "root can read any file")
    def test_brief_file_unreadable(self):
        path = self.root / "brief.md"
        path.write_bytes(b"brief")
        path.chmod(0)
        self.addCleanup(path.chmod, 0o600)
        result = run_crossfeed(["run", "--brief-file", str(path)], env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"could not read brief", result.stderr)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_brief_file_reaches_codex_byte_for_byte(self):
        brief = "CROSSFEED_BRIEF_EOF\r\n$(touch pwned)\r\n检查 naïve\r\n".encode()
        path = self.root / "brief ü.md"
        path.write_bytes(brief)
        result = run_crossfeed(["run", "--dir", str(self.root), "--brief-file", str(path)],
                               stdin=b"must not reach Codex", env=dict(self.env, FAKE_CODEX="echo"))
        self.assertEqual(result.returncode, 0, result.stderr)
        record, = load_crossfeed().read_ledger()
        job = self.home / "jobs" / record["id"]
        self.assertEqual((job / "brief.md").read_bytes(), brief)
        self.assertEqual((job / "result.md").read_bytes(), load_crossfeed().PREAMBLE_READ.encode() + b"\n\n" + brief)
        self.assertFalse((self.root / "pwned").exists())

    def test_brief_file_does_not_read_stdin(self):
        path = self.root / "brief.md"
        path.write_bytes(b"brief")
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin") as stdin, \
                contextlib.redirect_stdout(io.StringIO()):
            stdin.buffer.read.side_effect = AssertionError("stdin must not be read")
            self.assertEqual(load_crossfeed().main(["run", "--dir", str(self.root), "--brief-file", str(path)]), 0)
