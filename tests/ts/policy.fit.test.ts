import { expect, test } from 'claude-code/testing'
import { DEFAULTS, toConfig } from '../../hooks/config'
import { clamp, eligible, fit } from '../../hooks/policy'
import type { AgentCall } from '../../hooks/policy'

const implementation = 'Implement the parser described in docs/plan.md. ' + 'Handle the documented input cases. '.repeat(7)

test('clamp preserves values within its bounds', async () => {
  expect(clamp(5, 0, 1)).toBe(1)
  expect(clamp(-1, 0, 1)).toBe(0)
  expect(clamp(0.5, 0, 1)).toBe(0.5)
})

test('eligible accepts absent and configured types and worktree isolation', async () => {
  for (const fields of [{}, { subagent_type: 'general-purpose' }, { subagent_type: 'claude' }, { isolation: 'worktree' }]) {
    expect(eligible({ prompt: implementation, ...fields }, DEFAULTS).ok).toBe(true)
  }
  expect(eligible({ prompt: implementation, subagent_type: 'custom' }, toConfig({ eligibleTypes: 'custom' })).ok).toBe(true)
})

test('eligible rejects calls that depend on Claude setup', async () => {
  const cases: [Partial<AgentCall>, string][] = [
    [{ subagent_type: 'Explore' }, 'type Explore keeps its own setup'],
    [{ subagent_type: 'fork' }, 'type fork keeps its own setup'],
    [{ subagent_type: '' }, 'type  keeps its own setup'],
    [{ model: 'haiku' }, 'haiku is already cheap'],
    [{ name: 'x' }, 'a named agent expects follow-up messages'],
  ]
  for (const [fields, reason] of cases) {
    expect(eligible({ prompt: implementation, ...fields }, DEFAULTS)).toEqual({ ok: false, reason })
  }
  expect(eligible({ prompt: implementation, isolation: 'remote' }, DEFAULTS).ok).toBe(false)
})

test('eligible rejects empty briefs and every unsupported tool pattern', async () => {
  for (const prompt of ['', '\r\n ']) {
    expect(eligible({ prompt }, DEFAULTS).ok).toBe(false)
  }
  for (const tool of ['mcp__claude-in-chrome__navigate', 'claude-in-chrome', 'computer-use', 'Claude_Browser', 'AskUserQuestion', 'SendMessage', 'Artifact tool', 'screenshot']) {
    expect(eligible({ prompt: `${implementation} Use ${tool}.` }, DEFAULTS)).toEqual({
      ok: false, reason: 'the brief needs a tool Codex lacks',
    })
  }
})

test('fit keeps short and design briefs on Claude before considering checks', async () => {
  for (const prompt of ['', '\r\n ', 'x'.repeat(60), ' '.repeat(50) + 'x'.repeat(99)]) {
    expect(fit({ prompt })).toEqual({ tier: 'C', reason: 'brief under 100 characters' })
  }
  expect(fit({ prompt: 'Design the API for the billing module. ' + implementation + ' Check: pytest' })).toEqual({
    tier: 'C', reason: 'design or front-end judgment',
  })
  expect(fit({ prompt: implementation, description: 'Review UI layout' }).tier).toBe('C')
})

test('fit requires a check command and implementation work for tier A', async () => {
  expect(fit({ prompt: implementation + ' Check: pytest tests/test_parser.py' })).toEqual({
    tier: 'A', reason: 'has a check command and is implementation-type work',
  })
  expect(fit({ prompt: implementation })).toEqual({ tier: 'B', reason: 'no check command' })
  const research = 'Research which vendors support X and report with sources. '.repeat(4)
  expect(fit({ prompt: research }).tier).toBe('B')
  expect(fit({ prompt: research + ' Check: pytest' })).toEqual({ tier: 'B', reason: 'not implementation-type work' })
})

test('fit limits design matching to the description and first 300 prompt characters', async () => {
  const prompt = 'Read the supplied documents. '.padEnd(1999, ' ') + 'design'
  expect(fit({ prompt })).toEqual({ tier: 'B', reason: 'no check command' })
})

test('fit handles non-ASCII and CRLF briefs and the exact length boundary', async () => {
  expect(fit({ prompt: 'Implement 检查 naïve parser.\r\n'.repeat(6) + 'Check: python3 -m unittest' }).tier).toBe('A')
  expect(fit({ prompt: 'x'.repeat(100) }).tier).toBe('B')
})

test('toConfig supplies defaults and splits eligible types', async () => {
  expect(toConfig(undefined)).toEqual(DEFAULTS)
  expect(toConfig({})).toEqual(DEFAULTS)
  expect(toConfig({ mode: 'loud', stretchCalls: -1, eligibleTypes: 'a, b ,' })).toEqual({
    ...DEFAULTS, eligibleTypes: ['a', 'b'],
  })
  expect(toConfig({ eligibleTypes: '' }).eligibleTypes).toEqual([])
})

test('toConfig validates types and finite positive numbers', async () => {
  for (const value of [0, -1, Infinity, -Infinity, NaN, '12', null]) {
    expect(toConfig({ stretchCalls: value, codexStopPercent: value, timeoutMinutes: value, shedPercent: value })).toEqual(DEFAULTS)
  }
  expect(toConfig({ mode: 1, effort: false, model: 1, eligibleTypes: ['a'] })).toEqual(DEFAULTS)
  expect(toConfig({ mode: 'always', effort: 'xhigh', model: 'm', stretchCalls: 2, codexStopPercent: 80, timeoutMinutes: 5 })).toEqual({
    ...DEFAULTS, mode: 'always', effort: 'xhigh', model: 'm', stretchCalls: 2, codexStopPercent: 80, timeoutMinutes: 5,
  })
  expect(toConfig({ mode: 'off', effort: '', model: '' }).mode).toBe('off')
  expect(toConfig({ shedPercent: 100, wake: false })).toEqual({ ...DEFAULTS, shedPercent: 100, wake: false })
  expect(toConfig({ shedPercent: 101, wake: 'false' })).toEqual(DEFAULTS)
})

test('fit recognises the spellings the documentation lists', async () => {
  const pad = ' Details follow in the rest of this brief so that it is long enough to be considered at all.'
  expect(fit({ prompt: 'Rework the front end of the settings page.' + pad }).tier).toBe('C')
  expect(fit({ prompt: 'We are brainstorming names for the new module.' + pad }).tier).toBe('C')
  expect(fit({ prompt: 'Make pass the suite in tests/test_parser.py again.' + pad + ' Check: pytest tests/test_parser.py' }).tier).toBe('A')
})

test('the Codex stop accepts a fractional percentage through 100 inclusive', async () => {
  for (const stop of [0.1, 85, 99.9, 100]) expect(toConfig({ codexStopPercent: stop }).codexStopPercent).toBe(stop)
  for (const stop of [0, -1, 100.1, 101, NaN, Infinity, '85']) expect(toConfig({ codexStopPercent: stop }).codexStopPercent).toBe(85)
})
