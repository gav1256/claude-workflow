import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { collectRows, publishSelf, resetCaches } from './io'
import type { Fs } from './io'
import {
  ALIVE_MS,
  WAIT_MAX_MS,
  WATCHDOG_MS,
  ANON_MAX_MS,
  ANON_TURN_MS,
  expirePending,
  settleInflight,
  settleTurn,
  callSig,
  isDecided,
  isStuck,
  liveKind,
  pairPermission,
  FRESH_MS,
  LOCK_KEY,
  claudeDirFrom,
  dirsOf,
  countGoal,
  dotOf,
  endsWithQuestion,
  hookWaiting,
  layoutColumns,
  mergeRows,
  parseCommand,
  parsePublished,
  parseRegistry,
  projectKey,
  refusesClose,
  stateOf,
  summary,
  truncateChars,
} from './model'
import type { PeerInfo, Published, RegEntry, SelfLive } from './model'
import type { SessionRow } from '../types'

const HOME = 'C:/Users/user/.claude'
const DIRS = dirsOf(HOME)

const launch = (o: Record<string, unknown>): string => JSON.stringify({ repo: 'r', branch: 'b', ...o })

describe('registry', () => {
  test('keeps the newest launch line per repo|name, drops closed ones, tolerates bad lines', () => {
    const text = [
      launch({ id: 'a@1', name: 'a', launched_at: '2026-10-01T00:00:00Z', session_id: 's1', model: 'opus', effort: 'low' }),
      launch({ id: 'a@2', name: 'a', launched_at: '2026-10-02T00:00:00Z', session_id: 's2', model: 'opus', effort: 'high' }),
      launch({ id: 'b@1', name: 'b', launched_at: '2026-10-02T00:00:00Z', session_id: 's3' }),
      launch({ id: 'c@1', name: 'c', launched_at: '2026-10-02T00:00:00Z', session_id: 's4' }),
      JSON.stringify({ closed: 'c', id: 'c@1', at: 'x', why: 'done' }),
      JSON.stringify({ starting: 's9', name: 'd', pid_file: null, at: 'x' }),
      JSON.stringify({ priority: 1, value: 2, name: 'a' }),
      JSON.stringify({ stop_requested: 'a', name: 'a', at: 'x' }),
      'not json at all',
      '{"truncated":',
      '[1,2]',
      'null',
      '',
    ].join('\n')
    const open = parseRegistry(text)
    expect(open.map(e => e.name).sort()).toEqual(['a', 'b'])
    expect(open.find(e => e.name === 'a')?.sessionId).toBe('s2')
    expect(open.find(e => e.name === 'a')?.effort).toBe('high')
  })

  test('closing the newest launch line of a name leaves the older open one, as launch.mjs sessions does', () => {
    const text = [
      launch({ id: 'a@1', name: 'a', launched_at: '2026-10-01T00:00:00Z', session_id: 's1' }),
      launch({ id: 'a@2', name: 'a', launched_at: '2026-10-02T00:00:00Z', session_id: 's2' }),
      JSON.stringify({ closed: 'a', id: 'a@2' }),
    ].join('\n')
    expect(parseRegistry(text).map(e => e.sessionId)).toEqual(['s1'])
  })

  test('the same name in two repos is two sessions', () => {
    const text = [
      launch({ id: 'a@1', name: 'a', repo: 'r1', launched_at: '2026-10-01T00:00:00Z' }),
      launch({ id: 'a@2', name: 'a', repo: 'r2', launched_at: '2026-10-01T00:00:00Z' }),
    ].join('\n')
    expect(parseRegistry(text).length).toBe(2)
  })
})

describe('goal', () => {
  test('counts done against every checklist item (open, done, blocked)', () => {
    const text = ['# Goal', '- [x] one', '- [ ] two', '- [!] three — reason: x', '  * [X] four', 'not an item', '- [x]'].join('\n')
    expect(countGoal(text)).toEqual({ done: 3, total: 5 })
  })

  test('no items is null, not 0/0', () => {
    expect(countGoal('# Goal\nnothing here')).toBe(null)
  })
})

describe('waiting dot', () => {
  test('a waiting session shows a filled coloured dot, an idle one a dim hollow dot', () => {
    expect(dotOf(null)).toEqual({ glyph: '\u25cb', color: undefined, isDim: true })
    expect(dotOf('permission')).toEqual({ glyph: '\u25cf', color: 'error', isDim: false })
    expect(dotOf('question')).toEqual({ glyph: '\u25cf', color: 'warning', isDim: false })
    expect(dotOf('ask')).toEqual({ glyph: '\u25cf', color: 'warning', isDim: false })
  })

  test('state text follows what the session waits on', () => {
    expect(stateOf('permission', true)).toBe('waiting')
    expect(stateOf('question', false)).toBe('asking')
    expect(stateOf(null, true)).toBe('busy')
    expect(stateOf(null, false)).toBe('idle')
  })

  test('a coord waiting_since is over once the transcript moved after it', () => {
    expect(hookWaiting(null, 1000, 2000)).toBe(false)
    expect(hookWaiting(1000, null, 2000)).toBe(true)
    expect(hookWaiting(1000, 900, 2000)).toBe(true)
    expect(hookWaiting(1000, 1000 + 5001, 2000)).toBe(false)
  })

  test('a coord waiting_since older than 10 minutes is not a wait', () => {
    expect(hookWaiting(1000, null, 1000 + WAIT_MAX_MS - 1)).toBe(true)
    expect(hookWaiting(1000, null, 1000 + WAIT_MAX_MS)).toBe(false)
  })

  test('a turn that ends on a question is a question; wrapped and Hebrew questions count', () => {
    expect(endsWithQuestion('Should I continue?')).toBe(true)
    expect(endsWithQuestion('Should I continue?  \n')).toBe(true)
    expect(endsWithQuestion('**Which one?**')).toBe(true)
    expect(endsWithQuestion('(or the other?)')).toBe(true)
    expect(endsWithQuestion('האם להמשיך?')).toBe(true)
    expect(endsWithQuestion('Done.')).toBe(false)
    expect(endsWithQuestion('')).toBe(false)
    expect(endsWithQuestion(undefined)).toBe(false)
  })
})

const NOW = 10_000_000
const reg = (name: string, sessionId: string | null, extra: Partial<RegEntry> = {}): RegEntry => ({
  id: `${name}@1`,
  name,
  repo: 'r',
  branch: 'b',
  worktree: 'C:/w/' + name,
  sessionId,
  model: 'claude-opus-4-5-20251101',
  effort: 'medium',
  launchedAt: '2026-10-01T00:00:00Z',
  ...extra,
})
const peer = (p: Partial<PeerInfo> = {}): PeerInfo => ({ waitingSince: null, transcriptMtime: null, stateMtime: null, goal: null, ...p })
const pub = (id: string, p: Partial<Published> = {}): Published => ({
  session_id: id,
  name: null,
  cwd: 'C:/x/' + id,
  model: 'sonnet',
  effort: 'low',
  waiting: false,
  waiting_kind: null,
  busy: false,
  updated_at: NOW - 1000,
  ...p,
})
const me: SelfLive = { id: 'me', cwd: 'C:/x/mine', model: 'claude-opus-4-5', effort: 'high', kind: null, busy: true }

describe('merge', () => {
  test('registry-only sessions: alive by transcript, waiting from the coord hook, dead ones dropped', () => {
    const peers = new Map<string, PeerInfo>([
      ['s-wait', peer({ transcriptMtime: NOW - 60_000, waitingSince: NOW - 30_000, goal: { done: 2, total: 5 } })],
      ['s-busy', peer({ transcriptMtime: NOW - 5_000 })],
      ['s-idle', peer({ transcriptMtime: NOW - 10 * 60_000 })],
      ['s-dead', peer({ transcriptMtime: NOW - ALIVE_MS - 1 })],
    ])
    const rows = mergeRows({
      now: NOW,
      registry: [reg('wait', 's-wait'), reg('busy', 's-busy'), reg('idle', 's-idle'), reg('dead', 's-dead'), reg('nosid', null)],
      published: [],
      peers,
      self: null,
    })
    expect(rows.map(r => [r.name, r.state])).toEqual([
      ['wait', 'waiting'],
      ['busy', 'busy'],
      ['idle', 'idle'],
    ])
    expect(rows[0]?.goal).toBe('2/5')
    expect(rows[0]?.waiting).toBe('permission')
    expect(rows[1]?.model).toBe('opus-4-5')
    expect(rows[1]?.effort).toBe('medium')
  })

  test('waiting_since alone does not keep a dead session listed, and a stale one is not shown as a wait', () => {
    const peers = new Map<string, PeerInfo>([
      ['s-dead', peer({ transcriptMtime: NOW - ALIVE_MS - 1, waitingSince: NOW - 1000 })],
      ['s-old', peer({ transcriptMtime: NOW - 20 * 60_000, waitingSince: NOW - WAIT_MAX_MS - 1000 })],
    ])
    const rows = mergeRows({ now: NOW, registry: [reg('dead', 's-dead'), reg('old', 's-old')], published: [], peers, self: null })
    expect(rows.map(r => r.name)).toEqual(['old'])
    expect(rows[0]?.waiting).toBe(null)
  })

  test('a fresh published file wins over the registry launch values; a stale one is ignored', () => {
    const rows = mergeRows({
      now: NOW,
      registry: [reg('lane', 's1'), reg('old', 's2')],
      published: [
        pub('s1', { model: 'claude-sonnet-5-5', effort: 'xhigh', waiting: true, waiting_kind: 'question', busy: false }),
        pub('s2', { updated_at: NOW - FRESH_MS - 1, waiting: true, waiting_kind: 'permission' }),
        pub('hand', { name: null, cwd: 'C:/proj/hand-opened', busy: true }),
      ],
      peers: new Map([['s2', peer({ transcriptMtime: NOW - 1000 })]]),
      self: null,
    })
    const byName = Object.fromEntries(rows.map(r => [r.name, r]))
    expect(byName.lane?.model).toBe('sonnet-5-5')
    expect(byName.lane?.effort).toBe('xhigh')
    expect(byName.lane?.state).toBe('asking')
    expect(byName.lane?.waiting).toBe('question')
    // the stale published file is ignored: the registry-only path decides (transcript fresh, no hook wait)
    expect(byName.old?.waiting).toBe(null)
    // a hand-opened session shows under its folder name
    expect(byName['hand-opened']?.state).toBe('busy')
  })

  test('the current session is marked, takes live values over its registry entry, and sorts waiting first', () => {
    const rows = mergeRows({
      now: NOW,
      registry: [reg('mine', 'me', { effort: 'low' }), reg('other', 's2')],
      published: [pub('s2', { waiting: true, waiting_kind: 'permission' })],
      peers: new Map(),
      self: { ...me, kind: 'question' },
    })
    expect(rows.map(r => r.name)).toEqual(['other', 'mine'])
    const mine = rows.find(r => r.name === 'mine')
    expect(mine?.isSelf).toBe(true)
    expect(mine?.effort).toBe('high')
    expect(mine?.waiting).toBe('question')
    expect(rows.find(r => r.name === 'other')?.isSelf).toBe(false)
  })

  test('summary counts sessions and the waiting ones', () => {
    const row = (waiting: SessionRow['waiting']): SessionRow => ({ id: 'x', name: 'x', isSelf: false, model: '', effort: '', state: stateOf(waiting, false), waiting, goal: null })
    expect(summary([row(null)])).toBe('1 session')
    expect(summary([row(null), row('ask'), row('permission'), row(null), row(null)])).toBe('5 sessions \u00b7 2 waiting')
  })

  test('published files are validated', () => {
    expect(parsePublished('{"session_id":"a","updated_at":5,"waiting":true,"waiting_kind":"ask"}')?.waiting_kind).toBe('ask')
    expect(parsePublished('{"session_id":"a","updated_at":5,"waiting_kind":"bogus"}')?.waiting_kind).toBe(null)
    expect(parsePublished('{"updated_at":5}')).toBe(null)
    expect(parsePublished('nope')).toBe(null)
  })
})

describe('pending calls', () => {
  const call = (id: string, tool: string, input: unknown) => ({ id, tool, sig: callSig(input) })

  test('a permission request pairs with the running call of the same tool and arguments, not an already waiting one', () => {
    const inflight = [call('t1', 'Bash', { command: 'a' }), call('t2', 'Bash', { command: 'b' }), call('t3', 'Read', { file_path: 'x' })]
    expect(pairPermission(inflight, [], 'Bash', callSig({ command: 'b' }))?.id).toBe('t2')
    expect(pairPermission(inflight, [{ id: 't2', kind: 'permission' }], 'Bash', callSig({ command: 'b' }))?.id).toBe('t1')
    expect(pairPermission(inflight, [], 'Write', callSig({}))).toBe(null)
  })

  test('with several candidates and no argument match, the newest running call of that tool gets the dialog', () => {
    const inflight = [call('t1', 'Bash', { command: 'a' }), call('t2', 'Bash', { command: 'b' }), call('t3', 'Bash', { command: 'c' })]
    expect(pairPermission(inflight, [], 'Bash', callSig({ command: 'rewritten' }))?.id).toBe('t3')
    expect(pairPermission(inflight, [{ id: 't3', kind: 'permission' }], 'Bash', callSig({ command: 'rewritten' }))?.id).toBe('t2')
  })

  test('the paired call hands over its agent id', () => {
    const inflight = [{ id: 't1', tool: 'Bash', sig: callSig({}), agentId: 'sub1' }]
    expect(pairPermission(inflight, [], 'Bash', callSig({}))?.agentId).toBe('sub1')
  })

  test('a main turn end removes the main loop entries and old unpaired ones, and keeps a subagent entry', () => {
    const now = 10_000_000
    const pending = [
      { id: 'm', kind: 'permission' as const },
      { id: 's', kind: 'permission' as const, agentId: 'sub1' },
      { id: 'anon-1', kind: 'permission' as const, at: now - ANON_TURN_MS - 1, tool: 'Bash' },
      { id: 'anon-2', kind: 'permission' as const, agentId: 'sub1', at: now - ANON_TURN_MS - 1, tool: 'Bash' },
      { id: 'anon-3', kind: 'permission' as const, agentId: 'sub1', at: now - 1000, tool: 'Bash' },
    ]
    expect(settleTurn(pending, now).map(p => p.id)).toEqual(['s', 'anon-3'])
    expect(settleInflight([{ id: 'a', tool: 'Bash', sig: '' }, { id: 'b', tool: 'Bash', sig: '', agentId: 'sub1' }]).map(c => c.id)).toEqual(['b'])
  })

  test('an unpaired entry expires after 3 minutes or when no running call of its tool remains', () => {
    const now = 10_000_000
    const inflight = [{ id: 't1', tool: 'Bash', sig: '' }]
    const anon = (id: string, tool: string, at: number) => ({ id, kind: 'permission' as const, tool, at })
    const pending = [
      { id: 't1', kind: 'ask' as const },
      anon('anon-1', 'Bash', now - 1000),
      anon('anon-2', 'Bash', now - ANON_MAX_MS - 1),
      anon('anon-3', 'Read', now - 1000),
    ]
    expect(expirePending(pending, inflight, now).map(p => p.id)).toEqual(['t1', 'anon-1'])
  })

  test('an entry whose call is not in flight is removed, paired or not (a subagent entry orphaned by a reload)', () => {
    const now = 10_000_000
    const pending = [
      { id: 'live', kind: 'permission' as const, agentId: 'sub1' },
      { id: 'orphan', kind: 'permission' as const, agentId: 'sub1' },
      { id: 'orphan-ask', kind: 'ask' as const },
    ]
    expect(expirePending(pending, [{ id: 'live', tool: 'Bash', sig: '', agentId: 'sub1' }], now).map(p => p.id)).toEqual(['live'])
    expect(expirePending(pending, [], now)).toEqual([])
  })

  test('the signature ignores key order and the engine reserved keys of a tool.call input', () => {
    expect(callSig({ b: 1, a: { d: 1, c: 2 } })).toBe(callSig({ a: { c: 2, d: 1 }, b: 1 }))
    expect(callSig({ tool: 'Bash', tool_use_id: 't1', command: 'a' }, true)).toBe(callSig({ command: 'a' }))
  })

  test('a call settling clears only its own entry; the kind is permission, then ask, then question', () => {
    const pending = [
      { id: 'a', kind: 'ask' as const },
      { id: 'b', kind: 'permission' as const },
    ]
    expect(liveKind(pending, true)).toBe('permission')
    expect(liveKind(pending.filter(p => p.id !== 'b'), true)).toBe('ask')
    expect(liveKind([], true)).toBe('question')
    expect(liveKind([], false)).toBe(null)
  })

  test('a request a settings hook decided opens no dialog', () => {
    expect(isDecided({})).toBe(false)
    expect(isDecided(undefined)).toBe(false)
    expect(isDecided({ decision: { behavior: 'allow' } })).toBe(true)
  })

  test('the refresh watchdog trips after 30 s', () => {
    expect(isStuck(0, WATCHDOG_MS)).toBe(false)
    expect(isStuck(0, WATCHDOG_MS + 1)).toBe(true)
  })
})

describe('layout', () => {
  const row = (name: string, goal: string | null = '3/9'): SessionRow => ({
    id: name,
    name,
    isSelf: false,
    model: 'opus',
    effort: 'medium',
    state: 'idle',
    waiting: null,
    goal,
  })
  const rows = [row('cw-batchB'), row('property-research-accuracy')]

  test('wide: every column shows', () => {
    const l = layoutColumns(80, rows)
    expect(l.showModel && l.showGoal).toBe(true)
  })

  test('narrowing drops the goal first, then model and effort, before the name is squeezed', () => {
    const wide = layoutColumns(80, rows)
    let sawNoGoalWithModel = false
    let sawNeither = false
    for (let w = 80; w >= 12; w--) {
      const l = layoutColumns(w, rows)
      // a column is never back once a narrower width dropped it
      if (!l.showGoal && l.showModel) sawNoGoalWithModel = true
      if (!l.showGoal && !l.showModel) sawNeither = true
      if (sawNoGoalWithModel) expect(l.showGoal).toBe(false)
      if (sawNeither) expect(l.showModel).toBe(false)
      // the name keeps its minimum while a column can still be dropped
      expect(l.nameW >= 1).toBe(true)
    }
    expect(sawNoGoalWithModel && sawNeither).toBe(true)
    expect(wide.nameW).toBe(26)
    const mid = layoutColumns(35, rows)
    expect(mid.showGoal).toBe(false)
    expect(mid.showModel).toBe(true)
    const narrow = layoutColumns(30, rows)
    expect(narrow.showGoal || narrow.showModel).toBe(false)
    expect(narrow.nameW >= 10).toBe(true)
  })

  test('truncation is by characters and keeps Hebrew letters whole', () => {
    expect(truncateChars('abcdef', 4)).toBe('abc\u2026')
    expect(truncateChars('\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd', 4)).toBe('\u05e9\u05dc\u05d5\u2026')
    expect(truncateChars('\ud83d\ude00\ud83d\ude00\ud83d\ude00', 2)).toBe('\ud83d\ude00\u2026')
    expect(truncateChars('short', 10)).toBe('short')
    expect(truncateChars('a\nb', 10)).toBe('a b')
  })

  test('the project folder key', () => {
    expect(projectKey('C:\\Users\\user\\Desktop\\Projects\\Demo\\.claude\\worktrees\\lane')).toBe(
      'C--Users-user-Desktop-Projects-Demo--claude-worktrees-lane',
    )
    expect(projectKey('C:/Users/user/Desktop/Projects/My_project.v2')).toBe('C--Users-user-Desktop-Projects-My-project-v2')
  })
})

describe('config directory', () => {
  test('CLAUDE_CONFIG_DIR wins; else USERPROFILE, then HOME, plus /.claude; backslashes become slashes', () => {
    expect(claudeDirFrom('D:\\cfg\\claude\\', 'C:\\Users\\user', '/home/user')).toBe('D:/cfg/claude')
    expect(claudeDirFrom(undefined, 'C:\\Users\\user', '/home/user')).toBe('C:/Users/user/.claude')
    expect(claudeDirFrom(undefined, undefined, '/home/user/')).toBe('/home/user/.claude')
    expect(claudeDirFrom('', '', undefined)).toBe(null)
  })

  test('the paths hang off it', () => {
    expect(dirsOf('/h/.claude')).toEqual({
      registry: '/h/.claude/skills/handoff-launch/sessions.jsonl',
      coord: '/h/.claude/state/coord',
      pane: '/h/.claude/state/coord/pane',
      projects: '/h/.claude/projects',
    })
  })
})

describe('lock', () => {
  test('only a person close is refused, and only while locked', () => {
    expect(refusesClose(true, 'person')).toBe(true)
    expect(refusesClose(true, 'plugin')).toBe(false)
    expect(refusesClose(true, 'unload')).toBe(false)
    expect(refusesClose(false, 'person')).toBe(false)
  })

  test('the command words', () => {
    expect(parseCommand('')).toBe('toggle')
    expect(parseCommand('  LOCK ')).toBe('lock')
    expect(parseCommand('unlock')).toBe('unlock')
    expect(parseCommand('wat')).toBe('unknown')
  })
})

// ---- the plugin itself, on the engine, with the world beneath it faked ----

// The calls a refresh makes on `$`, answered from memory. Every hook beneath the plugin is `($, e, next)`.
type World = { writes: Array<{ path: string; text: string }>; surfaces: string[]; sessionId: string; modelGate: Promise<void> | null; surfacesGate: Promise<void> | null; env: Record<string, string> }
const newWorld = (): World => ({ writes: [], surfaces: ['terminal'], sessionId: 'me', modelGate: null, surfacesGate: null, env: { USERPROFILE: 'C:\\Users\\user' } })

function fakeWorld(on: On, opened: string[], w: World = newWorld()): World {
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: opened.length > 0 ? [{ id: 'sessions', title: 'Sessions', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.cwd', () => ({ value: 'C:/x/mine' }))
  on('session.model', async () => {
    if (w.modelGate) await w.modelGate
    return { value: 'opus' }
  })
  on('session.surfaces', async () => {
    const seen = [...w.surfaces]
    if (w.surfacesGate) await w.surfacesGate
    return { value: seen as never }
  })
  on('settings.read', () => ({ value: {} }))
  on('env.get', (_$, e) => ({ value: w.env[e.name] }))
  on('fs.stat', () => ({ deny: 'no fs in the test' }))
  on('fs.list', () => ({ deny: 'no fs in the test' }))
  on('fs.write', (_$, e) => {
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  // $.state in memory (atoms: the rows, the lock, the live flags)
  const state = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_$, e) => {
    const held = state.get(`${e.plugin}/${e.key}`)
    return { value: { value: held?.value, version: held?.version ?? 0 } }
  })
  on('state.set', (_$, e) => {
    const k = `${e.plugin}/${e.key}`
    const version = (state.get(k)?.version ?? 0) + 1
    state.set(k, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  return w
}

const START = { cwd: 'C:/x/mine', surface: 'terminal', isInteractive: true } as const
const written = (w: World, id: string) => w.writes.filter(x => x.path.split('\\').join('/').endsWith(`/${id}.json`)).map(x => JSON.parse(x.text) as Published)

test('/sessions lock persists the lock in the store and opens the pane; unlock clears it', async ($, on) => {
  const clock = mock.clock(on)
  const stored: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: stored[e.key] }))
  on('store.set', (_$, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  const opened: string[] = []
  fakeWorld(on, opened)

  const run = (args: string) =>
    $.command.run({ command: 'sessions', args, origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 200 } } as never)
  const locked = await run('lock')
  await clock.settle()
  expect(String(locked.text)).toMatch(/locked/)
  expect(opened).toEqual(['sessions'])
  expect(stored[LOCK_KEY]).toBe(true)

  // locked and open: a second /sessions does not close it
  const again = await run('')
  expect(String(again.text)).toMatch(/locked open/)

  const unlocked = await run('unlock')
  expect(String(unlocked.text)).toMatch(/unlocked/)
  expect(stored[LOCK_KEY]).toBe(false)
})

test('session.start reopens the pane when the lock was set in an earlier session', async ($, on) => {
  mock.store(on, { [LOCK_KEY]: true })
  const clock = mock.clock(on)
  const opened: string[] = []
  fakeWorld(on, opened)

  await $.session.start(START)
  await clock.settle()
  expect(opened).toEqual(['sessions'])
})

test('session.start leaves the pane closed when it is not locked', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on)
  const opened: string[] = []
  fakeWorld(on, opened)

  await $.session.start(START)
  await clock.settle()
  expect(opened).toEqual([])
})

test('a headless run (no surface) starts no timer and publishes nothing', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on)
  const w = fakeWorld(on, [])
  w.surfaces = []
  await $.session.start(START)
  await clock.advance(20_000)
  expect(w.writes).toEqual([])
})

test('a started session publishes itself, again on the timer, and a final end writes the stale record and stops', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = fakeWorld(on, [])
  await $.session.start(START)
  await clock.settle()
  expect(written(w, 'me').length).toBe(1)
  expect(written(w, 'me')[0]?.updated_at).toBeGreaterThanOrEqual(0)
  await clock.advance(12_000)
  expect(written(w, 'me').length).toBeGreaterThan(1)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'me', resume: { id: 'me' } })
  const n = w.writes.length
  expect(written(w, 'me').at(-1)?.updated_at).toBe(0)
  await clock.advance(60_000)
  // no write lands after the final updated_at 0, and the timer is gone
  expect(w.writes.length).toBe(n)
})

test('/clear keeps the timer: the old id goes stale and the new id publishes', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = fakeWorld(on, [])
  await $.session.start(START)
  await clock.settle()
  expect(written(w, 'me').length).toBe(1)

  await $.session.end({ reason: 'clear', sessionId: 'me', resume: { id: 'me' } })
  expect(written(w, 'me').at(-1)?.updated_at).toBe(0)
  w.sessionId = 'me2'
  await clock.advance(5000)
  expect(written(w, 'me2').length).toBe(1)
  expect((written(w, 'me2')[0]?.updated_at ?? 0) > 0).toBe(true)
  // the old id is not written again
  expect(written(w, 'me').filter(r => r.updated_at > 0).length).toBe(1)
})

test('a permission request waits per call: shown only when no hook decided it, and cleared by its own call settling', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on)
  const w = fakeWorld(on, [])
  let decision: { behavior: 'allow' } | undefined
  on('classic.PermissionRequest', () => (decision ? { decision } : {}))
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('tool.call', async () => {
    await gate
    return { result: 'ok' } as never
  })
  const kinds = () => written(w, 'me').map(r => r.waiting_kind)
  await $.session.start(START)
  await clock.settle()

  // a hook decided: no dialog, no wait
  decision = { behavior: 'allow' }
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'a' } })
  await clock.settle()
  expect(kinds().includes('permission')).toBe(false)

  // nothing decided: a dialog opens while the call is in flight, and ends with that call
  decision = undefined
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'b' } as never)
  await clock.settle()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'b' } })
  await clock.settle()
  expect(kinds().at(-1)).toBe('permission')
  release()
  await call
  await clock.settle()
  expect(kinds().at(-1)).toBe(null)
})

for (const reason of ['clear', 'prompt_input_exit'] as const) {
  test(`a refresh in flight when the session ends (${reason}) cannot republish the old id`, async ($, on) => {
    mock.store(on, {})
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = fakeWorld(on, [])
    await $.session.start(START)
    await clock.settle()
    expect(written(w, 'me').length).toBe(1)

    // the next tick's refresh hangs on session.model; the session ends meanwhile
    let release: () => void = () => undefined
    w.modelGate = new Promise<void>(resolve => {
      release = resolve
    })
    await clock.advance(4000)
    await $.session.end({ reason, sessionId: 'me', resume: { id: 'me' } })
    const afterEnd = w.writes.length
    expect(written(w, 'me').at(-1)?.updated_at).toBe(0)
    release()
    await clock.settle()
    // the orphaned run lands nothing: no write of the old id after the stale record
    expect(w.writes.length).toBe(afterEnd)
  })
}

test('a subagent permission dialog survives the main turn end and clears when its call settles', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = fakeWorld(on, [])
  on('classic.PermissionRequest', () => ({}))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('tool.call', async () => {
    await gate
    return { result: 'ok' } as never
  })
  const kinds = () => written(w, 'me').map(r => r.waiting_kind)
  await $.session.start(START)
  await clock.settle()
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 's1', agentId: 'sub1', command: 'x' } as never)
  await clock.settle()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'x' }, agent_id: 'sub1' } as never)
  await clock.settle()
  expect(kinds().at(-1)).toBe('permission')

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'u1', reason: 'answer' })
  await clock.settle()
  expect(kinds().at(-1)).toBe('permission')

  release()
  await call
  await clock.settle()
  expect(kinds().at(-1)).toBe(null)
})

test('a surface attaching starts a session that began headless', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = fakeWorld(on, [])
  w.surfaces = []
  await $.session.start(START)
  await clock.advance(10_000)
  expect(w.writes).toEqual([])
  w.surfaces = ['terminal']
  await $.session.attach({ surface: 'terminal', clientId: 'c1' })
  await clock.settle()
  expect(written(w, 'me').length).toBe(1)
})

test('a start asked for while the surface check runs gets the check again, so a surface that attached meanwhile starts it', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = fakeWorld(on, [])
  let release: () => void = () => undefined
  w.surfaces = []
  w.surfacesGate = new Promise<void>(resolve => {
    release = resolve
  })
  await $.session.start(START) // its surface check is now waiting on the gate, having seen no surface
  w.surfaces = ['terminal']
  w.surfacesGate = null
  await $.session.attach({ surface: 'terminal', clientId: 'c1' }) // arrives while the first check runs
  release()
  await clock.settle()
  expect(written(w, 'me').length).toBe(1)
})

test('the pane files go under CLAUDE_CONFIG_DIR when it is set', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = fakeWorld(on, [])
  w.env = { CLAUDE_CONFIG_DIR: 'D:\\cfg\\claude', USERPROFILE: 'C:\\Users\\other' }
  await $.session.start(START)
  await clock.settle()
  expect(w.writes.map(x => x.path.split('\\').join('/'))).toEqual(['D:/cfg/claude/state/coord/pane/me.json'])
})

test('with no home or config directory in the environment nothing is read or written', async ($, on) => {
  mock.store(on, {})
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = fakeWorld(on, [])
  w.env = {}
  await $.session.start(START)
  await clock.advance(20_000)
  expect(w.writes).toEqual([])
})

// ---- the pane's drawing: it validates on the terminal and the desktop, shows rows, and drops columns when narrow ----

const paneProps = (bodyColumns: number) => ({
  title: 'Sessions',
  isFocused: false,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
})

test('the pane draws rows with the waiting dot and the lock button, narrow drops columns', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, {})
  const rows: SessionRow[] = [
    { id: 'a', name: 'alpha', isSelf: true, model: 'opus', effort: 'high', state: 'asking', waiting: 'question', goal: '2/5' },
    { id: 'b', name: 'שלום', isSelf: false, model: 'sonnet', effort: 'low', state: 'idle', waiting: null, goal: null },
  ]
  on('state.get', (_$, e) => ({ value: { value: e.key === 'rows' ? rows : false, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const wide = await $.ui.mount({ plugin: 'sessions-pane', surface, component: 'Pane', props: paneProps(70), requestId: 'sessions' })
    expect((await wide.find({ type: 'Text', text: '●' }))?.props.color).toBe('warning')
    expect(await wide.find({ type: 'Text', text: '○' })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: 'opus·high' })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: '2/5' })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: 'שלום' })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: '2 sessions · 1 waiting' })).toBeDefined()
    expect((await wide.find({ key: 'lock' }))?.props.label).toBe('Lock')
    await wide.unmount()

    const narrow = await $.ui.mount({ plugin: 'sessions-pane', surface, component: 'Pane', props: paneProps(30), requestId: 'sessions' })
    expect(await narrow.find({ type: 'Text', text: 'alpha' })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: '2/5' })).toBeUndefined()
    expect(await narrow.find({ type: 'Text', text: 'opus·high' })).toBeUndefined()
    await narrow.unmount()
  }
  await clock.settle()
})

// ---- io against a fake file system ----

const fakeFs = (files: Record<string, { text: string; mtimeMs: number; size?: number }>): Fs => ({
  stat: async path => {
    const f = files[path]
    if (!f) throw new Error('ENOENT')
    return { kind: 'file', size: f.size ?? f.text.length, mtimeMs: f.mtimeMs }
  },
  read: async path => {
    const f = files[path]
    if (!f) throw new Error('ENOENT')
    return f.text
  },
  list: async path => {
    if (path !== DIRS.pane) throw new Error('ENOENT')
    return Object.entries(files)
      .filter(([p]) => p.startsWith(DIRS.pane + '/'))
      .map(([p, f]) => ({ name: p.slice(DIRS.pane.length + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs }))
  },
  write: async () => undefined,
})

describe('io', () => {
  resetCaches()
  test('rows from a registry, a hook state with a goal, and a published hand-opened session', async () => {
    resetCaches()
    const files = {
      [DIRS.registry]: {
        text: launch({ id: 'lane@1', name: 'lane', launched_at: '2026-10-01T00:00:00Z', session_id: 'sid1', worktree: 'C:/w/lane', model: 'opus', effort: 'medium' }),
        mtimeMs: 1,
      },
      'C:/Users/user/.claude/state/coord/sessions/sid1.json': {
        text: JSON.stringify({ waiting_since: new Date(NOW - 20_000).toISOString(), goal_path: 'C:/g/GOAL.md' }),
        mtimeMs: NOW - 20_000,
      },
      'C:/g/GOAL.md': { text: '# g\n- [x] a\n- [ ] b\n', mtimeMs: 5 },
      'C:/Users/user/.claude/projects/C--w-lane/sid1.jsonl': { text: '', mtimeMs: NOW - 60_000 },
      [`${DIRS.pane}/hand.json`]: {
        text: JSON.stringify({ session_id: 'hand', name: 'hand', cwd: 'C:/p/hand', model: 'sonnet', effort: 'low', waiting: true, waiting_kind: 'question', busy: false, updated_at: NOW - 2000 }),
        mtimeMs: NOW - 2000,
      },
    }
    const rows = await collectRows(fakeFs(files), DIRS, NOW, null)
    const lane = rows.find(r => r.name === 'lane')
    expect(lane?.goal).toBe('1/2')
    expect(lane?.waiting).toBe('permission')
    expect(rows.find(r => r.name === 'hand')?.waiting).toBe('question')
  })

  test('publishSelf writes only for a safe session id', async () => {
    const paths: string[] = []
    const fs = { ...fakeFs({}), write: async (p: string) => void paths.push(p) }
    const rec = { session_id: '', name: null, cwd: null, model: null, effort: null, waiting: false, waiting_kind: null, busy: false, updated_at: 1 }
    await publishSelf(fs, DIRS, { ...rec, session_id: '..\evil' })
    await publishSelf(fs, DIRS, { ...rec, session_id: 'a/b' })
    await publishSelf(fs, DIRS, { ...rec, session_id: 'ok-1_2' })
    expect(paths).toEqual([`${DIRS.pane}/ok-1_2.json`])
  })

  test('a registry over 4 MiB is skipped, not an error', async () => {
    resetCaches()
    const files = { [DIRS.registry]: { text: '', mtimeMs: 1, size: 5 * 1024 * 1024 } }
    expect(await collectRows(fakeFs(files), DIRS, NOW, null)).toEqual([])
  })
})
