"""Local /usage stand-in; never calls a service."""

import json
import os
from pathlib import Path
import sys
import time


if __name__ == "__main__":
    log = os.environ.get("FAKE_CLAUDE_LOG")
    if log:
        with Path(log).open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(),
                                     "stdin": sys.stdin.read(), "pid": os.getpid()}) + "\n")
    time.sleep(float(os.environ.get("FAKE_CLAUDE_SLEEP", "0")))
    fixture = os.environ.get("FAKE_CLAUDE_STDOUT")
    if fixture:
        sys.stdout.buffer.write(Path(fixture).read_bytes())
    sys.exit(int(os.environ.get("FAKE_CLAUDE_EXIT", "0")))
