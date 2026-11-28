# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- The README is now a short landing page. The routing rules, background-work
  protection, measurements, limits and research moved to
  [`docs/how-it-works.md`](docs/how-it-works.md), workflow stages to
  [`docs/workflow-stages.md`](docs/workflow-stages.md), and the status line,
  dispatcher, install notes and stored data to
  [`docs/reference.md`](docs/reference.md).

## 0.5.1 - 2026-11-28

### Added

- Workflow stages on Codex. A workflow agent whose prompt carries a
  `crossfeed-stage` block can run on Codex and return its text or
  structured answer through `agent()`. With routing enabled, `executor:
  auto` considers Codex when the 5-hour window is short or the routing
  policy selects it. A launch requires positive Codex headroom and Bash
  permission. `executor: codex` requires `schema` and fails if the stage
  cannot run on Codex. A `task` stage may edit in place. `review` and
  `research` stages are told to leave project files alone. Worktree
  isolation sends `auto` through ordinary Claude admission and causes an
  explicit Codex request to fail. After dispatch, only a silent `auto`
  stage can fall back, while the window has room and the dispatcher
  confirms Codex never started.
- `approveStages` defaults to off. Enabling it lets crossfeed launch a
  stage when Claude Code returns `ask`. In auto permission mode, the tested
  commands returned `ask` even with matching Bash allow rules. An explicit
  deny rule blocked the launch.
- While stages run on Codex, the status line counts active stage
  dispatchers, including those waiting for a slot, and shows the latest
  reported action among them or `started` if none has reported an action.
- `run --json` returns machine-readable output. `run --json --heartbeat
  SECONDS` also emits heartbeat and progress records. `run --slots N` makes
  each dispatcher wait for one of N shared slots before checking quota.
  Workflow stages use eight slots per data directory.

### Changed

- crossfeed no longer passes `-s read-only` or `-s workspace-write` to
  Codex: every job runs under your Codex configuration. The Quick start
  now asks you to let `codex exec` write the workspace, since its default
  is read-only. Read jobs are told to leave project files alone, and
  crossfeed warns when Codex reports that a read job edited a file.
- Crossfeed sets `CLAUDE.md` as the sole fallback filename for project
  instructions. Codex uses it in a directory when neither
  `AGENTS.override.md` nor `AGENTS.md` supplies instructions there.
- Job output lists `codex edits` (from Codex's own file-change events)
  apart from `workspace changes during the run`, which only write jobs
  report and which can include other agents' changes. Read jobs no longer
  take a workspace snapshot.
- Job rows carry a boolean `write` field and retain the legacy `sandbox`
  role label (`read-only` or `workspace-write`) so 0.5.0 readers can still
  count and resume new jobs. `/crossfeed report` says "read job results"
  where it said "read-only results".

## 0.5.0 - 2026-11-27

### Added

- crossfeed checks every agent start Claude Code exposes, including
  workflow agents. While the 5-hour window is short (at the `shedPercent`
  shed line, 85% by default, or when the current pace would fill it within
  15 minutes and before its reset), it refuses new workflow agents,
  background agents and the agents they start. A subagent the main loop
  waits for passes this check.
- At the first reading at or above the shed line, the breaker tries to
  stop background tasks already registered by this conversation. It
  reports explicit TaskStop denials and retries unresolved tasks on later
  readings at or above the line. With `wake` enabled, a pace crossing with
  registered work, a confirmed stop, or an explicit denial can wake an idle
  coordinator with an attached surface. The one-prompt allowance per window
  resets on plugin reload or conversation resume. Breaker messages identify
  stopped tasks or denied stops and explain how to resume each stopped
  workflow with a known run ID.
- `/crossfeed status` shows the short-window state. `/crossfeed report`
  counts agent starts by origin and outcome, breaker stops and wake-ups,
  which the plugin writes through the new `crossfeed.py record` command.
  Agent-start, breaker and wake-up counts show as unavailable until the
  ledger contains a valid event of one of those kinds.

### Changed

- Workflow agents follow the Claude model fallback rule. The static
  guidance asks the coordinator to launch heavy workflows one at a time
  while hand-offs are on.

## 0.4.0 - 2026-11-26

### Added

- `run --artifact ID` links jobs by label and kind and prints their round.
- `receipt ID` finds the latest successful review for an artifact and can
  check path modification times. Use `--kind any` to include all job kinds.
  For a verdict, run the review with `--output-schema` to produce a JSON
  object with a string `verdict`. Other results have no verdict.
- `run --role-file PATH` reuses a Markdown role such as a Claude Code
  agent definition in a fresh Codex job.
- `run --output-schema PATH` requests structured final output from Codex
  on fresh jobs and resumes.

### Changed

- The Codex preamble permits reading paths the brief names outside the
  job directory.
- New job records include six fractional digits in `started`. Readers of
  mixed ledgers should accept both `YYYY-MM-DDTHH:MM:SSZ` and
  `YYYY-MM-DDTHH:MM:SS.ffffffZ`.

## 0.3.0 - 2026-11-21

### Added

- Tier B calls can move when Claude's all-models week is 5 points ahead
  of an even pace or reaches 90% used.
- Tier B calls can also move when Codex is at least 15 points under an
  even pace to its weekly stop and has at least half its headroom.
- Balance notices tell Claude when to hand off checkable execution before
  its first command and when to do that work itself again.
- The status line shows an all-models week ahead and an active Codex
  surplus. `/crossfeed status` gives the figures and current hand-off reasons.
- The plugin attempts to log each balance notice and stretch reminder it
  attaches.
- `run --codex-stop PERCENT` sets the long-window stop for a launch,
  including a resume. The plugin passes its configured stop.

### Changed

- Weekly hand-off explanations use the account-week or surplus figures
  that moved the call. The decision record includes both weekly readings
  when available.
- The stretch reminder applies to every main-loop hand-off reason. It
  fires once per prompt on a counted call at or beyond `stretchCalls`.
- Hand-off advice needs at least half of Codex headroom. At 90% of
  Claude's 5-hour window, the reserve notice takes precedence.
- Fresh review, research and tier B subagent jobs use `gpt-6.2-astra`
  when Codex lists it. `CROSSFEED_JUDGMENT_MODEL` selects another listed
  model. An explicit `--model` takes precedence.
- `report` counts fresh jobs by hand-off cause, all jobs by model,
  launches refused by the guard and each kind of nudge.

### Fixed

- `run` checks quota before starting or resuming a job. At or above a
  counted Codex window's stop, it records the reason and exits 75.
- The plugin omits its static hand-off instructions in `off` mode.
- A late Codex reading no longer replaces a newer one unless the held
  reading is dated more than 5 minutes ahead of the clock.
- Headroom ignores Codex windows whose reset time has passed.

## 0.2.2 - 2026-11-21

### Added

- A ledger line for each subagent call the plugin decides, unless the mode
  is `off`: the call's type and model, the first 100 characters of its
  description, the brief's length, the tier, whether it was handed off and
  why, and the Claude and Codex readings at that moment. The line holds the
  brief's length, not its text; a hand-off's brief is saved separately when
  saving it works, as before. Writing it is best effort: a failure is logged
  and the call goes on as decided.
- `crossfeed.py used <job> yes|partly|no` records whether a successful
  job's result was used. When a read-only job succeeds, Claude is now told
  to verify the job's claims and record this, and the job's last output line
  asks for it instead of a check.
- `/crossfeed report` shows subagent calls by how they were routed,
  including how many hand-offs are linked by their saved brief to a job that
  has ended, and the ratings of successful read-only jobs.

### Changed

- `crossfeed.py run` records the session from `CLAUDE_CODE_SESSION_ID` when
  `--session` is omitted, and records the `--brief-file` it was given.

### Fixed

- A subagent call that waited for its readings was decided at the time it
  arrived. If a later call had been decided in the meantime and stayed on
  Claude, that stay was dropped from the count the burst rule uses, so a
  following call could stay on Claude where it should have been handed off.
  A call is now decided at the time the decision is made, and a stay dated
  up to a minute after a decision still counts.
- A reading that arrived late, after a newer one, replaced the newer one, so
  a decision or the status line could rest on the older value until the
  next update. Readings of Claude's usage and of the main model now take
  effect in the order they were asked for. A model-limit reading from
  `/usage` is dated by when its probe answered, less the age of its cached
  data, and is ignored if it is older than the one held, unless the held one
  is dated more than five minutes ahead of the clock (the clock went back).
- The refusal for a handed-off call is now built from its decision: the
  command uses the session the call was decided in, and any readings the
  refusal quotes are the ones the decision used. Before, both came from the
  moment the refusal was written, which could differ if a usage update or a
  `/clear` came in while the brief was being saved.

## 0.2.1 - 2026-11-19

### Fixed

- On each usage update (after a turn, for example), unless the mode is
  `off`, the plugin reads Codex's quota again when it has no reading or the
  reading is more than 15 minutes old, at most every 5 minutes. Before,
  only the start of a session and a subagent call that could be handed off
  read it, so in a session without such calls the status line and
  `/crossfeed status` showed Codex as `stale` or `unavailable` until one
  came.

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
