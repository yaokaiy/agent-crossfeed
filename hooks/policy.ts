import type { Config, Mode } from './config'

export type Tier = 'A' | 'B' | 'C'
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
  sevenDay?: { percentUsed: number }
}
export type CodexWindow = { minutes: number; usedPercent: number; resetsAt?: number }
export type CodexReading = { windows: CodexWindow[]; limitReached: boolean; readAt: number }
export type PressureState = {
  p: number
  updatedAt: number
  samples: { t: number; u: number }[]
  windowResetsAt?: number
}

export const INITIAL_PRESSURE: PressureState = { p: 0, updatedAt: 0, samples: [] }

const MINUTE = 60000

function usageRate(samples: PressureState['samples'], u: number, now: number): number | undefined {
  if (samples.length < 2) return undefined
  let ref = samples[0]!
  for (const sample of samples) {
    if (sample.t <= now - 10 * MINUTE) ref = sample
  }
  const elapsed = (now - ref.t) / MINUTE
  return elapsed > 0 ? Math.max(0, (u - ref.u) / elapsed) : undefined
}

export function updatePressure(state: PressureState, reading: ClaudeReading, now: number): PressureState {
  if (!reading.fiveHour) return state
  const { percentUsed: u, resetsAt } = reading.fiveHour
  let next = { ...state, samples: [...state.samples] }
  if (resetsAt !== undefined && (state.windowResetsAt === undefined || Math.abs(resetsAt - state.windowResetsAt) > MINUTE)) {
    next = { p: 0, updatedAt: 0, samples: [], windowResetsAt: resetsAt }
  }
  const last = next.samples[next.samples.length - 1]
  if (!last || now > last.t) next.samples.push({ t: now, u })
  next.samples = next.samples.filter(sample => sample.t >= now - 30 * MINUTE)

  if (now - next.samples[0]!.t < 10 * MINUTE) {
    return { ...next, p: u >= 80 ? 0.5 : 0, updatedAt: now }
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

export function headroom(codex: CodexReading | undefined, config: Config, now: number): number {
  if (!codex || !codex.windows.length || codex.limitReached || now - codex.readAt > 15 * MINUTE) return 0
  return Math.min(...codex.windows.map(window => {
    if (window.minutes <= 360) return window.usedPercent >= 90 ? 0 : 1
    const days = window.resetsAt === undefined ? 7 : Math.max(0, (window.resetsAt - now) / (1440 * MINUTE))
    return clamp((config.codexStopPercent - window.usedPercent) / (10 + 10 * clamp(days / 7, 0, 1)), 0, 1)
  }))
}

export function decide(input: { tier: Tier; P: number; g: number; mode: Mode; claudeKnown: boolean }): { handOff: boolean; reason: string } {
  const { tier, P, g, mode, claudeKnown } = input
  if (mode === 'off') return { handOff: false, reason: 'crossfeed is off' }
  if (!claudeKnown) return { handOff: false, reason: 'no Claude reading yet' }
  if (g <= 0) return { handOff: false, reason: 'no Codex headroom' }
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
