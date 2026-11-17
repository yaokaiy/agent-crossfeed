# Contributing

## Layout

| Path | What it holds |
| --- | --- |
| `hooks/policy.ts` | Pure decisions: eligibility, fit tier, pressure controller, Codex headroom, the hand-off decision |
| `hooks/text.ts` | Pure text builders: status line, refusal text, the system-prompt section, notices |
| `hooks/config.ts` | Plugin options with defaults and validation |
| `hooks/core.ts` | The session state machine, built on the three files above |
| `hooks/register.ts` | The only file that talks to Claude Code's hook API |
| `scripts/crossfeed.py` | The dispatcher: runs Codex, keeps the ledger, reads Codex quota |
| `tests/py/` | Dispatcher tests, with a stand-in `codex` executable |
| `tests/ts/` | Plugin tests |
| `docs/design.md` | What the plugin does and why, with every threshold |

## Setup

You need Claude Code 2.1.325 or later (for `claude plugin test` and
`claude plugin validate`), Python 3.9 or later, and git. The tests use a
stand-in `codex` executable, so Codex itself is not needed to run them.
Clone the repository and run `make test`.

## Rules

1. **Decisions stay engine-free.** `policy.ts`, `text.ts`, `config.ts` and
   `core.ts` never touch `$` and never read the clock: time comes in as
   `now`, in epoch milliseconds. Claude Code's function-hook API is early
   access; when it changes, only `register.ts` should need to change.
2. **The dispatcher stands alone.** `scripts/crossfeed.py` uses the Python
   standard library only, runs on Python 3.9 as `python3 -I`, and must work
   without the plugin.
3. **A broken hook never blocks work.** A hook that throws logs the failure
   and lets the original event continue.
4. **Unknown is not free capacity.** A missing or failed quota reading on
   either side hands nothing off.
5. **The system-prompt section never changes within a session.** Live
   numbers enter only at the tail of the conversation, so the prompt cache
   stays valid.
6. **Tests start from inputs.** Cover empty, missing and zero-length values,
   CRLF and non-ASCII text, and states where two values the code assumes
   agree do not. Do not build tests from expected outputs alone.

## Running the tests

```bash
make test        # everything
make test-py     # python3 -I -m unittest discover -s tests/py -v
make test-ts     # claude plugin test .
make validate    # claude plugin validate .
```

The TypeScript tests need the Claude Code CLI, so CI runs the Python tests
only. Run `make test` locally before you open a pull request.

## Changing a threshold or a tier rule

Change `docs/design.md` first, with the evidence, then the code and its
tests. A routing threshold that exists only in code is a bug, and so is a
sentence in the README or the design that the code does not back.

## Adding another executor

The executor is the part of `scripts/crossfeed.py` that starts `codex exec` and
reads its events. To add one, keep the command-line contract and the ledger
format, and add a stand-in executable under `tests/py/` with the same failure
modes the Codex stand-in has: failure, usage limit, hang, no result, garbage
output.

## Commits

Small commits, imperative subject, conventional prefix (`feat`, `fix`,
`docs`, `test`, `chore`). Update `CHANGELOG.md` for anything a user would
notice.
