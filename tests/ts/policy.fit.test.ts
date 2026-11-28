import { expect, test } from 'claude-code/testing'
import { DEFAULTS, toConfig } from '../../hooks/config'
import { ANSWER_FIELD_SCHEMA, clamp, eligible, fit, parseStage, stageAnswer, strictCompatible } from '../../hooks/policy'
import type { AgentCall } from '../../hooks/policy'

const implementation = 'Implement the parser described in docs/plan.md. ' + 'Handle the documented input cases. '.repeat(7)

test('stage contracts preserve the brief and default executor and kind', async () => {
  const parse = (prompt: string, subagentType = 'workflow-subagent') => parseStage({ prompt, subagentType })
  const block = (json: string) => '```crossfeed-stage\n' + json + '\n```\n'
  expect(parse('')).toBe(undefined)
  expect(parse('A prompt mentioning crossfeed-stage.')).toBe(undefined)
  expect(parse(block('bad'), 'general-purpose')).toBe(undefined)
  expect(parse(block('{"v":1,"id":"review一"}') + 'Read the design.')).toEqual({
    id: 'review一', executor: 'auto', kind: 'review', schema: undefined, brief: 'Read the design.',
  })
  const fenced = '\ufeff ```crossfeed-stage\r\n\ufeff{"v":1,"id":"r","executor":"codex","kind":"research","schema":{"type":"object"}}\r\n\ufeff ```\r\n'
  expect(parse('检查\r\n' + fenced + 'Retain this.\r\n')).toEqual({
    id: 'r', executor: 'codex', kind: 'research', schema: { type: 'object' }, brief: '检查\r\nRetain this.\r\n',
  })
})

test('stage contracts refuse malformed, duplicate and unsupported declarations', async () => {
  const parse = (prompt: string) => parseStage({ prompt, subagentType: 'workflow-subagent' })
  const block = (json: string) => '```crossfeed-stage\n' + json + '\n```\n'
  const valid = block('{"v":1,"id":"r"}')
  const cases = [
    [valid + valid, 'exactly one'], ['```crossfeed-stage\n{"v":1,"id":"r"}', 'unclosed'],
    [block('invalid JSON'), 'invalid JSON'], [block('[]'), 'JSON object'],
    [block('{"v":2,"id":"r"}'), 'must be 1'], [block('{"v":1,"id":" "}'), 'non-empty'],
    [block('{"v":1,"id":"r","executor":"claude"}'), 'executor must'],
    [block('{"v":1,"id":"r","kind":"design"}'), 'kind must'],
    [block('{"v":1,"id":"r","schema":[]}'), 'schema must'],
    [block('{"v":1,"id":"r","executor":"codex"}'), 'requires schema'],
  ] as const
  for (const [prompt, reason] of cases) {
    const result = parse(prompt)
    expect(result && 'error' in result && result.error.includes(reason)).toBe(true)
  }
})

test('stage contracts follow CommonMark fence boundaries', async () => {
  const parse = (prompt: string) => parseStage({ prompt, subagentType: 'workflow-subagent' })
  const declaration = '{"v":1,"id":"example"}'
  const block = '```crossfeed-stage\n' + declaration + '\n```\n'
  expect(parse(block.trimEnd().split('\n').map(line => '    ' + line).join('\n'))).toBe(undefined)
  expect(parse('```npm test```\n' + block)).toEqual({
    id: 'example', executor: 'auto', kind: 'review', schema: undefined, brief: '```npm test```\n',
  })
  expect(parse('````markdown\n' + block + '````\n')).toBe(undefined)
  expect(parse('~~~crossfeed-stage\n' + declaration + '\n~~~\n')).toBe(undefined)
  expect(parse('~~~markdown\n' + block + '~~~\n')).toBe(undefined)
  expect(parse('   ```` crossfeed-stage example\r\n' + declaration + '\r\n   `````   \r\n')).toEqual({
    id: 'example', executor: 'auto', kind: 'review', schema: undefined, brief: '',
  })
})

test('stage contracts accept CR-only lines and closing fence tabs', async () => {
  for (const ending of ['\r', '\r\n', '\n']) {
    const prompt = ['Review 检查.', '```crossfeed-stage', '{"v":1,"id":"cr"}', '``` \t', 'Keep this.'].join(ending)
    expect(parseStage({ prompt, subagentType: 'workflow-subagent' })).toEqual({
      id: 'cr', executor: 'auto', kind: 'review', schema: undefined, brief: 'Review 检查.' + ending + 'Keep this.',
    })
  }
})

function closedObject(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

test('strict compatibility covers supported keywords, nested objects and local definitions', async () => {
  const schema = {
    ...closedObject({
      text: { type: 'string', minLength: 1, maxLength: 30, pattern: '@', format: 'email', enum: ['a@b.example'], title: 'Contact', description: 'Contact email' },
      number: { type: 'number', minimum: 1, maximum: 9, exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 1 },
      rows: { type: 'array', items: closedObject({ enabled: { type: 'boolean', const: true } }), minItems: 1, maxItems: 9 },
      option: { anyOf: [{ $ref: '#/$defs/entry~1one' }, { type: 'null' }] },
      copy: { $ref: '#/$defs/entry~1one' },
    }),
    $defs: { 'entry/one': closedObject({ '检查': { type: ['string', 'null'] } }) },
  }
  expect(strictCompatible(schema)).toBe(true)
  expect(strictCompatible(closedObject({}))).toBe(true)
})

test('strict compatibility rejects open objects, optional fields and uncertain schemas', async () => {
  for (const schema of [
    {}, { type: 'string' }, { type: 'object', required: [], additionalProperties: false },
    { ...closedObject({}), additionalProperties: true },
    { ...closedObject({ name: { type: 'string' } }), required: [] },
    closedObject({ nested: { type: 'object', properties: {}, required: [] } }),
    closedObject({ ref: { $ref: '#/$defs/missing' } }),
    closedObject({ ref: { $ref: '#/definitions/item' } }),
    closedObject({ ref: { $ref: 'https://example.invalid/schema#/$defs/item' } }),
    closedObject({ value: { type: 'string', default: 'x' } }),
    closedObject({ values: { type: 'array', items: [{ type: 'string' }] } }),
    { ...closedObject({}), anyOf: [closedObject({})] },
  ]) expect(strictCompatible(schema)).toBe(false)
})

test('strict compatibility enforces aggregate depth, property and enum boundaries', async () => {
  const nested = (depth: number): Record<string, unknown> => depth === 1 ? closedObject({})
    : closedObject({ child: nested(depth - 1) })
  expect(strictCompatible(nested(5))).toBe(true)
  expect(strictCompatible(nested(6))).toBe(false)
  const ref = (depth: number) => ({ ...closedObject({ child: { $ref: '#/$defs/entry' } }), $defs: { entry: nested(depth) } })
  expect(strictCompatible(ref(4))).toBe(true)
  expect(strictCompatible(ref(5))).toBe(false)
  const properties = (count: number) => closedObject({ nested: closedObject(Object.fromEntries(
    Array.from({ length: count }, (_, index) => ['p' + index, { type: 'string' }]),
  )) })
  expect(strictCompatible(properties(99))).toBe(true)
  expect(strictCompatible(properties(100))).toBe(false)
  const enums = (second: number) => closedObject(Object.fromEntries([125, second].map((count, index) => [
    'p' + index, { type: 'integer', enum: Array.from({ length: count }, (_, value) => value) },
  ])))
  expect(strictCompatible(enums(125))).toBe(true)
  expect(strictCompatible(enums(126))).toBe(false)
})

test('strict compatibility bounds the serialized schema size, so long enum values take the brief path', async () => {
  const closed = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
  expect(strictCompatible(closed({ choice: { type: 'string', enum: ['x'.repeat(120_001)] } }))).toBe(false)
  const sized = (length: number) => {
    const schema = closed({ text: { type: 'string', description: '' } })
    const base = JSON.stringify(schema).length
    ;(schema.properties.text as { description: string }).description = '界'.repeat(length - base)
    return schema
  }
  expect(JSON.stringify(sized(15_000)).length).toBe(15_000)
  expect(strictCompatible(sized(15_000))).toBe(true)
  expect(strictCompatible(sized(15_001))).toBe(false)
})

test('a strict stage answer is the whole final message', async () => {
  const strict = { type: 'object', properties: { '检查': { type: 'integer' } }, required: ['检查'], additionalProperties: false }
  expect(stageAnswer('\uFEFF\r\n{"检查": 3}\r\n', strict)).toEqual({ value: { '检查': 3 }, json: '{"检查": 3}' })
  for (const number of ['9007199254740993', '1e400', '-0', '0.10000000000000000001'])
    expect((stageAnswer(`{"检查": ${number}}`, strict) as { json: string }).json).toBe(`{"检查": ${number}}`)
  for (const result of ['', 'Done.\n{"检查": 3}', '```json\n{"检查": 3}\n```'])
    expect(stageAnswer(result, strict)).toEqual({ error: 'the final message is not JSON' })
})

test('a wrapped stage answer is the JSON text in the answer field, whatever its prose', async () => {
  const loose = { type: 'object', properties: { note: { type: 'string' } } }
  expect(strictCompatible(loose)).toBe(false)
  expect(strictCompatible(ANSWER_FIELD_SCHEMA as never)).toBe(true)
  const value = { note: 'a ``` fence, an unmatched ] and 检查', nested: [null, 1.5, { ok: true }] }
  expect(stageAnswer(JSON.stringify({ answer: JSON.stringify(value) }), loose)).toEqual({ value, json: JSON.stringify(value) })
  for (const inner of ['[1,2]', '"text"', 'null', '0']) expect(stageAnswer(JSON.stringify({ answer: inner }), loose)).toEqual({ value: JSON.parse(inner), json: inner })
  for (const number of ['9007199254740993', '1e400'])
    expect((stageAnswer(JSON.stringify({ answer: ` {"n": ${number}}\r\n` }), loose) as { json: string }).json).toBe(`{"n": ${number}}`)
  const big = { text: 'x'.repeat(1024 * 1024) }
  expect((stageAnswer(JSON.stringify({ answer: JSON.stringify(big) }), loose) as { json: string }).json.length).toBe(JSON.stringify(big).length)
  expect(stageAnswer('{"answer": "> ```python\\n> {\\"example\\":true}"}', loose)).toEqual({ error: 'the answer field is not JSON' })
  expect(stageAnswer('{"answer": 3}', loose)).toEqual({ error: 'the final message has no answer field' })
  expect(stageAnswer('[{"answer": "{}"}]', loose)).toEqual({ error: 'the final message has no answer field' })
  expect(stageAnswer('Example:\n~~~json\n{"note":"x"}', loose)).toEqual({ error: 'the final message is not JSON' })
})

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
