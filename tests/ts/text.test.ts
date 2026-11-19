import { expect, test } from 'claude-code/testing'
import { toConfig } from '../../hooks/config'
import * as textBuilders from '../../hooks/text'
import { denyText, dispatchCommand, pressureNotice, reserveNotice, shellQuote, staticSection, statusLine, stretchReminder } from '../../hooks/text'

const dispatch = { script: '/x/crossfeed.py', tier: 'A' as const, dir: '/tmp/a b/它', write: true, worktree: true }
const command = "python3 -I '/x/crossfeed.py' run --tier A --kind subagent --dir '/tmp/a b/它' --write --worktree <<'CROSSFEED_BRIEF_EOF'"

test('shellQuote preserves empty strings, apostrophes and shell metacharacters', async () => {
  expect(shellQuote("it's")).toBe("'it'\\''s'")
  expect(shellQuote('')).toBe("''")
  expect(shellQuote('$(touch pwned); `whoami`\r\n检查')).toBe("'$(touch pwned); `whoami`\r\n检查'")
})

test('dispatchCommand builds the documented command and omits absent and default options', async () => {
  expect(dispatchCommand(dispatch)).toBe(command)
  expect(dispatchCommand({ ...dispatch, tier: 'B', write: false, worktree: false, effort: 'high', model: '', timeoutMinutes: 30 })).toBe(
    "python3 -I '/x/crossfeed.py' run --tier B --kind subagent --dir '/tmp/a b/它' <<'CROSSFEED_BRIEF_EOF'",
  )
})

test('dispatchCommand quotes every variable string argument and includes overrides', async () => {
  expect(dispatchCommand({ ...dispatch, script: "/x/it's/crossfeed.py", session: 's;$(echo x)', effort: 'xhigh', model: 'a model', timeoutMinutes: 5 })).toBe(
    "python3 -I '/x/it'\\''s/crossfeed.py' run --tier A --kind subagent --dir '/tmp/a b/它' --write --worktree --session 's;$(echo x)' --effort 'xhigh' --model 'a model' --timeout 5 <<'CROSSFEED_BRIEF_EOF'",
  )
  expect(dispatchCommand({ ...dispatch, session: '' }).includes("--session ''")).toBe(true)
})

test('denyText reproduces all seven fixed lines with rounded readings', async () => {
  expect(denyText({ saved: false, tier: 'A', reason: 'has a check command', u: 61.6, F: 103.6, codexPercent: 17.2, command })).toBe([
    'crossfeed: run this on Codex instead of a Claude subagent.',
    'Why: tier A (has a check command). Claude 5h 62%, on pace for 104%; Codex weekly 17%.',
    'Start it as a background Bash command with the brief you just wrote, unchanged, as stdin:',
    command,
    '<the brief>',
    'CROSSFEED_BRIEF_EOF',
    'Add --write if the task must change files, drop it if not. Wait for the exit notification and do not poll. Check the result before you report it.',
  ].join('\n'))
})

test('denyText independently omits missing optional readings but retains zero', async () => {
  const input = { saved: false, tier: 'B' as const, reason: 'no check command', u: 0, command }
  expect(denyText(input)).toBe([
    'crossfeed: run this on Codex instead of a Claude subagent.',
    'Why: tier B (no check command). Claude 5h 0%.',
    'Start it as a background Bash command with the brief you just wrote, unchanged, as stdin:',
    command,
    '<the brief>',
    'CROSSFEED_BRIEF_EOF',
    'Add --write if the task must change files, drop it if not. Wait for the exit notification and do not poll. Check the result before you report it.',
  ].join('\n'))
  expect(denyText({ ...input, F: 0 }).split('\n')[1]).toBe('Why: tier B (no check command). Claude 5h 0%, on pace for 0%.')
  expect(denyText({ ...input, codexPercent: 0 }).split('\n')[1]).toBe('Why: tier B (no check command). Claude 5h 0%; Codex weekly 0%.')
})

test('staticSection reproduces the fixed copy exactly', async () => {
  const text = staticSection('/x/crossfeed.py')
  expect(text).toBe([
    '# crossfeed: handing work to Codex',
    'This session can hand self-contained work to the Codex CLI, which runs on a separate subscription. crossfeed watches both quotas and tells you when to use it.',
    '- When a subagent call is refused with a message that starts with "crossfeed:", run the command in that message. Do not retry the subagent.',
    '- Start the command as a background Bash command. You are notified when it exits. Never poll, sleep, or read its output early.',
    '- Hand off only work the brief describes in full: goal, paths, constraints, the check command, the format of the answer. Codex sees none of this conversation.',
    '- Keep design, architecture and UX decisions, talking with the user, and edits under about 20 lines for yourself.',
    "- When crossfeed says a model's weekly limit is ahead of pace, keep planning, decisions and review yourself and hand execution to Codex.",
    '- While a write job runs, do not edit files in its directory.',
    "- A Codex result is a claim. Read the change list, run the check as `python3 -I '/x/crossfeed.py' check <job> -- <command>`, then report.",
    '- Exit code 75 means Codex is out of quota: do the work yourself.',
    '- Exit code 127 means the codex CLI was not found: do the work yourself and tell the user.',
  ].join('\n'))
  expect(text.split('\n').length <= 12).toBe(true)
  expect(text.split('/x/crossfeed.py').length - 1 <= 2).toBe(true)
})

test('statusLine matches the full, waiting, off and reserve examples', async () => {
  const input = { mode: 'auto' as const, u: 62, F: 104, w: 41, codexPercent: 17, P: 0.4, reserve: false }
  const full = 'crossfeed auto · claude 5h 62% (pace 104%) · 7d 41% · codex wk 17% · pressure 0.4'
  expect(statusLine(input)).toBe(full)
  expect(statusLine({ mode: 'auto', P: 0, reserve: false })).toBe('crossfeed auto · codex unavailable · waiting for a reading')
  expect(statusLine({ ...input, mode: 'off', reserve: true })).toBe('crossfeed off')
  expect(statusLine({ ...input, reserve: true })).toBe(full + ' · reserve')
})

test('statusLine handles partial readings and preserves zero percentages', async () => {
  expect(statusLine({ mode: 'always', u: 0, P: 0, reserve: false })).toBe('crossfeed always · claude 5h 0% · codex unavailable · pressure 0')
  expect(statusLine({ mode: 'auto', w: 0, codexPercent: 0, P: 0.25, reserve: false })).toBe('crossfeed auto · 7d 0% · codex wk 0% · pressure 0.25')
})

test('pressure displays at most two decimals without trailing zeros', async () => {
  for (const [P, expected] of [[0.30000000000000004, '0.3'], [0.116666, '0.12'], [0, '0'], [1, '1']] as const) {
    expect(statusLine({ mode: 'auto', u: 5, P, reserve: false })).toBe(`crossfeed auto · claude 5h 5% · codex unavailable · pressure ${expected}`)
    expect(pressureNotice({ u: 5, P })).toBe(`crossfeed: Claude 5h 5%; pressure ${expected}. Hand self-contained implementation, research and review work to Codex when it has headroom.`)
  }
})

test('staticSection quotes script paths containing spaces and apostrophes', async () => {
  expect(staticSection("/tmp/it's here/crossfeed.py").includes("python3 -I '/tmp/it'\\''s here/crossfeed.py' check")).toBe(true)
})

test('notices explain pressure, reserve and how to hand off a long stretch', async () => {
  const reminder = stretchReminder({ calls: 12, u: 62, script: '/x/crossfeed.py' })
  expect(reminder.includes('12')).toBe(true)
  expect(reminder.includes('62%')).toBe(true)
  expect(reminder.includes("python3 -I '/x/crossfeed.py' run")).toBe(true)
  expect(reminder.includes('background')).toBe(true)
  expect(pressureNotice({ u: 62, F: 104, P: 0.4 }).includes('104%')).toBe(true)
  expect(pressureNotice({ u: 62, P: 0.4 }).includes('0.4')).toBe(true)
  const reserve = reserveNotice(90)
  expect(reserve.includes('90%')).toBe(true)
  expect(reserve.includes('finish the current step')).toBe(true)
  expect(reserve.includes('hand-off note')).toBe(true)
  expect(reserve.includes('start no new autonomous work')).toBe(true)
})

test('all builders produce clean text without a trailing newline', async () => {
  const outputs = [
    shellQuote(''), dispatchCommand(dispatch),
    denyText({ saved: false, tier: 'A', reason: '', u: 0, command }),
    staticSection('/tmp/检查 naïve/crossfeed.py'),
    statusLine({ mode: 'auto', P: 0, reserve: false }),
    stretchReminder({ calls: 0, u: 0, script: '' }),
    pressureNotice({ u: 0, P: 0 }), reserveNotice(0),
  ]
  for (const output of outputs) {
    expect(output.endsWith('\n')).toBe(false)
    expect(output.includes('undefined')).toBe(false)
    expect(output.includes('NaN')).toBe(false)
  }
})

const guidance = 'Add --write if the task must change files, drop it if not. Wait for the exit notification and do not poll. Check the result before you report it.'

test('saved-brief command quotes the path and matches every option exactly', async () => {
  expect(dispatchCommand({ ...dispatch, session: 'session', effort: 'xhigh', model: 'test model', timeoutMinutes: 5, briefFile: "/tmp/it's 检查.md" })).toBe(
    "python3 -I '/x/crossfeed.py' run --tier A --kind subagent --dir '/tmp/a b/它' --write --worktree --session 'session' --effort 'xhigh' --model 'test model' --timeout 5 --brief-file '/tmp/it'\\''s 检查.md'",
  )
})

test('saved-brief refusal matches all five lines with rounded and optional readings', async () => {
  const savedCommand = "python3 -I '/x/crossfeed.py' run --tier B --kind subagent --dir '/tmp/a b/它' --brief-file '/tmp/brief.md'"
  expect(dispatchCommand({ ...dispatch, tier: 'B', write: false, worktree: false, briefFile: '/tmp/brief.md' })).toBe(savedCommand)
  const input = { tier: 'B' as const, reason: 'no check command', u: 61.6, command: savedCommand, saved: true }
  expect(denyText({ ...input, F: 103.6, codexPercent: 17.2 })).toBe([
    'crossfeed: run this on Codex instead of a Claude subagent.',
    'Why: tier B (no check command). Claude 5h 62%, on pace for 104%; Codex weekly 17%.',
    'The brief you just wrote is saved. Start this as a background Bash command:',
    savedCommand,
    guidance,
  ].join('\n'))
  expect(denyText(input)).toBe([
    'crossfeed: run this on Codex instead of a Claude subagent.',
    'Why: tier B (no check command). Claude 5h 62%.',
    'The brief you just wrote is saved. Start this as a background Bash command:',
    savedCommand,
    guidance,
  ].join('\n'))
})

test('fallback refusal uses the supplied delimiter in both command and closing line', async () => {
  const delimiter = 'CROSSFEED_BRIEF_test_1'
  const fallbackCommand = command.replace('CROSSFEED_BRIEF_EOF', delimiter)
  expect(dispatchCommand({ ...dispatch, delimiter })).toBe(fallbackCommand)
  expect(denyText({ tier: 'A', reason: 'has a check command', u: 5, command: fallbackCommand, saved: false, delimiter })).toBe([
    'crossfeed: run this on Codex instead of a Claude subagent.',
    'Why: tier A (has a check command). Claude 5h 5%.',
    'Start it as a background Bash command with the brief you just wrote, unchanged, as stdin:',
    fallbackCommand,
    '<the brief>',
    delimiter,
    guidance,
  ].join('\n'))
})

test('heredoc delimiters avoid every substring collision, including repeated candidates', async () => {
  const now = 1794902400000
  const first = 'CROSSFEED_BRIEF_' + now.toString(36)
  expect(textBuilders.heredocDelimiter('', now)).toBe(first)
  for (const initial of ['', '检查 naïve\r\n$(touch pwned)\r\nCROSSFEED_BRIEF_EOF', 'prefix' + first + 'suffix']) {
    let brief = initial
    for (let i = 0; i < 10; i++) {
      const delimiter = textBuilders.heredocDelimiter(brief, now)
      expect(delimiter.startsWith(first)).toBe(true)
      expect(brief.includes(delimiter)).toBe(false)
      brief += '\r\nprefix' + delimiter + 'suffix'
    }
  }
})

const limit = { label: 'Fable', family: 'fable', percent: 62, line: 33, resetsAt: Date.parse('2026-11-23T22:00:00Z'), state: 'ahead' as const }

test('model limits appear after seven-day usage and omit unknown readings', async () => {
  const input = { mode: 'auto' as const, u: 40, w: 55, codexPercent: 27, P: 0, reserve: false }
  expect(statusLine({ ...input, limits: [limit] })).toBe('crossfeed auto · claude 5h 40% · 7d 55% · fable wk 62% ahead · codex wk 27% · pressure 0')
  expect(statusLine({ ...input, limits: [{ ...limit, state: 'unknown' }] })).toBe(statusLine(input))
  expect(statusLine({ ...input, limits: [{ ...limit, state: 'full' }] }).includes('fable wk 62% full')).toBe(true)
})

test('limit refusals explain the cause and place it immediately after kind', async () => {
  const input = { tier: 'B' as const, reason: 'no check command', u: 10, command, saved: true, limit }
  expect(denyText(input).includes('Fable weekly 62% used, ahead of an even pace (33%).')).toBe(true)
  expect(denyText({ ...input, limit: { ...limit, state: 'full' } }).includes('Fable weekly 62% used, limit used up.')).toBe(true)
  expect(denyText({ ...input, limit: { ...limit, line: undefined } }).includes('Fable weekly 62% used.')).toBe(true)
  expect(dispatchCommand({ ...dispatch, cause: 'limit' }).includes('--kind subagent --cause limit --dir')).toBe(true)
  expect(dispatchCommand({ ...dispatch, cause: 'x;$(echo y)' }).includes("--cause 'x;$(echo y)' --dir")).toBe(true)
})

test('ahead and full notices preserve labels and include reset and model advice', async () => {
  for (const state of ['ahead', 'full'] as const) {
    const note = textBuilders.limitNotice({ ...limit, state, fallback: 'opus' })
    for (const part of ['Fable', '62%', '2026-11-23 22:00 UTC', '/model opus', '/advisor fable']) expect(note.includes(part)).toBe(true)
    const unknown = textBuilders.limitNotice({ ...limit, state, resetsAt: undefined, line: undefined, fallback: 'opus' })
    expect(unknown.includes('undefined')).toBe(false)
    expect(unknown.includes('UTC')).toBe(false)
  }
  expect(textBuilders.limitNotice({ ...limit, label: 'Fable · beta', fallback: 'opus' }).includes('Fable · beta')).toBe(true)
  for (const [label, family, advisor] of [['Sonnet only', 'sonnet', '/advisor sonnet'], ['Gizmo', undefined, undefined], ['Haiku', 'haiku', undefined]] as const) {
    for (const state of ['ahead', 'full'] as const) {
      const note = textBuilders.limitNotice({ ...limit, label, family, state, fallback: 'opus' })
      expect(note.includes('/advisor sonnet only')).toBe(false)
      expect(note.includes('/advisor')).toBe(advisor !== undefined)
      if (advisor) expect(note.includes(advisor + ' keeps Sonnet only')).toBe(true)
    }
  }
  expect(textBuilders.limitNotice({ ...limit, fallback: 'opus' }).includes('uses less')).toBe(false)
  const disabled = textBuilders.limitNotice({ ...limit, fallback: '' })
  expect(disabled.includes('run on .')).toBe(false)
  expect(disabled.includes('/model ')).toBe(false)
  expect(disabled.endsWith(' Subagents that stay on Claude keep their model.')).toBe(true)
})

test('limit stretch reminders work without a five-hour reading', async () => {
  const note = stretchReminder({ calls: 12, limit, script: '/x/crossfeed.py' })
  expect(note.startsWith('crossfeed: 12 main-loop tool calls since the last user prompt; Fable weekly 62% used, ahead of pace.')).toBe(true)
  expect(note.includes('Claude 5h')).toBe(false)
  expect(stretchReminder({ calls: 12, limit, u: 0, script: '' }).includes('Claude 5h 0%')).toBe(true)
})

test('model-limit static guidance appears exactly once after keep-design guidance', async () => {
  const line = "- When crossfeed says a model's weekly limit is ahead of pace, keep planning, decisions and review yourself and hand execution to Codex."
  const lines = staticSection('/x/crossfeed.py').split('\n')
  expect(lines.filter(text => text === line).length).toBe(1)
  expect(lines[lines.indexOf(line) - 1]?.startsWith('- Keep design')).toBe(true)
})

test('limitLines describes pace, state, age and routing', async () => {
  expect(textBuilders.limitLines([{ ...limit, ageSeconds: 40, subagents: 'hand off or run on opus' }])).toEqual([
    'Fable weekly: 62% used, even pace 33%, ahead, read 40 seconds ago; subagents on fable: hand off or run on opus',
  ])
  expect(textBuilders.limitLines([{ ...limit, line: undefined, ageSeconds: 0, subagents: 'unchanged' }])[0]?.includes('even pace unknown')).toBe(true)
})

test('limitLines names subagents by model family, not by bucket label', async () => {
  const [line] = textBuilders.limitLines([{ label: 'Sonnet only', family: 'sonnet', percent: 85, line: 34, state: 'ahead', ageSeconds: 18, subagents: 'run on opus' }])
  expect(line?.endsWith('subagents on sonnet: run on opus')).toBe(true)
})

test('premiumFallback defaults only non-string inputs', async () => {
  expect(toConfig({ premiumFallback: 3 }).premiumFallback).toBe('opus')
  expect(toConfig({ premiumFallback: '' }).premiumFallback).toBe('')
  expect(toConfig({}).premiumFallback).toBe('opus')
})
