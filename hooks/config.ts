export type Mode = 'auto' | 'always' | 'off'

export type Config = {
  mode: Mode
  effort: string
  model: string
  eligibleTypes: string[]
  stretchCalls: number
  codexStopPercent: number
  timeoutMinutes: number
}

export const DEFAULTS: Config = {
  mode: 'auto',
  effort: 'high',
  model: '',
  eligibleTypes: ['general-purpose', 'claude'],
  stretchCalls: 12,
  codexStopPercent: 85,
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
    model: typeof values.model === 'string' ? values.model : DEFAULTS.model,
    eligibleTypes: typeof values.eligibleTypes === 'string'
      ? values.eligibleTypes.split(',').map(type => type.trim()).filter(type => type.length > 0)
      : [...DEFAULTS.eligibleTypes],
    stretchCalls: positiveNumber(values.stretchCalls, DEFAULTS.stretchCalls),
    codexStopPercent: positiveNumber(values.codexStopPercent, DEFAULTS.codexStopPercent),
    timeoutMinutes: positiveNumber(values.timeoutMinutes, DEFAULTS.timeoutMinutes),
  }
}
