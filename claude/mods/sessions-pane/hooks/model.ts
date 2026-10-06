// Pure logic of the sessions pane: no `$`, no I/O, so it is unit-tested directly.
import type { LiveCall, SessionRow, SessionState, WaitKind } from '../types'

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
    updated_at: r.updated_at,
  }
}

export type SelfLive = {
  id: string
  cwd: string
  model: string | null
  effort: string | null
  kind: WaitKind | null
  busy: boolean
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
}

const RANK: Record<SessionState, number> = { waiting: 0, asking: 1, busy: 2, idle: 3 }

// Union of the launcher registry and the live published files (hand-opened sessions), the live values winning
// over the launch values. A registry-only session counts while its transcript or hook state moved within
// ALIVE_MS, and is waiting when the coord hook says so.
export function mergeRows(i: MergeInput): SessionRow[] {
  const drafts = new Map<string, Draft>()
  for (const e of i.registry) {
    const key = e.sessionId ?? `reg:${e.id}`
    drafts.set(key, { id: key, name: e.name, isSelf: false, model: e.model, effort: e.effort, live: null })
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

// ---------- layout ----------

export type Layout = {
  showModel: boolean
  showGoal: boolean
  nameW: number
  modelW: number
  stateW: number
  goalW: number
}

const STATE_W = 7
const MIN_NAME = 10
const MAX_NAME = 30

export const rowModelEffort = (r: SessionRow): string => modelEffort(r.model, r.effort)

// Drops columns before anything wraps: the goal first, then model·effort; the name takes what is left.
// dot and the "current" mark are 1 cell each; columns are separated by one cell.
export function layoutColumns(width: number, rows: readonly SessionRow[]): Layout {
  const maxOf = (f: (r: SessionRow) => string, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, ...rows.map(r => charLength(f(r)))))
  const modelW = maxOf(rowModelEffort, 6, 20)
  const goalW = maxOf(r => r.goal ?? '-', 3, 7)
  const nameNat = maxOf(r => r.name, 6, MAX_NAME)
  const w = Math.max(1, Math.floor(width))
  // cells besides the name for a set of optional columns: dot, mark, state, then the optionals; one gap between each
  const fixed = (model: boolean, goal: boolean): number => {
    const cols = 3 + (model ? 1 : 0) + (goal ? 1 : 0) + 1 // + the name
    return 1 + 1 + STATE_W + (model ? modelW : 0) + (goal ? goalW : 0) + (cols - 1)
  }
  const options: Array<[boolean, boolean]> = [
    [true, true],
    [true, false],
    [false, false],
  ]
  for (const [showModel, showGoal] of options) {
    const room = w - fixed(showModel, showGoal)
    if (room >= MIN_NAME) {
      return { showModel, showGoal, nameW: Math.min(nameNat, room), modelW, stateW: STATE_W, goalW }
    }
  }
  return { showModel: false, showGoal: false, nameW: Math.max(1, w - fixed(false, false)), modelW, stateW: STATE_W, goalW }
}

// ---------- lock ----------

export const LOCK_KEY = 'locked'

// What a person's close of the pane does: refused while locked; every other origin passes.
export const refusesClose = (isLocked: boolean, origin: 'plugin' | 'person' | 'unload'): boolean =>
  isLocked && origin === 'person'

export type SessionsCommand = 'toggle' | 'lock' | 'unlock' | 'unknown'

export function parseCommand(args: string): SessionsCommand {
  const a = args.trim().toLowerCase()
  if (a === '') return 'toggle'
  if (a === 'lock') return 'lock'
  if (a === 'unlock') return 'unlock'
  return 'unknown'
}
