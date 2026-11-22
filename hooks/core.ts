import type { Config, Mode } from './config'
import { CODEX_MAX_AGE, INITIAL_PRESSURE, accountWeekState, bucketState, codexSurplus, familyOf, fallbackFor, rewriteModel, subagentFamily, decide, eligible, fit, forecast, headroomCause, knownHeadroom, shortProblem, pressure, updatePressure, weeklyWindow } from './policy'
import type { AgentCall, BucketState, ClaudeReading, CodexReading, UsageReading, BucketView, Family, FloorCause, HandOffReason, Tier } from './policy'
import { balanceOffText, balanceOnText, limitLines, limitNotice, denyText, dispatchCommand, heredocDelimiter, pressureNotice, reserveNotice, statusLine, stretchReminder } from './text'

import type { LimitFact } from './text'

export type Route = { tier: 'A' | 'B'; reason: string; limit?: LimitFact; cause?: FloorCause }
export type Nudge = { session: string | null; kind: 'balance-on' | 'balance-off' | 'stretch'; reasons: HandOffReason[]; calls: number | null }
export type Notice = { text: string; nudge?: Nudge }
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
  cause: FloorCause | null
  burst: number
  pressure: number
  five_hour: number | null
  forecast: number | null
  seven_day: number | null
  account_week: { percent: number; line: number | null; state: BucketState } | null
  codex_surplus: number | null
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
  setCodex(reading: CodexReading | undefined, problem?: string, now?: number): void
  setLockout(resetAtMs: number | undefined): void
  codexAge(now: number): number
  needsCodex(call: AgentCall): boolean
  route(call: AgentCall, now: number): Route | undefined
  lastStay(): number | undefined
  lastRecord(): DecisionRecord | undefined
  forgetStay(time: number): void
  denial(route: Route, call: AgentCall, cwd: string, now: number, briefFile?: string, decided?: DecisionRecord): string
  lastDecision(): string
  toolCall(tool: string, isSubagent: boolean, now?: number): Notice | undefined
  takeNotices(now?: number): Notice[]
  userPrompt(now?: number): Notice[]
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

export function createCore(config: Config, script: string, session?: string): Core {
  let mode = config.mode
  let usage: UsageReading | undefined
  let usageProblem: string | undefined
  let usageAttempted = false
  let mainModel: string | undefined
  let latestNow: number | undefined
  const limitNotified = new Set<string>()
  const lockedBuckets = new Set<string>()
  let limitNotices: { family: Family; state: 'ahead' | 'full' }[] = []
  let reading: ClaudeReading = {}
  let sevenDayReadAt = 0
  let codex: CodexReading | undefined
  let codexProblem: string | undefined
  let lockoutResetAt: number | undefined
  let stayedCalls: number[] = []
  let lastStay: number | undefined
  let lastRecord: DecisionRecord | undefined
  let state = INITIAL_PRESSURE
  let pressureNotified = false
  let reserveNotified = false
  let pendingPressure: string | undefined
  let pendingReserve: string | undefined
  let lastBalance: 'on' | 'off' | undefined
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

  function balance(now: number) {
    const account = accountWeekState(reading.sevenDay, sevenDayReadAt, now)
    const accountAhead = account.state === 'ahead' || account.state === 'full'
    const availableHeadroom = knownHeadroom(codex, config, now)
    const g = availableHeadroom ?? 0
    const surplus = codexSurplus(codex, config, now)
    const activeSurplus = surplus !== undefined && surplus >= 15 && g >= 0.5 ? surplus : undefined
    return { account, accountAhead, g, availableHeadroom, surplus, activeSurplus }
  }

  function mainLoop(now: number, quotas = balance(now)) {
    const steeringEnabled = mode !== 'off' && (reading.fiveHour?.percentUsed ?? 0) < 90
    const open = steeringEnabled && quotas.g >= 0.5
    const limit = familyFact(mainModel, now)
    const balanceReasons: HandOffReason[] = []
    const reasons: HandOffReason[] = []
    if (open) {
      if (quotas.accountAhead) balanceReasons.push('account-week')
      if (quotas.activeSurplus !== undefined) balanceReasons.push('codex-surplus')
      if (mode === 'always') balanceReasons.push('always')
      if (reading.fiveHour && pressure(state, reading) >= 0.3) reasons.push('pressure')
      if (limit) reasons.push('limit')
      reasons.push(...balanceReasons)
    }
    return { steeringEnabled, open, limit, balanceReasons, reasons }
  }

  function routingPolicy(now: number, earlier: number, limit: LimitFact | undefined, quotas: ReturnType<typeof balance>) {
    const P = pressure(state, reading)
    const basePressure = earlier >= 2 ? Math.max(P, 0.3) : P
    const floor: FloorCause | undefined = limit ? 'limit' : quotas.accountAhead ? 'account-week'
      : quotas.activeSurplus !== undefined ? 'codex-surplus' : undefined
    const input = { mode, g: quotas.g, P: floor ? Math.max(basePressure, 0.3) : basePressure, limitFloor: !!limit,
      claudeKnown: reading.fiveHour !== undefined, headroomProblem: headroomCause(codex, config, now, codexProblem) }
    return { input, basePressure, floor }
  }

  function status(now: number): string {
    const quotas = balance(now)
    return statusLine({
      mode,
      limits: views(now).filter(view => view.bucket.family === familyOf(mainModel) && view.bucket.family !== undefined || view.state === 'ahead' || view.state === 'full')
        .map(view => ({ label: view.bucket.label, percent: view.bucket.usedPercent, state: view.state })),
      u: reading.fiveHour?.percentUsed,
      F: forecast(state, reading, now),
      w: reading.sevenDay?.percentUsed,
      accountAhead: quotas.accountAhead, activeSurplus: quotas.activeSurplus,
      codexPercent: weeklyWindow(codex)?.usedPercent,
      codexAvailable: !!codex?.windows.length,
      codexStale: codex !== undefined && codexAge(now) > CODEX_MAX_AGE,
      P: pressure(state, reading),
      reserve: (reading.fiveHour?.percentUsed ?? 0) >= 90,
    })
  }

  function takeNotices(now = latestNow ?? 0): Notice[] {
    notifyLimit(now)
    const quotas = balance(now)
    const { steeringEnabled, open, limit, balanceReasons, reasons } = mainLoop(now, quotas)
    const queued: Notice[] = []
    if (pendingPressure && reasons.includes('pressure')) {
      queued.push({ text: pendingPressure })
      pendingPressure = undefined
      pressureNotified = true
    }
    if (pendingReserve) {
      queued.push({ text: pendingReserve })
      pendingReserve = undefined
    }
    for (const note of limitNotices) {
      if (open && familyOf(mainModel) === note.family && limit?.state === note.state) {
        queued.push({ text: limitNotice({ ...limit, fallback: fallbackFor(note.family, config.premiumFallback, familyViews(now)) ?? '' }) })
        limitNotified.add(note.family + ':' + note.state)
      }
    }
    limitNotices = []
    if (balanceReasons.length && lastBalance !== 'on') {
      lastBalance = 'on'
      queued.push({ text: balanceOnText(quotas.account, weeklyWindow(codex), quotas.activeSurplus, config.codexStopPercent, mode === 'always'),
        nudge: { session: session ?? null, kind: 'balance-on', reasons: balanceReasons, calls: null } })
    } else if (lastBalance === 'on' && steeringEnabled) {
      const { account, availableHeadroom, surplus } = quotas
      const closeToStop = availableHeadroom !== undefined && availableHeadroom < 0.5
      // The lower thresholds apply only to withdrawing advice already delivered.
      const backOnPace = open && !reasons.length && account.state === 'ok' &&
        account.percent !== undefined && account.line !== undefined && account.percent < account.line + 2 &&
        surplus !== undefined && surplus < 10
      if (closeToStop || backOnPace) {
        lastBalance = 'off'
        queued.push({ text: balanceOffText(closeToStop), nudge: { session: session ?? null, kind: 'balance-off', reasons: [], calls: null } })
      }
    }
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
      pendingPressure = undefined
      pendingReserve = undefined
      lastBalance = undefined
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
        pendingPressure = undefined
        pendingReserve = undefined
      }
      reading = nextReading
      sevenDayReadAt = now
      state = nextState
      notifyLimit(now)
      if ((reading.fiveHour?.percentUsed ?? 0) < 90 && pendingReserve) {
        pendingReserve = undefined
        reserveNotified = false
      }
      if (mode === 'off' || !reading.fiveHour) return
      const u = reading.fiveHour.percentUsed
      const P = pressure(state, reading)
      if (P >= 0.3 && !pressureNotified) {
        pendingPressure = pressureNotice({ u, F: forecast(state, reading, now), P })
      }
      if (u >= 90 && !reserveNotified) {
        pendingReserve = reserveNotice(u)
        reserveNotified = true
      }
    },

    setCodex(nextReading, problem, now = latestNow ?? nextReading?.readAt ?? 0) {
      latestNow = now
      if (nextReading && codex && nextReading.readAt < codex.readAt && codex.readAt - now <= 5 * 60000) return
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
      const quotas = balance(now)
      const family = subagentFamily(call.model, mainModel)
      const limit = family === undefined ? undefined : fact(familyViews(now).get(family))
      const earlier = stayedCalls.length
      const record = (outcome: { eligible: boolean; tier?: Tier; tierReason?: string; handedOff: boolean; reason: string; cause?: FloorCause }): void => {
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
          account_week: quotas.account.percent === undefined ? null : { percent: quotas.account.percent, line: quotas.account.line ?? null, state: quotas.account.state },
          codex_surplus: quotas.surplus === undefined ? null : Number(quotas.surplus.toFixed(1)),
          codex_headroom: quotas.g, codex_weekly: weeklyWindow(codex)?.usedPercent ?? null,
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
      const { input, basePressure, floor } = routingPolicy(now, earlier, limit, quotas)
      const decision = decide({ tier, ...input })
      if (!decision.handOff || tier === 'C') {
        if (tier !== 'C') {
          stayedCalls.push(now)
          lastStay = now
        }
        lastDecision = `last subagent call: stayed on Claude (${decision.reason})`
        record({ eligible: true, tier, tierReason: reason, handedOff: false, reason: decision.reason })
        return undefined
      }
      const cause = tier === 'B' && mode === 'auto' && floor &&
        !decide({ ...input, tier, P: basePressure, limitFloor: false }).handOff ? floor : undefined
      const routeReason = !cause && tier === 'B' && mode === 'auto' && burst && P < 0.3
        ? `${reason}; burst: ${earlier} earlier subagent calls stayed on Claude in 10 minutes`
        : reason
      lastDecision = `last subagent call: handed to Codex (${routeReason})`
      record({ eligible: true, tier, tierReason: reason, handedOff: true, reason: decision.reason, cause })
      return { tier, reason: routeReason, ...(limit ? { limit } : {}), ...(cause ? { cause } : {}) }
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
    denial(route, call, cwd, now, briefFile, decided) {
      const { tier, reason } = route
      const limit = decided ? decided.limit && { ...decided.limit, line: route.limit?.line } : route.limit
      const cause = decided ? decided.cause ?? undefined : route.cause
      const delimiter = briefFile === undefined ? heredocDelimiter(call.prompt, now) : undefined
      const dispatchSession = decided === undefined ? session : decided.session ?? undefined
      const command = dispatchCommand({
        script, tier, cause, dir: cwd, write: tier === 'A', worktree: call.isolation === 'worktree', session: dispatchSession,
        effort: config.effort, model: config.model, codexStopPercent: config.codexStopPercent, timeoutMinutes: config.timeoutMinutes, briefFile, delimiter,
      })
      const readings = decided === undefined
        ? { u: reading.fiveHour?.percentUsed ?? 0, F: forecast(state, reading, now), codexPercent: weeklyWindow(codex)?.usedPercent,
            account: accountWeekState(reading.sevenDay, sevenDayReadAt, now), surplus: codexSurplus(codex, config, now) }
        : { u: decided.five_hour ?? 0, F: decided.forecast ?? undefined, codexPercent: decided.codex_weekly ?? undefined,
            account: decided.account_week ? { ...decided.account_week, line: decided.account_week.line ?? undefined } : undefined,
            surplus: decided.codex_surplus ?? undefined }
      return denyText({ tier, reason, limit: limit ?? undefined, cause, ...readings, codexStopPercent: config.codexStopPercent, command, saved: briefFile !== undefined, delimiter })
    },

    lastDecision: () => lastDecision,

    toolCall(tool, isSubagent, now = latestNow ?? 0) {
      if (isSubagent || !COUNTED_TOOLS.includes(tool)) return undefined
      calls += 1
      if (stretchNotified || calls < config.stretchCalls) return undefined
      const { reasons, limit } = mainLoop(now)
      if (!reasons.length) return undefined
      stretchNotified = true
      return { text: stretchReminder({ calls, limit, reasons, u: reading.fiveHour?.percentUsed, script, session, codexStopPercent: config.codexStopPercent }),
        nudge: { session: session ?? null, kind: 'stretch', reasons, calls } }
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
      if (mode === 'off') {
        pendingPressure = undefined
        pendingReserve = undefined
        limitNotices = []
        lastBalance = undefined
      }
    },

    status,

    describe(now) {
      const age = codexAge(now)
      const count = burstCount(now)
      const quotas = balance(now)
      const { reasons, limit } = mainLoop(now, quotas)
      const { input } = routingPolicy(now, count, limit, quotas)
      const cause = input.headroomProblem
      const tiers = (['A', 'B'] as const).map(tier => {
        const decision = decide({ tier, ...input })
        return `tier ${tier} calls: ${decision.handOff ? 'handed to Codex' : `stay on Claude (${decision.reason})`}`
      })
      const { account, surplus } = quotas
      const week = weeklyWindow(codex)
      const unavailable = cause ?? (!week ? 'no weekly window' : week.resetsAt === undefined ? 'weekly reset unknown' : 'weekly window has reset')
      const surplusStatus = surplus === undefined ? `unknown (${unavailable})`
        : `${Number(surplus.toFixed(1))} points (${quotas.activeSurplus !== undefined ? 'active' : surplus < 15 ? 'below 15 points' : 'headroom below 0.5'})`
      return [
        status(now),
        ...tiers,
        lastDecision,
        `Claude all-models weekly: ${account.percent === undefined ? 'usage unknown' : `${Math.round(account.percent)}% used`}, even pace ${account.line === undefined ? 'unknown' : `${Math.round(account.line)}%`}, ${account.state}`,
        `Codex weekly surplus: ${surplusStatus}`,
        reasons.length ? `hand-offs: on (${reasons.join(', ')})` : 'hand-offs: off',
        `Codex headroom: ${quotas.g}${cause ? ` (${cause})` : ''}`,
        `eligible calls stayed on Claude in 10 minutes: ${count}`,
        `Codex reading age: ${age === Infinity ? 'never read' : `${Math.round(age / 1000)} seconds`}`,
        ...limitLines(views(now).map(view => {
          const change = view.bucket.family === undefined ? undefined : spawnModel({ subagentType: 'general-purpose', fork: false, parentModel: view.bucket.family }, now)
          const handOff = mode !== 'off' && view.bucket.family !== undefined && !!fact(view) && quotas.g > 0
          const subagents = change ? `${handOff ? 'hand off or ' : ''}run on ${change.model}` : handOff ? 'hand off when eligible' : 'unchanged'
          return { label: view.bucket.label, family: view.bucket.family, percent: view.bucket.usedPercent, line: view.line, state: view.state, ageSeconds: usageAge(now) / 1000, subagents }
        })),
        ...(usageAttempted ? [`usage reading age: ${usageAge(now) === Infinity ? 'never read' : `${Math.round(usageAge(now) / 1000)} seconds`}${usageProblem ? ` (${usageProblem})` : ''}`] : []),
      ].join('\n')
    },
  }
}
