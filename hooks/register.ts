import type { Caught, EngineInterface, HookFailure, Register, SessionRateLimit, StreamNext, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import type { BackgroundState } from '../types'
import type { Mode } from './config'
import { DEFAULTS, toConfig } from './config'
import { createCore } from './core'
import type { BackgroundRow, Core, DecisionRecord, Notice, Nudge, StageRoute, StopResult } from './core'
import type { AgentCall, ClaudeReading, CodexReading, UsageReading, Family, StageContract } from './policy'
import { ANSWER_FIELD_SCHEMA, CODEX_MAX_AGE, familyOf, shortProblem, stageAnswer, strictCompatible } from './policy'
import type { StageChanges } from './text'
import { readStageWarning, shellCommand, stageFailure, stageResult, staticSection } from './text'

const ROW_CAP = 500

type RowQueue = { rows: BackgroundRow[]; writing: boolean; dropped: number }
type StateWrites = Map<string, { value: BackgroundState; settled: Promise<void> }>
type BackgroundIO = { queue: RowQueue; writes: StateWrites; stops: Set<Promise<void>> }

function logFailure($: EngineInterface, message: string): void {
  try { $.ui.log(`crossfeed: ${message}`) } catch { /* Logging must not block the event. */ }
}

function failOpen<E, R>($: EngineInterface, e: E, next: ((event: E) => Promise<R>) & { error: HookFailure; event: string }): Promise<R> {
  logFailure($, `${next.event}: ${next.error.message ?? next.error.kind}`)
  return next(e)
}

export async function* failOpenStep(
  $: EngineInterface, e: TurnStepInput, next: StreamNext<'turn.step'> & Caught, active: Core | undefined,
  record: (row: BackgroundRow) => void,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  logFailure($, `${next.event}: ${next.error.message ?? next.error.kind}`)
  const route = active?.stages.get(e.agentId)
  if (next.called || !active || !route || e.agentId === undefined) return yield* next(e)
  if ('retry' in route) return yield* stageText(e, stageFailure(route.id, 'the stage already ran under another agent'), 0)
  if (active.stages.endRun(route)) await showStatus($, active)
  const previous = route.output
  const index = previous?.turnId === e.turnId && previous.step === e.index ? previous.block + 1 : 0
  return yield* failStageStep($, e, next, active, route, route.failure ?? 'stage hook failed', index, record)
}

// A clock that returns no usable time would poison every age the plugin keeps: fail the event instead.
async function clock($: EngineInterface): Promise<number> {
  const now: unknown = await $.clock.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('the clock returned no usable time')
  return now
}

async function showStatus($: EngineInterface, core: Core, now?: number): Promise<void> {
  try {
    await $.ui.status(core.status(now ?? await clock($)))
  } catch { /* The status line must not block the event. */ }
}

function claudeReading(rateLimits: readonly SessionRateLimit[]): ClaudeReading {
  const reading: ClaudeReading = {}
  for (const window of rateLimits) {
    if (!Number.isFinite(window.percentUsed)) continue
    if (window.kind === 'five_hour') {
      const reset = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt)
      reading.fiveHour = { percentUsed: window.percentUsed, resetsAt: reset !== undefined && Number.isFinite(reset) ? reset : undefined }
    } else if (window.kind === 'seven_day') {
      const reset = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt)
      reading.sevenDay = { percentUsed: window.percentUsed, resetsAt: reset !== undefined && Number.isFinite(reset) ? reset : undefined }
    }
  }
  return reading
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readCodex($: EngineInterface, script: string): Promise<{ reading?: CodexReading; problem?: string; at?: number }> {
  try {
    const result = await $.process.run(['python3', '-I', script, 'quota'], { timeoutMs: 15000 })
    if (result.exitCode !== 0) return { problem: shortProblem(`quota probe exited with code ${result.exitCode}`) }
    if (result.isStdoutTruncated) return { problem: 'quota probe output was truncated' }
    let value: unknown
    try { value = JSON.parse(result.stdout) } catch { return { problem: 'quota probe returned invalid JSON' } }
    const problem = isRecord(value) ? shortProblem(value.app_server_error) : undefined
    if (isRecord(value) && value.source === 'none') {
      return { problem: problem ?? shortProblem(value.error) ?? 'quota probe returned no reading' }
    }
    if (!isRecord(value) || (value.source !== 'app-server' && value.source !== 'log') ||
        value.error !== null || typeof value.limit_reached !== 'boolean' || !Array.isArray(value.windows)) return { problem: problem ?? 'quota probe returned invalid data' }
    const windows: CodexReading['windows'] = []
    for (const window of value.windows) {
      if (!isRecord(window) || typeof window.minutes !== 'number' || !Number.isFinite(window.minutes) || window.minutes <= 0 ||
          typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) return { problem: problem ?? 'quota probe returned an invalid window' }
      const reset = window.resets_at
      if (reset !== null && reset !== undefined && (typeof reset !== 'number' || !Number.isFinite(reset * 1000) || Math.abs(reset * 1000) > 8640000000000000)) return { problem: problem ?? 'quota probe returned an invalid reset time' }
      windows.push({ minutes: window.minutes, usedPercent: window.used_percent, resetsAt: typeof reset === 'number' ? reset * 1000 : undefined })
    }
    // An unknown age is not a fresh reading. A log stamped slightly ahead of this clock counts as now.
    const age = value.age_s
    if (typeof age !== 'number' || !Number.isFinite(age) || age < -300) return { problem: problem ?? 'quota probe returned an invalid age' }
    const at = await clock($)
    const readAt = at - Math.max(0, age) * 1000
    if (!Number.isFinite(readAt)) return { problem: problem ?? 'quota probe returned an invalid age' }
    return { reading: { windows, limitReached: value.limit_reached, readAt }, problem, at }
  } catch (error) {
    return { problem: shortProblem(`quota probe failed: ${String(error)}`) }
  }
}

// The reading's time is taken when the probe answers, less the age of its data, so of two
// overlapping probes the one whose data is newer also has the later time, whichever started
// first. `at` is that answer time, the clock to judge the reading by.
export async function readUsage($: EngineInterface, script: string, fresh: boolean): Promise<{ reading?: UsageReading; problem?: string; at?: number }> {
  try {
    const result = await $.process.run(['python3', '-I', script, 'claude-usage', ...(fresh ? ['--fresh'] : [])], { timeoutMs: 25000 })
    const now = await clock($)
    if (result.exitCode !== 0) return { problem: `usage probe exited with code ${result.exitCode}` }
    if (result.isStdoutTruncated) return { problem: 'usage probe output was truncated' }
    let value: unknown
    try { value = JSON.parse(result.stdout.replace(/^\uFEFF/, '')) } catch { return { problem: 'usage probe returned invalid JSON' } }
    if (!isRecord(value) || (value.source !== 'usage' && value.source !== 'none') || !Array.isArray(value.buckets)) return { problem: 'usage probe returned invalid data' }
    const age = value.age_s
    if (typeof age !== 'number' || !Number.isInteger(age) || age < -300 || !Number.isFinite(now - Math.max(0, age) * 1000)) return { problem: 'usage probe returned an invalid age' }
    if (value.source === 'none') {
      if (value.buckets.length !== 0 || typeof value.error !== 'string' || !shortProblem(value.error)) return { problem: 'usage probe returned invalid data' }
      return { problem: shortProblem(value.error) }
    }
    if (value.error !== null) return { problem: 'usage probe returned invalid data' }
    const buckets: UsageReading['buckets'] = []
    for (const bucket of value.buckets) {
      if (!isRecord(bucket) || typeof bucket.label !== 'string' || !bucket.label.trim() ||
          typeof bucket.used_percent !== 'number' || !Number.isFinite(bucket.used_percent) || bucket.used_percent < 0 ||
          (bucket.family !== null && bucket.family !== 'fable' && bucket.family !== 'opus' && bucket.family !== 'sonnet' && bucket.family !== 'haiku')) return { problem: 'usage probe returned an invalid bucket' }
      const reset = bucket.resets_at
      if (reset !== null && (typeof reset !== 'number' || !Number.isFinite(reset * 1000) || Math.abs(reset * 1000) > 8640000000000000)) return { problem: 'usage probe returned an invalid reset time' }
      buckets.push({ label: bucket.label, family: bucket.family === null ? undefined : bucket.family as Family, usedPercent: bucket.used_percent, resetsAt: reset === null ? undefined : (reset as number) * 1000 })
    }
    return { reading: { buckets, readAt: now - Math.max(0, age) * 1000 }, at: now }
  } catch (error) {
    return { problem: shortProblem(`usage probe failed: ${String(error)}`) }
  }
}

// Takes the readings that are due side by side and keeps each as soon as it arrives,
// so neither probe delays the other or the other's result.
type CodexProbe = { pending?: Promise<void> }

async function refreshReadings(
  $: EngineInterface, core: Core, script: string, now: number, due: { codex: boolean; usage: boolean }, probe: CodexProbe,
): Promise<void> {
  let pending: Promise<void> | undefined
  if (due.codex) {
    pending = readCodex($, script).then(quota => core.setCodex(quota.reading, quota.problem, quota.at ?? now)).finally(() => {
      if (probe.pending === pending) probe.pending = undefined
    })
    probe.pending = pending
  }
  await Promise.all([
    pending,
    due.usage ? readUsage($, script, false).then(usage => core.setUsage(usage.reading, usage.problem, usage.at ?? now)) : undefined,
  ])
}

// An unknown main model only means no model-limit steering, never a skipped reading.
async function mainModel($: EngineInterface): Promise<string | undefined> {
  try { return await $.session.model() } catch { return undefined }
}

async function sessionId($: EngineInterface): Promise<string | undefined> {
  try { return await $.session.id() } catch { return undefined }
}

async function readLockout($: EngineInterface, script: string): Promise<number | undefined> {
  try {
    const result = await $.process.run(['python3', '-I', script, 'lockout', '--last'], { timeoutMs: 5000 })
    if (result.exitCode !== 0 || result.isStdoutTruncated) return undefined
    const value: unknown = JSON.parse(result.stdout)
    if (!isRecord(value) || typeof value.reset_at !== 'string') return undefined
    const resetAt = Date.parse(value.reset_at)
    return Number.isFinite(resetAt) ? resetAt : undefined
  } catch { return undefined }
}

async function stashBrief($: EngineInterface, script: string, prompt: string): Promise<string | undefined> {
  try {
    const result = await $.process.run(['python3', '-I', script, 'stash'], { stdin: prompt, timeoutMs: 5000 })
    const path = result.stdout.trim()
    if (result.exitCode === 0 && !result.isStdoutTruncated && path.startsWith('/') && !path.includes('\0')) return path
  } catch (error) {
    logFailure($, `brief could not be saved: ${String(error)}`)
  }
  return undefined
}

async function prepareStage(
  $: EngineInterface, core: Core, script: string, stage: StageContract, tier: 'A' | 'B',
): Promise<{ argv: string[] } | { error: string }> {
  let cwd: string
  try {
    cwd = await $.session.cwd()
    if (!cwd.startsWith('/') || cwd.includes('\0')) return { error: 'could not determine the session directory' }
  } catch {
    return { error: 'could not determine the session directory' }
  }
  let schemaJson: string | undefined
  let strict = false
  if (stage.schema !== undefined) {
    try { schemaJson = JSON.stringify(stage.schema) }
    catch { return { error: 'could not encode the stage schema' } }
    try { strict = strictCompatible(stage.schema) }
    catch { /* An uncertain schema can still be sent in the brief. */ }
  }
  const prompt = schemaJson !== undefined && !strict
    ? `${stage.brief}\n\nSchema:\n${schemaJson}\n\nYour final message is a JSON object with one field, \`answer\`: a string holding the JSON value that satisfies this schema.`
    : stage.brief
  const brief = await stashBrief($, script, prompt)
  if (!brief) return { error: 'could not save the stage brief' }
  const schema = schemaJson === undefined ? undefined
    : await stashBrief($, script, strict ? schemaJson : JSON.stringify(ANSWER_FIELD_SCHEMA))
  if (schemaJson !== undefined && !schema) return { error: 'could not save the stage schema' }
  const argv = core.stageArgv(stage, tier, cwd, brief, schema)
  try {
    const check = await $.tool.check({ tool: 'Bash', input: { command: shellCommand(argv) } })
    if (check.decision === 'allow' || (check.decision === 'ask' && core.approveStages)) return { argv }
    if (check.decision === 'ask') {
      const prefix = shellCommand(argv.slice(0, 4))
      return { error: `Bash approval required. Enable approveStages in /plugin configure, or outside auto permission mode allow Bash(${prefix} *)` }
    }
    return { error: shortProblem(check.reason) ?? shortProblem(check.rule) ?? 'Bash permission denied' }
  } catch {
    return { error: 'could not check Bash permission for the stage command' }
  }
}

async function readStageResult($: EngineInterface, path: string, signal: AbortSignal): Promise<string> {
  // A single engine file read is capped at 4 MiB. Decode the complete UTF-8
  // buffer after reading ranges so a range boundary cannot split a character.
  const range = 4 * 1024 * 1024
  const { kind, size } = await $.fs.stat(path)
  if (kind !== 'file') throw new Error('stage result is not a file')
  signal.throwIfAborted()
  if (size <= range) return $.fs.read(path)
  const body = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += range) {
    signal.throwIfAborted()
    const length = Math.min(range, size - offset)
    const { base64 } = await $.fs.read(path, { as: 'bytes', offset, length })
    const bytes = atob(base64)
    if (bytes.length !== length) throw new Error('stage result changed while being read')
    for (let index = 0; index < bytes.length; index++) body[offset + index] = bytes.charCodeAt(index)
  }
  return new TextDecoder().decode(body)
}

type StageAnswer = { text: string } | { input: unknown; json: string } | { error: string }

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function stageChanges(value: unknown, write: boolean): StageChanges | undefined {
  if (!isRecord(value) || !stringList(value.codex_edited)) return undefined
  const codexEdited = value.codex_edited
  if (!write) return { codexEdited }
  if ((value.observed !== 'unavailable' && !stringList(value.observed)) || typeof value.head_moved !== 'boolean') return undefined
  return { codexEdited, workspace: { observed: value.observed, headMoved: value.head_moved } }
}

async function* executeStage(
  $: EngineInterface, route: StageRoute, signal: AbortSignal, onProgress: (progress: string) => Promise<void>,
): AsyncGenerator<TurnStepChunk, StageAnswer> {
  signal.throwIfAborted()
  const env = route.row.session === null ? undefined : { CLAUDE_CODE_SESSION_ID: route.row.session }
  const child = $.process.spawn({ argv: route.argv, env })
  let stdout = ''
  let stderrTail = ''
  let firstStderr = true
  const progressPrefix = 'crossfeed: progress '
  const maxProgressLineLength = progressPrefix.length + 2 * 200 + 1 // UTF-16 units plus a possible CR.
  const heartbeat = 'crossfeed: heartbeat'
  for await (const chunk of child) {
    if (chunk.stream === 'stdout') {
      stdout += chunk.text
      continue
    }
    const text = firstStderr ? chunk.text.replace(/^\uFEFF/, '') : chunk.text
    firstStderr = false
    const lines = (stderrTail + text).split('\n')
    // Chunks can split lines. Keep only a possible progress or heartbeat line or a
    // sentinel for a diagnostic that continues into the next chunk.
    const tail = lines.pop() ?? ''
    stderrTail = ((heartbeat + '\r').startsWith(tail) || progressPrefix.startsWith(tail) ||
      (tail.startsWith(progressPrefix) && tail.length <= maxProgressLineLength)) ? tail : '!'
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      const progress = line.startsWith(progressPrefix) ? line.slice(progressPrefix.length) : ''
      if (line !== heartbeat && !progress) continue
      await onProgress(progress)
      const text = progress ? `Codex: ${progress}\n` : 'Waiting for the Codex job.\n'
      yield { kind: 'thinking', index: 0, text }
    }
  }
  const { code, signal: killedBy } = await child.result
  signal.throwIfAborted()
  let value: unknown
  try { value = JSON.parse(stdout) } catch { /* Use the process status below when no JSON arrived. */ }
  if (isRecord(value) && value.status === 'not-started') {
    route.notStarted = true
    const reason = shortProblem(value.error)
    return { error: 'Codex job did not start' + (reason ? ': ' + reason : '') }
  }
  const write = route.kind === 'task'
  const changes = stageChanges(value, write)
  if (changes?.codexEdited.length && !write) {
    route.readEdits = changes.codexEdited
    if (route.schema !== undefined) {
      try { await $.ui.toast(`Stage ${route.id}: ${readStageWarning(route.readEdits)}`) } catch { /* Best effort. */ }
    }
  }
  if (code !== 0) {
    const status = isRecord(value) ? shortProblem(value.status) : undefined
    return { error: `Codex job ${status ?? 'failed'} (${killedBy ?? 'exit ' + code})` }
  }
  if (!changes || !isRecord(value) || value.status !== 'done' || value.exit !== 0 ||
      typeof value.result_path !== 'string' || !value.result_path.startsWith('/') || !value.result_path.endsWith('/result.md')) {
    return { error: 'invalid dispatcher response' }
  }
  const result = await readStageResult($, value.result_path, signal)
  if (route.schema === undefined) return { text: stageResult(result, value.result_path, changes) }
  const parsed = stageAnswer(result, route.schema)
  return 'error' in parsed ? { error: parsed.error } : { input: parsed.value, json: parsed.json }
}

async function* stageText(e: TurnStepInput, answer: string, blockIndex: number): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: blockIndex, text: answer }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
}

async function* failStageStep(
  $: EngineInterface, e: TurnStepInput, next: StreamNext<'turn.step'>, active: Core, route: StageRoute,
  reason: string, block: number, record: (row: BackgroundRow) => void,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  let fallback = false
  if (!next.signal.aborted) {
    try { fallback = active.stageMayFallback(route, await clock($)) }
    catch (error) { logFailure($, `stage fallback check failed: ${errorText(error)}`) }
  }
  const aborted = next.signal.aborted
  const row = active.stages.fail(e.agentId!, route, aborted ? 'aborted' : reason, !aborted && fallback)
  if (row) record(row)
  if (aborted) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  if (fallback) return yield* next(e)
  route.output = { turnId: e.turnId, step: e.index, block }
  const warning = route.schema === undefined && route.readEdits?.length ? '\n' + readStageWarning(route.readEdits) : ''
  return yield* stageText(e, stageFailure(route.id, reason) + warning, block)
}

function errorText(error: unknown): string {
  try { return String(error) } catch { return 'an error that cannot be shown' }
}

function queueRow($: EngineInterface, queue: RowQueue, script: string, row: BackgroundRow): void {
  queue.rows.push(row)
  if (queue.rows.length > ROW_CAP) {
    queue.rows.shift()
    queue.dropped += 1
  }
  if (!queue.writing) void drainRows($, queue, script)
}

async function drainRows($: EngineInterface, queue: RowQueue, script: string): Promise<void> {
  queue.writing = true
  try {
    while (queue.rows.length) {
      if (queue.dropped) {
        logFailure($, `record queue dropped ${queue.dropped} oldest rows`)
        queue.dropped = 0
      }
      const stdin = queue.rows.splice(0).map(row => JSON.stringify(row) + '\n').join('')
      try {
        const result = await $.process.run(['python3', '-I', script, 'record'], { stdin, timeoutMs: 5000 })
        if (result.exitCode !== 0) logFailure($, `record exited with code ${result.exitCode}`)
      } catch (error) { logFailure($, `record failed: ${errorText(error)}`) }
    }
  } finally {
    queue.writing = false
  }
}

async function loadBackground($: EngineInterface, writes: StateWrites, id: string | undefined): Promise<BackgroundState | undefined> {
  if (id === undefined) return undefined
  try {
    const ref = { plugin: 'agent-crossfeed', key: 'background', id } as const
    return writes.get(id)?.value ?? (await $.state.get(ref)).value
  } catch (error) {
    logFailure($, `background state read failed: ${errorText(error)}`)
    return undefined
  }
}

async function loadConversation($: EngineInterface, writes: StateWrites): Promise<[string | undefined, BackgroundState | undefined]> {
  const id = await sessionId($)
  return [id, await loadBackground($, writes, id)]
}

function saveBackground($: EngineInterface, writes: StateWrites, id: string | undefined, value: BackgroundState): void {
  if (id === undefined) return
  const last = writes.get(id)
  if (last?.value === value) return
  const settled = (last?.settled ?? Promise.resolve()).then(async () => {
    // A later snapshot includes this one's changes.
    if (writes.get(id)?.value !== value) return
    const ref = { plugin: 'agent-crossfeed', key: 'background', id } as const
    await $.state.set(ref, value)
  }).catch(error => logFailure($, `background state write failed: ${errorText(error)}`))
  writes.set(id, { value, settled })
}

function taskError(text: string): StopResult {
  if (/not running|already (?:ended|finished|completed|stopped)|(?:no|unknown) task|task[^\n]*not found/i.test(text)) {
    return { outcome: 'ended' }
  }
  return { outcome: 'error', reason: shortProblem(text) ?? 'TaskStop returned no confirmation' }
}

async function stopTask($: EngineInterface, id: string, enabled: () => boolean): Promise<StopResult | undefined> {
  try {
    const call = { tool: 'TaskStop', task_id: id } as const
    const check = await $.tool.check({ tool: call.tool, input: { task_id: id } })
    if (!enabled()) return undefined
    if (check.decision === 'deny') return { outcome: 'denied', reason: shortProblem(check.reason) ?? shortProblem(check.rule) }
    const ran = await $.tool.call(call)
    if (ran.deny !== undefined) return { outcome: 'denied', reason: shortProblem(ran.deny) }
    if (!ran.isError && ran.result?.task_id === id) return { outcome: 'stopped' }
    const message = isRecord(ran.result) ? shortProblem(ran.result.message) : undefined
    return taskError(ran.text ?? message ?? '')
  } catch (error) { return taskError(errorText(error)) }
}

function runBreaker(
  $: EngineInterface, io: BackgroundIO, core: Core, script: string, id: string | undefined, now: number, enabled: () => boolean,
): void {
  saveBackground($, io.writes, id, core.background.snapshot())
  for (const stop of core.beginStops(now)) {
    const pending = stopTask($, stop.task.id, enabled).then(result => {
      const before = core.background.snapshot()
      const row = core.background.finishStop(stop, result)
      const after = core.background.snapshot()
      if (after !== before) saveBackground($, io.writes, id, after)
      if (row) queueRow($, io.queue, script, row)
    }).catch(error => logFailure($, `breaker failed: ${errorText(error)}`))
    io.stops.add(pending)
    void pending.then(() => io.stops.delete(pending))
  }
}

async function submitWake(
  $: EngineInterface, io: BackgroundIO, core: Core, script: string, wake: { text: string; row: Extract<BackgroundRow, { type: 'wake' }> },
  current: () => boolean,
): Promise<void> {
  try {
    const result = await $.prompt.submit({ text: wake.text })
    if (result.drop === undefined) {
      queueRow($, io.queue, script, wake.row)
      return
    }
    logFailure($, 'wake prompt was dropped')
  } catch (error) { logFailure($, `wake prompt failed: ${errorText(error)}`) }
  if (!current()) return
  const toast = core.background.keepWakeNotice(wake.text)
  if (toast) $.ui.toast(wake.text)
  if (toast) queueRow($, io.queue, script, { ...wake.row, outcome: 'notice' })
}

async function deliverWakes($: EngineInterface, io: BackgroundIO, core: Core, script: string, current: () => boolean): Promise<void> {
  if (!current() || !core.background.hasWake()) return
  let surface = false
  try { surface = (await $.session.surfaces()).length > 0 } catch { /* Keep the notice when the surface is unavailable. */ }
  while (current()) {
    const wake = core.background.takeWake(surface)
    if (!wake) break
    if (wake.row.outcome === 'prompt') {
      void submitWake($, io, core, script, wake, current).catch(error => logFailure($, `wake failed: ${errorText(error)}`))
    } else {
      queueRow($, io.queue, script, wake.row)
      if (wake.toast) $.ui.toast(wake.text)
    }
  }
}

function scheduleWakes($: EngineInterface, io: BackgroundIO, core: Core, script: string, current: () => boolean): void {
  if (!current()) return
  core.background.releaseWakes()
  const deliver = () => deliverWakes($, io, core, script, current).catch(error => logFailure($, `wake failed: ${errorText(error)}`))
  void deliver()
  for (const pending of io.stops) void pending.then(deliver)
}

// Never throws: a failed record must not fail the hook, which would replay the call through failOpen.
async function recordDecision($: EngineInterface, script: string, record: DecisionRecord): Promise<void> {
  try {
    const result = await $.process.run(['python3', '-I', script, 'decision'], { stdin: JSON.stringify(record), timeoutMs: 5000 })
    if (result.exitCode !== 0) logFailure($, `decision record exited with code ${result.exitCode}`)
  } catch (error) {
    logFailure($, `decision record failed: ${errorText(error)}`)
  }
}

async function recordNudge($: EngineInterface, script: string, nudge: Nudge): Promise<void> {
  try {
    const result = await $.process.run(['python3', '-I', script, 'nudge'], { stdin: JSON.stringify(nudge), timeoutMs: 5000 })
    if (result.exitCode !== 0) logFailure($, `nudge record exited with code ${result.exitCode}`)
  } catch (error) {
    logFailure($, `nudge record failed: ${errorText(error)}`)
  }
}

async function noticeText($: EngineInterface, script: string, items: Notice[]): Promise<string[]> {
  for (const item of items) {
    if (item.nudge) await recordNudge($, script, item.nudge)
  }
  return items.map(item => item.text)
}

export const register: Register = (on, options) => {
  let core: Core | undefined
  const backgroundIO: BackgroundIO = { queue: { rows: [], writing: false, dropped: 0 }, writes: new Map(), stops: new Set() }
  let script = ''
  let session: string | undefined
  let conversationChanged = false
  let conversationVersion = 0
  // Track attempts separately from reading age: an unavailable or stale reading
  // must not trigger another subprocess on every call.
  let lastProbeAt = -Infinity
  let codexProbe: CodexProbe = {}
  let lastUsageProbeAt = -Infinity
  let mode: Mode = 'auto'
  let codexStopPercent = DEFAULTS.codexStopPercent
  // Readings of the session's usage and main model are applied in the order they were asked for:
  // a reply that arrives after a newer reading was applied is dropped, whichever hook asked. A
  // usage update's reading counts as asked for when its event came. Claude Code raises an update
  // whenever a window moves a whole point, so once the updates already raised are handled, the
  // reading held is at most under a point older than a dropped reply.
  let usageAsked = 0
  let usageApplied = 0
  let modelAsked = 0
  let modelApplied = 0

  function applyUsage(asked: number, reading: ClaudeReading, now: number): boolean {
    if (!core || asked <= usageApplied) return false
    usageApplied = asked
    core.measure(reading, now)
    return reading.fiveHour !== undefined
  }

  // A failed model read (undefined) clears the model, as before, but does not count as applied,
  // so an earlier read that answers later still sets it.
  function applyModel(asked: number, model: string | undefined, now: number): void {
    if (!core || asked <= modelApplied) return
    if (model !== undefined) modelApplied = asked
    core.setMainModel(model, now)
  }

  function refreshConversation(version: number, id: string | undefined, saved: BackgroundState | undefined): void {
    if (!conversationChanged || version !== conversationVersion) return
    session = id
    core?.newConversation(session, saved)
    conversationChanged = false
  }

  // A call that could be handed off wants a reading under 5 minutes old. A usage update re-reads
  // only a reading no call can use, so a stretch without such calls does not leave the status
  // line stale, and a failed read there never replaces a usable one.
  function needsCodex(now: number, call?: AgentCall): boolean {
    if (!core) return false
    const due = call === undefined
      ? mode !== 'off' && core.codexAge(now) > CODEX_MAX_AGE
      : core.needsCodex(call) && core.codexAge(now) > 5 * 60000
    if (!due || Math.abs(now - lastProbeAt) <= 5 * 60000) return false
    lastProbeAt = now
    return true
  }

  function needsUsage(now: number): boolean {
    if (!core || mode === 'off' || core.usageAge(now) <= 10 * 60000 || Math.abs(now - lastUsageProbeAt) <= 10 * 60000) return false
    lastUsageProbeAt = now
    return true
  }

  on('session.start', async ($, e, next) => {
    script = $.plugin.root + '/scripts/crossfeed.py'
    const config = toConfig(options)
    mode = config.mode
    codexStopPercent = config.codexStopPercent
    const version = ++conversationVersion
    session = await $.session.id()
    core = createCore(config, script, session, await loadBackground($, backgroundIO.writes, session))
    conversationChanged = false
    await $.command.register({ name: 'crossfeed', description: 'Show crossfeed status, report or change routing mode.', argumentHint: '[status|report|auto|always|off]' })
    const now = await clock($)
    lastProbeAt = -Infinity
    codexProbe = {}
    lastUsageProbeAt = -Infinity
    if (config.mode !== 'off') { lastProbeAt = now; lastUsageProbeAt = now }
    const [quota, lockout, usage] = await Promise.all([
      config.mode === 'off' ? Promise.resolve({ reading: undefined, problem: undefined, at: undefined }) : readCodex($, script),
      readLockout($, script),
      config.mode === 'off' ? Promise.resolve({ reading: undefined, problem: undefined, at: undefined }) : readUsage($, script, false),
    ])
    core.setCodex(quota.reading, quota.problem, quota.at ?? now)
    core.setLockout(lockout)
    const usageAsk = ++usageAsked
    const reading = claudeReading((await $.session.usage()).rateLimits)
    const observedAt = await clock($)
    if (applyUsage(usageAsk, reading, observedAt)) {
      runBreaker($, backgroundIO, core, script, session, observedAt, () => mode !== 'off' && version === conversationVersion)
    }
    const modelAsk = ++modelAsked
    applyModel(modelAsk, await mainModel($), now)
    if (mode !== 'off') core.setUsage(usage.reading, usage.problem, usage.at ?? now)
    await showStatus($, core, await clock($))
    return next(e)
  }).catch(failOpen)

  on('session.end', async (_$, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      conversationChanged = true
      conversationVersion += 1
    }
    return next(e)
  }).catch(failOpen)

  on('session.measure', async ($, e, next) => {
    const usageAsk = ++usageAsked
    const version = conversationVersion
    if (conversationChanged) refreshConversation(version, ...await loadConversation($, backgroundIO.writes))
    if (core && version === conversationVersion) {
      const now = await clock($)
      const current = () => mode !== 'off' && version === conversationVersion
      if (version !== conversationVersion) return next(e)
      if (applyUsage(usageAsk, claudeReading(e.rateLimits), now)) {
        runBreaker($, backgroundIO, core, script, session, now, current)
      }
      scheduleWakes($, backgroundIO, core, script, current)
      const modelAsk = ++modelAsked
      applyModel(modelAsk, await mainModel($), now)
      await refreshReadings($, core, script, now, { codex: needsCodex(now), usage: needsUsage(now) }, codexProbe)
      await showStatus($, core, await clock($))
    }
    return next(e)
  }).catch(failOpen)

  on('prompt.compose', async (_$, e, next) => {
    const result = await next(e)
    if (!script || mode === 'off') return result
    return { sections: [...result.sections, { id: 'agent-crossfeed:policy', text: staticSection(script, codexStopPercent), scope: 'session' as const }] }
  }).catch(failOpen)

  on('prompt.submit', async ($, e, next) => {
    const version = conversationVersion
    if (conversationChanged) refreshConversation(version, ...await loadConversation($, backgroundIO.writes))
    if (e.isMeta || e.command || !core) return next(e)
    const now = await clock($)
    if (version !== conversationVersion) return next(e)
    const notices = core.userPrompt(now)
    return next(notices.length ? { ...e, context: [...(e.context ?? []), ...await noticeText($, script, notices)] } : e)
  }).catch(failOpen)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const version = conversationVersion
    if (conversationChanged) refreshConversation(version, ...await loadConversation($, backgroundIO.writes))
    if (!core) return next(e)
    const now = await clock($)
    // A model-limit reading that arrives during the probes is judged against the main model.
    const firstModelAsk = ++modelAsked
    applyModel(firstModelAsk, await mainModel($), now)
    await refreshReadings($, core, script, now, { codex: needsCodex(now, e), usage: needsUsage(now) }, codexProbe)
    // Take the session's own readings at decision time: a measure event may not have fired
    // yet in a session's first turn, and the main model may have changed during the probes.
    const usageAsk = ++usageAsked
    const reading = claudeReading((await $.session.usage()).rateLimits)
    const observedAt = await clock($)
    if (version !== conversationVersion) return next(e)
    if (applyUsage(usageAsk, reading, observedAt)) {
      runBreaker($, backgroundIO, core, script, session, observedAt, () => mode !== 'off' && version === conversationVersion)
    }
    const modelAsk = ++modelAsked
    applyModel(modelAsk, await mainModel($), now)
    // Decide at the time the decision is made, with no wait in between: a call that waited on
    // its reads must not date itself before a later call that has already been decided.
    const decidedAt = await clock($)
    const route = core.route(e, decidedAt)
    // Read before any await: an overlapping call may decide in the meantime.
    const stay = core.lastStay()
    const record = core.lastRecord()
    const decision = core.lastDecision()
    // The decision may rest on readings newer than the ones the status line was drawn from.
    await showStatus($, core, decidedAt)
    if (!route) {
      try { $.ui.log(decision) } catch { /* Logging must not block the call. */ }
      // The record is written while the subagent starts, not before it.
      const written = record ? recordDecision($, script, record) : undefined
      try {
        const ran = await next(e)
        if (ran.deny !== undefined && stay !== undefined) core.forgetStay(stay)
        return ran
      } finally {
        await written
      }
    }
    const cwd = await $.session.cwd()
    const briefFile = await stashBrief($, script, e.prompt)
    const deny = core.denial(route, e, cwd, decidedAt, briefFile, record)
    try { $.ui.log(decision) } catch { /* Logging must not block the handoff. */ }
    if (record) await recordDecision($, script, { ...record, brief_file: briefFile ?? null })
    return { deny }
  }).catch(failOpen)

  on('tool.call', async ($, e, next) => {
    const version = conversationVersion
    if (conversationChanged) refreshConversation(version, ...await loadConversation($, backgroundIO.writes))
    const ran = await next(e)
    // A refused call is not a hands-on step and must not use up the one reminder.
    if (ran.deny !== undefined || version !== conversationVersion || !core) return ran
    try {
      const result = ran.result
      if (!ran.isError && isRecord(result) && result.status === 'async_launched') {
        if (e.tool === 'Workflow' && typeof result.taskId === 'string' && result.taskId) {
          core.background.registerTask({ id: result.taskId, runId: typeof result.runId === 'string' ? result.runId : undefined })
        } else if (e.tool === 'Agent' && typeof result.agentId === 'string' && result.agentId) {
          core.background.registerAgent(result.agentId)
        }
        saveBackground($, backgroundIO.writes, session, core.background.snapshot())
      }
      if (e.agentId !== undefined || (e.tool === 'TaskStop' && next.origin.plugin === 'agent-crossfeed')) return ran
      const now = await clock($)
      // A tool finishing after /clear has no counted step or notice in the new prompt.
      if (version !== conversationVersion) return ran
      const note = core.toolCall(String(e.tool), false, now)
      const notices = core.takeNotices(now)
      if (note) notices.push(note)
      return notices.length ? { ...ran, context: [...(ran.context ?? []), ...await noticeText($, script, notices)] } : ran
    } catch { return ran }
  }).catch(failOpen)

  on('agent.spawn', async ($, e, next) => {
    const version = conversationVersion
    const usageAsk = ++usageAsked
    if (conversationChanged) refreshConversation(version, ...await loadConversation($, backgroundIO.writes))
    if (!core) return next(e)
    const active = core
    const reading = mode === 'off' ? undefined : claudeReading((await $.session.usage()).rateLimits)
    let now = await clock($)
    if (version !== conversationVersion) return next(e)
    if (reading && applyUsage(usageAsk, reading, now)) {
      runBreaker($, backgroundIO, active, script, session, now, () => mode !== 'off' && version === conversationVersion)
    }
    const contract = active.stageContract(e)
    let prepared: Awaited<ReturnType<typeof prepareStage>> | undefined
    let stageDenial: string | undefined
    if (contract && 'error' in contract) stageDenial = contract.error
    if (contract && !('error' in contract)) {
      if (active.codexAge(now) > 5 * 60000) {
        if (codexProbe.pending) await codexProbe.pending
        else if (Math.abs(now - lastProbeAt) > 5 * 60000) {
          lastProbeAt = now
          await refreshReadings($, active, script, now, { codex: true, usage: false }, codexProbe)
        }
        now = await clock($)
      }
      const plan = active.stagePlan(contract, e, now)
      if (plan) {
        if ('error' in plan) stageDenial = stageFailure(contract.id, plan.error)
        else if (version === conversationVersion) {
          prepared = await prepareStage($, active, script, contract, plan.tier)
          now = await clock($)
          const currentPlan = active.stagePlan(contract, e, now)
          if (!currentPlan) prepared = undefined
          else if ('error' in currentPlan) stageDenial = stageFailure(contract.id, currentPlan.error)
          else if ('error' in prepared && contract.executor === 'codex') stageDenial = stageFailure(contract.id, prepared.error)
        }
      }
    }
    if (version !== conversationVersion) return next(e)
    const { row, deny, background } = active.admission(e, now)
    if (row && contract && !('error' in contract) && prepared && 'argv' in prepared && !stageDenial) {
      const route: StageRoute = { nonce: crypto.randomUUID(), id: contract.id, executor: contract.executor, kind: contract.kind,
        schema: contract.schema, argv: prepared.argv, row }
      const prompt = active.stages.issue(route, e.prompt)
      let ran
      try { ran = await next({ ...e, prompt }) }
      catch (error) {
        active.stages.revoke(route.nonce)
        throw error
      }
      try {
        if (ran.deny !== undefined || !ran.agentId) {
          if (active.stages.revoke(route.nonce)) {
            const outcome = active.stages.finish(route, ran.deny !== undefined ? 'refused' : 'unconfirmed')
            if (outcome) queueRow($, backgroundIO.queue, script, outcome)
          }
        } else if (version === conversationVersion) {
          active.stages.confirm(ran.agentId, route)
          active.background.started(e, ran.agentId, background)
          saveBackground($, backgroundIO.writes, session, active.background.snapshot())
        }
      } catch (error) { logFailure($, `stage spawn bookkeeping failed: ${errorText(error)}`) }
      return ran
    }
    if (row && stageDenial) {
      queueRow($, backgroundIO.queue, script, { ...row, outcome: 'refused' })
      return { deny: stageDenial }
    }
    if (deny) {
      if (row) queueRow($, backgroundIO.queue, script, { ...row, outcome: 'refused' })
      return { deny }
    }
    const id = session
    const change = active.spawnModel(e, now)
    const ran = await next(change ? { ...e, model: change.model } : e)
    // Once next() has started the agent, ledger failures must never retry the spawn.
    try {
      if (row) queueRow($, backgroundIO.queue, script, { ...row, outcome: ran.deny !== undefined ? 'refused' : ran.agentId ? 'started' : 'unconfirmed' })
      if (!ran.agentId) return ran
      if (version === conversationVersion) {
        active.background.started(e, ran.agentId, background)
        saveBackground($, backgroundIO.writes, id, active.background.snapshot())
      }
      if (!change) return ran
      if (familyOf(ran.model) !== familyOf(change.model)) {
        logFailure($, `rewrite to ${change.model} not applied (ran on ${ran.model})`)
        return ran
      }
      logFailure($, `subagent ran on ${change.model} instead of ${change.from} (${change.bucket} weekly ${change.percent}%, ${change.percent >= 100 ? 'full' : 'ahead'})`)
      const result = await $.process.run(['python3', '-I', script, 'downgrade', '--from', change.from, '--to', change.model, '--bucket', change.bucket, '--percent', String(change.percent), ...(id ? ['--session', id] : [])], { timeoutMs: 5000 })
      if (result.exitCode !== 0) logFailure($, `downgrade record exited with code ${result.exitCode}`)
    } catch (error) { logFailure($, `${change ? 'downgrade record' : 'spawn bookkeeping'} failed: ${errorText(error)}`) }
    return ran
  }).catch(failOpen)

  on('vcs.isolate', async (_$, e, next) => {
    if (e.for === 'agent' && e.agentId !== undefined) core?.stages.isolate(e.agentId)
    return next(e)
  }).catch(failOpen)

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const version = conversationVersion
      if (conversationChanged) refreshConversation(version, ...await loadConversation($, backgroundIO.writes))
      if (version === conversationVersion) core?.background.startTurn(e.turnId)
    } else {
      core?.stages.bind(e.agentId, e.text)
    }
    return next(e)
  }).catch(failOpen)

  on('turn.step', async function* ($, e, next) {
    const active = core
    const route = active?.stages.get(e.agentId)
    if (!active || !route || e.agentId === undefined) return yield* next(e)
    if ('retry' in route) return yield* stageText(e, stageFailure(route.id, 'the stage already ran under another agent'), 0)
    const { turnId, index, agentId } = e
    const { signal } = next
    const record = (row: BackgroundRow) => queueRow($, backgroundIO.queue, script, row)
    // Some engine builds only put the worktree information on vcs.isolate.
    if (active.stages.isIsolated(agentId)) {
      const deny = active.isolatedStageDenial(route, await clock($))
      if (deny) return yield* failStageStep($, e, next, active, route, deny, 0, record)
      const row = active.stages.stay(agentId, route)
      if (row) record(row)
      return yield* next(e)
    }
    let blockIndex = 0
    let answer: StageAnswer
    if (route.failure !== undefined) answer = { error: route.failure }
    else if (route.toolSent) answer = { error: 'StructuredOutput was rejected' }
    else if (route.answer !== undefined) answer = { text: route.answer }
    else {
      try {
        signal.throwIfAborted()
        if (!active.stages.start(agentId, route)) {
          return yield* stageText(e, stageFailure(route.id, 'the stage dispatcher is already running'), 0)
        }
        try {
          await showStatus($, active)
          answer = yield* executeStage($, route, signal, async progress => {
            blockIndex = 1
            route.output = { turnId, step: index, block: 0 }
            if (progress && active.stages.progress(route, progress)) await showStatus($, active)
          })
        } finally {
          if (active.stages.endRun(route)) await showStatus($, active)
        }
      }
      catch (error) {
        if (!signal.aborted) logFailure($, `stage dispatch failed: ${errorText(error)}`)
        answer = { error: 'stage dispatch failed' }
      }
    }
    if (signal.aborted || 'error' in answer) {
      return yield* failStageStep($, e, next, active, route, 'error' in answer ? answer.error : 'aborted', blockIndex, record)
    }
    route.output = { turnId, step: index, block: blockIndex }
    if ('input' in answer) {
      const tool = { id: 'toolu_crossfeed_' + route.nonce.replace(/-/g, ''), name: 'StructuredOutput', input: answer.input }
      route.toolSent = true
      yield { kind: 'tool', index: blockIndex, id: tool.id, name: tool.name }
      yield { kind: 'input', index: blockIndex, json: answer.json }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId, index, answer: '', toolUses: [tool], stopReason: 'tool_use', usage: null }
    }
    route.answer = answer.text
    return yield* stageText(e, answer.text, blockIndex)
  }).catch(async function* ($, e, next) {
    return yield* failOpenStep($, e, next, core, row => queueRow($, backgroundIO.queue, script, row))
  })

  on('turn.complete', async ($, e, next) => {
    const version = conversationVersion
    const ran = await next(e)
    if (e.agentId !== undefined && core) {
      try {
        const active = core
        const route = active.stages.get(e.agentId)
        // The canceled step's own status call can fail after its signal aborts.
        const refresh = route && !('retry' in route) && (active.stages.endRun(route) || e.isAborted || e.reason === 'aborted')
        const row = active.stages.complete(e.agentId, e.reason === 'answer' && !e.isAborted)
        if (row) queueRow($, backgroundIO.queue, script, row)
        if (refresh) await showStatus($, active)
      } catch (error) { logFailure($, `stage completion bookkeeping failed: ${errorText(error)}`) }
    }
    if (e.agentId === undefined && core && version === conversationVersion) {
      try {
        core.background.completeTurn(e.turnId)
        scheduleWakes($, backgroundIO, core, script, () => mode !== 'off' && !conversationChanged && version === conversationVersion)
      } catch (error) { logFailure($, `wake scheduling failed: ${errorText(error)}`) }
    }
    return ran
  }).catch(failOpen)

  on('classic.StopFailure', async ($, e, next) => {
    const now = await clock($)
    const lockout = core?.stopFailure(e.error, now)
    if (lockout) {
      try { await $.process.run(['python3', '-I', script, 'lockout', '--reset-at', lockout.resetAt, ...(session === undefined ? [] : ['--session', session])]) }
      catch (error) { logFailure($, `lockout record failed: ${String(error)}`) }
    }
    if (core && mode !== 'off' && e.error === 'rate_limit') {
      const modelAsk = ++modelAsked
      applyModel(modelAsk, await mainModel($), now)
      lastUsageProbeAt = now
      const usage = await readUsage($, script, true)
      core.setUsage(usage.reading, usage.problem, usage.at ?? now)
      const bucket = core.bucketLockout(now)
      if (bucket) await $.process.run(['python3', '-I', script, 'lockout', '--reset-at', bucket.resetAt, '--bucket', bucket.bucket, ...(session ? ['--session', session] : [])])
      await showStatus($, core, now)
    }
    return next(e)
  }).catch(failOpen)

  on('command.run', { command: 'crossfeed' }, async ($, e, next) => {
    if (!core) return next(e)
    const args = e.args.trim()
    const now = await clock($)
    if (args === '' || args === 'status') return { text: core.describe(now) }
    if (args === 'report') return { text: (await $.process.run(['python3', '-I', script, 'report'])).stdout }
    if (args === 'auto' || args === 'always' || args === 'off') {
      mode = args
      core.setMode(args)
      await showStatus($, core, now)
      return { text: `crossfeed mode: ${args} (this session)` }
    }
    return { text: 'usage: /crossfeed [status|report|auto|always|off]' }
  }).catch(failOpen)
}
