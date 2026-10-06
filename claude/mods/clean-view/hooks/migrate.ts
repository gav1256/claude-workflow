// The one-time move of the old sessions-pane mod's saved values into this plugin's store. It takes plain functions
// (sessions.tsx builds them over `$`), so it is unit-tested with fakes.

import { MIGRATED_KEY, OLD_STORE_DIR, oldStoreValues, pickOldStore } from './model'
import type { StoreEntry } from './model'
import { LOCK_KEY, THEME_KEY, findCleanDark, findWarm } from './model-sessions'

export type MigrationIo = {
  /** The Claude config directory (forward slashes); null when the environment names none, which leaves the old store unread. */
  claudeDir: string | null
  getStore: (key: string) => Promise<unknown>
  setStore: (key: string, value: unknown) => Promise<void>
  list: (path: string) => Promise<StoreEntry[]>
  read: (path: string) => Promise<string>
  /** The theme row of /config, or null when it is not there. */
  themeRow: () => Promise<{ value: unknown; options?: readonly string[] } | null>
}

export type MigrationResult = {
  /** 'already': the flag was set, nothing ran. 'old-store': the old plugin's file was read. 'fallback': it could not be, defaults apply. */
  source: 'already' | 'old-store' | 'fallback'
  /** The keys that were written to this plugin's store (the flag included). */
  written: string[]
}

// Runs once per store: copies `locked` and `themeOffered` from the old plugin's store file, never over a value this
// plugin already holds. Without that file (not found, unreadable, no config directory) `locked` stays at its default
// (off), and `themeOffered` is set when the theme in use is already Warm, so it is never offered again. Never throws.
export async function migrateFromSessionsPane(io: MigrationIo): Promise<MigrationResult> {
  const written: string[] = []
  try {
    if ((await io.getStore(MIGRATED_KEY)) === true) return { source: 'already', written }
  } catch {
    return { source: 'fallback', written } // the store cannot be read: nothing can be moved or flagged
  }

  let old: ReturnType<typeof oldStoreValues> = null
  if (io.claudeDir !== null) {
    try {
      const dir = `${io.claudeDir}/${OLD_STORE_DIR}`
      const name = pickOldStore(await io.list(dir))
      if (name !== null) old = oldStoreValues(await io.read(`${dir}/${name}`))
    } catch {
      old = null // a folder or file that cannot be read means the fallback, not an error
    }
  }

  const put = async (key: string, value: unknown): Promise<void> => {
    if ((await io.getStore(key)) !== undefined) return
    await io.setStore(key, value)
    written.push(key)
  }
  try {
    if (old?.locked !== undefined) await put(LOCK_KEY, old.locked)
    if (old?.themeOffered !== undefined) await put(THEME_KEY, old.themeOffered)
    // one of this mod's themes that is already on is never offered
    if ((await io.getStore(THEME_KEY)) !== true) {
      const row = await io.themeRow().catch(() => null)
      const own = [findWarm(row?.options), findCleanDark(row?.options)]
      if (row !== null && row.value !== undefined && own.includes(row.value as string)) await put(THEME_KEY, true)
    }
    await io.setStore(MIGRATED_KEY, true)
    written.push(MIGRATED_KEY)
  } catch {
    // a store that cannot be written: the move is tried again at the next start
  }
  return { source: old === null ? 'fallback' : 'old-store', written }
}
