import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time
from unittest.mock import patch

from helpers import CROSSFEED, CrossfeedCase, load_crossfeed, run_crossfeed


class ChangesTests(CrossfeedCase):
    def setUp(self):
        super().setUp()
        self.repo = self.root / "repository with ü"
        self.repo.mkdir()
        self.env.update(
            GIT_AUTHOR_NAME="Crossfeed Test", GIT_AUTHOR_EMAIL="crossfeed@example.invalid",
            GIT_COMMITTER_NAME="Crossfeed Test", GIT_COMMITTER_EMAIL="crossfeed@example.invalid",
        )
        self.git("init", "--quiet")
        (self.repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        (self.repo / "dirty.txt").write_text("clean\n", encoding="utf-8")
        self.git("add", "tracked.txt", "dirty.txt")
        tree = self.git("write-tree").strip()
        commit = self.git("commit-tree", tree, stdin=b"synthetic test baseline\n").strip()
        self.git("update-ref", "HEAD", commit)
        (self.repo / "dirty.txt").write_text("dirty before the job\n", encoding="utf-8")

    def git(self, *args, stdin=None):
        result = subprocess.run(["git", "-C", str(self.repo), *args], input=stdin,
                                env=self.env, capture_output=True, check=True)
        return result.stdout.decode("utf-8")

    def run_job(self, args=(), mode="write", **env):
        return run_crossfeed(["run", "--dir", str(self.repo), *args], stdin=b"Make the requested change.\n",
                         env=dict(self.env, FAKE_CODEX=mode, **env), cwd=self.root)

    def last_record(self):
        return load_crossfeed().read_ledger()[-1]

    def test_write_job_lists_changes(self):
        result = self.run_job(["--write"])
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertIn("[crossfeed] workspace changes during the run: new file ü.txt, tracked.txt".encode(), result.stdout)
        self.assertNotIn(b"dirty.txt", result.stdout)
        self.assertEqual(self.last_record()["observed"], ["new file ü.txt", "tracked.txt"])
        self.assertFalse(self.last_record()["head_moved"])
        lines = result.stdout.decode().splitlines()
        index = next(index for index, line in enumerate(lines) if line.startswith("[crossfeed] job "))
        self.assertEqual(lines[index + 1], "[crossfeed] codex edits: new file ü.txt, tracked.txt")

    def test_already_dirty_file_changed_again_is_listed(self):
        result = self.run_job(["--write"], mode="dirty")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"dirty.txt", result.stdout)
        self.assertEqual(self.last_record()["observed"], ["dirty.txt", "new file ü.txt", "tracked.txt"])

    def test_no_change_is_flagged(self):
        result = self.run_job(["--write"], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"[crossfeed] workspace changes during the run: none", result.stdout)
        self.assertEqual(self.last_record()["observed"], [])

    def test_snapshot_errors_keep_write_job_success_and_comparison_unavailable(self):
        crossfeed = load_crossfeed()
        before = {"head": "initial", "files": {}}
        for snapshots in ([OSError("cannot read file before the run")],
                          [before, OSError("cannot read changed file")]):
            with self.subTest(phase=len(snapshots)):
                stdout, stderr = io.StringIO(), io.StringIO()
                stdin = io.TextIOWrapper(io.BytesIO(b"Make the requested change."))
                with patch.dict(os.environ, self.env), patch.object(sys, "stdin", stdin), \
                        patch.object(crossfeed, "snapshot", side_effect=snapshots), \
                        contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = crossfeed.main(["run", "--write", "--json", "--dir", str(self.repo)])
                self.assertEqual(code, 0, stderr.getvalue())
                data = json.loads(stdout.getvalue())
                self.assertEqual((data["status"], data["observed"]), ("done", "unavailable"))
                self.assertIn("ok:", data["result"])
                record = crossfeed.read_ledger()[-1]
                self.assertEqual((record["status"], record["exit"], record["observed"]),
                                 ("done", 0, "unavailable"))
                self.assertEqual(record["tokens"]["input"], 12000)

    def test_read_job_never_calls_snapshot(self):
        crossfeed = load_crossfeed()
        stdin = io.TextIOWrapper(io.BytesIO(b"Read the requested file."))
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin", stdin), \
                patch.object(crossfeed, "snapshot", side_effect=AssertionError("unexpected Git snapshot")) as snapshot, \
                contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()):
            code = crossfeed.main(["run", "--json", "--dir", str(self.repo)])
        self.assertEqual(code, 0)
        snapshot.assert_not_called()
        self.assertNotIn("observed", json.loads(stdout.getvalue()))
        self.assertNotIn("head_moved", crossfeed.read_ledger()[-1])

    def test_json_interrupt_during_delayed_final_git_status_finishes_within_grace(self):
        git = self.root / "git"
        git.write_text("#!" + sys.executable + "\n"
                       "import os, sys, time\n"
                       "from pathlib import Path\n"
                       "if 'status' in sys.argv and Path(os.environ['FAKE_CODEX_ARGV']).exists():\n"
                       "    Path(os.environ['FINAL_STATUS_READY']).touch()\n"
                       "    time.sleep(4)\n"
                       "os.execv(" + repr(shutil.which("git")) + ", sys.argv)\n", encoding="utf-8")
        git.chmod(0o700)
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum):
                ready = self.root / ("status-" + str(signum))
                argv = self.root / ("argv-" + str(signum))
                env = dict(self.env, PATH=str(self.root) + os.pathsep + self.env["PATH"],
                           FAKE_CODEX_ARGV=str(argv), FINAL_STATUS_READY=str(ready))
                with subprocess.Popen(
                    [sys.executable, "-I", str(CROSSFEED), "run", "--json", "--write", "--dir", str(self.repo)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                ) as dispatcher:
                    try:
                        dispatcher.stdin.write(b"Write the change.\n")
                        dispatcher.stdin.close()
                        dispatcher.stdin = None
                        deadline = time.monotonic() + 8
                        while not ready.exists() and dispatcher.poll() is None and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertTrue(ready.exists(), "final git status never started")
                        dispatcher.send_signal(signum)
                        stdout, stderr = dispatcher.communicate(timeout=2)
                        self.assertEqual(dispatcher.returncode, 130, (stdout, stderr))
                        self.assertEqual(stderr, b"")
                        data = json.loads(stdout)
                        row = self.last_record()
                        self.assertEqual((data["status"], data["observed"]), ("interrupted", "unavailable"))
                        self.assertEqual((row["id"], row["status"], row["codex_thread"]),
                                         (data["id"], "interrupted", "fake-thread-1"))
                    finally:
                        if dispatcher.poll() is None:
                            dispatcher.kill()

    def test_head_moved_is_flagged(self):
        result = self.run_job(["--write"], mode="commit")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertIn(b"[crossfeed] warning: HEAD moved during the run", result.stdout)
        self.assertTrue(self.last_record()["head_moved"])

    def test_interrupted_write_keeps_full_accounting(self):
        brief, ready, release = (self.root / name for name in ("brief.md", "ready", "release"))
        brief.write_text("Change the tracked file.\n")
        tree = self.git("write-tree").strip()
        moved_head = self.git("commit-tree", tree, stdin=b"synthetic HEAD movement\n").strip()
        with subprocess.Popen(
            [sys.executable, "-I", str(CROSSFEED), "run", "--write", "--dir", str(self.repo), "--brief-file", str(brief)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(self.env, FAKE_CODEX="hold", FAKE_CODEX_READY=str(ready), FAKE_CODEX_RELEASE=str(release)),
        ) as dispatcher:
            try:
                deadline = time.monotonic() + 8
                while not ready.exists() and dispatcher.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "fake Codex never started")
                (self.repo / "tracked.txt").write_text("changed\n")
                self.git("update-ref", "HEAD", moved_head)
                dispatcher.send_signal(signal.SIGTERM)
                stdout, stderr = dispatcher.communicate(timeout=8)
                self.assertEqual(dispatcher.returncode, 130, (stdout, stderr))
            finally:
                release.touch()
                if dispatcher.poll() is None:
                    dispatcher.kill()
        record, = load_crossfeed().read_ledger()
        self.assertEqual(record["status"], "interrupted")
        self.assertEqual(record["tokens"]["input"], 12)
        self.assertEqual(record["codex_thread"], "fake-thread-1")
        self.assertEqual(record["observed"], ["tracked.txt"])
        self.assertTrue(record["head_moved"])
        state = json.loads((self.home / "jobs" / record["id"] / "state.json").read_text())
        self.assertEqual({key: state[key] for key in ("tokens", "codex_thread", "observed", "head_moved")},
                         {key: record[key] for key in ("tokens", "codex_thread", "observed", "head_moved")})

    def test_non_git_directory(self):
        result = self.run_job(["--write", "--dir", str(self.root)], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"[crossfeed] workspace changes: unavailable (not a git repository)", result.stdout)
        self.assertEqual(self.last_record()["observed"], "unavailable")

    def test_non_git_report_preserves_codex_edits_and_unavailable_comparison(self):
        result = self.run_job(["--json", "--write", "--dir", str(self.root)])
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["observed"], "unavailable")
        self.assertEqual(report["codex_edited"], ["new file ü.txt", "tracked.txt"])
        self.assertEqual(result.stderr, b"")
        self.assertEqual(self.last_record()["codex_edited"], report["codex_edited"])

    def test_overlapping_dispatchers_separate_codex_edits_from_workspace_changes(self):
        ready, release, brief = (self.root / name for name in ("ready", "release", "hold-brief.md"))
        brief.write_text("Review the workspace.", encoding="utf-8")
        with subprocess.Popen(
            [sys.executable, "-I", str(CROSSFEED), "run", "--json", "--dir", str(self.repo),
             "--brief-file", str(brief)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(self.env, FAKE_CODEX="hold", FAKE_CODEX_READY=str(ready), FAKE_CODEX_RELEASE=str(release)),
        ) as reviewer:
            try:
                deadline = time.monotonic() + 8
                while not ready.exists() and reviewer.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "reviewer never started")
                writer = self.run_job(["--json", "--write"])
                self.assertEqual(writer.returncode, 0, writer.stderr)
                release.touch()
                stdout, stderr = reviewer.communicate(timeout=8)
                self.assertEqual(reviewer.returncode, 0, stderr)
                report = json.loads(stdout)
                self.assertEqual(report["codex_edited"], [])
                paths = ["new file ü.txt", "tracked.txt"]
                self.assertNotIn("observed", report)
                self.assertNotIn("head_moved", report)
                self.assertEqual(json.loads(writer.stdout)["observed"], paths)
                self.assertEqual(json.loads(writer.stdout)["codex_edited"], paths)
                self.assertNotIn(b"this read job edited", stderr)
                self.assertEqual(stderr, b"")
            finally:
                release.touch()
                if reviewer.poll() is None:
                    reviewer.kill()

    def test_unborn_branch(self):
        unborn = self.root / "unborn"
        unborn.mkdir()
        subprocess.run(["git", "init", "--quiet", str(unborn)], env=self.env, check=True)
        result = self.run_job(["--write", "--dir", str(unborn)])
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertEqual(self.last_record()["observed"], ["new file ü.txt", "tracked.txt"])
        self.assertFalse(self.last_record()["head_moved"])
        self.assertIsNone(load_crossfeed().snapshot(str(unborn))["head"])

    def test_resume_uses_thread_and_dir(self):
        result = self.run_job(["--write"], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.last_record()
        argv_file = self.root / "resume-argv.json"
        cwd_file = self.root / "resume-cwd.txt"
        # A resume keeps the saved directory and role.
        result = self.run_job(["--resume", first["id"], "--dir", str(self.root), "--effort", "xhigh"],
                              mode="write", FAKE_CODEX_ARGV=str(argv_file), FAKE_CODEX_CWD=str(cwd_file))
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        argv = json.loads(argv_file.read_text())
        self.assertEqual(argv[1:4], ["exec", "resume", first["codex_thread"]])
        self.assertEqual(argv[4:8], ["--skip-git-repo-check", "--json", "-c", 'model_reasoning_effort="xhigh"'])
        self.assertIn('project_doc_fallback_filenames=["CLAUDE.md"]', argv)
        self.assertNotIn("-s", argv)
        self.assertNotIn("-C", argv)
        self.assertNotIn("--worktree", argv)
        self.assertEqual(cwd_file.read_text(), str(self.repo.resolve()))
        record = self.last_record()
        self.assertEqual(record["resume_of"], first["id"])
        self.assertEqual(record["dir"], first["dir"])
        self.assertIs(record["write"], True)
        self.assertEqual(record["observed"], ["new file ü.txt", "tracked.txt"])
        self.assertNotEqual(record["id"], first["id"])

    def test_resume_unknown_job_exit_2(self):
        for job in ("missing", ""):
            with self.subTest(job=job):
                result = self.run_job(["--resume", job], mode="ok")
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"unknown", result.stderr.lower())
                self.assertEqual(load_crossfeed().read_ledger(), [])

    def test_resume_without_thread_exit_2(self):
        load_crossfeed().append_ledger({"type": "job", "id": "missing-thread", "codex_thread": None})
        result = self.run_job(["--resume", "missing-thread"], mode="ok")
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"thread", result.stderr.lower())
        self.assertEqual(len(load_crossfeed().read_ledger()), 1)

    def test_resume_with_worktree_exit_2(self):
        result = self.run_job(mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        job_id = self.last_record()["id"]
        result = self.run_job(["--resume", job_id, "--worktree"], mode="ok")
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"worktree", result.stderr)
        self.assertEqual(len(load_crossfeed().read_ledger()), 1)

    def test_resume_keeps_read_role_even_with_write_flag(self):
        result = self.run_job(mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.last_record()
        argv_file = self.root / "resume.json"
        result = self.run_job(["--resume", first["id"], "--write"], mode="ok", FAKE_CODEX_ARGV=str(argv_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('sandbox_mode="read-only"', json.loads(argv_file.read_text()))
        self.assertIs(self.last_record()["write"], False)
        self.assertNotIn("observed", self.last_record())

    def test_resume_infers_role_from_legacy_sandbox_rows(self):
        crossfeed = load_crossfeed()
        for sandbox, write in (("read-only", False), ("workspace-write", True)):
            with self.subTest(sandbox=sandbox):
                crossfeed.append_ledger({"type": "job", "id": sandbox, "sandbox": sandbox,
                                        "dir": str(self.repo), "codex_thread": "legacy-thread"})
                result = self.run_job(["--resume", sandbox], mode="echo")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIs(self.last_record()["write"], write)
                self.assertIn(b"; write; codex tokens " if write else b"; read; codex tokens ", result.stdout)
                statement = b"Change files only inside that directory" if write else b"Do not change any project file"
                self.assertIn(statement, result.stdout)

    def test_read_job_warns_on_cli_and_reports_only_codex_edits_in_json(self):
        text = self.run_job(mode="write")
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertIn("[crossfeed] warning: this read job edited 2 file(s): new file ü.txt, tracked.txt".encode(),
                      text.stdout)
        self.assertNotIn(b"workspace changes", text.stdout)
        self.assertIn(b" used ", text.stdout)
        result = self.run_job(["--json"], mode="write")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        data, record = json.loads(result.stdout), self.last_record()
        for report in (data, record):
            self.assertEqual(report["codex_edited"], ["new file ü.txt", "tracked.txt"])
            self.assertNotIn("observed", report)
            self.assertNotIn("head_moved", report)

    def test_json_head_movement_is_reported_only_for_write_jobs(self):
        for flags in ([], ["--write"]):
            with self.subTest(flags=flags):
                result = self.run_job(["--json", *flags], mode="commit")
                self.assertEqual(result.returncode, 0, result.stderr)
                data, record = json.loads(result.stdout), self.last_record()
                self.assertIs(record["write"], bool(flags))
                for report in (data, record):
                    if flags:
                        self.assertTrue(report["head_moved"])
                        self.assertIsInstance(report["observed"], list)
                    else:
                        self.assertNotIn("head_moved", report)
                        self.assertNotIn("observed", report)

    def test_resume_records_inherited_model(self):
        result = self.run_job(["--model", "original-model"], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.last_record()
        result = self.run_job(["--resume", first["id"]], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last_record()["model"], "original-model")

    def test_resume_rejects_unapplied_model_override(self):
        result = self.run_job(mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_job(["--resume", self.last_record()["id"], "--model", "other"], mode="ok")
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"--model", result.stderr)
        self.assertEqual(len(load_crossfeed().read_ledger()), 1)

    def test_snapshot_uses_repository_relative_paths_and_raw_names(self):
        crossfeed = load_crossfeed()
        nested = self.repo / "nested"
        nested.mkdir()
        strange = nested / "space ü\tline\n.txt"
        strange.write_bytes(b"contents\r\n")
        (self.repo / "outside.txt").write_bytes(b"outside")
        state = crossfeed.snapshot(str(nested))
        self.assertEqual(state["head"], self.git("rev-parse", "HEAD").strip())
        self.assertEqual(state["files"], {
            "nested/space ü\tline\n.txt": hashlib.sha1(b"contents\r\n").hexdigest(),
        })

    def test_snapshot_handles_deleted_and_renamed_paths(self):
        crossfeed = load_crossfeed()
        (self.repo / "tracked.txt").unlink()
        self.git("mv", "dirty.txt", "renamed ü.txt")
        state = crossfeed.snapshot(str(self.repo))
        self.assertEqual(state["files"]["tracked.txt"], "deleted")
        self.assertEqual(state["files"]["renamed ü.txt"], hashlib.sha1(b"dirty before the job\n").hexdigest())

    def test_changes_compares_digests_and_head(self):
        crossfeed = load_crossfeed()
        before = {"head": "one", "files": {"same": "a", "dirty": "b", "gone": "c"}}
        after = {"head": "two", "files": {"same": "a", "dirty": "new", "added": "d"}}
        self.assertEqual(crossfeed.changes(before, after), {
            "changed": ["added", "dirty", "gone"], "head_moved": True,
        })

    def test_workspace_snapshot_detects_an_executable_bit_change_on_an_untracked_file(self):
        crossfeed = load_crossfeed()
        script = self.repo / "script.sh"
        script.write_text("echo ok\n")
        script.chmod(0o644)
        before = crossfeed.snapshot(str(self.repo))
        script.chmod(0o755)
        after = crossfeed.snapshot(str(self.repo))
        self.assertEqual(crossfeed.changes(before, after), {"changed": ["script.sh"], "head_moved": False})

    def test_change_output_caps_paths_at_ten(self):
        result = self.run_job(["--write"], mode="many-files")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.last_record()["observed"]), 12)
        self.assertIn(b"(+2 more)", result.stdout)
        self.assertNotIn(b"file-10.txt", result.stdout)

    def test_links_and_fifo_do_not_hang_and_changes_are_named(self):
        (self.repo / "zero-link").symlink_to("/dev/zero")
        outside = self.root / "outside.txt"
        outside.write_bytes(b"outside")
        (self.repo / "outside-link").symlink_to(outside)
        os.mkfifo(self.repo / "pipe")
        result = subprocess.run(
            [sys.executable, "-I", str(CROSSFEED), "run", "--write", "--dir", str(self.repo)],
            input=b"Change links and FIFO.", capture_output=True, timeout=30,
            env=dict(self.env, FAKE_CODEX="special-files"))
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertIn(b"workspace changes during the run: outside-link, pipe, zero-link", result.stdout)
        self.assertEqual(outside.read_bytes(), b"outside")

    def test_link_digest_uses_target_without_opening_it(self):
        crossfeed = load_crossfeed()
        for target in ("/dev/zero", str(self.root / "missing")):
            with self.subTest(target=target):
                link = self.repo / "link"
                link.symlink_to(target)
                try:
                    with patch.object(Path, "open", side_effect=AssertionError("must not open a link")):
                        self.assertEqual(crossfeed._file_digest(link), "link:" + target)
                finally:
                    link.unlink()

    def test_fifo_and_device_digests_never_open(self):
        pipe = self.repo / "pipe"
        os.mkfifo(pipe)
        for path in (pipe, Path("/dev/zero")):
            with self.subTest(path=path), patch.object(Path, "open", side_effect=AssertionError("must not open special files")):
                self.assertEqual(load_crossfeed()._file_digest(path), "special")

    def test_socket_digest_never_opens(self):
        crossfeed = load_crossfeed()
        # Socket binding is unavailable in some test sandboxes.
        socket_stat = os.stat_result((stat.S_IFSOCK | 0o600,) + (0,) * 9)
        with patch.object(crossfeed.os, "lstat", return_value=socket_stat), \
                patch.object(Path, "open", side_effect=AssertionError("must not open a socket")):
            self.assertEqual(crossfeed._file_digest(self.repo / "socket"), "special")

    def test_worktree_job_skips_snapshots_and_prints_location(self):
        crossfeed = load_crossfeed()
        for flags in (["--write"], []):
            with self.subTest(flags=flags):
                stdout = io.StringIO()
                stdin = io.TextIOWrapper(io.BytesIO(b"Change the managed worktree."))
                with patch.dict(os.environ, self.env), patch.object(sys, "stdin", stdin), \
                        patch.object(crossfeed, "snapshot", side_effect=AssertionError("must not snapshot --dir")), \
                        contextlib.redirect_stdout(stdout):
                    code = crossfeed.main(["run", "--worktree", "--dir", str(self.repo), *flags])
                self.assertEqual(code, 0)
                self.assertIn("[crossfeed] worktree job: changes are in Codex's managed worktree, not in {}\n".format(
                    self.repo.resolve()), stdout.getvalue())
                self.assertNotIn("no files changed", stdout.getvalue())
                self.assertNotIn("[crossfeed] changed", stdout.getvalue())
                self.assertNotIn("no change list", stdout.getvalue())
                if flags:
                    self.assertEqual(self.last_record()["observed"], "unavailable")
                else:
                    self.assertNotIn("observed", self.last_record())

    def test_already_dirty_submodule_edited_again_is_listed(self):
        submodule = self.repo / "submodule"
        submodule.mkdir()

        def git(*args, stdin=None):
            return subprocess.run(["git", "-C", str(submodule), *args], input=stdin,
                                  env=self.env, capture_output=True, check=True).stdout.strip()

        git("init", "--quiet")
        tracked = submodule / "tracked.txt"
        tracked.write_bytes(b"clean\n")
        git("add", "tracked.txt")
        tree = git("write-tree").decode()
        commit = git("commit-tree", tree, stdin=b"synthetic submodule baseline\n").decode()
        git("update-ref", "HEAD", commit)
        self.git("update-index", "--add", "--cacheinfo", "160000", commit, "submodule")
        parent = self.git("rev-parse", "HEAD").strip()
        tree = self.git("write-tree").strip()
        commit = self.git("commit-tree", tree, "-p", parent, stdin=b"synthetic gitlink baseline\n").strip()
        self.git("update-ref", "HEAD", commit)
        tracked.write_bytes(b"already dirty\n")
        status = git("status", "--porcelain=v1", "-z")
        before = load_crossfeed().snapshot(str(self.repo))
        result = self.run_job(["--write"], mode="dirty-submodule")
        self.assertEqual(result.returncode, 0, result.stderr)
        # Porcelain stays identical: its hash alone cannot detect this edit.
        self.assertEqual(git("status", "--porcelain=v1", "-z"), status)
        self.assertIn(b"workspace changes during the run: submodule", result.stdout)
        self.assertEqual(self.last_record()["observed"], ["submodule"])
        after = load_crossfeed().snapshot(str(self.repo))
        self.assertNotEqual(before["files"]["submodule"], after["files"]["submodule"])

    def test_directory_digest_distinguishes_repository_and_plain_directory(self):
        crossfeed = load_crossfeed()
        plain = self.repo / "plain"
        plain.mkdir()
        self.assertEqual(crossfeed._file_digest(plain), "dir")
        unborn = self.repo / "unborn"
        unborn.mkdir()
        subprocess.run(["git", "init", "--quiet", str(unborn)], env=self.env, check=True)
        self.assertEqual(crossfeed._file_digest(unborn), "submodule:unborn:" + hashlib.sha1(b"").hexdigest())
        clean_head = self.git("rev-parse", "HEAD").strip()
        status = self.git("status", "--porcelain=v1", "-z", "--untracked-files=all").encode()
        self.assertTrue(crossfeed._file_digest(self.repo).startswith(
            "submodule:{}:{}".format(clean_head, hashlib.sha1(status).hexdigest())))


class EditedPathsTests(CrossfeedCase):
    def test_codex_edit_paths_are_shown_relative_to_the_job_directory(self):
        crossfeed = load_crossfeed()
        root = self.root
        project = root / "项目"
        (project / "sub").mkdir(parents=True)
        link = root / "link"
        link.symlink_to(project, target_is_directory=True)
        outside = root / "outside.txt"
        edited = {str(project / "a.txt"), str(project / "sub" / "检查.txt"), str(outside), "relative.txt", str(link / "b.txt")}
        self.assertEqual(crossfeed._edited_paths(str(project), edited),
                         sorted(["a.txt", "b.txt", "relative.txt", str(outside), "sub/检查.txt"]))
        self.assertEqual(crossfeed._edited_paths(str(link), {str(project / "a.txt")}), ["a.txt"])
        self.assertEqual(crossfeed._edited_paths(str(project), set()), [])


    def test_codex_edit_paths_keep_the_last_symlink_component(self):
        project = self.root / "project"
        project.mkdir()
        alias = project / "alias"
        alias.symlink_to(self.root / "outside-target")
        outside = self.root / "outside-alias"
        outside.symlink_to(project / "inside-target")
        crossfeed = load_crossfeed()
        self.assertEqual(crossfeed._edited_paths(str(project), {str(alias), str(outside)}),
                         sorted(["alias", str(outside)]))


class LaunchAccountingTests(CrossfeedCase):
    def test_thread_id_is_read_back_from_the_event_log(self):
        crossfeed = load_crossfeed()
        log = self.root / "events.jsonl"
        self.assertIsNone(crossfeed._thread_from_events(log))
        for content, expected in ((b"", None),
                                  (b"not json\r\n{\"type\":\"turn.started\"}\r\n{\"type\":\"thread.started\",\"thread_id\":\"t-\xe6\xa3\x80\"}\r\n", "t-检"),
                                  (b"\xef\xbb\xbf{\"type\":\"thread.started\",\"thread_id\":\"bom\"}\n", "bom"),
                                  (b"{\"type\":\"thread.started\",\"thread_id\":7}\n{\"type\":\"thread.started\",\"thread_id\":\"second\"}\n", "second"),
                                  (b"[1]\n{\"type\":\"thread.started\",\"thread_id\":\"\"}\n", None)):
            with self.subTest(content=content):
                log.write_bytes(content)
                self.assertEqual(crossfeed._thread_from_events(log), expected)

    def test_end_row_reads_back_a_thread_id_the_follower_missed(self):
        # Stands for a signal that lands after thread.started was read and before it was
        # saved: neither the live follower nor the final parse supplies the id.
        crossfeed = load_crossfeed()
        original_follow, original_parse = crossfeed._follow_events, crossfeed.parse_events

        def follow_without_thread(events, edited, progress, record, final=False):
            original_follow(events, edited, progress, record, final)
            record["codex_thread"] = None

        def parse_without_thread(lines):
            return dict(original_parse(lines), thread=None)

        stdin = io.TextIOWrapper(io.BytesIO(b"Read the requested file."))
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin", stdin), \
                patch.object(crossfeed, "_follow_events", follow_without_thread), \
                patch.object(crossfeed, "parse_events", parse_without_thread), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = crossfeed.main(["run", "--json", "--dir", str(self.root)])
        self.assertEqual(code, 0)
        self.assertEqual(crossfeed.read_ledger()[-1]["codex_thread"], "fake-thread-1")

    def test_setup_failure_before_the_process_is_created_is_not_started(self):
        crossfeed = load_crossfeed()
        original = crossfeed._private_open

        def refuse_event_log(path, mode, **kwargs):
            if Path(path).name == "events.jsonl":
                raise PermissionError(13, "Permission denied", str(path))
            return original(path, mode, **kwargs)

        stdin = io.TextIOWrapper(io.BytesIO(b"Read the requested file."))
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin", stdin), \
                patch.object(crossfeed, "_private_open", refuse_event_log), \
                contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()):
            code = crossfeed.main(["run", "--json", "--dir", str(self.root)])
        data = json.loads(stdout.getvalue())
        self.assertEqual(data["status"], "not-started")
        self.assertIn("Permission denied", data["error"])
        self.assertNotEqual(code, 0)

    def test_state_write_failures_before_launch_and_at_the_end_are_not_started(self):
        crossfeed = load_crossfeed()

        def no_space(*args, **kwargs):
            raise OSError(28, "No space left on device")

        stdin = io.TextIOWrapper(io.BytesIO(b"Read the requested file."))
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin", stdin), \
                patch.object(crossfeed, "write_state", no_space), \
                patch.object(crossfeed, "_execute_job", side_effect=AssertionError("Codex must not start")), \
                contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()):
            code = crossfeed.main(["run", "--json", "--dir", str(self.root)])
        data = json.loads(stdout.getvalue())
        self.assertEqual(data["status"], "not-started")
        self.assertIn("No space left on device", data["error"])
        self.assertNotEqual(code, 0)
