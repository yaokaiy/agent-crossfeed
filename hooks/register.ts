import type { EngineInterface, HookFailure, Register, SessionRateLimit } from 'claude-code'
import type { Mode } from './config'
import { toConfig } from './config'
import { createCore } from './core'
import type { Core, DecisionRecord } from './core'
import type { AgentCall, ClaudeReading, CodexReading, UsageReading, Family } from './policy'
import { CODEX_MAX_AGE, familyOf, shortProblem } from './policy'
import { staticSection } from './text'

function logFailure($: EngineInterface, message: string): void {
  try { $.ui.log(`crossfeed: ${message}`) } catch { /* Logging must not block the event. */ }
}

function failOpen<E, R>($: EngineInterface, e: E, next: ((event: E) => Promise<R>) & { error: HookFailure; event: string }): Promise<R> {
  logFailure($, `${next.event}: ${next.error.message ?? next.error.kind}`)
  return next(e)
}

// A clock that returns no usable time would poison every age the plugin keeps: fail the event instead.
async function clock($: EngineInterface): Promise<number> {
  const now: unknown = await $.clock.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('the clock returned no usable time')
  return now
}

function showStatus($: EngineInterface, core: Core, now: number): void {
  try {
    void Promise.resolve($.ui.status(core.status(now))).catch(() => { /* The status line must not block the event. */ })
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

async function readCodex($: EngineInterface, script: string, now: number): Promise<{ reading?: CodexReading; problem?: string }> {
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
      if (reset !== null && reset !== undefined && (typeof reset !== 'number' || !Number.isFinite(reset * 1000))) return { problem: problem ?? 'quota probe returned an invalid reset time' }
      windows.push({ minutes: window.minutes, usedPercent: window.used_percent, resetsAt: typeof reset === 'number' ? reset * 1000 : undefined })
    }
    // An unknown age is not a fresh reading. A log stamped slightly ahead of this clock counts as now.
    const age = value.age_s
    if (typeof age !== 'number' || !Number.isFinite(age) || age < -300) return { problem: problem ?? 'quota probe returned an invalid age' }
    return { reading: { windows, limitReached: value.limit_reached, readAt: now - Math.max(0, age) * 1000 }, problem }
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
async function refreshReadings($: EngineInterface, core: Core, script: string, now: number, due: { codex: boolean; usage: boolean }): Promise<void> {
  await Promise.all([
    due.codex ? readCodex($, script, now).then(quota => core.setCodex(quota.reading, quota.problem)) : undefined,
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

function errorText(error: unknown): string {
  try { return String(error) } catch { return 'an error that cannot be shown' }
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

export const register: Register = (on, options) => {
  let core: Core | undefined
  let script = ''
  let session: string | undefined
  let conversationChanged = false
  // Track attempts separately from reading age: an unavailable or stale reading
  // must not trigger another subprocess on every call.
  let lastProbeAt = -Infinity
  let lastUsageProbeAt = -Infinity
  let mode: Mode = 'auto'
  // Readings of the session's usage and main model are applied in the order they were asked for:
  // a reply that arrives after a newer reading was applied is dropped, whichever hook asked. A
  // usage update's reading counts as asked for when its event came. Claude Code raises an update
  // whenever a window moves a whole point, so once the updates already raised are handled, the
  // reading held is at most under a point older than a dropped reply.
  let usageAsked = 0
  let usageApplied = 0
  let modelAsked = 0
  let modelApplied = 0

  function applyUsage(asked: number, reading: ClaudeReading, now: number): void {
    if (!core || asked <= usageApplied) return
    usageApplied = asked
    core.measure(reading, now)
  }

  // A failed model read (undefined) clears the model, as before, but does not count as applied,
  // so an earlier read that answers later still sets it.
  function applyModel(asked: number, model: string | undefined, now: number): void {
    if (!core || asked <= modelApplied) return
    if (model !== undefined) modelApplied = asked
    core.setMainModel(model, now)
  }

  function refreshConversation(id: string | undefined): void {
    session = id
    core?.newConversation(session)
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
    session = await $.session.id()
    core = createCore(config, script, session)
    conversationChanged = false
    await $.command.register({ name: 'crossfeed', description: 'Show crossfeed status, report or change routing mode.', argumentHint: '[status|report|auto|always|off]' })
    const now = await clock($)
    lastProbeAt = -Infinity
    lastUsageProbeAt = -Infinity
    if (config.mode !== 'off') { lastProbeAt = now; lastUsageProbeAt = now }
    const [quota, lockout, usage] = await Promise.all([
      config.mode === 'off' ? Promise.resolve({ reading: undefined, problem: undefined }) : readCodex($, script, now),
      readLockout($, script),
      config.mode === 'off' ? Promise.resolve({ reading: undefined, problem: undefined, at: undefined }) : readUsage($, script, false),
    ])
    core.setCodex(quota.reading, quota.problem)
    core.setLockout(lockout)
    const usageAsk = ++usageAsked
    applyUsage(usageAsk, claudeReading((await $.session.usage()).rateLimits), now)
    const modelAsk = ++modelAsked
    applyModel(modelAsk, await mainModel($), now)
    if (mode !== 'off') core.setUsage(usage.reading, usage.problem, usage.at ?? now)
    showStatus($, core, now)
    return next(e)
  }).catch(failOpen)

  on('session.end', async (_$, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') conversationChanged = true
    return next(e)
  }).catch(failOpen)

  on('session.measure', async ($, e, next) => {
    const usageAsk = ++usageAsked
    if (conversationChanged) refreshConversation(await sessionId($))
    if (core) {
      const now = await clock($)
      applyUsage(usageAsk, claudeReading(e.rateLimits), now)
      const modelAsk = ++modelAsked
      applyModel(modelAsk, await mainModel($), now)
      await refreshReadings($, core, script, now, { codex: needsCodex(now), usage: needsUsage(now) })
      showStatus($, core, now)
    }
    return next(e)
  }).catch(failOpen)

  on('prompt.compose', async (_$, e, next) => {
    const result = await next(e)
    if (!script) return result
    return { sections: [...result.sections, { id: 'agent-crossfeed:policy', text: staticSection(script), scope: 'session' as const }] }
  }).catch(failOpen)

  on('prompt.submit', async ($, e, next) => {
    if (conversationChanged) refreshConversation(await sessionId($))
    const notices = !e.isMeta && !e.command ? core?.userPrompt(await clock($)) ?? [] : []
    return next(notices.length ? { ...e, context: [...(e.context ?? []), ...notices] } : e)
  }).catch(failOpen)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (conversationChanged) refreshConversation(await sessionId($))
    if (!core) return next(e)
    const now = await clock($)
    // A model-limit reading that arrives during the probes is judged against the main model.
    const firstModelAsk = ++modelAsked
    applyModel(firstModelAsk, await mainModel($), now)
    await refreshReadings($, core, script, now, { codex: needsCodex(now, e), usage: needsUsage(now) })
    // Take the session's own readings at decision time: a measure event may not have fired
    // yet in a session's first turn, and the main model may have changed during the probes.
    const usageAsk = ++usageAsked
    applyUsage(usageAsk, claudeReading((await $.session.usage()).rateLimits), now)
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
    showStatus($, core, decidedAt)
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
    if (conversationChanged) refreshConversation(await sessionId($))
    const ran = await next(e)
    // A refused call is not a hands-on step and must not use up the one reminder.
    if (ran.deny !== undefined || e.agentId !== undefined) return ran
    let now: number
    try { now = await clock($) } catch { return ran }
    const note = core?.toolCall(String(e.tool), false, now)
    const notices = core?.takeNotices(now) ?? []
    if (note) notices.push(note)
    return notices.length ? { ...ran, context: [...(ran.context ?? []), ...notices] } : ran
  }).catch(failOpen)

  on('agent.spawn', async ($, e, next) => {
    const change = core?.spawnModel(e, await clock($))
    if (!change) return next(e)
    const ran = await next({ ...e, model: change.model })
    if (ran.deny !== undefined) return ran
    if (familyOf(ran.model) !== familyOf(change.model)) {
      logFailure($, `rewrite to ${change.model} not applied (ran on ${ran.model})`)
      return ran
    }
    logFailure($, `subagent ran on ${change.model} instead of ${change.from} (${change.bucket} weekly ${change.percent}%, ${change.percent >= 100 ? 'full' : 'ahead'})`)
    // Once next() has started the agent, ledger failures must never retry the spawn.
    try {
      const result = await $.process.run(['python3', '-I', script, 'downgrade', '--from', change.from, '--to', change.model, '--bucket', change.bucket, '--percent', String(change.percent), ...(session ? ['--session', session] : [])], { timeoutMs: 5000 })
      if (result.exitCode !== 0) logFailure($, `downgrade record exited with code ${result.exitCode}`)
    } catch (error) { logFailure($, `downgrade record failed: ${String(error)}`) }
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
      showStatus($, core, now)
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
      showStatus($, core, now)
      return { text: `crossfeed mode: ${args} (this session)` }
    }
    return { text: 'usage: /crossfeed [status|report|auto|always|off]' }
  }).catch(failOpen)
}
