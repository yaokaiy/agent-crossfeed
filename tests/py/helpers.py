"""Isolated CLI and import helpers for dispatcher tests."""

import importlib.util
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


CROSSFEED = Path(__file__).resolve().parents[2] / "scripts" / "crossfeed.py"


def load_crossfeed():
    spec = importlib.util.spec_from_file_location("crossfeed", CROSSFEED)
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, "dont_write_bytecode", True):
        spec.loader.exec_module(module)
    return module


def run_crossfeed(args, stdin=b"", env=None, cwd=None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", str(CROSSFEED), *args],
        input=stdin, capture_output=True, env=env, cwd=cwd, timeout=20,
    )


class CrossfeedCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "crossfeed"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.shim = self.bin / "codex"
        fake = Path(__file__).with_name("fake_codex.py")
        self.shim.write_text(
            "#!/bin/sh\nexec {} -I {} \"$@\"\n".format(
                shlex.quote(sys.executable), shlex.quote(str(fake))
            ),
            encoding="utf-8",
        )
        self.shim.chmod(0o755)
        self.claude_shim = self.bin / "claude"
        self.claude_shim.write_text(
            "#!/bin/sh\nexec {} -I {} \"$@\"\n".format(
                shlex.quote(sys.executable),
                shlex.quote(str(Path(__file__).with_name("fake_claude.py"))),
            ), encoding="utf-8",
        )
        self.claude_shim.chmod(0o755)
        for program in ("git", "true", "false"):
            executable = shutil.which(program)
            if executable:
                (self.bin / program).symlink_to(executable)
        self.env = os.environ.copy()
        self.env.pop("CROSSFEED_CODEX", None)
        self.env.pop("CROSSFEED_CLAUDE", None)
        self.env.pop("CLAUDE_CODE_SESSION_ID", None)
        for name in list(self.env):
            if name.startswith(("FAKE_CODEX", "FAKE_CLAUDE")):
                del self.env[name]
        self.env.update(
            CROSSFEED_HOME=str(self.home),
            CODEX_HOME=str(self.root / "codex-home"),
            PATH=str(self.bin),
            CROSSFEED_CODEX_DIRS="",
            TMPDIR=str(self.root),
        )
        environment = patch.dict(os.environ, self.env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

        temporary_files = patch.object(tempfile, "tempdir", str(self.root))
        temporary_files.start()
        self.addCleanup(temporary_files.stop)
