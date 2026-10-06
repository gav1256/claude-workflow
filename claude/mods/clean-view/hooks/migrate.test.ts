import { describe, expect, test } from 'claude-code/testing'

import { migrateFromSessionsPane } from './migrate'
import type { MigrationIo } from './migrate'
import { MIGRATED_KEY, isOldStoreName, oldStoreValues, pickOldStore } from './model'

// ---------- the one-time move of the old sessions-pane values: the pure parts and the flow, over fakes ----------

const DIR = 'C:/Users/user/.claude'
const STORE = `${DIR}/plugins/store`
const OLD_FILE = 'sessions-pane_inline-f9e041d6f866.json'

type Fake = { io: MigrationIo; store: Record<string, unknown>; listed: string[]; sets: string[] }

// A fake `$`: a store in memory, a folder listing, the files in it, and the theme row.
function fake(o: { files?: Record<string, string>; list?: Array<{ name: string; kind?: 'file' | 'dir' | 'other'; mtimeMs?: number }> | 'throws'; claudeDir?: string | null; theme?: { value: unknown; options?: string[] } | null | 'throws'; store?: Record<string, unknown> }): Fake {
  const store: Record<string, unknown> = { ...(o.store ?? {}) }
  const listed: string[] = []
  const sets: string[] = []
  const files = o.files ?? {}
  const io: MigrationIo = {
    claudeDir: o.claudeDir === undefined ? DIR : o.claudeDir,
    getStore: async key => store[key],
    setStore: async (key, value) => {
      sets.push(key)
      store[key] = value
    },
    list: async path => {
      listed.push(path)
      if (o.list === 'throws') throw new Error('EACCES')
      return (o.list ?? []).map(f => ({ name: f.name, kind: f.kind ?? 'file', mtimeMs: f.mtimeMs ?? 1 }))
    },
    read: async path => {
      const t = files[path]
      if (t === undefined) throw new Error('ENOENT')
      return t
    },
    themeRow: async () => {
      if (o.theme === 'throws') throw new Error('no config')
      return o.theme === undefined ? null : o.theme
    },
  }
  return { io, store, listed, sets }
}

describe('the old store file', () => {
  test('is found by the plugin name, not by a lookalike, and the newest wins', () => {
    expect(isOldStoreName('sessions-pane_inline-f9e041d6f866.json')).toBe(true)
    expect(isOldStoreName('sessions-pane.json')).toBe(true)
    expect(isOldStoreName('Sessions-Pane_inline-1.json')).toBe(true)
    expect(isOldStoreName('sessions-pane-extra_inline-1.json')).toBe(false)
    expect(isOldStoreName('clean-view_inline-1.json')).toBe(false)
    expect(isOldStoreName('sessions-pane_inline-1.txt')).toBe(false)
    expect(
      pickOldStore([
        { name: 'clean-view_inline-1.json', kind: 'file', mtimeMs: 9 },
        { name: 'sessions-pane_a.json', kind: 'file', mtimeMs: 2 },
        { name: 'sessions-pane_b.json', kind: 'file', mtimeMs: 5 },
        { name: 'sessions-pane_dir.json', kind: 'dir', mtimeMs: 8 },
      ]),
    ).toBe('sessions-pane_b.json')
    expect(pickOldStore([{ name: 'other.json', kind: 'file', mtimeMs: 1 }])).toBe(null)
    expect(pickOldStore([])).toBe(null)
  })

  test('only the two booleans are taken, and only from a JSON object', () => {
    expect(oldStoreValues('{"locked":true,"themeOffered":true,"other":1}')).toEqual({ locked: true, themeOffered: true })
    expect(oldStoreValues('{"locked":"yes","themeOffered":false}')).toEqual({ themeOffered: false })
    expect(oldStoreValues('{}')).toEqual({})
    expect(oldStoreValues('[1]')).toBe(null)
    expect(oldStoreValues('not json')).toBe(null)
    expect(oldStoreValues('null')).toBe(null)
  })
})

describe('the move', () => {
  test('possible: locked and themeOffered are copied from the old plugin store file once, and the flag is set', async () => {
    const f = fake({ list: [{ name: OLD_FILE }, { name: 'clean-view_inline-1.json' }], files: { [`${STORE}/${OLD_FILE}`]: '{"locked":true,"themeOffered":true}' } })
    const r = await migrateFromSessionsPane(f.io)
    expect(r.source).toBe('old-store')
    expect(f.listed).toEqual([STORE])
    expect(f.store).toEqual({ locked: true, themeOffered: true, [MIGRATED_KEY]: true })
    expect(r.written).toEqual(['locked', 'themeOffered', MIGRATED_KEY])
    // once: a second start neither lists nor writes
    const again = await migrateFromSessionsPane(f.io)
    expect(again.source).toBe('already')
    expect(f.listed).toHaveLength(1)
    expect(f.sets).toHaveLength(3)
  })

  test('a value this plugin already holds is never overwritten', async () => {
    const f = fake({ store: { locked: false }, list: [{ name: OLD_FILE }], files: { [`${STORE}/${OLD_FILE}`]: '{"locked":true,"themeOffered":true}' } })
    await migrateFromSessionsPane(f.io)
    expect(f.store.locked).toBe(false)
    expect(f.store.themeOffered).toBe(true)
  })

  test('a lock saved as off is carried over as off', async () => {
    const f = fake({ list: [{ name: OLD_FILE }], files: { [`${STORE}/${OLD_FILE}`]: '{"locked":false}' } })
    await migrateFromSessionsPane(f.io)
    expect(f.store.locked).toBe(false)
    expect(f.store.themeOffered).toBeUndefined()
  })

  test('impossible (the store folder cannot be read): the lock keeps its default and a Warm theme already on is never offered', async () => {
    const warm = 'custom:clean-view:warm'
    const f = fake({ list: 'throws', theme: { value: warm, options: ['dark', 'light', warm] } })
    const r = await migrateFromSessionsPane(f.io)
    expect(r.source).toBe('fallback')
    expect(f.store.locked).toBeUndefined() // the default: off
    expect(f.store.themeOffered).toBe(true)
    expect(f.store[MIGRATED_KEY]).toBe(true)
  })

  test('impossible: another theme in use leaves the offer to the normal flow', async () => {
    const f = fake({ list: 'throws', theme: { value: 'light', options: ['dark', 'light', 'custom:clean-view:warm'] } })
    await migrateFromSessionsPane(f.io)
    expect(f.store.themeOffered).toBeUndefined()
    expect(f.store[MIGRATED_KEY]).toBe(true)
  })

  test('Clean View Dark already on is never offered either', async () => {
    const dark = 'custom:clean-view:clean-view'
    const f = fake({ list: [], theme: { value: dark, options: ['dark', dark] } })
    await migrateFromSessionsPane(f.io)
    expect(f.store.themeOffered).toBe(true)
  })

  test('the old plugin name in the theme option counts as Warm too', async () => {
    const f = fake({ list: [], theme: { value: 'custom:sessions-pane:warm', options: ['custom:sessions-pane:warm'] } })
    await migrateFromSessionsPane(f.io)
    expect(f.store.themeOffered).toBe(true)
  })

  test('no config directory: nothing is read, the fallback runs', async () => {
    const f = fake({ claudeDir: null, theme: null })
    const r = await migrateFromSessionsPane(f.io)
    expect(r.source).toBe('fallback')
    expect(f.listed).toEqual([])
    expect(f.store).toEqual({ [MIGRATED_KEY]: true })
  })

  test('no old file, an unreadable one, or one that is not a store: the fallback, and no error', async () => {
    const cases: Array<Parameters<typeof fake>[0]> = [
      { list: [] },
      { list: [{ name: OLD_FILE }], files: {} },
      { list: [{ name: OLD_FILE }], files: { [`${STORE}/${OLD_FILE}`]: 'not json' } },
    ]
    for (const o of cases) {
      const f = fake({ ...o, theme: 'throws' })
      const r = await migrateFromSessionsPane(f.io)
      expect(r.source).toBe('fallback')
      expect(f.store).toEqual({ [MIGRATED_KEY]: true })
    }
  })

  test('a store that cannot be written does not throw, and does not set the flag', async () => {
    const f = fake({ list: [{ name: OLD_FILE }], files: { [`${STORE}/${OLD_FILE}`]: '{"locked":true}' } })
    f.io.setStore = async () => {
      throw new Error('read-only')
    }
    const r = await migrateFromSessionsPane(f.io)
    expect(r.written).toEqual([])
    expect(f.store[MIGRATED_KEY]).toBeUndefined()
  })
})
