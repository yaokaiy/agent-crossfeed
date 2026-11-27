import type { BackgroundState, BackgroundTask as Task } from '../types'
import type { Config, Mode } from './config'
import { CODEX_MAX_AGE, FIVE_HOUR_WINDOW_MS, INITIAL_PRESSURE, accountWeekState, bucketState, codexSurplus, familyOf, fallbackFor, rewriteModel, subagentFamily, decide, eligible, fit, forecast, headroomCause, knownHeadroom, shortProblem, pressure, shortWindow, spawnOrigin, updatePressure, weeklyWindow } from './policy'
import type { AgentCall, BucketState, ClaudeReading, CodexReading, UsageReading, BucketView, Family, FiveHour, FloorCause, HandOffReason, PressureState, ShortWindow, Spawn, SpawnOrigin, Tier } from './policy'
import { balanceOffText, balanceOnText, limitLines, limitNotice, denyText, dispatchCommand, heredocDelimiter, paceWarning, pressureNotice, reserveNotice, shortWindowStatus, spawnDenial, statusLine, stretchReminder, wakeText } from './text'

import type { LimitFact, WakeStop } from './text'

export type Route = { tier: 'A' | 'B'; reason: string; limit?: LimitFact; cause?: FloorCause }
export type Nudge = { session: string | null; kind: 'balance-on' | 'balance-off' | 'stretch'; reasons: HandOffReason[]; calls: number | null }
export type Notice = { text: string; nudge?: Nudge }
type SpawnModel = Pick<Spawn, 'subagentType' | 'model' | 'fork' | 'parentModel'>
type SpawnRow = { type: 'spawn'; session: string | null; origin: SpawnOrigin; run_id: string | null;
  agent_index: number | null; model: string | null; outcome: 'started' | 'refused' | 'unconfirmed' }
type BreakerRow = { type: 'breaker'; session: string | null; task_id: string; run_id: string | null;
  outcome: 'stopped' | 'denied' | 'error'; reason: string | null }
type WakeRow = { type: 'wake'; session: string | null; trigger: 'pace' | 'breaker'; outcome: 'prompt' | 'notice' }
export type BackgroundRow = SpawnRow | BreakerRow | WakeRow
export type StopResult = { outcome: BreakerRow['outcome'] | 'ended'; reason?: string }
type Stop = { task: Task; session: string | null; conversation: number; window: number; reading: ShortWindow; wakeReady: boolean }
type Wake = { trigger: WakeRow['trigger']; reading: ShortWindow; stops: WakeStop[]; ready: boolean }

function createBackgroundProtection(config: Config, initialSession?: string, saved?: BackgroundState) {
  let session = initialSession
  let mode = config.mode
  let current = saved ?? { tasks: [], lineage: [] }
  let observed: (FiveHour & { at: number }) | undefined
  let resetAt = current.shed?.resetAt
  let window = 0
  let conversation = 0
  let paceShort = false
  let paceWakeQueued = false
  let paceWarned = false
  let wakeHandled = false
  let mainTurn: string | undefined
  const stopping = new Map<Task, Stop>()
  const denied = new Set<Task>()
  let notices: Notice[] = []
  let wakes: Wake[] = []

  function windowAt(state: PressureState, now: number) {
    return shortWindow(state, observed, now, config.shedPercent)
  }

  function shedMatchesWindow(shed: NonNullable<BackgroundState['shed']>, now: number): boolean {
    if (resetAt !== undefined && shed.resetAt !== undefined) {
      return Math.abs(shed.resetAt - resetAt) <= CLOCK_SKEW
    }
    const { crossedAt } = shed
    if (crossedAt === undefined || crossedAt > now + CLOCK_SKEW) return false
    if (resetAt !== undefined) {
      return crossedAt >= resetAt - FIVE_HOUR_WINDOW_MS - CLOCK_SKEW && crossedAt < resetAt
    }
    return now - crossedAt < FIVE_HOUR_WINDOW_MS && (shed.resetAt === undefined || now < shed.resetAt)
  }

  function resetWakes(): void {
    notices = []
    wakes = []
    paceWakeQueued = false
    paceWarned = false
    wakeHandled = false
  }

  function registerTask(task: Task): void {
    if (current.tasks.some(existing => existing.id === task.id)) return
    current = { ...current, tasks: [...current.tasks, task.runId ? task : { id: task.id }] }
  }

  function rememberAgent(agentId: string): void {
    if (!current.lineage.includes(agentId)) current = { ...current, lineage: [...current.lineage, agentId] }
  }

  return {
    snapshot: () => current,
    registerTask,
    registerAgent(agentId: string) {
      rememberAgent(agentId)
      registerTask({ id: agentId })
    },
    newConversation(id?: string, restored?: BackgroundState) {
      session = id
      conversation += 1
      current = restored ?? { tasks: [], lineage: [],
        ...(current.shed ? { shed: { ...current.shed, eligible: [] } } : {}) }
      resetWakes()
      mainTurn = undefined
      denied.clear()
      stopping.clear()
    },
    setMode(nextMode: Mode) {
      mode = nextMode
      if (mode === 'off') {
        notices = []
        if (wakes.some(wake => wake.trigger === 'pace')) paceWakeQueued = false
        wakes = []
      }
    },
    measure(reading: FiveHour, state: PressureState, now: number) {
      const { resetsAt } = reading
      const undatedCrossing = current.shed?.crossedAt ?? observed?.at
      // A full window's elapsed time or a known start after the crossing retires an undated cutoff.
      const moved = resetAt === undefined
        ? undatedCrossing !== undefined && (now - undatedCrossing >= FIVE_HOUR_WINDOW_MS ||
            (resetsAt !== undefined && resetsAt - FIVE_HOUR_WINDOW_MS > undatedCrossing + CLOCK_SKEW))
        : resetsAt === undefined ? now >= resetAt
          : Math.abs(resetsAt - resetAt) > CLOCK_SKEW || (now >= resetAt && resetsAt > now)
      if (moved) {
        current = { tasks: current.tasks, lineage: current.lineage }
        window += 1
        paceShort = false
        denied.clear()
        resetWakes()
      }
      resetAt = resetsAt ?? (moved ? undefined : resetAt)
      if (current.shed && !shedMatchesWindow(current.shed, now)) {
        current = { tasks: current.tasks, lineage: current.lineage }
      }
      observed = { ...reading, at: now }
      const latest = windowAt(state, now)
      const paceCrossed = latest?.pace === true && !paceShort
      paceShort = mode !== 'off' && latest?.pace === true
      if (!latest) return
      if (latest.shed && !current.shed) {
        current = { ...current, shed: {
          ...(resetAt === undefined ? {} : { resetAt }), crossedAt: now, eligible: current.tasks.map(task => task.id),
        } }
      } else if (current.shed && current.shed.resetAt === undefined && resetAt !== undefined) {
        current = { ...current, shed: { ...current.shed, resetAt } }
      }
      if (!paceShort) return
      if (!paceWarned) {
        paceWarned = true
        notices.push({ text: paceWarning(latest) })
      }
      if (paceCrossed && !paceWakeQueued && current.tasks.length) {
        paceWakeQueued = true
        wakes.push({ trigger: 'pace', reading: latest, stops: [], ready: false })
      }
    },
    describe(state: PressureState, now: number) {
      const latest = windowAt(state, now)
      return shortWindowStatus(config.shedPercent, latest ?? (!observed ? 'missing'
        : observed.resetsAt === undefined ? 'expired-age' : 'expired-reset'))
    },
    admission(spawn: Spawn, state: PressureState, now: number) {
      const fromBackground = !!spawn.parentAgentId && current.lineage.includes(spawn.parentAgentId)
      const background = !!spawn.workflow || spawn.background || fromBackground
      const latest = windowAt(state, now)
      const deny = mode !== 'off' && background && latest && (latest.shed || latest.pace)
        ? spawnDenial(latest, !!spawn.workflow) : undefined
      const row: Omit<SpawnRow, 'outcome'> | undefined = mode === 'off' ? undefined : {
        type: 'spawn', session: session ?? null, origin: spawnOrigin(spawn), run_id: spawn.workflow?.runId ?? null,
        agent_index: spawn.workflow?.agentIndex ?? null, model: spawn.model ?? null,
      }
      return { row, deny, background }
    },
    started(spawn: Spawn, agentId: string, background: boolean) {
      const hasTask = spawn.isTeammate || (spawn.fork && !spawn.tool_use_id)
      if (background || hasTask) rememberAgent(agentId)
      if (hasTask) registerTask({ id: agentId })
    },
    beginStops(state: PressureState, now: number): Stop[] {
      const latest = windowAt(state, now)
      if (mode === 'off' || !latest?.shed || !current.shed) return []
      const eligible = new Set(current.shed.eligible)
      return current.tasks.filter(task => eligible.has(task.id) && !stopping.has(task)).map(task => {
        const stop = { task, session: session ?? null, conversation, window, reading: latest, wakeReady: false }
        stopping.set(task, stop)
        return stop
      })
    },
    finishStop(stop: Stop, result: StopResult | undefined): BreakerRow | undefined {
      const { task } = stop
      if (stopping.get(task) === stop) stopping.delete(task)
      if (!result) return undefined
      const { outcome, reason } = result
      if (stop.conversation === conversation) {
        if (outcome === 'ended' || outcome === 'stopped') {
          denied.delete(task)
          current = { ...current, tasks: current.tasks.filter(existing => existing !== task) }
        }
        if (stop.window === window && mode !== 'off' && (outcome === 'stopped' || outcome === 'denied')) {
          if (outcome === 'denied' && denied.has(task)) return undefined
          if (outcome === 'denied') denied.add(task)
          const detail = { ...task, outcome, reason }
          const last = wakes[wakes.length - 1]
          if (last?.trigger === 'breaker' && last.ready === stop.wakeReady) last.stops.push(detail)
          else wakes.push({ trigger: 'breaker', reading: stop.reading, stops: [detail], ready: stop.wakeReady })
        }
      }
      if (outcome === 'ended') return undefined
      return { type: 'breaker', session: stop.session, task_id: task.id, run_id: task.runId ?? null, outcome, reason: reason ?? null }
    },
    startTurn(id: string) { mainTurn = id },
    completeTurn(id: string) { if (mainTurn === id) mainTurn = undefined },
    releaseWakes() {
      // A measure or main-loop completion releases only events and stops it has seen.
      for (const wake of wakes) wake.ready = true
      for (const stop of stopping.values()) stop.wakeReady = true
    },
    hasWake: () => wakes[0]?.ready === true,
    takeWake(hasSurface: boolean) {
      if (mode === 'off' || !wakes[0]?.ready) return undefined
      const event = wakes.shift()!
      const text = wakeText(event.reading, event.stops)
      const prompt = !wakeHandled && config.wake && mainTurn === undefined && hasSurface
      wakeHandled = true
      if (!prompt) notices.push({ text })
      const row: WakeRow = { type: 'wake', session: session ?? null, trigger: event.trigger, outcome: prompt ? 'prompt' : 'notice' }
      return { text, row, toast: !prompt && config.wake }
    },
    keepWakeNotice(text: string) {
      if (mode === 'off') return false
      notices.push({ text })
      return config.wake
    },
    takeNotices() {
      const queued = notices
      notices = []
      return queued
    },
  }
}

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
  newConversation(session: string | undefined, background?: BackgroundState): void
  background: ReturnType<typeof createBackgroundProtection>
  admission(spawn: Spawn, now: number): ReturnType<Core['background']['admission']>
  beginStops(now: number): Stop[]
  setUsage(reading: UsageReading | undefined, problem: string | undefined, now: number): void
  usageAge(now: number): number
  setMainModel(model: string | undefined, now: number): void
  spawnModel(e: SpawnModel, now: number): { model: string; from: string; bucket: string; percent: number } | undefined
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

export function createCore(config: Config, script: string, session?: string, saved?: BackgroundState): Core {
  let mode = config.mode
  const background = createBackgroundProtection(config, session, saved)
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

  function spawnModel(e: SpawnModel, now: number) {
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
    queued.push(...background.takeNotices())
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
    background,
    admission: (spawn, now) => background.admission(spawn, state, now),
    beginStops: now => background.beginStops(state, now),
    newConversation(nextSession, savedBackground) {
      session = nextSession
      background.newConversation(nextSession, savedBackground)
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
      if (nextReading.fiveHour) background.measure(nextReading.fiveHour, state, now)
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
      background.setMode(nextMode)
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
        background.describe(state, now),
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
