// Pure logic of the sessions pane: no `$`, no I/O, so it is unit-tested directly.
import type { AgentEntry, LiveCall, RowProgress, SessionRow, SessionState, TaskItem, TaskProgress, WaitKind } from '../types'
import { PLUGIN_NAME, OLD_PLUGIN_NAME, charLength } from './model'

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

// Phrases that ask for an approval or a decision even without a question mark (matched as whole words, any case).
export const ASK_PHRASES: readonly string[] = [
  'if you approve',
  'let me know',
  'say go',
  'say the word',
  'please confirm',
  'waiting for your',
  'once you confirm',
  'shall I',
  'shall we',
  'should I',
  'should we',
  'can I proceed',
  'ok to proceed',
  'do you want',
  'want me to',
  'would you like',
  'תאשר',
  'האם להמשיך',
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A Hebrew phrase may carry the prefix ו, ש or כש ("and", "that", "when").
const askPattern = (p: string): string =>
  `${/^[\u05d0-\u05ea]/.test(p) ? '(?:\u05db\u05e9|\u05d5|\u05e9){0,2}' : ''}${escapeRe(p).replace(/\s+/g, '\\s+')}`

const ASK_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${ASK_PHRASES.map(askPattern).join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
)

// A `?` counts when it ends something: followed by whitespace, a closer or the end (so `/api?limit=1` and `a?.b` do not).
const QUESTION_MARK = /\?(?=[!\s)\]}>"'`*_~”’»]|$)|？/u

// True when the closing part of the message asks something: it holds a sentence ending in `?` (or the full-width one)
// or an approval phrase (ASK_PHRASES). The closing part is the last paragraph or the last 3 sentences, whichever is
// longer. A `?` inside a code fence, a code span or a URL does not count; a question only earlier in the message
// (before the closing part) does not count.
export function endsWithQuestion(text: string | null | undefined): boolean {
  if (!text) return false
  // Code and URLs go first, on the whole text (a cut inside a fence would flip it); then only the end matters, and a
  // long run of marks must not make the matching slow.
  const plain = text
    .replace(/[.!?,:;]{20,}/g, (m) => m.slice(-3))
    .replace(/\r\n?/g, '\n')
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1[`~]*|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/(?:https?:\/\/|www\.)[^\s)\]>"']*?(?=[?.,!:;]*(?:[\s)\]>"']|$))/gi, ' ')
    .slice(-20000)
    .replace(/[.!?]{20,}/g, (m) => m.slice(-3))
    .trim()
  if (!plain) return false
  const paragraph = (plain.split(/\n[ \t]*\n/).pop() ?? plain).trim()
  // A sentence ends at . ! ? followed by whitespace, a closer or the end of the text; CJK marks end one anywhere.
  const sentences = [
    ...plain.matchAll(
      /[\s\S]*?(?:[.!?]+(?=[\s)\]}>"'`*_~”’»]|$)|[。？！]+|$)/gu,
    ),
  ].filter((m) => m[0].trim())
  const from = sentences.length > 3 ? (sentences[sentences.length - 3].index ?? 0) : 0
  const lastSentences = plain.slice(from).trim()
  const closing = paragraph.length >= lastSentences.length ? paragraph : lastSentences
  return QUESTION_MARK.test(closing) || ASK_RE.test(closing)
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

// The main session's own state first (waiting, asking, busy); only an idle main session with subagents running reads
// `agents`, so both facts stay visible: the word is the main session, the agents column the subagents.
export const stateOf = (waiting: WaitKind | null, isBusy: boolean, agents = 0): SessionState =>
  waiting === 'permission' ? 'waiting' : waiting !== null ? 'asking' : isBusy ? 'busy' : agents > 0 ? 'agents' : 'idle'

// ---------- running subagents of this session ----------

export const MAX_AGENT_LIST = 12 // entries published per session
export const AGENT_TEXT = 40 // characters kept of a name, model or effort

// What `$.agent.list()` gives per agent, as far as this reads it.
export type AgentLike = { id: string; description?: string; type?: string; status: string }
export type AgentNote = { model?: string; effort?: string; /** when it was last noted (ms), so a note is not pruned the moment it is made */ at?: number }
export const NOTE_GRACE_MS = 5000 // a note this young stays even if the list does not show its agent yet

// A loop that still counts: not started yet, running, or held on background work. Idle (between turns) and the ended
// statuses do not.
const RUNNING = new Set(['pending', 'running', 'waiting'])

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// An agent type's effort when no step of it reported one: `worker-<level>` is that level, `explorer` is medium.
export function effortFromType(type: string | undefined): string {
  const t = (type ?? '').replace(/^.*:/, '')
  const m = /^worker-(\w+)$/.exec(t)
  if (m && EFFORTS.includes(m[1] as string)) return m[1] as string
  return t === 'explorer' ? 'medium' : '?'
}

// What the engine told us about a running agent's loop: its model (the resolved id from agent.spawn, or a turn.step's) and
// effort (a turn.step's). An empty value changes nothing.
export function noteAgent(notes: Map<string, AgentNote>, id: string, patch: AgentNote): void {
  if (id === '') return
  const next: AgentNote = { ...(notes.get(id) ?? {}) }
  if (patch.model !== undefined && patch.model !== '') next.model = patch.model
  if (patch.effort !== undefined && patch.effort !== '') next.effort = patch.effort
  if (patch.at !== undefined) next.at = patch.at
  notes.set(id, next)
}

// The agents of the engine's list that are running, one entry each (an id twice counts once), with the model and effort
// noted for it. The count of running agents is the length: it is the engine's own list, so it cannot drift and never
// goes negative.
export function agentEntries(list: readonly AgentLike[] | null | undefined, notes: ReadonlyMap<string, AgentNote>): AgentEntry[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: AgentEntry[] = []
  for (const a of list) {
    if (a === null || typeof a !== 'object' || typeof a.id !== 'string' || !RUNNING.has(a.status) || seen.has(a.id)) continue
    seen.add(a.id)
    const note = notes.get(a.id)
    const name = (typeof a.description === 'string' && a.description.trim() !== '' ? a.description.trim() : undefined) ?? (typeof a.type === 'string' && a.type !== '' ? a.type : 'agent')
    out.push({
      name: truncateChars(name, AGENT_TEXT),
      model: truncateChars(note?.model ? shortModel(note.model) : '?', AGENT_TEXT),
      effort: truncateChars(note?.effort ?? effortFromType(a.type), AGENT_TEXT),
    })
  }
  return out
}

// Notes of agents the engine no longer lists are dropped, but only once they are older than NOTE_GRACE_MS: a refresh that
// races a spawn (the list was read before the agent showed in it) must not lose the model just noted. A /clear or a
// session end empties them.
export function pruneAgentNotes(notes: Map<string, AgentNote>, list: readonly AgentLike[] | null | undefined, now: number): void {
  const ids = new Set(Array.isArray(list) ? list.map(a => a.id) : [])
  for (const [id, note] of [...notes]) if (!ids.has(id) && (note.at === undefined || now - note.at > NOTE_GRACE_MS)) notes.delete(id)
}

// ` · 2 agents` for the Session Viewer button; nothing for none.
export const agentsSuffix = (rows: readonly SessionRow[]): string => {
  const total = rows.reduce((n, r) => n + (r.agents ?? 0), 0)
  return total > 0 ? ` \u00b7 ${total} ${total === 1 ? 'agent' : 'agents'}` : ''
}

// The agents column of a row: `⧉ 2`; nothing for none; `-` for an unknown count.
export const agentsText = (r: SessionRow): string => (r.agents == null ? '-' : r.agents > 0 ? `\u29c9 ${r.agents}` : '')

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
  /** Running subagents; absent from a record of an older version or when unknown. */
  agents?: number
  /** Their name, model and effort (at most 12); absent when not published. */
  agentList?: AgentEntry[]
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
  const agents = count(r.agents)
  const agentList = parseAgentList(r.agentList)
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
    ...(agents === null ? {} : { agents }),
    ...(agentList === null ? {} : { agentList }),
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

// A published `agentList` is trusted no further than its shape: an array, entries of three strings (cut to 40 characters),
// at most 12. Anything else is absent.
function parseAgentList(v: unknown): AgentEntry[] | null {
  if (!Array.isArray(v)) return null
  const out: AgentEntry[] = []
  for (const item of v) {
    if (out.length >= MAX_AGENT_LIST) break
    const r = rec(item)
    const name = str(r?.name)
    const model = str(r?.model)
    const effort = str(r?.effort)
    if (name === null || model === null || effort === null) continue
    out.push({ name: truncateChars(name, AGENT_TEXT), model: truncateChars(model, AGENT_TEXT), effort: truncateChars(effort, AGENT_TEXT) })
  }
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
  /** The running subagents of this session; null or absent: not known (the list could not be read). */
  agents?: AgentEntry[] | null
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
    ...(self.agents == null
      ? {}
      : {
          agents: self.agents.length,
          agentList: self.agents.slice(0, MAX_AGENT_LIST).map(a => ({ name: truncateChars(a.name, AGENT_TEXT), model: truncateChars(a.model, AGENT_TEXT), effort: truncateChars(a.effort, AGENT_TEXT) })),
        }),
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
  agents: number | null
  agentList: AgentEntry[] | null
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

// waiting > asking > busy > agents running > idle
const RANK: Record<SessionState, number> = { waiting: 0, asking: 1, busy: 2, agents: 3, idle: 4 }

// Union of the launcher registry and the live published files (hand-opened sessions), the live values winning
// over the launch values. A registry-only session counts while its transcript or hook state moved within
// ALIVE_MS, and is waiting when the coord hook says so.
export function mergeRows(i: MergeInput): SessionRow[] {
  const drafts = new Map<string, Draft>()
  for (const e of i.registry) {
    const key = e.sessionId ?? `reg:${e.id}`
    drafts.set(key, { id: key, name: e.name, isSelf: false, model: e.model, effort: e.effort, live: null, tasks: null, agents: null, agentList: null })
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
      agents: p.agents ?? null,
      agentList: p.agentList ?? null,
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
      state: stateOf(waiting, isBusy, d.agents ?? 0),
      waiting,
      goal: goalText(peer?.goal ?? null),
      progress: progressOf(d.tasks, peer?.goal ?? null),
      agents: d.agents,
      agentList: d.agentList,
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

// The own task list follows the main loop's TodoWrite and TaskCreate/TaskUpdate. It is the fallback progress source: with
// Clean View on, its checklist (the same plugin's `checklist` atom) already follows those calls and plan_steps /
// report_progress, and is read first.
export const isTaskTool = (tool: string): boolean => tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate'

// The checklist of this plugin's Clean View feature (the `checklist` atom). Its tasks
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
  return tasks === null ? null : [...tasks]
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
  /** The agents column (`⧉ 2`, after the state word): shown only while a session has agents running. */
  showAgents: boolean
  agentsW: number
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

// Drops columns before anything wraps: the meter first (10 cells, then 5, then gone), then the agents column, then
// model·effort; the name takes what is left. dot and the "current" mark are 1 cell each; columns are separated by one cell. With no row
// holding progress there is no meter column at all.
export function layoutColumns(width: number, rows: readonly SessionRow[]): Layout {
  const maxOf = (f: (r: SessionRow) => string, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, ...rows.map(r => charLength(f(r)))))
  const modelW = maxOf(rowModelEffort, 6, 20)
  const labelW = maxOf(r => (r.progress ? progressLabel(r.progress) : ''), 3, 9)
  const nameNat = maxOf(r => r.name, 6, MAX_NAME)
  const hasMeter = rows.some(r => r.progress !== null)
  const hasAgents = rows.some(r => (r.agents ?? 0) > 0)
  const agentsW = maxOf(agentsText, 3, 9)
  const w = Math.max(1, Math.floor(width))
  // cells besides the name for a set of optional columns: dot, mark, state, then the optionals; one gap between each
  const fixed = (model: boolean, cells: number, agents: boolean): number => {
    const meterW = cells > 0 ? cells + 1 + labelW : 0
    const cols = 3 + (model ? 1 : 0) + (cells > 0 ? 1 : 0) + (agents ? 1 : 0) + 1 // + the name
    return 1 + 1 + STATE_W + (model ? modelW : 0) + meterW + (agents ? agentsW : 0) + (cols - 1)
  }
  const options: Array<[boolean, number, boolean]> = [
    [true, METER_CELLS, hasAgents],
    [true, METER_CELLS_SHORT, hasAgents],
    [true, 0, hasAgents],
    [true, 0, false],
    [false, 0, false],
  ]
  const build = (showModel: boolean, cells: number, agents: boolean, nameW: number): Layout => ({
    showModel,
    showMeter: cells > 0,
    showAgents: agents,
    agentsW,
    meterCells: cells > 0 ? cells : METER_CELLS,
    nameW,
    modelW,
    stateW: STATE_W,
    meterW: cells + 1 + labelW,
    labelW,
  })
  for (const [showModel, cells, agents] of options) {
    if (cells > 0 && !hasMeter) continue
    const room = w - fixed(showModel, cells, agents)
    if (room >= MIN_NAME) return build(showModel, cells, agents, Math.min(nameNat, room))
  }
  return build(false, 0, false, Math.max(1, w - fixed(false, 0, false)))
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
  if (a === 'theme' || a === 'theme warm' || a === 'theme dark') return 'theme'
  return 'unknown'
}

// Which theme `/sessions theme [dark|warm]` asks for: Clean View Dark unless `warm` is named.
export const themeArg = (args: string): ThemeName => (args.trim().toLowerCase() === 'theme warm' ? 'warm' : 'dark')

// ---------- the themes: Clean View Dark (the first offer) and Warm ----------

export type ThemeName = 'dark' | 'warm'

export const THEME_KEY = 'themeOffered' // a $.store flag: the theme was offered once, never again on its own
export const THEME_ROW = 'theme' // the /config row that holds the theme

// The option of the theme row that is one of this mod's own themes: the file name (`clean-view`, `warm`) or the display
// name of Clean View Dark, optionally behind `custom:` and this plugin's name (Warm also behind the name of the
// sessions-pane mod it replaces), matched whole (ignoring case). Any other option, a lookalike included, is not it.
const WARM = new RegExp(`^(custom:)?((?:${PLUGIN_NAME}|${OLD_PLUGIN_NAME})[:/])?warm$`, 'i')
const CLEAN_DARK = new RegExp(`^(custom:)?(${PLUGIN_NAME}[:/])?(clean-view|clean view dark)$`, 'i')
export function findWarm(options: readonly string[] | undefined): string | undefined {
  return options?.find(o => WARM.test(o.trim()))
}
export function findCleanDark(options: readonly string[] | undefined): string | undefined {
  return options?.find(o => CLEAN_DARK.test(o.trim()))
}
export const findTheme = (name: ThemeName, options: readonly string[] | undefined): string | undefined => (name === 'warm' ? findWarm(options) : findCleanDark(options))
export const themeLabel = (name: ThemeName): string => (name === 'warm' ? 'Warm' : 'Clean View Dark')

// The default theme, which the offer may replace on its own; any other value is a choice the person made.
export const isDefaultTheme = (value: unknown): boolean => value === undefined || value === null || value === '' || value === 'dark'

export const themeToastOn = (name: ThemeName): string => `${themeLabel(name)} theme on (change in /theme)`
export const themeToastIs = (name: ThemeName): string => `${themeLabel(name)} theme is on (change in /theme)`
export const themeToastPick = (name: ThemeName): string => (name === 'warm' ? "Pick 'Warm' in /theme for the warm look" : "Pick 'Clean View Dark' in /theme for the clean look")
