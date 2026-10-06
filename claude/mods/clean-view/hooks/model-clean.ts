import type { Checklist, CleanTask, Phase } from '../types'
import { PLUGIN_NAME, charLength } from './model'

// Pure logic of the Clean View feature: nothing here touches `$`.

export const STORE_KEY = 'enabled'
export const PLAN_TOOL = `mcp__${PLUGIN_NAME}__plan_steps`
export const PROGRESS_TOOL = `mcp__${PLUGIN_NAME}__report_progress`

export const MAX_NAME_CHARS = 40
export const MAX_STEPS = 8
export const METER_CELLS = 10
export const LABEL_CELLS = 7 // "Up next", "Working"
export const FRAME_MS = 250
export const COLLAPSE_MS = 5000
export const FALLBACK_NAME = 'Working on it'
export const FALLBACK_TITLE = 'Working on your request'
export const PLACEHOLDER_STEPS = ['Understand your request', 'Plan the steps'] as const
export const FAILURES_TO_STUCK = 3

export const REASON_PERMISSION = 'Claude needs your OK to continue'
export const REASON_QUESTION = 'Claude has a question for you'
export const REASON_REPLY = 'Claude is waiting for your reply'
export const STUCK_DENIED = 'you said no to a step, so Claude paused'
export const STUCK_FAILING = 'a step keeps failing, Claude is trying another way'
export const STUCK_REFUSED = "Claude couldn't help with that request"

// ---------- text helpers (by code point, never reversed: Hebrew stays in its stored order) ----------

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

// File names that are code or settings. A word that ends in one of these is dropped from a name.
const CODE_EXT =
  /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|json|jsonc|md|mdx|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|sql|sh|ps1|bat|css|scss|less|html?|xml|ya?ml|toml|ini|env|lock|txt|csv|vue|svelte|swift|ipynb)$/i

function isCodeWord(word: string): boolean {
  if (/[\\/]/.test(word)) return true // anything with a slash: a path, a URL
  return CODE_EXT.test(word.replace(/[.,;:!?)"'\]}>]+$/, ''))
}

function capitalise(text: string): string {
  const chars = Array.from(text)
  const first = chars[0]
  return first === undefined ? text : first.toUpperCase() + chars.slice(1).join('')
}

// The words of a text with its code taken out (backtick spans, paths, code file names), whitespace collapsed.
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ') // a stray tick of an unclosed span
    .replace(CONTROL, ' ')
    .split(/\s+/)
    .filter(w => w !== '' && !isCodeWord(w))
    .join(' ')
    .trim()
}

// The one name cleaner. Strips backtick code, anything with a slash and file names with a code extension, collapses
// whitespace and capitalises the first letter. A name over 40 characters is cut at a word boundary and gets "…" (the
// result is never longer than 40). Nothing left: the fallback.
export function cleanName(raw: unknown, fallback: string = FALLBACK_NAME): string {
  let name = stripCode(typeof raw === 'string' ? raw : '')
  if (name === '') return fallback
  name = capitalise(name)
  const chars = Array.from(name)
  if (chars.length > MAX_NAME_CHARS) {
    let cut = chars.slice(0, MAX_NAME_CHARS - 1).join('')
    if (chars[MAX_NAME_CHARS - 1] !== ' ') {
      const space = cut.lastIndexOf(' ')
      if (space > 0) cut = cut.slice(0, space)
    }
    cut = cut.replace(/[\s.,;:!?-]+$/, '')
    name = `${cut}…`
  }
  return name
}

// ---------- the job's name, worked out locally from the prompt (no model is called) ----------

// What a person puts in front of the real request.
const FILLERS: readonly RegExp[] = [
  /^(?:hey|hi|hello|ok|okay|so|well|claude)\b[\s,!.:-]*/i,
  /^(?:please|pls|kindly)\b[\s,]*/i,
  /^(?:can|could|would|will)\s+you\b(?:\s+please)?[\s,]*/i,
  /^i(?:'d|\s+would|\s+want|\s+need|\s+wanna)\s+(?:like\s+)?(?:you\s+)?to\s+/i,
  /^i(?:'d|\s+would)\s+(?:like|love)\s+(?:you\s+)?to\s+/i,
  /^let'?s\s+/i,
  /^help\s+me(?:\s+to)?\s+/i,
  /^(?:go\s+ahead\s+and|just)\s+/i,
]
const QUESTION_START = /^(?:what|why|how|who|whom|whose|where|when|which|is|are|am|was|were|does|do|did|has|have|should|shall)\b/i
export const MAX_TITLE_WORDS = 6

export function jobName(prompt: string): string {
  let text = prompt.replace(/```[\s\S]*?```/g, ' ').trim()
  let before = ''
  while (before !== text) {
    before = text
    for (const filler of FILLERS) text = text.replace(filler, '').trim()
  }
  if (QUESTION_START.test(text)) return 'Answer your question'
  // the first line with words in it, the code taken out first so a file name's dot is not the end of a sentence
  const line = text.split(/\r?\n/).map(stripCode).find(l => l !== '') ?? ''
  const clause = line.split(/[.?!;:,]| - | — /)[0] ?? ''
  const cleaned = cleanName(clause, '')
  if (cleaned === '') return FALLBACK_TITLE
  const words = cleaned.split(' ')
  return cleanName(words.slice(0, MAX_TITLE_WORDS).join(' '), FALLBACK_TITLE)
}

// ---------- time and meter ----------

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export const clampPercent = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}

// Always METER_CELLS cells: filled `█`, empty `░`.
export function meterBar(percent: number): string {
  const filled = Math.min(METER_CELLS, Math.max(0, Math.round(clampPercent(percent) / 10)))
  return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled)
}

// The moving sweep of a step with no percent yet: three cells that bounce from end to end.
const SWEEP_CELLS = 3
export function sweepBar(frame: number): string {
  const span = METER_CELLS - SWEEP_CELLS
  const period = span * 2
  const p = ((Math.floor(frame) % period) + period) % period
  const start = p <= span ? p : period - p
  return '░'.repeat(start) + '█'.repeat(SWEEP_CELLS) + '░'.repeat(METER_CELLS - SWEEP_CELLS - start)
}

export type RowKind = 'done' | 'active' | 'upcoming'
export type RowView = { glyph: string; kind: RowKind; name: string; meter: string; label: string; isHeld: boolean }

// What one checklist row shows. `isHeld`: the person's turn (the ▶ becomes ‖ and the sweep stands still).
export function rowViews(tasks: readonly CleanTask[], frame: number, isHeld: boolean): RowView[] {
  let seenUpcoming = false
  return tasks.map(t => {
    if (t.status === 'done') return { glyph: '✓', kind: 'done', name: t.name, meter: meterBar(100), label: 'Done', isHeld: false }
    if (t.status === 'active') {
      const meter = t.hasReported ? meterBar(t.percent) : sweepBar(isHeld ? 0 : frame)
      return { glyph: isHeld ? '‖' : '▶', kind: 'active', name: t.name, meter, label: t.hasReported ? `${t.percent}%` : 'Working', isHeld }
    }
    const label = seenUpcoming ? 'Up next' : 'Next'
    seenUpcoming = true
    return { glyph: '○', kind: 'upcoming', name: t.name, meter: meterBar(0), label, isHeld: false }
  })
}

// At most `max` rows, kept around the current step, so a long list never pushes the prompt off the screen.
export function windowRows<T>(rows: readonly T[], activeIndex: number, max: number): T[] {
  if (rows.length <= max) return [...rows]
  const start = Math.min(Math.max(0, activeIndex - 2), rows.length - max)
  return rows.slice(start, start + max)
}

// The width of the name column: as wide as the longest name, never so wide that a row would wrap.
export function nameWidth(names: readonly string[], bodyColumns: number): number {
  const longest = names.reduce((m, n) => Math.max(m, charLength(n)), 0)
  const room = Math.max(6, bodyColumns - (1 + 1 + 1 + METER_CELLS + 1 + LABEL_CELLS))
  return Math.max(1, Math.min(longest, room, MAX_NAME_CHARS))
}

// ---------- the command ----------

export type SimpleCommand = 'on' | 'off' | 'toggle' | 'unknown'

export function parseCommand(args: string | readonly string[] | undefined): SimpleCommand {
  const text = (Array.isArray(args) ? args.join(' ') : String(args ?? '')).trim().toLowerCase()
  if (text === '') return 'toggle'
  if (text === 'on') return 'on'
  if (text === 'off') return 'off'
  return 'unknown'
}

// ---------- which tool rows may be hidden ----------

// Only these tools are hidden. A message or file sent to the person, a goal proposal, a sign-in offer, a question, a plan
// and anything new are drawn by the engine as they are.
const HIDEABLE = new Set([
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Grep',
  'Glob',
  'LSP',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Agent',
  'ToolSearch',
  'plan_steps',
  'report_progress',
])

// Rows that always show: a question, a plan to approve, content meant for the person, an offer.
const ALWAYS_SHOWN = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'SendUserMessage', 'SendUserFile', 'ProposeGoal'])
const OFFERS = /^(?:Suggest|Offer|Show)/
const SIGN_IN = /authenticat/i

export function isHideableTool(tool: string): boolean {
  if (ALWAYS_SHOWN.has(tool)) return false
  const parts = tool.split('__')
  const name = tool.startsWith('mcp__') ? (parts[parts.length - 1] ?? tool) : tool
  if (OFFERS.test(name) || OFFERS.test(tool) || SIGN_IN.test(name)) return false
  if (HIDEABLE.has(tool)) return true
  return tool.startsWith('mcp__') // another MCP tool (sign-in already excluded)
}

// ---------- the plan gate ----------

// These pass the gate before a plan exists.
const GATE_OPEN = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL])
export const passesGate = (tool: string): boolean => GATE_OPEN.has(tool)
export const GATE_MESSAGE = `Clean View needs a plan before any other tool: call ${PLAN_TOOL} first (load it with ToolSearch if it is deferred) with 2 to 8 short plain-English steps, then try this tool again.`

// ---------- the checklist ----------

export const EMPTY_CHECKLIST: Checklist = {
  title: '',
  phase: 'idle',
  tasks: [],
  needsYouReason: null,
  stuckReason: null,
  startedAt: null,
  finishedAt: null,
  isCollapsed: false,
  jobId: 0,
  hasPlan: false,
  failStreak: 0,
}

const task = (id: string, name: string, status: CleanTask['status']): CleanTask => ({
  id,
  name,
  status,
  percent: status === 'done' ? 100 : 0,
  hasReported: status === 'done',
})

function placeholders(): CleanTask[] {
  return PLACEHOLDER_STEPS.map((name, i) => task(`ph${i + 1}`, name, i === 0 ? 'active' : 'upcoming'))
}

// A new job: placeholder steps until the real plan arrives.
export function startJob(cl: Checklist, title: string, now: number): Checklist {
  return {
    ...EMPTY_CHECKLIST,
    title,
    phase: 'working',
    tasks: placeholders(),
    startedAt: now,
    jobId: cl.jobId + 1,
  }
}

export const isIdleLike = (phase: Phase): boolean => phase === 'idle' || phase === 'done' || phase === 'stopped'

// A step arrives with no job running (a skill's turn, a late wake-up): a job with the fallback name starts.
function ensureJob(cl: Checklist, now: number): Checklist {
  return isIdleLike(cl.phase) ? startJob(cl, FALLBACK_TITLE, now) : cl
}

// Exactly the rule the person sees: when no step is current, the first upcoming one starts.
function normalize(tasks: CleanTask[]): CleanTask[] {
  if (tasks.some(t => t.status === 'active')) return tasks
  const i = tasks.findIndex(t => t.status === 'upcoming')
  return i < 0 ? tasks : tasks.map((t, j) => (j === i ? { ...t, status: 'active' as const } : t))
}

// Work is going on again: a reply, a tool that ran, a step that moved clears the person-wait and the stuck state.
function resume(cl: Checklist): Checklist {
  return cl.phase === 'needsYou' || cl.phase === 'stuck' ? { ...cl, phase: 'working', needsYouReason: null, stuckReason: null, finishedAt: null } : cl
}

const normName = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// A step the model names again, matched loosely (case, punctuation, a word more or less).
export function findTask(tasks: readonly CleanTask[], name: string): number {
  const want = normName(name)
  if (want === '') return -1
  const exact = tasks.findIndex(t => normName(t.name) === want)
  if (exact >= 0) return exact
  const contains = tasks.findIndex(t => {
    const have = normName(t.name)
    return Math.min(have.length, want.length) >= 6 && (have.includes(want) || want.includes(have))
  })
  if (contains >= 0) return contains
  const a = new Set(want.split(' '))
  return tasks.findIndex(t => {
    const b = new Set(normName(t.name).split(' '))
    const shared = [...a].filter(w => b.has(w)).length
    return shared >= 2 && shared / Math.max(a.size, b.size) >= 0.6
  })
}

// plan_steps: the real plan. The first step starts. A step the earlier plan had already finished stays finished.
export function planSteps(cl: Checklist, rawSteps: unknown, now: number): { checklist: Checklist; count: number } {
  const given = Array.isArray(rawSteps) ? rawSteps : []
  const names: string[] = []
  for (const s of given) {
    if (typeof s !== 'string' || s.trim() === '') continue
    const name = cleanName(s)
    if (!names.some(n => normName(n) === normName(name))) names.push(name)
    if (names.length >= MAX_STEPS) break
  }
  if (names.length === 0) return { checklist: cl, count: 0 }
  const base = ensureJob(cl, now)
  const wasDone = (name: string): boolean => base.hasPlan && base.tasks.some(t => t.status === 'done' && normName(t.name) === normName(name))
  const tasks = normalize(names.map((n, i) => task(`s${i + 1}`, n, wasDone(n) ? 'done' : 'upcoming')))
  return { checklist: { ...resume(base), tasks, hasPlan: true, failStreak: 0 }, count: names.length }
}

// report_progress. A planned step: every step before it is checked off; at 100 it is checked off and the next one starts.
// A name that is not in the plan becomes a new step at the end (and the step that was current is checked off).
export function reportProgress(cl: Checklist, rawTask: unknown, rawPercent: unknown, now: number): { checklist: Checklist; percent: number } {
  const percent = clampPercent(rawPercent)
  const base = resume(ensureJob(cl, now))
  const name = cleanName(rawTask)
  const known = base.hasPlan ? base.tasks : []
  const i = findTask(known, name)
  let tasks: CleanTask[]
  if (i >= 0) {
    tasks = known.map((t, j) => {
      if (j < i) return t.status === 'done' ? t : { ...t, status: 'done' as const, percent: 100, hasReported: true }
      if (j > i) return t
      if (t.status === 'done' && percent < 100) return t // a step already checked off stays so
      return { ...t, status: percent >= 100 ? ('done' as const) : ('active' as const), percent, hasReported: true }
    })
  } else {
    const added: CleanTask = { id: `p${known.length + 1}`, name, status: percent >= 100 ? 'done' : 'active', percent, hasReported: true }
    const before = percent >= 100 ? known : known.map(t => (t.status === 'active' ? { ...t, status: 'done' as const, percent: 100, hasReported: true } : t))
    tasks = [...before, added]
  }
  return { checklist: { ...base, tasks: normalize(tasks), hasPlan: true, failStreak: 0 }, percent }
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null ? (v as Rec) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const statusFromTodo = (v: unknown): CleanTask['status'] => (v === 'completed' ? 'done' : v === 'in_progress' ? 'active' : 'upcoming')

// TodoWrite: the whole list is the checklist. A step that was already running keeps its percent.
export function applyTodos(cl: Checklist, input: unknown, now: number): Checklist {
  const todos = rec(input)?.todos
  if (!Array.isArray(todos)) return cl
  const base = resume(ensureJob(cl, now))
  const old = base.hasPlan ? base.tasks : []
  const tasks = todos.flatMap((t, i): CleanTask[] => {
    const content = str(rec(t)?.content)
    if (content === undefined || content.trim() === '') return []
    const name = cleanName(content)
    const status = statusFromTodo(rec(t)?.status)
    const before = old[findTask(old, name)]
    const kept = status === 'active' && before !== undefined && before.status === 'active'
    return [{ id: `t${i + 1}`, name, status, percent: status === 'done' ? 100 : kept ? before.percent : 0, hasReported: status === 'done' || (kept && before.hasReported) }]
  })
  return { ...base, tasks: normalize(tasks), hasPlan: base.hasPlan || tasks.length > 0, failStreak: 0 }
}

// TaskCreate adds a step (its id comes from the result when there is one).
export function applyTaskCreate(cl: Checklist, input: unknown, result: unknown, now: number): Checklist {
  const subject = str(rec(input)?.subject)
  if (subject === undefined) return cl
  const base = resume(ensureJob(cl, now))
  const known = base.hasPlan ? base.tasks : []
  const id = str(rec(rec(result)?.task)?.id) ?? `task-${known.length + 1}`
  const tasks = [...known.filter(t => t.id !== id), task(id, cleanName(subject), 'upcoming')]
  return { ...base, tasks: normalize(tasks), hasPlan: true, failStreak: 0 }
}

// TaskUpdate sets, renames or deletes a step.
export function applyTaskUpdate(cl: Checklist, input: unknown, now: number): Checklist {
  const id = str(rec(input)?.taskId)
  if (id === undefined || !cl.tasks.some(t => t.id === id)) return cl
  const base = resume(ensureJob(cl, now))
  const status = str(rec(input)?.status)
  const subject = str(rec(input)?.subject)
  if (status === 'deleted') return { ...base, tasks: normalize(base.tasks.filter(t => t.id !== id)) }
  const tasks = base.tasks.map(t => {
    if (t.id !== id) return t
    let next: CleanTask = subject !== undefined && subject.trim() !== '' ? { ...t, name: cleanName(subject) } : t
    if (status === 'completed') next = { ...next, status: 'done', percent: 100, hasReported: true }
    else if (status === 'in_progress') next = { ...next, status: 'active' }
    else if (status === 'pending') next = { ...next, status: 'upcoming', percent: 0, hasReported: false }
    return next
  })
  return { ...base, tasks: normalize(tasks), failStreak: 0 }
}

// ---------- the person's turn, trouble, and the end of a turn ----------

export function setNeedsYou(cl: Checklist, reason: string): Checklist {
  return cl.phase === 'working' || cl.phase === 'needsYou' ? { ...cl, phase: 'needsYou', needsYouReason: reason, stuckReason: null } : cl
}

export function clearNeedsYou(cl: Checklist): Checklist {
  return cl.phase === 'needsYou' ? { ...cl, phase: 'working', needsYouReason: null, finishedAt: null } : cl
}

// What the main loop's tool call came to: a success clears Stuck, a failure counts, a "no" at a permission is Stuck at once.
export type ToolOutcome = 'ok' | 'failed' | 'rejected'
export function noteToolOutcome(cl: Checklist, outcome: ToolOutcome): Checklist {
  if (isIdleLike(cl.phase)) return cl
  if (outcome === 'ok') return cl.failStreak === 0 && cl.phase !== 'stuck' ? cl : { ...(cl.phase === 'stuck' ? resume(cl) : cl), failStreak: 0 }
  const failStreak = cl.failStreak + 1
  if (outcome === 'rejected') return { ...cl, phase: 'stuck', stuckReason: STUCK_DENIED, needsYouReason: null, failStreak }
  if (failStreak >= FAILURES_TO_STUCK) return { ...cl, phase: 'stuck', stuckReason: STUCK_FAILING, needsYouReason: null, failStreak }
  return { ...cl, failStreak }
}

// What the model reads when the person says no at the permission dialog. A rule's or another plugin's denial reads
// differently and is not "you said no".
export const isRejection = (text: string): boolean => /doesn'?t want to proceed|tool use was rejected|rejected by the user/i.test(text)

export const GENERIC_ERROR = 'something went wrong, try again in a moment'

// One calm sentence for an API error: the kind Claude Code classified decides first, then the error's own details. The
// model's words never do.
export function apiErrorSentence(kind: string | undefined, details: string): string {
  switch (kind) {
    case 'rate_limit':
    case 'billing_error':
      return 'you hit your usage limit, try again a little later'
    case 'overloaded':
      return "Claude's servers are busy, try again in a minute"
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'verification_required':
    case 'cloud_credential_error':
      return 'you are signed out, type /login'
    default:
  }
  if (/prompt is too long|context (?:length|window)|too many tokens|exceed.{0,30}context/i.test(details)) return 'this chat is too long, type /compact and try again'
  if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket|connection (?:error|reset|refused|closed)|offline/i.test(details)) {
    return 'the internet connection dropped'
  }
  if (/usage limit|rate limit|429/i.test(details)) return 'you hit your usage limit, try again a little later'
  if (kind === 'server_error' || /overloaded|529|50\d\b/i.test(details)) return "Claude's servers are busy, try again in a minute"
  if (/\/login|unauthori[sz]ed|401|invalid api key|authentication/i.test(details)) return 'you are signed out, type /login'
  return GENERIC_ERROR
}

export type TurnEnd = { reason: 'answer' | 'aborted' | 'refusal' | 'error'; errorKind?: string; text?: string }

export function completeTurn(cl: Checklist, end: TurnEnd, now: number): Checklist {
  if (cl.phase === 'idle') return cl
  const finished = { finishedAt: now, needsYouReason: null, stuckReason: null }
  if (end.reason === 'aborted') return { ...cl, ...finished, phase: 'stopped' }
  if (end.reason === 'refusal') return { ...cl, ...finished, phase: 'stuck', stuckReason: STUCK_REFUSED }
  if (end.reason === 'error') {
    return { ...cl, ...finished, phase: 'stuck', stuckReason: apiErrorSentence(end.errorKind, end.text ?? '') }
  }
  // the model answered. Steps left open mean it is waiting for the person; with no plan there is nothing left open.
  if (cl.hasPlan && cl.tasks.some(t => t.status !== 'done')) {
    return { ...cl, phase: 'needsYou', needsYouReason: REASON_REPLY, stuckReason: null, finishedAt: now }
  }
  return { ...cl, ...finished, phase: 'done', isCollapsed: false, tasks: cl.hasPlan ? cl.tasks : [] }
}

// A new prompt. A reply while the job waits on the person continues the job; a new job starts only when nothing runs.
// `isCommand`: the turn is a slash command's or a skill's. It has no job of its own and asks for no plan: the gate stays
// open (hasPlan) and the band shows nothing but the button.
export function beginTurn(cl: Checklist, text: string, now: number, isCommand = false): Checklist {
  const prompt = text.trim()
  if (cl.phase === 'needsYou') return clearNeedsYou(cl)
  if (cl.phase === 'working') return cl
  if (isCommand || prompt.startsWith('/')) return { ...EMPTY_CHECKLIST, jobId: cl.jobId + 1, hasPlan: true }
  if (prompt === '') return cl
  return startJob(cl, jobName(prompt), now)
}

// Whether a finished job has shrunk to one line (also by the clock, if a timer was lost to a reload).
export function isShrunk(cl: Checklist, now: number): boolean {
  return cl.phase === 'done' && (cl.isCollapsed || (cl.finishedAt !== null && now - cl.finishedAt >= COLLAPSE_MS))
}

