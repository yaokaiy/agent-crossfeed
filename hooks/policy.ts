import type { Config, Mode } from './config'

export type Tier = 'A' | 'B' | 'C'
export type FloorCause = 'limit' | 'account-week' | 'codex-surplus'
export type HandOffReason = FloorCause | 'pressure' | 'always'

export type AgentCall = {
  prompt: string
  agentId?: string
  description?: string
  subagent_type?: string
  model?: string
  isolation?: string
  name?: string
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

export function eligible(call: AgentCall, config: Config): { ok: boolean; reason: string } {
  if (call.agentId !== undefined) return { ok: false, reason: 'call belongs to a subagent' }
  if (call.subagent_type !== undefined && !config.eligibleTypes.includes(call.subagent_type)) {
    return { ok: false, reason: `type ${call.subagent_type} keeps its own setup` }
  }
  if (call.model === 'haiku') return { ok: false, reason: 'haiku is already cheap' }
  if (call.isolation === 'remote') return { ok: false, reason: 'remote isolation stays on Claude' }
  if (call.name !== undefined) return { ok: false, reason: 'a named agent expects follow-up messages' }
  if (/mcp__|claude-in-chrome|computer-use|Claude_Browser|AskUserQuestion|SendMessage|\bArtifact tool\b|\bscreenshot/i.test(call.prompt)) {
    return { ok: false, reason: 'the brief needs a tool Codex lacks' }
  }
  if (!call.prompt.trim()) return { ok: false, reason: 'the brief is empty' }
  return { ok: true, reason: 'self-contained agent call' }
}

export function fit(call: AgentCall): { tier: Tier; reason: string } {
  const head = (call.description ?? '') + ' ' + call.prompt.slice(0, 300)
  if (call.prompt.trim().length < 100) return { tier: 'C', reason: 'brief under 100 characters' }
  if (/\b(design|architect\w*|ux|ui|front[- ]?end|css|styling|layout|look and feel|naming|brainstorm\w*)\b/i.test(head)) {
    return { tier: 'C', reason: 'design or front-end judgment' }
  }
  if (!/\b(pytest|unittest|npm (run )?test|pnpm (run )?test|yarn test|cargo test|go test|make (test|check)|tox|jest|vitest|mvn test|gradle test|ctest|rspec|claude plugin test)\b/i.test(call.prompt)) {
    return { tier: 'B', reason: 'no check command' }
  }
  if (/\b(implement\w*|refactor\w*|migrat\w+|rename|port|convert|fix\w* (the )?(failing|broken)|make (.{0,40} )?pass|reproduc\w+|bisect|triage|logs?|flaky|upgrade|bump)\b/i.test(head + call.prompt)) {
    return { tier: 'A', reason: 'has a check command and is implementation-type work' }
  }
  return { tier: 'B', reason: 'not implementation-type work' }
}

export type ClaudeReading = {
  fiveHour?: { percentUsed: number; resetsAt?: number }
  sevenDay?: { percentUsed: number; resetsAt?: number }
}
export type CodexWindow = { minutes: number; usedPercent: number; resetsAt?: number }
export type CodexReading = { windows: CodexWindow[]; limitReached: boolean; readAt: number; problem?: string }
export type PressureState = {
  p: number
  updatedAt: number
  samples: { t: number; u: number }[]
  windowResetsAt?: number
}

export const INITIAL_PRESSURE: PressureState = { p: 0, updatedAt: 0, samples: [] }

const MINUTE = 60000
export const FIVE_HOUR_WINDOW_MS = 300 * MINUTE

// A Codex reading older than this, or dated this far ahead of the clock, gives no headroom and shows as stale.
export const CODEX_MAX_AGE = 15 * MINUTE

export type AccountWeek = { percent?: number; line?: number; resetsAt?: number; state: BucketState }

export function accountWeekState(window: ClaudeReading['sevenDay'], readAt: number, now: number): AccountWeek {
  if (!window) return { state: 'unknown' }
  const { percentUsed: percent, resetsAt } = window
  if (resetsAt === undefined) return { percent, state: 'unknown' }
  const line = 100 * clamp(1 - (resetsAt - now) / (7 * 1440 * MINUTE), 0, 1)
  const state = now >= resetsAt || readAt - now > 5 * MINUTE ? 'unknown'
    : percent >= 100 ? 'full' : percent >= line + 5 || percent >= 90 ? 'ahead' : 'ok'
  return { percent, line, resetsAt, state }
}

export function weeklyWindow(codex: CodexReading | undefined): CodexWindow | undefined {
  return codex?.windows.filter(window => window.minutes > 360).sort((a, b) => b.minutes - a.minutes)[0]
}

export function codexSurplus(codex: CodexReading | undefined, config: Config, now: number): number | undefined {
  if (!codex || codex.limitReached || Math.abs(codex.readAt - now) > CODEX_MAX_AGE) return undefined
  const week = weeklyWindow(codex)
  if (week?.resetsAt === undefined || now >= week.resetsAt) return undefined
  const elapsed = clamp(1 - (week.resetsAt - now) / (week.minutes * MINUTE), 0, 1)
  return config.codexStopPercent * elapsed - week.usedPercent
}

function usageRate(samples: PressureState['samples'], u: number, now: number): number | undefined {
  if (samples.length < 2) return undefined
  let ref = samples[0]!
  for (const sample of samples) {
    if (sample.t <= now - 10 * MINUTE) ref = sample
  }
  const elapsed = (now - ref.t) / MINUTE
  return elapsed > 0 ? Math.max(0, (u - ref.u) / elapsed) : undefined
}

export type FiveHour = NonNullable<ClaudeReading['fiveHour']>
export type ShortWindow = FiveHour & { shed: boolean; pace: boolean; rate?: number; minutesLeft?: number }

export function shortWindow(
  state: PressureState, observed: (FiveHour & { at: number }) | undefined, now: number, shedPercent: number,
): ShortWindow | undefined {
  if (!observed) return undefined
  const { percentUsed, resetsAt, at } = observed
  if (now >= (resetsAt ?? at + 10 * MINUTE)) return undefined
  const rate = resetsAt !== undefined && at - (state.samples[0]?.t ?? at) >= 10 * MINUTE
    ? usageRate(state.samples, percentUsed, at) : undefined
  const minutesLeft = rate && rate > 0 ? (100 - percentUsed) / rate : undefined
  return { percentUsed, resetsAt, rate, minutesLeft, shed: percentUsed >= shedPercent,
    pace: minutesLeft !== undefined && resetsAt !== undefined && minutesLeft <= 15 && minutesLeft < (resetsAt - now) / MINUTE }
}

export type SpawnOrigin = 'workflow' | 'fork' | 'teammate' | 'resume' | 'agent-tool' | 'other'
export type Spawn = {
  subagentType: string; model?: string; fork: boolean; parentModel: string
  tool_use_id: string; background: boolean; parentAgentId?: string; isTeammate?: boolean
  workflow?: { runId: string; agentIndex: number }; resume?: { agentId: string }
}

export function spawnOrigin(spawn: Spawn): SpawnOrigin {
  if (spawn.workflow) return 'workflow'
  if (spawn.fork) return 'fork'
  if (spawn.isTeammate) return 'teammate'
  if (spawn.resume) return 'resume'
  return spawn.tool_use_id ? 'agent-tool' : 'other'
}

export function updatePressure(state: PressureState, reading: ClaudeReading, now: number, lockoutResetAt?: number): PressureState {
  if (!reading.fiveHour) return state
  const { percentUsed: u, resetsAt } = reading.fiveHour
  // The start after a lockout uses this reading's own reset time, never a remembered one,
  // and holds only while the window is young: a session that starts or resumes later begins at 0.
  const windowStart = (resetsAt ?? NaN) - FIVE_HOUR_WINDOW_MS
  const sinceLockout = windowStart - (lockoutResetAt ?? NaN)
  const windowAge = now - windowStart
  const p0 = sinceLockout >= -5 * MINUTE && sinceLockout < 120 * MINUTE && windowAge >= -5 * MINUTE && windowAge < 30 * MINUTE ? 0.3 : 0
  let next: PressureState = { ...state, samples: [...state.samples] }
  if (resetsAt !== undefined && (state.windowResetsAt === undefined || Math.abs(resetsAt - state.windowResetsAt) > MINUTE)) {
    next = { p: p0, updatedAt: 0, samples: [], windowResetsAt: resetsAt }
  } else if (resetsAt === undefined && state.windowResetsAt !== undefined && now > state.windowResetsAt) {
    // The known window is over and this reading does not say when the next one ends.
    next = { p: 0, updatedAt: 0, samples: [] }
  }
  const last = next.samples[next.samples.length - 1]
  if (!last || now > last.t) next.samples.push({ t: now, u })
  next.samples = next.samples.filter(sample => sample.t >= now - 30 * MINUTE)

  if (now - next.samples[0]!.t < 10 * MINUTE) {
    return { ...next, p: u >= 80 ? 0.5 : p0, updatedAt: now }
  }
  if (next.updatedAt > 0 && now - next.updatedAt < 5 * MINUTE) return next

  const r = usageRate(next.samples, u, now)
  if (resetsAt === undefined || r === undefined) return { ...next, updatedAt: now }
  const R = Math.max(0, (resetsAt - now) / MINUTE)
  const F = u + r * R
  const a = Math.max(0, 90 - u) / Math.max(R, 1)
  if (F > 95) {
    next.p = clamp(next.p + Math.min(0.10, 0.20 * (r - a) / Math.max(r, 0.05)), 0, 0.8)
  } else if (F < 80) {
    next.p = Math.max(0, next.p - 0.10)
  }
  return { ...next, p: Math.round(next.p * 1000) / 1000, updatedAt: now }
}

export function forecast(state: PressureState, reading: ClaudeReading, now: number): number | undefined {
  if (!reading.fiveHour || reading.fiveHour.resetsAt === undefined) return undefined
  const { percentUsed: u, resetsAt } = reading.fiveHour
  const r = usageRate(state.samples, u, now)
  if (r === undefined) return undefined
  return u + r * Math.max(0, (resetsAt - now) / MINUTE)
}

export function pressure(state: PressureState, reading: ClaudeReading): number {
  const w = reading.sevenDay?.percentUsed ?? 0
  return Math.max(state.p, 0.25 * clamp((w - 75) / 15, 0, 1))
}

function currentWindows(codex: CodexReading, now: number): CodexWindow[] {
  return codex.windows.filter(window => window.resetsAt === undefined || now < window.resetsAt)
}

export function knownHeadroom(codex: CodexReading | undefined, config: Config, now: number): number | undefined {
  if (!codex || Math.abs(now - codex.readAt) > CODEX_MAX_AGE) return undefined
  if (codex.limitReached) return 0
  const windows = currentWindows(codex, now)
  if (!windows.length) return undefined
  return Math.min(...windows.map(window => {
    if (window.minutes <= 360) return window.usedPercent >= 90 ? 0 : 1
    const days = window.resetsAt === undefined ? 7 : Math.max(0, (window.resetsAt - now) / (1440 * MINUTE))
    return clamp((config.codexStopPercent - window.usedPercent) / (10 + 10 * clamp(days / 7, 0, 1)), 0, 1)
  }))
}

export function headroom(codex: CodexReading | undefined, config: Config, now: number): number {
  return knownHeadroom(codex, config, now) ?? 0
}

// Keep diagnostics safe for one-line status and refusal text, regardless of source.
export function shortProblem(problem: unknown): string | undefined {
  if (typeof problem !== 'string') return undefined
  return problem.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined
}

export function headroomCause(codex: CodexReading | undefined, config: Config, now: number, problem?: string): string | undefined {
  if (headroom(codex, config, now) > 0) return undefined
  const detail = shortProblem(problem ?? codex?.problem)
  const suffix = detail ? ` (${detail})` : ''
  if (codex?.limitReached) return 'Codex reported its limit' + suffix
  if (!codex || !codex.windows.length) return 'no Codex reading' + suffix
  if (now - codex.readAt > CODEX_MAX_AGE) return `Codex reading is ${Math.round((now - codex.readAt) / MINUTE)} minutes old` + suffix
  if (codex.readAt - now > CODEX_MAX_AGE) return `Codex reading is dated ${Math.round((codex.readAt - now) / MINUTE)} minutes ahead of the clock` + suffix
  const windows = currentWindows(codex, now)
  if (!windows.length) return 'all Codex windows have reset' + suffix
  const window = windows.find(window => window.usedPercent >= (window.minutes <= 360 ? 90 : config.codexStopPercent))
  if (!window) return 'no Codex headroom'
  const label = window.minutes === 10080 ? 'weekly' : `${window.minutes / 60}-hour`
  return `Codex ${label} use is ${Math.round(window.usedPercent)}%` + suffix
}

export function decide(input: { tier: Tier; P: number; g: number; mode: Mode; claudeKnown: boolean; limitFloor?: boolean; headroomProblem?: string }): { handOff: boolean; reason: string } {
  const { tier, P, g, mode, claudeKnown } = input
  if (mode === 'off') return { handOff: false, reason: 'crossfeed is off' }
  if (!claudeKnown && !input.limitFloor) return { handOff: false, reason: 'no Claude reading yet' }
  if (g <= 0) return { handOff: false, reason: input.headroomProblem ?? 'no Codex headroom' }
  if (tier === 'C') return { handOff: false, reason: 'tier C stays on Claude' }
  if (mode === 'always') return { handOff: true, reason: 'crossfeed is always on' }
  if (tier === 'A') {
    return g >= 0.5
      ? { handOff: true, reason: 'tier A has enough Codex headroom' }
      : { handOff: false, reason: 'Codex headroom is low' }
  }
  return P >= 0.3
    ? { handOff: true, reason: 'pressure is high enough' }
    : { handOff: false, reason: 'pressure is low' }
}


export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type ModelBucket = { label: string; family?: Family; usedPercent: number; resetsAt?: number }
export type UsageReading = { buckets: ModelBucket[]; readAt: number }
export type BucketState = 'ok' | 'ahead' | 'full' | 'unknown'
export type BucketView = { bucket: ModelBucket; state: BucketState; line?: number }

export function familyOf(model: string | undefined): Family | undefined {
  const name = model?.toLowerCase() ?? ''
  return (['fable', 'opus', 'sonnet', 'haiku'] as const).find(family => name.includes(family))
}

export function bucketState(bucket: ModelBucket, readAt: number, now: number, sevenDayResetsAt?: number): { state: BucketState; line?: number } {
  const reset = bucket.resetsAt ?? sevenDayResetsAt
  const line = reset === undefined ? undefined : 100 * clamp(1 - (reset - now) / (7 * 1440 * MINUTE), 0, 1)
  const state = now - readAt > 20 * MINUTE || readAt - now > 5 * MINUTE || (reset !== undefined && now >= reset) ? 'unknown'
    : bucket.usedPercent >= 100 ? 'full'
    : bucket.usedPercent >= 80 || (line !== undefined && bucket.usedPercent >= line + 5) ? 'ahead' : 'ok'
  return { state, line }
}

export function subagentFamily(callModel: string | undefined, inheritedModel: string | undefined): Family | undefined {
  return familyOf(!callModel || callModel === 'inherit' ? inheritedModel : callModel)
}

export const REWRITE_TYPES = ['general-purpose', 'claude', 'workflow-subagent'] as const

export const MODEL_RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

export function fallbackFor(from: Family, fallback: string, views: ReadonlyMap<Family, BucketView>): string | undefined {
  const family = familyOf(fallback)
  if (!fallback.trim() || !family || MODEL_RANK[family] >= MODEL_RANK[from]) return undefined
  const state = views.get(family)?.state
  return state === 'ahead' || state === 'full' ? undefined : fallback
}

export function rewriteModel(a: { mode: Mode; subagentType: string; model?: string; fork: boolean; parentModel: string; fallback: string; views: ReadonlyMap<Family, BucketView> }): { model: string; from: Family; view: BucketView } | undefined {
  if (a.mode === 'off' || a.fork || !REWRITE_TYPES.some(type => type === a.subagentType) || !a.fallback.trim()) return undefined
  const from = subagentFamily(a.model, a.parentModel)
  const view = from === undefined ? undefined : a.views.get(from)
  if (!from || !view || (view.state !== 'ahead' && view.state !== 'full')) return undefined
  if (view.state === 'ahead' && a.model && a.model !== 'inherit') return undefined
  const fallback = fallbackFor(from, a.fallback, a.views)
  return fallback === undefined ? undefined : { model: fallback, from, view }
}
