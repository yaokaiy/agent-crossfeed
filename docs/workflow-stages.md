# Workflow stages on Codex

A workflow stage can run on Codex instead of Claude and return its answer through `agent()`. Setup is in the [README](../README.md#quick-start); how crossfeed routes ordinary subagent calls is in [How it works](how-it-works.md).

## Mark a stage

Pass a task description and one stage block together as the `agent()` prompt. For example:

````markdown
Review the current git diff for regressions. Give a file and line for each finding.

```crossfeed-stage
{"v":1,"id":"review-diff","executor":"auto","kind":"review"}
```
````

`executor` defaults to `auto`. It can route to Codex when the Claude
window is short or when the routing policy would hand off the stage
(`task` is tier A and `review` and `research` are tier B). The default
`kind` is `review`. Include `schema` with the JSON Schema passed to
`agent()` for a structured answer. `executor: codex` requires `schema`
and fails if Codex cannot run the stage. Every Codex launch needs known
positive headroom and a Bash verdict of `allow`, or `ask` with
`approveStages` enabled. A `deny` always blocks the Codex launch.
Stages use your Codex permissions. A `task` runs with `--write` and may
edit the project in place. A stage using worktree isolation stays on the
ordinary Claude path with `auto`. An explicit Codex request for that stage
is refused. `review` and `research` are instructed to leave project files
alone. Leave stages that need Claude-only MCP tools, skills or agent
types unmarked.

## What a stage returns

A text stage returns the full answer, the result path, and edits reported
by Codex. A text `task` answer also includes the workspace comparison and
flags a HEAD change when detected. A structured `task` returns the schema
value through `agent()` and keeps the comparison in the job record. A read stage
with a reported edit gets a warning in its text answer or a toast for a
structured answer. How a schema reaches Codex and how a stage survives Claude Code's
silence timeout are in the [reference](reference.md#workflow-stage-internals).

## Fallback and failure

An `auto` stage can fall
back to Claude while the window has room if the dispatcher confirms Codex
never started and the step has emitted nothing. A rejected structured answer
fails the stage. If the directory, saved brief or permission verdict is
unavailable, `auto` uses ordinary Claude admission and an explicit Codex
request is refused.

## While stages run

While stages run on Codex, the `/workflows` panel shows each one as an
idle agent under its Claude model. crossfeed's status line counts active
stage dispatchers, including those waiting for a slot, and shows the
latest reported action among them or `started` if none has reported an
action.

Launch heavy workflows one at a time while hand-offs are on.
