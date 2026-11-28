import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from '../../hooks/config'
import { CODEX_MAX_AGE, INITIAL_PRESSURE, codexStop, codexSurplus, decide, forecast, headroom, headroomCause, pressure, shortWindow, updatePressure } from '../../hooks/policy'
import type { ClaudeReading, CodexReading, PressureState, Tier } from '../../hooks/policy'

const BASE = 1794902400000
const MINUTE = 60000
const DAY = 1440 * MINUTE
const RESET = BASE + 300 * MINUTE

function reading(u: number, resetsAt = RESET): ClaudeReading {
  return { fiveHour: { percentUsed: u, resetsAt } }
}

function replay(usage: (minute: number) => number, end: number): PressureState[] {
  const states: PressureState[] = []
  let state = INITIAL_PRESSURE
  for (let minute = 0; minute <= end; minute += 5) {
    state = updatePressure(state, reading(usage(minute)), BASE + minute * MINUTE)
    states.push(state)
  }
  return states
}

function weekly(usedPercent: number, days?: number): CodexReading {
  return {
    windows: [{ minutes: 10080, usedPercent, ...(days === undefined ? {} : { resetsAt: BASE + days * DAY }) }],
    limitReached: false,
    readAt: BASE,
  }
}

test('heavy window builds pressure and forecasts 300 percent at minute 10', async () => {
  const states = replay(t => t, 100)
  expect(states[1]!.p).toBe(0)
  expect(states[2]!.p).toBe(0.1)
  expect(states[4]!.p).toBe(0.3)
  expect(states.every(state => state.p >= 0 && state.p <= 0.8)).toBe(true)
  expect(forecast(states[2]!, reading(10), BASE + 10 * MINUTE)).toBe(300)
})

test('light window keeps pressure at zero for all 300 minutes', async () => {
  expect(replay(t => 40 * t / 300, 300).every(state => state.p === 0)).toBe(true)
})

test('pressure falls by a tenth every five minutes after usage has been flat for ten', async () => {
  const states = replay(t => Math.min(t, 30), 100)
  expect(states.slice(7, 13).map(state => state.p)).toEqual([0.6, 0.5, 0.4, 0.3, 0.2, 0.1])
  expect(states.slice(13).every(state => state.p === 0)).toBe(true)
})

test('decreasing usage produces a zero slope', async () => {
  const first = updatePressure(INITIAL_PRESSURE, reading(60), BASE)
  const next = updatePressure(first, reading(40), BASE + 10 * MINUTE)
  expect(forecast(next, reading(40), BASE + 10 * MINUTE)).toBe(40)
  expect(next.p).toBe(0)
})

test('short window uses the configured shed line and expires at reset or ten minutes', async () => {
  const known = { percentUsed: 85, at: BASE, resetsAt: RESET }
  const unknown = { percentUsed: 85, at: BASE }
  expect(shortWindow(INITIAL_PRESSURE, known, RESET - 1, 85)?.shed).toBe(true)
  expect(shortWindow(INITIAL_PRESSURE, known, RESET - 1, 86)?.shed).toBe(false)
  expect(shortWindow(INITIAL_PRESSURE, known, RESET, 85)).toBe(undefined)
  expect(shortWindow(INITIAL_PRESSURE, unknown, BASE + 10 * MINUTE - 1, 85)?.shed).toBe(true)
  expect(shortWindow(INITIAL_PRESSURE, unknown, BASE + 10 * MINUTE, 85)).toBe(undefined)
})

test('short pace needs ten minutes of rising use and fills within 15 minutes strictly before reset', async () => {
  function pace(before: number, percentUsed: number, elapsed: number, resetsAt: number) {
    const at = BASE + elapsed * MINUTE
    const initial = updatePressure(INITIAL_PRESSURE, reading(before, resetsAt), BASE)
    const state = updatePressure(initial, reading(percentUsed, resetsAt), at)
    return shortWindow(state, { percentUsed, at, resetsAt }, at, 85)
  }
  expect(pace(40, 64, 10, RESET)).toEqual(expect.objectContaining({ pace: true, shed: false, minutesLeft: 15 }))
  expect(pace(40, 63, 10, RESET)?.pace).toBe(false)
  expect(pace(40, 64, 10, BASE + 25 * MINUTE)?.pace).toBe(false)
  expect(pace(40, 64, 10, BASE + 24 * MINUTE)?.pace).toBe(false)
  expect(pace(64, 64, 10, RESET)?.pace).toBe(false)
  expect(pace(80, 64, 10, RESET)?.pace).toBe(false)
  expect(pace(20, 84, 9, RESET)?.pace).toBe(false)
})

test('a past reset uses zero remaining minutes without division by zero', async () => {
  const first = updatePressure(INITIAL_PRESSURE, reading(80, BASE - MINUTE), BASE)
  const next = updatePressure(first, reading(90, BASE - MINUTE), BASE + 10 * MINUTE)
  expect(forecast(next, reading(90, BASE - MINUTE), BASE + 10 * MINUTE)).toBe(90)
  expect(next.p).toBe(0.5)
})

test('readings six hours apart discard stale history and keep pressure bounded', async () => {
  const first = updatePressure(INITIAL_PRESSURE, reading(50), BASE)
  const next = updatePressure(first, reading(95), BASE + 360 * MINUTE)
  expect(next.samples).toEqual([{ t: BASE + 360 * MINUTE, u: 95 }])
  expect(next.p).toBe(0.5)
  expect(forecast(next, reading(95), BASE + 360 * MINUTE)).toBe(undefined)
})

test('first readings at 80 and 95 percent start at pressure 0.5', async () => {
  expect(updatePressure(INITIAL_PRESSURE, reading(79), BASE).p).toBe(0)
  expect(updatePressure(INITIAL_PRESSURE, reading(80), BASE).p).toBe(0.5)
  expect(updatePressure(INITIAL_PRESSURE, reading(95), BASE).p).toBe(0.5)
})

test('new windows clear pressure and samples but reset jitter does not', async () => {
  const previous = replay(t => t, 20)[4]!
  const jitter = updatePressure(previous, reading(25, RESET + MINUTE), BASE + 25 * MINUTE)
  expect(jitter.samples.length).toBe(6)
  const next = updatePressure(previous, reading(1, RESET + MINUTE + 1), BASE + 25 * MINUTE)
  expect(next.samples).toEqual([{ t: BASE + 25 * MINUTE, u: 1 }])
  expect(next.p).toBe(0)
  expect(next.windowResetsAt).toBe(RESET + MINUTE + 1)
})

test('usage above 100 percent never raises pressure above 0.8', async () => {
  const states = replay(() => 130, 100)
  expect(states.every(state => state.p >= 0 && state.p <= 0.8)).toBe(true)
  expect(states[20]!.p).toBe(0.5)
})

test('weekly-only and absent readings leave pressure state unchanged', async () => {
  const state = replay(t => t, 20)[4]!
  expect(updatePressure(state, { sevenDay: { percentUsed: 90 } }, BASE + 25 * MINUTE)).toBe(state)
  expect(updatePressure(state, {}, BASE + 25 * MINUTE)).toBe(state)
})

test('updates preserve input state and retain only the last thirty minutes', async () => {
  const states = replay(t => t, 35)
  expect(INITIAL_PRESSURE).toEqual({ p: 0, updatedAt: 0, samples: [] })
  expect(states[0]!.samples).toEqual([{ t: BASE, u: 0 }])
  expect(states[7]!.samples.length).toBe(7)
  expect(states[7]!.samples[0]).toEqual({ t: BASE + 5 * MINUTE, u: 5 })
})

test('irregular samples use the latest sample at least ten minutes old', async () => {
  let state = INITIAL_PRESSURE
  for (const [minute, u] of [[0, 0], [2, 1], [7, 5], [13, 12]] as const) {
    state = updatePressure(state, reading(u), BASE + minute * MINUTE)
  }
  expect(forecast(state, reading(12), BASE + 13 * MINUTE)).toBe(299)
  expect(state.p).toBe(0.1)
})

test('pressure updates at most once per five minutes after warmup', async () => {
  const previous = replay(t => t, 10)[2]!
  const next = updatePressure(previous, reading(14), BASE + 14 * MINUTE)
  expect(next.p).toBe(0.1)
  expect(next.updatedAt).toBe(BASE + 10 * MINUTE)
  expect(next.samples.length).toBe(4)
  expect(updatePressure(next, reading(15), BASE + 15 * MINUTE).p).toBe(0.2)
})

test('duplicate and out-of-order times do not append samples', async () => {
  const state = updatePressure(INITIAL_PRESSURE, reading(95), BASE)
  for (const now of [BASE, BASE - MINUTE]) {
    const next = updatePressure(state, reading(95), now)
    expect(next.samples).toEqual(state.samples)
    expect(next.p).toBe(0.5)
    expect(forecast(next, reading(95), now)).toBe(undefined)
  }
})

test('missing reset preserves established pressure and forecast needs sufficient data', async () => {
  const previous = replay(t => t, 20)[4]!
  const noReset: ClaudeReading = { fiveHour: { percentUsed: 25 } }
  const next = updatePressure(previous, noReset, BASE + 25 * MINUTE)
  expect(next.p).toBe(0.3)
  expect(next.updatedAt).toBe(BASE + 25 * MINUTE)
  expect(forecast(next, noReset, BASE + 25 * MINUTE)).toBe(undefined)
  expect(forecast(next, {}, BASE + 25 * MINUTE)).toBe(undefined)
  expect(forecast(INITIAL_PRESSURE, reading(0), BASE)).toBe(undefined)
})

test('weekly pressure is bounded and combines with five-hour pressure by maximum', async () => {
  for (const [percentUsed, expected] of [[90, 0.25], [75, 0], [60, 0], [130, 0.25]] as const) {
    expect(pressure(INITIAL_PRESSURE, { sevenDay: { percentUsed } })).toBe(expected)
  }
  expect(pressure({ ...INITIAL_PRESSURE, p: 0.5 }, { sevenDay: { percentUsed: 90 } })).toBe(0.5)
  expect(pressure(INITIAL_PRESSURE, {})).toBe(0)
})

test('headroom rejects unknown, empty, exhausted and stale readings', async () => {
  expect(headroom(undefined, DEFAULTS, BASE)).toBe(0)
  expect(headroom({ windows: [], limitReached: false, readAt: BASE }, DEFAULTS, BASE)).toBe(0)
  expect(headroom({ ...weekly(18, 5), limitReached: true }, DEFAULTS, BASE)).toBe(0)
  expect(headroom(weekly(18, 5), DEFAULTS, BASE + 16 * MINUTE)).toBe(0)
  expect(headroom(weekly(18, 5), DEFAULTS, BASE + 15 * MINUTE)).toBe(1)
})

test('headroom scales weekly capacity by days until reset and configured stop percent', async () => {
  for (const [used, days, expected] of [[18, 5, 1], [80, 7, 0.25], [80, 0, 0], [80, -1, 0], [85, 7, 0], [130, 7, 0], [80, 14, 0.25]] as const) {
    expect(headroom(weekly(used, days), DEFAULTS, BASE)).toBe(expected)
  }
  expect(headroom(weekly(80), DEFAULTS, BASE)).toBe(0.25)
  expect(headroom(weekly(80, 7), { ...DEFAULTS, codexStopPercent: 90 }, BASE)).toBe(0.5)
})

test('headroom takes the minimum across windows and treats six hours as short', async () => {
  for (const minutes of [300, 360]) {
    for (const [usedPercent, expected] of [[89, 1], [90, 0], [91, 0]] as const) {
      const codex = weekly(10, 5)
      codex.windows.push({ minutes, usedPercent })
      expect(headroom(codex, DEFAULTS, BASE)).toBe(expected)
    }
  }
  expect(headroom({ windows: [{ minutes: 361, usedPercent: 80 }], limitReached: false, readAt: BASE }, DEFAULTS, BASE)).toBe(0.25)
})

test('auto decision table uses exact tier A headroom and tier B pressure boundaries', async () => {
  const cases: [Tier, number, number, boolean][] = [
    ['A', 0, 0.5, true], ['A', 0.8, 0.49, false], ['A', 0, 1, true],
    ['B', 0.3, 0.01, true], ['B', 0.29, 1, false], ['B', 0.8, 0, false],
    ['C', 0.8, 1, false], ['C', 0, 0.5, false],
  ]
  for (const [tier, P, g, handOff] of cases) {
    expect(decide({ tier, P, g, mode: 'auto', claudeKnown: true }).handOff).toBe(handOff)
  }
  expect(decide({ tier: 'A', P: 0.8, g: 0.49, mode: 'auto', claudeKnown: true }).reason).toBe('Codex headroom is low')
  expect(decide({ tier: 'B', P: 0.29, g: 1, mode: 'auto', claudeKnown: true }).reason).toBe('pressure is low')
})

test('off, missing readings and tier C veto always in the specified order', async () => {
  const input = { tier: 'A' as Tier, P: 0, g: 1, mode: 'always' as const, claudeKnown: true }
  expect(decide({ ...input, mode: 'off', claudeKnown: false, g: 0 })).toEqual({ handOff: false, reason: 'crossfeed is off' })
  expect(decide({ ...input, claudeKnown: false, g: 0 })).toEqual({ handOff: false, reason: 'no Claude reading yet' })
  expect(decide({ ...input, g: 0, tier: 'C' })).toEqual({ handOff: false, reason: 'no Codex headroom' })
  expect(decide({ ...input, g: -1 })).toEqual({ handOff: false, reason: 'no Codex headroom' })
  expect(decide({ ...input, tier: 'C' })).toEqual({ handOff: false, reason: 'tier C stays on Claude' })
  for (const tier of ['A', 'B'] as Tier[]) {
    expect(decide({ ...input, tier, g: 0.01 }).handOff).toBe(true)
  }
})

test('Codex surplus needs a fresh reading and a live long window with a reset', async () => {
  const week = weekly(20, 3.5)
  for (const value of [
    undefined, { ...week, windows: [] }, { ...week, windows: [{ minutes: 360, usedPercent: 0, resetsAt: RESET }] },
    { ...week, limitReached: true }, weekly(0), weekly(0, 0), weekly(0, -1),
    { ...week, readAt: BASE - CODEX_MAX_AGE - 1 }, { ...week, readAt: BASE + CODEX_MAX_AGE + 1 },
  ]) expect(codexSurplus(value, DEFAULTS, BASE)).toBe(undefined)
  for (const readAt of [BASE - CODEX_MAX_AGE, BASE, BASE + CODEX_MAX_AGE]) {
    expect(codexSurplus({ ...week, readAt }, DEFAULTS, BASE)).toEqual({ points: 30, onAt: 15, offAt: 10 })
  }
})

test('surplus uses the longest window and its own duration, and the stop sets the threshold near the reset', async () => {
  const window = { minutes: 14 * 1440, usedPercent: 40, resetsAt: BASE + 7 * DAY }
  const value = weekly(5, 1)
  value.windows.push(window)
  for (const windows of [value.windows, [...value.windows].reverse()]) {
    expect(codexSurplus({ ...value, windows }, DEFAULTS, BASE)).toEqual({ points: 10, onAt: 15, offAt: 10 })
    expect(codexSurplus({ ...value, windows }, { ...DEFAULTS, codexStopPercent: 100 }, BASE)).toEqual({ points: 10, onAt: 15, offAt: 10 })
  }
  expect(codexSurplus(weekly(10, 8), DEFAULTS, BASE)).toEqual({ points: -10, onAt: 15, offAt: 10 })
  expect(codexSurplus(weekly(70, 1.75), DEFAULTS, BASE)).toEqual({ points: 5, onAt: 10.625, offAt: 7.083333 })
  expect(codexSurplus(weekly(80, 0.875), DEFAULTS, BASE)).toEqual({ points: 7.5, onAt: 5.3125, offAt: 3.541667 })
  expect(codexSurplus(weekly(80, 0.875), { ...DEFAULTS, codexStopPercent: 50 }, BASE)).toEqual({ points: 7.5, onAt: 3.125, offAt: 2.083333 })
  // Decimal inputs land exactly on decimal thresholds at a millionth of a point, whatever the binary fraction.
  expect(codexSurplus(weekly(5, 5.6), DEFAULTS, BASE)).toEqual({ points: 15, onAt: 15, offAt: 10 })
  expect(codexSurplus(weekly(55.6, 2.1), { ...DEFAULTS, codexStopPercent: 96 }, BASE)).toEqual({ points: 14.4, onAt: 14.4, offAt: 9.6 })
  expect(codexSurplus(weekly(55.2, 2.94), { ...DEFAULTS, codexStopPercent: 20 }, BASE)).toEqual({ points: 2.8, onAt: 4.2, offAt: 2.8 })
})

test('stops match the literal fixtures that tests/py/test_quota.py checks for the dispatcher', async () => {
  const week = (stop: number, msLeft?: number) => codexStop(
    { minutes: 10080, usedPercent: 0, ...(msLeft === undefined ? {} : { resetsAt: BASE + msLeft }) }, { ...DEFAULTS, codexStopPercent: stop }, BASE)
  expect(week(0.2, 2000)).toBe(99.99967)
  expect(week(85, 0.875 * DAY)).toBe(98.125)
  expect(week(85.1234)).toBe(85.1234)
  expect(week(0.0001)).toBe(0.0001)
  expect(week(85, 7 * DAY)).toBe(85)
  // A reset a fraction of a millisecond short of a 361-minute window rounds to a whole millisecond: no time elapsed.
  expect(codexStop({ minutes: 361, usedPercent: 0, resetsAt: BASE + 21659999.625 }, { ...DEFAULTS, codexStopPercent: 10 }, BASE)).toBe(10)
  // Lengths and resets too large for milliseconds keep the configured stop, or clamp to the window.
  expect(codexStop({ minutes: 1e308, usedPercent: 0 }, DEFAULTS, BASE)).toBe(85)
  expect(codexStop({ minutes: 10080, usedPercent: 0, resetsAt: 1e308 }, DEFAULTS, BASE)).toBe(85)
  expect(codexSurplus({ windows: [{ minutes: 1e308, usedPercent: 0, resetsAt: BASE + DAY }], limitReached: false, readAt: BASE }, DEFAULTS, BASE)).toBe(undefined)
})

test('headroom is exactly one half when the margin is half the taper', async () => {
  // A stop of 80 with 96% of the week left is 80.8; the taper is 19.6 and 71% used leaves 9.8 points.
  const codex = weekly(71, 6.72)
  expect(headroom(codex, { ...DEFAULTS, codexStopPercent: 80 }, BASE)).toBe(0.5)
  expect(decide({ tier: 'A', P: 0, g: headroom(codex, { ...DEFAULTS, codexStopPercent: 80 }, BASE), mode: 'auto', claudeKnown: true }).handOff).toBe(true)
})

test('the long-window stop rises from the configured stop to 100 at the reset', async () => {
  for (const [days, stop] of [[undefined, 85], [14, 85], [7, 85], [3.5, 92.5], [1.75, 96.25], [0.875, 98.125], [0, 100]] as const) {
    expect(codexStop(weekly(0, days).windows[0]!, DEFAULTS, BASE)).toBe(stop)
  }
  expect(codexStop(weekly(0, 3.5).windows[0]!, { ...DEFAULTS, codexStopPercent: 100 }, BASE)).toBe(100)
  expect(codexStop({ minutes: 360, usedPercent: 0, resetsAt: BASE + DAY }, DEFAULTS, BASE)).toBe(90)
  // With no time elapsed, or no reset, the stop is exactly the configured value, so use at it gives no headroom.
  for (const stop of [0.1, 0.2, 85.5]) {
    for (const days of [undefined, 7, 14]) {
      expect(codexStop(weekly(0, days).windows[0]!, { ...DEFAULTS, codexStopPercent: stop }, BASE)).toBe(stop)
      expect(headroom(weekly(stop, days), { ...DEFAULTS, codexStopPercent: stop }, BASE)).toBe(0)
    }
  }
  // 85% used with 21 hours left keeps full headroom; at the stop it is zero and the cause names it.
  expect(headroom(weekly(85, 0.875), DEFAULTS, BASE)).toBe(1)
  expect(headroom(weekly(92.5, 0.875), DEFAULTS, BASE)).toBe(0.5)
  expect(headroom(weekly(98.125, 0.875), DEFAULTS, BASE)).toBe(0)
  expect(headroomCause(weekly(98.125, 0.875), DEFAULTS, BASE)).toBe('Codex weekly use is 98%')
  expect(headroomCause(weekly(98, 0.875), DEFAULTS, BASE)).toBe(undefined)
})

test('expired windows neither consume headroom nor explain another window’s stop', async () => {
  const expired = { minutes: 300, usedPercent: 100, resetsAt: BASE }
  const fresh = weekly(20, 1)
  fresh.windows.unshift(expired)
  expect(headroom(fresh, DEFAULTS, BASE)).toBe(1)
  expect(headroomCause(fresh, DEFAULTS, BASE)).toBe(undefined)
  const stopped = { ...fresh, windows: [expired, ...weekly(98, 1).windows] }
  expect(headroomCause(stopped, DEFAULTS, BASE)).toBe('Codex weekly use is 98%')
  expect(headroomCause({ ...fresh, windows: [expired] }, DEFAULTS, BASE)).toBe('all Codex windows have reset')
})
