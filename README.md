<p align="center">
  <img src=".claude-plugin/icon.png" width="120" alt="agent-crossfeed icon: two fuel tanks joined by a crossfeed valve">
</p>

<h1 align="center">agent-crossfeed</h1>

<p align="center"><strong>Spend your Codex quota on subagent work before Claude's usage limit locks you out.</strong></p>

<p align="center">
  <a href="https://github.com/yaokaiy/agent-crossfeed/actions/workflows/ci.yml"><img src="https://github.com/yaokaiy/agent-crossfeed/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
</p>

When Claude's 5-hour window fills, you are locked out of Claude until it
resets. A model's weekly limit, such as Fable's, can run out days early. If
you also pay for Codex, that quota may be sitting unused at the same moment.
agent-crossfeed is a Claude Code plugin that hands suitable subagent work to
the Codex CLI while Codex has room, more of it as Claude's limits fill
faster. The aim is fewer and later lockouts.

- **Decides each subagent call from the main loop as it starts**, from what the brief asks
  for, how fast Claude's limits are filling and how much Codex quota is
  left.
- **Moves work off a scarce model.** While a model's weekly limit is ahead
  of an even pace, research and review that would use it can go to Codex,
  and subagents that only inherit it from your main loop can run on a
  cheaper Claude model.
- **Keeps you in one conversation.** A hand-off refuses the subagent call
  and gives Claude one command that runs the same brief on Codex; Claude is
  told to check what comes back.

Crossfeed makes the hand-off decision as each subagent starts, so you can keep working in the same conversation. [How it works](docs/how-it-works.md) explains the routing rules and what has been measured so far.

## Quick start

You need [Claude Code](https://code.claude.com/docs) 2.1.325 or later on a
subscription plan, the Codex CLI 0.167 or later (logged in with
`codex login`), Python 3.9 or later, and git. macOS and Linux are supported.

At the prompt of a Claude Code terminal session:

```
/plugin install agent-crossfeed --marketplace yaokaiy/agent-crossfeed
```

Or install from a shell with the command below. If you used the in-session command above, confirm the marketplace if prompted, choose an install scope, and follow any reload instruction in the installation summary.

```bash
claude plugin install agent-crossfeed --marketplace yaokaiy/agent-crossfeed
```

Make sure `codex exec` can edit files in the workspace; its default is
read-only. If you use a named Codex permissions profile, enable workspace
writes and any needed network access in that profile. Otherwise, set or
update the top-level `sandbox_mode = "workspace-write"` in
`~/.codex/config.toml`:

```toml
sandbox_mode = "workspace-write"
```

If you use the legacy `sandbox_mode = "workspace-write"` setting, enable
network access by setting `network_access = true` in the existing
`[sandbox_workspace_write]` table or creating that table once:

```toml
[sandbox_workspace_write]
network_access = true
```

Crossfeed uses your Codex configuration and passes no sandbox or approval
flags. It tells review jobs to leave project files alone and warns when
Codex reports a completed file edit. A line under the prompt shows what crossfeed
sees:

```
crossfeed auto · claude 5h 62% (pace 104%) · 7d 41% · codex wk 17% · pressure 0.4
```

Work as usual. When a subagent call should move, crossfeed refuses it and
tells Claude what to run instead. [Install notes](docs/reference.md#install-notes) cover permissions, where `codex` is looked
up, and removal.

## What a hand-off looks like

crossfeed refuses the subagent call and gives Claude one command to run
instead:

```
crossfeed: run this on Codex instead of a Claude subagent.
Why: tier A (has a check command and is implementation-type work). Claude 5h 62%, on pace for 104%; Codex weekly 17%.
The brief you just wrote is saved. Start this as a background Bash command:
python3 -I '.../scripts/crossfeed.py' run --tier A --kind subagent --dir '/your/repo' --write --brief-file '.../briefs/20260101-120000-ab12.md'
Add --write if the task must change files, drop it if not. Wait for the exit notification and do not poll. Check the result before you report it.
```

Claude is told to start the command in the background, where waiting costs
no model turns. When it exits, Claude Code notifies Claude, which reads its
output:

```
[crossfeed] job 20260101-120000-ab12 done in 1m32s; tier A; kind subagent; write; codex tokens 48210
[crossfeed] codex edits: calc.py, test_calc.py
[crossfeed] workspace changes during the run: calc.py, test_calc.py
[crossfeed] full result: .../jobs/20260101-120000-ab12/result.md
[crossfeed] record the outcome: python3 -I .../scripts/crossfeed.py check 20260101-120000-ab12 -- <your check command>
```

After a write job, Claude is told to run the brief's check through
`crossfeed.py check`, which records pass or fail, and then to report to you. After a read job
that succeeded, such as a review, it is told to verify the job's claims and
record through `crossfeed.py used` whether it used the result.

## Workflow stages

A workflow can send a stage to Codex and receive its answer through `agent()`. With routing enabled, `executor: codex` requires a schema and fails if the stage cannot run on Codex. See [Workflow stages](docs/workflow-stages.md) for the example, permission settings, and `auto` fallback rules.

## Commands and options

Use `/crossfeed status` to check routing, `/crossfeed report` for the past seven days, and `/crossfeed off` to pause steering for this session. See the [commands](docs/reference.md#commands) and [configuration options](docs/reference.md#options) for details.

## Safety and data

- crossfeed passes a brief to your Codex CLI and to nothing else, and
  Codex runs it under your Codex configuration.
- Crossfeed stores briefs, schemas, results, job state, event and error logs, quota readings, and its ledger locally. The dispatcher creates private files. See [Safety and data](docs/reference.md#safety-and-data) for storage locations and ledger contents.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Status and limits

Version 0.5.1 is an early release.

- Hand-offs aim to make lockouts rarer and later. A before and after count
  is not in yet (see [Measured so far](docs/how-it-works.md#measured-so-far)), and what the
  hand-offs themselves cost in Claude usage has not been measured.
- The tiers are keyword heuristics informed by published benchmarks and one
  practitioner's routing rules, not by your tasks. They will misfile some
  briefs. `/crossfeed report` shows check results per tier so you can see
  whether they hold for you.
- In a very heavy window only part of the usage can move, so a lockout can
  still happen.
- A Codex job starts with none of the conversation's context. Thin briefs
  give poor results.

The full list is in [How it works](docs/how-it-works.md#limits).

## Documentation

- [How it works](docs/how-it-works.md): why crossfeed exists, the routing
  rules, background-work protection, what has been measured, limits and the
  research behind it.
- [Workflow stages](docs/workflow-stages.md): running a workflow stage on
  Codex.
- [Reference](docs/reference.md): commands, options, the status line, the
  dispatcher script, install notes and the data crossfeed stores.
- [Design](docs/design.md): the exact rules, formulas and design decisions.
- [Changelog](CHANGELOG.md).

## Contributing

```bash
make test
```

[yaokaiy](https://github.com/yaokaiy) maintains agent-crossfeed. [Report a bug or an unexpected routing decision](https://github.com/yaokaiy/agent-crossfeed/issues/new/choose). For contributions, see the [contributing guide](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)

agent-crossfeed is an independent project, not affiliated with or endorsed
by Anthropic or OpenAI.
