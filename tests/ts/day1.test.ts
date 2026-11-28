import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from '../../hooks/config'
import { createCore } from '../../hooks/core'
import { headroomCause, INITIAL_PRESSURE, updatePressure } from '../../hooks/policy'
import type { CodexReading } from '../../hooks/policy'
import { shellQuote, staticSection, stretchReminder } from '../../hooks/text'

const MINUTE = 60000
const BASE = 1794902400000
const RESET = BASE + 300 * MINUTE
const B = { prompt: 'Research the protocol and report the supported vendors with sources. '.repeat(4) }
const A = { prompt: 'Implement the parser and run pytest tests/test_parser.py. '.repeat(4) }
const reading = (percentUsed = 2, resetsAt = RESET) => ({ fiveHour: { percentUsed, resetsAt } })
const codex = (): CodexReading => ({ windows: [{ minutes: 10080, usedPercent: 24 }], limitReached: false, readAt: BASE })

for (const [name, value, now, cause] of [
  ['absent', undefined, BASE, 'no Codex reading'],
  ['empty', { ...codex(), windows: [] }, BASE, 'no Codex reading'],
  ['old', codex(), BASE + 180 * MINUTE, 'Codex reading is 180 minutes old'],
  ['limit with windows', { ...codex(), limitReached: true }, BASE, 'Codex reported its limit'],
  ['limit without windows', { ...codex(), windows: [], limitReached: true }, BASE, 'Codex reported its limit'],
  ['weekly', { ...codex(), windows: [{ minutes: 10080, usedPercent: 91 }] }, BASE, 'Codex weekly use is 91%'],
  ['short', { ...codex(), windows: [{ minutes: 300, usedPercent: 90 }] }, BASE, 'Codex 5-hour use is 90%'],
] satisfies [string, CodexReading | undefined, number, string][]) {
  test(`zero headroom cause: ${name}`, async () => {
    expect(headroomCause(value, DEFAULTS, now)).toBe(cause)
    const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
    core.measure(reading(), now)
    core.setCodex(value)
    expect(core.route(B, now)).toBe(undefined)
    expect(core.lastDecision().includes(cause)).toBe(true)
    expect(core.describe(now).includes(cause)).toBe(true)
  })
}

for (const problem of ['', 'cannot find codex\r\n检查\nretry', 'x'.repeat(1000)]) {
  test(`problem is bounded and retained without a reading (${problem.length} chars)`, async () => {
    const clean = problem.replace(/\s+/g, ' ').trim().slice(0, 200)
    const suffix = clean ? ` (${clean})` : ''
    const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
    core.measure(reading(), BASE)
    core.setCodex(undefined, problem)
    core.route(B, BASE)
    expect(core.lastDecision()).toBe(`last subagent call: stayed on Claude (no Codex reading${suffix})`)
    expect(headroomCause({ ...codex(), problem }, DEFAULTS, BASE + 16 * MINUTE)).toBe(`Codex reading is 16 minutes old${suffix}`)
    core.setCodex(codex())
    core.route(B, BASE)
    expect(core.describe(BASE).includes(clean || '()')).toBe(false)
  })
}

test('status distinguishes unavailable and stale at the exact freshness boundary', async () => {
  const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
  expect(core.status(BASE).includes('codex unavailable')).toBe(true)
  core.setCodex(codex())
  expect(core.status(BASE + 15 * MINUTE).includes('stale')).toBe(false)
  expect(core.status(BASE + 15 * MINUTE + 1).includes('codex wk 24% stale')).toBe(true)
})

for (const lockout of [false, true]) {
  test(`seven research calls in 73 seconds, previous lockout ${lockout}`, async () => {
    const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
    if (lockout) core.setLockout(BASE)
    core.setCodex(codex())
    for (const [index, seconds] of [0, 10, 20, 31, 44, 59, 73].entries()) {
      const now = BASE + seconds * 1000
      core.measure(reading(), now)
      const route = core.route(B, now)
      expect(route !== undefined).toBe(lockout || index >= 2)
      if (!lockout && index >= 2) {
        expect(route?.reason.includes('burst')).toBe(true)
        expect(route?.reason.includes('2 earlier subagent calls')).toBe(true)
        expect(core.lastDecision().includes(route!.reason)).toBe(true)
        expect(core.denial(route!, B, '/project', now).includes(route!.reason)).toBe(true)
      }
    }
    expect(core.describe(BASE + 73000).includes(`eligible calls stayed on Claude in 10 minutes: ${lockout ? 0 : 2}`)).toBe(true)
    if (!lockout) {
      expect(core.takeNotices()).toEqual([])
      for (let i = 0; i < 20; i++) expect(core.toolCall('Bash', false)).toBe(undefined)
    }
  })
}

for (const extra of [0, 1]) {
  test(`burst counts calls at ten minutes plus ${extra} ms`, async () => {
    const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
    core.measure(reading(), BASE)
    core.setCodex(codex())
    core.route(B, BASE)
    core.route(B, BASE)
    expect(core.route(B, BASE + 10 * MINUTE + extra) !== undefined).toBe(extra === 0)
  })
}

test('tier C and ineligible calls do not contribute to a burst; tier A stays do', async () => {
  const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
  core.measure(reading(), BASE)
  core.setCodex(codex())
  for (const call of [{ prompt: 'short' }, { ...B, agentId: 'child' }, { ...B, subagent_type: 'Explore' }]) core.route(call, BASE)
  expect(core.route(B, BASE)).toBe(undefined)
  core.setCodex({ ...codex(), windows: [{ minutes: 10080, usedPercent: 84 }] })
  expect(core.route(A, BASE)).toBe(undefined)
  core.setCodex(codex())
  expect(core.route(B, BASE)?.reason.includes('burst')).toBe(true)
})

for (const mode of ['auto', 'off', 'always'] as const) {
  test(`burst respects ${mode} and unavailable Codex`, async () => {
    const core = createCore({ ...DEFAULTS, mode }, '/plugin/crossfeed.py')
    core.measure(reading(), BASE)
    for (let i = 0; i < 7; i++) {
      expect(core.route(B, BASE + i * 1000)).toBe(undefined)
      expect(core.lastDecision().includes(mode === 'off' ? 'crossfeed is off' : 'no Codex reading')).toBe(true)
    }
    core.setCodex(codex())
    expect(core.route(B, BASE + 8000) !== undefined).toBe(mode !== 'off')
    if (mode === 'always') expect(core.lastDecision().includes('burst')).toBe(false)
  })
}

for (const [delta, expected] of [[-5 * MINUTE - 1, 0], [-5 * MINUTE, 0.3], [120 * MINUTE - 1, 0.3], [120 * MINUTE, 0], [-300 * MINUTE, 0]] as const) {
  test(`lockout window-start delta ${delta}`, async () => {
    expect(updatePressure(INITIAL_PRESSURE, reading(), BASE, BASE - delta).p).toBe(expected)
  })
}

test('lockout pressure cools after warmup, high usage overrides it, and unknown reset stays zero', async () => {
  const initial = updatePressure(INITIAL_PRESSURE, reading(), BASE, BASE)
  expect(initial.p).toBe(0.3)
  expect(updatePressure(initial, reading(), BASE + 10 * MINUTE, BASE).p).toBe(0.2)
  expect(updatePressure(INITIAL_PRESSURE, reading(80), BASE, BASE).p).toBe(0.5)
  expect(updatePressure(INITIAL_PRESSURE, reading(), BASE).p).toBe(0)
})

test('session lockout seeds only the next window and newer known reset wins', async () => {
  const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
  core.measure(reading(97), BASE)
  core.stopFailure('rate_limit', BASE)
  core.measure(reading(2), BASE + MINUTE)
  expect(core.status(BASE + MINUTE).endsWith('· pressure 0')).toBe(true)
  core.setCodex(codex())
  expect(core.route(B, BASE + MINUTE)).toBe(undefined)
  core.setLockout(BASE - 300 * MINUTE)
  core.setLockout(undefined)
  core.measure(reading(2, RESET + 300 * MINUTE), RESET)
  expect(core.status(RESET).endsWith('· pressure 0.3')).toBe(true)
})

for (const [age, expected] of [[30 * MINUTE - 1, 0.3], [30 * MINUTE, 0], [180 * MINUTE, 0]] as const) {
  test(`a session that starts ${age} ms into the window after a lockout begins at ${expected}`, async () => {
    expect(updatePressure(INITIAL_PRESSURE, reading(), BASE + age, BASE).p).toBe(expected)
  })
}

test('the start after a lockout is not restored by a pause or by a later session in the same window', async () => {
  const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
  core.setLockout(BASE)
  core.setCodex({ ...codex(), readAt: BASE + 61 * MINUTE })
  core.measure(reading(), BASE)
  expect(core.status(BASE).endsWith('· pressure 0.3')).toBe(true)
  for (const minute of [10, 15, 20]) core.measure(reading(), BASE + minute * MINUTE)
  expect(core.status(BASE + 20 * MINUTE).endsWith('· pressure 0')).toBe(true)
  // An hour without readings drops every sample, so the warm-up runs again.
  core.measure(reading(), BASE + 80 * MINUTE)
  expect(core.status(BASE + 80 * MINUTE).endsWith('· pressure 0')).toBe(true)
  expect(core.route(B, BASE + 80 * MINUTE)).toBe(undefined)
})

test('readings that lose their reset time do not keep the start after a lockout', async () => {
  const unknown = { fiveHour: { percentUsed: 2 } }
  let state = updatePressure(INITIAL_PRESSURE, reading(), BASE, BASE)
  expect(state.p).toBe(0.3)
  // Still inside the warm-up: without a reset time the window's age is unknown.
  expect(updatePressure(state, unknown, BASE + 5 * MINUTE, BASE).p).toBe(0)
  // After the warm-up the value is kept only until the known window ends.
  state = updatePressure(state, reading(), BASE + 9 * MINUTE, BASE)
  for (const minute of [12, 60, 299]) state = updatePressure(state, unknown, BASE + minute * MINUTE, BASE)
  expect(state.windowResetsAt).toBe(RESET)
  state = updatePressure(state, unknown, RESET + MINUTE, BASE)
  expect(state.p).toBe(0)
  expect(state.windowResetsAt).toBe(undefined)
  expect(state.samples.length).toBe(1)
  for (let hour = 1; hour <= 24; hour++) state = updatePressure(state, unknown, RESET + hour * 60 * MINUTE, BASE)
  expect(state.p).toBe(0)
})

test('a counted call that is refused downstream is forgotten, and only that call', async () => {
  const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
  core.measure(reading(), BASE)
  core.setCodex(codex())
  expect(core.lastStay()).toBe(undefined)
  for (const now of [BASE, BASE + 1000]) {
    expect(core.route(B, now)).toBe(undefined)
    expect(core.lastStay()).toBe(now)
    core.forgetStay(now)
  }
  core.forgetStay(BASE + 5)
  for (const call of [{ prompt: 'short' }, { ...B, subagent_type: 'Explore' }]) {
    core.route(call, BASE + 2000)
    expect(core.lastStay()).toBe(undefined)
  }
  expect(core.route(B, BASE + 3000)).toBe(undefined)
  expect(core.route(B, BASE + 3000)).toBe(undefined)
  core.forgetStay(BASE + 3000)
  expect(core.describe(BASE + 3000).includes('eligible calls stayed on Claude in 10 minutes: 1')).toBe(true)
  expect(core.route(B, BASE + 4000)).toBe(undefined)
  expect(core.route(B, BASE + 5000)?.reason.includes('burst')).toBe(true)
  expect(core.lastStay()).toBe(undefined)
})

for (const [name, value, cause] of [
  ['limit', { ...codex(), limitReached: true }, 'Codex reported its limit (app server down)'],
  ['weekly', { ...codex(), windows: [{ minutes: 10080, usedPercent: 91 }] }, 'Codex weekly use is 91% (app server down)'],
] satisfies [string, CodexReading, string][]) {
  test(`zero headroom cause keeps the dispatcher error: ${name}`, async () => {
    expect(headroomCause({ ...value, problem: 'app server\ndown' }, DEFAULTS, BASE)).toBe(cause)
  })
}

test('takeNotices drains once without resetting the stretch counter', async () => {
  const core = createCore({ ...DEFAULTS, stretchCalls: 2 }, '/plugin/crossfeed.py', "it's session")
  core.setCodex(codex())
  core.measure(reading(85), BASE)
  core.toolCall('Bash', false)
  expect(core.takeNotices().length).toBe(1)
  expect(core.takeNotices()).toEqual([])
  expect(core.toolCall('Bash', false)?.text.includes('--session ' + shellQuote("it's session"))).toBe(true)
  expect(core.userPrompt()).toEqual([])
  expect(core.toolCall('Bash', false)).toBe(undefined)
  expect(core.toolCall('Bash', false)).not.toBe(undefined)
})

test('reminder says when to add --write and quotes session; static guidance covers missing CLI', async () => {
  for (const session of [undefined, '', "it's; 检查"]) {
    const reminder = stretchReminder({ reasons: ['pressure'], calls: 12, u: 85, script: '/plugin/crossfeed.py', session })
    expect(reminder.includes('Add --write for work that should change project files.')).toBe(true)
    expect(reminder.includes('read-only')).toBe(false)
    expect(reminder.includes('--session')).toBe(session !== undefined)
    if (session !== undefined) expect(reminder.includes('--session ' + shellQuote(session))).toBe(true)
  }
  expect(staticSection('/plugin/crossfeed.py').includes('Exit code 127 means the codex CLI was not found: do the work yourself and tell the user.')).toBe(true)
})

for (const [early, expected] of [[5 * MINUTE, 0.3], [5 * MINUTE + 1, 0], [60 * MINUTE, 0]] as const) {
  test(`a reading for a window that begins ${early} ms from now starts at ${expected}`, async () => {
    const start = BASE + early
    expect(updatePressure(INITIAL_PRESSURE, reading(2, start + 300 * MINUTE), BASE, start).p).toBe(expected)
  })
}

test('a clock that goes back does not keep a burst or a Codex reading alive', async () => {
  const core = createCore(DEFAULTS, '/plugin/crossfeed.py')
  core.measure(reading(), BASE)
  core.setCodex(codex())
  core.route(B, BASE)
  core.route(B, BASE)
  const earlier = BASE - 60 * MINUTE
  expect(core.describe(earlier).includes('eligible calls stayed on Claude in 10 minutes: 0')).toBe(true)
  expect(core.codexAge(earlier)).toBe(60 * MINUTE)
  expect(core.status(earlier).includes('codex wk 24% stale')).toBe(true)
  expect(headroomCause(codex(), DEFAULTS, earlier)).toBe('Codex reading is dated 60 minutes ahead of the clock')
  expect(core.route(B, earlier)).toBe(undefined)
  expect(core.lastDecision().includes('ahead of the clock')).toBe(true)
  // With a reading taken on the new clock the earlier calls still do not count.
  core.setCodex({ ...codex(), readAt: earlier }, undefined, earlier)
  expect(core.route(B, earlier)).toBe(undefined)
  expect(core.lastDecision().includes('pressure is low')).toBe(true)
})
