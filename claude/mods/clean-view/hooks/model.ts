// What the two features of this plugin (Clean View, the checklist; Sessions, the pane) share: the plugin's name, a text
// helper, and the pure logic of the one-time move of the sessions-pane mod's saved values. No `$` here.

export const PLUGIN_NAME = 'clean-view'

// The mod this plugin replaces. Its saved values (`locked`, `themeOffered`) are carried over once.
export const OLD_PLUGIN_NAME = 'sessions-pane'

export const charLength = (text: string): number => Array.from(text).length

// ---------- the one-time move of the old sessions-pane values ----------

// $.store is a plugin's own: the declarations give no way to read another plugin's. The store is a JSON file under the
// config directory, though, and `$.fs` reads any absolute path. On this build the file is
// `<config dir>/plugins/store/<plugin name>_<source>-<hash>.json` (seen on disk; the declarations do not document the
// layout). The move therefore lists that folder and reads the old plugin's file, and when anything is missing or
// different it falls back to defaults instead.
export const OLD_STORE_DIR = 'plugins/store'
export const MIGRATED_KEY = 'migratedFromSessionsPane' // a $.store flag: the move was done (or tried) once

export type StoreEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

// The old plugin's own store file: the plugin name, then either nothing or a `_`, `.` or `@` and a suffix, ending in
// `.json`. A plugin whose name only starts the same (`sessions-pane-extra_...`) is not it.
export function isOldStoreName(name: string): boolean {
  const n = name.toLowerCase()
  if (!n.endsWith('.json') || !n.startsWith(OLD_PLUGIN_NAME)) return false
  const rest = n.slice(OLD_PLUGIN_NAME.length, -'.json'.length)
  return rest === '' || /^[_.@]/.test(rest)
}

// The old store file among the names in the store folder; when several match (the same mod installed twice) the newest wins.
export function pickOldStore(entries: readonly StoreEntry[]): string | null {
  const found = entries.filter(f => f.kind === 'file' && isOldStoreName(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found[0]?.name ?? null
}

export type OldValues = { locked?: boolean; themeOffered?: boolean }

// The two values worth keeping, and only when they are booleans. null: not a store file.
export function oldStoreValues(text: string): OldValues | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  const out: OldValues = {}
  if (typeof r.locked === 'boolean') out.locked = r.locked
  if (typeof r.themeOffered === 'boolean') out.themeOffered = r.themeOffered
  return out
}
