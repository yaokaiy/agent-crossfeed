import type { EngineInterface, HookFailure, Register, SessionRateLimit } from 'claude-code'
import { toConfig } from './config'
import { createCore } from './core'
import type { Core } from './core'
import type { ClaudeReading, CodexReading } from './policy'
import { staticSection } from './text'

function logFailure($: EngineInterface, message: string): void {
  try { $.ui.log(`crossfeed: ${message}`) } catch { /* Logging must not block the event. */ }
}

function failOpen<E, R>($: EngineInterface, e: E, next: ((event: E) => Promise<R>) & { error: HookFailure; event: string }): Promise<R> {
  logFailure($, `${next.event}: ${next.error.message ?? next.error.kind}`)
  return next(e)
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

async function readCodex($: EngineInterface, script: string, now: number): Promise<CodexReading | undefined> {
  try {
    const result = await $.process.run(['python3', '-I', script, 'quota'], { timeoutMs: 15000 })
    if (result.exitCode !== 0 || result.isStdoutTruncated) return undefined
    const value: unknown = JSON.parse(result.stdout)
    if (!isRecord(value) || (value.source !== 'app-server' && value.source !== 'log') ||
        value.error !== null || typeof value.limit_reached !== 'boolean' || !Array.isArray(value.windows)) return undefined
    const windows: CodexReading['windows'] = []
    for (const window of value.windows) {
      if (!isRecord(window) || typeof window.minutes !== 'number' || !Number.isFinite(window.minutes) || window.minutes <= 0 ||
          typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) return undefined
      const reset = window.resets_at
      if (reset !== null && reset !== undefined && (typeof reset !== 'number' || !Number.isFinite(reset * 1000))) return undefined
      windows.push({ minutes: window.minutes, usedPercent: window.used_percent, resetsAt: typeof reset === 'number' ? reset * 1000 : undefined })
    }
    const ageMs = typeof value.age_s === 'number' && Number.isFinite(value.age_s) && value.age_s > 0 ? value.age_s * 1000 : 0
    return { windows, limitReached: value.limit_reached, readAt: now - ageMs }
  } catch (error) {
    logFailure($, `quota unavailable: ${String(error)}`)
    return undefined
  }
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
  // Track attempts separately from reading age: an unavailable or stale reading
  // must not trigger another subprocess on every call.
  let lastProbeAt = -Infinity

  on('session.start', async ($, e, next) => {
    script = $.plugin.root + '/scripts/crossfeed.py'
    const config = toConfig(options)
    core = createCore(config, script, await $.session.id())
    await $.command.register({ name: 'crossfeed', description: 'Show crossfeed status, report or change routing mode.', argumentHint: '[status|report|auto|always|off]' })
    const now = await $.clock.now()
    lastProbeAt = -Infinity
    if (config.mode !== 'off') {
      lastProbeAt = now
      core.setCodex(await readCodex($, script, now))
    }
    core.measure(claudeReading((await $.session.usage()).rateLimits), now)
    $.ui.status(core.status(now))
    return next(e)
  }).catch(failOpen)

  on('session.measure', async ($, e, next) => {
    if (core) {
      const now = await $.clock.now()
      core.measure(claudeReading(e.rateLimits), now)
      $.ui.status(core.status(now))
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
    const now = await $.clock.now()
    if (core.needsCodex(e) && core.codexAge(now) > 5 * 60000 && now - lastProbeAt > 5 * 60000) {
      lastProbeAt = now
      core.setCodex(await readCodex($, script, now))
    }
    // A measure event may not have fired yet in a session's first turn: take the reading at decision time.
    const latest = claudeReading((await $.session.usage()).rateLimits)
    core.measure(latest, now)
    const route = core.route(e, now)
    if (!route) {
      try { $.ui.log(core.lastDecision()) } catch { /* Logging must not block the call. */ }
      return next(e)
    }
    const cwd = await $.session.cwd()
    const briefFile = await stashBrief($, script, e.prompt)
    const deny = core.denial(route, e, cwd, now, briefFile)
    try { $.ui.log(core.lastDecision()) } catch { /* Logging must not block the handoff. */ }
    return { deny }
  }).catch(failOpen)

  on('tool.call', async (_$, e, next) => {
    const ran = await next(e)
    const note = core?.toolCall(String(e.tool), e.agentId !== undefined)
    return note && ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  }).catch(failOpen)

  on('classic.StopFailure', async ($, e, next) => {
    const lockout = core?.stopFailure(e.error, await $.clock.now())
    if (lockout) await $.process.run(['python3', '-I', script, 'lockout', '--reset-at', lockout.resetAt])
    return next(e)
  }).catch(failOpen)

  on('command.run', { command: 'crossfeed' }, async ($, e, next) => {
    if (!core) return next(e)
    const args = e.args.trim()
    const now = await $.clock.now()
    if (args === '' || args === 'status') return { text: core.describe(now) }
    if (args === 'report') return { text: (await $.process.run(['python3', '-I', script, 'report'])).stdout }
    if (args === 'auto' || args === 'always' || args === 'off') {
      core.setMode(args)
      $.ui.status(core.status(now))
      return { text: `crossfeed mode: ${args} (this session)` }
    }
    return { text: 'usage: /crossfeed [status|report|auto|always|off]' }
  }).catch(failOpen)
}
