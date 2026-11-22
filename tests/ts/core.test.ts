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
  expect(notices[0]?.text.includes('pressure 0.3')).toBe(true)
})

test('reserve notices are once per window and reset jitter does not repeat them', async () => {
  const core = createCore(DEFAULTS, SCRIPT)
  core.setCodex(codex())
  measure(core, 89)
  expect(core.userPrompt().length).toBe(1)
  measure(core, 90, BASE + MINUTE)
  const notices = core.userPrompt()
  expect(notices.length).toBe(1)
  expect(notices[0]?.text.includes('reserve')).toBe(true)
  measure(core, 97, BASE + 2 * MINUTE, RESET + MINUTE)
  expect(core.userPrompt()).toEqual([])
  measure(core, 95, RESET, RESET + 300 * MINUTE)
  expect(core.userPrompt().length).toBe(1)
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
  expect(core.toolCall('Bash', false)?.text.includes('12 main-loop tool calls')).toBe(true)
  expect(core.toolCall('Bash', false)).toBe(undefined)
  core.userPrompt()
  for (let i = 1; i < 12; i++) expect(core.toolCall('Bash', false)).toBe(undefined)
  expect(core.toolCall('Bash', false)?.text.includes('12 main-loop tool calls')).toBe(true)
})

test('all seven counted tools contribute and low pressure gives no reminder', async () => {
  const core = createCore({ ...DEFAULTS, stretchCalls: 7 }, SCRIPT)
  heavy(core)
  for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob']) {
    expect(core.toolCall(tool, false)).toBe(undefined)
  }
  expect(core.toolCall('NotebookEdit', false)?.text.includes('7 main-loop tool calls')).toBe(true)
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
  expect(notices.length).toBe(1)
  expect(notices.every(notice => notice.text.includes('97%'))).toBe(true)
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
  expect(core.takeNotices()[0]?.text.includes('limit is used up')).toBe(true)
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
  expect(core.toolCall('Read', false)?.text.includes('Fable weekly 62% used')).toBe(true)
  expect(core.toolCall('Read', false)).toBe(undefined)
  core.userPrompt()
  core.measure({}, BASE)
  for (let i = 0; i < 11; i++) core.toolCall('Read', false)
  expect(core.toolCall('Read', false)?.text.includes('Fable weekly 62% used')).toBe(true)
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
  core.setCodex(codex(now))
  core.setUsage(fresh, undefined, now)
  core.setUsage(fresh, undefined, now)
  const notes = core.takeNotices(now)
  expect(notes.length).toBe(1)
  expect(notes[0]?.text.includes('Fable weekly limit is used up')).toBe(true)
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
  expect(core.takeNotices(BASE).map(note => note.text.includes('reserve'))).toEqual([true])
  measure(core, 85)
  expect(core.takeNotices(BASE).length).toBe(2)
  expect(core.bucketLockout(BASE)?.bucket).toBe('Fable')
  core.setCodex(undefined)
  core.route(B, BASE)
  core.setCodex(codex())
  core.toolCall('Read', false, BASE)
  expect(core.toolCall('Read', false, BASE)?.text.includes("--session 'first-session'")).toBe(true)
  const status = core.status(BASE)
  core.newConversation('second-session')
  expect(core.status(BASE)).toBe(status)
  expect(core.usageAge(BASE)).toBe(0)
  expect(core.codexAge(BASE)).toBe(0)
  expect(core.describe(BASE).includes('eligible calls stayed on Claude in 10 minutes: 1')).toBe(true)
  expect(core.bucketLockout(BASE)).toBe(undefined)
  measure(core, 95)
  expect(core.takeNotices(BASE).map(note => note.text.includes('reserve'))).toEqual([true])
  measure(core, 85)
  expect(core.takeNotices(BASE).length).toBe(2)
  expect(core.takeNotices(BASE)).toEqual([])
  expect(core.toolCall('Read', false, BASE)).toBe(undefined)
  expect(core.toolCall('Read', false, BASE)?.text.includes("--session 'second-session'")).toBe(true)
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
    core.setCodex(codex())
    core.setMainModel(`claude-${family}-5-5`, BASE)
    core.setUsage({ readAt: BASE, buckets: [
      { label: family === 'fable' ? 'Fable' : 'Sonnet only', family, usedPercent: percent, resetsAt: LIMIT_RESET },
      { label: 'Opus', family: 'opus', usedPercent: opusPercent, resetsAt: LIMIT_RESET },
    ] }, undefined, BASE)
    const notes = core.takeNotices(BASE)
    expect(notes.length).toBe(1)
    const note = notes[0]!.text
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
  account_week: null, codex_surplus: 6.3, codex_headroom: 1, codex_weekly: 18, codex_age_s: 0, limit: null, brief_file: null,
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
    ...RECORD_BASE, codex_surplus: null, session: null, main_model: null, five_hour: null, codex_headroom: 0, codex_weekly: null, codex_age_s: null,
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

const BALANCE_TIME = Date.parse('2026-11-21T12:35:00Z')
const accountWeek = { percentUsed: 79, resetsAt: Date.parse('2026-11-23T22:00:00Z') }
const codexWeek = { minutes: 10080, usedPercent: 40, resetsAt: Date.parse('2026-11-22T01:27:00Z') }

function balanceCore() {
  const core = createCore({ ...DEFAULTS, stretchCalls: 2 }, SCRIPT, 'one')
  core.setMainModel('opus', BALANCE_TIME)
  core.measure({ fiveHour: { percentUsed: 10 }, sevenDay: accountWeek }, BALANCE_TIME)
  core.setCodex({ readAt: BALANCE_TIME, windows: [codexWeek], limitReached: false }, undefined, BALANCE_TIME)
  return core
}

test('an Opus call snapshots both weeks, their reasons and the combined notice', async () => {
  const core = balanceCore()
  const route = core.route(B, BALANCE_TIME)
  const record = core.lastRecord()!
  expect(route?.cause).toBe('account-week')
  expect(record.cause).toBe('account-week')
  expect(record.account_week?.state).toBe('ahead')
  expect(record.account_week?.percent).toBe(79)
  expect(Math.round(record.account_week?.line ?? 0)).toBe(66)
  expect(record.codex_surplus).toBe(38.5)
  expect(core.status(BALANCE_TIME).includes('7d 79% ahead · codex wk 40% +38')).toBe(true)
  const description = core.describe(BALANCE_TIME)
  for (const line of ['tier B calls: handed to Codex', 'Claude all-models weekly: 79% used, even pace 66%, ahead',
    'Codex weekly surplus: 38.5 points (active)', 'hand-offs: on (account-week, codex-surplus)']) {
    expect(description.split('\n').includes(line)).toBe(true)
  }
  expect(core.takeNotices(BALANCE_TIME)).toEqual([{
    text: 'crossfeed: hand-offs are on. Claude all-models weekly 79% used, an even pace would be 66% (resets 2026-11-23 22:00 UTC); Codex weekly 40% used, 38 points under an even pace to its 85% stop (resets 2026-11-22 01:27 UTC). Before you start execution with a result you can check, hand it to Codex; keep talking with the user, decisions and review here.',
    nudge: { session: 'one', kind: 'balance-on', reasons: ['account-week', 'codex-surplus'], calls: null },
  }])
  expect(core.takeNotices(BALANCE_TIME)).toEqual([])
  measure(core, 5, BALANCE_TIME)
  const denial = core.denial(route!, B, CWD, BALANCE_TIME, '/brief', record)
  expect(denial.split('\n')[1]).toBe('Why: tier B; Claude all-models weekly 79% used, ahead of an even pace (66%).')
  expect(denial.includes('--cause account-week')).toBe(true)
  const surplusRoute = core.route(B, BALANCE_TIME)!
  const surplusRecord = core.lastRecord()!
  expect(surplusRoute.cause).toBe('codex-surplus')
  expect(surplusRecord.account_week).toBe(null)
  core.setCodex(undefined)
  const surplusDenial = core.denial(surplusRoute, B, CWD, BALANCE_TIME, '/brief', surplusRecord)
  expect(surplusDenial.split('\n')[1]).toBe('Why: tier B; Codex weekly 40% used, 38 points under an even pace to its 85% stop.')
  expect(surplusDenial.includes('--cause codex-surplus')).toBe(true)
})

test('only an auto tier B hand-off changed by a floor records its first applicable cause', async () => {
  const core = balanceCore()
  const fable = { ...B, model: 'fable' }
  core.setUsage({ buckets: [{ label: 'Fable', family: 'fable', usedPercent: 90 }], readAt: BALANCE_TIME }, undefined, BALANCE_TIME)
  expect(core.route(fable, BALANCE_TIME)?.cause).toBe('limit')
  expect(core.route(A, BALANCE_TIME)?.tier).toBe('A')
  expect(core.lastRecord()?.cause).toBe(null)
  core.setMode('always')
  expect(core.route(fable, BALANCE_TIME)?.tier).toBe('B')
  expect(core.lastRecord()?.cause).toBe(null)
  core.setMode('auto')
  core.measure({ sevenDay: accountWeek }, BALANCE_TIME)
  for (let i = 0; i < 2; i++) {
    expect(core.route(B, BALANCE_TIME)).toBe(undefined)
    expect(core.lastRecord()?.reason).toBe('no Claude reading yet')
  }
  // Burst pressure cannot open the missing five-hour gate, but the family limit can.
  expect(core.route(fable, BALANCE_TIME)?.cause).toBe('limit')
  core.measure({ fiveHour: { percentUsed: 5 }, sevenDay: accountWeek }, BALANCE_TIME)
  expect(core.route(fable, BALANCE_TIME)?.tier).toBe('B')
  expect(core.lastRecord()?.cause).toBe(null)
  expect(core.lastRecord()?.burst).toBe(2)
})

test('the full account week routes even with low positive headroom while main-loop steering stays off', async () => {
  const core = balanceCore()
  core.measure({ fiveHour: { percentUsed: 5 }, sevenDay: { ...accountWeek, percentUsed: 100 } }, BALANCE_TIME)
  core.setCodex({ readAt: BALANCE_TIME, windows: [{ minutes: 10080, usedPercent: 84 }], limitReached: false })
  const route = core.route(B, BALANCE_TIME)!
  expect(route.cause).toBe('account-week')
  expect(core.denial(route, B, CWD, BALANCE_TIME, '/brief', core.lastRecord()).split('\n')[1]).toBe('Why: tier B; Claude all-models weekly 100% used, limit used up.')
  expect(core.describe(BALANCE_TIME).includes('hand-offs: off')).toBe(true)
  expect(core.takeNotices(BALANCE_TIME)).toEqual([])
})

test('Codex surplus uses the exact 15-point and half-headroom boundaries before rounding', async () => {
  for (const [used, otherUsed, active] of [[27.5, 75, true], [27.501, 75, false], [27.5, 75.001, false]] as const) {
    const core = decisionCore()
    core.setCodex({ readAt: BASE, limitReached: false, windows: [
      { minutes: 10080, usedPercent: used, resetsAt: BASE + 3.5 * 1440 * MINUTE },
      { minutes: 400, usedPercent: otherUsed },
    ] })
    expect(core.route(B, BASE)?.cause).toBe(active ? 'codex-surplus' : undefined)
    expect(core.takeNotices(BASE).length).toBe(active ? 1 : 0)
    expect(core.describe(BASE).includes('hand-offs: on (codex-surplus)')).toBe(active)
  }
})

test('balance stays on through unknown readings and other reasons, then announces off and on once', async () => {
  const core = balanceCore()
  const kinds = (now: number) => core.takeNotices(now).flatMap(item => item.nudge ? [item.nudge.kind] : [])
  const later = BALANCE_TIME + 20 * MINUTE
  expect(kinds(BALANCE_TIME)).toEqual(['balance-on'])
  expect(kinds(later)).toEqual([])
  core.measure({}, later)
  core.setCodex({ readAt: later, windows: [{ ...codexWeek, usedPercent: 70 }], limitReached: false })
  expect(kinds(later)).toEqual([])
  core.setCodex({ readAt: later, windows: [codexWeek], limitReached: false })
  expect(kinds(later)).toEqual([])
  core.measure({ fiveHour: { percentUsed: 85, resetsAt: later + 300 * MINUTE }, sevenDay: { ...accountWeek, percentUsed: 40 } }, later)
  core.setCodex({ readAt: later, windows: [{ ...codexWeek, usedPercent: 70 }], limitReached: false })
  expect(kinds(later)).toEqual([])
  core.setUsage({ readAt: later, buckets: [{ family: 'opus', label: 'Opus', usedPercent: 90 }] }, undefined, later)
  core.measure({ fiveHour: { percentUsed: 5 }, sevenDay: { ...accountWeek, percentUsed: 40 } }, later)
  expect(kinds(later)).toEqual([])
  core.setUsage({ readAt: later, buckets: [] }, undefined, later)
  const off = core.userPrompt(later)
  expect(off.length).toBe(1)
  expect(off[0]?.text).toBe('crossfeed: hand-offs are off (the Claude week is on pace and the Codex surplus is under 10 points). Do execution yourself; hand work to Codex only when a subagent call is refused.')
  expect(off[0]?.nudge).toEqual({ session: 'one', kind: 'balance-off', calls: null, reasons: [] })
  expect(kinds(later)).toEqual([])
  core.measure({ sevenDay: accountWeek }, later)
  core.setCodex({ readAt: later, windows: [{ minutes: 300, usedPercent: 10 }], limitReached: false })
  expect(kinds(later)).toEqual(['balance-on'])
  core.setMode('off')
  expect(kinds(later)).toEqual([])
  core.setMode('always')
  expect(core.takeNotices(later)[0]?.nudge?.reasons).toEqual(['account-week', 'always'])
})

test('reserve wins at delivery over every hand-off notice, while subagent routing still works', async () => {
  const core = balanceCore()
  core.setUsage({ readAt: BALANCE_TIME, buckets: [{ family: 'opus', label: 'Opus', usedPercent: 90 }] }, undefined, BALANCE_TIME)
  core.measure({ fiveHour: { percentUsed: 85 }, sevenDay: accountWeek }, BALANCE_TIME)
  core.toolCall('Bash', false, BALANCE_TIME)
  core.measure({ fiveHour: { percentUsed: 90 }, sevenDay: accountWeek }, BALANCE_TIME)
  expect(core.toolCall('Read', false, BALANCE_TIME)).toBe(undefined)
  expect(core.takeNotices(BALANCE_TIME)).toEqual([{ text: 'crossfeed: Claude 5h 90%; reserve. Please finish the current step, keep a hand-off note and start no new autonomous work.' }])
  expect(core.route(B, BALANCE_TIME)?.tier).toBe('B')
})

test('an Opus account-week stretch fires once at the counted call, resets per prompt and needs Codex headroom', async () => {
  const core = balanceCore()
  core.setCodex({ readAt: BALANCE_TIME, windows: [{ minutes: 300, usedPercent: 10 }], limitReached: false })
  for (let i = 0; i < 2; i++) {
    core.userPrompt(BALANCE_TIME)
    expect(core.toolCall('Read', false, BALANCE_TIME)).toBe(undefined)
    const note = core.toolCall('Read', false, BALANCE_TIME)
    expect(note?.text.includes('run --kind task')).toBe(true)
    expect(note?.text.includes('--codex-stop')).toBe(false)
    expect(note?.text.includes('account-week')).toBe(true)
    expect(note?.nudge).toEqual({ session: 'one', kind: 'stretch', reasons: ['account-week'], calls: 2 })
    expect(core.toolCall('Read', false, BALANCE_TIME)).toBe(undefined)
  }
  core.userPrompt(BALANCE_TIME)
  core.setCodex(undefined)
  core.toolCall('Read', false, BALANCE_TIME)
  expect(core.toolCall('Bash', false, BALANCE_TIME)).toBe(undefined)
  core.setCodex({ readAt: BALANCE_TIME, windows: [codexWeek], limitReached: false })
  expect(core.toolCall('Bash', false, BALANCE_TIME)?.nudge?.calls).toBe(3)
})

test('the stretch reminder waits past call 12 for a reason and fires once at call 15', async () => {
  const core = decisionCore()
  for (let count = 1; count <= 14; count++) expect(core.toolCall('Read', false, BASE)).toBe(undefined)
  core.measure({ fiveHour: { percentUsed: 5 }, sevenDay: { percentUsed: 55, resetsAt: BASE + 3.5 * 1440 * MINUTE } }, BASE)
  expect(core.toolCall('Read', false, BASE)?.nudge).toEqual({ session: 'session-1', kind: 'stretch', reasons: ['account-week'], calls: 15 })
  expect(core.toolCall('Read', false, BASE)).toBe(undefined)
})

test('the last on notice survives unknown Codex headroom but turns off once fresh headroom falls below half', async () => {
  const core = balanceCore()
  expect(core.takeNotices(BALANCE_TIME)[0]?.nudge?.kind).toBe('balance-on')
  const later = BALANCE_TIME + 16 * MINUTE
  const lowQuota = { readAt: later, windows: [{ ...codexWeek, usedPercent: 82 }], limitReached: false }
  core.setCodex({ ...lowQuota, readAt: BALANCE_TIME })
  expect(core.takeNotices(later)).toEqual([])
  core.setCodex({ ...lowQuota, windows: [] })
  expect(core.takeNotices(later)).toEqual([])
  core.setCodex({ ...lowQuota, windows: [{ ...lowQuota.windows[0]!, resetsAt: later }] })
  expect(core.takeNotices(later)).toEqual([])
  core.setCodex(lowQuota)
  expect(core.takeNotices(later)).toEqual([{
    text: 'crossfeed: hand-offs are off (Codex is close to its stop). Do execution yourself; hand work to Codex only when a subagent call is refused.',
    nudge: { session: 'one', kind: 'balance-off', reasons: [], calls: null },
  }])
  expect(core.takeNotices(later)).toEqual([])
})

test('reserve suppresses balance-off even with fresh low headroom', async () => {
  const core = balanceCore()
  expect(core.takeNotices(BALANCE_TIME)[0]?.nudge?.kind).toBe('balance-on')
  measure(core, 90, BALANCE_TIME)
  core.setCodex({ readAt: BALANCE_TIME, windows: [{ ...codexWeek, usedPercent: 82 }], limitReached: false })
  const notes = core.takeNotices(BALANCE_TIME)
  expect(notes.length).toBe(1)
  expect(notes[0]?.text.includes('reserve')).toBe(true)
  expect(notes[0]?.nudge).toBe(undefined)
  measure(core, 89, BALANCE_TIME)
  expect(core.takeNotices(BALANCE_TIME)[0]?.nudge?.kind).toBe('balance-off')
})

test('surplus hysteresis holds a delivered on at 14 and 10 points and turns off at 9', async () => {
  const core = decisionCore()
  core.measure({ fiveHour: { percentUsed: 5 }, sevenDay: { percentUsed: 40, resetsAt: BASE + 3.5 * 1440 * MINUTE } }, BASE)
  const setSurplus = (points: number) => core.setCodex({
    readAt: BASE, limitReached: false, windows: [{ minutes: 10080, usedPercent: 42.5 - points, resetsAt: BASE + 3.5 * 1440 * MINUTE }],
  })
  setSurplus(16)
  expect(core.takeNotices(BASE)[0]?.nudge?.reasons).toEqual(['codex-surplus'])
  setSurplus(14)
  expect(core.takeNotices(BASE)).toEqual([])
  expect(core.route(B, BASE)).toBe(undefined)
  setSurplus(10)
  expect(core.takeNotices(BASE)).toEqual([])
  setSurplus(9)
  expect(core.takeNotices(BASE)[0]?.nudge?.kind).toBe('balance-off')
  setSurplus(14)
  expect(core.takeNotices(BASE)).toEqual([])
})

test('account-week hysteresis holds a delivered on at line plus 3 and 2 and turns off at plus 1', async () => {
  const core = decisionCore()
  const setWeek = (points: number) => core.measure({
    fiveHour: { percentUsed: 5 }, sevenDay: { percentUsed: 50 + points, resetsAt: BASE + 3.5 * 1440 * MINUTE },
  }, BASE)
  setWeek(5)
  expect(core.takeNotices(BASE)[0]?.nudge?.reasons).toEqual(['account-week'])
  setWeek(3)
  expect(core.takeNotices(BASE)).toEqual([])
  expect(core.route(B, BASE)).toBe(undefined)
  setWeek(2)
  expect(core.takeNotices(BASE)).toEqual([])
  setWeek(1)
  expect(core.takeNotices(BASE)[0]?.nudge?.kind).toBe('balance-off')
  setWeek(3)
  expect(core.takeNotices(BASE)).toEqual([])
})

test('an older Codex answer is ignored unless the held reading exceeds five minutes of clock skew', async () => {
  const core = balanceCore()
  const quota = { readAt: BALANCE_TIME - MINUTE, limitReached: false, windows: [{ ...codexWeek, usedPercent: 60 }] }
  core.setCodex(quota, undefined, BALANCE_TIME)
  expect(core.status(BALANCE_TIME).includes('codex wk 40%')).toBe(true)
  core.setCodex(quota, undefined, BALANCE_TIME - 5 * MINUTE)
  expect(core.status(BALANCE_TIME).includes('codex wk 40%')).toBe(true)
  core.setCodex(quota, undefined, BALANCE_TIME - 5 * MINUTE - 1)
  expect(core.status(BALANCE_TIME).includes('codex wk 60%')).toBe(true)
})

test('low headroom blocks pressure, family, balance and stretch advice until the main-loop gate opens', async () => {
  const core = balanceCore()
  core.setMode('always')
  core.setUsage({ readAt: BALANCE_TIME, buckets: [{ family: 'opus', label: 'Opus', usedPercent: 90 }] }, undefined, BALANCE_TIME)
  core.measure({ fiveHour: { percentUsed: 89 }, sevenDay: accountWeek }, BALANCE_TIME)
  const quota = { readAt: BALANCE_TIME, windows: [codexWeek, { minutes: 400, usedPercent: 75.01 }], limitReached: false }
  core.setCodex(quota)
  expect(core.takeNotices(BALANCE_TIME)).toEqual([])
  core.toolCall('Read', false)
  expect(core.toolCall('Bash', false)).toBe(undefined)
  expect(core.describe(BALANCE_TIME).includes('38.5 points (headroom below 0.5)')).toBe(true)
  core.setCodex({ ...quota, windows: [codexWeek, { minutes: 400, usedPercent: 75 }] })
  const notices = core.userPrompt(BALANCE_TIME)
  expect(notices.map(item => item.nudge?.kind)).toEqual([undefined, undefined, 'balance-on'])
  expect(notices[0]?.text.includes('pressure')).toBe(true)
  expect(notices[1]?.text.includes('Opus weekly')).toBe(true)
  core.toolCall('Read', false)
  expect(core.toolCall('Bash', false)?.nudge?.reasons).toEqual(['pressure', 'limit', 'account-week', 'codex-surplus', 'always'])
})
