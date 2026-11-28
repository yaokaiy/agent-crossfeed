export type Mode = 'auto' | 'always' | 'off'

export type Config = {
  mode: Mode
  effort: string
  model: string
  premiumFallback: string
  eligibleTypes: string[]
  stretchCalls: number
  codexStopPercent: number
  shedPercent: number
  wake: boolean
  approveStages: boolean
  timeoutMinutes: number
}

export const DEFAULTS: Config = {
  mode: 'auto',
  effort: 'high',
  model: '',
  premiumFallback: 'opus',
  eligibleTypes: ['general-purpose', 'claude'],
  stretchCalls: 12,
  codexStopPercent: 85,
  shedPercent: 85,
  wake: true,
  approveStages: false,
  timeoutMinutes: 30,
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function toConfig(options: Record<string, unknown> | undefined): Config {
  const values = options ?? {}
  return {
    mode: values.mode === 'auto' || values.mode === 'always' || values.mode === 'off' ? values.mode : DEFAULTS.mode,
    effort: typeof values.effort === 'string' ? values.effort : DEFAULTS.effort,
    premiumFallback: typeof values.premiumFallback === 'string' ? values.premiumFallback : DEFAULTS.premiumFallback,
    model: typeof values.model === 'string' ? values.model : DEFAULTS.model,
    eligibleTypes: typeof values.eligibleTypes === 'string'
      ? values.eligibleTypes.split(',').map(type => type.trim()).filter(type => type.length > 0)
      : [...DEFAULTS.eligibleTypes],
    stretchCalls: positiveNumber(values.stretchCalls, DEFAULTS.stretchCalls),
    codexStopPercent: typeof values.codexStopPercent === 'number' && values.codexStopPercent > 0 && values.codexStopPercent <= 100
      ? values.codexStopPercent : DEFAULTS.codexStopPercent,
    shedPercent: typeof values.shedPercent === 'number' && values.shedPercent > 0 && values.shedPercent <= 100
      ? values.shedPercent : DEFAULTS.shedPercent,
    wake: typeof values.wake === 'boolean' ? values.wake : DEFAULTS.wake,
    approveStages: typeof values.approveStages === 'boolean' ? values.approveStages : DEFAULTS.approveStages,
    timeoutMinutes: positiveNumber(values.timeoutMinutes, DEFAULTS.timeoutMinutes),
  }
}
