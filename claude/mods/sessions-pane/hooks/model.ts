// Pure logic of the sessions pane: no `$`, no I/O, so it is unit-tested directly.
import type { LiveCall, RowProgress, SessionRow, SessionState, TaskItem, TaskProgress, WaitKind } from '../types'

// Where the files live, resolved at run time from the environment (see claudeDirFrom), never written in the source.
export type Dirs = { registry: string; coord: string; pane: string; projects: string }

const slashes = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

// The Claude config directory: CLAUDE_CONFIG_DIR, else the home directory (USERPROFILE, then HOME) plus `/.claude`.
// Backslashes become `/`. null when none of the three is set: the pane then reads and writes nothing.
export function claudeDirFrom(configDir: string | undefined, userProfile: string | undefined, home: string | undefined): string | null {
  if (configDir) return slashes(configDir)
  const h = userProfile || home
  return h ? `${slashes(h)}/.claude` : null
}

export function dirsOf(claudeDir: string): Dirs {
  return {
    registry: `${claudeDir}/skills/handoff-launch/sessions.jsonl`,
    coord: `${claudeDir}/state/coord`,
    pane: `${claudeDir}/state/coord/pane`,
    projects: `${claudeDir}/projects`,
  }
}

export const MAX_READ_BYTES = 4 * 1024 * 1024 // $.fs.read rejects anything larger
export const FRESH_MS = 30_000 // a published pane file counts while it is this fresh
export const ALIVE_MS = 30 * 60_000 // a registry-only session counts while its files moved this recently
export const BUSY_MS = 20_000 // a registry-only session whose transcript moved this recently is "busy"
export const WAIT_SKEW_MS = 5_000 // transcript written this much after waiting_since: the wait is over
export const WAIT_MAX_MS = 10 * 60_000 // a coord waiting_since older than this is not shown as a wait
export const WATCHDOG_MS = 30_000 // a refresh running this long is treated as dead
export const SAFE_ID = /^[\w-]+$/

// ---------- registry ----------

export type RegEntry = {
  id: string
  name: string
  repo: string
  branch: string
  worktree: string | null
  sessionId: string | null
  model: string | null
  effort: string | null
  launchedAt: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

// Mirrors launch.mjs `readRegistry` + `sessions`: a launch line has name + launched_at and is none of the other
// line kinds; closed ids come from `{closed}` lines; the newest launch line per `repo|name` among the not-closed
// lines is the open session of that name.
export function parseRegistry(text: string): RegEntry[] {
  const closed = new Set<string>()
  const entries: RegEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) continue
    const r = o as Record<string, unknown>
    if (r.closed) {
      closed.add(String(r.id || r.closed))
    } else if (r.stop_requested || r.merged || r.merge_blocked) {
      continue
    } else if (r.name && r.launched_at) {
      const name = str(r.name)
      const launchedAt = str(r.launched_at)
      if (name === null || launchedAt === null) continue
      entries.push({
        id: str(r.id) ?? `${name}@${launchedAt}`,
        name,
        repo: str(r.repo) ?? '',
        branch: str(r.branch) ?? '',
        worktree: str(r.worktree),
        sessionId: str(r.session_id),
        model: str(r.model),
        effort: str(r.effort),
        launchedAt,
      })
    }
  }
  const newest = new Map<string, RegEntry>()
  for (const e of entries) {
    if (closed.has(e.id)) continue
    const k = `${e.repo}|${e.name}`
    const cur = newest.get(k)
    if (!cur || cur.launchedAt <= e.launchedAt) newest.set(k, e)
  }
  return [...newest.values()]
}

// ---------- goal ----------

export type GoalCount = { done: number; total: number }

// Same checklist grammar as recover-lib parseGoal: `- [ ]`, `- [x]`, `- [!]` (also `*`); x counts as done.
export function countGoal(text: string): GoalCount | null {
  let done = 0
  let total = 0
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X|!)\]/.exec(line)
    if (!m) continue
    total += 1
    if (m[1] === 'x' || m[1] === 'X') done += 1
  }
  return total === 0 ? null : { done, total }
}

export const goalText = (g: GoalCount | null): string | null => (g === null ? null : `${g.done}/${g.total}`)

// ---------- text helpers (character based, never byte based) ----------

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

// Cuts by code points (so a surrogate pair or a Hebrew letter is never split) and marks the cut with an ellipsis.
// It does not reverse or reorder anything: the terminal's own bidi handling sees the text as written.
export function truncateChars(text: string, max: number): string {
  const clean = text.replace(CONTROL, ' ')
  const chars = Array.from(clean)
  if (chars.length <= max) return clean
  if (max <= 1) return max === 1 ? '…' : ''
  return `${chars.slice(0, max - 1).join('')}…`
}

export const charLength = (text: string): number => Array.from(text).length

// True when the text ends on a question: its last visible character is `?` (or the full-width one), ignoring
// trailing whitespace and the closers a message wraps one in (`)`, quotes, markdown emphasis, a code fence tick).
export function endsWithQuestion(text: string | null | undefined): boolean {
  if (!text) return false
  const tail = text.replace(/[\s)\]}>"'`*_~\u201d\u2019\u00bb]+$/u, '')
  return tail.endsWith('?') || tail.endsWith('\uff1f')
}

export function shortModel(model: string | null | undefined): string {
  if (!model) return ''
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

export function modelEffort(model: string | null | undefined, effort: string | null | undefined): string {
  const m = shortModel(model)
  const e = effort ?? ''
  if (m && e) return `${m}\u00b7${e}`
  return m || e || '-'
}

// Claude Code's project folder name for a working directory: every character outside [A-Za-z0-9-] becomes `-`
// (`C:\Users\x\proj` -> `C--Users-x-proj`; `.claude` -> `-claude`; `_` -> `-`).
export const projectKey = (dir: string): string => dir.replace(/[^A-Za-z0-9-]/g, '-')

// ---------- waiting ----------

// A coord hook's `waiting_since` is only a wait while nothing was written to the transcript after it, and only for
// WAIT_MAX_MS (a session that never cleared it must not show a dot forever).
export function hookWaiting(waitingSince: number | null, transcriptMtime: number | null, now: number): boolean {
  if (waitingSince === null || now - waitingSince >= WAIT_MAX_MS) return false
  return !(transcriptMtime !== null && transcriptMtime > waitingSince + WAIT_SKEW_MS)
}

export const isStuck = (startedAt: number, now: number, limit: number = WATCHDOG_MS): boolean => now - startedAt > limit

// ---------- this session's own pending calls ----------

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'parentAgentId'])

const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, stable(x)]))
      : v

// A call's arguments as one comparable string: a tool.call input without the engine's reserved keys, or a
// PermissionRequest's `tool_input`.
export function callSig(input: unknown, isToolCallInput = false): string {
  let o = input
  if (isToolCallInput && input !== null && typeof input === 'object') {
    o = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([k]) => !RESERVED.has(k)))
  }
  try {
    return JSON.stringify(stable(o)) ?? ''
  } catch {
    return ''
  }
}

export type InflightCall = { id: string; tool: string; sig: string; agentId?: string }

// PermissionRequest carries no tool_use_id, so the request is paired with a running tool.call of the same tool that is
// not already waiting: the one with the same arguments, else (several candidates) the newest, since the dialog
// belongs to a call that just started. `inflight` is in start order. null: no such call.
export function pairPermission(inflight: readonly InflightCall[], pending: readonly LiveCall[], tool: string, sig: string): InflightCall | null {
  const free = inflight.filter(c => c.tool === tool && !pending.some(p => p.id === c.id))
  return free.findLast(c => c.sig === sig) ?? free[free.length - 1] ?? null
}

export const ANON_PREFIX = 'anon-'
export const ANON_TURN_MS = 2 * 60_000 // at a main turn end, an unpaired entry older than this goes
export const ANON_MAX_MS = 3 * 60_000 // an unpaired entry never lives longer than this

const isAnon = (c: LiveCall): boolean => c.id.startsWith(ANON_PREFIX)

// The main turn ended: its own entries go, a subagent's stay (it may still be running), and an unpaired entry
// older than ANON_TURN_MS goes whoever made it.
export function settleTurn(pending: readonly LiveCall[], now: number): LiveCall[] {
  return pending.filter(c => c.agentId !== undefined && !(isAnon(c) && c.at !== undefined && now - c.at > ANON_TURN_MS))
}

export const settleInflight = (inflight: readonly InflightCall[]): InflightCall[] => inflight.filter(c => c.agentId !== undefined)

// A paired entry lives only while its call runs: one whose call is not in flight (a subagent's, orphaned by a reload)
// goes. An unpaired entry expires after ANON_MAX_MS, or as soon as no running call of its tool remains.
export function expirePending(pending: readonly LiveCall[], inflight: readonly InflightCall[], now: number): LiveCall[] {
  return pending.filter(c =>
    isAnon(c)
      ? (c.at === undefined || now - c.at <= ANON_MAX_MS) && inflight.some(i => i.tool === c.tool)
      : inflight.some(i => i.id === c.id),
  )
}

// What the session waits on now: a permission dialog first, then an AskUserQuestion, then a turn that ended on a question.
export function liveKind(pending: readonly LiveCall[], question: boolean): WaitKind | null {
  if (pending.some(p => p.kind === 'permission')) return 'permission'
  if (pending.some(p => p.kind === 'ask')) return 'ask'
  return question ? 'question' : null
}

// A PermissionRequest hook below us that already decided (allow or deny) means no dialog will open.
export const isDecided = (result: { decision?: unknown } | null | undefined): boolean =>
  result !== null && result !== undefined && result.decision !== undefined

export const dotOf = (waiting: WaitKind | null): { glyph: string; color: string | undefined; isDim: boolean } =>
  waiting === null
    ? { glyph: '\u25cb', color: undefined, isDim: true }
    : { glyph: '\u25cf', color: waiting === 'permission' ? 'error' : 'warning', isDim: false }

export const stateOf = (waiting: WaitKind | null, isBusy: boolean): SessionState =>
  waiting === 'permission' ? 'waiting' : waiting !== null ? 'asking' : isBusy ? 'busy' : 'idle'

// ---------- published pane files ----------

export type Published = {
  session_id: string
  name: string | null
  cwd: string | null
  model: string | null
  effort: string | null
  waiting: boolean
  waiting_kind: WaitKind | null
  busy: boolean
  /** Task progress of that session; absent from a record of an older version. */
  tasks?: TaskProgress | null
  updated_at: number
}

const KINDS: readonly string[] = ['permission', 'question', 'ask']

export function parsePublished(text: string): Published | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const id = str(r.session_id)
  if (id === null || typeof r.updated_at !== 'number' || !Number.isFinite(r.updated_at)) return null
  const kind = typeof r.waiting_kind === 'string' && KINDS.includes(r.waiting_kind) ? (r.waiting_kind as WaitKind) : null
  return {
    session_id: id,
    name: str(r.name),
    cwd: str(r.cwd),
    model: str(r.model),
    effort: str(r.effort),
    waiting: r.waiting === true,
    waiting_kind: kind,
    busy: r.busy === true,
    tasks: parseTasks(r.tasks),
    updated_at: r.updated_at,
  }
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null)

// A published `tasks` is trusted no further than its shape: two counts, done within total, a name that is a string.
function parseTasks(v: unknown): TaskProgress | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const done = count(r.done)
  const total = count(r.total)
  if (done === null || total === null || total === 0 || done > total) return null
  const name = str(r.activeName)
  const percent = count(r.percent)
  const out: TaskProgress = { done, total }
  if (name !== null) out.activeName = truncateChars(name, 80)
  if (percent !== null && percent <= 100) out.percent = percent
  return out
}

export type SelfLive = {
  id: string
  cwd: string
  model: string | null
  effort: string | null
  kind: WaitKind | null
  busy: boolean
  tasks?: TaskProgress | null
}

export const baseName = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function selfRecord(self: SelfLive, name: string, now: number): Published {
  return {
    session_id: self.id,
    name,
    cwd: self.cwd,
    model: self.model,
    effort: self.effort,
    waiting: self.kind !== null,
    waiting_kind: self.kind,
    busy: self.busy,
    tasks: self.tasks ?? null,
    updated_at: now,
  }
}

// ---------- merge ----------

export type PeerInfo = {
  waitingSince: number | null
  transcriptMtime: number | null
  stateMtime: number | null
  goal: GoalCount | null
}

export type MergeInput = {
  now: number
  registry: RegEntry[]
  published: Published[]
  peers: ReadonlyMap<string, PeerInfo>
  self: SelfLive | null
}

type Draft = {
  id: string
  name: string
  isSelf: boolean
  model: string | null
  effort: string | null
  live: { kind: WaitKind | null; busy: boolean } | null
  tasks: TaskProgress | null
}

// The meter of a row: the session's live task progress when it has a list that is still going, else its GOAL.md count,
// else nothing. A task list with every task done is a finished plan: the GOAL.md count (the longer job) wins then.
export function progressOf(tasks: TaskProgress | null, goal: GoalCount | null): RowProgress | null {
  const hasGoal = goal !== null && goal.total > 0
  if (tasks !== null && tasks.total > 0 && !(hasGoal && tasks.done >= tasks.total)) return { ...tasks, source: 'tasks' }
  if (goal !== null && goal.total > 0) return { done: goal.done, total: goal.total, source: 'goal' }
  if (tasks !== null && tasks.total > 0) return { ...tasks, source: 'tasks' }
  return null
}

const RANK: Record<SessionState, number> = { waiting: 0, asking: 1, busy: 2, idle: 3 }

// Union of the launcher registry and the live published files (hand-opened sessions), the live values winning
// over the launch values. A registry-only session counts while its transcript or hook state moved within
// ALIVE_MS, and is waiting when the coord hook says so.
export function mergeRows(i: MergeInput): SessionRow[] {
  const drafts = new Map<string, Draft>()
  for (const e of i.registry) {
    const key = e.sessionId ?? `reg:${e.id}`
    drafts.set(key, { id: key, name: e.name, isSelf: false, model: e.model, effort: e.effort, live: null, tasks: null })
  }
  const fromPublished = (p: Published, isSelf: boolean): void => {
    const cur = drafts.get(p.session_id)
    drafts.set(p.session_id, {
      id: p.session_id,
      name: cur?.name ?? p.name ?? (p.cwd ? baseName(p.cwd) : p.session_id.slice(0, 8)),
      isSelf,
      model: p.model ?? cur?.model ?? null,
      effort: p.effort ?? cur?.effort ?? null,
      live: { kind: p.waiting ? (p.waiting_kind ?? 'permission') : null, busy: p.busy },
      tasks: p.tasks ?? null,
    })
  }
  for (const p of i.published) {
    if (p.updated_at > 0 && i.now - p.updated_at <= FRESH_MS) fromPublished(p, false)
  }
  if (i.self) {
    fromPublished(selfRecord(i.self, baseName(i.self.cwd), i.now), true)
  }

  const rows: SessionRow[] = []
  for (const d of drafts.values()) {
    const peer = i.peers.get(d.id)
    let waiting: WaitKind | null
    let isBusy: boolean
    if (d.live) {
      waiting = d.live.kind
      isBusy = d.live.busy
    } else {
      if (!peer) continue
      const t = peer.transcriptMtime
      const s = peer.stateMtime
      const w = peer.waitingSince
      // waiting_since is deliberately not a sign of life: a stale one must not keep a dead session listed
      const latest = Math.max(t ?? 0, s ?? 0)
      if (latest === 0 || i.now - latest > ALIVE_MS) continue
      waiting = hookWaiting(w, t, i.now) ? 'permission' : null
      isBusy = t !== null && i.now - t <= BUSY_MS
    }
    rows.push({
      id: d.id,
      name: d.name,
      isSelf: d.isSelf || (i.self !== null && d.id === i.self.id),
      model: shortModel(d.model),
      effort: d.effort ?? '',
      state: stateOf(waiting, isBusy),
      waiting,
      goal: goalText(peer?.goal ?? null),
      progress: progressOf(d.tasks, peer?.goal ?? null),
    })
  }
  rows.sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name))
  return rows
}

export function summary(rows: readonly SessionRow[]): string {
  const waiting = rows.filter(r => r.waiting !== null).length
  const base = `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}`
  return waiting > 0 ? `${base} \u00b7 ${waiting} waiting` : base
}

// ---------- this session's own task list ----------

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

export const statusOf = (v: unknown): TaskItem['status'] =>
  v === 'completed' || v === 'done' ? 'completed' : v === 'in_progress' || v === 'active' ? 'in_progress' : 'pending'

// done/total of a list, and the name of the first task in progress; null for no list (nothing to show).
export function taskProgress(tasks: readonly TaskItem[] | null | undefined): TaskProgress | null {
  if (!tasks || tasks.length === 0) return null
  const done = tasks.filter(t => t.status === 'completed').length
  const active = tasks.find(t => t.status === 'in_progress')
  const out: TaskProgress = { done, total: tasks.length }
  if (active?.name !== undefined) out.activeName = active.name
  if (active?.percent !== undefined) out.percent = active.percent
  return out
}

// The whole list a TodoWrite call carries.
export function tasksFromTodos(input: unknown): TaskItem[] | undefined {
  const todos = rec(input)?.todos
  if (!Array.isArray(todos)) return undefined
  return todos.map((t, i) => {
    const r = rec(t)
    const status = statusOf(r?.status)
    const name = status === 'in_progress' ? (text(r?.activeForm) ?? text(r?.content)) : text(r?.content)
    return name === undefined ? { id: `todo-${i}`, status } : { id: `todo-${i}`, name, status }
  })
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
    const id = text(rec(rec(result)?.task)?.id) ?? `task-${list.length + 1}`
    const name = text(rec(input)?.subject)
    return [...list.filter(t => t.id !== id), name === undefined ? { id, status: 'pending' } : { id, name, status: 'pending' }]
  }
  if (tool === 'TaskUpdate') {
    const id = text(rec(input)?.taskId)
    if (id === undefined) return tasks === null ? null : list
    const status = text(rec(input)?.status)
    if (status === 'deleted') return list.filter(t => t.id !== id)
    const subject = text(rec(input)?.subject)
    const active = text(rec(input)?.activeForm)
    if (status === undefined && subject === undefined) return tasks === null ? null : list
    if (list.some(t => t.id === id)) {
      return list.map(t =>
        t.id === id ? { ...t, ...(status === undefined ? {} : { status: statusOf(status) }), ...(subject === undefined ? {} : { name: subject }) } : t,
      )
    }
    const name = active ?? subject
    return [...list, name === undefined ? { id, status: statusOf(status) } : { id, name, status: statusOf(status) }]
  }
  return tasks === null ? null : list
}

// The Clean View tools (exact names; an MCP prefix is harmless): `plan_steps({ steps: string[] })` declares 2-8 step
// names in order, the first active; `report_progress({ task, percent })` reports the percent (clamped 0-100) of one
// step. Reporting a planned step checks off every step before it; 100 checks the step off and starts the next; a name
// not in the plan becomes a new step.
export const isPlanTool = (tool: string): boolean => /(^|__)plan_steps$/.test(tool)
export const isReportTool = (tool: string): boolean => /(^|__)report_progress$/.test(tool)
export const isTaskTool = (tool: string): boolean =>
  tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate' || isPlanTool(tool) || isReportTool(tool)

export const MAX_PLAN_STEPS = 8

// Step names compared the way Clean View compares them: case, spacing and punctuation do not matter.
export const normName = (v: string): string => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function applyPlanCall(tasks: readonly TaskItem[] | null, tool: string, input: unknown): TaskItem[] | null {
  const o = rec(input)
  if (isPlanTool(tool)) {
    const steps = o?.steps
    if (!Array.isArray(steps)) return tasks === null ? null : [...tasks]
    const names = steps.map(text).filter((n): n is string => n !== undefined).slice(0, MAX_PLAN_STEPS)
    if (names.length === 0) return tasks === null ? null : [...tasks]
    return names.map((name, i): TaskItem => ({ id: `step-${i + 1}`, name, status: i === 0 ? 'in_progress' : 'pending' }))
  }
  if (isReportTool(tool)) {
    const task = text(o?.task)
    const raw = typeof o?.percent === 'number' && Number.isFinite(o.percent) ? o.percent : undefined
    if (task === undefined || raw === undefined) return tasks === null ? null : [...tasks]
    const percent = Math.round(Math.max(0, Math.min(100, raw)))
    const strip = (t: TaskItem): TaskItem => {
      const { percent: _drop, ...rest } = t
      return rest
    }
    let list: TaskItem[] = tasks === null ? [] : tasks.map(t => ({ ...t }))
    const want = normName(task)
    let idx = want === '' ? -1 : list.findIndex(t => t.name !== undefined && normName(t.name) === want)
    if (idx < 0) {
      // A name outside the plan is a new last step: only the step in progress is finished, the planned ones stay.
      list = list.map((t): TaskItem => (t.status === 'in_progress' ? { ...strip(t), status: 'completed' } : t))
      list.push({ id: `step-${list.length + 1}`, name: task, status: 'pending' })
      idx = list.length - 1
      const out = list.map((t, i): TaskItem => (i === idx ? (percent >= 100 ? { ...strip(t), status: 'completed' } : { ...strip(t), status: 'in_progress', percent }) : t))
      return out
    }
    const out = list.map((t, i): TaskItem => {
      if (i < idx) return { ...strip(t), status: 'completed' }
      if (i === idx) return percent >= 100 ? { ...strip(t), status: 'completed' } : { ...strip(t), status: 'in_progress', percent }
      return t.status === 'completed' ? strip(t) : { ...strip(t), status: 'pending' }
    })
    if (percent >= 100) {
      const next = out.findIndex((t, i) => i > idx && t.status !== 'completed')
      if (next >= 0) out[next] = { ...out[next]!, status: 'in_progress' }
    }
    return out
  }
  return tasks === null ? null : [...tasks]
}

// Clean View keeps its checklist in `$.state` (plugin `clean-view`, key `checklist`); any plugin may read it. Its tasks
// are `{ status: 'done' | 'active' | 'upcoming', percent, hasReported }`. A plan counts once `hasPlan` is set, and only
// while the checklist is live: its phase is not `idle` (a finished job, phase `done`, still counts until the next job).
// The active step's percent counts only once Claude reported one. null: not loaded, idle, no plan, or not a checklist.
export function progressFromChecklist(v: unknown): TaskProgress | null {
  const cl = rec(v)
  if (cl === undefined || cl.phase === 'idle' || cl.hasPlan !== true || !Array.isArray(cl.tasks) || cl.tasks.length === 0) return null
  let done = 0
  let activeName: string | undefined
  let percent: number | undefined
  for (const t of cl.tasks) {
    const r = rec(t)
    if (r === undefined) return null
    if (r.status === 'done') done += 1
    else if (r.status === 'active' && activeName === undefined) {
      activeName = text(r.name)
      if (r.hasReported === true && typeof r.percent === 'number' && Number.isFinite(r.percent)) percent = Math.max(0, Math.min(100, Math.round(r.percent)))
    }
  }
  const out: TaskProgress = { done, total: cl.tasks.length }
  if (activeName !== undefined) out.activeName = truncateChars(activeName, 80)
  if (percent !== undefined) out.percent = percent
  return out
}

// One finished tool call of the main loop, folded into the task list.
export function applyAnyTaskCall(tasks: readonly TaskItem[] | null, tool: string, input: unknown, result: unknown): TaskItem[] | null {
  if (tool === 'TodoWrite') return tasksFromTodos(input) ?? (tasks === null ? null : [...tasks])
  if (tool === 'TaskCreate' || tool === 'TaskUpdate') return applyTaskCall(tasks, tool, input, result)
  return applyPlanCall(tasks, tool, input)
}

// ---------- colours: theme tokens, so the pane follows the person's theme (the Warm theme maps them to amber) ----------

export const TONE = {
  title: 'claude', // header and the current-session mark
  meter: 'suggestion', // the filled part of a meter
  track: 'subtle', // the empty part
  name: 'text', // names
  dim: 'inactive', // dim text
} as const

// ---------- the meter ----------

// `███████░░░`: the filled and the empty cells of `done` of `total` in `cells` cells. Never full before done, never
// empty once something is done.
export function meterCells(done: number, total: number, cells: number): { filled: number; empty: number } {
  const w = Math.max(1, Math.floor(cells))
  if (total <= 0 || done <= 0) return { filled: 0, empty: w }
  if (done >= total) return { filled: w, empty: 0 }
  const filled = Math.min(w - 1, Math.max(1, Math.round((done / total) * w)))
  return { filled, empty: w - filled }
}

// What the meter fills to: the done steps plus the active step's percent (the label stays done/total).
export const meterFill = (p: RowProgress): number => Math.min(p.total, p.done + (p.percent ?? 0) / 100)

export const progressLabel = (p: RowProgress): string => `${p.done}/${p.total}`

// ---------- the band button ----------

export const BAND_KEY = 'sessions'

// `◆ Sessions 3 · 1 waiting`; `◆ Sessions` while the count is unknown.
export function bandLabel(rows: readonly SessionRow[]): string {
  if (rows.length === 0) return '◆ Sessions'
  const waiting = rows.filter(r => r.waiting !== null).length
  return waiting > 0 ? `◆ Sessions ${rows.length} · ${waiting} waiting` : `◆ Sessions ${rows.length}`
}

// What a press of the band button does: open a closed pane; close an open one unless it is locked.
export const bandPressAction = (isOpen: boolean, isLocked: boolean): 'open' | 'close' | 'locked' => (!isOpen ? 'open' : isLocked ? 'locked' : 'close')

// ---------- layout ----------

export type Layout = {
  showModel: boolean
  showMeter: boolean
  /** 10, or 5 when the width is short; the label (`7/10`) follows it. */
  meterCells: number
  nameW: number
  modelW: number
  stateW: number
  /** Width of the whole meter column: the cells, a space and the label. */
  meterW: number
  labelW: number
}

const STATE_W = 7
const MIN_NAME = 10
const MAX_NAME = 30
export const METER_CELLS = 10
export const METER_CELLS_SHORT = 5

export const rowModelEffort = (r: SessionRow): string => modelEffort(r.model, r.effort)

// Drops columns before anything wraps: the meter first (10 cells, then 5, then gone), then model·effort; the name
// takes what is left. dot and the "current" mark are 1 cell each; columns are separated by one cell. With no row
// holding progress there is no meter column at all.
export function layoutColumns(width: number, rows: readonly SessionRow[]): Layout {
  const maxOf = (f: (r: SessionRow) => string, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, ...rows.map(r => charLength(f(r)))))
  const modelW = maxOf(rowModelEffort, 6, 20)
  const labelW = maxOf(r => (r.progress ? progressLabel(r.progress) : ''), 3, 9)
  const nameNat = maxOf(r => r.name, 6, MAX_NAME)
  const hasMeter = rows.some(r => r.progress !== null)
  const w = Math.max(1, Math.floor(width))
  // cells besides the name for a set of optional columns: dot, mark, state, then the optionals; one gap between each
  const fixed = (model: boolean, cells: number): number => {
    const meterW = cells > 0 ? cells + 1 + labelW : 0
    const cols = 3 + (model ? 1 : 0) + (cells > 0 ? 1 : 0) + 1 // + the name
    return 1 + 1 + STATE_W + (model ? modelW : 0) + meterW + (cols - 1)
  }
  const options: Array<[boolean, number]> = [
    [true, METER_CELLS],
    [true, METER_CELLS_SHORT],
    [true, 0],
    [false, 0],
  ]
  const build = (showModel: boolean, cells: number, nameW: number): Layout => ({
    showModel,
    showMeter: cells > 0,
    meterCells: cells > 0 ? cells : METER_CELLS,
    nameW,
    modelW,
    stateW: STATE_W,
    meterW: cells + 1 + labelW,
    labelW,
  })
  for (const [showModel, cells] of options) {
    if (cells > 0 && !hasMeter) continue
    const room = w - fixed(showModel, cells)
    if (room >= MIN_NAME) return build(showModel, cells, Math.min(nameNat, room))
  }
  return build(false, 0, Math.max(1, w - fixed(false, 0)))
}

// ---------- lock ----------

export const LOCK_KEY = 'locked'

// What a person's close of the pane does: refused while locked; every other origin passes.
export const refusesClose = (isLocked: boolean, origin: 'plugin' | 'person' | 'unload'): boolean =>
  isLocked && origin === 'person'

export type SessionsCommand = 'toggle' | 'lock' | 'unlock' | 'theme' | 'unknown'

export function parseCommand(args: string): SessionsCommand {
  const a = args.trim().toLowerCase()
  if (a === '') return 'toggle'
  if (a === 'lock') return 'lock'
  if (a === 'unlock') return 'unlock'
  if (a === 'theme') return 'theme'
  return 'unknown'
}

// ---------- the warm theme ----------

export const THEME_KEY = 'themeOffered' // a $.store flag: the theme was offered once, never again on its own
export const THEME_ROW = 'theme' // the /config row that holds the theme

// The option of the theme row that is this mod's own Warm theme: the name `Warm`, optionally behind `custom:` and this
// plugin's name, matched whole (ignoring case). Any other option, a lookalike included, is not it.
export function findWarm(options: readonly string[] | undefined): string | undefined {
  return options?.find(o => /^(custom:)?(sessions-pane[:/])?warm$/i.test(o.trim()))
}

// The default theme, which the offer may replace on its own; any other value is a choice the person made.
export const isDefaultTheme = (value: unknown): boolean => value === undefined || value === null || value === '' || value === 'dark'

export const THEME_TOAST_ON = 'Warm theme on (change in /theme)'
export const THEME_TOAST_PICK = "Pick 'Warm' in /theme for the warm look"
