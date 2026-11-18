# agent-crossfeed

[![ci](https://github.com/yaokaiy/agent-crossfeed/actions/workflows/ci.yml/badge.svg)](https://github.com/yaokaiy/agent-crossfeed/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code plugin that hands self-contained execution work to the Codex
CLI before Claude's 5-hour usage window runs out, and records each job.

It is for people who use Claude Code as their main agent and also have a
Codex subscription. In aviation, crossfeed lets an engine draw fuel from the
other side's tank so that neither runs dry first. This does the same with
two subscriptions.

Status: alpha (0.1.1). A hand-off has been run end to end against the real
Claude Code and Codex CLIs. Its effect on lockouts has not been measured
yet. See [Limits](#limits).

This is an independent project. It is not affiliated with or endorsed by
Anthropic or OpenAI.

## What it does

Claude's 5-hour window stops every Claude session when it fills. Much of
what fills it is execution: subagents and long runs of commands and edits.
crossfeed watches both quotas. When Claude is about to start a subagent
whose brief the rules judge suitable for Codex, it refuses the call and
gives Claude one command to run instead:

```
crossfeed: run this on Codex instead of a Claude subagent.
Why: tier A (has a check command and is implementation-type work). Claude 5h 62%, on pace for 104%; Codex weekly 17%.
The brief you just wrote is saved. Start this as a background Bash command:
python3 -I '.../scripts/crossfeed.py' run --tier A --kind subagent --dir '/your/repo' --write --brief-file '.../briefs/20260101-120000-ab12.md'
Add --write if the task must change files, drop it if not. Wait for the exit notification and do not poll. Check the result before you report it.
```

When the command exits, Claude Code notifies Claude, which reads its output:

```
[crossfeed] job 20260101-120000-ab12 done in 1m32s; tier A; kind subagent; sandbox workspace-write; codex tokens 48210
[crossfeed] changed 2 file(s): calc.py, test_calc.py
[crossfeed] record the outcome: python3 -I .../scripts/crossfeed.py check 20260101-120000-ab12 -- <your check command>
```

Claude is told to run the brief's check through `crossfeed.py check`, which
records pass or fail, and then to report to you. Claude still coordinates
the work, talks to you and reviews what comes back.

## Requirements

- [Claude Code](https://code.claude.com/docs) 2.1.325 or later, on a
  subscription plan. crossfeed uses the function-hook plugin API, which is
  early access and may change.
- Codex CLI 0.167 or later, logged in (`codex login`).
- Python 3.9 or later, and git.
- macOS or Linux.

crossfeed looks for `codex` in `$CROSSFEED_CODEX` when that is set and not
empty, then on `PATH`, then in the usual install directories listed in
[the design](docs/design.md#the-dispatcher). If your Codex is somewhere
else and Claude Code runs with a `PATH` that lacks it, set `CROSSFEED_CODEX`
to the executable's path.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-crossfeed --marketplace yaokaiy/agent-crossfeed
```

Or from a shell:

```bash
claude plugin install agent-crossfeed --marketplace yaokaiy/agent-crossfeed
```

To try it from a clone for one session:

```bash
claude --plugin-dir /path/to/agent-crossfeed
```

There is nothing else to set up. Claude Code asks you to approve the
dispatcher command when it runs, as it does for any shell command. To skip
that prompt for hand-offs, allow the dispatcher's `run` command in your
Claude Code settings, using the script path shown in the refusal message:

```json
{
  "permissions": {
    "allow": ["Bash(python3 -I '/path/to/agent-crossfeed/scripts/crossfeed.py' run *)"]
  }
}
```

Do not allow `check` the same way: it runs whatever command you give it.

To remove the plugin: `claude plugin uninstall agent-crossfeed@agent-crossfeed`.

## Use

A line under the prompt shows the state:

```
crossfeed auto · claude 5h 62% (pace 104%) · 7d 41% · codex wk 17% · pressure 0.4
```

When Codex's quota cannot be read the line says `codex unavailable`, and a
reading older than 15 minutes is marked `stale`. Nothing is handed off in
either state; `/crossfeed status` says why.

| Command | Effect |
| --- | --- |
| `/crossfeed` or `/crossfeed status` | readings, pressure, what would be handed off now, and why the last subagent call was or was not handed off |
| `/crossfeed report` | the last 7 days: lockouts seen, jobs, tokens, results of the first check recorded for each job |
| `/crossfeed always` | hand off every tier A and B call while Codex has room (this session) |
| `/crossfeed auto` | back to the default (this session) |
| `/crossfeed off` | stop steering, keep the record (this session) |

## How it decides

For each subagent call crossfeed asks three questions.

1. **Fit.** What kind of task is this? The answer comes from keyword rules
   on the call's description and brief.

   | Tier | Work | Handed to Codex |
   | --- | --- | --- |
   | A | a brief that names a check command (`pytest`, `npm test`, `cargo test` and similar) and reads as implementation work: implement, refactor, migrate, fix failing tests, reproduce, triage logs | when Codex headroom is at least half |
   | B | everything else that is eligible: research, reading code, review, implementation without a recognised check command | when Claude's window is filling fast |
   | C | design, architecture, UX, front-end look, naming, brainstorming, and briefs under 100 characters | never |

2. **Pressure.** How fast is Claude's 5-hour window filling? crossfeed
   forecasts where the window will end at the current pace. It raises a
   pressure value in small steps while that forecast is above 95% and lowers
   it when the forecast is below 80%.

3. **Headroom.** How much Codex quota is left? Hand-offs taper off as
   Codex's weekly use approaches 85%.

The forecast cannot see subagents that have just started, so two more
rules apply. Once two calls that could have been handed off (tier A or B)
have stayed on Claude within 10 minutes, further tier B calls in that time
go to Codex too, while it has headroom. And a window that begins within two
hours of a locked window's
reset starts with pressure already raised; that start counts for the
window's first 30 minutes.

If either quota cannot be read, nothing is handed off, and `/crossfeed
status` names the reason. Only calls to the general-purpose agent types are
considered. Other agent types, calls pinned
to the `haiku` model, named or remote agents, and briefs that mention
browser tools or other Claude-only tools stay on Claude.

The exact rules, formulas and sources are in [docs/design.md](docs/design.md).

## The dispatcher

`scripts/crossfeed.py` works without the plugin. Write the task into a file,
here `brief.md`, and use the job id that `run` prints:

```bash
python3 -I scripts/crossfeed.py run --tier A --dir "$PWD" --write < brief.md
python3 -I scripts/crossfeed.py check 20260101-120000-ab12 -- pytest -q
python3 -I scripts/crossfeed.py quota
python3 -I scripts/crossfeed.py report
```

`run` puts a fixed preamble before the brief (stay in the directory, never
push, commit or post, answer in at most 40 lines), runs `codex exec` asking
for Codex's read-only sandbox, or for `workspace-write` with `--write`, and
prints the result capped at 60 lines. For a write job in a git repository it
compares the modified and untracked files before and after, lists the ones
that changed, and warns when `HEAD` moved. Jobs run with `--worktree` and
directories outside git get no change list. `--brief-file PATH` reads the
brief from a file instead of standard input, and `stash` saves standard
input to such a file and prints its path; the plugin uses the pair.

Exit codes of `run`: 0 done, 1 failed, 2 usage error, 75 Codex reported its
usage limit, 124 timeout, 127 Codex not found, 130 interrupted. On a timeout
or an interrupt the Codex process group is stopped.

`check` runs your check command and records pass or fail for the job. The
verdict comes from the command's exit status, not from the model.

## Options

Set them with `/plugin configure agent-crossfeed@agent-crossfeed`.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `always` or `off` |
| `effort` | `high` | Codex reasoning effort for hand-offs |
| `model` | empty | Codex model; empty uses your Codex configuration |
| `eligibleTypes` | `general-purpose,claude` | subagent types that may be redirected |
| `stretchCalls` | `12` | hands-on tool calls in a row before one reminder |
| `codexStopPercent` | `85` | Codex weekly use at which hand-offs stop |
| `timeoutMinutes` | `30` | time limit for one job |

## Safety and data

- If a hook of the plugin throws, the subagent call goes ahead on Claude,
  unchanged. If only saving the brief fails, the call is still handed off
  and Claude is told to pass the brief on standard input instead.
- crossfeed asks Codex for its read-only sandbox, or for `workspace-write`
  with `--write`. What those sandboxes permit is decided by Codex and your
  Codex configuration, not by crossfeed.
- crossfeed passes a brief to your Codex CLI and to nothing else. Codex then
  handles it as your Codex configuration says.
- What crossfeed stores stays on your machine, in `$CROSSFEED_HOME`, else
  `$CLAUDE_CONFIG_DIR/crossfeed`, else `~/.claude/crossfeed`: a ledger with
  one line per finished job, check and lockout, the saved briefs, and each
  job's event log and result. Files are created readable by you only. A
  check is recorded by program name, without its arguments.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limits

- Hand-offs aim to make lockouts rarer and later. Whether they do, and what
  the hand-offs themselves cost in Claude usage, has not been measured yet.
- The tiers are keyword heuristics informed by published benchmarks and one
  practitioner's routing rules, not by your tasks. They will misfile some
  briefs. `/crossfeed report` shows check results per tier so you can see
  whether they hold for you.
- Subagent calls are counted per session. Subagents started from two
  sessions at once are not seen as one burst, and subagents that are
  already running cannot be moved.
- In a very heavy window only part of the usage can move, so a lockout can
  still happen.
- A Codex job starts with none of the conversation's context. Thin briefs
  give poor results.
- Running the command in the background and checking the result are
  instructions to the model, not something the plugin can enforce.
- The pressure controller's constants were calculated, not tuned on
  measurements, and most are fixed in code.
- Continuing a task on Codex after Claude is locked out is planned and not
  in this version.

## Related work

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc):
  OpenAI's plugin for calling Codex from Claude Code, for reviews and task
  hand-offs on request.
- [steipete/CodexBar](https://github.com/steipete/CodexBar): shows Claude and
  Codex usage in the menu bar and on the command line.
- [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router):
  routes an agent's model requests to other models.
- [wr/quota-router](https://github.com/wr/quota-router),
  [contains-studio/fable-delegator](https://github.com/contains-studio/fable-delegator)
  and [surlymochan/swrm](https://github.com/surlymochan/swrm): other takes on
  quota-aware delegation between coding agents.

crossfeed's own angle: it decides per subagent call from task fit and a
pacing controller, refuses the call at the hook instead of advising, and
records outcomes so the rules can be checked.

## Contributing

```bash
make test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
