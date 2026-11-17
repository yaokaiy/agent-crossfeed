import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
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
        self.assertIn("[crossfeed] changed 2 file(s): new file ü.txt, tracked.txt".encode(), result.stdout)
        self.assertNotIn(b"dirty.txt", result.stdout)
        self.assertEqual(self.last_record()["changed"], 2)
        self.assertFalse(self.last_record()["head_moved"])
        lines = result.stdout.decode().splitlines()
        index = next(index for index, line in enumerate(lines) if line.startswith("[crossfeed] job "))
        self.assertTrue(lines[index + 1].startswith("[crossfeed] changed "))

    def test_already_dirty_file_changed_again_is_listed(self):
        result = self.run_job(["--write"], mode="dirty")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"dirty.txt", result.stdout)
        self.assertEqual(self.last_record()["changed"], 3)

    def test_no_change_is_flagged(self):
        result = self.run_job(["--write"], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"[crossfeed] no files changed", result.stdout)
        self.assertEqual(self.last_record()["changed"], 0)

    def test_snapshot_error_finalizes_failed_job(self):
        crossfeed = load_crossfeed()
        stdout, stderr = io.StringIO(), io.StringIO()
        before = {"head": "initial", "files": {}}
        stdin = io.TextIOWrapper(io.BytesIO(b"Make the requested change."))
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin", stdin), \
                patch.object(crossfeed, "snapshot", side_effect=[before, OSError("cannot read changed file")]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = crossfeed.main(["run", "--write", "--dir", str(self.repo)])
        self.assertEqual(code, 1)
        self.assertIn("cannot read changed file", stdout.getvalue())
        record, = crossfeed.read_ledger()
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["exit"], 1)
        self.assertEqual(record["tokens"]["input"], 12000)
        state = json.loads((self.home / "jobs" / record["id"] / "state.json").read_text())
        self.assertEqual(state["status"], "failed")

    def test_head_moved_is_flagged(self):
        result = self.run_job(["--write"], mode="commit")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertIn(b"[crossfeed] WARNING: HEAD moved during the job, so a commit was made", result.stdout)
        self.assertTrue(self.last_record()["head_moved"])

    def test_non_git_directory(self):
        result = self.run_job(["--write", "--dir", str(self.root)], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"[crossfeed] not a git repository: no change list", result.stdout)
        self.assertIsNone(self.last_record()["changed"])

    def test_unborn_branch(self):
        unborn = self.root / "unborn"
        unborn.mkdir()
        subprocess.run(["git", "init", "--quiet", str(unborn)], env=self.env, check=True)
        result = self.run_job(["--write", "--dir", str(unborn)])
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertEqual(self.last_record()["changed"], 2)
        self.assertFalse(self.last_record()["head_moved"])
        self.assertIsNone(load_crossfeed().snapshot(str(unborn))["head"])

    def test_resume_uses_thread_and_dir(self):
        result = self.run_job(["--write"], mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.last_record()
        argv_file = self.root / "resume-argv.json"
        cwd_file = self.root / "resume-cwd.txt"
        # The saved directory and sandbox win over a conflicting caller directory.
        result = self.run_job(["--resume", first["id"], "--dir", str(self.root), "--effort", "xhigh"],
                              mode="write", FAKE_CODEX_ARGV=str(argv_file), FAKE_CODEX_CWD=str(cwd_file))
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        argv = json.loads(argv_file.read_text())
        self.assertEqual(argv[1:4], ["exec", "resume", first["codex_thread"]])
        self.assertEqual(argv[4:10], ["--skip-git-repo-check", "--json", "-c",
                                     'sandbox_mode="workspace-write"', "-c", 'model_reasoning_effort="xhigh"'])
        self.assertNotIn("-s", argv)
        self.assertNotIn("-C", argv)
        self.assertNotIn("--worktree", argv)
        self.assertEqual(cwd_file.read_text(), str(self.repo.resolve()))
        record = self.last_record()
        self.assertEqual(record["resume_of"], first["id"])
        self.assertEqual(record["dir"], first["dir"])
        self.assertEqual(record["sandbox"], "workspace-write")
        self.assertEqual(record["changed"], 2)
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

    def test_resume_cannot_upgrade_read_only_sandbox(self):
        result = self.run_job(mode="ok")
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.last_record()
        argv_file = self.root / "resume.json"
        result = self.run_job(["--resume", first["id"], "--write"], mode="ok", FAKE_CODEX_ARGV=str(argv_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('sandbox_mode="read-only"', json.loads(argv_file.read_text()))
        self.assertEqual(self.last_record()["sandbox"], "read-only")
        self.assertIsNone(self.last_record()["changed"])

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

    def test_change_output_caps_paths_at_ten(self):
        result = self.run_job(["--write"], mode="many-files")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last_record()["changed"], 12)
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
        self.assertIn(b"changed 3 file(s): outside-link, pipe, zero-link", result.stdout)
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
                self.assertIsNone(self.last_record()["changed"])

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
        self.assertIn(b"changed 1 file(s): submodule", result.stdout)
        self.assertEqual(self.last_record()["changed"], 1)
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
