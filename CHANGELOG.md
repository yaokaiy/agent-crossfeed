# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- On each usage update (after a turn, for example), unless the mode is
  `off`, the plugin reads Codex's quota again when it has no reading or the
  reading is more than 15 minutes old, at most every 5 minutes. Before,
  only the start of a session and a subagent call that could be handed off
  read it, so a session without such calls showed `codex wk N% stale` or
  `codex unavailable` from then on.

## 0.2.0 - 2026-11-19

### Added

- Model-scoped weekly limits. The dispatcher's new `claude-usage` command
  reads them from Claude Code's `/usage` without a model call (cached for 5
  minutes, shared by sessions). A limit is `ahead` at 80%, or 5 points past
  an even pace for its week, and `full` at 100%.
- While a limit is `ahead` or `full`: subagent calls that would run on that
  model are decided with pressure of at least 0.3, so tier B work goes to
  Codex; `general-purpose` and `claude` subagents that stay on Claude and
  named no model run on the new `premiumFallback` option's model (default
  `opus`) when it is a cheaper model whose own limit is not ahead, and once
  the limit is full so do ones that named it; when the main loop runs on
  that model, Claude gets one notice and the long-stretch reminder, and is
  asked to tell the user about `/model` with `/advisor`. A reading taken
  before the limit's reset stops counting once the reset passes.
- The status line shows a model limit (`fable wk 62% ahead`) when the main
  loop runs on that model or the limit is ahead or full. `/crossfeed status`
  lists each limit with its even-pace line and what happens to subagents.
- Ledger: model-limit lockouts (`lockout --bucket`), subagents moved to a
  cheaper model (`downgrade`), and the cause of a hand-off (`run --cause`).
  `/crossfeed report` shows all three.

### Changed

- `lockout --last` and the 5-hour lockout count ignore model-limit lockouts.

### Fixed

- After `/clear` or a resume, notices and the long-stretch reminder start
  over and later hand-off commands and records carry the new session id.
  Before, the plugin kept the previous conversation's state, because
  Claude Code starts no new session for these.

## 0.1.1 - 2026-11-18

### Fixed

- The dispatcher finds Codex when its install directory is missing from
  `PATH`: it looks in `$CROSSFEED_CODEX`, then `PATH`, then a list of usual
  install directories (`$CROSSFEED_CODEX_DIRS` replaces the list), and adds
  the directory it found to the child's `PATH`. Before, such a session
  could not start a job, and its quota reading silently came from the
  newest session log; once that was older than 15 minutes nothing was
  handed off. `run` exits with 127 when Codex is not found.
- When Codex headroom is zero, `/crossfeed status` says why (no reading, a
  reading that is too old, Codex's reported limit, or the window that is
  used up), and so does the last-decision line when that is what kept a
  call on Claude. Before, both said only "no Codex headroom".
- A refused tool call no longer counts as a hands-on step or uses up the
  long-stretch reminder.
- A clock that returns no usable time, or goes back, no longer leaves a
  Codex reading or a burst count that never ages.

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
  whichever comes first. A refused tool call or a slash command does not
  carry them.
- Include the session id in lockout records from the plugin.
- The plugin description and the README lead with what the plugin does:
  routing subagent calls from Claude Code to Codex, call by call.

### Added

- `app_server_error` on every dispatcher quota response, preserving a bounded,
  single-line failure reason even when a session-log reading is available.
- `lockout --last` to read the newest lockout record with a valid reset time.
- A plugin icon.

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
