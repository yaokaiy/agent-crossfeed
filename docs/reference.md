# Reference

Setup and everyday use are in the [README](../README.md). This page covers the commands, the options, the status line, workflow stage internals, the dispatcher script, install details and what crossfeed stores.

## Commands

| Command | Effect |
| --- | --- |
| `/crossfeed` or `/crossfeed status` | Claude's all-models pace and state, Codex surplus and headroom, pressure, current main-loop hand-off reasons, the 5-hour short-window state, tier decisions and the last subagent decision |
| `/crossfeed report` | Summarizes the past seven days of lockouts, locked time and unknown resets, model downgrades, routing decisions, jobs by cause, model and outcome, median job duration, Codex tokens, stopped launches, notices and reminders, first checks by tier, unchecked jobs, and read-result ratings. It also shows agent starts by origin and outcome, breaker outcomes, and wake-ups by trigger. Those three sections appear as unavailable until the ledger has recorded a valid event of one of those kinds. |
| `/crossfeed always` | this session, hand off eligible tier A and B calls with positive Codex headroom and either a Claude 5-hour reading or an ahead or full limit for the call's model family |
| `/crossfeed auto` | back to the default (this session) |
| `/crossfeed off` | stop steering, keep the record (this session) |

## Options

Set them with `/plugin configure agent-crossfeed@agent-crossfeed`.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | auto routes on both quotas; always hands off every eligible tier A and B call while Codex has headroom and Claude's 5-hour usage is known (or the call's model limit is ahead or full); off stops steering. |
| `effort` | `high` | Codex reasoning effort for subagent hand-offs and workflow stages. |
| `model` | empty | Codex model for subagent hand-offs and workflow stages. Leave empty to use the judgment model for eligible reviews, research and tier B subagent jobs when available, or the Codex default otherwise. |
| `premiumFallback` | `opus` | Model for subagents moved off a model whose weekly limit is ahead of pace. Leave empty to turn this off. |
| `eligibleTypes` | `general-purpose,claude` | Comma-separated subagent types whose briefs can be handed to Codex. |
| `stretchCalls` | `12` | Counted hands-on main-loop tool calls in one prompt before the one hand-off reminder, sent while hand-offs are on. |
| `codexStopPercent` | `85` | Stop handing off new work when a long Codex quota window reaches this percentage at its start. The stop rises in step with the time elapsed to 100 at the reset. Use a value greater than 0 and at most 100. |
| `shedPercent` | `85` | Refuse new background Claude agents and try to stop this conversation's registered background tasks when the 5-hour window reaches this percentage. Use a value greater than 0 and at most 100. |
| `wake` | `true` | Allow one wake-up prompt per 5-hour window for an idle coordinator with an attached surface. Reloading the plugin or resuming the conversation resets the allowance. Set to false to queue the message for Claude's next eligible main-loop tool result or ordinary prompt. |
| `approveStages` | `false` | Let crossfeed start Codex with your Codex permissions for marked stages when Claude Code would ask. Explicit denials still apply. |
| `timeoutMinutes` | `30` | Codex execution time limit in minutes for subagent hand-offs and workflow stages. |

## Workflow stage internals

How to mark a stage and what it returns are in [Workflow stages](workflow-stages.md).

Crossfeed passes a schema to Codex unchanged if it
meets the strict requirements, including required properties, closed
objects, and limits on nesting and size. Any other schema goes into the
brief, and Codex answers under a fixed strict schema with one string
field, `answer`, that holds the JSON value. Either way crossfeed sends the
value unchanged for Claude Code to validate against the workflow's schema.

A heartbeat every minute prevents
Claude Code's 10-minute silence timeout, and each route launches at most
one Codex job even if the engine retries it.

## Status line

When Codex's quota cannot be read the status line says `codex unavailable`,
and a reading older than 15 minutes is marked `stale`. Nothing is handed
off in either state. A model limit appears in the status line, as
`fable wk 62% ahead` for example, when your main loop runs on that model or
the limit is ahead or used up. `7d 79% ahead` marks an all-models week
ahead or full. In `codex wk 40% +38`, 40% is usage and 38 is the active
surplus in whole percentage points.

## The dispatcher

`scripts/crossfeed.py` works without the plugin. Write the task into a file,
here `brief.md`, and use the job id that `run` prints:

```bash
python3 -I scripts/crossfeed.py run --tier A --dir "$PWD" --write < brief.md
python3 -I scripts/crossfeed.py check 20260101-120000-ab12 -- pytest -q
python3 -I scripts/crossfeed.py run --kind review --artifact draft-v1 --dir "$PWD" < review.md
python3 -I scripts/crossfeed.py used 20260101-120500-cd34 partly
python3 -I scripts/crossfeed.py receipt draft-v1 --path draft.md --json
python3 -I scripts/crossfeed.py quota
python3 -I scripts/crossfeed.py report
```

`run` tells Codex to keep changes inside the workspace, permits reads of
paths named in the brief, and forbids pushing, committing, posting, or
printing secrets. Ordinary runs request an answer of at most 40 lines.
`run --json` asks Codex to use the brief's answer format. The command
saves the full result in `result.md` and returns a capped preview.
Every job reports `codex_edited` from Codex's completed file-change
events. Read jobs take no workspace snapshot. Their edit warning uses
those events, which do not cover edits made through shell commands.
Write jobs also report `observed` and `head_moved` from Git snapshots.
The comparison can include other agents' changes. It is unavailable
for managed worktrees, directories outside Git, or failed snapshots.
A failed snapshot leaves the job outcome intact. `--brief-file PATH` reads the
brief from a file instead of standard input, and `stash` saves standard
input to such a file and prints its path; the plugin uses the pair. Without
`--session`, `run` records the session from `CLAUDE_CODE_SESSION_ID`, which
Claude Code sets in the shells it starts.

Fresh and resumed jobs use your Codex configuration. `--write` tells Codex
to make changes within the workspace and run the check in the brief.
A read job can use temporary files and is told to leave project files
alone. A resume keeps the original job's role. Every job, including a resume,
lets Codex use `CLAUDE.md` as a fallback for project instructions.

A fresh job uses an explicit nonempty `--model` first. Otherwise
`--kind review`, `--kind research` and `--kind subagent --tier B` select
`gpt-6.2-astra` when Codex lists it in its local model cache.
`CROSSFEED_JUDGMENT_MODEL` selects a different listed model, and an empty
value disables the choice. If the judgment model is absent or the cache
cannot be read, crossfeed uses Codex's own default. Other kinds of work,
including `task` (the default kind), also use that default unless you
supply `--model`. `run --resume <job>` keeps the prior model selection.

- `--artifact ID` labels jobs for the same draft or other artifact. Use
  1 to 64 ASCII letters, digits, dots, underscores or hyphens. `run`
  prints the round, one more than the number of earlier successful jobs
  with the same label and kind. A resume inherits the label if present.
  You can repeat the selected job’s label or choose a label if that job has none.
  Use `--kind review` again when the resumed job is a review.
- `--role-file PATH` puts a UTF-8 Markdown role between the preamble and
  the brief. It accepts an optional BOM and strips opening YAML
  frontmatter delimited by `---` lines, so you can use a file from
  `~/.claude/agents/`. The file must be at most 64 KiB and contain a
  nonempty body. `brief.md` stores the brief alone. Use the flag on the
  first turn of a thread.
- `--output-schema PATH` passes a JSON object from a file to Codex as its
  output schema. Codex writes the structured final message to `result.md`.
  The flag works on fresh jobs and resumes with Codex CLI 0.170.0. Supply
  it on each turn that needs the schema.

`receipt ID` looks up the latest successful `review` for an artifact.
Use `--kind KIND` to select a different kind or `--kind any` to look across
all kinds. The receipt includes the job ID, kind, round, timestamps, model,
latest `used` rating, completed rounds for that kind, and paths to
`brief.md` and `result.md`. The receipt takes its verdict from a string
`verdict` in a JSON object in `result.md`. Run the review with
`--output-schema` to produce that result. If `result.md` lacks a JSON object with a string `verdict`, the receipt prints `none` in text output and `null` in JSON output.
Pass `--path PATH` for each file whose modification time you want checked.
A directory argument checks only the directory’s own modification time.
`--json` prints one object with `stale` and `stale_paths` alongside the
job details. Receipt exit codes are 0 for
a match with no stale paths, 1 for no match, 2 for bad input such as a
missing or empty path, and 3 for a match with stale paths.

Jobs Claude starts itself use `run`'s defaults of `--effort high` and
`--timeout 30` unless the command specifies other values. The timeout
covers Codex execution after the quota check.

`run --slots N` waits in the dispatcher for one of N exclusive locks
before checking quota. The lock files `slot-1` through `slot-N` are in
`slots/` under the crossfeed data directory. Workflow stages use
`--slots 8`, shared by dispatchers with the same data directory. A slot
is released when its dispatcher exits.
`run --json` uses stderr for heartbeat and progress records when enabled
with `--heartbeat SECONDS`. If Codex never started, stdout carries the
reason in the JSON response. An interrupted JSON job records its thread
ID if Codex reported it, even during the final workspace snapshot.

Before starting or resuming a job, `run` checks Codex's quota. A window
of 6 hours or less stops the launch at 90%. A longer window stops it at
`--codex-stop PERCENT` (default 85, greater than 0 and at most 100) when
the window starts, rising with the time elapsed to 100% at its reset.
The plugin includes the flag in its commands for a nondefault stop.
A window counts until its reset. Without a reset it counts only on a
reading at most 15 minutes old. A reported limit also stops the launch on
a reading that fresh with a counted window. With no reading, or one dated
more than 5 minutes ahead, `run` reports unknown quota and proceeds.

Exit codes of `run`: 0 done, 1 failed, 2 usage error, 75 the launch guard
stopped the job or Codex reported its limit, 124 timeout, 127 Codex not
found, 130 for an interrupt handled during an allocated job. A timeout
or a handled interrupt stops the Codex process group if it started.
With `run --json`, a handled interrupt writes the job's end row before
stopping that group. The ordinary text command collects final accounting
before writing its end row. An interrupt before job allocation can end
`run` without a job record.

`check` runs your check command and records pass or fail for the job. The
verdict comes from the command's exit status, not from the model. `used`
records whether the result of a successful job was used: `yes`, `partly` or
`no`. That one is the model's own rating, and a later rating replaces an
earlier one. `decision` is how the plugin records a routing decision, as
JSON on standard input. The plugin uses `nudge` to record delivered
`balance-on`, `balance-off` and `stretch` notices. A refused launch writes
a `stop` line with its reason before a job directory is created.

`report` counts fresh jobs handed off because of a model limit, the
account week or Codex surplus. Its “jobs by model” line includes resumes
and groups jobs without a recorded model name under “Codex default.”
For example, the report test fixture produces these lines:

```
jobs handed off because of: model limit 1, account week 1, Codex surplus 1
jobs by model: Codex default 10, custom 2, gpt-6.2-astra 2
launches stopped at the Codex stop: 1
nudges: balance on 1, balance off 1, stretch 2
```

## Install notes

crossfeed uses Claude Code's function-hook plugin API, which is early access
and may change.

It looks for `codex` in `$CROSSFEED_CODEX` when that is set and not empty,
then on `PATH`, then in the usual install directories listed in
[the design](design.md#the-dispatcher). If your Codex is somewhere
else and Claude Code runs with a `PATH` that lacks it, set `CROSSFEED_CODEX`
to the executable's path.

Claude Code asks you to approve the dispatcher command when Claude runs it
for a hand-off, as it does for any shell command. For ordinary hand-offs,
you can allow the dispatcher's `run` command using the script path shown
in the refusal:

```json
{
  "permissions": {
    "allow": ["Bash(python3 -I '/path/to/agent-crossfeed/scripts/crossfeed.py' run *)"]
  }
}
```

Workflow stages check Bash permission before launch. In Claude Code's auto
permission mode, a matching allow rule can still return `ask`. Enable
`approveStages` if you want crossfeed to launch marked stages on that
verdict.

Do not allow `check` the same way: it runs whatever command you give it.

To try the plugin from a clone for one session:

```bash
claude --plugin-dir /path/to/agent-crossfeed
```

To remove it: `claude plugin uninstall agent-crossfeed@agent-crossfeed`.

## Safety and data

- If a hook of the plugin throws before it handles a call, the original
  event continues. An Agent hand-off can send a brief on standard input
  when saving it fails. Workflow stages require saved inputs and either
  an `allow` verdict or `ask` with `approveStages` enabled.
- Codex configuration controls permissions for every job. Crossfeed
  instructs read jobs to leave project files alone and reports any
  edits it detects.
- crossfeed passes a brief to your Codex CLI and to nothing else. Codex then
  handles it as your Codex configuration says.
- What crossfeed stores stays on your machine, in `$CROSSFEED_HOME`, else
  `$CLAUDE_CONFIG_DIR/crossfeed`, else `~/.claude/crossfeed`: a ledger with
  a line for each subagent routing decision it could record outside `off`
  mode (the call's type and model, the first 100 characters of its
  description and the brief's length, not the brief), finished job, check,
  rating, lockout, nudge, stopped launch, agent start, breaker outcome and wake-up, the saved
  briefs and any workflow stage schemas saved with them, each job's brief,
  event log (`events.jsonl`), error log (`stderr.log`), state
  (`state.json`) and result (`result.md`), a cache of Claude usage readings
  (`claude-usage.json`) and the slot lock files (`slots/`). The dispatcher
  creates its files so only you can
  read them. A check is recorded by program name,
  without its arguments. Claude Code separately stores registered task IDs,
  agent lineage and the breaker cutoff in this conversation's plugin state.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).
