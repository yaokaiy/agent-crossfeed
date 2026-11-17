# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
