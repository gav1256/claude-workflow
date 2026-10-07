// The file reads and the one write of the sessions pane, through `$.fs`. Cheap by construction: every read is
// guarded by a stat (4 MiB cap, mtime caches) and any failure means "no data", never an error.

import type { SessionRow } from '../types'
import {
  FRESH_MS,
  MAX_READ_BYTES,
  SAFE_ID,
  countGoal,
  mergeRows,
  parsePublished,
  parseRegistry,
  projectKey,
} from './model-sessions'
import type { Dirs, GoalCount, PeerInfo, Published, RegEntry, SelfLive } from './model-sessions'
import { parsePace } from './model-usage'
import type { Usage } from './model-usage'

// The file-system calls the pane needs, as plain functions: register.tsx builds one over `$.fs`, tests pass a fake.
export type Fs = {
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<Array<{ name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>>
  write: (path: string, text: string) => Promise<void>
}


async function statOrNull(fs: Fs, path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await fs.stat(path)
    return s.kind === 'file' ? { size: s.size, mtimeMs: s.mtimeMs } : null
  } catch {
    return null
  }
}

async function readSmall(fs: Fs, path: string): Promise<string | null> {
  const s = await statOrNull(fs, path)
  if (s === null || s.size > MAX_READ_BYTES) return null
  try {
    return await fs.read(path)
  } catch {
    return null
  }
}

// The registry is re-read only when its size or mtime changed; over 4 MiB it is skipped (the last good list stays).
let registryCache: { size: number; mtimeMs: number; entries: RegEntry[] } | null = null

export async function loadRegistry(fs: Fs, dirs: Dirs): Promise<RegEntry[]> {
  const s = await statOrNull(fs, dirs.registry)
  if (s === null) return []
  if (s.size > MAX_READ_BYTES) return registryCache?.entries ?? []
  if (registryCache && registryCache.size === s.size && registryCache.mtimeMs === s.mtimeMs) return registryCache.entries
  try {
    const entries = parseRegistry(await fs.read(dirs.registry))
    registryCache = { size: s.size, mtimeMs: s.mtimeMs, entries }
    return entries
  } catch {
    return registryCache?.entries ?? []
  }
}

// pace.json (the usage pacer's file; read only): re-read only when its size or mtime changed. The staleness check (15 min)
// runs on every call, since the same bytes age. Absent, over 4 MiB, malformed or stale is null.
let paceCache: { size: number; mtimeMs: number; text: string } | null = null

export async function loadUsage(fs: Fs, dirs: Dirs, now: number): Promise<Usage | null> {
  const path = `${dirs.coord}/pace.json`
  const s = await statOrNull(fs, path)
  if (s === null || s.size > MAX_READ_BYTES) {
    paceCache = null
    return null
  }
  if (!(paceCache && paceCache.size === s.size && paceCache.mtimeMs === s.mtimeMs)) {
    let text: string
    try {
      text = await fs.read(path)
    } catch {
      paceCache = null // a failed read is not remembered: the next refresh reads again
      return null
    }
    paceCache = { size: s.size, mtimeMs: s.mtimeMs, text }
  }
  return parsePace(paceCache.text, s.mtimeMs, now)
}

type HookState = { waitingSince: number | null; goalPath: string | null; mtimeMs: number | null }

async function loadHookState(fs: Fs, dirs: Dirs, sessionId: string): Promise<HookState> {
  const none: HookState = { waitingSince: null, goalPath: null, mtimeMs: null }
  if (!SAFE_ID.test(sessionId)) return none
  const path = `${dirs.coord}/sessions/${sessionId}.json`
  const s = await statOrNull(fs, path)
  if (s === null) return none
  const text = await readSmall(fs, path)
  if (text === null) return { ...none, mtimeMs: s.mtimeMs }
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    const ws = typeof o.waiting_since === 'string' ? Date.parse(o.waiting_since) : typeof o.waiting_since === 'number' ? o.waiting_since : NaN
    return {
      waitingSince: Number.isFinite(ws) ? ws : null,
      goalPath: typeof o.goal_path === 'string' && o.goal_path !== '' ? o.goal_path : null,
      mtimeMs: s.mtimeMs,
    }
  } catch {
    return { ...none, mtimeMs: s.mtimeMs }
  }
}

const goalCache = new Map<string, { mtimeMs: number; goal: GoalCount | null }>()

export function resetCaches(): void {
  registryCache = null
  paceCache = null
  goalCache.clear()
}

async function loadGoal(fs: Fs, goalPath: string | null): Promise<GoalCount | null> {
  if (goalPath === null) return null
  const s = await statOrNull(fs, goalPath)
  if (s === null) return null
  const hit = goalCache.get(goalPath)
  if (hit && hit.mtimeMs === s.mtimeMs) return hit.goal
  const text = await readSmall(fs, goalPath)
  const goal = text === null ? null : countGoal(text)
  goalCache.set(goalPath, { mtimeMs: s.mtimeMs, goal })
  return goal
}

async function transcriptMtime(fs: Fs, dirs: Dirs, worktree: string | null, sessionId: string | null): Promise<number | null> {
  if (worktree === null || sessionId === null || !SAFE_ID.test(sessionId)) return null
  return (await statOrNull(fs, `${dirs.projects}/${projectKey(worktree)}/${sessionId}.jsonl`))?.mtimeMs ?? null
}

async function loadPublished(fs: Fs, dirs: Dirs, now: number): Promise<Published[]> {
  let names: Awaited<ReturnType<Fs['list']>>
  try {
    names = await fs.list(dirs.pane)
  } catch {
    return []
  }
  const out: Published[] = []
  for (const f of names) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || now - f.mtimeMs > FRESH_MS) continue
    const text = await readSmall(fs, `${dirs.pane}/${f.name}`)
    const p = text === null ? null : parsePublished(text)
    if (p !== null) out.push(p)
  }
  return out
}

// One refresh: everything the rows need, read cheaply, merged. Never throws.
export async function collectRows(fs: Fs, dirs: Dirs, now: number, self: SelfLive | null): Promise<SessionRow[]> {
  const [registry, published] = await Promise.all([loadRegistry(fs, dirs), loadPublished(fs, dirs, now)])
  const peers = new Map<string, PeerInfo>()
  const wanted = new Map<string, string | null>() // session id -> worktree for the transcript lookup
  for (const e of registry) if (e.sessionId !== null) wanted.set(e.sessionId, e.worktree)
  for (const p of published) if (!wanted.has(p.session_id)) wanted.set(p.session_id, p.cwd)
  if (self && !wanted.has(self.id)) wanted.set(self.id, self.cwd)
  for (const [id, worktree] of wanted) {
    const [t, hook] = await Promise.all([transcriptMtime(fs, dirs, worktree, id), loadHookState(fs, dirs, id)])
    peers.set(id, {
      waitingSince: hook.waitingSince,
      transcriptMtime: t,
      stateMtime: hook.mtimeMs,
      goal: await loadGoal(fs, hook.goalPath),
    })
  }
  return mergeRows({ now, registry, published, peers, self })
}

// The one write: this session's own state, for the other sessions' panes.
export async function publishSelf(fs: Fs, dirs: Dirs, record: Published): Promise<void> {
  if (!SAFE_ID.test(record.session_id)) return
  await fs.write(`${dirs.pane}/${record.session_id}.json`, JSON.stringify(record))
}
