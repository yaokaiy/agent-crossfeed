import json
import os
from pathlib import Path
from unittest.mock import patch

from helpers import CrossfeedCase, load_crossfeed, run_crossfeed


class CodexLookupTests(CrossfeedCase):
    def candidate(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "codex"
        path.write_bytes(self.shim.read_bytes())
        path.chmod(0o755)
        return path

    def resolved(self, env):
        with patch.dict(os.environ, env, clear=True):
            return load_crossfeed().resolve_codex()

    def succeeds(self, command, directory, env, extra=()):
        capture = self.root / "child-path.txt"
        capture.unlink(missing_ok=True)
        args = [command, *extra]
        if command == "run":
            args += ["--dir", str(self.root)]
        result = run_crossfeed(args, stdin=b"Read this isolated task.\n",
                               env=dict(env, FAKE_CODEX_PATH=str(capture)), cwd=self.root)
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        if command == "quota":
            reading = json.loads(result.stdout)
            self.assertEqual(reading["source"], "app-server", reading)
            self.assertIsNone(reading["app_server_error"])
        child_path = capture.read_text()
        original = env.get("PATH", os.defpath)
        expected = original if str(directory) in original.split(os.pathsep) else (
            str(directory) + (os.pathsep + original if original else ""))
        self.assertEqual(child_path, expected)
        return result

    def test_unset_and_empty_override_use_path(self):
        for value in (None, ""):
            env = dict(self.env)
            if value is not None:
                env["CROSSFEED_CODEX"] = value
            with self.subTest(value=value):
                self.assertEqual(self.resolved(env), str(self.shim))

    def test_override_accepts_valid_file_tilde_and_symlink(self):
        alternate = self.candidate(self.root / "alternate")
        link = self.root / "links" / "codex"
        link.parent.mkdir()
        link.symlink_to(alternate)
        for value, expected in ((str(alternate), alternate), ("~/alternate/codex", alternate),
                                (str(link), link)):
            with self.subTest(value=value):
                env = dict(self.env, HOME=str(self.root), CROSSFEED_CODEX=value)
                self.assertEqual(self.resolved(env), str(expected))
                for command in ("run", "quota"):
                    self.succeeds(command, expected.parent, env)

    def test_invalid_override_does_not_try_path_or_fallback(self):
        not_executable = self.root / "not-executable"
        not_executable.touch()
        for value in (str(self.bin), str(not_executable), str(self.root / "missing")):
            with self.subTest(value=value):
                env = dict(self.env, CROSSFEED_CODEX=value, CROSSFEED_CODEX_DIRS=str(self.bin))
                result = run_crossfeed(["run", "--dir", str(self.root)], stdin=b"task", env=env)
                self.assertEqual(result.returncode, 127, result.stdout)
                record = load_crossfeed().read_ledger()[-1]
                self.assertEqual(record["status"], "failed")
                detail = (self.home / "jobs" / record["id"] / "stderr.log").read_text()
                self.assertIn("CROSSFEED_CODEX", detail)
                self.assertIn(value, detail)
                reading = json.loads(run_crossfeed(["quota"], env=env).stdout)
                self.assertEqual(reading["source"], "none")
                self.assertIn("CROSSFEED_CODEX", reading["app_server_error"])

    def test_path_unset_uses_shutil_default_search_then_fallback(self):
        env = dict(self.env, CROSSFEED_CODEX_DIRS=str(self.bin))
        del env["PATH"]
        crossfeed = load_crossfeed()
        # Isolate shutil.which's OS default too; never search the host for Codex.
        with patch.dict(os.environ, env, clear=True), patch.object(os, "defpath", str(self.root / "absent")):
            self.assertEqual(crossfeed.resolve_codex(), str(self.shim))

    def test_path_empty_directory_or_nonexecutable_are_not_candidates(self):
        directory = self.root / "directory-on-path"
        (directory / "codex").mkdir(parents=True)
        nonexec = self.root / "nonexec-on-path"
        nonexec.mkdir()
        (nonexec / "codex").touch()
        for path in ("", str(directory), str(nonexec)):
            with self.subTest(path=path):
                env = dict(self.env, PATH=path)
                with self.assertRaises(FileNotFoundError):
                    self.resolved(env)
                for command in ("run", "quota"):
                    self.succeeds(command, self.bin, dict(env, CROSSFEED_CODEX_DIRS=str(self.bin)))

    def test_fallback_list_empty_entries_missing_unicode_and_first_match(self):
        first = self.candidate(self.root / "安装 naïve")
        second = self.candidate(self.root / "second")
        missing = self.root / "absent"
        for directories in (str(first.parent),
                            os.pathsep.join(("", str(missing), "", str(first.parent), str(second.parent), ""))):
            with self.subTest(directories=directories):
                env = dict(self.env, PATH="", CROSSFEED_CODEX_DIRS=directories)
                self.assertEqual(self.resolved(env), str(first))
                for command in ("run", "quota"):
                    self.succeeds(command, first.parent, env)

    def test_empty_fallback_list_does_not_search_home_or_cwd(self):
        self.candidate(self.root / ".local" / "bin")
        self.candidate(self.root)
        for directories in ("", os.pathsep * 2, str(self.root / "missing")):
            with self.subTest(directories=directories):
                env = dict(self.env, HOME=str(self.root), PATH=str(self.root / "empty"),
                           CROSSFEED_CODEX_DIRS=directories)
                result = run_crossfeed(["run", "--dir", str(self.root)], stdin=b"task", env=env, cwd=self.root)
                self.assertEqual(result.returncode, 127, result.stdout)
                self.assertIn(b"codex was not found", result.stdout)

    def test_fallback_expands_tilde(self):
        env = dict(self.env, HOME=str(self.root), PATH="", CROSSFEED_CODEX_DIRS="~/bin")
        self.assertEqual(self.resolved(env), str(self.shim))

    def test_default_fallback_order(self):
        crossfeed = load_crossfeed()
        env = dict(self.env, HOME=str(self.root), PATH="")
        del env["CROSSFEED_CODEX_DIRS"]
        attempted = []

        def missing(path):
            attempted.append(str(path))
            return False

        with patch.dict(os.environ, env, clear=True), patch.object(crossfeed.shutil, "which", return_value=None), \
                patch.object(Path, "is_file", missing):
            with self.assertRaises(FileNotFoundError):
                crossfeed.resolve_codex()
        self.assertEqual(attempted, [str(Path(d) / "codex") for d in (
            "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin",
            str(self.root / ".local/bin"), str(self.root / ".npm-global/bin"),
            str(self.root / ".bun/bin"), str(self.root / ".volta/bin"))])

    def test_path_precedes_fallback_and_is_not_duplicated(self):
        fallback = self.candidate(self.root / "fallback")
        env = dict(self.env, CROSSFEED_CODEX_DIRS=str(fallback.parent))
        for command in ("run", "quota"):
            self.succeeds(command, self.bin, env)

    def test_directory_already_on_path_keeps_its_place(self):
        original = str(self.root / "missing") + os.pathsep + str(self.bin)
        env = dict(self.env, PATH=original)
        for command in ("run", "quota"):
            self.succeeds(command, self.bin, env)
            self.assertEqual((self.root / "child-path.txt").read_text(), original)

    def test_unset_path_keeps_the_system_default_behind_the_fallback_directory(self):
        env = dict(self.env, CROSSFEED_CODEX_DIRS=str(self.bin))
        del env["PATH"]
        for command in ("run", "quota"):
            self.succeeds(command, self.bin, env)
            self.assertEqual((self.root / "child-path.txt").read_text(),
                             str(self.bin) + os.pathsep + os.defpath)

    def interpreted(self, with_interpreter):
        """A codex like the npm one: a script whose interpreter sits beside it."""
        directory = self.root / ("npm-bin" if with_interpreter else "npm-bin-broken")
        directory.mkdir()
        codex = directory / "codex"
        codex.write_text("#!/usr/bin/env crossfeed-test-node\n", encoding="utf-8")
        codex.chmod(0o755)
        if with_interpreter:
            node = directory / "crossfeed-test-node"
            node.write_text("#!/bin/sh\nshift\nexec {} \"$@\"\n".format(self.shim), encoding="utf-8")
            node.chmod(0o755)
        return directory

    def test_interpreter_beside_codex_is_found_through_the_child_path(self):
        directory = self.interpreted(True)
        env = dict(self.env, PATH="", CROSSFEED_CODEX_DIRS=str(directory))
        for command in ("run", "quota"):
            self.succeeds(command, directory, env)

    def test_codex_that_exists_but_cannot_start_is_a_failure_not_a_missing_codex(self):
        directory = self.interpreted(False)
        env = dict(self.env, PATH="", CROSSFEED_CODEX_DIRS=str(directory))
        result = run_crossfeed(["run", "--dir", str(self.root)], stdin=b"task", env=env, cwd=self.root)
        self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
        record = load_crossfeed().read_ledger()[-1]
        self.assertEqual((record["status"], record["exit"]), ("failed", 1))
        self.assertNotIn(b"codex was not found", result.stdout)
        reading = json.loads(run_crossfeed(["quota"], env=env).stdout)
        self.assertEqual(reading["source"], "none")
        self.assertTrue(reading["app_server_error"])

    def test_resume_uses_fallback_and_child_path(self):
        env = dict(self.env, PATH="", CROSSFEED_CODEX_DIRS=str(self.bin))
        self.succeeds("run", self.bin, env)
        job = load_crossfeed().read_ledger()[-1]["id"]
        self.succeeds("run", self.bin, env, ("--resume", job))
        self.assertEqual(load_crossfeed().read_ledger()[-1]["resume_of"], job)
