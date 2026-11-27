import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, ProcessRunResult, RenderSurface, SessionRateLimit } from 'claude-code'
import type { BackgroundRow } from '../../hooks/core'
import type { BackgroundState } from '../../types'

const BASE = 1794902400000
const MINUTE = 60000
const RESET = '2026-11-17T13:00:00.000Z'
const CWD = '/tmp/检查 project'
const AGENT = { tool: 'Agent' as const, description: 'Implement parser', prompt: 'Implement the parser specified in docs/plan.md. '.repeat(4) + 'Check: pytest tests/test_parser.py' }
const AGENT_RESULT = { result: { status: 'async_launched' as const, agentId: 'test-agent', description: AGENT.description, prompt: AGENT.prompt, outputFile: '/tmp/result' } }
const QUOTA = { source: 'app-server', age_s: 0, limit_reached: false, error: null, app_server_error: null, windows: [{ minutes: 10080, used_percent: 18, resets_at: 1900000000 }] }
const COMPOSE = { model: 'test', promptModel: 'test', surfaces: [], tools: [], outputStyle: null, traits: [] }
const ORIGIN = { kind: 'composer' as const }

function processResult(stdout: string, exitCode = 0): ProcessRunResult {
  return { stdout, exitCode, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function setup(on: On) {
  const world = {
    sessionId: 'test-session', failSessionId: false, sessionIdReads: 0,
    model: 'opus', failModel: false, claudeUsage: processResult(JSON.stringify({ source: 'usage', age_s: 0, error: null, buckets: [] })),
    usageProcesses: [] as { argv: readonly string[]; timeout?: number }[],
    spawns: [] as AgentSpawnInput[], spawnModel: undefined as string | undefined, denySpawn: false,
    failUsage: false, failDowngrade: false, downgradeExit: 0,
    now: BASE, quota: processResult(JSON.stringify(QUOTA)), rejectProcess: false, failClock: false,
    usage: [] as SessionRateLimit[], cwd: CWD,
    lockout: processResult('{"reset_at":null}'), processFailure: '',
    stash: processResult('/tmp/检查 brief.md\n'), rejectStash: false,
    processes: [] as { argv: readonly string[]; timeout?: number; stdin?: string }[],
    agents: [] as unknown[], statuses: [] as (string | undefined)[], logs: [] as string[], commands: [] as string[],
    bashCalls: 0, denyBash: false, denyAgent: false, failStatus: false,
    holdProbes: false, openProbes: 0, mostOpenProbes: 0, duringQuota: undefined as (() => void) | undefined,
    usageGate: undefined as Promise<void> | undefined,
    // Decision records have their own trace so the legacy process trace stays intact.
    decisions: [] as { argv: readonly string[]; timeout?: number; stdin?: string }[], decisionsDone: 0,
    decisionGate: undefined as Promise<void> | undefined, decisionFailure: '' as '' | 'throw' | 'deny' | 'nonzero' | 'opaque',
    nudges: [] as { argv: readonly string[]; timeout?: number; stdin?: string }[],
    nudgeGate: undefined as Promise<void> | undefined, nudgeFailure: '' as '' | 'throw' | 'nonzero' | 'deny',
    decisionsDoneAtAgent: [] as number[], atAgent: undefined as (() => void) | undefined,
    stashGate: undefined as Promise<void> | undefined, sequence: [] as string[],
    quotaGate: undefined as Promise<void> | undefined, throwAgent: false,
    modelReads: 0, holdModelReadAt: 0, modelGate: undefined as Promise<void> | undefined, modelHeld: false,
    usageReads: 0, holdUsageReadAt: 0, usageReadGate: undefined as Promise<void> | undefined, usageHeld: false,
    clockReads: 0, holdClockReadAt: 0, clockGate: undefined as Promise<void> | undefined, clockHeld: false,
    // Per-probe results for `claude-usage`, used in order before the default result.
    usageQueue: [] as { result: ProcessRunResult; gate?: Promise<void> }[],
    nextAgentId: 'spawned' as string | undefined, workflowTaskId: 'workflow-task', runId: 'wf_test',
    background: new Map<string, BackgroundState>(), surfaces: [] as RenderSurface[],
    checks: [] as string[], stops: [] as string[], stopGate: undefined as Promise<void> | undefined,
    verdicts: new Map<string, 'deny' | 'ask'>(), stopErrors: new Map<string, string>(),
    stopDeniedReason: 'a TaskStop rule' as string | undefined,
    wakePrompts: [] as string[], toasts: [] as string[], wakeGate: undefined as Promise<void> | undefined,
    records: [] as BackgroundRow[][], recordGate: undefined as Promise<void> | undefined,
    writers: 0, maxWriters: 0,
  }
  on('clock.now', async () => {
    world.clockReads += 1
    if (world.clockReads === world.holdClockReadAt) {
      world.clockHeld = true
      await world.clockGate
    }
    if (world.failClock) { world.failClock = false; return { deny: 'clock unavailable' } }
    return { value: world.now }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', async () => {
    // The reply carries the usage as it was when the read was asked for, even if it is held.
    const rateLimits = world.usage
    world.usageReads += 1
    if (world.usageReads === world.holdUsageReadAt) {
      world.usageHeld = true
      await world.usageReadGate
    }
    return { value: { startedAt: BASE, context: { window: 200000 }, rateLimits } }
  })
  on('session.cwd', () => ({ value: world.cwd }))
  on('session.model', async () => {
    // As for usage, a held reply carries the model in use when it was asked for.
    const model = world.model
    world.modelReads += 1
    if (world.modelReads === world.holdModelReadAt) {
      world.modelHeld = true
      await world.modelGate
    }
    if (world.failModel) throw new Error('model unavailable')
    return { value: model }
  })
  on('agent.spawn', (_$, e) => {
    world.spawns.push(e)
    return world.denySpawn ? { deny: 'engine denied spawn' } : { model: world.spawnModel ?? e.model ?? 'claude-fable-5-2', agentId: world.nextAgentId }
  })
  on('session.id', () => {
    world.sessionIdReads += 1
    if (world.failSessionId) throw new Error('session id unavailable')
    return { value: world.sessionId }
  })
  on('ui.status', (_$, e) => {
    if (world.failStatus) throw new Error('status unavailable')
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => { world.logs.push(e.text); return { value: undefined } })
  on('ui.toast', (_$, e) => { world.toasts.push(e.text); return { value: undefined } })
  on('session.surfaces', () => ({ value: world.surfaces }))
  on('state.get', (_$, e) => ({ value: { version: 0, value: world.background.get(e.id ?? '') } }))
  on('state.set', (_$, e) => {
    world.background.set(e.id ?? '', e.value as BackgroundState)
    return { value: { isSet: true, version: 1 } }
  })
  on('command.register', (_$, e) => { world.commands.push(e.name); return { value: { command: e.name } } })
  on('command.run', () => ({ text: 'engine command' }))
  on('process.run', async (_$, e) => {
    if (e.argv[3] === 'record') {
      world.records.push((e.init?.stdin ?? '').trim().split('\n').map(line => JSON.parse(line) as BackgroundRow))
      world.writers += 1
      world.maxWriters = Math.max(world.maxWriters, world.writers)
      await world.recordGate
      world.writers -= 1
      return { value: processResult('') }
    }
    world.sequence.push(e.argv[3] ?? '')
    if (e.argv[3] === 'nudge') {
      world.nudges.push({ argv: e.argv, timeout: e.init?.timeoutMs, stdin: e.init?.stdin })
      await world.nudgeGate
      if (world.nudgeFailure === 'throw') throw Object.create(null)
      if (world.nudgeFailure === 'deny') return { deny: 'ledger unavailable' }
      return { value: processResult('', world.nudgeFailure === 'nonzero' ? 2 : 0) }
    }
    if (e.argv[3] === 'decision') {
      world.decisions.push({ argv: e.argv, timeout: e.init?.timeoutMs, stdin: e.init?.stdin })
      await world.decisionGate
      world.decisionsDone += 1
      if (world.decisionFailure === 'throw') throw new Error('ledger unavailable')
      // An error value that cannot be turned into a string.
      if (world.decisionFailure === 'opaque') throw Object.create(null)
      if (world.decisionFailure === 'deny') return { deny: 'ledger denied' }
      return { value: processResult('', world.decisionFailure === 'nonzero' ? 2 : 0) }
    }
    // A held probe waits a few turns of the event loop for the other probe to start, so a test can see them overlap.
    if (world.holdProbes && (e.argv[3] === 'quota' || e.argv[3] === 'claude-usage')) {
      world.openProbes += 1
      world.mostOpenProbes = Math.max(world.mostOpenProbes, world.openProbes)
      for (let i = 0; i < 100 && world.openProbes < 2; i++) await Promise.resolve()
      world.openProbes -= 1
    }
    // Keep the legacy process trace intact; new usage probes have their own complete trace.
    if (e.argv[3] === 'claude-usage') {
      world.usageProcesses.push({ argv: e.argv, timeout: e.init?.timeoutMs })
      const queued = world.usageQueue.shift()
      if (queued) {
        await queued.gate
        return { value: queued.result }
      }
      await world.usageGate
      if (world.failUsage) throw new Error('usage unavailable')
      return { value: world.claudeUsage }
    }
    world.processes.push({ argv: e.argv, timeout: e.init?.timeoutMs, stdin: e.init?.stdin })
    if (e.argv[3] === 'downgrade') {
      if (world.failDowngrade) throw new Error('ledger unavailable')
      return { value: processResult('', world.downgradeExit) }
    }
    if (e.argv[3] === 'stash') {
      await world.stashGate
      return world.rejectStash ? { deny: 'stash unavailable' } : { value: world.stash }
    }
    if (world.processFailure) throw new Error(world.processFailure)
    if (world.rejectProcess) return { deny: 'process unavailable' }
    if (e.argv[3] === 'lockout') return { value: world.lockout }
    if (e.argv[3] === 'quota') {
      const quota = world.quota
      world.duringQuota?.()
      await world.quotaGate
      return { value: quota }
    }
    return { value: e.argv[3] === 'report' ? processResult('synthetic report\n') : world.quota }
  })
  on('tool.call', { tool: 'Agent' }, (_$, e) => {
    world.agents.push(e)
    world.decisionsDoneAtAgent.push(world.decisionsDone)
    world.atAgent?.()
    if (world.throwAgent) throw new Error('engine failed the call')
    return world.denyAgent ? { deny: 'engine denied' } : AGENT_RESULT
  })
  on('tool.call', { tool: 'Bash' }, () => {
    world.bashCalls += 1
    return world.denyBash ? { deny: 'engine denied' } : { result: { stdout: 'ok', stderr: '', interrupted: false }, context: ['existing tool context'] }
  })
  on('tool.call', { tool: 'Workflow' }, () => ({ result: {
    status: 'async_launched', taskId: world.workflowTaskId, runId: world.runId,
  } }))
  on('tool.check', { tool: 'TaskStop' }, (_$, e) => {
    // This fixture controls the preflight query. Let the synthetic tool run after it passes.
    if (e.tool_use_id !== undefined) return { decision: 'allow' }
    const id = (e.input as { task_id: string }).task_id
    world.checks.push(id)
    const decision = world.verdicts.get(id) ?? 'allow'
    return { decision, reason: decision === 'deny' ? world.stopDeniedReason : undefined }
  })
  on('tool.call', { tool: 'TaskStop' }, async (_$, e) => {
    const id = e.task_id ?? ''
    world.stops.push(id)
    await world.stopGate
    const error = world.stopErrors.get(id)
    const result = { message: error ?? 'Successfully stopped task', task_id: id, task_type: 'test' }
    return error ? { result, isError: true, text: error } : { result }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'engine section', scope: 'shared' }] }))
  on('prompt.submit', async (_$, e) => {
    if (e.origin?.kind === 'plugin') {
      world.wakePrompts.push(e.text)
      await world.wakeGate
    }
    return { text: e.text, context: e.context }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
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
  const lockouts = world.processes.filter(call => call.argv[3] === 'lockout' && call.argv[4] === '--reset-at')
  expect(lockouts.length).toBe(1)
  expect(lockouts[0]?.argv.slice(3)).toEqual(['lockout', '--reset-at', RESET, '--session', 'test-session'])
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
  expect(result.context?.length).toBe(2)
  expect((await $.prompt.submit(prompt)).context).toEqual(prompt.context)
})

test('tool reminders preserve results and context and never replace engine denials', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 85)
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
  expect(world.processes.map(call => call.argv[3])).toEqual(['quota', 'lockout', 'stash'])
  expect(world.processes[2]).toEqual({ argv: ['python3', '-I', script, 'stash'], stdin: prompt, timeout: 5000 })
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
    expect(world.processes[2]?.argv[3]).toBe('stash')
    expect(world.processes[2]?.stdin).toBe(prompt)
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
    expect(world.processes.map(call => call.argv[3])).toEqual(['quota', 'lockout'])
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
    expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(1)
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    world.now += MINUTE
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(1)
    world.now = BASE + 5 * MINUTE + 1
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(2)
    expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
    expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(2)
  })
}

test('turns without subagent calls re-read Codex once its reading is too old to use', async ($, on) => {
  const world = setup(on)
  const probes = () => world.processes.filter(call => call.argv[3] === 'quota').length
  await start($)
  await measure($, world, 5)
  // A reading that calls can still use is kept: a failed read on a usage update must not replace it.
  world.quota = processResult('', 1)
  world.now = BASE + 15 * MINUTE
  await measure($, world, 6)
  expect(probes()).toBe(1)
  expect(world.statuses[world.statuses.length - 1]?.includes('codex wk 18% ·')).toBe(true)
  world.quota = processResult(JSON.stringify({ ...QUOTA, windows: [{ ...QUOTA.windows[0]!, used_percent: 30 }] }))
  world.now += 1
  await measure($, world, 6)
  expect(probes()).toBe(2)
  expect(world.statuses[world.statuses.length - 1]?.includes('codex wk 30% ·')).toBe(true)
  world.now += 15 * MINUTE
  await measure($, world, 7)
  expect(probes()).toBe(2)
  world.now = BASE + 3 * 60 * MINUTE
  await measure($, world, 8)
  expect(probes()).toBe(3)
  expect(world.statuses[world.statuses.length - 1]?.includes('stale')).toBe(false)
})

test('a subagent call is decided on the Claude reading taken after its Codex probe', async ($, on) => {
  const world = setup(on)
  await start($)
  world.now += 6 * MINUTE
  world.duringQuota = () => { world.usage = [{ kind: 'five_hour', percentUsed: 5, resetsAt: RESET }] }
  expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
})

test('a usage update takes the Codex and usage readings side by side', async ($, on) => {
  const world = setup(on)
  await start($)
  world.holdProbes = true
  world.now = BASE + 20 * MINUTE
  await measure($, world, 5)
  expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(2)
  expect(world.usageProcesses.length).toBe(2)
  expect(world.mostOpenProbes).toBe(2)
})

test('a Codex reading is kept as soon as it arrives, while the usage probe still runs', async ($, on) => {
  const world = setup(on)
  await start($)
  world.quota = processResult(JSON.stringify({ ...QUOTA, windows: [{ ...QUOTA.windows[0]!, used_percent: 30 }] }))
  let release = () => {}
  world.usageGate = new Promise<void>(resolve => { release = resolve })
  world.now = BASE + 20 * MINUTE
  const pending = measure($, world, 5)
  let shown = ''
  for (let i = 0; i < 20 && !shown.includes('codex wk 30% ·'); i++) shown = (await command($, 'status')).text ?? ''
  release()
  await pending
  expect(shown.includes('codex wk 30% ·')).toBe(true)
})

test('a missing Codex reading is retried on usage updates under the same five-minute throttle as calls', async ($, on) => {
  const world = setup(on)
  const probes = () => world.processes.filter(call => call.argv[3] === 'quota').length
  world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
  world.quota = processResult('', 1)
  await start($)
  expect(world.statuses[world.statuses.length - 1]?.includes('codex unavailable')).toBe(true)
  world.now = BASE + 5 * MINUTE
  await measure($, world, 2)
  expect(probes()).toBe(1)
  world.now += 1
  await measure($, world, 2)
  expect(probes()).toBe(2)
  world.quota = processResult(JSON.stringify(QUOTA))
  world.now += 5 * MINUTE
  expect(await $.tool.call(AGENT)).toEqual(AGENT_RESULT)
  expect(probes()).toBe(2)
  world.now += 1
  await measure($, world, 2)
  expect(probes()).toBe(3)
  expect(world.statuses[world.statuses.length - 1]?.includes('codex wk 18% ·')).toBe(true)
  expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
  expect(probes()).toBe(3)
})

test('off mode reads no Codex quota on usage updates', async ($, on) => {
  const world = setup(on)
  await start($)
  await command($, 'off')
  world.now += 20 * MINUTE
  world.processes = []
  await measure($, world, 5)
  expect(world.processes.length).toBe(0)
  expect(world.statuses[world.statuses.length - 1]).toBe('crossfeed off')
})

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

for (const [name, response, failure, cause] of [
  ['nonzero', processResult('', 127), '', 'quota probe exited with code 127'],
  ['timeout', processResult(''), 'quota timed out', 'quota probe failed'],
  ['throw', processResult(''), 'synthetic exception', 'quota probe failed'],
  ['empty', processResult(''), '', 'quota probe returned invalid JSON'],
  ['garbage', processResult('not json'), '', 'quota probe returned invalid JSON'],
  ['truncated', { ...processResult(JSON.stringify(QUOTA)), isStdoutTruncated: true }, '', 'quota probe output was truncated'],
  ['invalid shape', processResult('null'), '', 'quota probe returned invalid data'],
  ['none', processResult(JSON.stringify({ ...QUOTA, source: 'none', error: 'no logs\r\n检查' })), '', 'no logs 检查'],
  ['app error', processResult(JSON.stringify({ ...QUOTA, source: 'none', error: 'no logs', app_server_error: 'codex missing' })), '', 'codex missing'],
] as const) {
  test(`quota failure ${name} appears as a problem in status and decisions`, async ($, on) => {
    const world = setup(on)
    world.quota = response
    world.processFailure = failure
    world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
    await start($)
    await $.tool.call(AGENT)
    const status = (await command($, 'status')).text ?? ''
    expect(status.includes(`no Codex reading (${cause}`)).toBe(true)
    expect(status.includes('codex unavailable')).toBe(true)
    expect(world.logs.some(log => log.includes(cause))).toBe(true)
  })
}

test('stale log fallback preserves a single-line bounded app server error', async ($, on) => {
  const world = setup(on)
  const problem = 'missing codex\r\n检查 ' + 'x'.repeat(1000)
  world.quota = processResult(JSON.stringify({ ...QUOTA, source: 'log', age_s: 180 * 60, app_server_error: problem }))
  world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
  await start($)
  await $.tool.call(AGENT)
  const status = (await command($, 'status')).text ?? ''
  expect(status.includes('codex wk 18% stale')).toBe(true)
  expect(status.includes('Codex reading is 180 minutes old (' + problem.replace(/\s+/g, ' ').slice(0, 200) + ')')).toBe(true)
  expect(status.includes('x'.repeat(201))).toBe(false)
})

for (const output of ['', 'garbage', 'null', '[]', '{}', '{"reset_at":null}', '{"reset_at":"unknown"}', '{"reset_at":17}', '{"reset_at":""}']) {
  test(`bad last-lockout output ${JSON.stringify(output)} fails open`, async ($, on) => {
    const world = setup(on)
    world.lockout = processResult(output)
    world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
    await start($)
    expect((await command($, 'status')).text?.split('\n')[0]?.endsWith('pressure 0')).toBe(true)
    expect(world.processes.some(call => call.argv[4] === '--last')).toBe(true)
    expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
  })
}

test('startup loads the previous lockout before the first measure with a five second timeout', async ($, on) => {
  const world = setup(on)
  world.lockout = processResult(JSON.stringify({ reset_at: new Date(BASE).toISOString() }))
  world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
  await start($)
  expect(world.statuses[0]?.includes('pressure 0.3')).toBe(true)
  const probe = world.processes.find(call => call.argv[4] === '--last')
  expect(probe?.argv.slice(0, 2)).toEqual(['python3', '-I'])
  expect(probe?.argv.slice(3)).toEqual(['lockout', '--last'])
  expect(probe?.timeout).toBe(5000)
  const research = { ...AGENT, description: 'Research', prompt: 'Research the protocol and report vendors with sources. '.repeat(4) }
  for (const seconds of [0, 10, 20, 31, 44, 59, 73]) {
    world.now = BASE + seconds * 1000
    expect((await $.tool.call(research)).deny?.startsWith('crossfeed:')).toBe(true)
  }
})

test('notices wait through subagent calls and denials, reach main-loop tool once, then leave prompt clean', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 95)
  const bash = { tool: 'Bash' as const, command: 'true' }
  expect((await $.tool.call({ ...bash, agentId: 'child' })).context).toEqual(['existing tool context'])
  expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
  world.denyBash = true
  expect(await $.tool.call(bash)).toEqual({ deny: 'engine denied' })
  world.denyBash = false
  const result = await $.tool.call(bash)
  expect(result.context?.length).toBe(2)
  expect(result.context?.[0]).toBe('existing tool context')
  expect(result.context?.[1]?.includes('reserve')).toBe(true)
  expect((await $.tool.call(bash)).context).toEqual(['existing tool context'])
  expect((await $.prompt.submit({ text: 'next', context: [], wait: false, origin: ORIGIN })).context).toEqual([])
})

const RESEARCH = { tool: 'Agent' as const, description: 'Research vendors', prompt: 'Research which vendors support the requested protocol and report with sources. '.repeat(3) }

for (const refused of [true, false]) {
  test(`two subagent calls the engine ${refused ? 'refused' : 'started'} ${refused ? 'do not' : 'do'} make a burst`, async ($, on) => {
    const world = setup(on)
    world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
    await start($)
    world.denyAgent = refused
    for (let i = 0; i < 2; i++) {
      world.now += 1000
      expect((await $.tool.call(RESEARCH)).deny).toBe(refused ? 'engine denied' : undefined)
    }
    world.denyAgent = false
    world.now += 1000
    const third = await $.tool.call(RESEARCH)
    expect(third.deny?.startsWith('crossfeed:') ?? false).toBe(!refused)
    expect(world.agents.length).toBe(refused ? 3 : 2)
  })
}

test('the status line is redrawn from the readings a subagent call was decided on', async ($, on) => {
  const world = setup(on)
  world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
  world.rejectProcess = true
  await start($)
  expect(world.statuses[world.statuses.length - 1]?.includes('codex unavailable')).toBe(true)
  world.rejectProcess = false
  world.now += 6 * MINUTE
  expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
  const shown = world.statuses[world.statuses.length - 1] ?? ''
  expect(shown.includes('codex unavailable')).toBe(false)
  expect(shown.includes('codex wk 18%')).toBe(true)
})

for (const [name, age, accepted] of [
  ['missing', undefined, false], ['null', null, false], ['a string', '5', false],
  ['far in the future', -301, false], ['slightly in the future', -300, true], ['zero', 0, true],
] as const) {
  test(`a quota reading whose age is ${name} is ${accepted ? 'used' : 'rejected'}`, async ($, on) => {
    const world = setup(on)
    const { age_s: _dropped, ...rest } = QUOTA
    world.quota = processResult(JSON.stringify(age === undefined ? rest : { ...rest, age_s: age }))
    world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
    await start($)
    const result = await $.tool.call(AGENT)
    expect(result.deny?.startsWith('crossfeed:') ?? false).toBe(accepted)
    const status = (await command($, 'status')).text ?? ''
    expect(status.includes('no Codex reading (quota probe returned an invalid age)')).toBe(!accepted)
  })
}

for (const bad of [NaN, Infinity, undefined, null, '1794902400000'] as const) {
  test(`a clock that returns ${String(bad)} at startup does not leave a reading that never ages`, async ($, on) => {
    const world = setup(on)
    world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
    world.now = bad as unknown as number
    await start($)
    const probes = () => world.processes.filter(call => call.argv[3] === 'quota').length
    expect(probes()).toBe(0)
    expect((await $.tool.call(AGENT)).deny).toBe(undefined)
    world.now = BASE
    expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
    expect(probes()).toBe(1)
    world.now = BASE + 24 * 60 * MINUTE
    await $.tool.call(AGENT)
    expect(probes()).toBe(2)
  })
}

test('a refused tool call is not counted and does not use up the stretch reminder', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 85)
  for (let i = 0; i < 11; i++) await $.tool.call({ tool: 'Bash', command: 'true' })
  world.denyBash = true
  for (let i = 0; i < 3; i++) expect(await $.tool.call({ tool: 'Bash', command: 'true' })).toEqual({ deny: 'engine denied' })
  world.denyBash = false
  const result = await $.tool.call({ tool: 'Bash', command: 'true' })
  const reminder = result.context?.find(text => text.includes('main-loop tool calls'))
  expect(reminder?.startsWith('crossfeed: 12 main-loop tool calls')).toBe(true)
})

test('a status line that cannot be drawn does not block commands, readings or routing', async ($, on) => {
  const world = setup(on)
  world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
  await start($)
  world.failStatus = true
  expect((await command($, 'always')).text).toBe('crossfeed mode: always (this session)')
  await measure($, world, 3)
  expect((await $.tool.call(RESEARCH)).deny?.startsWith('crossfeed:')).toBe(true)
  expect((await command($, 'off')).text).toBe('crossfeed mode: off (this session)')
  expect((await $.tool.call(RESEARCH)).deny).toBe(undefined)
})


const MODEL_USAGE = { source: 'usage', age_s: 0, error: null, buckets: [{ label: 'Fable', family: 'fable', used_percent: 62, resets_at: (BASE + 4.5 * 1440 * MINUTE) / 1000 }] }
test('a subagent call is decided on the main model in use after its Codex probe', async ($, on) => {
  const world = scarce(on)
  world.model = 'opus'
  await start($)
  world.now += 6 * MINUTE
  world.duringQuota = () => { world.model = 'claude-fable-5-2' }
  expect((await $.tool.call(RESEARCH)).deny?.startsWith('crossfeed:')).toBe(true)
})

const SPAWN: AgentSpawnInput = { tool_use_id: 'spawn-test', prompt: 'Research the protocol.', description: 'Research', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-fable-5-2', background: false, fork: false }
function scarce(on: On) {
  const world = setup(on)
  world.model = 'claude-fable-5-2'
  world.claudeUsage = processResult(JSON.stringify(MODEL_USAGE))
  world.usage = [{ kind: 'five_hour', percentUsed: 10, resetsAt: RESET }]
  return world
}

for (const reason of ['clear', 'resume', 'other'] as const) {
  test(`session end ${reason} updates conversation notices and dispatch identity only when changed`, async ($, on) => {
    const world = scarce(on)
    await start($)
    const prompt = { text: 'Continue', wait: false, origin: ORIGIN }
    const first = await $.prompt.submit(prompt)
    expect(first.context?.some(note => note.includes('Fable weekly'))).toBe(true)
    await $.session.end({ reason, sessionId: 'test-session', resume: { id: 'test-session' } })
    expect(world.sessionIdReads).toBe(1)
    world.sessionId = 'second-session'
    const second = await $.prompt.submit(prompt)
    expect(second.context ?? []).toEqual(reason === 'other' ? [] : first.context)
    const refusal = await $.tool.call(RESEARCH)
    expect(refusal.deny?.includes(`--session '${reason === 'other' ? 'test-session' : 'second-session'}'`)).toBe(true)
    expect((await $.prompt.submit(prompt)).context ?? []).toEqual([])
    expect(world.sessionIdReads).toBe(reason === 'other' ? 1 : 2)
    await $.agent.spawn(SPAWN)
    const record = world.processes.find(p => p.argv[3] === 'downgrade')!
    expect(record.argv.slice(-2)).toEqual(['--session', reason === 'other' ? 'test-session' : 'second-session'])
  })
}

for (const event of ['tool', 'agent', 'measure'] as const) {
  test(`conversation refresh runs before the first ${event} event`, async ($, on) => {
    const world = scarce(on)
    await start($)
    await $.prompt.submit({ text: 'First', wait: false, origin: ORIGIN })
    await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
    world.sessionId = 'second-session'
    if (event === 'measure') await measure($, world, 10)
    if (event === 'agent') expect((await $.tool.call(RESEARCH)).deny?.includes("--session 'second-session'")).toBe(true)
    const result = await $.tool.call({ tool: 'Bash', command: 'true' })
    expect(result.context?.filter(note => note.includes('Fable weekly')).length).toBe(1)
    expect(world.sessionIdReads).toBe(2)
    expect(world.usageProcesses.length).toBe(1)
  })
}

test('conversation refresh drops the old identity when session.id fails', async ($, on) => {
  const world = scarce(on)
  await start($)
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
  world.failSessionId = true
  const refusal = await $.tool.call(RESEARCH)
  expect(refusal.deny?.startsWith('crossfeed:')).toBe(true)
  expect(refusal.deny?.includes('--session')).toBe(false)
  await $.agent.spawn(SPAWN)
  expect(world.processes.find(p => p.argv[3] === 'downgrade')?.argv.includes('--session')).toBe(false)
})

test('startup reads Claude usage once alongside Codex quota with the contracted argv', async ($, on) => {
  const world = scarce(on)
  await start($)
  const script = world.processes[0]!.argv[2]!
  expect(world.usageProcesses).toEqual([{ argv: ['python3', '-I', script, 'claude-usage'], timeout: 25000 }])
  expect(world.processes.filter(p => p.argv[3] === 'quota').length).toBe(1)
  expect(world.statuses[0]?.includes('fable wk 62% ahead')).toBe(true)
  const section = (await $.prompt.compose(COMPOSE)).sections[1]?.text ?? ''
  expect(section.includes('When a crossfeed notice says hand-offs are on')).toBe(true)
})

test('an ahead Fable limit hands a tier B call to Codex', async ($, on) => {
  scarce(on)
  await start($)
  const result = await $.tool.call(RESEARCH)
  expect(result.deny?.startsWith('crossfeed:')).toBe(true)
  expect(result.deny?.includes('Fable weekly 62% used')).toBe(true)
  expect(result.deny?.includes('--kind subagent --cause limit')).toBe(true)
})

test('spawn rewrite records only the model the engine actually used', async ($, on) => {
  const world = scarce(on)
  await start($)
  const result = await $.agent.spawn(SPAWN)
  expect(result).toEqual({ model: 'opus', agentId: 'spawned' })
  expect(world.spawns[0]?.model).toBe('opus')
  expect(world.logs.some(log => log.includes('subagent ran on opus instead of claude-fable-5-2 (Fable weekly 62%, ahead)'))).toBe(true)
  const script = world.processes[0]!.argv[2]!
  expect(world.processes.filter(p => p.argv[3] === 'downgrade')).toEqual([{
    argv: ['python3', '-I', script, 'downgrade', '--from', 'claude-fable-5-2', '--to', 'opus', '--bucket', 'Fable', '--percent', '62', '--session', 'test-session'], timeout: 5000, stdin: undefined,
  }])
  expect(world.usageProcesses.length).toBe(1)
})

for (const engineModel of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
  test(`spawn accounting compares families for engine model ${engineModel}`, async ($, on) => {
    const world = scarce(on)
    world.spawnModel = engineModel
    await start($)
    expect((await $.agent.spawn(SPAWN)).model).toBe(engineModel)
    expect(world.processes.filter(p => p.argv[3] === 'downgrade').length).toBe(engineModel.includes('opus') ? 1 : 0)
    if (engineModel.includes('sonnet')) expect(world.logs.some(log => log.includes('rewrite to opus not applied (ran on claude-sonnet-5-5)'))).toBe(true)
  })
}

for (const overrides of [{ subagentType: 'Explore' }, { subagentType: 'web-fetch' }, { subagentType: 'plugin-agent' }, { fork: true }, { model: 'fable' }, { parentModel: 'opus' }]) {
  test(`spawn keeps protected input ${JSON.stringify(overrides)}`, async ($, on) => {
    const world = scarce(on)
    await start($)
    await $.agent.spawn({ ...SPAWN, ...overrides })
    expect(world.spawns).toEqual([{ ...SPAWN, ...overrides }])
    expect(world.processes.some(p => p.argv[3] === 'downgrade')).toBe(false)
  })
}

test('spawn uses its parent model even when the main model differs, including workflows', async ($, on) => {
  const world = scarce(on)
  world.model = 'sonnet'
  await start($)
  await $.agent.spawn({ ...WORKFLOW_SPAWN, parentAgentId: 'parent-agent' })
  expect(world.spawns[0]?.model).toBe('opus')
})

test('downstream spawn refusals are returned unchanged and logged as refused', async ($, on) => {
  const world = scarce(on)
  world.denySpawn = true
  await start($)
  expect(await $.agent.spawn(SPAWN)).toEqual({ deny: 'engine denied spawn' })
  expect(world.processes.some(p => p.argv[3] === 'downgrade')).toBe(false)
  await waitForBackground(() => world.records.flat().some(row => row.type === 'spawn' && row.outcome === 'refused'))
})

test('a model-only spawn result records an unconfirmed start without a downgrade', async ($, on) => {
  const world = scarce(on)
  world.nextAgentId = undefined
  await start($)
  const result = await $.agent.spawn(SPAWN)
  expect(result.model).toBe('opus')
  expect(result.agentId).toBe(undefined)
  await waitForBackground(() => world.records.flat().length === 1)
  expect(world.records.flat()[0]).toEqual(expect.objectContaining({ type: 'spawn', outcome: 'unconfirmed' }))
  expect(world.processes.some(p => p.argv[3] === 'downgrade')).toBe(false)
})

for (const failure of ['throw', 'exit'] as const) {
  test(`downgrade ledger ${failure} does not block or duplicate a spawn`, async ($, on) => {
    const world = scarce(on)
    world.failDowngrade = failure === 'throw'
    world.downgradeExit = failure === 'exit' ? 1 : 0
    await start($)
    expect(await $.agent.spawn(SPAWN)).toEqual({ model: 'opus', agentId: 'spawned' })
    expect(world.spawns.length).toBe(1)
    expect(world.logs.some(log => log.includes('downgrade') && (log.includes('failed') || log.includes('exited')))).toBe(true)
  })
}

test('usage probe throttle spans Agent and measure events, including a failed probe', async ($, on) => {
  const world = scarce(on)
  await start($)
  for (let i = 1; i <= 20; i++) {
    world.now = BASE + i * 9 * MINUTE / 20
    await $.tool.call(RESEARCH)
    await measure($, world, 10)
  }
  expect(world.usageProcesses.length).toBe(1)
  world.now = BASE + 10 * MINUTE
  await measure($, world, 10)
  expect(world.usageProcesses.length).toBe(1)
  world.now = BASE + 11 * MINUTE
  world.claudeUsage = processResult('', 1)
  await measure($, world, 10)
  expect(world.usageProcesses.length).toBe(2)
  world.now = BASE + 20 * MINUTE
  await $.tool.call(RESEARCH)
  await measure($, world, 10)
  expect(world.usageProcesses.length).toBe(2)
  world.now = BASE + 21 * MINUTE + 1
  await $.tool.call(RESEARCH)
  expect(world.usageProcesses.length).toBe(3)
})

const BAD_USAGE = [
  '', 'not json', 'null', '[]', '{}',
  JSON.stringify({ ...MODEL_USAGE, source: 'none', buckets: [], error: 'x' }),
  JSON.stringify({ ...MODEL_USAGE, age_s: '0' }), JSON.stringify({ ...MODEL_USAGE, age_s: -400 }),
  JSON.stringify({ ...MODEL_USAGE, age_s: null }), JSON.stringify({ ...MODEL_USAGE, age_s: 0.5 }),
  JSON.stringify({ ...MODEL_USAGE, age_s: 21 * 60 }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], used_percent: '62' }] }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], used_percent: null }] }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], used_percent: -1 }] }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], resets_at: 'soon' }] }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], family: 'gizmo' }] }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], label: '' }] }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], label: null }] }),
  JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], resets_at: 1e100 }] }),
  JSON.stringify(MODEL_USAGE).replace('62', '1e400'),
]
for (let index = 0; index < BAD_USAGE.length; index++) {
  test(`bad usage output ${index} fails safe without changing 0.1 routing`, async ($, on) => {
    const world = scarce(on)
    world.claudeUsage = processResult(BAD_USAGE[index]!)
    await start($)
    await $.agent.spawn(SPAWN)
    expect(world.spawns[0]?.model).toBe(undefined)
    const call = await $.tool.call(RESEARCH)
    expect(call.deny).toBe(undefined)
    expect(call.context?.some(note => note.includes('weekly')) ?? false).toBe(false)
    expect((await $.tool.call(AGENT)).deny?.startsWith('crossfeed:')).toBe(true)
  })
}

for (const failure of ['throw', 'truncated', 'exit'] as const) {
  test(`usage probe ${failure} fails open and is throttled`, async ($, on) => {
    const world = scarce(on)
    world.failUsage = failure === 'throw'
    world.claudeUsage = { ...world.claudeUsage, isStdoutTruncated: failure === 'truncated', exitCode: failure === 'exit' ? 127 : 0 }
    await start($)
    await $.agent.spawn(SPAWN)
    expect(world.spawns[0]?.model).toBe(undefined)
    await $.tool.call(RESEARCH)
    await measure($, world, 10)
    expect(world.usageProcesses.length).toBe(1)
  })
}

test('rate-limit stop records a fresh full bucket once without a five-hour lockout', async ($, on) => {
  const world = scarce(on)
  await start($)
  world.claudeUsage = processResult(JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], used_percent: 100, resets_at: Date.parse('2026-11-23T22:00:00Z') / 1000 }] }))
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  const script = world.processes[0]!.argv[2]!
  expect(world.usageProcesses.slice(1).map(p => p.argv)).toEqual([
    ['python3', '-I', script, 'claude-usage', '--fresh'], ['python3', '-I', script, 'claude-usage', '--fresh'],
  ])
  expect(world.processes.filter(p => p.argv[3] === 'lockout' && p.argv[4] !== '--last').map(p => p.argv)).toEqual([
    ['python3', '-I', script, 'lockout', '--reset-at', '2026-11-23T22:00:00.000Z', '--bucket', 'Fable', '--session', 'test-session'],
  ])
  await $.agent.spawn({ ...SPAWN, model: 'fable' })
  expect(world.spawns[0]?.model).toBe('opus')
})

test('session.model failure at startup still reads usage; spawns decide from their own parent model', async ($, on) => {
  const world = scarce(on)
  world.failModel = true
  await start($)
  expect(world.usageProcesses.length).toBe(1)
  await $.agent.spawn(SPAWN)
  expect(world.spawns[0]?.model).toBe('opus')
  expect(world.spawns.length).toBe(1)
})

test('spawn clock failure goes ahead unchanged exactly once', async ($, on) => {
  const world = scarce(on)
  await start($)
  world.failClock = true
  await $.agent.spawn(SPAWN)
  expect(world.spawns[0]?.model).toBe(undefined)
  expect(world.spawns.length).toBe(1)
})

test('seven-day reset is retained as a fallback and seconds are converted to milliseconds', async ($, on) => {
  const world = scarce(on)
  world.claudeUsage = processResult(JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], used_percent: 40, resets_at: null }] }))
  world.usage.push({ kind: 'seven_day', percentUsed: 10, resetsAt: new Date(BASE + 7 * 1440 * MINUTE).toISOString() })
  await start($)
  expect((await $.agent.spawn(SPAWN)).model).toBe('opus')
})

test('usage readings accept BOM, CRLF, non-ASCII labels and slight clock skew', async ($, on) => {
  const world = scarce(on)
  world.claudeUsage = processResult('\ufeff' + JSON.stringify({ ...MODEL_USAGE, age_s: -300, buckets: [{ ...MODEL_USAGE.buckets[0], label: 'Fable · beta' }] }) + '\r\n')
  await start($)
  expect((await $.agent.spawn(SPAWN)).model).toBe('opus')
  expect((await command($, 'status')).text?.includes('Fable · beta weekly')).toBe(true)
})

test('off mode stops usage probes, rewrites, notices and bucket lockouts', async ($, on) => {
  const world = scarce(on)
  await start($)
  await command($, 'off')
  world.now += 11 * MINUTE
  await measure($, world, 10)
  await $.tool.call(RESEARCH)
  await $.agent.spawn(SPAWN)
  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(world.usageProcesses.length).toBe(1)
  expect(world.spawns[0]?.model).toBe(undefined)
})

function decisions(world: ReturnType<typeof setup>): Record<string, unknown>[] {
  return world.decisions.map(call => JSON.parse(call.stdin ?? 'null') as Record<string, unknown>)
}

test('a call that stays is recorded while the engine runs it, with no wait before the engine call', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  let release: () => void = () => {}
  world.decisionGate = new Promise(resolve => { release = resolve })
  let settled = false
  const pending = $.tool.call(RESEARCH).then(result => { settled = true; return result })
  for (let i = 0; i < 1000 && world.agents.length === 0; i++) await Promise.resolve()
  for (let i = 0; i < 100; i++) await Promise.resolve()
  // The engine has run the call; the hook still waits for its record before it returns.
  expect(world.agents.length).toBe(1)
  expect(world.decisionsDoneAtAgent).toEqual([0])
  expect(settled).toBe(false)
  release()
  const result = await pending
  expect(result).toEqual(AGENT_RESULT)
  expect(world.decisionsDone).toBe(1)
  const script = world.processes[0]!.argv[2]!
  expect(world.decisions.map(call => [call.argv, call.timeout])).toEqual([[['python3', '-I', script, 'decision'], 5000]])
  expect(decisions(world)[0]).toEqual(expect.objectContaining({
    session: 'test-session', mode: 'auto', main_model: 'opus', description: 'Research vendors', eligible: true, tier: 'B',
    tier_reason: 'no check command', handed_off: false, reason: 'pressure is low', five_hour: 5, brief_file: null,
  }))
  expect(world.processes.some(call => call.argv[3] === 'decision')).toBe(false)
})

test('a hand-off is recorded after its brief is saved, with the saved path', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  const result = await $.tool.call(AGENT)
  expect(result.deny?.startsWith('crossfeed:')).toBe(true)
  expect(world.sequence.indexOf('stash') < world.sequence.indexOf('decision')).toBe(true)
  expect(decisions(world)).toEqual([expect.objectContaining({
    description: 'Implement parser', tier: 'A', handed_off: true, reason: 'tier A has enough Codex headroom', brief_file: '/tmp/检查 brief.md',
  })])
  world.rejectStash = true
  await $.tool.call(AGENT)
  expect(decisions(world)[1]?.brief_file).toBe(null)
  expect(decisions(world)[1]?.handed_off).toBe(true)
})

for (const failure of ['throw', 'deny', 'nonzero', 'opaque'] as const) {
  test(`a decision record that fails (${failure}) is logged and changes neither path`, async ($, on) => {
    const world = setup(on)
    await start($)
    await measure($, world, 5)
    world.decisionFailure = failure
    expect(await $.tool.call(RESEARCH)).toEqual(AGENT_RESULT)
    expect(world.agents.length).toBe(1)
    const handoff = await $.tool.call(AGENT)
    expect(handoff.deny?.startsWith('crossfeed: run this on Codex')).toBe(true)
    expect(world.agents.length).toBe(1)
    const failures = world.logs.filter(line => line.startsWith('crossfeed: decision record'))
    expect(failures.length).toBe(2)
    expect(failures[0]).toBe(failure === 'nonzero' ? 'crossfeed: decision record exited with code 2' : failures[0])
    expect(world.logs.filter(line => line.startsWith('last subagent call:')).length).toBe(2)
  })
}

test('off mode writes no decision record', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  await command($, 'off')
  await $.tool.call(AGENT)
  await $.tool.call(RESEARCH)
  expect(world.decisions.length).toBe(0)
  await command($, 'auto')
  await $.tool.call(RESEARCH)
  expect(world.decisions.length).toBe(1)
})

test('overlapping calls each record and log their own decision', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  let release: () => void = () => {}
  world.stashGate = new Promise(resolve => { release = resolve })
  const first = $.tool.call(AGENT)
  for (let i = 0; i < 1000 && !world.sequence.includes('stash'); i++) await Promise.resolve()
  expect(world.sequence.includes('stash')).toBe(true)
  expect(await $.tool.call(RESEARCH)).toEqual(AGENT_RESULT)
  release()
  expect((await first).deny?.startsWith('crossfeed:')).toBe(true)
  expect(decisions(world).map(record => [record.description, record.handed_off])).toEqual([['Research vendors', false], ['Implement parser', true]])
  expect(world.logs.filter(line => line.startsWith('last subagent call:'))).toEqual([
    'last subagent call: stayed on Claude (pressure is low)',
    'last subagent call: handed to Codex (has a check command and is implementation-type work)',
  ])
})

test('a conversation change while the brief is saved leaves the record and the command on one session', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  let release: () => void = () => {}
  world.stashGate = new Promise(resolve => { release = resolve })
  const first = $.tool.call(AGENT)
  for (let i = 0; i < 1000 && !world.sequence.includes('stash'); i++) await Promise.resolve()
  expect(world.sequence.includes('stash')).toBe(true)
  // A /clear lands while the brief is being saved, and the next event adopts the new session.
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
  world.sessionId = 'new-session'
  await $.prompt.submit({ text: 'next', wait: false, origin: ORIGIN })
  release()
  const deny = (await first).deny ?? ''
  const session = decisions(world)[0]?.session
  expect(session).toBe('test-session')
  expect(deny.includes(`--session '${String(session)}'`)).toBe(true)
})

test('a call whose engine run fails is not run a second time by the fail-open handler', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  world.throwAgent = true
  await $.tool.call(RESEARCH).catch(() => undefined)
  expect(world.agents.length).toBe(1)
  expect(world.decisions.length).toBe(1)
})

test('a call that finishes its Codex probe after a later call still counts that later stay', async ($, on) => {
  const world = setup(on)
  world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
  await start($)
  // The Codex reading is now old enough that the next eligible call probes again.
  world.now += 6 * MINUTE
  let release: () => void = () => {}
  world.quotaGate = new Promise(resolve => { release = resolve })
  const quotas = world.sequence.filter(name => name === 'quota').length
  const first = $.tool.call(RESEARCH)
  for (let i = 0; i < 1000 && world.sequence.filter(name => name === 'quota').length === quotas; i++) await Promise.resolve()
  // More than the clock-skew allowance passes while the first call's probe runs.
  world.now += 2 * MINUTE
  // Inside the probe throttle, this call decides at once and stays.
  expect(await $.tool.call(RESEARCH)).toEqual(AGENT_RESULT)
  world.now += 1000
  release()
  expect(await first).toEqual(AGENT_RESULT)
  world.now += 1000
  const third = await $.tool.call(RESEARCH)
  expect(third.deny?.startsWith('crossfeed:')).toBe(true)
  expect(decisions(world).map(record => record.burst)).toEqual([0, 1, 2])
})

test('a refusal states the readings its call was decided on, not ones that arrived while the brief was saved', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  let release: () => void = () => {}
  world.stashGate = new Promise(resolve => { release = resolve })
  const first = $.tool.call(AGENT)
  for (let i = 0; i < 1000 && !world.sequence.includes('stash'); i++) await Promise.resolve()
  await measure($, world, 65)
  release()
  const deny = (await first).deny ?? ''
  expect(deny.includes('Claude 5h 5%')).toBe(true)
  expect(decisions(world)[0]?.five_hour).toBe(5)
})

test('a usage update that lands while a call reads the main model is not overwritten by the older reading', async ($, on) => {
  const world = setup(on)
  world.usage = [{ kind: 'five_hour', percentUsed: 5, resetsAt: RESET }]
  await start($)
  await measure($, world, 5)
  let release: () => void = () => {}
  world.modelGate = new Promise(resolve => { release = resolve })
  // The second main-model read of the call: the one after the call took the session's usage.
  world.holdModelReadAt = world.modelReads + 2
  const call = $.tool.call(RESEARCH)
  for (let i = 0; i < 1000 && !world.modelHeld; i++) await Promise.resolve()
  expect(world.modelHeld).toBe(true)
  await measure($, world, 95)
  release()
  expect((await call).deny?.startsWith('crossfeed:')).toBe(true)
  expect(decisions(world)[0]?.five_hour).toBe(95)
})

test('a call that waits on its main-model read still counts a stay decided meanwhile', async ($, on) => {
  const world = setup(on)
  world.usage = [{ kind: 'five_hour', percentUsed: 2, resetsAt: RESET }]
  await start($)
  let release: () => void = () => {}
  world.modelGate = new Promise(resolve => { release = resolve })
  world.holdModelReadAt = world.modelReads + 2
  const first = $.tool.call(RESEARCH)
  for (let i = 0; i < 1000 && !world.modelHeld; i++) await Promise.resolve()
  expect(world.modelHeld).toBe(true)
  world.now += 2 * MINUTE
  expect(await $.tool.call(RESEARCH)).toEqual(AGENT_RESULT)
  world.now += 1000
  release()
  expect(await first).toEqual(AGENT_RESULT)
  world.now += 1000
  expect((await $.tool.call(RESEARCH)).deny?.startsWith('crossfeed:')).toBe(true)
  expect(decisions(world).map(record => record.burst)).toEqual([0, 1, 2])
})

test('a usage reply that arrives after a newer usage update is dropped', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  let release: () => void = () => {}
  world.usageReadGate = new Promise(resolve => { release = resolve })
  world.holdUsageReadAt = world.usageReads + 1
  const call = $.tool.call(RESEARCH)
  for (let i = 0; i < 1000 && !world.usageHeld; i++) await Promise.resolve()
  expect(world.usageHeld).toBe(true)
  await measure($, world, 95)
  release()
  expect((await call).deny?.startsWith('crossfeed:')).toBe(true)
  expect(decisions(world)[0]?.five_hour).toBe(95)
})

test('a main-model reply that arrives after a newer one is dropped', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  world.model = 'claude-opus-5-5'
  let release: () => void = () => {}
  world.modelGate = new Promise(resolve => { release = resolve })
  world.holdModelReadAt = world.modelReads + 2
  const call = $.tool.call(RESEARCH)
  for (let i = 0; i < 1000 && !world.modelHeld; i++) await Promise.resolve()
  expect(world.modelHeld).toBe(true)
  // The person switches models; the next usage update reads the new one.
  world.model = 'claude-sonnet-5-5'
  await measure($, world, 6)
  release()
  await call
  expect(decisions(world)[0]?.main_model).toBe('claude-sonnet-5-5')
})

test('a usage update handled after a newer reading was taken does not replace it', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  let release: () => void = () => {}
  world.clockGate = new Promise(resolve => { release = resolve })
  world.holdClockReadAt = world.clockReads + 1
  // An update for 50% arrives and waits on the clock before it is applied.
  world.usage = [{ kind: 'five_hour', percentUsed: 50, resetsAt: RESET }]
  const update = $.session.measure({ context: { window: 200000 }, rateLimits: world.usage, changed: ['rateLimits'] })
  for (let i = 0; i < 1000 && !world.clockHeld; i++) await Promise.resolve()
  expect(world.clockHeld).toBe(true)
  // Meanwhile usage moves on, and a subagent call reads 95%.
  world.usage = [{ kind: 'five_hour', percentUsed: 95, resetsAt: RESET }]
  await $.tool.call(RESEARCH)
  expect(decisions(world)[0]?.five_hour).toBe(95)
  release()
  await update
  expect((await command($, 'status')).text?.includes('claude 5h 95%')).toBe(true)
})


test('a failed main-model read does not discard an earlier read that answers later', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 5)
  world.model = 'claude-opus-5-5'
  let release: () => void = () => {}
  world.modelGate = new Promise(resolve => { release = resolve })
  world.holdModelReadAt = world.modelReads + 2
  const call = $.tool.call(RESEARCH)
  for (let i = 0; i < 1000 && !world.modelHeld; i++) await Promise.resolve()
  world.failModel = true
  await measure($, world, 6)
  world.failModel = false
  release()
  await call
  expect(decisions(world)[0]?.main_model).toBe('claude-opus-5-5')
})

test('of two overlapping limit probes, the reading taken last wins, whichever started first', async ($, on) => {
  const world = scarce(on)
  await start($)
  const bucket = (used: number, age: number) => processResult(JSON.stringify({ ...MODEL_USAGE, age_s: age, buckets: [{ ...MODEL_USAGE.buckets[0], used_percent: used }] }))
  let release: () => void = () => {}
  // A slow probe that fetches fresh data, then a fast one that answers from a 5-second-old cache.
  world.usageQueue = [{ result: bucket(95, 0), gate: new Promise(resolve => { release = resolve }) }, { result: bucket(62, 5) }]
  world.now += 11 * MINUTE
  const update = measure($, world, 10)
  for (let i = 0; i < 1000 && world.usageProcesses.length < 2; i++) await Promise.resolve()
  expect(world.usageProcesses.length).toBe(2)
  world.now += 10000
  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(world.usageProcesses.length).toBe(3)
  world.now += 10000
  release()
  await update
  expect((await command($, 'status')).text?.includes('fable wk 95%')).toBe(true)
})

test('a limit probe that answers after the clock went back an hour is still used', async ($, on) => {
  const world = scarce(on)
  await start($)
  let release: () => void = () => {}
  world.usageQueue = [{ result: processResult(JSON.stringify({ ...MODEL_USAGE, buckets: [{ ...MODEL_USAGE.buckets[0], used_percent: 70 }] })), gate: new Promise(resolve => { release = resolve }) }]
  world.now += 11 * MINUTE
  const update = measure($, world, 10)
  for (let i = 0; i < 1000 && world.usageProcesses.length < 2; i++) await Promise.resolve()
  expect(world.usageProcesses.length).toBe(2)
  world.now -= 60 * MINUTE
  release()
  await update
  expect((await command($, 'status')).text?.includes('fable wk 70%')).toBe(true)
})

test('off suppresses the static section on each compose and auto restores the same text', { options: { mode: 'off' } }, async ($, on) => {
  const world = setup(on)
  await start($)
  const engine = [{ id: 'engine', text: 'engine section', scope: 'shared' }]
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual(engine)
  await command($, 'auto')
  const active = await $.prompt.compose(COMPOSE)
  expect(active.sections[1]?.text.includes('before your first command')).toBe(true)
  await command($, 'always')
  expect(await $.prompt.compose(COMPOSE)).toEqual(active)
  await command($, 'off')
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual(engine)
  expect(world.nudges).toEqual([])
})

for (const stop of [75.5, 85]) {
  test(`the configured stop ${stop} reaches fresh, resumed, stretch and refusal commands`, { options: { mode: 'always', codexStopPercent: stop, stretchCalls: 1, model: 'explicit-model' } }, async ($, on) => {
    const world = setup(on)
    world.usage = [{ kind: 'five_hour', percentUsed: 5, resetsAt: RESET }]
    await start($)
    const lines = (await $.prompt.compose(COMPOSE)).sections[1]!.text.split('\n')
    const result = await $.tool.call({ tool: 'Bash', command: 'true' })
    const refusal = await $.tool.call(AGENT)
    const commands = [lines.find(line => line.includes('run --kind task|review|research')), lines.find(line => line.includes('run --resume <job>')),
      result.context?.find(text => text.includes('run --kind task')), refusal.deny?.split('\n')[3]]
    expect(refusal.deny?.includes("--model 'explicit-model'")).toBe(true)
    for (const cmd of commands) {
      expect(cmd?.includes('run ')).toBe(true)
      expect(cmd?.includes('--codex-stop')).toBe(stop !== 85)
      if (stop !== 85) expect(cmd?.includes('--codex-stop 75.5')).toBe(true)
    }
  })
}

test('tool and prompt notices await their own nudge records and retain their session across clear', { options: { mode: 'always', stretchCalls: 1 } }, async ($, on) => {
  const world = setup(on)
  await start($)
  let release = () => {}
  world.nudgeGate = new Promise<void>(resolve => { release = resolve })
  let toolDone = false
  const tool = $.tool.call({ tool: 'Bash', command: 'true' }).then(result => { toolDone = true; return result })
  for (let i = 0; i < 1000 && !world.nudges.length; i++) await Promise.resolve()
  expect(world.nudges.length).toBe(1)
  expect(toolDone).toBe(false)
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
  world.sessionId = 'new-session'
  let promptDone = false
  const prompt = $.prompt.submit({ text: 'Next', wait: false, origin: ORIGIN }).then(result => { promptDone = true; return result })
  for (let i = 0; i < 1000 && world.nudges.length < 2; i++) await Promise.resolve()
  expect(world.nudges.length).toBe(2)
  expect(promptDone).toBe(false)
  release()
  const context = (await tool).context
  expect(context?.length).toBe(3)
  expect(context?.[0]).toBe('existing tool context')
  expect(context?.[1]?.includes('hand-offs are on')).toBe(true)
  expect(context?.[2]?.includes('1 main-loop tool calls')).toBe(true)
  expect((await prompt).context?.[0]?.includes('crossfeed is set to always')).toBe(true)
  expect(world.bashCalls).toBe(1)
  const script = world.processes[0]!.argv[2]!
  for (const call of world.nudges) {
    expect(call.argv).toEqual(['python3', '-I', script, 'nudge'])
    expect(call.timeout).toBe(5000)
  }
  expect(world.nudges.map(call => JSON.parse(call.stdin!))).toEqual([
    { session: 'test-session', kind: 'balance-on', reasons: ['always'], calls: null },
    { session: 'new-session', kind: 'balance-on', reasons: ['always'], calls: null },
    { session: 'test-session', kind: 'stretch', reasons: ['always'], calls: 1 },
  ])
})

test('both weekly fields and the account-week refusal survive a newer measure during stash', async ($, on) => {
  const world = setup(on)
  const week = { kind: 'seven_day' as const, percentUsed: 79, resetsAt: new Date(BASE + 3.5 * 1440 * MINUTE).toISOString() }
  world.usage = [{ kind: 'five_hour', percentUsed: 5, resetsAt: RESET }, week]
  await start($)
  let release = () => {}
  world.stashGate = new Promise<void>(resolve => { release = resolve })
  const call = $.tool.call(RESEARCH)
  for (let i = 0; i < 1000 && !world.sequence.includes('stash'); i++) await Promise.resolve()
  expect(world.sequence.includes('stash')).toBe(true)
  await measure($, world, 10)
  release()
  const deny = (await call).deny ?? ''
  expect(deny.split('\n')[1]).toBe('Why: tier B; Claude all-models weekly 79% used, ahead of an even pace (50%).')
  expect(deny.includes('--kind subagent --cause account-week')).toBe(true)
  expect(decisions(world)[0]).toEqual(expect.objectContaining({
    cause: 'account-week', account_week: { percent: 79, line: 50, state: 'ahead' }, codex_surplus: -18,
  }))
})

test('prompt submission records balance-off only after a known recovery and never probes', async ($, on) => {
  const world = setup(on)
  const week = { kind: 'seven_day' as const, percentUsed: 79, resetsAt: new Date(BASE + 3.5 * 1440 * MINUTE).toISOString() }
  world.usage = [week]
  await start($)
  const prompt = { text: 'Next', wait: false, origin: ORIGIN }
  expect((await $.prompt.submit(prompt)).context?.[0]?.includes('hand-offs are on')).toBe(true)
  world.now += 16 * MINUTE
  expect((await $.prompt.submit(prompt)).context ?? []).toEqual([])
  expect(world.processes.filter(call => call.argv[3] === 'quota').length).toBe(1)
  expect(world.usageProcesses.length).toBe(1)
  world.usage = [{ ...week, percentUsed: 10 }]
  await $.session.measure({ context: { window: 200000 }, rateLimits: world.usage, changed: ['rateLimits'] })
  expect((await $.prompt.submit(prompt)).context?.[0]?.includes('hand-offs are off')).toBe(true)
  expect((await $.prompt.submit(prompt)).context ?? []).toEqual([])
  expect(world.nudges.map(call => JSON.parse(call.stdin!))).toEqual([
    { session: 'test-session', kind: 'balance-on', reasons: ['account-week'], calls: null },
    { session: 'test-session', kind: 'balance-off', reasons: [], calls: null },
  ])
})

for (const failure of ['throw', 'deny', 'nonzero'] as const) {
  test(`a failed nudge write (${failure}) still delivers the notice and never replays the tool`, async ($, on) => {
    const world = setup(on)
    await start($)
    await command($, 'always')
    world.nudgeFailure = failure
    const result = await $.tool.call({ tool: 'Bash', command: 'true' })
    expect(result.context?.[1]?.includes('hand-offs are on')).toBe(true)
    expect(world.bashCalls).toBe(1)
    expect(world.nudges.length).toBe(1)
    expect(world.logs.some(line => line.startsWith('crossfeed: nudge record'))).toBe(true)
    expect((await $.prompt.submit({ text: 'Next', wait: false, origin: ORIGIN })).context ?? []).toEqual([])
  })
}

for (const [age, kept] of [[0, 30], [60, 40]] as const) {
  test(`overlapping quota replies use answer time less log age (${age}s)`, async ($, on) => {
    const world = setup(on)
    await start($)
    const quota = (used_percent: number, age_s: number) => processResult(JSON.stringify({ ...QUOTA, age_s, windows: [{ ...QUOTA.windows[0], used_percent }] }))
    world.now += 20 * MINUTE
    world.quota = quota(30, age)
    let release = () => {}
    world.quotaGate = new Promise<void>(resolve => { release = resolve })
    const first = measure($, world, 5)
    for (let i = 0; i < 1000 && world.sequence.filter(name => name === 'quota').length < 2; i++) await Promise.resolve()
    expect(world.sequence.filter(name => name === 'quota').length).toBe(2)
    world.now += 6 * MINUTE
    world.quota = quota(40, 0)
    world.quotaGate = undefined
    await measure($, world, 5)
    world.now += 10 * 1000
    release()
    await first
    const status = (await command($, 'status')).text ?? ''
    expect(status.includes(`codex wk ${kept}%`)).toBe(true)
    expect(status.includes(`Codex reading age: ${age === 0 ? 0 : 10} seconds`)).toBe(true)
  })
}

test('a tool finishing after clear leaves the new conversation’s notices and count for its own calls', { options: { mode: 'always', stretchCalls: 1 } }, async ($, on) => {
  const world = setup(on)
  await start($)
  let release = () => {}
  world.clockGate = new Promise<void>(resolve => { release = resolve })
  world.holdClockReadAt = world.clockReads + 1
  const bash = { tool: 'Bash' as const, command: 'true' }
  const old = $.tool.call(bash)
  for (let i = 0; i < 1000 && !world.clockHeld; i++) await Promise.resolve()
  expect(world.clockHeld).toBe(true)
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
  world.sessionId = 'new-session'
  await measure($, world, 5)
  release()
  expect((await old).context).toEqual(['existing tool context'])
  expect(world.nudges.length).toBe(0)
  await $.tool.call(bash)
  expect(world.nudges.map(call => JSON.parse(call.stdin!))).toEqual([
    { session: 'new-session', kind: 'balance-on', reasons: ['always'], calls: null },
    { session: 'new-session', kind: 'stretch', reasons: ['always'], calls: 1 },
  ])
})

async function waitForBackground(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await Promise.resolve()
  expect(condition()).toBe(true)
}

const WORKFLOW_SPAWN = { ...SPAWN, subagentType: 'workflow-subagent', workflow: { runId: 'wf_test', agentIndex: 2 } }
const WORKFLOW = { tool: 'Workflow' as const, script: 'return [];', name: 'test' }

function completeTurn($: Engine, turnId: string, agentId?: string) {
  return $.turn.complete({ answer: '', reason: 'answer', durationMs: 1, isAborted: false, turnId, agentId })
}

test('shed admission checks every spawn origin and propagates background lineage', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 20)
  world.nextAgentId = 'workflow-parent'
  await $.agent.spawn(WORKFLOW_SPAWN)
  world.nextAgentId = 'background-parent'
  await $.agent.spawn({ ...SPAWN, background: true })
  world.nextAgentId = 'background-child'
  await $.agent.spawn({ ...SPAWN, parentAgentId: 'background-parent' })
  world.nextAgentId = 'foreground-parent'
  await $.agent.spawn(SPAWN)
  await measure($, world, 85)
  const workflow = await $.agent.spawn({ ...WORKFLOW_SPAWN, model: 'opus' })
  for (const part of ['85%', RESET, 'this agent did not start', 'resumeFromRunId']) {
    expect(workflow.deny?.includes(part)).toBe(true)
  }
  const starts = [
    [{}, 'agent-tool', 'started'],
    [{ parentAgentId: 'foreground-parent' }, 'agent-tool', 'started'],
    [{ background: true }, 'agent-tool', 'refused'],
    [{ parentAgentId: 'workflow-parent' }, 'agent-tool', 'refused'],
    [{ parentAgentId: 'background-parent' }, 'agent-tool', 'refused'],
    [{ parentAgentId: 'background-child' }, 'agent-tool', 'refused'],
    [{ fork: true, tool_use_id: '', background: true }, 'fork', 'refused'],
    [{ isTeammate: true, background: true }, 'teammate', 'refused'],
    [{ resume: { agentId: 'foreground-parent' } }, 'resume', 'started'],
    [{ tool_use_id: '' }, 'other', 'started'],
  ] as const
  for (const [input, , outcome] of starts) {
    const result = await $.agent.spawn({ ...SPAWN, ...input })
    expect(result.deny !== undefined).toBe(outcome === 'refused')
  }
  await waitForBackground(() => world.records.flat().length === 5 + starts.length)
  const rows = world.records.flat().slice(4)
  expect(rows[0]).toEqual({ type: 'spawn', session: 'test-session', origin: 'workflow',
    run_id: 'wf_test', agent_index: 2, model: 'opus', outcome: 'refused' })
  expect(rows.slice(1).map(row => row.type === 'spawn' && [row.origin, row.outcome])).toEqual(
    starts.map(([, origin, outcome]) => [origin, outcome]),
  )
})

test('breaker checks registered Workflow, Agent, teammate and command-fork tasks before the crossing', async ($, on) => {
  const world = setup(on)
  await start($)
  await measure($, world, 20)
  await $.tool.call(WORKFLOW)
  await $.tool.call({ ...AGENT, prompt: 'Brief' })
  world.nextAgentId = 'teammate'
  await $.agent.spawn({ ...SPAWN, background: true, isTeammate: true })
  world.nextAgentId = 'fork'
  await $.agent.spawn({ ...SPAWN, background: true, fork: true, tool_use_id: '' })
  await waitForBackground(() => world.background.get('test-session')?.tasks.length === 4)
  world.verdicts.set('test-agent', 'deny')
  world.verdicts.set('teammate', 'ask')
  world.stopErrors.set('workflow-task', 'temporarily unavailable')
  world.stopErrors.set('fork', 'Task fork is not running')
  let release!: () => void
  world.stopGate = new Promise(resolve => { release = resolve })
  await measure($, world, 85)
  await waitForBackground(() => world.stops.length === 3)
  expect([...world.checks].sort()).toEqual(['fork', 'teammate', 'test-agent', 'workflow-task'])
  expect([...world.stops].sort()).toEqual(['fork', 'teammate', 'workflow-task'])
  world.workflowTaskId = 'late-workflow'
  await $.tool.call(WORKFLOW)
  release()
  await waitForBackground(() => world.records.flat().filter(row => row.type === 'breaker').length === 3)
  expect(world.records.flat()).toContainEqual({ type: 'breaker', session: 'test-session', outcome: 'denied',
    task_id: 'test-agent', run_id: null, reason: 'a TaskStop rule' })
  expect(world.toasts.some(note => note.includes('TaskStop denied for task test-agent'))).toBe(true)
  world.stopErrors.delete('workflow-task')
  world.now += MINUTE
  await measure($, world, 86)
  await waitForBackground(() => world.records.flat().some(row => row.type === 'breaker' && row.run_id === 'wf_test' && row.outcome === 'stopped'))
  expect(world.stops.slice(3)).toEqual(['workflow-task'])
})

test('an idle coordinator gets the pace prompt and the second event goes to notices', async ($, on) => {
  const world = setup(on)
  world.surfaces = ['terminal']
  await start($)
  await $.tool.call(WORKFLOW)
  await measure($, world, 20)
  let release!: () => void
  world.wakeGate = new Promise(resolve => { release = resolve })
  world.now += 10 * MINUTE
  await measure($, world, 80)
  await waitForBackground(() => world.wakePrompts.length === 1)
  expect(world.wakePrompts[0]?.includes('full in 4 min')).toBe(true)
  release()
  await waitForBackground(() => world.records.flat().some(row => row.type === 'wake' && row.outcome === 'prompt'))
  world.now += MINUTE
  await measure($, world, 85)
  await waitForBackground(() => world.toasts.some(note => note.includes('Stopped task workflow-task')))
  const prompt = await $.prompt.submit({ text: 'Continue', origin: ORIGIN, wait: false })
  expect(prompt.context?.some(note => note.includes('workflow-task') && note.includes('wf_test') &&
    note.includes('resumeFromRunId') && note.includes('keep a hand-off note'))).toBe(true)
  expect(world.wakePrompts.length).toBe(1)
})

test('a confirmed breaker stop wakes the idle coordinator even without a pace reading', async ($, on) => {
  const world = setup(on)
  world.surfaces = ['terminal']
  await start($)
  await measure($, world, 20)
  await $.tool.call(WORKFLOW)
  let release!: () => void
  world.stopGate = new Promise(resolve => { release = resolve })
  await measure($, world, 85)
  await waitForBackground(() => world.stops.length === 1)
  expect(world.wakePrompts).toEqual([])
  release()
  await waitForBackground(() => world.wakePrompts.length === 1)
  expect(world.wakePrompts[0]?.includes('Stopped task workflow-task (run wf_test')).toBe(true)
  expect(world.wakePrompts[0]?.includes('pace unknown')).toBe(true)
})

test('a clear gives the new conversation its own breaker wake in the same quota window', async ($, on) => {
  const world = setup(on)
  world.surfaces = ['terminal']
  await start($)
  await measure($, world, 20)
  await $.tool.call(WORKFLOW)
  world.now += 10 * MINUTE
  await measure($, world, 80)
  await waitForBackground(() => world.wakePrompts.length === 1)

  await $.session.end({ reason: 'clear', sessionId: world.sessionId, resume: { id: world.sessionId } })
  world.sessionId = 'new-conversation'
  world.workflowTaskId = 'new-workflow-task'
  await $.tool.call(WORKFLOW)
  world.now += MINUTE
  await measure($, world, 85)
  await waitForBackground(() => world.wakePrompts.length === 2)
  expect(world.wakePrompts[1]).toContain('Stopped task new-workflow-task')
  expect(world.stops).toEqual(['new-workflow-task'])
})

test('a workflow stop denial shows its run without resume advice and fills in a missing reason only in the notice', async ($, on) => {
  const world = setup(on)
  world.stopDeniedReason = undefined
  world.verdicts.set('workflow-task', 'deny')
  await start($)
  await measure($, world, 20)
  await $.tool.call(WORKFLOW)
  await measure($, world, 85)
  await waitForBackground(() => world.toasts.length === 1)
  expect(world.toasts[0]).toContain('TaskStop denied for task workflow-task (run wf_test). Permission denied.')
  expect(world.toasts[0]).not.toContain('resumeFromRunId')
  expect(world.records.flat()).toContainEqual({ type: 'breaker', session: 'test-session', outcome: 'denied',
    task_id: 'workflow-task', run_id: 'wf_test', reason: null })
  expect(world.stops).toEqual([])
})

test('pace always queues a warning even without registered tasks', async ($, on) => {
  const world = setup(on)
  world.surfaces = ['terminal']
  await start($)
  await measure($, world, 20)
  world.now += 10 * MINUTE
  await measure($, world, 80)
  const prompt = await $.prompt.submit({ text: 'Continue', origin: ORIGIN, wait: false })
  expect(prompt.context?.some(note => note.includes('window will fill before reset'))).toBe(true)
  await measure($, world, 81)
  const next = await $.prompt.submit({ text: 'Again', origin: ORIGIN, wait: false })
  expect(next.context?.some(note => note.includes('window will fill before reset')) ?? false).toBe(false)
  expect(world.wakePrompts).toEqual([])
})

for (const name of ['busy', 'no surface', 'wake disabled'] as const) {
  test(`pace wake queues a notice when ${name}`, { options: { wake: name !== 'wake disabled' } }, async ($, on) => {
    const world = setup(on)
    if (name !== 'no surface') world.surfaces = ['terminal']
    await start($)
    if (name === 'busy') await $.turn.start({ text: 'Working', turnId: 'main' })
    await measure($, world, 20)
    await $.tool.call(WORKFLOW)
    world.now += 10 * MINUTE
    await measure($, world, 80)
    await waitForBackground(() => world.records.flat().some(row => row.type === 'wake' && row.outcome === 'notice'))
    expect(world.wakePrompts).toEqual([])
    expect(world.toasts.length).toBe(name === 'wake disabled' ? 0 : 1)
    const prompt = await $.prompt.submit({ text: 'Continue', origin: ORIGIN, wait: false })
    expect(prompt.context?.some(note => note.includes('window will fill before reset'))).toBe(true)
    expect(prompt.context?.some(note => note.includes('keep a hand-off note'))).toBe(true)
  })
}

test('a pace crossing at admission defers wake until measure or main turn completion', async ($, on) => {
  const world = setup(on)
  world.surfaces = ['terminal']
  await start($)
  await measure($, world, 20)
  await $.tool.call(WORKFLOW)
  await $.turn.start({ turnId: 'main', text: 'Working' })
  world.now += 10 * MINUTE
  world.usage = [{ kind: 'five_hour', percentUsed: 80, resetsAt: RESET }]
  expect((await $.agent.spawn(WORKFLOW_SPAWN)).deny?.includes('80%')).toBe(true)
  await completeTurn($, 'subagent', 'workflow-child')
  expect(world.wakePrompts).toEqual([])
  await completeTurn($, 'main')
  await waitForBackground(() => world.wakePrompts.length === 1)
  await measure($, world, 80)
  expect(world.wakePrompts.length).toBe(1)
})

test('a pace crossing at admission wakes on the next measure', async ($, on) => {
  const world = setup(on)
  world.surfaces = ['terminal']
  await start($)
  await measure($, world, 20)
  await $.tool.call(WORKFLOW)
  world.now += 10 * MINUTE
  world.usage = [{ kind: 'five_hour', percentUsed: 80, resetsAt: RESET }]
  expect((await $.agent.spawn(WORKFLOW_SPAWN)).deny?.includes('80%')).toBe(true)
  expect(world.wakePrompts).toEqual([])
  await measure($, world, 80)
  await waitForBackground(() => world.wakePrompts.length === 1)
})

test('off passes spawns and keeps task registration without protection or telemetry', { options: { mode: 'off' } }, async ($, on) => {
  const world = setup(on)
  world.surfaces = ['terminal']
  await start($)
  await measure($, world, 20)
  await $.tool.call(WORKFLOW)
  world.now += 10 * MINUTE
  await measure($, world, 99)
  expect((await $.agent.spawn(WORKFLOW_SPAWN)).deny).toBe(undefined)
  await waitForBackground(() => world.background.get('test-session')?.tasks[0]?.id === 'workflow-task')
  expect(world.checks).toEqual([])
  expect(world.wakePrompts).toEqual([])
  expect(world.records).toEqual([])
})

test('the row queue uses one writer and drops the oldest entries above 500', async ($, on) => {
  const world = setup(on)
  await start($)
  let release!: () => void
  world.recordGate = new Promise(resolve => { release = resolve })
  await $.agent.spawn({ ...SPAWN, model: 'test-0' })
  await waitForBackground(() => world.writers === 1)
  for (let i = 1; i <= 503; i++) await $.agent.spawn({ ...SPAWN, model: `test-${i}` })
  expect(world.records.length).toBe(1)
  release()
  await waitForBackground(() => world.records.length === 2)
  const batch = world.records[1] ?? []
  expect(batch.length).toBe(500)
  expect(batch[0]).toEqual(expect.objectContaining({ model: 'test-4' }))
  expect(batch[499]).toEqual(expect.objectContaining({ model: 'test-503' }))
  expect(world.maxWriters).toBe(1)
  expect(world.logs.some(log => log.includes('dropped 3 oldest rows'))).toBe(true)
})
