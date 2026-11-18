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
