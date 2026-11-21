import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from '../../hooks/config'
import { createCore } from '../../hooks/core'
import type { Core } from '../../hooks/core'
import type { AgentCall, CodexReading } from '../../hooks/policy'

const BASE = 1794902400000
const MINUTE = 60000
const RESET = BASE + 300 * MINUTE
const SCRIPT = '/plugin/crossfeed.py'
const CWD = "/tmp/it's 检查"
const A = { prompt: 'Implement the parser described in docs/plan.md. '.repeat(4) + 'Check: pytest tests/test_parser.py' }
const B = { prompt: 'Research which vendors support the requested protocol and report with sources. '.repeat(3) }
const C = { prompt: 'Design the API for the billing module. '.repeat(4) }

function agentCall(core: Core, call: AgentCall, cwd: string, now: number): { deny: string } | undefined {
  const route = core.route(call, now)
  return route ? { deny: core.denial(route, call, cwd, now) } : undefined
}

function codex(now = BASE): CodexReading {
  return { windows: [{ minutes: 10080, usedPercent: 18, resetsAt: BASE + 5 * 1440 * MINUTE }], limitReached: false, readAt: now }
}

function measure(core: Core, percentUsed: number, now = BASE, resetsAt = RESET): void {
  core.measure({ fiveHour: { percentUsed, resetsAt } }, now)
}

function heavy(core: Core, start = BASE, reset = RESET): void {
  for (let minute = 0; minute <= 20; minute += 5) {
    measure(core, minute, start + minute * MINUTE, reset)
  }
  core.setCodex(codex(start + 20 * MINUTE))
}

function cleanStatus(core: Core, now = BASE): void {
  for (const text of [core.status(now), core.describe(now)]) {
    expect(text.includes('undefined')).toBe(false)
    expect(text.includes('NaN')).toBe(false)
    expect(text.endsWith('\n')).toBe(false)
  }
  expect(core.describe(now).includes('\n')).toBe(true)
}

test('tier A is denied in a fresh low-usage window with a quoted write command', async () => {
  const core = createCore(DEFAULTS, SCRIPT, 'session-1')
  core.setCodex(codex())
  measure(core, 5)
  const deny = agentCall(core, A, CWD, BASE)?.deny ?? ''
  expect(deny.startsWith('crossfeed:')).toBe(true)
  expect(deny.includes('--tier A')).toBe(true)
  expect(deny.includes('--write')).toBe(true)
  expect(deny.includes("--dir '/tmp/it'\\''s 检查'")).toBe(true)
  expect(deny.includes("--session 'session-1'")).toBe(true)
  expect(deny.includes('Claude 5h 5%; Codex weekly 18%.')).toBe(true)
  cleanStatus(core)
})

test('missing five-hour or Codex readings and off mode allow the call', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  cleanStatus(core)
  core.setCodex(codex())
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  core.measure({ sevenDay: { percentUsed: 90 } }, BASE)
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  cleanStatus(core)
  core.setCodex(undefined)
  measure(core, 5)
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  core.setCodex(codex())
  core.setMode('off')
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  expect(core.status(BASE)).toBe('crossfeed off')
  cleanStatus(core)
})

test('tier B requires pressure and uses a read-only command', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  core.setCodex(codex())
  measure(core, 0)
  expect(agentCall(core, B, CWD, BASE)).toBe(undefined)
  heavy(core)
  const deny = agentCall(core, B, CWD, BASE + 20 * MINUTE)?.deny ?? ''
  expect(deny.includes('--tier B')).toBe(true)
  expect(deny.split('\n')[3]?.includes('--write')).toBe(false)
  expect(deny.includes('on pace for 300%')).toBe(true)
  cleanStatus(core, BASE + 20 * MINUTE)
})

test('tier C, fork, empty briefs and Claude-only tools are never denied', async () => {
  const core = createCore({ ...DEFAULTS, mode: 'always' }, SCRIPT)
  heavy(core)
  for (const call of [C, { ...A, subagent_type: 'fork' }, { prompt: '\r\n ' }, { ...A, prompt: A.prompt + ' Use AskUserQuestion.' }]) {
    expect(agentCall(core, call, CWD, BASE + 20 * MINUTE)).toBe(undefined)
  }
})

test('core forwards worktree and configured dispatch options', async () => {
  const core = createCore({ ...DEFAULTS, effort: 'xhigh', model: 'model name', timeoutMinutes: 5 }, SCRIPT)
  core.setCodex(codex())
  measure(core, 5)
  const command = agentCall(core, { ...A, isolation: 'worktree' }, CWD, BASE)?.deny.split('\n')[3] ?? ''
  expect(command.includes('--worktree')).toBe(true)
  expect(command.includes("--effort 'xhigh'")).toBe(true)
  expect(command.includes("--model 'model name'")).toBe(true)
  expect(command.includes('--timeout 5')).toBe(true)
})

test('Codex age, stale readings and exhausted windows control admission', async () => {
  const core = createCore({ ...DEFAULTS, mode: 'always' }, SCRIPT)
  expect(core.codexAge(BASE)).toBe(Infinity)
  core.setCodex(codex())
  expect(core.codexAge(BASE + MINUTE)).toBe(MINUTE)
  measure(core, 5)
  expect(agentCall(core, A, CWD, BASE + 16 * MINUTE)).toBe(undefined)
  core.setCodex({ ...codex(), limitReached: true })
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  core.setCodex({ ...codex(), windows: [] })
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  core.setCodex(undefined)
  expect(core.codexAge(BASE)).toBe(Infinity)
  cleanStatus(core)
})

test('pressure notices are queued once per window and drained once per prompt', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  heavy(core)
  expect(core.userPrompt().length).toBe(1)
  expect(core.userPrompt()).toEqual([])
  measure(core, 25, BASE + 25 * MINUTE)
  expect(core.userPrompt()).toEqual([])
  const next = BASE + 300 * MINUTE
  heavy(core, next, RESET + 300 * MINUTE)
  const notices = core.userPrompt()
  expect(notices.length).toBe(1)
  expect(notices[0]?.includes('pressure 0.3')).toBe(true)
})

test('reserve notices are once per window and reset jitter does not repeat them', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  measure(core, 89)
  expect(core.userPrompt().length).toBe(1)
  measure(core, 90, BASE + MINUTE)
  const notices = core.userPrompt()
  expect(notices.length).toBe(1)
  expect(notices[0]?.includes('reserve')).toBe(true)
  measure(core, 97, BASE + 2 * MINUTE, RESET + MINUTE)
  expect(core.userPrompt()).toEqual([])
  measure(core, 95, RESET, RESET + 300 * MINUTE)
  expect(core.userPrompt().length).toBe(2)
  expect(core.status(RESET).endsWith(' · reserve')).toBe(true)
  cleanStatus(core, RESET)
})

test('stretch reminders count only main-loop tools and occur once per prompt', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  heavy(core)
  for (let i = 0; i < 12; i++) {
    expect(core.toolCall('Bash', true)).toBe(undefined)
    expect(core.toolCall('Agent', false)).toBe(undefined)
  }
  for (let i = 1; i < 12; i++) expect(core.toolCall('Bash', false)).toBe(undefined)
  expect(core.toolCall('Bash', false)?.includes('12 main-loop tool calls')).toBe(true)
  expect(core.toolCall('Bash', false)).toBe(undefined)
  core.userPrompt()
  for (let i = 1; i < 12; i++) expect(core.toolCall('Bash', false)).toBe(undefined)
  expect(core.toolCall('Bash', false)?.includes('12 main-loop tool calls')).toBe(true)
})

test('all seven counted tools contribute and low pressure gives no reminder', async () => {
  const core = createCore({ ...DEFAULTS, stretchCalls: 7 }, SCRIPT)
  heavy(core)
  for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob']) {
    expect(core.toolCall(tool, false)).toBe(undefined)
  }
  expect(core.toolCall('NotebookEdit', false)?.includes('7 main-loop tool calls')).toBe(true)
  const quiet = createCore(DEFAULTS, SCRIPT)
  measure(quiet, 5)
  for (let i = 0; i < 20; i++) expect(quiet.toolCall('Bash', false)).toBe(undefined)
})

test('off mode suppresses steering notices and reminders and mode changes stay local', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  heavy(core)
  core.setMode('off')
  expect(core.userPrompt()).toEqual([])
  measure(core, 95, BASE + 25 * MINUTE)
  expect(core.userPrompt()).toEqual([])
  for (let i = 0; i < 20; i++) expect(core.toolCall('Bash', false)).toBe(undefined)
  core.setMode('always')
  expect(agentCall(core, B, CWD, BASE + 25 * MINUTE)?.deny.includes('--tier B')).toBe(true)
  expect(DEFAULTS.mode).toBe('auto')
  expect(createCore(DEFAULTS, SCRIPT).status(BASE)).toBe('crossfeed auto · codex unavailable · waiting for a reading')
})

test('lockouts require rate_limit and at least 95 percent usage', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  expect(core.stopFailure('rate_limit', BASE)).toBe(undefined)
  measure(core, 97)
  expect(core.stopFailure('rate_limit', BASE)).toEqual({ resetAt: '2026-11-17T13:00:00.000Z' })
  expect(core.stopFailure('overloaded', BASE)).toBe(undefined)
  measure(core, 40)
  expect(core.stopFailure('rate_limit', BASE)).toBe(undefined)
  core.measure({ fiveHour: { percentUsed: 95 } }, BASE)
  expect(core.stopFailure('rate_limit', BASE)).toEqual({ resetAt: 'unknown' })
  cleanStatus(core)
})

test('status reports current readings and selects the longest Codex window', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  core.measure({ fiveHour: { percentUsed: 5, resetsAt: RESET }, sevenDay: { percentUsed: 41 } }, BASE)
  core.setCodex({ ...codex(), windows: [{ minutes: 300, usedPercent: 91 }, ...codex().windows] })
  expect(core.status(BASE)).toBe('crossfeed auto · claude 5h 5% · 7d 41% · codex wk 18% · pressure 0')
  expect(agentCall(core, A, CWD, BASE)).toBe(undefined)
  core.setCodex({ ...codex(), windows: [{ minutes: 300, usedPercent: 10 }] })
  expect(core.status(BASE).includes('codex wk')).toBe(false)
  cleanStatus(core)
})

test('describe explains both tier decisions immediately after the status line', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  expect(core.describe(BASE).split('\n').slice(1, 3)).toEqual([
    'tier A calls: stay on Claude (no Claude reading yet)',
    'tier B calls: stay on Claude (no Claude reading yet)',
  ])
  measure(core, 0)
  core.setCodex(codex())
  expect(core.describe(BASE).split('\n').slice(1, 3)).toEqual([
    'tier A calls: handed to Codex', 'tier B calls: stay on Claude (pressure is low)',
  ])
  heavy(core)
  expect(core.describe(BASE + 20 * MINUTE).split('\n').slice(1, 3)).toEqual([
    'tier A calls: handed to Codex', 'tier B calls: handed to Codex',
  ])
  core.setMode('off')
  expect(core.describe(BASE).split('\n').slice(1, 3)).toEqual([
    'tier A calls: stay on Claude (crossfeed is off)', 'tier B calls: stay on Claude (crossfeed is off)',
  ])
})

test('a new window discards queued pressure and reserve notices from the old window', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  measure(core, 97)
  measure(core, 5, RESET, RESET + 300 * MINUTE)
  expect(core.userPrompt()).toEqual([])
  measure(core, 97, RESET + MINUTE, RESET + 300 * MINUTE)
  const notices = core.userPrompt()
  expect(notices.length).toBe(2)
  expect(notices.every(notice => notice.includes('97%'))).toBe(true)
})

test('needsCodex only permits eligible non-C calls while routing is enabled', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  expect(core.needsCodex(A)).toBe(true)
  expect(core.needsCodex(B)).toBe(true)
  for (const call of [C, { ...A, subagent_type: 'Explore' }, { ...A, name: 'teammate' }, { prompt: '' }]) {
    expect(core.needsCodex(call)).toBe(false)
  }
  core.setMode('off')
  expect(core.needsCodex(A)).toBe(false)
  core.setMode('always')
  expect(core.needsCodex(B)).toBe(true)
})

test('route returns the fit reason and denial uses the saved file or a safe fallback', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  core.setCodex(codex())
  measure(core, 5)
  const call = { ...A, prompt: A.prompt + '\r\nCROSSFEED_BRIEF_' + BASE.toString(36) + '\r\n$(touch pwned)' }
  const route = core.route(call, BASE)
  expect(route).toEqual({ tier: 'A', reason: 'has a check command and is implementation-type work' })
  if (!route) throw new Error('expected handoff')
  const saved = core.denial(route, call, CWD, BASE, '/tmp/检查 brief.md')
  expect(saved.includes("--brief-file '/tmp/检查 brief.md'")).toBe(true)
  expect(saved.includes('The brief you just wrote is saved.')).toBe(true)
  expect(saved.includes('<<')).toBe(false)
  const fallback = core.denial(route, call, CWD, BASE)
  const delimiter = fallback.split('\n')[5] ?? ''
  expect(delimiter.startsWith('CROSSFEED_BRIEF_' + BASE.toString(36))).toBe(true)
  expect(call.prompt.includes(delimiter)).toBe(false)
  expect(fallback.includes("<<'" + delimiter + "'")).toBe(true)
})

test('describe remembers the last actual decision and preserves policy reasons', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  function last() { return core.describe(BASE).split('\n').find(line => line.startsWith('last subagent call:')) }
  expect(last()).toBe('last subagent call: none yet')
  core.route(A, BASE)
  expect(last()).toBe('last subagent call: stayed on Claude (no Claude reading yet)')
  measure(core, 5)
  core.route(A, BASE)
  expect(last()).toBe('last subagent call: stayed on Claude (no Codex reading)')
  core.setCodex(codex())
  core.route(A, BASE)
  expect(last()).toBe('last subagent call: handed to Codex (has a check command and is implementation-type work)')
  core.setMode('off')
  expect(last()).toBe('last subagent call: handed to Codex (has a check command and is implementation-type work)')
  core.route(A, BASE)
  expect(last()).toBe('last subagent call: stayed on Claude (crossfeed is off)')
  core.setMode('auto')
  core.route({ ...A, subagent_type: 'Explore' }, BASE)
  expect(last()).toBe('last subagent call: stayed on Claude (type Explore keeps its own setup)')
  core.route(C, BASE)
  expect(last()).toBe('last subagent call: stayed on Claude (tier C stays on Claude)')
  core.route(B, BASE)
  expect(last()).toBe('last subagent call: handed to Codex (no check command; burst: 3 earlier subagent calls stayed on Claude in 10 minutes)')
  core.setCodex({ ...codex(), windows: [{ minutes: 10080, usedPercent: 84 }] })
  core.route(A, BASE)
  expect(last()).toBe('last subagent call: stayed on Claude (Codex headroom is low)')
})

const LIMIT_RESET = Date.parse('2026-11-23T22:00:00Z')
const SPAWN = { subagentType: 'general-purpose', fork: false, parentModel: 'claude-fable-5-2' }
function limitCore(percent = 62, main = 'claude-fable-5-2', age = 0, fiveHour: number | undefined = 10) {
  const core = createCore(DEFAULTS, SCRIPT)
  if (fiveHour !== undefined) measure(core, fiveHour)
  core.setCodex(codex())
  core.setMainModel(main, BASE)
  core.setUsage({ readAt: BASE - age, buckets: [{ label: 'Fable', family: 'fable', usedPercent: percent, resetsAt: BASE + 4.5 * 1440 * MINUTE }] }, undefined, BASE)
  return core
}

test('a tier B call on an ahead model is handed off at low pressure, including before five-hour data', async () => {
  for (const fiveHour of [10, undefined, 80]) {
    const core = limitCore(62, 'claude-fable-5-2', 0, fiveHour)
    // Explicit undefined must remove the helper default's five-hour reading.
    if (fiveHour === undefined) core.measure({}, BASE)
    const route = core.route(B, BASE)
    expect(route?.tier).toBe('B')
    const denial = core.denial(route!, B, CWD, BASE)
    expect(denial.includes('Fable weekly 62% used')).toBe(true)
    expect(denial.includes('--cause limit')).toBe(fiveHour !== 80)
  }
  for (const [main, age] of [['claude-opus-5-5', 0], ['fable', 21 * MINUTE], ['fable', -6 * MINUTE]] as const) {
    const core = limitCore(62, main, age)
    expect(core.route(B, BASE)).toBe(undefined)
    expect(core.lastDecision().includes('pressure is low')).toBe(true)
  }
  expect(limitCore(62, 'opus').route({ ...B, model: 'Fable 5.2' }, BASE)?.tier).toBe('B')
  expect(limitCore().route({ ...B, model: 'opus' }, BASE)).toBe(undefined)
})

test('tier A keeps its headroom rule while Fable is ahead', async () => {
  const core = limitCore()
  core.setCodex({ ...codex(), windows: [{ minutes: 10080, usedPercent: 77, resetsAt: BASE + 7 * 1440 * MINUTE }] })
  expect(core.route(A, BASE)).toBe(undefined)
  expect(core.lastDecision().includes('headroom is low')).toBe(true)
  expect(core.route(B, BASE)?.tier).toBe('B')
})

test('spawnModel uses the event parent and protects custom agent definitions', async () => {
  const core = limitCore()
  expect(core.spawnModel(SPAWN, BASE)).toEqual({ model: 'opus', from: 'claude-fable-5-2', bucket: 'Fable', percent: 62 })
  expect(core.spawnModel({ ...SPAWN, subagentType: 'Explore' }, BASE)).toBe(undefined)
  expect(core.spawnModel({ ...SPAWN, parentModel: 'opus' }, BASE)).toBe(undefined)
  core.setMainModel('opus', BASE)
  expect(core.spawnModel(SPAWN, BASE)?.model).toBe('opus')
  expect(core.spawnModel(SPAWN, BASE + 21 * MINUTE)).toBe(undefined)
})

test('limit notices fire once per family and state, including a later main-model change', async () => {
  const core = limitCore()
  const usage = { readAt: BASE, buckets: [{ label: 'Fable', family: 'fable' as const, usedPercent: 62, resetsAt: LIMIT_RESET }] }
  expect(core.takeNotices().length).toBe(1)
  core.setUsage(usage, undefined, BASE)
  expect(core.takeNotices()).toEqual([])
  core.setUsage({ ...usage, buckets: [{ ...usage.buckets[0]!, usedPercent: 100 }] }, undefined, BASE)
  expect(core.takeNotices()[0]?.includes('limit is used up')).toBe(true)
  core.setMainModel('opus', BASE)
  expect(core.takeNotices()).toEqual([])
  const switched = limitCore(62, 'opus')
  expect(switched.takeNotices()).toEqual([])
  switched.setMainModel('fable', BASE)
  expect(switched.takeNotices().length).toBe(1)
  const off = createCore({ ...DEFAULTS, mode: 'off' }, SCRIPT)
  off.setMainModel('fable', BASE)
  off.setUsage(usage, undefined, BASE)
  expect(off.takeNotices()).toEqual([])
  expect(off.spawnModel(SPAWN, BASE)).toBe(undefined)
})

test('stretch reminder fires on an ahead limit once per stretch without five-hour pressure', async () => {
  const core = limitCore()
  core.takeNotices()
  for (let i = 0; i < 11; i++) expect(core.toolCall('Read', false)).toBe(undefined)
  expect(core.toolCall('Read', false)?.includes('Fable weekly 62% used')).toBe(true)
  expect(core.toolCall('Read', false)).toBe(undefined)
  core.userPrompt()
  core.measure({}, BASE)
  for (let i = 0; i < 11; i++) core.toolCall('Read', false)
  expect(core.toolCall('Read', false)?.includes('Fable weekly 62% used')).toBe(true)
})

test('bucketLockout is separate from five-hour pressure and deduplicates bucket and reset', async () => {
  const core = limitCore(100)
  const usage = { readAt: BASE, buckets: [{ label: 'Fable', family: 'fable' as const, usedPercent: 100, resetsAt: LIMIT_RESET }] }
  core.setUsage(usage, undefined, BASE)
  expect(core.bucketLockout(BASE)).toEqual({ bucket: 'Fable', resetAt: '2026-11-23T22:00:00.000Z' })
  expect(core.bucketLockout(BASE)).toBe(undefined)
  core.setUsage({ ...usage, buckets: [{ ...usage.buckets[0]!, resetsAt: undefined }] }, undefined, BASE)
  expect(core.bucketLockout(BASE)).toEqual({ bucket: 'Fable', resetAt: 'unknown' })
  core.setMainModel('opus', BASE)
  expect(core.bucketLockout(BASE)).toBe(undefined)
  measure(core, 2, LIMIT_RESET, LIMIT_RESET + 300 * MINUTE)
  expect(core.status(LIMIT_RESET).endsWith('pressure 0')).toBe(true)
})

test('limit status and description show state, fallback routing and bounded probe problems', async () => {
  const core = limitCore()
  expect(core.status(BASE).includes('fable wk 62% ahead')).toBe(true)
  expect(core.describe(BASE).includes('subagents on fable: hand off or run on opus')).toBe(true)
  expect(core.describe(BASE).includes('usage reading age: 0 seconds')).toBe(true)
  core.setCodex(undefined)
  expect(core.describe(BASE).includes('subagents on fable: run on opus')).toBe(true)
  core.setUsage(undefined, 'broken\r\n检查', BASE)
  expect(core.spawnModel(SPAWN, BASE)).toBe(undefined)
  expect(core.takeNotices()).toEqual([])
  expect(core.usageAge(BASE)).toBe(Infinity)
  expect(core.describe(BASE).includes('usage reading age: never read (broken 检查)')).toBe(true)
})

test('bucket reset wins over seven-day reset and unknown families never steer', async () => {
  const core = limitCore(40)
  core.measure({ sevenDay: { percentUsed: 10, resetsAt: BASE + 7 * 1440 * MINUTE } }, BASE)
  expect(core.spawnModel(SPAWN, BASE)).toBe(undefined)
  core.setUsage({ readAt: BASE, buckets: [{ label: 'Fable', family: 'fable', usedPercent: 40 }] }, undefined, BASE)
  expect(core.spawnModel(SPAWN, BASE)?.model).toBe('opus')
  core.setUsage({ readAt: BASE, buckets: [{ label: 'Gizmo', usedPercent: 100 }] }, undefined, BASE)
  expect(core.route(B, BASE)).toBe(undefined)
  expect(core.spawnModel(SPAWN, BASE)).toBe(undefined)
})

test('stale limit notices and stretch reminders are not delivered later', async () => {
  const core = limitCore()
  expect(core.takeNotices(BASE + 21 * MINUTE)).toEqual([])
  for (let i = 0; i < 12; i++) expect(core.toolCall('Read', false, BASE + 21 * MINUTE)).toBe(undefined)
})

test('a dropped full notice can be queued again and is marked only on delivery', async () => {
  const core = limitCore(100)
  const now = BASE + 21 * MINUTE
  expect(core.takeNotices(now)).toEqual([])
  const fresh = { readAt: now, buckets: [{ label: 'Fable', family: 'fable' as const, usedPercent: 100, resetsAt: LIMIT_RESET }] }
  core.setUsage(fresh, undefined, now)
  core.setUsage(fresh, undefined, now)
  const notes = core.takeNotices(now)
  expect(notes.length).toBe(1)
  expect(notes[0]?.includes('Fable weekly limit is used up')).toBe(true)
  expect(core.takeNotices(now)).toEqual([])
  core.setUsage({ ...fresh, readAt: now + MINUTE }, undefined, now + MINUTE)
  expect(core.takeNotices(now + MINUTE)).toEqual([])
})

test('newConversation resets notices and stretch while retaining readings, pressure, stays and bucket dedupe', async () => {
  const core = createCore({ ...DEFAULTS, stretchCalls: 2 }, SCRIPT, 'first-session')
  measure(core, 95)
  core.setCodex(codex())
  core.setMainModel('fable', BASE)
  core.setUsage({ readAt: BASE, buckets: [{ label: 'Fable', family: 'fable', usedPercent: 100, resetsAt: LIMIT_RESET }] }, undefined, BASE)
  expect(core.takeNotices(BASE).length).toBe(3)
  expect(core.bucketLockout(BASE)?.bucket).toBe('Fable')
  core.setCodex(undefined)
  core.route(B, BASE)
  core.setCodex(codex())
  core.toolCall('Read', false, BASE)
  expect(core.toolCall('Read', false, BASE)?.includes("--session 'first-session'")).toBe(true)
  const status = core.status(BASE)
  core.newConversation('second-session')
  expect(core.status(BASE)).toBe(status)
  expect(core.usageAge(BASE)).toBe(0)
  expect(core.codexAge(BASE)).toBe(0)
  expect(core.describe(BASE).includes('eligible calls stayed on Claude in 10 minutes: 1')).toBe(true)
  expect(core.bucketLockout(BASE)).toBe(undefined)
  measure(core, 95)
  expect(core.takeNotices(BASE).length).toBe(3)
  expect(core.takeNotices(BASE)).toEqual([])
  expect(core.toolCall('Read', false, BASE)).toBe(undefined)
  expect(core.toolCall('Read', false, BASE)?.includes("--session 'second-session'")).toBe(true)
  expect(agentCall(core, B, CWD, BASE)?.deny.includes("--session 'second-session'")).toBe(true)
  // Undelivered old pressure/reserve notices must also be discarded.
  core.newConversation(undefined)
  measure(core, 95)
  core.newConversation(undefined)
  core.setMainModel('opus', BASE)
  expect(core.takeNotices(BASE)).toEqual([])
  expect(agentCall(core, B, CWD, BASE)?.deny.includes('--session')).toBe(false)
})

for (const [family, percent, opusPercent, fallback] of [
  ['fable', 100, 100, false], ['sonnet', 85, 0, false], ['fable', 62, 0, true],
] as const) {
  test(`limit notice recommends only a usable fallback: ${family} ${percent}, opus ${opusPercent}`, async () => {
    const core = createCore(DEFAULTS, SCRIPT)
    core.setMainModel(`claude-${family}-5-5`, BASE)
    core.setUsage({ readAt: BASE, buckets: [
      { label: family === 'fable' ? 'Fable' : 'Sonnet only', family, usedPercent: percent, resetsAt: LIMIT_RESET },
      { label: 'Opus', family: 'opus', usedPercent: opusPercent, resetsAt: LIMIT_RESET },
    ] }, undefined, BASE)
    const notes = core.takeNotices(BASE)
    expect(notes.length).toBe(1)
    const note = notes[0]!
    expect(note.includes('/model')).toBe(fallback)
    expect(note.includes('run on opus')).toBe(fallback)
    if (fallback) {
      expect(note.includes('/model opus')).toBe(true)
      expect(note.includes('/advisor fable')).toBe(true)
    } else if (percent < 100) {
      expect(note.endsWith(' Subagents that stay on Claude keep their model.')).toBe(true)
    }
  })
}

function decisionCore(session = 'session-1') {
  const core = createCore(DEFAULTS, SCRIPT, session)
  core.setCodex(codex())
  measure(core, 5)
  core.setMainModel('claude-opus-5-5', BASE)
  return core
}

const RECORD_BASE = {
  session: 'session-1', mode: 'auto', agent_type: null, model: null, main_model: 'claude-opus-5-5', from_subagent: false,
  description: null, cause: null, burst: 0, pressure: 0, five_hour: 5, forecast: null, seven_day: null,
  codex_headroom: 1, codex_weekly: 18, codex_age_s: 0, limit: null, brief_file: null,
}

test('a hand-off decision is recorded with its tier, policy reason and readings', async () => {
  const core = decisionCore()
  expect(core.route({ ...A, description: 'Implement parser' }, BASE)?.tier).toBe('A')
  expect(core.lastRecord()).toEqual({
    ...RECORD_BASE, description: 'Implement parser', brief_chars: A.prompt.length, eligible: true,
    tier: 'A', tier_reason: 'has a check command and is implementation-type work', handed_off: true, reason: 'tier A has enough Codex headroom',
  })
})

test('stays, bursts, tier C and ineligible calls each get their own record', async () => {
  const core = decisionCore()
  const records = []
  for (let i = 0; i < 3; i++) {
    core.route(B, BASE + i * 1000)
    records.push(core.lastRecord())
  }
  expect(records.map(record => [record?.handed_off, record?.burst, record?.reason])).toEqual([
    [false, 0, 'pressure is low'], [false, 1, 'pressure is low'], [true, 2, 'pressure is high enough'],
  ])
  expect(records[0]).toEqual({ ...RECORD_BASE, brief_chars: B.prompt.length, eligible: true, tier: 'B', tier_reason: 'no check command', handed_off: false, reason: 'pressure is low' })
  core.route(C, BASE + 3000)
  expect(core.lastRecord()).toEqual({ ...RECORD_BASE, burst: 2, codex_age_s: 3, brief_chars: C.prompt.length, eligible: true, tier: 'C', tier_reason: 'design or front-end judgment', handed_off: false, reason: 'tier C stays on Claude' })
  core.route({ ...A, subagent_type: 'Explore', model: 'sonnet' }, BASE + 3000)
  expect(core.lastRecord()).toEqual({ ...RECORD_BASE, burst: 2, codex_age_s: 3, agent_type: 'Explore', model: 'sonnet', brief_chars: A.prompt.length, eligible: false, tier: null, tier_reason: null, handed_off: false, reason: 'type Explore keeps its own setup' })
  core.route({ ...A, agentId: 'child' }, BASE + 3000)
  expect(core.lastRecord()?.from_subagent).toBe(true)
  expect(core.lastRecord()?.reason).toBe('call belongs to a subagent')
  // A record already read is not changed by later decisions.
  expect(records[0]?.burst).toBe(0)
})

test('off mode records no decision and missing readings are null, not zero', async () => {
  const core = decisionCore()
  core.setMode('off')
  core.route(A, BASE)
  expect(core.lastRecord()).toBe(undefined)
  const fresh = createCore(DEFAULTS, SCRIPT)
  fresh.route(A, BASE)
  expect(fresh.lastRecord()).toEqual({
    ...RECORD_BASE, session: null, main_model: null, five_hour: null, codex_headroom: 0, codex_weekly: null, codex_age_s: null,
    brief_chars: A.prompt.length, eligible: true, tier: 'A', tier_reason: 'has a check command and is implementation-type work',
    handed_off: false, reason: 'no Claude reading yet',
  })
  heavy(fresh)
  fresh.route(A, BASE + 20 * MINUTE)
  const record = fresh.lastRecord()
  expect(Number.isFinite(record?.forecast)).toBe(true)
})

test('a recorded description keeps whole characters and stops at 100', async () => {
  const core = decisionCore()
  core.route({ ...A, description: 'x'.repeat(99) + '😀 tail' }, BASE)
  expect(core.lastRecord()?.description).toBe('x'.repeat(99) + '😀')
  core.route({ ...A, description: '检查 naïve\r\n' }, BASE)
  expect(core.lastRecord()?.description).toBe('检查 naïve\r\n')
})

test('a model-limit hand-off records the limit and its cause', async () => {
  const core = limitCore()
  core.route(B, BASE)
  const record = core.lastRecord()
  expect(record?.limit).toEqual({ label: 'Fable', percent: 62, state: 'ahead' })
  expect(record?.cause).toBe('limit')
  expect(record?.handed_off).toBe(true)
  core.route({ ...B, model: 'opus' }, BASE)
  expect(core.lastRecord()?.limit).toBe(null)
})

test('a record keeps the exact headroom the decision used', async () => {
  const core = decisionCore()
  // Weekly use that leaves headroom just under the tier A threshold of 0.5.
  core.setCodex({ windows: [{ minutes: 10080, usedPercent: 76.4305, resetsAt: BASE + 5 * 1440 * MINUTE }], limitReached: false, readAt: BASE })
  expect(core.route(A, BASE)).toBe(undefined)
  const record = core.lastRecord()
  expect(record?.reason).toBe('Codex headroom is low')
  expect((record?.codex_headroom ?? 1) < 0.5).toBe(true)
})

test('a decision made out of order keeps the stays of later decisions', async () => {
  const core = decisionCore()
  core.route(B, BASE + 2000)
  // A call that started earlier and waited on its probes is decided now, at its own earlier time.
  core.route(B, BASE + 1000)
  expect(core.describe(BASE + 1000).includes('eligible calls stayed on Claude in 10 minutes: 2')).toBe(true)
  expect(core.route(B, BASE + 3000)?.tier).toBe('B')
  expect(core.lastRecord()?.burst).toBe(2)
  // A clock that went back by more than a minute still drops what it can no longer place.
  expect(core.describe(BASE - 2 * MINUTE).includes('eligible calls stayed on Claude in 10 minutes: 0')).toBe(true)
})

test('a refusal built from the decision record states the readings of that decision', async () => {
  const core = decisionCore()
  const route = core.route(A, BASE)
  const record = core.lastRecord()
  measure(core, 65, BASE + 1000)
  core.setCodex({ ...codex(BASE + 1000), windows: [{ minutes: 10080, usedPercent: 40, resetsAt: BASE + 5 * 1440 * MINUTE }] })
  const deny = core.denial(route!, A, CWD, BASE + 1000, undefined, record)
  expect(deny.includes('Claude 5h 5%; Codex weekly 18%.')).toBe(true)
  expect(core.denial(route!, A, CWD, BASE + 1000).includes('Claude 5h 65%')).toBe(true)
})

test('a refusal built from the decision record states the forecast of that decision', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  heavy(core)
  const decided = BASE + 20 * MINUTE
  const route = core.route(A, decided)
  const record = core.lastRecord()
  const F = record?.forecast ?? NaN
  expect(Number.isFinite(F)).toBe(true)
  // A much faster rise afterwards changes the live forecast.
  measure(core, 90, decided + MINUTE)
  const deny = core.denial(route!, A, CWD, decided + MINUTE, undefined, record)
  expect(deny.includes(`Claude 5h 20%, on pace for ${Math.round(F)}%`)).toBe(true)
  expect(core.denial(route!, A, CWD, decided + MINUTE).includes(`on pace for ${Math.round(F)}%`)).toBe(false)
})



test('a weekly-limit reading taken before the one held is ignored, unless the held one is dated ahead of the clock', async () => {
  const core = limitCore(62)
  core.setUsage({ readAt: BASE - MINUTE, buckets: [{ label: 'Fable', family: 'fable', usedPercent: 40, resetsAt: BASE + 4.5 * 1440 * MINUTE }] }, undefined, BASE)
  expect(core.status(BASE).includes('fable wk 62% ahead')).toBe(true)
  const back = limitCore(62)
  back.setUsage({ readAt: BASE + 60 * MINUTE, buckets: [{ label: 'Fable', family: 'fable', usedPercent: 62, resetsAt: BASE + 4.5 * 1440 * MINUTE }] }, undefined, BASE + 60 * MINUTE)
  // The clock went back an hour: a reading taken now is older than the held one but must be used.
  back.setUsage({ readAt: BASE, buckets: [{ label: 'Fable', family: 'fable', usedPercent: 30, resetsAt: BASE + 4.5 * 1440 * MINUTE }] }, undefined, BASE)
  expect(back.status(BASE).includes('fable wk 30%')).toBe(true)
})
