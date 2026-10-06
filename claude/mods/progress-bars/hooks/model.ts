import type { ProgressState, TaskItem } from '../types'

// Pure logic of the progress-bars mod: nothing here touches `$`.

export const STORE_KEY = 'enabled'

// Only these tools collapse to a line. Every other tool (a message or file sent to the person, a goal proposal, an MCP
// tool, a sign-in or install offer, anything new) is drawn by the engine as it is.
export const COLLAPSE_TOOLS = new Set([
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
])
export const collapses = (tool: string): boolean => COLLAPSE_TOOLS.has(tool)

const MAX_TARGET = 40
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

// ---------- text helpers (by code point, never reversed: Hebrew stays in its stored order) ----------

export function truncateChars(text: string, max: number): string {
  const clean = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  if (chars.length <= max) return clean
  if (max <= 1) return max === 1 ? '…' : ''
  return `${chars.slice(0, max - 1).join('')}…`
}

export const charLength = (text: string): number => Array.from(text).length

export function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(p => p !== '')
  return parts.length === 0 ? path : (parts[parts.length - 1] as string)
}

// ---------- commands ----------

export type BarsCommand = 'on' | 'off' | 'status' | 'toggle' | 'unknown'

export function parseCommand(args: string | readonly string[] | undefined): BarsCommand {
  const text = (Array.isArray(args) ? args.join(' ') : String(args ?? '')).trim().toLowerCase()
  if (text === '') return 'toggle'
  if (text === 'on') return 'on'
  if (text === 'off') return 'off'
  if (text === 'status') return 'status'
  return 'unknown'
}

// ---------- fenced code ----------

// Blocks the person runs, pastes or reads as settings: kept whole however long.
export const COMMAND_LANGS = new Set([
  'sh',
  'bash',
  'shell',
  'console',
  'powershell',
  'ps1',
  'cmd',
  'bat',
  'zsh',
  'fish',
  'pwsh',
  'ps',
  'batch',
  'dos',
  'shell-session',
  'sh-session',
  'terminal',
  'nu',
])
export const DATA_LANGS = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'dotenv', 'diff', 'patch'])
export const KEEP_LINES = 5 // a block this short is kept

// A fence is at most three spaces in, as in Markdown; a deeper line is prose or a block's own text.
const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const isCloseOf = (line: string, mark: string): boolean => {
  const run = CLOSE.exec(line)?.[1]
  return run !== undefined && run[0] === mark[0] && run.length >= mark.length
}

export type Fence = { lang: string; lines: string[] }

// Whether a closed fenced block stays fully visible: short, or something the person runs or pastes.
export function keepsBlock(fence: Fence): boolean {
  if (fence.lines.length <= KEEP_LINES) return true
  const lang = fence.lang.toLowerCase()
  if (COMMAND_LANGS.has(lang) || DATA_LANGS.has(lang)) return true
  return fence.lines.some(l => /^\s*! /.test(l))
}

// A body line that would open a fence of its own kind with a language, at least as long as `mark`.
function holdsOpener(lines: readonly string[], mark: string): boolean {
  return lines.some(l => {
    const o = OPEN.exec(l)
    const run = o?.[2]
    return run !== undefined && run[0] === mark[0] && run.length >= mark.length && (o?.[3] as string).trim() !== '' && !(o?.[3] as string).includes('`')
  })
}

export const collapsedLine =(fence: Fence, indent = ''): string =>
  `${indent}\`[code · ${fence.lang === '' ? 'text' : fence.lang} · ${fence.lines.length} lines]\``

// Replaces each long CLOSED fenced block of code (``` or ~~~, with or without a language) by one line
// `[code · lang · N lines]` (at the opener's indent); prose is untouched. A fence with no closing line is never
// collapsed, so a stray fence cannot swallow the text after it, and a reply still streaming shows in full.
export function stripFences(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text
  const source = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < source.length) {
    const line = source[i] as string
    const open = OPEN.exec(line)
    // a backtick in the info string means inline code, not a fence (tildes too)
    if (open === null || (open[3] as string).includes('`')) {
      out.push(line)
      i += 1
      continue
    }
    const mark = open[2] as string
    let j = i + 1
    while (j < source.length && !isCloseOf(source[j] as string, mark)) j += 1
    if (j >= source.length) {
      // never closed: all of it stays
      out.push(...source.slice(i))
      break
    }
    const lang = ((open[3] as string).trim().split(/\s+/)[0] ?? '').replace(/^\{\.?|\}$/g, '')
    const fence: Fence = { lang, lines: source.slice(i + 1, j) }
    // an opener of the same kind, with a language and a run as long as ours, inside the body means the fences are not
    // really nested (stray fences closed against each other): the span may hold prose, so it stays whole
    if (keepsBlock(fence) || holdsOpener(fence.lines, mark)) out.push(...source.slice(i, j + 1))
    else out.push(collapsedLine(fence, open[1] as string))
    i = j + 1
  }
  return out.join('\n')
}

// ---------- the one-line target of a tool row ----------

function str(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

// Never the whole command: its description when it has one, else its first two words.
function bashTarget(input: unknown): string {
  const description = str(input, 'description')
  if (description !== undefined && description.trim() !== '') return truncateChars(description, MAX_TARGET)
  const command = str(input, 'command') ?? ''
  const words = command.trim().split(/\s+/).filter(w => w !== '')
  return truncateChars(words.slice(0, 2).join(' '), MAX_TARGET)
}

export function shortTarget(tool: string, input: unknown): string {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const p = str(input, 'file_path')
      return p === undefined ? '' : truncateChars(baseName(p), MAX_TARGET)
    }
    case 'NotebookEdit': {
      const p = str(input, 'notebook_path') ?? str(input, 'file_path')
      return p === undefined ? '' : truncateChars(baseName(p), MAX_TARGET)
    }
    case 'Bash':
    case 'PowerShell':
      return bashTarget(input)
    case 'Grep':
    case 'Glob': {
      const p = str(input, 'pattern')
      return p === undefined ? '' : truncateChars(p, MAX_TARGET)
    }
    case 'Agent':
    case 'Task': {
      const d = str(input, 'description')
      return d === undefined ? '' : truncateChars(d, MAX_TARGET)
    }
    default:
      return ''
  }
}

export const toolLabel = (tool: string, input: unknown): string => {
  const name = truncateChars(tool, 40)
  const target = shortTarget(tool, input)
  return target === '' ? name : `${name} ${target}`
}

// ---------- the dim line under a finished call ----------

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const lineCount = (s: string): number => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0))

// Lines added and removed, from the structured patch, else the git diff counts, else (for an edit) the old and new text.
export function editCounts(output: unknown): { added: number; removed: number } | undefined {
  const o = rec(output)
  if (o === undefined) return undefined
  if (Array.isArray(o.structuredPatch) && o.structuredPatch.length > 0) {
    let added = 0
    let removed = 0
    for (const hunk of o.structuredPatch) {
      const lines = rec(hunk)?.lines
      if (!Array.isArray(lines)) continue
      for (const l of lines) {
        if (typeof l !== 'string') continue
        if (l.startsWith('+')) added += 1
        else if (l.startsWith('-')) removed += 1
      }
    }
    return { added, removed }
  }
  const diff = rec(o.gitDiff)
  const a = num(diff?.additions)
  const d = num(diff?.deletions)
  if (a !== undefined && d !== undefined) return { added: a, removed: d }
  if (typeof o.newString === 'string' || typeof o.oldString === 'string') {
    return { added: lineCount(String(o.newString ?? '')), removed: lineCount(String(o.oldString ?? '')) }
  }
  if (typeof o.content === 'string') {
    return { added: lineCount(o.content), removed: typeof o.originalFile === 'string' ? lineCount(o.originalFile) : 0 }
  }
  return undefined
}

export function summarize(tool: string, output: unknown): string {
  const o = rec(output)
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      if (o?.staged === true) return 'held for review, not written'
      const c = editCounts(output)
      return c === undefined ? 'edited' : `+${c.added} −${c.removed}`
    }
    case 'Read': {
      const file = rec(o?.file)
      const n = num(file?.numLines)
      if (n !== undefined) return `${n} line${n === 1 ? '' : 's'}`
      if (o?.type === 'image') return 'image'
      if (o?.type === 'notebook') return 'notebook'
      return 'done'
    }
    case 'Bash':
    case 'PowerShell': {
      if (o?.interrupted === true) return 'interrupted'
      if (typeof o?.backgroundTaskId === 'string') return 'running in background'
      const note = typeof o?.returnCodeInterpretation === 'string' ? truncateChars(o.returnCodeInterpretation, MAX_TARGET) : ''
      const hasStderr = typeof o?.stderr === 'string' && o.stderr.trim() !== ''
      return ['done', note, hasStderr ? 'stderr' : ''].filter(p => p !== '').join(' · ')
    }
    case 'Grep': {
      const mode = o?.mode
      if (mode === 'content') {
        const n = num(o?.numMatches) ?? num(o?.numLines)
        if (n !== undefined) return `${n} match${n === 1 ? '' : 'es'}`
      }
      if (mode === 'count') {
        const n = num(o?.numMatches)
        if (n !== undefined) return `${n} match${n === 1 ? '' : 'es'}`
      }
      const n = num(o?.numFiles)
      return n === undefined ? 'done' : `${n} file${n === 1 ? '' : 's'}`
    }
    case 'Glob': {
      const n = num(o?.numFiles)
      if (n === undefined) return 'done'
      return `${n}${o?.truncated === true ? '+' : ''} file${n === 1 ? '' : 's'}`
    }
    default:
      return 'done'
  }
}

// ---------- the turn bar ----------

export const EMPTY_PROGRESS: ProgressState = { tasks: null, started: 0, finished: 0 }

// `▕████░░░░▏`: `width` cells between the ends, `done` of `total` filled (an empty total draws all light).
export function bar(done: number, total: number, width: number): string {
  const w = Math.max(1, Math.floor(width))
  const filled = total <= 0 ? 0 : Math.max(0, Math.min(w, Math.round((done / total) * w)))
  return `▕${'█'.repeat(filled)}${'░'.repeat(w - filled)}▏`
}

export function taskProgress(tasks: readonly TaskItem[]): { done: number; total: number } {
  return { done: tasks.filter(t => t.status === 'completed').length, total: tasks.length }
}

// The latest task list from a TodoWrite call's input.
export function tasksFromTodos(input: unknown): TaskItem[] | undefined {
  const todos = rec(input)?.todos
  if (!Array.isArray(todos)) return undefined
  return todos.map((t, i) => ({ id: `todo-${i}`, status: statusOf(rec(t)?.status) }))
}

export function statusOf(v: unknown): TaskItem['status'] {
  return v === 'completed' || v === 'in_progress' ? v : 'pending'
}

// A task call counts only when the tool did not report a failure: `success: false` or an `error` field.
export function taskCallOk(result: unknown): boolean {
  const r = rec(result)
  if (r === undefined) return true
  return r.success !== false && r.error === undefined
}

// A TaskCreate adds a task (its id comes from the result, else a running number); a TaskUpdate sets or deletes one.
export function applyTaskCall(tasks: readonly TaskItem[] | null, tool: string, input: unknown, result: unknown): TaskItem[] | null {
  const list = tasks === null ? [] : [...tasks]
  if (tool === 'TaskCreate') {
    const id = str(rec(rec(result)?.task), 'id') ?? `task-${list.length + 1}`
    return [...list.filter(t => t.id !== id), { id, status: 'pending' }]
  }
  if (tool === 'TaskUpdate') {
    const id = str(input, 'taskId')
    if (id === undefined) return tasks === null ? null : list
    const status = str(input, 'status')
    if (status === 'deleted') return list.filter(t => t.id !== id)
    if (status === undefined) return tasks === null ? null : list
    const next = statusOf(status)
    return list.some(t => t.id === id) ? list.map(t => (t.id === id ? { ...t, status: next } : t)) : [...list, { id, status: next }]
  }
  return tasks === null ? null : list
}

// The whole turn line: `▕████████░░░░▏ 4/7 tasks`, or, with no task list, finished/started tool calls.
export function turnLine(progress: ProgressState, columns: number): { bar: string; label: string } {
  const tasks = progress.tasks
  const hasTasks = tasks !== null && tasks.length > 0
  const { done, total } = hasTasks ? taskProgress(tasks) : { done: progress.finished, total: progress.started }
  const label = hasTasks ? `${done}/${total} tasks` : `${total} tool call${total === 1 ? '' : 's'}`
  const room = columns - charLength(label) - 3 // the two ends and the space
  const width = Math.max(10, Math.min(30, room))
  return { bar: bar(done, total, width), label }
}

// The running mark of a row: a static indeterminate bar (no timer per row).
export const RUNNING_BAR = '░░▒▓'
