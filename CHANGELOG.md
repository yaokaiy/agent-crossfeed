# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1 - 2026-11-17

### Fixed

- The dispatcher finds Codex when its install directory is missing from
  `PATH`: it looks in `$CROSSFEED_CODEX`, then `PATH`, then a list of usual
  install directories (`$CROSSFEED_CODEX_DIRS` replaces the list), and adds
  the directory it found to the child's `PATH`. Before, such a session
  could not start a job, and its quota reading silently came from the
  newest session log; once that was older than 15 minutes nothing was
  handed off. `run` exits with 127 when Codex is not found.
- When Codex headroom is zero, the status and the last-decision line say
  why (no reading, a reading that is too old, Codex's reported limit, or
  the window that is used up) instead of "no Codex headroom".

### Changed

- Decide the next call with pressure at least 0.3 after 2 eligible tier A or
  B calls stayed on Claude in the last 10 minutes of the session.
- Start pressure at 0.3 after a known lockout when the new window began
  between 5 minutes before and 2 hours after the locked window's reset time,
  during that window's first 30 minutes.
- A Codex quota reading without a usable age counts as no reading instead
  of a fresh one.
- The status line is redrawn when a subagent call is decided, from the
  readings the decision used.
- Deliver queued notices with the next main-loop tool result or user prompt,
  whichever comes first.
- Include the session id in lockout records from the plugin.

### Added

- `app_server_error` on every dispatcher quota response, preserving a bounded,
  single-line failure reason even when a session-log reading is available.
- `lockout --last` to read the newest lockout record with a valid reset time.

## 0.1.0 - 2026-11-17

First public release. Alpha.

### Added

- Hand-off policy: eligibility rules, fit tiers A, B and C, a pressure
  controller for Claude's 5-hour window, and Codex headroom.
- Plugin hooks that refuse an eligible subagent call with one command to run
  on Codex instead, save the brief to a file (falling back to standard
  input), remind Claude during long hands-on stretches, and record lockouts.
- `/crossfeed status`, `report`, `auto`, `always` and `off`. `status` shows
  why the last subagent call was or was not handed off.
- Dispatcher `scripts/crossfeed.py` with `run`, `stash`, `check`, `quota`,
  `lockout` and `report`: Codex runs in the sandbox mode asked for, with a time
  limit, a list of changed files for write jobs in git repositories,
  distinct exit codes for failure, usage limit,
  timeout and interrupt, and an append-only local ledger.
