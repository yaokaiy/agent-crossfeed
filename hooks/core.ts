import type { Config, Mode } from './config'
import { INITIAL_PRESSURE, decide, eligible, fit, forecast, headroom, headroomCause, shortProblem, pressure, updatePressure } from './policy'
import type { AgentCall, ClaudeReading, CodexReading } from './policy'
import { denyText, dispatchCommand, heredocDelimiter, pressureNotice, reserveNotice, statusLine, stretchReminder } from './text'

export type Route = { tier: 'A' | 'B'; reason: string }

export type Core = {
  measure(reading: ClaudeReading, now: number): void
  setCodex(reading: CodexReading | undefined, problem?: string): void
  setLockout(resetAtMs: number | undefined): void
  codexAge(now: number): number
  needsCodex(call: AgentCall): boolean
  route(call: AgentCall, now: number): Route | undefined
  lastStay(): number | undefined
  forgetStay(time: number): void
  denial(route: Route, call: AgentCall, cwd: string, now: number, briefFile?: string): string
  lastDecision(): string
  toolCall(tool: string, isSubagent: boolean): string | undefined
  takeNotices(): string[]
  userPrompt(): string[]
  stopFailure(error: string, now: number): { resetAt: string } | undefined
  setMode(mode: Mode): void
  status(now: number): string
  describe(now: number): string
}

const COUNTED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'NotebookEdit']

function weeklyPercent(codex: CodexReading | undefined): number | undefined {
  const windows = codex?.windows.filter(window => window.minutes > 360) ?? []
  return windows.sort((a, b) => b.minutes - a.minutes)[0]?.usedPercent
}

export function createCore(config: Config, script: string, session?: string): Core {
  let mode = config.mode
  let reading: ClaudeReading = {}
  let codex: CodexReading | undefined
  let codexProblem: string | undefined
  let lockoutResetAt: number | undefined
  let stayedCalls: number[] = []
  let lastStay: number | undefined
  let state = INITIAL_PRESSURE
  let pressureNotified = false
  let reserveNotified = false
  let notices: string[] = []
  let calls = 0
  let stretchNotified = false
  let lastDecision = 'last subagent call: none yet'

  function codexAge(now: number): number {
    // A reading dated ahead of the clock (the clock went back) is as untrusted as an old one.
    return codex === undefined ? Infinity : Math.abs(now - codex.readAt)
  }

  function status(now: number): string {
    return statusLine({
      mode,
      u: reading.fiveHour?.percentUsed,
      F: forecast(state, reading, now),
      w: reading.sevenDay?.percentUsed,
      codexPercent: weeklyPercent(codex),
      codexAvailable: !!codex?.windows.length,
      codexStale: codex !== undefined && codexAge(now) > 15 * 60000,
      P: pressure(state, reading),
      reserve: (reading.fiveHour?.percentUsed ?? 0) >= 90,
    })
  }

  function takeNotices(): string[] {
    const queued = notices
    notices = []
    return queued
  }

  function setLockout(resetAtMs: number | undefined): void {
    if (resetAtMs !== undefined && Number.isFinite(resetAtMs)) {
      lockoutResetAt = Math.max(lockoutResetAt ?? -Infinity, resetAtMs)
    }
  }

  function burstCount(now: number): number {
    return stayedCalls.filter(time => time >= now - 10 * 60000 && time <= now).length
  }

  return {
    measure(nextReading, now) {
      const nextState = updatePressure(state, nextReading, now, lockoutResetAt)
      if (nextState.windowResetsAt !== state.windowResetsAt) {
        pressureNotified = false
        reserveNotified = false
        notices = []
      }
      reading = nextReading
      state = nextState
      if (mode === 'off' || !reading.fiveHour) return
      const u = reading.fiveHour.percentUsed
      const P = pressure(state, reading)
      if (P >= 0.3 && !pressureNotified) {
        notices.push(pressureNotice({ u, F: forecast(state, reading, now), P }))
        pressureNotified = true
      }
      if (u >= 90 && !reserveNotified) {
        notices.push(reserveNotice(u))
        reserveNotified = true
      }
    },

    setCodex(nextReading, problem) {
      codexProblem = shortProblem(problem ?? nextReading?.problem)
      codex = nextReading === undefined ? undefined : { ...nextReading, problem: codexProblem }
    },

    setLockout,

    codexAge,

    needsCodex(call) {
      return mode !== 'off' && eligible(call, config).ok && fit(call).tier !== 'C'
    },

    route(call, now) {
      stayedCalls = stayedCalls.filter(time => time >= now - 10 * 60000 && time <= now)
      lastStay = undefined
      const eligibility = eligible(call, config)
      if (!eligibility.ok) {
        lastDecision = `last subagent call: stayed on Claude (${eligibility.reason})`
        return undefined
      }
      const { tier, reason } = fit(call)
      const P = pressure(state, reading)
      const burst = stayedCalls.length >= 2
      const decision = decide({ tier, P: burst ? Math.max(P, 0.3) : P, g: headroom(codex, config, now), headroomProblem: headroomCause(codex, config, now, codexProblem), mode, claudeKnown: reading.fiveHour !== undefined })
      if (!decision.handOff || tier === 'C') {
        if (tier !== 'C') {
          stayedCalls.push(now)
          lastStay = now
        }
        lastDecision = `last subagent call: stayed on Claude (${decision.reason})`
        return undefined
      }
      const routeReason = tier === 'B' && mode === 'auto' && burst && P < 0.3
        ? `${reason}; burst: ${stayedCalls.length} earlier subagent calls stayed on Claude in 10 minutes`
        : reason
      lastDecision = `last subagent call: handed to Codex (${routeReason})`
      return { tier, reason: routeReason }
    },

    // Read right after route(): the time under which that call was counted as staying on Claude.
    lastStay: () => lastStay,

    // A call that was counted but then refused downstream started no subagent.
    forgetStay(time) {
      const index = stayedCalls.lastIndexOf(time)
      if (index >= 0) stayedCalls.splice(index, 1)
    },

    denial({ tier, reason }, call, cwd, now, briefFile) {
      const delimiter = briefFile === undefined ? heredocDelimiter(call.prompt, now) : undefined
      const command = dispatchCommand({
        script, tier, dir: cwd, write: tier === 'A', worktree: call.isolation === 'worktree', session,
        effort: config.effort, model: config.model, timeoutMinutes: config.timeoutMinutes, briefFile, delimiter,
      })
      return denyText({ tier, reason, u: reading.fiveHour?.percentUsed ?? 0, F: forecast(state, reading, now), codexPercent: weeklyPercent(codex), command, saved: briefFile !== undefined, delimiter })
    },

    lastDecision: () => lastDecision,

    toolCall(tool, isSubagent) {
      if (isSubagent || !COUNTED_TOOLS.includes(tool)) return undefined
      calls += 1
      if (mode === 'off' || stretchNotified || calls < config.stretchCalls || pressure(state, reading) < 0.3 || !reading.fiveHour) return undefined
      stretchNotified = true
      return stretchReminder({ calls, u: reading.fiveHour.percentUsed, script, session })
    },

    takeNotices,

    userPrompt() {
      const queued = takeNotices()
      calls = 0
      stretchNotified = false
      return queued
    },

    stopFailure(error) {
      if (error !== 'rate_limit' || !reading.fiveHour || reading.fiveHour.percentUsed < 95) return undefined
      const reset = reading.fiveHour.resetsAt
      setLockout(reset)
      return { resetAt: reset === undefined ? 'unknown' : new Date(reset).toISOString() }
    },

    setMode(nextMode) {
      mode = nextMode
      if (mode === 'off') notices = []
    },

    status,

    describe(now) {
      const age = codexAge(now)
      const cause = headroomCause(codex, config, now, codexProblem)
      const count = burstCount(now)
      const P = pressure(state, reading)
      const tiers = (['A', 'B'] as const).map(tier => {
        const decision = decide({ tier, P: count >= 2 ? Math.max(P, 0.3) : P, g: headroom(codex, config, now), headroomProblem: cause, mode, claudeKnown: reading.fiveHour !== undefined })
        return `tier ${tier} calls: ${decision.handOff ? 'handed to Codex' : `stay on Claude (${decision.reason})`}`
      })
      return [
        status(now),
        ...tiers,
        lastDecision,
        `Codex headroom: ${headroom(codex, config, now)}${cause ? ` (${cause})` : ''}`,
        `eligible calls stayed on Claude in 10 minutes: ${count}`,
        `Codex reading age: ${age === Infinity ? 'never read' : `${Math.round(age / 1000)} seconds`}`,
      ].join('\n')
    },
  }
}
