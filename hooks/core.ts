import type { Config, Mode } from './config'
import { CODEX_MAX_AGE, INITIAL_PRESSURE, bucketState, familyOf, fallbackFor, rewriteModel, subagentFamily, decide, eligible, fit, forecast, headroom, headroomCause, shortProblem, pressure, updatePressure } from './policy'
import type { AgentCall, ClaudeReading, CodexReading, UsageReading, BucketView, Family, Tier } from './policy'
import { limitLines, limitNotice, denyText, dispatchCommand, heredocDelimiter, pressureNotice, reserveNotice, statusLine, stretchReminder } from './text'

import type { LimitFact } from './text'

export type Route = { tier: 'A' | 'B'; reason: string; limit?: LimitFact; cause?: string }
type Spawn = { subagentType: string; model?: string; fork: boolean; parentModel: string }

// One ledger line per routing decision, built from plain values when the call is decided.
export type DecisionRecord = {
  session: string | null
  mode: Mode
  agent_type: string | null
  model: string | null
  main_model: string | null
  from_subagent: boolean
  description: string | null
  brief_chars: number
  eligible: boolean
  tier: Tier | null
  tier_reason: string | null
  handed_off: boolean
  reason: string
  cause: string | null
  burst: number
  pressure: number
  five_hour: number | null
  forecast: number | null
  seven_day: number | null
  codex_headroom: number
  codex_weekly: number | null
  codex_age_s: number | null
  limit: { label: string; percent: number; state: 'ahead' | 'full' } | null
  brief_file: string | null
}

export type Core = {
  newConversation(session: string | undefined): void
  setUsage(reading: UsageReading | undefined, problem: string | undefined, now: number): void
  usageAge(now: number): number
  setMainModel(model: string | undefined, now: number): void
  spawnModel(e: Spawn, now: number): { model: string; from: string; bucket: string; percent: number } | undefined
  bucketLockout(now: number): { bucket: string; resetAt: string } | undefined
  measure(reading: ClaudeReading, now: number): void
  setCodex(reading: CodexReading | undefined, problem?: string): void
  setLockout(resetAtMs: number | undefined): void
  codexAge(now: number): number
  needsCodex(call: AgentCall): boolean
  route(call: AgentCall, now: number): Route | undefined
  lastStay(): number | undefined
  lastRecord(): DecisionRecord | undefined
  forgetStay(time: number): void
  denial(route: Route, call: AgentCall, cwd: string, now: number, briefFile?: string, decided?: DecisionRecord): string
  lastDecision(): string
  toolCall(tool: string, isSubagent: boolean, now?: number): string | undefined
  takeNotices(now?: number): string[]
  userPrompt(now?: number): string[]
  stopFailure(error: string, now: number): { resetAt: string } | undefined
  setMode(mode: Mode): void
  status(now: number): string
  describe(now: number): string
}

const COUNTED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'NotebookEdit']

// Overlapping calls are decided in the order they finish their probes, so a stay can be dated
// slightly after the call being decided. Only a clock that went back further drops it.
const CLOCK_SKEW = 60000

function recentStays(stays: number[], now: number): number[] {
  return stays.filter(time => time >= now - 10 * 60000 && time <= now + CLOCK_SKEW)
}

function weeklyPercent(codex: CodexReading | undefined): number | undefined {
  const windows = codex?.windows.filter(window => window.minutes > 360) ?? []
  return windows.sort((a, b) => b.minutes - a.minutes)[0]?.usedPercent
}

export function createCore(config: Config, script: string, session?: string): Core {
  let mode = config.mode
  let usage: UsageReading | undefined
  let usageProblem: string | undefined
  let usageAttempted = false
  let mainModel: string | undefined
  let latestNow = 0
  const limitNotified = new Set<string>()
  const lockedBuckets = new Set<string>()
  let limitNotices: { family: Family; state: 'ahead' | 'full' }[] = []
  let reading: ClaudeReading = {}
  let codex: CodexReading | undefined
  let codexProblem: string | undefined
  let lockoutResetAt: number | undefined
  let stayedCalls: number[] = []
  let lastStay: number | undefined
  let lastRecord: DecisionRecord | undefined
  let state = INITIAL_PRESSURE
  let pressureNotified = false
  let reserveNotified = false
  let notices: string[] = []
  let calls = 0
  let stretchNotified = false
  let lastDecision = 'last subagent call: none yet'

  function views(now: number): BucketView[] {
    return (usage?.buckets ?? []).map(bucket => ({ bucket, ...bucketState(bucket, usage!.readAt, now, reading.sevenDay?.resetsAt) }))
  }

  function familyViews(now: number): Map<Family, BucketView> {
    return new Map(views(now).filter(view => view.bucket.family !== undefined).map(view => [view.bucket.family!, view]))
  }

  function fact(view: BucketView | undefined): LimitFact | undefined {
    if (!view || (view.state !== 'ahead' && view.state !== 'full')) return undefined
    return { label: view.bucket.label, family: view.bucket.family, percent: view.bucket.usedPercent, line: view.line, resetsAt: view.bucket.resetsAt ?? reading.sevenDay?.resetsAt, state: view.state }
  }

  function familyFact(model: string | undefined, now: number): LimitFact | undefined {
    const family = familyOf(model)
    return family === undefined ? undefined : fact(familyViews(now).get(family))
  }

  function notifyLimit(now: number): void {
    latestNow = now
    if (mode === 'off') return
    const family = familyOf(mainModel)
    const limit = familyFact(mainModel, now)
    if (!family || !limit) return
    const key = family + ':' + limit.state
    if (limitNotified.has(key) || limitNotices.some(note => note.family === family && note.state === limit.state)) return
    // A full notice supersedes an ahead notice that has not yet been delivered.
    limitNotices = limitNotices.filter(note => note.family !== family)
    limitNotices.push({ family, state: limit.state })
  }

  function spawnModel(e: Spawn, now: number) {
    const change = rewriteModel({ ...e, mode, fallback: config.premiumFallback, views: familyViews(now) })
    return change === undefined ? undefined : {
      model: change.model, from: !e.model || e.model === 'inherit' ? e.parentModel : e.model,
      bucket: change.view.bucket.label, percent: change.view.bucket.usedPercent,
    }
  }

  function usageAge(now: number): number {
    return usage === undefined ? Infinity : Math.abs(now - usage.readAt)
  }

  function codexAge(now: number): number {
    // A reading dated ahead of the clock (the clock went back) is as untrusted as an old one.
    return codex === undefined ? Infinity : Math.abs(now - codex.readAt)
  }

  function status(now: number): string {
    return statusLine({
      mode,
      limits: views(now).filter(view => view.bucket.family === familyOf(mainModel) && view.bucket.family !== undefined || view.state === 'ahead' || view.state === 'full')
        .map(view => ({ label: view.bucket.label, percent: view.bucket.usedPercent, state: view.state })),
      u: reading.fiveHour?.percentUsed,
      F: forecast(state, reading, now),
      w: reading.sevenDay?.percentUsed,
      codexPercent: weeklyPercent(codex),
      codexAvailable: !!codex?.windows.length,
      codexStale: codex !== undefined && codexAge(now) > CODEX_MAX_AGE,
      P: pressure(state, reading),
      reserve: (reading.fiveHour?.percentUsed ?? 0) >= 90,
    })
  }

  function takeNotices(now = latestNow): string[] {
    notifyLimit(now)
    const queued = notices
    notices = []
    for (const note of limitNotices) {
      const limit = familyFact(mainModel, now)
      if (mode !== 'off' && familyOf(mainModel) === note.family && limit?.state === note.state) {
        queued.push(limitNotice({ ...limit, fallback: fallbackFor(note.family, config.premiumFallback, familyViews(now)) ?? '' }))
        limitNotified.add(note.family + ':' + note.state)
      }
    }
    limitNotices = []
    return queued
  }

  function setLockout(resetAtMs: number | undefined): void {
    if (resetAtMs !== undefined && Number.isFinite(resetAtMs)) {
      lockoutResetAt = Math.max(lockoutResetAt ?? -Infinity, resetAtMs)
    }
  }

  function burstCount(now: number): number {
    return recentStays(stayedCalls, now).length
  }

  return {
    newConversation(nextSession) {
      session = nextSession
      notices = []
      pressureNotified = false
      reserveNotified = false
      limitNotified.clear()
      limitNotices = []
      calls = 0
      stretchNotified = false
    },

    setUsage(nextReading, problem, now) {
      usageAttempted = true
      // A probe that finished after a newer one carries the older reading; a held reading dated
      // ahead of the clock (the clock went back) is no reason to refuse a new one.
      if (nextReading && usage && nextReading.readAt < usage.readAt && usage.readAt - now <= 5 * 60000) return
      usage = nextReading
      usageProblem = shortProblem(problem)
      if (!usage) limitNotices = []
      notifyLimit(now)
    },

    usageAge,

    setMainModel(model, now) {
      mainModel = model
      notifyLimit(now)
    },

    spawnModel,

    bucketLockout(now) {
      if (mode === 'off') return undefined
      const limit = familyFact(mainModel, now)
      if (limit?.state !== 'full') return undefined
      const resetAt = limit.resetsAt === undefined ? 'unknown' : new Date(limit.resetsAt).toISOString()
      const key = JSON.stringify([limit.label, resetAt])
      if (lockedBuckets.has(key)) return undefined
      lockedBuckets.add(key)
      return { bucket: limit.label, resetAt }
    },

    measure(nextReading, now) {
      const nextState = updatePressure(state, nextReading, now, lockoutResetAt)
      if (nextState.windowResetsAt !== state.windowResetsAt) {
        pressureNotified = false
        reserveNotified = false
        notices = []
      }
      reading = nextReading
      state = nextState
      notifyLimit(now)
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
      stayedCalls = recentStays(stayedCalls, now)
      lastStay = undefined
      const eligibility = eligible(call, config)
      const P = pressure(state, reading)
      const g = headroom(codex, config, now)
      const family = subagentFamily(call.model, mainModel)
      const limit = family === undefined ? undefined : fact(familyViews(now).get(family))
      const earlier = stayedCalls.length
      const record = (outcome: { eligible: boolean; tier?: Tier; tierReason?: string; handedOff: boolean; reason: string; cause?: string }): void => {
        const F = forecast(state, reading, now)
        const age = codexAge(now)
        lastRecord = mode === 'off' ? undefined : {
          session: session ?? null, mode, agent_type: call.subagent_type ?? null, model: call.model ?? null,
          main_model: mainModel ?? null, from_subagent: call.agentId !== undefined,
          description: call.description === undefined ? null : Array.from(call.description).slice(0, 100).join(''),
          brief_chars: call.prompt.length, eligible: outcome.eligible, tier: outcome.tier ?? null, tier_reason: outcome.tierReason ?? null,
          handed_off: outcome.handedOff, reason: outcome.reason, cause: outcome.cause ?? null, burst: earlier,
          pressure: P, five_hour: reading.fiveHour?.percentUsed ?? null,
          forecast: F ?? null, seven_day: reading.sevenDay?.percentUsed ?? null,
          codex_headroom: g, codex_weekly: weeklyPercent(codex) ?? null,
          codex_age_s: age === Infinity ? null : Math.round(age / 1000),
          limit: limit ? { label: limit.label, percent: limit.percent, state: limit.state } : null, brief_file: null,
        }
      }
      if (!eligibility.ok) {
        lastDecision = `last subagent call: stayed on Claude (${eligibility.reason})`
        record({ eligible: false, handedOff: false, reason: eligibility.reason })
        return undefined
      }
      const { tier, reason } = fit(call)
      const burst = earlier >= 2
      const basePressure = burst ? Math.max(P, 0.3) : P
      const decision = decide({ tier, P: limit ? Math.max(basePressure, 0.3) : basePressure, limitFloor: !!limit, g, headroomProblem: headroomCause(codex, config, now, codexProblem), mode, claudeKnown: reading.fiveHour !== undefined })
      if (!decision.handOff || tier === 'C') {
        if (tier !== 'C') {
          stayedCalls.push(now)
          lastStay = now
        }
        lastDecision = `last subagent call: stayed on Claude (${decision.reason})`
        record({ eligible: true, tier, tierReason: reason, handedOff: false, reason: decision.reason })
        return undefined
      }
      const routeReason = tier === 'B' && mode === 'auto' && burst && P < 0.3
        ? `${reason}; burst: ${earlier} earlier subagent calls stayed on Claude in 10 minutes`
        : reason
      const cause = limit && tier === 'B' && mode === 'auto' && basePressure < 0.3 ? 'limit' : undefined
      lastDecision = `last subagent call: handed to Codex (${routeReason})`
      record({ eligible: true, tier, tierReason: reason, handedOff: true, reason: decision.reason, cause })
      return { tier, reason: routeReason, ...(limit ? { limit, ...(cause ? { cause } : {}) } : {}) }
    },

    // Read right after route(): the time under which that call was counted as staying on Claude.
    lastStay: () => lastStay,

    // Read right after route(), like lastStay(): the record of that call, or undefined in off mode.
    lastRecord: () => lastRecord,

    // A call that was counted but then refused downstream started no subagent.
    forgetStay(time) {
      const index = stayedCalls.lastIndexOf(time)
      if (index >= 0) stayedCalls.splice(index, 1)
    },

    // decided, when given, is the call's decision record: the refusal then names the session and
    // states the readings the call was decided on, even if newer ones arrived since.
    denial({ tier, reason, limit, cause }, call, cwd, now, briefFile, decided) {
      const delimiter = briefFile === undefined ? heredocDelimiter(call.prompt, now) : undefined
      const dispatchSession = decided === undefined ? session : decided.session ?? undefined
      const command = dispatchCommand({
        script, tier, cause, dir: cwd, write: tier === 'A', worktree: call.isolation === 'worktree', session: dispatchSession,
        effort: config.effort, model: config.model, timeoutMinutes: config.timeoutMinutes, briefFile, delimiter,
      })
      const readings = decided === undefined
        ? { u: reading.fiveHour?.percentUsed ?? 0, F: forecast(state, reading, now), codexPercent: weeklyPercent(codex) }
        : { u: decided.five_hour ?? 0, F: decided.forecast ?? undefined, codexPercent: decided.codex_weekly ?? undefined }
      return denyText({ tier, reason, limit, ...readings, command, saved: briefFile !== undefined, delimiter })
    },

    lastDecision: () => lastDecision,

    toolCall(tool, isSubagent, now = latestNow) {
      if (isSubagent || !COUNTED_TOOLS.includes(tool)) return undefined
      calls += 1
      const limit = familyFact(mainModel, now)
      if (mode === 'off' || stretchNotified || calls < config.stretchCalls || (!limit && (pressure(state, reading) < 0.3 || !reading.fiveHour))) return undefined
      stretchNotified = true
      return stretchReminder({ calls, limit, u: reading.fiveHour?.percentUsed, script, session })
    },

    takeNotices,

    userPrompt(now) {
      const queued = takeNotices(now)
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
      if (mode === 'off') { notices = []; limitNotices = [] }
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
        ...limitLines(views(now).map(view => {
          const change = view.bucket.family === undefined ? undefined : spawnModel({ subagentType: 'general-purpose', fork: false, parentModel: view.bucket.family }, now)
          const handOff = mode !== 'off' && view.bucket.family !== undefined && !!fact(view) && headroom(codex, config, now) > 0
          const subagents = change ? `${handOff ? 'hand off or ' : ''}run on ${change.model}` : handOff ? 'hand off when eligible' : 'unchanged'
          return { label: view.bucket.label, family: view.bucket.family, percent: view.bucket.usedPercent, line: view.line, state: view.state, ageSeconds: usageAge(now) / 1000, subagents }
        })),
        ...(usageAttempted ? [`usage reading age: ${usageAge(now) === Infinity ? 'never read' : `${Math.round(usageAge(now) / 1000)} seconds`}${usageProblem ? ` (${usageProblem})` : ''}`] : []),
      ].join('\n')
    },
  }
}
