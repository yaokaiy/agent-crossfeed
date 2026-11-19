# Design

This document says what agent-crossfeed decides, how, and why. The routing
rules and their thresholds are stated here; a routing threshold that exists
only in code is a bug.

## Problem

Claude Code on a subscription has a rolling 5-hour usage window. When it
fills, every Claude session stops until the reset. Much of what fills it is
execution rather than judgment: subagents, and long runs of commands and
edits. Many people who hit that limit also hold a Codex subscription whose
quota is left over.

crossfeed moves execution work to the Codex CLI before the window fills.
Claude keeps coordinating the work, talking to the user and reviewing what
comes back.

A second limit works the same way. Some Claude models have their own weekly
limit on top of the all-model one (Claude Code's `/usage` lists them as
"Current week (Fable)", for example). That limit can run out days before
the week resets while the all-model week, the 5-hour window and Codex all
have room left. Much of what uses it is subagents that never asked for that
model and inherited it from the main loop. crossfeed watches these limits
too: while one is being used faster than an even pace, execution goes to
Codex or to a cheaper Claude model, and the scarce model is kept for
judgment.

## Goals and non-goals

Goals:

1. Fewer and shorter 5-hour lockouts for the same work, shown by numbers.
2. Fewer weeks in which a model's own weekly limit runs out before its
   reset, and fewer hours without that model, for the same work.
3. No setup beyond installing: no edits to settings, the status line or
   instruction files.
4. Every job the dispatcher finishes leaves a record: what ran, how long it
   took, how many Codex tokens it used, and, when a check was run, whether
   it passed.

Non-goals:

- It never changes the main loop's model or the advisor setting; it can
  suggest them. It changes a subagent's model only as section 5 says.
- No daemon, no database, no MCP server.
- One executor for now, the Codex CLI.
- No quota estimates from token counts. Only readings the vendors report.

Constraints the design works under:

- A hand-off must not cost more Claude quota than it saves, through turns
  spent waiting or results read back at length. Hence one background
  command, an exit notification, and a capped result.
- It must not drain the Codex quota the user needs for their own Codex
  work. Hence the headroom rule.
- A Codex result is a claim. The model is told to check it, and jobs
  without a recorded check are counted as unchecked.
- The system prompt must not change during a session, which would
  invalidate the prompt cache.
- A failure of the plugin itself must not block the user's work.

## The decision

Each time the main agent is about to start a subagent, crossfeed asks
separate questions. Routing research keeps "which model suits this task"
apart from "how tight is the budget", and so does this design (see
[References](#references)).

### 1. Eligibility

A call can be redirected only when all of these hold:

- its `subagent_type` is absent or in the `eligibleTypes` option (default
  `general-purpose`, `claude`). Other agent types carry their own system
  prompt, tool limits or MCP servers, which a brief does not carry to Codex;
- its `model` is not `haiku` (already cheap and fast);
- it is not `isolation: "remote"` and has no `name` (a named agent expects
  follow-up messages);
- its brief does not contain `mcp__`, `claude-in-chrome`, `computer-use`,
  `Claude_Browser`, `AskUserQuestion`, `SendMessage`, `Artifact tool`, or a
  word starting with `screenshot` (tools Codex does not have);
- its brief is not empty.

A call with `isolation: "worktree"` is eligible and runs in a Codex-managed
worktree.

### 2. Fit

Keyword rules on the call's description and brief, checked in this order, so
the reason fits in one line. "Head" means the description plus the first 300
characters of the brief.

| Tier | Rule | Handed to Codex |
| --- | --- | --- |
| C | the brief is under 100 characters; or the head contains one of the words design, architect…, ux, ui, frontend / front-end / front end, css, styling, layout, look and feel, naming, brainstorm… | never |
| A | the brief contains a check command (`pytest`, `unittest`, `npm test`, `pnpm test`, `yarn test`, `cargo test`, `go test`, `make test`, `make check`, `tox`, `jest`, `vitest`, `mvn test`, `gradle test`, `ctest`, `rspec`, `claude plugin test`) and the head or brief contains one of implement…, refactor…, migrat…, rename, port, convert, fix… failing / broken, make … pass, reproduc…, bisect, triage, log(s), flaky, upgrade, bump | when headroom is at least 0.5 |
| B | every other eligible call: research, reading code, review, implementation without a recognised check command | when pressure is at least 0.3 and headroom is above 0 |

Why these tiers. Published agentic coding benchmarks, a study of agents
whose requirements change during a run, a study of cross-model code review,
and one practitioner's published routing rules informed them (see
[References](#references)). Read together they suggest that the strongest
models of both vendors are close on repository-level implementation tasks
with a clear target, that Claude models tend to lead where judgment about
design and front-end quality matters, and that an executor does worst when
the brief is not fixed. So work with a fixed brief and a check goes in tier
A, and design work stays. This project did not re-verify the numbers in
those sources, and it has not measured that Codex does tier A work as well
as Claude on any user's tasks. The rules are heuristics: the ledger records
each job's tier and check result so they can be corrected from outcomes.

### 3. Pressure: how fast is Claude's window filling?

A feedback controller, in the manner of budget pacing in online
advertising, not a fixed threshold. A threshold such as "start at 50%"
reacts too late in a window that is burning fast and too early in one that
is not.

- `u` is the five-hour percent used and `R` the minutes to its reset.
  Readings are kept for 30 minutes. `r` is the rise in percent per minute
  since a reference reading: the newest one at least 10 minutes old, or the
  oldest one kept. `F = u + r * R` is where the window ends if that pace
  continues.
- `p` lies in [0, 0.8] and starts each window at `p0`, which is 0 except
  early in a window that follows a lockout (below). While the readings span
  less than 10 minutes,
  `p` is 0.5 when `u >= 80` and `p0` otherwise. After that it changes at
  most every 5 minutes: while `F > 95` it rises by
  `min(0.10, 0.20 * (r - a) / max(r, 0.05))`, where
  `a = max(0, 90 - u) / max(R, 1)` is the pace that would end at 90%; while
  `F < 80` it falls by 0.10; between the two it stays.
- A reset time that moves by more than one minute means a new window: the
  readings and any queued notices are cleared and `p` returns to `p0`. A
  reading without a reset time, once the known reset time has passed, also
  starts over, with `p0 = 0`.
- After a lockout `p0` is 0.3, on the assumption that the work that filled
  one window continues into the next; the first minutes of a window have no
  pace to measure. It applies when the new window began between 5 minutes
  before and 2 hours after the time the locked window was due to reset, and
  only during that window's first 30 minutes, judged from the reading's own
  reset time (a reading for a window that begins more than 5 minutes from
  now does not count). Outside those minutes `p0` is 0, so a session that
  starts later in the window, or whose readings resume after a long pause,
  is treated as in any other window. The plugin knows a lockout from the
  session's own rate-limit error and, at session start, from the newest
  lockout in the ledger that has a reset time.
- Claude's weekly use `w` adds `b = 0.25 * clamp((w - 75) / 15, 0, 1)`.
  Pressure is `P = max(p, b)`.

The controller sees only usage that has been reported, and a subagent's
usage arrives minutes after it starts. Several subagents started together
can use most of a window before `p` moves. So calls are counted as well:
when 2 eligible tier A or B calls have stayed on Claude in the last 10
minutes of the session, the next call is decided with `P` taken as at least
0.3. A call that something else then refuses, so that no subagent starts,
is taken out of the count when the refusal arrives. Notices and the
long-stretch reminder use `P` itself.

### 4. Headroom: how much Codex quota is left?

`g` is 1 while Codex's use is low and falls to 0 as it nears the
`codexStopPercent` option (default 85). For a window longer than 6 hours,
with `v` its percent used and `D` the days to its reset (7 when unknown):

`g = clamp((85 - v) / (10 + 10 * clamp(D / 7, 0, 1)), 0, 1)`

so hand-offs taper over the last 10 to 20 points, sooner when the reset is
far away. A window of 6 hours or less gives 0 at 90% used and 1 below. With
several windows the smallest value counts. `g` is 0 when Codex reported its
limit, when the reading is more than 15 minutes old or dated that far ahead
of the clock, or when there is none.

When `g` is 0 the plugin keeps the cause: no reading, a reading that is too
old, Codex's reported limit, or the window that is used up. `/crossfeed
status` names it, and so does the last-decision line when headroom is what
kept the call on Claude, with the dispatcher's error when there is one. The
status line shows `codex unavailable` without a reading and marks one that
is too old as `stale`.

The Codex reading is refreshed when it is older than 5 minutes and a call
could be handed off. After a failed read the plugin waits 5 minutes before
trying again. A reading whose age is missing or not a number, or that is
dated more than 5 minutes ahead of the clock, counts as no reading.

### 5. Model limits: is one model's weekly limit going too fast?

**Reading.** The plugin API reports only the 5-hour and all-model weekly
windows. Model-scoped weekly limits appear in Claude Code's `/usage`, which
reads them from the server without a model call. The dispatcher's
`claude-usage` runs `claude -p /usage --output-format json
--no-session-persistence --setting-sources project` from the data
directory (no transcript is kept, and no user plugin loads in that process)
with a 20-second limit, and parses each `Current week (<label>): <n>% used
· resets <time>` line whose label is not `all models`. The label's model
family is the first of fable, opus, sonnet, haiku it contains. Results are
cached in the data directory for 5 minutes, failures for 1 minute, and
shared by all sessions; a file lock lets only one session run the probe at
a time.

The plugin reads at session start; before a subagent decision and on a
usage update, when its reading is more than 10 minutes old and its last
attempt was more than 10 minutes ago; and, bypassing the cache, after a
turn ends with a rate-limit error.

**State.** For a limit at `q` percent with reset time `T`, the even-pace
line is `L = 100 * (1 - (T - now) / 7 days)`, clamped to [0, 100]. `T` is
the limit's own reset time, else the all-model weekly reset time Claude
reports. The limit is

- `unknown` when there is no reading, or it is more than 20 minutes old or
  dated more than 5 minutes ahead of the clock, or `T` has passed (the
  reading belongs to a week that has ended; a cached reading in that state
  is not reused either);
- `full` at `q >= 100`;
- `ahead` at `q >= 80`, or at `q >= L + 5` when `T` is known;
- `ok` otherwise.

Only `ahead` and `full` change anything; `unknown` acts like `ok`, since
there is no evidence that the model is short. The thresholds were chosen by
replaying three past weeks of one user's logs; they are heuristics.

A subagent call "would run on" a model family when it names a model of
that family, or names none and the main loop runs on that family.

**Effects while a family is `ahead` or `full`:**

- A subagent call that would run on it is decided with `P` taken as at
  least 0.3, so tier B goes to Codex when `g > 0`; tier A keeps its own
  rule. The known limit also stands in for a missing Claude reading. When
  the limit is what moved a tier B call (pressure without it is below
  0.3), the command carries `--cause limit` and the job record keeps it.
- A subagent that still starts on Claude runs on the `premiumFallback`
  model (default `opus`; empty turns this off) when its type is
  `general-purpose` or `claude`, it is not a fork, and either it named no
  model (or `inherit`) or the family is `full` (a call that names a full
  model would fail). The fallback must be of a cheaper family (haiku <
  sonnet < opus < fable) that is not itself `ahead` or `full`; otherwise
  nothing is rewritten. The list of types is fixed: both inherit the
  parent's model, while other types may set their own, which the plugin
  cannot see, and rewriting those could make them more expensive. The
  plugin records a rewrite only when the started subagent's model is of
  the fallback's family; the engine can ignore a rewrite, for example for
  a resumed agent.
- When the main loop runs on that family, one notice per session when it
  becomes `ahead` and one when it becomes `full`, delivered like the
  notices below. It asks the model to keep planning, decisions and review,
  to hand execution to Codex, and to tell the user once about `/model
  <fallback>` with `/advisor <family>` (Claude Code's own setting for
  consulting a stronger model at key moments); without a usable fallback
  it suggests neither. A notice counts as sent only once it is delivered.
  The long-stretch reminder also fires while that family is `ahead` or
  `full`.
- After a rate-limit error, if the main loop's family is at 100% on a
  fresh reading, the ledger gets a lockout record for that limit, once
  per limit and reset time per session. These records never count as
  5-hour lockouts.

### The decision

In this order: mode `off` hands nothing off; so does a missing Claude
reading (unknown is not free capacity) unless the call would run on a
model limit that is `ahead` or `full`; so does `g = 0`; tier C stays; mode
`always` hands off every remaining call; tier A goes when `g >= 0.5`; tier B
goes when `P >= 0.3`, which a burst (section 3) or a model limit (section
5) can supply.

Two more signals reach the model, each once per window or stretch:

- when `P` first reaches 0.3, and when `u` first reaches 90, a one-line
  notice is attached to the next tool result in the main loop or to the
  user's next prompt, whichever comes first. A refused tool call, a slash
  command and a meta prompt do not carry it;
- after `stretchCalls` hands-on tool calls (default 12) with no user prompt
  in between, while `P >= 0.3` or the main loop's model limit is `ahead`
  or `full`, one reminder is attached to a tool result. Refused calls are
  not counted.

Notices and the stretch count belong to a conversation. Claude Code reports
`/clear` and a resume as the end of a session without a new start; after
either, they begin again, and later commands and records carry the new
session id. Readings and the pressure state are kept.

## What a hand-off looks like

1. The plugin saves the subagent's brief to a file through the dispatcher
   (`crossfeed.py stash`).
2. It refuses the subagent call. The refusal text holds the tier and its
   reason, both quota readings, and one command to run.
3. The main agent starts that command as a background shell command and is
   notified when it exits. Waiting costs no model turns.
4. The dispatcher runs `codex exec` on the brief and prints the result,
   capped at 60 lines and 8 KB, with the job id and, where it can, the list
   of files that changed.
5. The main agent runs the brief's check through `crossfeed.py check`,
   which records pass or fail, and reports to the user.

The plugin enforces step 2. Steps 3 and 5 are instructions in the refusal
text and in the section the plugin adds to the system prompt; the model
normally follows them, and nothing forces it to.

If saving the brief fails, the call is still refused, and the command takes
the brief on standard input through a quoted heredoc whose delimiter is
checked to be absent from the brief.

The system-prompt section is fixed text. Live numbers enter only at the
tail of the conversation: in the refusal, in notices, in tool-result
context.

## The dispatcher

`scripts/crossfeed.py` is one Python file with no third-party dependencies.
It needs the Codex CLI, and git for change lists. It works without the
plugin.

- **Finding Codex.** It uses the executable named by `$CROSSFEED_CODEX`
  when that is set and not empty, else `codex` on `PATH`, else the first
  match in a list
  of install directories: `/opt/homebrew/bin`, `/usr/local/bin`,
  `/home/linuxbrew/.linuxbrew/bin`, and `.local/bin`, `.npm-global/bin`,
  `.bun/bin` and `.volta/bin` under the home directory.
  `$CROSSFEED_CODEX_DIRS`, separated like `PATH`, replaces the list. The
  list exists because a Claude Code session's `PATH` can lack the directory
  Codex was installed in. When the directory Codex was found in is not on
  the child's `PATH`, it is put first, since a Codex installed through npm
  starts `node` from there. A `$CROSSFEED_CODEX` that is not an executable
  file is an error, not a reason to look further. When Codex is not found,
  `run` exits with 127 and says where it looked.
- **Sandbox.** It asks Codex for its read-only sandbox by default and for
  `workspace-write` in the given directory with `--write`. What those
  sandboxes permit, including network access, is decided by Codex and the
  user's Codex configuration.
- **Preamble.** Every brief is preceded by fixed rules: stay in the
  directory; never push, commit or post; print no secrets; answer in at most
  40 lines with the conclusion, the evidence and what is not done. These are
  instructions to Codex, not a mechanism.
- **Effort.** Reasoning effort defaults to `high` and is an option.
- **Time limit.** 30 minutes by default. On timeout, or when the dispatcher
  receives SIGINT, SIGTERM or SIGHUP, the Codex process group is stopped and
  the job is recorded as `timeout` or `interrupted`.
- **Failures are told apart.** Codex's own usage-limit message gives exit
  code 75 and a line telling the model to do the work itself; hand-offs stop
  once a later quota reading reports the limit. Any other failure of a Codex
  that started gives exit code 1 with the last log lines. Nothing is retried
  automatically. An exit
  code of 0 without a result is a failure. An error event during a run that
  still finished with a result is not.
- **Change list.** For a `--write` job in a git repository the dispatcher
  records the modified and untracked files, with content digests, before
  and after, and lists the paths that differ, at most 10 by name. It says
  when nothing differs and warns when `HEAD` changed. A change that was
  committed during the job shows only as that warning. Paths it identifies
  as symbolic links or special files are not opened. `--worktree` jobs and
  directories outside git get no change list.
- **Ledger.** `ledger.jsonl` in the data directory, append-only, written
  under a file lock: one line when a job ends, one per check, one per
  lockout, one per subagent moved to a cheaper model (`downgrade`). A check
  records the program's name, not its arguments. A lockout written with
  `--bucket <label>` is a model-limit lockout. `lockout --last` prints the
  reset time of the newest 5-hour lockout that has one. `run --cause
  <word>` stores why a job was handed off.
- **Claude usage.** `claude-usage` reads model-scoped weekly limits as
  section 5 says. It finds Claude Code through `$CROSSFEED_CLAUDE`, then
  `PATH`, then `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.
- **Quota.** `quota` asks `codex app-server` for the account's rate limits,
  with no model turn. If that fails it reads the last rate-limit event in
  the newest 8 Codex session logs and reports its age and the app server's
  error.

The data directory is `$CROSSFEED_HOME`, else `$CLAUDE_CONFIG_DIR/crossfeed`,
else `~/.claude/crossfeed`. Exit codes of `run`: 0 done, 1 failed, 2 usage
error, 75 Codex usage limit, 124 timeout, 127 Codex not found, 130
interrupted.

## Architecture

Ports and adapters.

| File | Role |
| --- | --- |
| `hooks/policy.ts` | pure functions: eligibility, fit, pressure, headroom, decision |
| `hooks/text.ts` | pure text builders |
| `hooks/config.ts` | options with defaults and validation |
| `hooks/core.ts` | the session state machine, engine-free |
| `hooks/register.ts` | the only code that touches Claude Code's hook API |
| `scripts/crossfeed.py` | execution, quota reading, ledger |

Claude Code's function-hook API is early access. Keeping every decision out
of `register.ts` means an API change touches one thin file, and a second
adapter for another host can reuse the rest.

Codex jobs are started by the main agent as background shell commands, not
by the plugin. They belong to Claude Code's own task tracking, survive a
plugin reload, and need no daemon.

If a hook throws, it logs the failure and lets the original event continue.

## How to tell whether it works

`/crossfeed report` shows, for the last 7 days:

- **lockouts**: turns that ended with a rate-limit error while the last
  five-hour reading was 95% or more, and the time from each to its window's
  reset. This is the time the window stayed closed, an upper bound on time
  lost;
- **jobs** by outcome, Codex tokens, and median job time;
- **checks**: for each tier, how many jobs' first recorded check passed, and
  how many jobs have no check;
- **model limits**: lockouts per limit and the time from each to its reset;
  subagents moved to a cheaper model; jobs handed off because of a model
  limit.

Compare a week with crossfeed against a week without. Time locked out
should fall; most checked jobs should pass their first check in each tier;
Codex weekly use should stay under the stop percentage. If one tier's pass
rate is clearly lower than the other's, its rules are wrong for your work:
change the options or open an issue with the numbers.

## Limits

- No measurement yet shows that hand-offs reduce lockouts, or what they
  cost in Claude usage.
- In a very heavy window, demand can be several times the window's capacity
  and only part of it can move.
- The fit rules are keyword heuristics. They will misfile some briefs.
- The controller's constants were derived by calculation, not tuned on
  measurements. Apart from the options listed in the README they are fixed
  in code.
- A Codex job starts with none of the conversation. A thin brief gives a
  poor result.
- Claude's reading comes from its last API response and Codex's from its
  app server, with a session-log fallback. Either can be missing; then
  nothing is handed off, except that a fresh model-limit reading that is
  `ahead` or `full` stands in for a missing Claude reading (section 5).
- Calls are counted per session. Subagents started from two sessions at
  the same time are not seen as one burst, and subagents that are already
  running cannot be moved.
- Model limits are parsed from text Claude Code prints for people. A change
  in that text makes the reading fail (no limit is acted on) until the
  parser is updated. A feature request to expose these limits to plugins
  would remove the parser.
- The main loop's own use of a scarce model is most of it. The plugin only
  asks the model to hand off execution and suggests `/model` and
  `/advisor`; the user decides. Whether advisor calls count toward the
  advised model's weekly limit has not been measured.

## Planned

Continuity: when Claude is locked out anyway, continue the task on Codex
from a hand-off note and let Claude review the result after the reset.

## References

Routing and budgets:

- Ong et al., "RouteLLM: Learning to Route LLMs with Preference Data",
  [arXiv:2406.18665](https://arxiv.org/abs/2406.18665)
- Chen, Zaharia and Zou, "FrugalGPT: How to Use Large Language Models While
  Reducing Cost and Improving Performance",
  [arXiv:2305.05176](https://arxiv.org/abs/2305.05176)
- Ding et al., "Hybrid LLM: Cost-Efficient and Quality-Aware Query Routing",
  [arXiv:2404.14618](https://arxiv.org/abs/2404.14618)
- Taberner-Miller, "ParetoBandit: Budget-Paced Adaptive Routing for
  Non-Stationary LLM Serving",
  [arXiv:2604.00136](https://arxiv.org/abs/2604.00136)
- Qin et al., "Pathwise-Budgeted LLM Routing: Online Allocation with K-Bit
  Tail-Cost Learning", [arXiv:2611.05835](https://arxiv.org/abs/2611.05835)

Coding agents and delegation:

- Samway et al., "Scaling Inference-Time Compute with Teams of Coding
  Agents", [arXiv:2610.17471](https://arxiv.org/abs/2610.17471)
- Xiang et al., "Cross-Model LLM Code Review: Should you use Claude to
  review Codex or vice versa?",
  [arXiv:2607.21656](https://arxiv.org/abs/2607.21656)
- Huang et al., "SWE-Shift: Evaluating Coding Agents in Evolving
  Workspaces", [arXiv:2610.32196](https://arxiv.org/abs/2610.32196)
- skrode's delegation benchmark, which measured that handing small tasks to
  another model raised the planner's token use while pass rates stayed the
  same: <https://github.com/gabrielqfr/skrode/blob/main/docs/benchmark.md>
- A practitioner's routing rules for Claude and Codex:
  <https://github.com/steipete/agent-scripts/blob/main/skills/codex-first/SKILL.md>

Benchmarks consulted: [Terminal-Bench](https://www.tbench.ai/),
[SWE-bench Pro](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2),
WebDev Arena.
