import type { EngineInterface, HookFailure, Register, SessionRateLimit } from 'claude-code'
import { toConfig } from './config'
import { createCore } from './core'
import type { Core } from './core'
import type { ClaudeReading, CodexReading } from './policy'
import { shortProblem } from './policy'
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
      reading.sevenDay = { percentUsed: window.percentUsed }
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

export const register: Register = (on, options) => {
  let core: Core | undefined
  let script = ''
  let session: string | undefined
  // Track attempts separately from reading age: an unavailable or stale reading
  // must not trigger another subprocess on every call.
  let lastProbeAt = -Infinity

  on('session.start', async ($, e, next) => {
    script = $.plugin.root + '/scripts/crossfeed.py'
    const config = toConfig(options)
    session = await $.session.id()
    core = createCore(config, script, session)
    await $.command.register({ name: 'crossfeed', description: 'Show crossfeed status, report or change routing mode.', argumentHint: '[status|report|auto|always|off]' })
    const now = await clock($)
    lastProbeAt = -Infinity
    if (config.mode !== 'off') lastProbeAt = now
    const [quota, lockout] = await Promise.all([
      config.mode === 'off' ? Promise.resolve({ reading: undefined, problem: undefined }) : readCodex($, script, now),
      readLockout($, script),
    ])
    core.setCodex(quota.reading, quota.problem)
    core.setLockout(lockout)
    core.measure(claudeReading((await $.session.usage()).rateLimits), now)
    showStatus($, core, now)
    return next(e)
  }).catch(failOpen)

  on('session.measure', async ($, e, next) => {
    if (core) {
      const now = await clock($)
      core.measure(claudeReading(e.rateLimits), now)
      showStatus($, core, now)
    }
    return next(e)
  }).catch(failOpen)

  on('prompt.compose', async (_$, e, next) => {
    const result = await next(e)
    if (!script) return result
    return { sections: [...result.sections, { id: 'agent-crossfeed:policy', text: staticSection(script), scope: 'session' as const }] }
  }).catch(failOpen)

  on('prompt.submit', (_$, e, next) => {
    const notices = !e.isMeta && !e.command ? core?.userPrompt() ?? [] : []
    return next(notices.length ? { ...e, context: [...(e.context ?? []), ...notices] } : e)
  }).catch(failOpen)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!core) return next(e)
    const now = await clock($)
    if (core.needsCodex(e) && core.codexAge(now) > 5 * 60000 && Math.abs(now - lastProbeAt) > 5 * 60000) {
      lastProbeAt = now
      const quota = await readCodex($, script, now)
      core.setCodex(quota.reading, quota.problem)
    }
    // A measure event may not have fired yet in a session's first turn: take the reading at decision time.
    const latest = claudeReading((await $.session.usage()).rateLimits)
    core.measure(latest, now)
    const route = core.route(e, now)
    const stay = core.lastStay()
    // The decision may rest on readings newer than the ones the status line was drawn from.
    showStatus($, core, now)
    if (!route) {
      try { $.ui.log(core.lastDecision()) } catch { /* Logging must not block the call. */ }
      const ran = await next(e)
      if (ran.deny !== undefined && stay !== undefined) core.forgetStay(stay)
      return ran
    }
    const cwd = await $.session.cwd()
    const briefFile = await stashBrief($, script, e.prompt)
    const deny = core.denial(route, e, cwd, now, briefFile)
    try { $.ui.log(core.lastDecision()) } catch { /* Logging must not block the handoff. */ }
    return { deny }
  }).catch(failOpen)

  on('tool.call', async (_$, e, next) => {
    const ran = await next(e)
    // A refused call is not a hands-on step and must not use up the one reminder.
    if (ran.deny !== undefined || e.agentId !== undefined) return ran
    const note = core?.toolCall(String(e.tool), false)
    const notices = core?.takeNotices() ?? []
    if (note) notices.push(note)
    return notices.length ? { ...ran, context: [...(ran.context ?? []), ...notices] } : ran
  }).catch(failOpen)

  on('classic.StopFailure', async ($, e, next) => {
    const lockout = core?.stopFailure(e.error, await clock($))
    if (lockout) await $.process.run(['python3', '-I', script, 'lockout', '--reset-at', lockout.resetAt, ...(session === undefined ? [] : ['--session', session])])
    return next(e)
  }).catch(failOpen)

  on('command.run', { command: 'crossfeed' }, async ($, e, next) => {
    if (!core) return next(e)
    const args = e.args.trim()
    const now = await clock($)
    if (args === '' || args === 'status') return { text: core.describe(now) }
    if (args === 'report') return { text: (await $.process.run(['python3', '-I', script, 'report'])).stdout }
    if (args === 'auto' || args === 'always' || args === 'off') {
      core.setMode(args)
      showStatus($, core, now)
      return { text: `crossfeed mode: ${args} (this session)` }
    }
    return { text: 'usage: /crossfeed [status|report|auto|always|off]' }
  }).catch(failOpen)
}
