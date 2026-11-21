import type { Mode } from './config'
import type { BucketState } from './policy'

export type LimitFact = { label: string; family?: string; percent: number; line?: number; resetsAt?: number; state: 'ahead' | 'full' }

// /advisor takes these names only; a label such as "Sonnet only" is not one.
const ADVISOR_MODELS = ['fable', 'opus', 'sonnet']

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function heredocDelimiter(brief: string, now: number): string {
  const base = 'CROSSFEED_BRIEF_' + now.toString(36)
  let delimiter = base
  let counter = 0
  while (brief.includes(delimiter)) delimiter = base + '_' + ++counter
  return delimiter
}

export function dispatchCommand(a: { script: string; tier: 'A' | 'B'; dir: string; write: boolean; worktree: boolean; session?: string; effort?: string; model?: string; timeoutMinutes?: number; briefFile?: string; delimiter?: string; cause?: string }): string {
  const parts = ['python3', '-I', shellQuote(a.script), 'run', '--tier', a.tier, '--kind', 'subagent']
  if (a.cause !== undefined) parts.push('--cause', /^[A-Za-z0-9-]{1,32}$/.test(a.cause) ? a.cause : shellQuote(a.cause))
  parts.push('--dir', shellQuote(a.dir))
  if (a.write) parts.push('--write')
  if (a.worktree) parts.push('--worktree')
  if (a.session !== undefined) parts.push('--session', shellQuote(a.session))
  if (a.effort !== undefined && a.effort !== 'high') parts.push('--effort', shellQuote(a.effort))
  if (a.model !== undefined && a.model !== '') parts.push('--model', shellQuote(a.model))
  if (a.timeoutMinutes !== undefined && a.timeoutMinutes !== 30) parts.push('--timeout', String(a.timeoutMinutes))
  if (a.briefFile !== undefined) parts.push('--brief-file', shellQuote(a.briefFile))
  else parts.push('<<' + shellQuote(a.delimiter ?? 'CROSSFEED_BRIEF_EOF'))
  return parts.join(' ')
}

export function denyText(a: { tier: 'A' | 'B'; reason: string; u: number; F?: number; codexPercent?: number; command: string; saved: boolean; delimiter?: string; limit?: LimitFact }): string {
  const pace = a.F === undefined ? '' : `, on pace for ${Math.round(a.F)}%`
  const codex = a.codexPercent === undefined ? '' : `; Codex weekly ${Math.round(a.codexPercent)}%`
  return [
    'crossfeed: run this on Codex instead of a Claude subagent.',
    a.limit ? `Why: tier ${a.tier}; ${a.limit.label} weekly ${Math.round(a.limit.percent)}% used${a.limit.state === 'full' ? ', limit used up' : a.limit.line === undefined ? '' : `, ahead of an even pace (${Math.round(a.limit.line)}%)`}.`
      : `Why: tier ${a.tier} (${a.reason}). Claude 5h ${Math.round(a.u)}%${pace}${codex}.`,
    a.saved ? 'The brief you just wrote is saved. Start this as a background Bash command:'
      : 'Start it as a background Bash command with the brief you just wrote, unchanged, as stdin:',
    a.command,
    ...(a.saved ? [] : ['<the brief>', a.delimiter ?? 'CROSSFEED_BRIEF_EOF']),
    'Add --write if the task must change files, drop it if not. Wait for the exit notification and do not poll. Check the result before you report it.',
  ].join('\n')
}

export function staticSection(script: string): string {
  return [
    '# crossfeed: handing work to Codex',
    'This session can hand self-contained work to the Codex CLI, which runs on a separate subscription. crossfeed watches both quotas and tells you when to use it.',
    '- When a subagent call is refused with a message that starts with "crossfeed:", run the command in that message. Do not retry the subagent.',
    '- Start the command as a background Bash command. You are notified when it exits. Never poll, sleep, or read its output early.',
    '- Hand off only work the brief describes in full: goal, paths, constraints, the check command, the format of the answer. Codex sees none of this conversation.',
    '- Keep design, architecture and UX decisions, talking with the user, and edits under about 20 lines for yourself.',
    "- When crossfeed says a model's weekly limit is ahead of pace, keep planning, decisions and review yourself and hand execution to Codex.",
    '- While a write job runs, do not edit files in its directory.',
    `- A Codex result is a claim. Check it before you report it: after a write job, read the change list and run the check as \`python3 -I ${shellQuote(script)} check <job> -- <command>\`; after a read-only job that succeeded, verify its claims and record whether you used it as \`python3 -I ${shellQuote(script)} used <job> <yes|partly|no>\`.`,
    '- Exit code 75 means Codex is out of quota: do the work yourself.',
    '- Exit code 127 means the codex CLI was not found: do the work yourself and tell the user.',
  ].join('\n')
}

export function statusLine(a: { mode: Mode; u?: number; F?: number; w?: number; codexPercent?: number; codexAvailable?: boolean; codexStale?: boolean; P: number; reserve: boolean; limits?: { label: string; percent: number; state: BucketState }[] }): string {
  if (a.mode === 'off') return 'crossfeed off'
  const parts = [`crossfeed ${a.mode}`]
  if (a.u !== undefined) {
    const pace = a.F === undefined ? '' : ` (pace ${Math.round(a.F)}%)`
    parts.push(`claude 5h ${Math.round(a.u)}%${pace}`)
  }
  if (a.w !== undefined) parts.push(`7d ${Math.round(a.w)}%`)
  for (const limit of a.limits ?? []) {
    if (limit.state === 'unknown') continue
    parts.push(`${limit.label.toLowerCase()} wk ${Math.round(limit.percent)}%${limit.state === 'ahead' || limit.state === 'full' ? ' ' + limit.state : ''}`)
  }
  const waiting = parts.length === 1 && a.codexPercent === undefined
  if (a.codexPercent !== undefined) parts.push(`codex wk ${Math.round(a.codexPercent)}%${a.codexStale ? ' stale' : ''}`)
  else if (!a.codexAvailable) parts.push('codex unavailable')
  else if (a.codexStale) parts.push('codex stale')
  parts.push(waiting ? 'waiting for a reading' : `pressure ${Math.round(a.P * 100) / 100}`)
  if (a.reserve) parts.push('reserve')
  return parts.join(' · ')
}

export function stretchReminder(a: { calls: number; u?: number; script: string; session?: string; limit?: LimitFact }): string {
  const usage = a.limit
    ? `${a.limit.label} weekly ${Math.round(a.limit.percent)}% used, ${a.limit.state === 'full' ? 'limit used up' : 'ahead of pace'}.${a.u === undefined ? '' : ` Claude 5h ${Math.round(a.u)}%.`}`
    : a.u === undefined ? 'usage unknown.' : `Claude 5h ${Math.round(a.u)}%.`
  return `crossfeed: ${a.calls} main-loop tool calls since the last user prompt; ${usage} Hand self-contained work to Codex with python3 -I ${shellQuote(a.script)} run${a.session === undefined ? '' : ' --session ' + shellQuote(a.session)} and the full brief on stdin. The job is read-only unless --write is added. Start it as a background Bash command, wait for the exit notification, and check the result.`
}

export function pressureNotice(a: { u: number; F?: number; P: number }): string {
  const pace = a.F === undefined ? '' : `, on pace for ${Math.round(a.F)}%`
  return `crossfeed: Claude 5h ${Math.round(a.u)}%${pace}; pressure ${Math.round(a.P * 100) / 100}. Hand self-contained implementation, research and review work to Codex when it has headroom.`
}

export function reserveNotice(u: number): string {
  return `crossfeed: Claude 5h ${Math.round(u)}%; reserve. Please finish the current step, keep a hand-off note and start no new autonomous work.`
}


export function limitNotice(a: LimitFact & { fallback: string }): string {
  const reset = a.resetsAt === undefined ? undefined : new Date(a.resetsAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const advisor = a.fallback && a.family !== undefined && ADVISOR_MODELS.includes(a.family) ? a.family : undefined
  const advice = advisor ? ` /model ${a.fallback} with /advisor ${advisor} keeps ${a.label} available for key decisions.` : ''
  if (a.state === 'full') {
    return `crossfeed: ${a.label} weekly limit is used up (${Math.round(a.percent)}% used)${reset ? ` until ${reset}` : ''}.${a.fallback ? ` Subagents that would run on ${a.label} run on ${a.fallback}.` : ' Hand self-contained execution to Codex when it has headroom.'}${advice}`
  }
  const pace = a.line === undefined ? 'ahead of pace' : `an even pace would be ${Math.round(a.line)}%`
  const tell = advisor ? ` Tell the user once that /model ${a.fallback} with /advisor ${advisor} keeps ${a.label} for key decisions.` : ''
  return `crossfeed: ${a.label} weekly ${Math.round(a.percent)}% used; ${pace}${reset ? ` (resets ${reset})` : ''}. Keep planning, decisions and review here; hand self-contained execution to Codex.${a.fallback ? ` Subagents now go to Codex or run on ${a.fallback}.${tell}` : ' Subagents that stay on Claude keep their model.'}`
}

export function limitLines(views: { label: string; family?: string; percent: number; line?: number; state: BucketState; ageSeconds: number; subagents: string }[]): string[] {
  return views.map(view => `${view.label} weekly: ${Math.round(view.percent)}% used, even pace ${view.line === undefined ? 'unknown' : Math.round(view.line) + '%'}, ${view.state}, read ${Math.round(view.ageSeconds)} seconds ago; subagents on ${view.family ?? view.label.toLowerCase()}: ${view.subagents}`)
}
