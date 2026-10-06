// The look both features share: the round card, the gradient title, the segmented meters and the status words. Pure
// (no `$`, no elements), so it is unit-tested directly; `card.tsx` turns it into elements.
//
// The card's accents are theme tokens (`claude`, `success`, `inverseText`), so the card follows the theme: pink on
// Clean View Dark, orange on Warm. Only the gradients (the title, the meters) are raw hex: mid-tone, so they read on
// dark and light themes. Every body text stays on theme tokens (`text`, `inactive`, `subtle`, `warning`, `error`).

import type { CleanTask, RowProgress, SessionRow } from '../types'
import { rowViews } from './model-clean'
import { meterCells, meterFill } from './model-sessions'

export const MAGENTA = 'claude' // the card border while working, the current dot
export const PINK = 'claude' // Working
export const GREEN = 'success' // the done card, Done
export const ACCENT = 'claude' // the selected half of a toggle
export const DARK = 'inverseText' // text on a green badge or an accent button

// The title runs through these, one colour per word.
export const TITLE_STOPS = ['#f0a060', '#e86aa0', '#b07ae0', '#7a9ae0'] as const
// The meter of a step in progress: dark magenta to pink to lilac.
export const METER_STOPS = ['#5a2146', '#e0407a', '#e8a0e0'] as const
// The meter of a finished step or job: dark green to light green.
export const DONE_STOPS = ['#1f7a35', '#6fdc8c'] as const

export const SWEEP_CELLS = 5 // the moving blocks of a step with no percent yet
export const STATUS_W = 7 // `Working`, `Up next`, `Waiting`
export const MAX_BANDS = 16 // a long bar is drawn in at most this many colour bands

// ---------- colour ----------

const hex = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
const channels = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]

// The colour at `t` (0 to 1) along a list of `#rrggbb` stops.
export function gradientAt(stops: readonly string[], t: number): string {
  const first = stops[0] ?? '#ffffff'
  if (stops.length < 2) return first
  const p = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(p))
  const a = channels(stops[i] ?? first)
  const b = channels(stops[i + 1] ?? first)
  const f = p - i
  return `#${hex(a[0] + (b[0] - a[0]) * f)}${hex(a[1] + (b[1] - a[1]) * f)}${hex(a[2] + (b[2] - a[2]) * f)}`
}

// One colour per word of the title, from the first stop to the last.
export function titleColors(words: number): string[] {
  return Array.from({ length: words }, (_, i) => gradientAt(TITLE_STOPS, words <= 1 ? 0 : i / (words - 1)))
}

// ---------- the meters ----------

export type Run = { text: string; color: string }

// `cells` block characters, each cell coloured by its place along `stops`; a long bar is coloured in at most MAX_BANDS
// bands. Neighbours of one colour are one run.
export function gradientRuns(cells: number, stops: readonly string[], ch = '█', from = 0, span = cells): Run[] {
  const runs: Run[] = []
  const bands = Math.min(Math.max(1, span), MAX_BANDS)
  for (let i = 0; i < cells; i++) {
    const at = from + i
    const band = Math.floor((at * bands) / Math.max(1, span))
    const color = gradientAt(stops, bands <= 1 ? 1 : band / (bands - 1))
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.text += ch
    else runs.push({ text: ch, color })
  }
  return runs
}

// A bar of `cells` cells filled to `percent`: the filled cells carry the gradient of the whole bar, the rest a muted track.
export function fillRuns(percent: number, cells: number, stops: readonly string[] = METER_STOPS): Run[] {
  const w = Math.max(1, Math.floor(cells))
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  let filled = Math.round((p / 100) * w)
  if (p > 0 && filled === 0) filled = 1
  if (p < 100 && filled === w) filled = w - 1
  const runs = gradientRuns(filled, stops, '█', 0, w)
  if (filled < w) runs.push({ text: '░'.repeat(w - filled), color: 'subtle' })
  return runs
}

// The moving blocks of a step with no percent yet: the brightest block steps along each frame, the ones behind it dim.
export function sweepRuns(frame: number, cells: number = SWEEP_CELLS): Run[] {
  const n = Math.max(2, cells)
  const pos = ((Math.floor(frame) % n) + n) % n
  const runs: Run[] = []
  for (let i = 0; i < n; i++) {
    const behind = (pos - i + n) % n
    runs.push({ text: '█', color: gradientAt(METER_STOPS, 1 - behind / (n - 1)) })
  }
  return runs
}

// A finished bar of `cells` cells: all filled, dark green to light green.
export const doneRuns = (cells: number): Run[] => gradientRuns(Math.max(1, Math.floor(cells)), DONE_STOPS)

// ---------- the card's columns ----------

export type CardLayout = {
  /** The cells inside the border and padding. */
  inner: number
  labelW: number
  meterW: number
  statusW: number
}

// The columns of a row (dot, label, meter, status), the meter at about 45% of the width. At a narrow width the meter
// shrinks to 5 cells and the label gives way; the status column is always kept.
export function cardLayout(bodyColumns: number): CardLayout {
  const inner = Math.max(24, Math.floor(bodyColumns) - 4) // border and padding on both sides
  const meterW = inner >= 46 ? 10 : 5
  const room = inner - 2 - 1 - meterW - 1 - STATUS_W // dot and gap, label, gap, meter, gap, status
  const labelW = Math.max(4, Math.min(room, Math.round(inner * 0.45) - 2))
  return { inner, labelW, meterW, statusW: STATUS_W }
}

// ---------- the checklist rows ----------

export type CardRow = {
  kind: 'done' | 'active' | 'upcoming'
  glyph: string
  glyphColor: string
  name: string
  label: string
  labelColor: string
  meter: Run[]
  isHeld: boolean
}

// What one step shows: a green check, the current step's dot and moving meter, or a hollow dot with no meter.
export function cardRows(tasks: readonly CleanTask[], frame: number, isHeld: boolean, meterW: number): CardRow[] {
  const views = rowViews(tasks, frame, isHeld)
  return views.map((v, i): CardRow => {
    const t = tasks[i]
    if (v.kind === 'done') return { kind: 'done', glyph: '✓', glyphColor: GREEN, name: v.name, label: v.label, labelColor: GREEN, meter: doneRuns(meterW), isHeld: false }
    if (v.kind === 'active') {
      const meter = t?.hasReported === true ? fillRuns(t.percent, meterW) : sweepRuns(isHeld ? 0 : frame, Math.min(SWEEP_CELLS, meterW))
      return { kind: 'active', glyph: isHeld ? '‖' : '●', glyphColor: MAGENTA, name: v.name, label: v.label, labelColor: PINK, meter, isHeld }
    }
    return { kind: 'upcoming', glyph: '○', glyphColor: 'inactive', name: v.name, label: v.label, labelColor: 'inactive', meter: [], isHeld: false }
  })
}

// `Step 2 of 4`: the step the person is on (the count of finished steps plus one, never past the end).
export function stepLine(tasks: readonly CleanTask[]): string {
  const done = tasks.filter(t => t.status === 'done').length
  return `Step ${Math.min(tasks.length, done + 1)} of ${tasks.length}`
}

// ---------- the sessions rows ----------

export type Word = { text: string; color: string }

// The dot of a session: red for a permission dialog, yellow for a question, magenta while busy, hollow and in the suggestion
// colour while only its subagents run, hollow and dim when idle.
export function rowDot(r: SessionRow): { glyph: string; color: string; isDim: boolean } {
  if (r.waiting === 'permission') return { glyph: '●', color: 'error', isDim: false }
  if (r.waiting !== null) return { glyph: '●', color: 'warning', isDim: false }
  if (r.state === 'busy') return { glyph: '●', color: MAGENTA, isDim: false }
  if (r.state === 'agents') return { glyph: '○', color: 'suggestion', isDim: false }
  return { glyph: '○', color: 'inactive', isDim: true }
}

// Whether the row's meter is complete (x of x).
export const isComplete = (r: SessionRow): boolean => r.progress !== null && r.progress.total > 0 && r.progress.done >= r.progress.total

// The status word of a session.
export function rowStatus(r: SessionRow): Word {
  if (r.state === 'waiting') return { text: 'Waiting', color: 'warning' }
  if (r.state === 'asking') return { text: 'Asking', color: 'warning' }
  if (r.state === 'busy') return { text: 'Working', color: PINK }
  if (r.state === 'agents') return { text: 'Agents', color: 'claude' } // the main session is idle, its subagents are not
  return isComplete(r) ? { text: 'Done', color: GREEN } : { text: 'Idle', color: 'inactive' }
}

// The meter of a session: pink while it goes on, green when x of x is done. A started meter is never empty and an
// unfinished one never full (see meterCells).
export function progressRuns(p: RowProgress, cells: number): Run[] {
  if (p.total > 0 && p.done >= p.total) return doneRuns(cells)
  const { filled, empty } = meterCells(meterFill(p), p.total, cells)
  const runs = gradientRuns(filled, METER_STOPS, '█', 0, cells)
  if (empty > 0) runs.push({ text: '░'.repeat(empty), color: 'subtle' })
  return runs
}

// The spaced-caps header of the sessions panel.
export const PANE_HEADER = 'S E S S I O N S'

// The spaced-caps header of the agents popup.
export const AGENTS_HEADER = 'A G E N T S'
