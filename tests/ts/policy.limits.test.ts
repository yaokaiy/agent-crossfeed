import { expect, test } from 'claude-code/testing'
import * as policy from '../../hooks/policy'
import type { BucketView, Family } from '../../hooks/policy'

const NOW = 1794902400000
const MINUTE = 60000
const DAY = 1440 * MINUTE
const bucket = { label: 'Fable', family: 'fable' as const, usedPercent: 62, resetsAt: NOW + 4.5 * DAY }

test('familyOf maps every form', async () => {
  for (const [model, family] of [
    ['fable', 'fable'], ['claude-fable-5-2', 'fable'], ['Fable 5.2', 'fable'], ['fable[1m]', 'fable'],
    ['opus', 'opus'], ['claude-opus-5-5', 'opus'], ['claude-sonnet-5-5', 'sonnet'], ['haiku', 'haiku'],
    ['inherit', undefined], ['', undefined], [undefined, undefined], ['gpt-6-astra', undefined],
  ] as const) expect(policy.familyOf(model)).toBe(family)
})

test('bucketState follows the even-pace line and freshness boundaries', async () => {
  for (const [usedPercent, state] of [[40, 'ok'], [40.8, 'ahead'], [100, 'full'], [104, 'full']] as const) {
    const view = policy.bucketState({ ...bucket, usedPercent }, NOW, NOW)
    expect(view.state).toBe(state)
    expect(Math.abs((view.line ?? 0) - 100 * 2.5 / 7) < 0.00001).toBe(true)
  }
  for (const [usedPercent, state] of [[79, 'ok'], [80, 'ahead']] as const) {
    expect(policy.bucketState({ ...bucket, usedPercent, resetsAt: undefined }, NOW, NOW)).toEqual({ state, line: undefined })
  }
  for (const [offset, state] of [[-21 * MINUTE, 'unknown'], [6 * MINUTE, 'unknown'], [-20 * MINUTE, 'ahead'], [5 * MINUTE, 'ahead']] as const) {
    expect(policy.bucketState(bucket, NOW + offset, NOW).state).toBe(state)
  }
  expect(policy.bucketState({ ...bucket, resetsAt: NOW - DAY }, NOW, NOW).line).toBe(100)
  expect(policy.bucketState({ ...bucket, resetsAt: NOW + 9 * DAY }, NOW, NOW).line).toBe(0)
  expect(policy.bucketState({ ...bucket, resetsAt: undefined }, NOW, NOW, bucket.resetsAt)).toEqual(policy.bucketState(bucket, NOW, NOW))
  expect(policy.bucketState(bucket, NOW, NOW, NOW + DAY)).toEqual(policy.bucketState(bucket, NOW, NOW))
  const line = policy.bucketState(bucket, NOW, NOW).line!
  expect(policy.bucketState({ ...bucket, usedPercent: line + 5 }, NOW, NOW).state).toBe('ahead')
  expect(policy.bucketState({ ...bucket, usedPercent: line + 5 - 0.0001 }, NOW, NOW).state).toBe('ok')
})

test('subagentFamily resolves only inherited calls through the parent', async () => {
  expect(policy.subagentFamily(undefined, 'claude-fable-5-2')).toBe('fable')
  expect(policy.subagentFamily('inherit', 'claude-fable-5-2')).toBe('fable')
  expect(policy.subagentFamily('opus', 'claude-fable-5-2')).toBe('opus')
  expect(policy.subagentFamily('', undefined)).toBe(undefined)
})

for (const resetOffset of [-MINUTE, 0, MINUTE]) {
  test(`ended weekly readings stop steering at reset offset ${resetOffset}`, async () => {
    const ended = { ...bucket, usedPercent: 100, resetsAt: NOW + resetOffset }
    const view = { bucket: ended, ...policy.bucketState(ended, NOW - 2 * MINUTE, NOW) }
    expect(view.state).toBe(resetOffset <= 0 ? 'unknown' : 'full')
    if (resetOffset <= 0) expect(view.line).toBe(100)
    expect(policy.bucketState({ ...ended, resetsAt: undefined }, NOW - 2 * MINUTE, NOW, ended.resetsAt)).toEqual({ state: view.state, line: view.line })
    const change = policy.rewriteModel({ mode: 'auto', subagentType: 'general-purpose', fork: false, parentModel: 'fable', fallback: 'opus', views: new Map([['fable', view]]) })
    expect(change?.model).toBe(resetOffset <= 0 ? undefined : 'opus')
  })
}

test('decide with limitFloor accepts a missing five-hour reading', async () => {
  const input = { tier: 'B' as const, P: 0.3, g: 1, mode: 'auto' as const, claudeKnown: false }
  expect(policy.decide({ ...input, limitFloor: true }).handOff).toBe(true)
  expect(policy.decide(input).reason).toBe('no Claude reading yet')
})

test('rewriteModel protects pinned types, explicit choices and scarce fallbacks', async () => {
  const view: BucketView = { bucket, state: 'ahead', line: 35.7 }
  const views = new Map<Family, BucketView>([['fable', view]])
  const input = { mode: 'auto' as const, subagentType: 'general-purpose', fork: false, parentModel: 'claude-fable-5-2', fallback: 'opus', views }
  const changed = { model: 'opus', from: 'fable', view }
  expect(policy.rewriteModel(input)).toEqual(changed)
  expect(policy.rewriteModel({ ...input, model: 'inherit' })).toEqual(changed)
  expect(policy.rewriteModel({ ...input, model: '' })).toEqual(changed)
  expect(policy.rewriteModel({ ...input, subagentType: 'claude' })).toEqual(changed)
  for (const overrides of [
    { model: 'fable' }, { subagentType: 'my-agent' }, { subagentType: 'Explore' }, { subagentType: 'web-fetch' },
    { fork: true }, { mode: 'off' as const }, { fallback: '' }, { fallback: 'fable' }, { parentModel: 'claude-opus-5-5' },
  ]) expect(policy.rewriteModel({ ...input, ...overrides })).toBe(undefined)
  for (const state of ['ok', 'unknown'] as const) {
    expect(policy.rewriteModel({ ...input, views: new Map([['fable', { ...view, state }]]) })).toBe(undefined)
  }
  for (const state of ['ahead', 'full'] as const) {
    expect(policy.rewriteModel({ ...input, views: new Map([...views, ['opus', { bucket: { ...bucket, family: 'opus' }, state }]]) })).toBe(undefined)
  }
  expect(policy.rewriteModel({ ...input, model: 'fable', views: new Map([['fable', { ...view, state: 'full' }]]) })?.model).toBe('opus')
})

for (const [from, fallback, fallbackState, expected] of [
  ['fable', 'opus', 'ok', 'opus'],
  ['sonnet', 'opus', 'ok', undefined],
  ['opus', 'haiku', 'unknown', 'haiku'],
  ['fable', 'claude-x-9', 'ok', undefined],
  ['fable', 'opus', 'ahead', undefined],
] as const) {
  test(`rewrite only to a cheaper available family: ${from} to ${fallback} (${fallbackState})`, async () => {
    const views = new Map<Family, BucketView>([[from, { bucket: { ...bucket, family: from, usedPercent: 85 }, state: 'ahead' }]])
    const family = policy.familyOf(fallback)
    if (family) views.set(family, { bucket: { ...bucket, family }, state: fallbackState })
    expect(policy.rewriteModel({ mode: 'auto', subagentType: 'general-purpose', fork: false, parentModel: from, fallback, views })?.model).toBe(expected)
  })
}

test('the account week needs a current reset and tolerates an old reading in the same week', async () => {
  const window = { percentUsed: 55, resetsAt: NOW + 3.5 * DAY }
  for (const absent of [undefined, { percentUsed: 100 }, { percentUsed: 100, resetsAt: NOW }, { percentUsed: 100, resetsAt: NOW - 1 }]) {
    expect(policy.accountWeekState(absent, NOW, NOW).state).toBe('unknown')
  }
  for (const readAt of [NOW - 3 * DAY, NOW, NOW + 5 * MINUTE]) {
    expect(policy.accountWeekState(window, readAt, NOW)).toEqual({ percent: 55, line: 50, resetsAt: window.resetsAt, state: 'ahead' })
  }
  expect(policy.accountWeekState(window, NOW + 5 * MINUTE + 1, NOW).state).toBe('unknown')
})

test('account pace has a five-point margin and an absolute 90 percent threshold', async () => {
  for (const [days, percentUsed, line, state] of [
    [3.5, 0, 50, 'ok'], [3.5, 54.99, 50, 'ok'], [3.5, 55, 50, 'ahead'], [8, 5, 0, 'ahead'],
    [0.4375, 85, 93.75, 'ok'], [0.4375, 89.99, 93.75, 'ok'], [0.4375, 90, 93.75, 'ahead'], [0.4375, 100, 93.75, 'full'],
  ] as const) {
    const resetsAt = NOW + days * DAY
    expect(policy.accountWeekState({ percentUsed, resetsAt }, NOW, NOW)).toEqual({ percent: percentUsed, resetsAt, line, state })
  }
})
