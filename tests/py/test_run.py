import datetime
import contextlib
from concurrent.futures import ThreadPoolExecutor
import fcntl
import io
import json
import os
from pathlib import Path
from select import select
import shlex
import signal
import stat
import subprocess
import sys
import time
from unittest.mock import patch

from helpers import CROSSFEED, CrossfeedCase, load_crossfeed, run_crossfeed


class JobDirectoryTests(CrossfeedCase):
    def test_collision_allocates_another_directory(self):
        crossfeed = load_crossfeed()
        existing = self.home / "jobs" / "20261117-010203-aaaa"
        existing.mkdir(parents=True)
        marker = existing / "brief.md"
        marker.write_bytes(b"original job")
        with patch.object(crossfeed, "new_job_id", side_effect=[existing.name, "20261117-010203-bbbb"]):
            directory = crossfeed._create_job_dir(datetime.datetime(2026, 11, 17, 1, 2, 3))
        self.assertEqual(directory.name, "20261117-010203-bbbb")
        self.assertTrue(directory.is_dir())
        self.assertEqual(marker.read_bytes(), b"original job")

    def test_allocation_stops_after_five_collisions(self):
        crossfeed = load_crossfeed()
        existing = self.home / "jobs" / "20261117-010203-aaaa"
        existing.mkdir(parents=True)
        with patch.object(crossfeed, "new_job_id", return_value=existing.name) as ids:
            with self.assertRaises(FileExistsError):
                crossfeed._create_job_dir(datetime.datetime(2026, 11, 17, 1, 2, 3))
        self.assertEqual(ids.call_count, 5)
        self.assertEqual(list(existing.iterdir()), [])


class RunTests(CrossfeedCase):
    def test_run_records_cause(self):
        for args, cause in ((["--cause", "limit"], "limit"), ([], None),
                            (["--cause", "account-week"], "account-week"),
                            (["--cause", "codex-surplus"], "codex-surplus"),
                            (["--cause", "Ab9-" * 8], "Ab9-" * 8)):
            with self.subTest(cause=cause):
                result = self.run_job(args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.records()[-1]["cause"], cause)
                self.assertEqual(json.loads((self.job_dir() / "state.json").read_text())["cause"], cause)
        records = self.records()
        argv = self.root / "must-not-start.json"
        for cause in ("a b", "", "a" * 33, "a_b", "é", "limit\n"):
            with self.subTest(cause=cause):
                result = self.run_job(["--cause", cause], FAKE_CODEX_ARGV=str(argv))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.records(), records)
                self.assertFalse(argv.exists())

    def test_resume_preserves_cause_and_rejects_override(self):
        self.assertEqual(self.run_job(["--cause", "limit"]).returncode, 0)
        first = self.records()[-1]
        result = self.run_job(["--resume", first["id"]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]["cause"], "limit")
        for cause in ("limit", "other"):
            result = self.run_job(["--resume", first["id"], "--cause", cause])
            self.assertEqual(result.returncode, 2)
            self.assertIn(b"--cause", result.stderr)
        self.assertEqual(len(self.records()), 2)

    def test_run_session_flag_and_environment(self):
        for args, environment, session in (
            ([], "environment-session", "environment-session"),
            (["--session", "flag-session"], "environment-session", "flag-session"),
            (["--session", ""], "environment-session", None),
            ([], "", None),
        ):
            with self.subTest(args=args, environment=environment):
                result = self.run_job(args, CLAUDE_CODE_SESSION_ID=environment)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.records()[-1]["session"], session)

    def test_run_preserves_brief_file_argument(self):
        (self.root / "brief ü.md").write_bytes(b"File brief\n")
        path = "./brief ü.md"
        result = self.run_job(["--brief-file", path])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]["brief_file"], path)

    def test_artifact_round_counts_only_done_jobs_of_the_same_kind(self):
        crossfeed = load_crossfeed()
        for status, kind, artifact in (
            ("done", "review", "draft.v1_2-3"), ("failed", "review", "draft.v1_2-3"),
            ("timeout", "review", "draft.v1_2-3"), ("interrupted", "review", "draft.v1_2-3"),
            ("done", "research", "draft.v1_2-3"), ("done", "review", "another-draft"),
        ):
            crossfeed.append_ledger({"type": "job", "id": "prior-{}-{}-{}".format(status, kind, artifact),
                                     "status": status, "kind": kind, "artifact": artifact})
        args = ["--kind", "review", "--artifact", "draft.v1_2-3"]
        failed = self.run_job(args, mode="fail")
        self.assertEqual(failed.returncode, 1, failed.stderr)
        self.assertEqual(self.records()[-1]["round"], 2)
        done = self.run_job(args)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(b"[crossfeed] artifact draft.v1_2-3 round 2\n", done.stdout)
        record = self.records()[-1]
        self.assertEqual((record["artifact"], record["round"]), ("draft.v1_2-3", 2))
        state = json.loads((self.job_dir() / "state.json").read_text())
        self.assertEqual((state["artifact"], state["round"]), ("draft.v1_2-3", 2))

    def test_concurrent_artifact_rounds_follow_ledger_order(self):
        args = ["--kind", "review", "--artifact", "draft"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.run_job, [args, args]))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([record["round"] for record in self.records()], [1, 2])

    def test_resume_inherits_artifact_and_rejects_conflict(self):
        self.assertEqual(self.run_job(["--kind", "review", "--artifact", "draft"]).returncode, 0)
        first = self.records()[-1]
        resume = ["--kind", "review", "--resume", first["id"]]
        for number, flags in enumerate(([], ["--artifact", "draft"]), start=2):
            result = self.run_job(resume + flags)
            self.assertEqual(result.returncode, 0, result.stderr)
            record = self.records()[-1]
            self.assertEqual((record["artifact"], record["round"]), ("draft", number))
        result = self.run_job(resume + ["--artifact", "other"])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"crossfeed: --artifact cannot be overridden with --resume\n")
        self.assertEqual(len(self.records()), 3)

    def test_resume_can_label_an_unlabelled_job(self):
        self.assertEqual(self.run_job().returncode, 0)
        first = self.records()[-1]
        result = self.run_job(["--resume", first["id"], "--artifact", "draft"])
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.records()[-1]
        self.assertEqual((record["artifact"], record["round"]), ("draft", 1))

    def test_run_rejects_invalid_artifact_ids(self):
        for artifact in ("", "a" * 65, "a/b", "two words", "café", "draft\n"):
            with self.subTest(artifact=artifact):
                result = self.run_job(["--artifact", artifact])
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"crossfeed: artifact ID", result.stderr)
        self.assertEqual(self.records(), [])
        self.assertFalse((self.home / "jobs").exists())

    def test_role_file_sends_exact_prompt_bytes_and_saves_only_brief(self):
        preamble = load_crossfeed().PREAMBLE_READ.encode("utf-8")
        role_file = self.root / "role.md"
        brief = b"Retain brief whitespace \r\n\r\n"
        body = "\nReview café. \n".encode("utf-8")
        crlf_body = body.replace(b"\n", b"\r\n")
        for content, expected in (
            (b"---\nname: reviewer\n---\n" + body, body),
            (b"---\r\nname: reviewer\r\n---\r\n" + crlf_body, crlf_body),
            (b"\xef\xbb\xbf---\nname: reviewer\n---\n" + body, body),
            (b"  ---\n" + body, b"  ---\n" + body),
            (b"x" * 65536, b"x" * 65536),
        ):
            with self.subTest(prefix=content[:40]):
                role_file.write_bytes(content)
                result = self.run_job(["--role-file", "role.md"], brief=brief, mode="echo")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.job_dir() / "brief.md").read_bytes(), brief)
                self.assertEqual((self.job_dir() / "result.md").read_bytes(),
                                 b"\n\n".join((preamble, expected, brief)))
                self.assertEqual(self.records()[-1]["role_file"], str(role_file.resolve()))

    def test_invalid_role_files_are_usage_errors(self):
        role = self.root / "role.md"
        for content, error in (
            (None, b"requires an existing file"),
            (b"", b"must contain a role"),
            (b"---\nname: reviewer\n---\n  \r\n", b"must contain a role"),
            (b"---\nname: reviewer\n--- \n", b"unterminated frontmatter"),
            (b"x" * 65537, b"exceeds 64 KiB"),
            (b"\xff", b"must be UTF-8"),
        ):
            with self.subTest(content=content and content[:40]):
                if content is not None:
                    role.write_bytes(content)
                result = self.run_job(["--role-file", str(role)])
                self.assertEqual(result.returncode, 2)
                self.assertIn(error, result.stderr)
        self.assertEqual(self.records(), [])

    def test_resume_rejects_role_file(self):
        role = self.root / "role.md"
        role.write_text("Review the draft.", encoding="utf-8")
        self.assertEqual(self.run_job(["--role-file", str(role)]).returncode, 0)
        first = self.records()[-1]
        resume = ["--resume", first["id"]]
        result = self.run_job(resume + ["--role-file", str(role)])
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"--role-file cannot be combined with --resume", result.stderr)
        self.assertEqual(self.run_job(resume).returncode, 0)
        self.assertIsNone(self.records()[-1]["role_file"])

    def test_invalid_output_schemas_are_usage_errors(self):
        schema = self.root / "schema.json"
        for content in (None, b"", b"\xef\xbb\xbf{}", b"{invalid}", b"[]", b'{"value": NaN}'):
            with self.subTest(content=content):
                if content is not None:
                    schema.write_bytes(content)
                result = self.run_job(["--output-schema", str(schema)])
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"crossfeed: --output-schema", result.stderr)
        self.assertEqual(self.records(), [])
        self.assertFalse((self.home / "jobs").exists())

    def test_output_schema_reaches_fresh_and_resume_commands_when_supplied(self):
        schema = self.root / "schema opts.json"
        schema.write_text('{"type": "object"}', encoding="utf-8")
        work = self.root / "work"
        work.mkdir()
        argv_file = self.root / "schema-argv.json"
        env = {"FAKE_CODEX_ARGV": str(argv_file)}
        flags = ["--output-schema", schema.name]
        result = self.run_job(["--dir", str(work)] + flags, **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.records()[-1]
        for resume in (False, True):
            with self.subTest(resume=resume):
                if resume:
                    result = self.run_job(["--resume", first["id"]] + flags, **env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                argv = json.loads(argv_file.read_text())
                self.assertEqual(argv[1:3], ["exec", "resume" if resume else "--skip-git-repo-check"])
                self.assertEqual(argv[argv.index("--output-schema") + 1], str(schema.resolve()))
                self.assertEqual(self.records()[-1]["output_schema"], str(schema.resolve()))
        result = self.run_job(["--resume", first["id"]], **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("--output-schema", json.loads(argv_file.read_text()))
        self.assertIsNone(self.records()[-1]["output_schema"])

    def test_write_job_footer(self):
        result = self.run_job(["--write"])
        self.assertEqual(result.returncode, 0, result.stderr)
        record, = self.records()
        self.assertEqual(result.stdout.decode().splitlines()[-1],
                         "[crossfeed] record the outcome: python3 -I {} check {} -- <your check command>"
                         .format(shlex.quote(str(CROSSFEED)), record["id"]))

    def run_job(self, args=(), brief=b"Implement the parser. Check: python3 -m unittest\n", mode="ok", **env):
        return run_crossfeed(["run", "--dir", str(self.root), *args], stdin=brief,
                         env=dict(self.env, FAKE_CODEX=mode, **env), cwd=self.root)

    def records(self):
        return load_crossfeed().read_ledger()

    def job_dir(self):
        return self.home / "jobs" / self.records()[-1]["id"]

    def test_ok_job(self):
        result = self.run_job(["--tier", "A", "--kind", "subagent", "--session", "session-1"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"ok:", result.stdout)
        record, = self.records()
        self.assertEqual(set(record), {
            "v", "type", "ts", "id", "session", "kind", "tier", "dir", "write", "sandbox", "worktree",
            "effort", "model", "model_source", "cause", "started", "wall_s", "status", "exit", "tokens", "codex_thread",
            "codex_edited", "resume_of", "brief_file", "artifact", "round", "role_file", "output_schema",
        })
        self.assertEqual(record["type"], "job")
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["exit"], 0)
        self.assertEqual(record["tier"], "A")
        self.assertEqual(record["kind"], "subagent")
        self.assertEqual(record["session"], "session-1")
        self.assertRegex(record["started"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\Z")
        self.assertIsNone(record["brief_file"])
        for field in ("artifact", "round", "role_file", "output_schema"):
            self.assertIsNone(record[field])
        self.assertEqual(record["tokens"], {"input": 12000, "cached": 500, "output": 321, "reasoning": 21})
        self.assertTrue(record["codex_thread"])
        self.assertEqual(record["effort"], "high")
        self.assertIs(record["write"], False)
        self.assertEqual(record["dir"], str(self.root.resolve()))
        self.assertIsNone(record["resume_of"])
        state = json.loads((self.job_dir() / "state.json").read_text())
        self.assertEqual(state["status"], "done")
        self.assertEqual({path.name for path in self.job_dir().iterdir()},
                         {"brief.md", "events.jsonl", "stderr.log", "result.md", "state.json"})
        lines = result.stdout.decode().splitlines()
        self.assertTrue(any("codex tokens 12321" in line for line in lines))
        self.assertTrue(lines[-2].startswith("[crossfeed] full result: "))
        self.assertEqual(lines[-1],
                         "[crossfeed] once you have checked its claims, record whether you used this result: "
                         "python3 -I {} used {} <yes|partly|no>".format(shlex.quote(str(CROSSFEED)), record["id"]))

    def test_argv_passed_to_codex(self):
        argv_file = self.root / "argv.json"
        for args in ([], ["--write", "--effort", "xhigh", "--model", "m", "--worktree"]):
            with self.subTest(args=args):
                result = self.run_job(args, FAKE_CODEX_ARGV=str(argv_file))
                self.assertEqual(result.returncode, 0, result.stderr)
                argv = json.loads(argv_file.read_text())
                self.assertEqual(argv[1:4], ["exec", "--skip-git-repo-check", "--json"])
                self.assertNotIn("-s", argv)
                self.assertEqual(argv[argv.index("-C") + 1], str(self.root.resolve()))
                self.assertEqual(argv[-1], "-")
                self.assertIn('project_doc_fallback_filenames=["CLAUDE.md"]', argv)
                if args:
                    self.assertIn('model_reasoning_effort="xhigh"', argv)
                    self.assertEqual(argv[argv.index("-m") + 1], "m")
                    self.assertIn("--worktree", argv)
                else:
                    self.assertIn('model_reasoning_effort="high"', argv)
                    self.assertNotIn("-m", argv)

    def test_fresh_and_resumed_jobs_use_user_permissions_for_both_roles(self):
        argv_file = self.root / "argv.json"
        for write in (False, True):
            with self.subTest(write=write):
                flags = ["--write"] if write else []
                fresh = self.run_job(flags, FAKE_CODEX_ARGV=str(argv_file))
                self.assertEqual(fresh.returncode, 0, fresh.stderr)
                job = self.records()[-1]
                outputs = [(fresh, json.loads(argv_file.read_text()), job)]
                resumed = self.run_job(["--resume", job["id"]], FAKE_CODEX_ARGV=str(argv_file))
                self.assertEqual(resumed.returncode, 0, resumed.stderr)
                outputs.append((resumed, json.loads(argv_file.read_text()), self.records()[-1]))
                for result, argv, record in outputs:
                    for flag in ("-s", "--sandbox", "-a", "--ask-for-approval"):
                        self.assertNotIn(flag, argv)
                    overrides = [argv[index + 1] for index, arg in enumerate(argv) if arg == "-c"]
                    self.assertEqual(overrides, ['model_reasoning_effort="high"', 'project_doc_fallback_filenames=["CLAUDE.md"]'])
                    self.assertIs(record["write"], write)
                    self.assertEqual(record["sandbox"], "workspace-write" if write else "read-only")
                    self.assertNotIn("profile", record)
                    self.assertIn(b"; write; codex tokens " if write else b"; read; codex tokens ", result.stdout)

    def assert_run_model(self, args, model, source, **env):
        argv_file = self.root / "model-argv.json"
        result = self.run_job(args, FAKE_CODEX_ARGV=str(argv_file), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = json.loads(argv_file.read_text())
        if model is None or source == "resume":
            self.assertNotIn("-m", argv)
        else:
            self.assertEqual(argv[argv.index("-m") + 1], model)
        record = self.records()[-1]
        self.assertEqual((record["model"], record["model_source"]), (model, source))
        return record

    def test_model_precedence_by_kind_and_tier(self):
        astra = "gpt-6.2-astra"
        cache = Path(self.env["CODEX_HOME"]) / "models_cache.json"
        cache.parent.mkdir()
        cache.write_text(json.dumps({"models": [{"slug": astra}]}), encoding="utf-8-sig")
        for kind, tier, model, source in (
            ("task", "B", None, "codex-default"), ("custom", "B", None, "codex-default"),
            ("review", "A", astra, "judgment"), ("research", "A", astra, "judgment"),
            ("subagent", "B", astra, "judgment"), ("subagent", "A", None, "codex-default"),
        ):
            with self.subTest(kind=kind, tier=tier):
                self.assert_run_model(["--kind", kind, "--tier", tier, "--model", ""], model, source)
        self.assert_run_model(["--kind", "review", "--model", "unlisted"], "unlisted", "flag")

    def test_judgment_model_requires_a_readable_cache_and_listed_slug(self):
        cache = Path(self.env["CODEX_HOME"]) / "models_cache.json"
        cache.parent.mkdir()
        for content in (None, b"", b"{", b"\xff", b"[]", b"{}", b'{"models":[]}',
                        b'{"models":{"slug":"gpt-6.2-astra"}}',
                        b'{"models":["gpt-6.2-astra",{},{"slug":"other"}]}'):
            with self.subTest(content=content):
                if content is not None:
                    cache.write_bytes(content)
                self.assert_run_model(["--kind", "review"], None, "codex-default")
        cache.unlink()
        cache.mkdir()  # An unreadable cache even when tests run as root.
        self.assert_run_model(["--kind", "research"], None, "codex-default")

    def test_judgment_model_override_disable_and_resume(self):
        cache = self.root / ".codex" / "models_cache.json"
        cache.parent.mkdir()
        cache.write_text('{"models":[{"slug":"override"},{"slug":"gpt-6.2-astra"}]}')
        env = {"CODEX_HOME": "", "HOME": str(self.root)}
        args = ["--kind", "review"]
        first = self.assert_run_model(args, "override", "judgment", CROSSFEED_JUDGMENT_MODEL="override", **env)
        self.assert_run_model(args, None, "codex-default", CROSSFEED_JUDGMENT_MODEL="", **env)
        self.assert_run_model(args, None, "codex-default", CROSSFEED_JUDGMENT_MODEL="missing", **env)
        cache.unlink()
        self.assert_run_model(["--resume", first["id"]], "override", "resume", **env)

    def test_empty_brief_is_usage_error(self):
        for brief in (b"", b"  \r\n"):
            with self.subTest(brief=brief):
                result = self.run_job(brief=brief)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"brief", result.stderr.lower())
                self.assertEqual(self.records(), [])
                self.assertFalse((self.home / "jobs").exists())

    def test_brief_reaches_codex_unchanged(self):
        brief = "$(touch pwned)\r\n`touch pwned`\r\nCROSSFEED_BRIEF_EOF\r\n检查 naïve\r\n".encode()
        for args, preamble in (([], "PREAMBLE_READ"), (["--write"], "PREAMBLE_WRITE")):
            with self.subTest(args=args):
                result = self.run_job(args, brief=brief, mode="echo")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.job_dir() / "brief.md").read_bytes(), brief)
                self.assertEqual((self.job_dir() / "result.md").read_bytes(),
                                 getattr(load_crossfeed(), preamble).encode() + b"\n\n" + brief)
                self.assertFalse((self.root / "pwned").exists())

    def test_failure_has_log_lines(self):
        result = self.run_job(mode="fail")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"[crossfeed] last log lines:", result.stdout)
        self.assertIn(b"boom", result.stdout)
        self.assertNotIn(b"ok:", result.stdout)
        self.assertEqual(self.records()[-1]["status"], "failed")

    def test_logged_out_has_clear_failure(self):
        result = self.run_job(mode="logged-out")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"Not logged in", result.stdout)
        self.assertIn(b"[crossfeed] last log lines:", result.stdout)

    def test_limit_exit_75(self):
        result = self.run_job(mode="limit")
        self.assertEqual(result.returncode, 75)
        self.assertIn(b"Do not retry on Codex; do this work on Claude.", result.stdout)
        self.assertEqual(self.records()[-1]["status"], "limit")

    def test_recoverable_error_events_keep_success_and_print_notice(self):
        for args in ([], ["--write"]):
            with self.subTest(args=args):
                result = self.run_job(args, mode="recoverable")
                self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
                self.assertEqual(self.records()[-1]["status"], "done")
                self.assertIn(b"ok:", result.stdout)
                lines = result.stdout.decode().splitlines()
                job_line = next(index for index, line in enumerate(lines) if line.startswith("[crossfeed] job "))
                notice = "[crossfeed] codex reported 2 recoverable error event(s); see {}".format(
                    self.job_dir() / "events.jsonl")
                self.assertEqual(lines[job_line + 1], notice)
                self.assertEqual(lines.count(notice), 1)

    def test_recoverable_error_without_result_still_fails(self):
        result = self.run_job(mode="recoverable-noresult")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.records()[-1]["status"], "failed")
        self.assertIn(b"[crossfeed] Codex exited 0 without a result.", result.stdout)
        self.assertNotIn(b"recoverable error event(s)", result.stdout)

    def test_usage_limit_requires_nonzero_exit(self):
        result = self.run_job(mode="recovered-limit")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertEqual(self.records()[-1]["status"], "done")
        self.assertIn(b"1 recoverable error event(s)", result.stdout)
        result = self.run_job(mode="limit-with-result")
        self.assertEqual(result.returncode, 75)
        self.assertEqual(self.records()[-1]["status"], "limit")
        self.assertNotIn(b"ok:", result.stdout)
        self.assertNotIn(b"recoverable error event(s)", result.stdout)

    def test_timeout_kills_process_group(self):
        pidfile = self.root / "child.pid"
        start = time.monotonic()
        try:
            result = self.run_job(["--timeout", "0.05"], mode="hang", FAKE_CODEX_PIDFILE=str(pidfile))
            self.assertEqual(result.returncode, 124, (result.stdout, result.stderr))
            self.assertLess(time.monotonic() - start, 15)
            self.assertIn(b"stopped after 0.05 minutes.", result.stdout)
            self.assertEqual(self.records()[-1]["status"], "timeout")
            self.assertTrue(pidfile.exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pidfile.read_text()), 0)
        finally:
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_dispatcher_signals_stop_the_entire_group_and_record_interrupted(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum):
                pidfile = self.root / (str(signum) + ".pid")
                observed = self.root / (str(signum) + ".jsonl")
                output_args = ["--json"] if signum == signal.SIGTERM else []
                dispatcher = subprocess.Popen(
                    [sys.executable, "-I", str(CROSSFEED), "run", "--dir", str(self.root), *output_args],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=dict(self.env, FAKE_CODEX="hang", FAKE_CODEX_PIDFILE=str(pidfile),
                             FAKE_CODEX_INTERRUPT_LEDGER=str(observed)))
                group = None
                try:
                    dispatcher.stdin.write(b"Hang until interrupted.\n")
                    dispatcher.stdin.close()
                    dispatcher.stdin = None
                    deadline = time.monotonic() + 20
                    while not pidfile.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(pidfile.exists(), "fake Codex never started")
                    descendant = int(pidfile.read_text())
                    group = os.getpgid(descendant)
                    dispatcher.send_signal(signum)
                    stdout, stderr = dispatcher.communicate(timeout=30)
                    self.assertEqual(dispatcher.returncode, 130, (stdout, stderr))
                    if output_args:
                        self.assertEqual(stderr, b"")
                    else:
                        self.assertIn(b"[crossfeed] job ", stdout)
                        self.assertIn(b"[crossfeed] interrupted; Codex was stopped.\n", stdout)
                    self.assertNotIn(b"Traceback", stderr)
                    record = self.records()[-1]
                    self.assertEqual((record["status"], record["exit"]), ("interrupted", 130))
                    at_signal = [json.loads(line) for line in observed.read_text().splitlines()]
                    if output_args:
                        self.assertEqual(at_signal[-1], record)
                        self.assertEqual(record["codex_thread"], "fake-thread-1")
                        self.assertIn(record["sandbox"], ("read-only", "workspace-write"))
                    else:
                        self.assertNotIn(record["id"], [row["id"] for row in at_signal])
                    self.assertEqual(sum(row["id"] == record["id"] for row in self.records()), 1)
                    if output_args:
                        self.assertEqual(json.loads(stdout), {
                            "id": record["id"], "status": "interrupted", "exit": 130,
                            "result_path": str(self.job_dir() / "result.md"), "result": "", "codex_edited": [],
                        })
                    state = json.loads((self.job_dir() / "state.json").read_text())
                    self.assertEqual((state["status"], state["exit"]), ("interrupted", 130))
                    if signum == signal.SIGTERM:
                        argv = self.root / "resumed-argv"
                        resumed = self.run_job(["--resume", record["id"]], FAKE_CODEX_ARGV=str(argv))
                        self.assertEqual(resumed.returncode, 0, resumed.stderr)
                        self.assertEqual(json.loads(argv.read_text())[1:4], ["exec", "resume", "fake-thread-1"])
                    with self.assertRaises(ProcessLookupError):
                        os.kill(descendant, 0)
                    with self.assertRaises(ProcessLookupError):
                        os.killpg(group, 0)
                finally:
                    if group is not None:
                        try:
                            os.killpg(group, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    if dispatcher.poll() is None:
                        dispatcher.kill()
                    dispatcher.communicate()

    def test_slots_wait_before_quota_and_release_on_exit_or_sigkill(self):
        brief = self.root / "brief.md"
        brief.write_text("Review this.\n")
        command = [sys.executable, "-I", str(CROSSFEED), "run", "--json", "--slots", "1",
                   "--dir", str(self.root), "--brief-file", str(brief)]
        for killed in (False, True):
            with self.subTest(killed=killed), contextlib.ExitStack() as processes:
                release, ready, probe = (self.root / "{}-{}".format(killed, name)
                                         for name in ("release", "ready", "quota-pid"))
                jobs = self.home / "jobs"
                before = set(jobs.glob("*/result.md"))
                holder = processes.enter_context(subprocess.Popen(
                    command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=dict(self.env, FAKE_CODEX="hold", FAKE_CODEX_RELEASE=str(release), FAKE_CODEX_READY=str(ready))))
                waiter = None
                held_result = None
                try:
                    deadline = time.monotonic() + 8
                    while not ready.exists() and holder.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(ready.exists(), "first dispatcher never started Codex")
                    held_result, = set(jobs.glob("*/result.md")) - before
                    slots = self.home / "slots"
                    self.assertEqual(stat.S_IMODE(slots.stat().st_mode), 0o700)
                    self.assertEqual(stat.S_IMODE((slots / "slot-1").stat().st_mode), 0o600)
                    waiter = processes.enter_context(subprocess.Popen(
                        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        env=dict(self.env, FAKE_CODEX_APPSERVER_PIDFILE=str(probe))))
                    with self.assertRaises(subprocess.TimeoutExpired):
                        waiter.wait(timeout=0.4)
                    self.assertFalse(probe.exists(), "waiter checked quota before taking a slot")
                    if killed:
                        holder.kill()
                    else:
                        release.touch()
                    out, err = holder.communicate(timeout=8)
                    self.assertEqual(holder.returncode, -signal.SIGKILL if killed else 0, (out, err))
                    out, err = waiter.communicate(timeout=8)
                    self.assertEqual(waiter.returncode, 0, (out, err))
                    self.assertEqual(json.loads(out)["status"], "done")
                    self.assertTrue(probe.exists())
                finally:
                    release.touch()
                    if killed and held_result is not None:
                        deadline = time.monotonic() + 2
                        while held_result.stat().st_size == 0 and time.monotonic() < deadline:
                            time.sleep(0.01)
                    for process in (holder, waiter):
                        if process is not None and process.poll() is None:
                            process.kill()

    def test_slots_requires_a_positive_integer(self):
        for value in ("0", "-1", "1.5"):
            with self.subTest(value=value):
                result = self.run_job(["--slots", value])
                self.assertEqual(result.returncode, 2, (result.stdout, result.stderr))
                self.assertIn(b"--slots", result.stderr)
        self.assertFalse((self.home / "slots").exists())
        self.assertEqual(self.records(), [])

    def test_json_preamble_follows_the_briefs_format(self):
        brief = "格式\r\nReturn one JSON object.\n".encode()
        preamble = ("The given directory is your workspace: make any changes only inside it. You may read "
                    "the files and directories the brief names, wherever they are. Never push, commit or post "
                    "to any service. Print no secrets. Answer in the form the brief asks for.").encode()
        for args in ([], ["--write"]):
            with self.subTest(args=args):
                result = self.run_job(["--json", *args], brief=brief, mode="echo")
                self.assertEqual(result.returncode, 0, result.stderr)
                role = (b" Change files only inside that directory and run the check the brief states." if args
                        else b" Do not change any project file. You may write temporary files.")
                self.assertEqual((self.job_dir() / "result.md").read_bytes(), preamble + role + b"\n\n" + brief)

    def test_progress_reports_completed_items_only_with_heartbeat(self):
        prefix = "crossfeed: progress "
        expected = ["ran printf ok pwd (exit 3)", "searched 查找 example", "changed a.txt, 检查.txt",
                    "called local.lookup", "searched " + "界" * 191]
        for flags in ([], ["--heartbeat", "1"]):
            with self.subTest(flags=flags):
                result = self.run_job(["--json", *flags], mode="progress")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertEqual(json.loads(result.stdout)["status"], "done")
                self.assertEqual([line.removeprefix(prefix) for line in result.stderr.decode().splitlines()
                                  if line.startswith(prefix)], expected if flags else [])

    def test_json_answer_cannot_impersonate_progress(self):
        answer = b"crossfeed: progress changed example.py\n"
        result = self.run_job(["--json", "--heartbeat", "1"], brief=answer, mode="echo")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(answer.decode(), json.loads(result.stdout)["result"])
        self.assertNotIn(b"crossfeed: progress", result.stderr)
        self.assertTrue(all(line == b"crossfeed: heartbeat" for line in result.stderr.splitlines()))

    def test_json_failed_file_change_is_not_reported_as_an_edit(self):
        result = self.run_job(["--json", "--heartbeat", "1"], mode="failed-patch")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["codex_edited"], [])
        self.assertEqual(self.records()[-1]["codex_edited"], [])
        self.assertNotIn(b"never-created", result.stderr)

    def test_heartbeat_keeps_slow_json_stdout_to_one_object(self):
        for flags in ([], ["--heartbeat", "1"]):
            with self.subTest(flags=flags):
                result = self.run_job(["--json", *flags], mode="slow")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertEqual(json.loads(result.stdout)["status"], "done")
                self.assertEqual(b"crossfeed: heartbeat" in result.stderr.splitlines(), bool(flags))

    def test_heartbeat_continues_while_waiting_for_slot(self):
        brief, probe = self.root / "brief.md", self.root / "quota-pid"
        brief.write_text("Review this.\n")
        slots = self.home / "slots"
        slots.mkdir(mode=0o700)
        with (slots / "slot-1").open("ab") as slot:
            fcntl.flock(slot, fcntl.LOCK_EX)
            with subprocess.Popen(
                [sys.executable, "-I", str(CROSSFEED), "run", "--json", "--slots", "1", "--heartbeat", "1",
                 "--dir", str(self.root), "--brief-file", str(brief)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=dict(self.env, FAKE_CODEX_APPSERVER_PIDFILE=str(probe)),
            ) as dispatcher:
                try:
                    self.assertTrue(select([dispatcher.stderr], [], [], 6)[0], "no heartbeat while the slot was held")
                    self.assertEqual(dispatcher.stderr.readline(), b"crossfeed: heartbeat\n")
                    self.assertFalse(probe.exists(), "dispatcher checked quota while the slot was held")
                    fcntl.flock(slot, fcntl.LOCK_UN)
                    stdout, stderr = dispatcher.communicate(timeout=8)
                    self.assertEqual(dispatcher.returncode, 0, (stdout, stderr))
                    self.assertEqual(json.loads(stdout)["status"], "done")
                finally:
                    if dispatcher.poll() is None:
                        dispatcher.kill()

    def test_heartbeat_requires_json_and_a_positive_integer(self):
        for flags, reason in ((["--heartbeat", "1"], b"requires --json"),
                              (["--json", "--heartbeat", "0"], b"must be at least 1"),
                              (["--json", "--heartbeat", "1.5"], b"invalid int value")):
            with self.subTest(flags=flags):
                result = self.run_job(flags)
                self.assertEqual(result.returncode, 2, (result.stdout, result.stderr))
                if flags == ["--json", "--heartbeat", "0"]:
                    self.assertIn(reason.decode(), json.loads(result.stdout)["error"])
                    self.assertEqual(result.stderr, b"")
                else:
                    self.assertIn(reason, result.stderr)
                self.assertNotIn(b"crossfeed: heartbeat", result.stderr)
        self.assertEqual(self.records(), [])

    def test_json_done_preserves_unicode_and_caps_result(self):
        for mode in ("unicode-result", "big", "boundary"):
            with self.subTest(mode=mode):
                result = self.run_job(["--json"], mode=mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(result.stdout.splitlines()), 1)
                data = json.loads(result.stdout)
                record = self.records()[-1]
                path = self.home / "jobs" / record["id"] / "result.md"
                expected = {"unicode-result": "\ufeff检查 naïve\n下一行\n", "big": "line of result\n" * 60,
                            "boundary": ""}[mode]
                self.assertEqual(data, {"id": record["id"], "status": "done", "exit": 0,
                                        "result_path": str(path), "result": expected,
                                        "codex_edited": []})
                self.assertEqual(result.stderr, b"")
                if mode == "unicode-result":
                    self.assertEqual(path.read_bytes(), "\ufeff检查 naïve\r\n下一行\r\n".encode("utf-8"))

    def test_json_missing_codex_reports_not_started(self):
        absent = str(self.root / "missing-codex")
        for flags in ([], ["--json"]):
            with self.subTest(flags=flags):
                result = self.run_job(flags, CROSSFEED_CODEX=absent)
                self.assertEqual(result.returncode, 127, result.stderr)
                if flags:
                    data = json.loads(result.stdout)
                    self.assertEqual((data["status"], data["exit"]), ("not-started", 127))
                    self.assertEqual(data["codex_edited"], [])
                    self.assertIn(absent, data["error"])
                    self.assertEqual(result.stderr, b"")
                else:
                    self.assertIn(absent.encode(), result.stdout)

    def test_json_process_creation_error_reports_not_started_and_keeps_cli_exit(self):
        shim = self.root / "broken-interpreter"
        shim.write_text("#!" + str(self.root / "absent-interpreter") + "\n", encoding="utf-8")
        shim.chmod(0o700)
        for output in ([], ["--json"]):
            with self.subTest(output=output):
                result = self.run_job(output, CROSSFEED_CODEX=str(shim))
                self.assertEqual(result.returncode, 1, result.stderr)
                if output:
                    data = json.loads(result.stdout)
                    self.assertEqual((data["status"], data["exit"]), ("not-started", 1))
                    self.assertIn("could not start codex", data["error"])
                    self.assertEqual(result.stderr, b"")
                else:
                    self.assertIn(b"could not start codex", result.stdout)
                self.assertEqual(self.records()[-1]["status"], "failed")

    def test_current_job_rows_support_legacy_reader_role_rules(self):
        new_jobs = []
        for write in (False, True):
            result = self.run_job(["--write"] if write else [])
            self.assertEqual(result.returncode, 0, result.stderr)
            row = self.records()[-1]
            legacy_row = {key: value for key, value in row.items() if key != "write"}
            self.assertEqual(legacy_row["sandbox"], "workspace-write" if write else "read-only")
            new_jobs.append(legacy_row)
        self.assertEqual(sum(row["sandbox"] == "read-only" and row["status"] == "done" for row in new_jobs), 1)
        for row in new_jobs:
            self.assertIn(row["sandbox"], ("read-only", "workspace-write"))
            self.assertTrue(row["codex_thread"])
            result = self.run_job(["--resume", row["id"]], mode="echo")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIs(self.records()[-1]["write"], row["sandbox"] == "workspace-write")

    def test_json_reports_failed_empty_result_and_timeout(self):
        for mode, args, status, code in (("fail", [], "failed", 1), ("emptyresult", [], "failed", 1),
                                         ("hang", ["--timeout", "0.02"], "timeout", 124)):
            with self.subTest(mode=mode):
                result = self.run_job(["--json", *args], mode=mode, FAKE_CODEX_PIDFILE=str(self.root / "child"))
                self.assertEqual(result.returncode, code, result.stderr)
                record = self.records()[-1]
                path = self.home / "jobs" / record["id"] / "result.md"
                self.assertEqual(json.loads(result.stdout), {
                    "id": record["id"], "status": status, "exit": code, "result_path": str(path), "result": "",
                    "codex_edited": [],
                })
                self.assertEqual(result.stderr, b"")

    def test_json_quota_refusal_and_empty_brief_have_no_job(self):
        limits = {"secondary": {"window_minutes": 10080, "used_percent": 86}}
        for brief, code in ((b"Review this.\n", 75), (b"", 2)):
            with self.subTest(code=code):
                result = self.run_job(["--json"], brief=brief, FAKE_CODEX_RATE_LIMITS=json.dumps(limits))
                data = json.loads(result.stdout)
                self.assertIn("85% stop" if code == 75 else "brief must not be empty", data.pop("error"))
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(data, {
                    "id": None, "status": "not-started", "exit": code, "result_path": None, "result": "",
                    "codex_edited": [],
                })
                self.assertEqual(result.stderr, b"")
        self.assertFalse((self.home / "jobs").exists())
        self.assertEqual([row["type"] for row in self.records()], ["stop"])

    def test_big_result_is_capped(self):
        result = self.run_job(mode="big")
        self.assertEqual(result.returncode, 0, result.stderr)
        text = result.stdout.split(b"[crossfeed]", 1)[0]
        self.assertLessEqual(len(text.splitlines()), 60)
        self.assertLessEqual(len(text), 8192)
        self.assertIn(b"[crossfeed] result truncated: full text in", result.stdout)
        self.assertEqual(len((self.job_dir() / "result.md").read_bytes().splitlines()), 10000)

    def test_output_separator_counts_toward_byte_cap(self):
        result = self.run_job(mode="boundary")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLessEqual(len(result.stdout.split(b"[crossfeed]", 1)[0]), 8192)
        self.assertIn(b"[crossfeed] result truncated:", result.stdout)
        self.assertEqual((self.job_dir() / "result.md").read_bytes(), b"x" * 8192)

    def test_exit_zero_without_result_is_failure(self):
        for mode in ("noresult", "emptyresult", "unknown"):
            with self.subTest(mode=mode):
                result = self.run_job(mode=mode)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(b"[crossfeed] Codex exited 0 without a result.", result.stdout)
                self.assertEqual(self.records()[-1]["status"], "failed")

    def test_garbage_events_tolerated(self):
        result = self.run_job(mode="garbage")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"ok:", result.stdout)
        self.assertEqual(self.records()[-1]["tokens"]["input"], 12000)

    def test_stderr_diagnostics_do_not_turn_success_into_failure(self):
        result = self.run_job(mode="stderr-note")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertEqual(self.records()[-1]["status"], "done")
        self.assertIn(b"informational Codex diagnostic", (self.job_dir() / "stderr.log").read_bytes())

    def test_no_codex_on_path(self):
        empty_bin = self.root / "empty"
        empty_bin.mkdir()
        result = self.run_job(PATH=str(empty_bin))
        self.assertEqual(result.returncode, 127)
        self.assertIn(b"codex", result.stdout)
        self.assertIn(b"[crossfeed] last log lines:", result.stdout)
        self.assertEqual(self.records()[-1]["status"], "failed")

        self.assertEqual(self.records()[-1]["exit"], 127)
        detail = (self.job_dir() / "stderr.log").read_text()
        self.assertEqual(len(detail.splitlines()), 1)
        self.assertIn("codex was not found", detail)
        self.assertIn(str(empty_bin), detail)
        self.assertIn("CROSSFEED_CODEX", detail)

    def test_running_state_exists_before_codex_starts(self):
        result = self.run_job(mode="inspect-state")
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        self.assertIn(b"ok:", result.stdout)

    def test_invalid_directory_and_timeout_are_usage_errors(self):
        for args in (["--dir", str(self.root / "missing")], ["--timeout", "0"],
                     ["--timeout", "nan"], ["--timeout", "-1"]):
            with self.subTest(args=args):
                result = self.run_job(args)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.records(), [])

    def test_collision_exhaustion_exits_one_without_overwriting(self):
        crossfeed = load_crossfeed()
        existing = self.home / "jobs" / "20261117-010203-aaaa"
        existing.mkdir(parents=True)
        marker = existing / "brief.md"
        marker.write_bytes(b"original")
        stderr = io.StringIO()
        stdin = io.TextIOWrapper(io.BytesIO(b"new brief"))
        with patch.object(crossfeed, "new_job_id", return_value=existing.name), \
                patch.object(sys, "stdin", stdin), contextlib.redirect_stderr(stderr):
            code = crossfeed.main(["run", "--dir", str(self.root)])
        self.assertEqual(code, 1)
        self.assertIn("5 attempts", stderr.getvalue())
        self.assertEqual(marker.read_bytes(), b"original")
        self.assertEqual(self.records(), [])

    def test_default_directory_is_current_directory(self):
        result = run_crossfeed(["run"], stdin=b"brief", env=self.env, cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        record, = self.records()
        self.assertEqual(record["dir"], str(self.root.resolve()))
        self.assertEqual(record["tier"], "B")
        self.assertEqual(record["kind"], "task")


class EventTests(CrossfeedCase):
    def test_cap_text_utf8(self):
        crossfeed = load_crossfeed()
        text = ("检" * 100 + "\r\n") * 60
        capped, truncated = crossfeed.cap_text(text)
        self.assertTrue(truncated)
        self.assertLessEqual(len(capped.encode("utf-8")), 8192)
        self.assertEqual(capped.encode().decode(), capped)
        self.assertTrue(capped.endswith("\r\n"))
        self.assertTrue(text.startswith(capped))
        self.assertEqual(crossfeed.cap_text("检" * 3000), ("", True))
        self.assertEqual(crossfeed.cap_text(""), ("", False))
        self.assertEqual(crossfeed.cap_text("naïve\nlast", max_lines=1), ("naïve\n", True))
        self.assertEqual(crossfeed.cap_text("abc", max_bytes=3), ("abc", False))

    def test_parse_events_keeps_last_message_and_sums_usage(self):
        crossfeed = load_crossfeed()
        events = [
            {"type": "thread.started", "thread_id": "thread-1"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "first"}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "检查 naïve"}},
            {"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 3,
             "cache_write_input_tokens": 99, "output_tokens": 4, "reasoning_output_tokens": 2}},
            {"type": "turn.completed", "usage": {"input_tokens": 2, "output_tokens": 1}},
            {"type": "error", "message": "boom"},
            {"type": "turn.failed", "error": {"message": "Not logged in"}},
        ]
        parsed = crossfeed.parse_events([json.dumps(event) for event in events])
        self.assertEqual(parsed, {"thread": "thread-1", "tokens": {
            "input": 12, "cached": 3, "output": 5, "reasoning": 2,
        }, "last_message": "检查 naïve", "errors": ["boom", "Not logged in"]})

    def test_parse_events_ignores_unknown_and_malformed_shapes(self):
        crossfeed = load_crossfeed()
        lines = ["", "bad\r\n", "null", "[]", '"text"', '{"type":"future"}',
                 '{"type":"item.completed","item":null}', '{"type":"turn.failed","error":[]}',
                 '{"type":"turn.completed","usage":{"input_tokens":"bad"}}']
        self.assertEqual(crossfeed.parse_events(lines), {
            "thread": None, "tokens": {"input": 0, "cached": 0, "output": 0, "reasoning": 0},
            "last_message": "", "errors": [],
        })

    def test_usage_limit_accepts_both_apostrophes(self):
        crossfeed = load_crossfeed()
        for message in ("You've hit your usage limit", "You’ve hit your usage limit", "HIT YOUR USAGE LIMIT"):
            self.assertTrue(crossfeed.is_usage_limit([message]))
        self.assertFalse(crossfeed.is_usage_limit(["rate limit: try later", "Not logged in"]))
