// The usage bars: what `state/coord/pace.json` (written by the usage pacer, never by this mod) says about the Claude
// 5-hour and weekly windows and about Codex. Pure (no `$`, no elements), so it is unit-tested directly. No Fable window is
// read or drawn: only `pct`, `resets_at`, `week_pct`, `week_resets_at` and `state` of a provider are looked at.

export const USAGE_STALE_MS = 15 * 60 * 1000 // a pace.json older than this is absent
export const USAGE_CELLS = 10 // the bar of a row
export const COMPACT_CELLS = 3 // the bar of the one-line form in the band

import type { Usage, UsageProvider, UsageWindow } from '../types'
export type { Usage, UsageProvider, UsageWindow }

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

// 0-100 number, clamped; anything else is unknown.
export function normPct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

// Epoch seconds, epoch milliseconds or an ISO string, as epoch ms; anything else is null. Under 1e11 is seconds (that is
// year 5138 in seconds and 1973 in milliseconds).
export function normTime(v: unknown): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return normTime(n)
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

function providerOf(o: Record<string, unknown>): UsageProvider {
  const windows = rec(o.windows)
  const stateOf = (key: string): unknown => rec(windows?.[key])?.state
  const whole = o.state === 'exhausted'
  return {
    five: { pct: normPct(o.pct), resetsAt: normTime(o.resets_at), isExhausted: whole || stateOf('five_hour') === 'exhausted' },
    week: { pct: normPct(o.week_pct), resetsAt: normTime(o.week_resets_at), isExhausted: whole || stateOf('weekly') === 'exhausted' },
  }
}

// The file's text, its modification time and now: the usage, or null when the text is not an object, or the file is
// older than USAGE_STALE_MS (by `updated`, else by the file time). A provider is a key whose value is an object with a
// `state` (`updated` is reserved).
export function parsePace(text: string, mtimeMs: number, now: number): Usage | null {
  let o: Record<string, unknown> | null
  try {
    o = rec(JSON.parse(text))
  } catch {
    return null
  }
  if (o === null) return null
  // an `updated` from the future (a skewed clock) is not believed: the file time decides
  const claimed = normTime(o.updated)
  const stamp = claimed !== null && claimed <= now + USAGE_STALE_MS ? claimed : mtimeMs
  if (!Number.isFinite(stamp) || now - stamp > USAGE_STALE_MS) return null
  const provider = (name: string): UsageProvider | null => {
    if (name === 'updated') return null
    const p = rec(o[name])
    return p !== null && 'state' in p ? providerOf(p) : null
  }
  return { claude: provider('claude'), codex: provider('codex') }
}

// ---------- reading it ----------

export type UsageRowView =
  | { kind: 'none' } // a row that reads `no data yet`
  | { kind: 'exhausted' } // exhausted with no percent: reads `exhausted` in the error colour
  | { kind: 'reset' } // the reset time has passed, so the old percent is not shown: reads `reset · no data yet`
  | { kind: 'bar'; pct: number; resetsAt: number | null; isExhausted: boolean } // a reset time is optional

// A window as a row. A percent is enough for a bar (no reset time: no `resets ...`); a reset time already past means the
// percent is of the old window, so it reads `reset · no data yet`; exhausted with no percent still says so.
export function windowView(w: UsageWindow, now: number): UsageRowView {
  if (w.pct === null) return w.isExhausted ? { kind: 'exhausted' } : { kind: 'none' }
  if (w.resetsAt !== null && w.resetsAt <= now) return { kind: 'reset' }
  return { kind: 'bar', pct: w.pct, resetsAt: w.resetsAt, isExhausted: w.isExhausted }
}

// The lines the usage block draws (its header, then Claude's two rows and Codex's rows or its one line): a file that is
// absent or stale is the header and one line.
export function usageLines(u: Usage | null): number {
  if (u === null) return 2
  const codex = u.codex === null ? 0 : [u.codex.five, u.codex.week].filter(hasData).length
  return 1 + 2 + Math.max(1, codex)
}

// Whether a window has anything at all (Codex on Pro Lite has no 5-hour window: both fields are null).
export const hasData = (w: UsageWindow): boolean => w.pct !== null || w.resetsAt !== null

// The colour token of a bar: green under 70 %, warning from 70 to under 90, error from 90 or exhausted.
export function usageTone(pct: number, isExhausted: boolean): 'success' | 'warning' | 'error' {
  return isExhausted || pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'
}

// Filled cells of a bar: a started bar is never empty and an unfinished one never full.
export function usageCells(pct: number, cells: number): number {
  const w = Math.max(1, Math.floor(cells))
  let filled = Math.round((pct / 100) * w)
  if (pct > 0 && filled === 0) filled = 1
  if (pct < 100 && filled === w) filled = w - 1
  return filled
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const two = (n: number): string => String(n).padStart(2, '0')

// `in 2h 14m` within a day, else `Mon 09:00` (local time); `now` once it has passed.
export function resetText(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms <= 0) return 'now'
  if (ms < 24 * 60 * 60 * 1000) {
    const mins = Math.max(1, Math.round(ms / 60000))
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`
  }
  const d = new Date(resetsAt)
  return `${DAYS[d.getDay()] ?? ''} ${two(d.getHours())}:${two(d.getMinutes())}`
}

// ---------- the one-line form of the band ----------

// `5h ▰▰▱ 23% · wk ▰▱▱ 12% · cx ▰▱▱ 8%`: the Claude 5-hour, the Claude weekly and the Codex weekly, each only when its
// percent is known and its reset time (if any) is still ahead, so a window that has reset never shows its old percent (as in
// the panel). `cx` is Codex's weekly window, else its only window with data.
export function compactParts(u: Usage | null, now: number): string[] {
  if (u === null) return []
  const isLive = (w: UsageWindow | undefined): w is UsageWindow => w !== undefined && w.pct !== null && (w.resetsAt === null || w.resetsAt > now)
  const part = (label: string, w: UsageWindow | undefined): string | null => {
    if (!isLive(w) || w.pct === null) return null
    const n = usageCells(w.pct, COMPACT_CELLS)
    return `${label} ${'▰'.repeat(n)}${'▱'.repeat(COMPACT_CELLS - n)} ${Math.round(w.pct)}%`
  }
  const cx = u.codex === null ? undefined : isLive(u.codex.week) ? u.codex.week : u.codex.five
  return [part('5h', u.claude?.five), part('wk', u.claude?.week), part('cx', cx)].filter((p): p is string => p !== null)
}

// The longest form that fits `room` cells: all parts, then without `cx`, then fewer, then none (the band row never grows).
export function compactUsage(u: Usage | null, room: number, now: number): string {
  const parts = compactParts(u, now)
  const claude = parts.filter(p => !p.startsWith('cx '))
  const tries = [parts, claude, claude.slice(0, 1)]
  for (const t of tries) {
    const text = t.join(' · ')
    if (text !== '' && Array.from(text).length <= room) return text
  }
  return ''
}
