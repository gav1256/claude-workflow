// The pure rules of the global Shabbat switch, `state/coord/shabbos.json` (the launcher's file; this mod reads it for the
// band marker and writes it for `/shabbos on|off`). No `$` here. The reader and the wording mirror the coordinator
// (`offtimes-io.mjs` shabbosEnabled, `coord.mjs shabbos`), so a change from either side reads the same in both.

export const SHABBOS_FILE = 'shabbos.json'
export const SHABBOS_USAGE = 'Usage: /shabbos [on|off|status]'

// The one reader rule (fail safe ON): the switch is off only when the text is a JSON object whose `enabled` is exactly
// `false`. Absent (null), unreadable, malformed, not an object (an array too), or any other `enabled` is on.
export function shabbosEnabled(text: string | null): boolean {
  if (text === null) return true
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return true
  }
  return !(v !== null && typeof v === 'object' && !Array.isArray(v) && (v as { enabled?: unknown }).enabled === false)
}

// The file's exact shape: `{ enabled, changed_at (epoch ms), by_session }`, two-space JSON like the CLI writes it.
export function shabbosRecord(enabled: boolean, now: number, by: string): string {
  return JSON.stringify({ enabled, changed_at: now, by_session: by === '' ? 'user' : by }, null, 2)
}

// The one status line, word for word what `coord.mjs shabbos` prints.
export function shabbosLine(enabled: boolean): string {
  return enabled
    ? 'shabbos: on (Shabbat/Yom Tov pause and working-time weekly pacing)'
    : 'shabbos: off (plain 7-day pacing, no Shabbat/Yom Tov pause)'
}

// The marker in the band (and the Sessions pane header).
export const shabbosMarker = (enabled: boolean): string => (enabled ? '✡ Shabbos on' : '✡ Shabbos off')

export type ShabbosCommand = 'on' | 'off' | 'status' | 'unknown'

// `/shabbos`, `/shabbos on|off|status`; no argument is status. Anything else (case matters, as in the CLI), or more than one
// word, is unknown.
export function parseShabbos(args: string): ShabbosCommand {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  if (words.length === 0) return 'status'
  if (words.length > 1) return 'unknown'
  const w = words[0]
  return w === 'on' || w === 'off' || w === 'status' ? w : 'unknown'
}
