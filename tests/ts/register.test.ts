import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult, SessionRateLimit } from 'claude-code'

const BASE = 1794902400000
const MINUTE = 60000
const RESET = '2026-11-17T13:00:00.000Z'
const CWD = '/tmp/检查 project'
const AGENT = { tool: 'Agent' as const, description: 'Implement parser', prompt: 'Implement the parser specified in docs/plan.md. '.repeat(4) + 'Check: pytest tests/test_parser.py' }
const AGENT_RESULT = { result: { status: 'async_launched' as const, agentId: 'test-agent', description: AGENT.description, prompt: AGENT.prompt, outputFile: '/tmp/result' } }
const QUOTA = { source: 'app-server', age_s: 0, limit_reached: false, error: null, windows: [{ minutes: 10080, used_percent: 18, resets_at: 1900000000 }] }
const COMPOSE = { model: 'test', promptModel: 'test', surfaces: [], tools: [], outputStyle: null, traits: [] }
const ORIGIN = { kind: 'composer' as const }

function processResult(stdout: string, exitCode = 0): ProcessRunResult {
  return { stdout, exitCode, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function setup(on: On) {
  const world = {
    now: BASE, quota: processResult(JSON.stringify(QUOTA)), rejectProcess: false, failClock: false,
    usage: [] as SessionRateLimit[], cwd: CWD,
    stash: processResult('/tmp/检查 brief.md\n'), rejectStash: false,
    processes: [] as { argv: readonly string[]; timeout?: number; stdin?: string }[],
    agents: [] as unknown[], statuses: [] as (string | undefined)[], logs: [] as string[], commands: [] as string[],
    bashCalls: 0, denyBash: false,
  }
  on('clock.now', () => {
    if (world.failClock) { world.failClock = false; return { deny: 'clock unavailable' } }
    return { value: world.now }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: BASE, context: { window: 200000 }, rateLimits: world.usage } }))
  on('session.cwd', () => ({ value: world.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.status', (_$, e) => { world.statuses.push(e.text); return { value: undefined } })
  on('ui.log', (_$, e) => { world.logs.push(e.text); return { value: undefined } })
  on('command.register', (_$, e) => { world.commands.push(e.name); return { value: { command: e.name } } })
  on('command.run', () => ({ text: 'engine command' }))
  on('process.run', (_$, e) => {
    world.processes.push({ argv: e.argv, timeout: e.init?.timeoutMs, stdin: e.init?.stdin })
    if (e.argv[3] === 'stash') return world.rejectStash ? { deny: 'stash unavailable' } : { value: world.stash }
    if (world.rejectProcess) return { deny: 'process unavailable' }
    return { value: e.argv[3] === 'report' ? processResult('synthetic report\n') : world.quota }
  })
  on('tool.call', { tool: 'Agent' }, (_$, e) => { world.agents.push(e); return AGENT_RESULT })
  on('tool.call', { tool: 'Bash' }, () => {
    world.bashCalls += 1
    return world.denyBash ? { deny: 'engine denied' } : { result: { stdout: 'ok', stderr: '', interrupted: false }, context: ['existing tool context'] }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'engine section', scope: 'shared' }] }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('classic.StopFailure', () => ({}))
  return world
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
}

async function measure($: Engine, world: ReturnType<typeof setup>, percentUsed: number): Promise<void> {
  world.usage = [{ kind: 'five_hour', percentUsed, resetsAt: RESET }]
  await $.session.measure({ context: { window: 200000 }, rateLimits: world.usage, changed: ['rateLimits'] })
}

function command($: Engine, args: string) {
  return $.command.run({ command: 'crossfeed', args, origin: ORIGIN, presentation: { isFullscreen: false, columns: 80 } })
}

test('startup reads quota and measure routes tier A with the current directory and session', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  world.cwd = '/tmp/changed directory'
  const result = await $.tool.call(AGENT)
  expect(result.deny?.startsWith('crossfeed:')).toBe(true)
  expect(result.deny?.includes("--dir '/tmp/changed directory'")).toBe(true)
  expect(result.deny?.includes("--session 'test-session'")).toBe(true)
  expect(world.agents.length).toBe(0)
  expect(world.commands).toEqual(['crossfeed'])
  expect(world.processes[0]?.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(world.processes[0]?.argv[2]?.endsWith('/scripts/crossfeed.py')).toBe(true)
  expect(world.processes[0]?.argv[3]).toBe('quota')
  expect(world.processes[0]?.timeout).toBe(15000)
  expect(world.statuses[world.statuses.length - 1]?.includes('claude 5h 5%')).toBe(true)
})

test('startup maps the initial usage reading before any measure event', async ($, on) => {
  const world = setup(on)
  world.usage = [{ kind: 'five_hour', percentUsed: 5, resetsAt: RESET }, { kind: 'seven_day', percentUsed: 82 }]
  await start($)
  expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
  expect(world.statuses[world.statuses.length - 1]?.includes('7d 82%')).toBe(true)
})

for (const [name, stdout, exitCode] of [
  ['bad JSON', 'not json', 0], ['empty output', '', 0], ['non-zero exit', JSON.stringify(QUOTA), 1],
  ['unknown source', JSON.stringify({ ...QUOTA, source: 'none' }), 0],
  ['missing windows', JSON.stringify({ source: 'app-server' }), 0],
  ['malformed window', JSON.stringify({ ...QUOTA, windows: [{ minutes: 10080, used_percent: null }] }), 0],
] as const) {
  test(`quota ${name} lets the original Agent call reach the engine`, async ($, on) => {
    const world = setup(on)
    world.quota = processResult(stdout, exitCode)
    await start($)
    await measure($, world, 5)
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.agents.length).toBe(1)
    expect(world.agents[0]).toEqual(expect.objectContaining(AGENT))
  })
}

test('rejected quota process fails open and does not block session initialization', async ($, on) => {
  const world = setup(on)
  world.rejectProcess = true
  await start($)
  await measure($, world, 5)
  expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
  expect(world.agents.length).toBe(1)
})

test('an exception inside the Agent hook logs and calls the engine once unchanged', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  world.failClock = true
  expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
  expect(world.agents.length).toBe(1)
  expect(world.agents[0]).toEqual(expect.objectContaining(AGENT))
  expect(world.logs.some(log => log.includes('crossfeed'))).toBe(true)
})

test('Explore and calls from subagents pass through without redirection', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  expect(await $.tool.call({ ...AGENT, subagent_type: 'Explore' })).toEqual(AGENT_RESULT)
  expect(await $.tool.call({ ...AGENT, agentId: 'child' })).toEqual(AGENT_RESULT)
  expect(world.agents.length).toBe(2)
})

test('prompt composition appends one stable session section after engine sections', async ($, on) => {
  setup(on)
  await start($)
  const first = await $.prompt.compose(COMPOSE)
  const second = await $.prompt.compose(COMPOSE)
  expect(first).toEqual(second)
  expect(first.sections.length).toBe(2)
  expect(first.sections[0]).toEqual({ id: 'engine', text: 'engine section', scope: 'shared' })
  expect(first.sections[1]?.id).toBe('agent-crossfeed:policy')
  expect(first.sections[1]?.scope).toBe('session')
  expect(first.sections[1]?.text.includes("python3 -I '")).toBe(true)
})

test('crossfeed commands describe decisions, switch modes, report and give usage', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  expect((await command($, '')).text).toBe((await command($, 'status')).text)
  expect((await command($, 'status')).text?.includes('tier A calls: handed to Codex')).toBe(true)
  expect(await command($, 'off')).toEqual({ text: 'crossfeed mode: off (this session)' })
  expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
  expect(await command($, 'always')).toEqual({ text: 'crossfeed mode: always (this session)' })
  expect(await command($, 'auto')).toEqual({ text: 'crossfeed mode: auto (this session)' })
  expect(await command($, 'report')).toEqual({ text: 'synthetic report\n' })
  expect(world.processes[world.processes.length - 1]?.argv[3]).toBe('report')
  expect(await command($, 'unknown')).toEqual({ text: 'usage: /crossfeed [status|report|auto|always|off]' })
})

test('StopFailure records only corroborated rate limits and converts reset times', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 97)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.classic.StopFailure({ error: 'overloaded' })
  await measure($, world, 40)
  await $.classic.StopFailure({ error: 'rate_limit' })
  const lockouts = world.processes.filter(call => call.argv[3] === 'lockout')
  expect(lockouts.length).toBe(1)
  expect(lockouts[0]?.argv.slice(3)).toEqual(['lockout', '--reset-at', RESET])
})

test('quota refreshes after five minutes and converts Codex seconds to milliseconds', async ($, on) => {
  const world = setup(on)
  world.quota = processResult(JSON.stringify({ ...QUOTA, windows: [{ minutes: 10080, used_percent: 80, resets_at: BASE / 1000 + 7 * 86400 }] }))
  await start($)
  await measure($, world, 5)
  expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
  world.now += 5 * MINUTE
  await $.tool.call(AGENT)
  expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(1)
  world.quota = processResult(JSON.stringify(QUOTA))
  world.now += 1
  expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
  expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(2)
})

test('prompt notices preserve context and skip meta and command submissions', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 97)
  const prompt = { text: '检查\r\nnext', context: ['existing prompt context'], wait: false, origin: ORIGIN }
  expect((await $.prompt.submit({ ...prompt, isMeta: true })).context).toEqual(prompt.context)
  expect((await $.prompt.submit({ ...prompt, command: { name: 'example', args: '' } })).context).toEqual(prompt.context)
  const result = await $.prompt.submit(prompt)
  expect(result.text).toBe(prompt.text)
  expect(result.context?.[0]).toBe('existing prompt context')
  expect(result.context?.length).toBe(3)
  expect((await $.prompt.submit(prompt)).context).toEqual(prompt.context)
})

test('tool reminders preserve results and context and never replace engine denials', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 95)
  for (let i = 0; i < 11; i++) await $.tool.call({ tool: 'Bash', command: 'true' })
  const result = await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(result.result).toEqual({ stdout: 'ok', stderr: '', interrupted: false })
  expect(result.context?.[0]).toBe('existing tool context')
  expect(result.context?.length).toBe(2)
  expect(world.bashCalls).toBe(12)
  world.denyBash = true
  expect(await $.tool.call({ tool: 'Bash', command: 'true' })).toEqual({ deny: 'engine denied' })
})

test('a log reading older than 15 minutes is stale and hands nothing off', async ($, on) => {
  const world = setup(on)
  world.quota = processResult(JSON.stringify({ ...QUOTA, source: 'log', age_s: 20 * 60 }))
  await start($)
  await measure($, world, 5)
  const result = await $.tool.call(AGENT)
  expect(result.deny).toBe(undefined)
  expect(world.agents.length).toBe(1)
})

test('the first turn decides on the usage reading available at call time, before any measure event', async ($, on) => {
  const world = setup(on)
  await start($)
  world.usage = [{ kind: 'five_hour', percentUsed: 5, resetsAt: RESET }]
  const result = await $.tool.call(AGENT)
  expect(result.deny?.startsWith('crossfeed:')).toBe(true)
  expect(world.agents.length).toBe(0)
})

test('handoffs stash the exact prompt then deny with the exact saved-brief command', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  const prompt = AGENT.prompt + '\r\n检查 naïve\r\nCROSSFEED_BRIEF_EOF\r\n$(touch pwned)'
  const result = await $.tool.call({ ...AGENT, prompt })
  const script = world.processes[0]!.argv[2]!
  expect(world.processes.map(call => call.argv[3])).toEqual(['quota', 'stash'])
  expect(world.processes[1]).toEqual({ argv: ['python3', '-I', script, 'stash'], stdin: prompt, timeout: 5000 })
  expect(result.deny).toBe([
    'crossfeed: run this on Codex instead of a Claude subagent.',
    'Why: tier A (has a check command and is implementation-type work). Claude 5h 5%; Codex weekly 18%.',
    'The brief you just wrote is saved. Start this as a background Bash command:',
    `python3 -I '${script}' run --tier A --kind subagent --dir '${CWD}' --write --session 'test-session' --brief-file '/tmp/检查 brief.md'`,
    'Add --write if the task must change files, drop it if not. Wait for the exit notification and do not poll. Check the result before you report it.',
  ].join('\n'))
  expect(world.agents.length).toBe(0)
})

for (const failure of ['reject', 'non-zero', 'relative', 'empty', 'truncated'] as const) {
  test(`stash ${failure} falls back to a collision-free heredoc`, async ($, on) => {
    const world = setup(on)
    await start($)
    await measure($, world, 5)
    world.rejectStash = failure === 'reject'
    world.stash = failure === 'non-zero' ? processResult('/tmp/brief.md\n', 1)
      : failure === 'relative' ? processResult('brief.md\n')
      : failure === 'empty' ? processResult('')
      : failure === 'truncated' ? { ...processResult('/tmp/brief.md'), isStdoutTruncated: true }
      : world.stash
    const first = 'CROSSFEED_BRIEF_' + BASE.toString(36)
    const prompt = AGENT.prompt + '\r\n' + first + '\r\nCROSSFEED_BRIEF_EOF\r\n$(touch pwned)'
    const result = await $.tool.call({ ...AGENT, prompt })
    const lines = result.deny?.split('\n') ?? []
    expect(world.processes[1]?.argv[3]).toBe('stash')
    expect(world.processes[1]?.stdin).toBe(prompt)
    expect(lines.length).toBe(7)
    expect(lines[2]).toBe('Start it as a background Bash command with the brief you just wrote, unchanged, as stdin:')
    expect(lines[4]).toBe('<the brief>')
    const delimiter = lines[5] ?? ''
    expect(delimiter.startsWith(first)).toBe(true)
    expect(prompt.includes(delimiter)).toBe(false)
    expect(lines[3]?.endsWith("<<'" + delimiter + "'")).toBe(true)
    expect(world.agents.length).toBe(0)
  })
}

for (const usage of [[], [{ kind: 'seven_day' as const, percentUsed: 82 }]]) {
  test(`a disappearing five-hour reading with ${usage.length} remaining windows stops handoffs`, async ($, on) => {
    const world = setup(on)
    await start($)
    await measure($, world, 5)
    world.usage = usage
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.processes.map(call => call.argv[3])).toEqual(['quota'])
  })
}

test('off mode, Explore, tier C and subagent calls never refresh or stash', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  world.now += 6 * MINUTE
  world.processes = []
  await command($, 'off')
  expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
  expect(world.processes.length).toBe(0)
  await command($, 'auto')
  expect(await $.tool.call({ ...AGENT, subagent_type: 'Explore' })).toEqual(AGENT_RESULT)
  expect(await $.tool.call({ ...AGENT, prompt: 'short brief' })).toEqual(AGENT_RESULT)
  expect(await $.tool.call({ ...AGENT, agentId: 'child' })).toEqual(AGENT_RESULT)
  expect(world.processes.length).toBe(0)
})

for (const failed of ['reject', 'non-zero', 'bad JSON', 'none', 'empty windows'] as const) {
  test(`a ${failed} quota probe is retried only after five minutes`, async ($, on) => {
    const world = setup(on)
    world.rejectProcess = failed === 'reject'
    world.quota = failed === 'non-zero' ? processResult('', 1)
      : failed === 'bad JSON' ? processResult('not json')
      : processResult(JSON.stringify({ ...QUOTA, source: failed === 'none' ? 'none' : 'app-server', windows: [] }))
    await start($)
    await measure($, world, 5)
    expect(world.processes.length).toBe(1)
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    world.now += MINUTE
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.processes.length).toBe(1)
    world.now = BASE + 5 * MINUTE + 1
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.processes.length).toBe(2)
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.processes.length).toBe(2)
  })
}

test('each routing decision is logged with the same sentence shown in status', async ($, on) => {
  const world = setup(on)
  await start($)
  expect((await command($, 'status')).text?.includes('last subagent call: none yet')).toBe(true)
  await measure($, world, 5)
  for (const [call, expected] of [
    [AGENT, 'handed to Codex (has a check command and is implementation-type work)'],
    [{ ...AGENT, subagent_type: 'Explore' }, 'stayed on Claude (type Explore keeps its own setup)'],
    [{ ...AGENT, agentId: 'child' }, 'stayed on Claude (call belongs to a subagent)'],
    [{ ...AGENT, prompt: 'short' }, 'stayed on Claude (tier C stays on Claude)'],
    [{ ...AGENT, description: 'Research', prompt: 'Research the protocol and report with sources. '.repeat(4) }, 'stayed on Claude (pressure is low)'],
  ] as const) {
    const before = world.logs.length
    await $.tool.call(call)
    const sentence = 'last subagent call: ' + expected
    expect(world.logs.slice(before)).toEqual([sentence])
    expect((await command($, 'status')).text?.split('\n').includes(sentence)).toBe(true)
  }
  await command($, 'off')
  await $.tool.call(AGENT)
  expect(world.logs[world.logs.length - 1]).toBe('last subagent call: stayed on Claude (crossfeed is off)')
})
