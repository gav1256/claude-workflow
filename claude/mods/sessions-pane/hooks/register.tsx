import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { LiveCall, LiveState, SessionRow } from '../types'
import { collectRows, publishSelf } from './io'
import type { Fs } from './io'
import {
  LOCK_KEY,
  baseName,
  claudeDirFrom,
  dirsOf,
  dotOf,
  ANON_PREFIX,
  callSig,
  expirePending,
  endsWithQuestion,
  isDecided,
  isStuck,
  liveKind,
  pairPermission,
  settleInflight,
  settleTurn,
  layoutColumns,
  parseCommand,
  refusesClose,
  rowModelEffort,
  selfRecord,
  summary,
  truncateChars,
} from './model'
import type { Dirs, InflightCall, Published, SelfLive } from './model'

const PANE = 'sessions'
const PANE_TITLE = 'Sessions'
const TICK_MS = 4000 // one cheap refresh (file reads only, never the model)
const REPUBLISH_MS = 10_000 // own pane file rewritten at least this often so peers see it as fresh
const MAX_NAME_CHARS = 60

const rows = atom({ plugin: 'sessions-pane', key: 'rows' } as const, [] as SessionRow[])
const isLockedAtom = atom({ plugin: 'sessions-pane', key: 'isLocked' } as const, false)

const liveAtom = atom({ plugin: 'sessions-pane', key: 'live' } as const, {
  model: null,
  effort: null,
  question: false,
  busy: false,
  pending: [],
} as LiveState)

// Refresh bookkeeping that a reload may safely lose. What the session knows about itself (model, effort, the open
// dialogs, the question flag) is in `liveAtom`, so a hot reload keeps it.
const S = {
  settingsEffort: null as string | null,
  dirs: null as Dirs | null, // resolved once from the environment in ensureStarted
  timer: null as Timer | null,
  isStarted: false,
  isStarting: false,
  wantStart: false, // a start was asked for while a check was running
  ended: false, // set by a final session.end: nothing is published after its updated_at 0 record
  runId: 0,
  runStartedAt: 0,
  isRunning: false,
  isAgain: false,
  lastSig: '',
  lastWriteAt: 0,
  lastRows: '',
  lastStatus: undefined as string | undefined,
  lastRecord: null as Published | null,
  anon: 0,
  inflight: [] as InflightCall[], // running tool.calls, to pair a PermissionRequest (which has no tool_use_id) with one
}

// `$` is only ever passed to functions declared at the top of this file (what `claude plugin validate` can follow);
// io.ts takes this plain-function view of `$.fs` instead.
function fsOf($: EngineInterface): Fs {
  return {
    stat: path => $.fs.stat(path),
    read: path => $.fs.read(path),
    list: path => $.fs.list(path),
    write: (path, text) => $.fs.write(path, text),
  }
}

async function isLocked($: EngineInterface): Promise<boolean> {
  return (await $.store.get(LOCK_KEY)) === true
}

async function setLocked($: EngineInterface, value: boolean): Promise<void> {
  await $.store.set(LOCK_KEY, value)
  await update($, isLockedAtom, () => value)
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: PANE_TITLE })
}

// Locked means open: reopen the pane when it is not up (a new session, a reload).
async function ensurePane($: EngineInterface): Promise<void> {
  try {
    if (!(await isLocked($))) return
    if ((await $.ui.panes()).some(p => p.id === PANE)) return
    await openPane($)
  } catch {
    // a refused open leaves the pane closed; the next session start tries again
  }
}

// The config directory from the environment; null (nothing is read or written) when none of the variables is set.
async function resolveDirs($: EngineInterface): Promise<Dirs | null> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const profile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  const dir = claudeDirFrom(config, profile, home)
  return dir === null ? null : dirsOf(dir)
}

async function selfNow($: EngineInterface): Promise<SelfLive> {
  const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
  const live = await read($, liveAtom)
  const model = await $.session.model().catch(() => live.model)
  return {
    id,
    cwd,
    model: model || live.model,
    effort: live.effort ?? S.settingsEffort,
    kind: liveKind(live.pending, live.question),
    busy: live.busy,
  }
}

// One refresh; a second call while one runs only asks for another pass, so refreshes never pile up. A refresh that has
// run for more than WATCHDOG_MS is dead (a hung `$` call): a new one replaces it, and the old one's cleanup is ignored.
async function refresh($: EngineInterface): Promise<void> {
  const dirs = S.dirs
  if (dirs === null) return
  if (S.isRunning) {
    if (!isStuck(S.runStartedAt, Date.now())) {
      S.isAgain = true
      return
    }
  }
  const run = ++S.runId
  S.isRunning = true
  S.runStartedAt = Date.now()
  // A run is current until the session ends or a newer run replaces it; every effect re-checks right before it lands.
  const isCurrent = (): boolean => S.runId === run && !S.ended
  try {
    do {
      S.isAgain = false
      const now = await $.clock.now()
      const before = await read($, liveAtom)
      const kept = expirePending(before.pending, S.inflight, now)
      if (kept.length !== before.pending.length && isCurrent()) {
        await update($, liveAtom, v => ({ ...v, pending: expirePending(v.pending, S.inflight, now) }))
      }
      const self = await selfNow($)
      if (!isCurrent()) return
      const record = selfRecord(self, baseName(self.cwd), now)
      S.lastRecord = record
      const sig = JSON.stringify({ ...record, updated_at: 0 })
      if (sig !== S.lastSig || now - S.lastWriteAt >= REPUBLISH_MS) {
        if (!isCurrent()) return
        await publishSelf(fsOf($), dirs, record)
        S.lastSig = sig
        S.lastWriteAt = now
      }
      const list = await collectRows(fsOf($), dirs, now, self)
      const json = JSON.stringify(list)
      if (json !== S.lastRows) {
        if (!isCurrent()) return
        S.lastRows = json
        await update($, rows, () => list)
      }
      const status = list.length === 0 ? undefined : summary(list)
      if (status !== S.lastStatus) {
        if (!isCurrent()) return
        S.lastStatus = status
        $.ui.status(status)
      }
    } while (S.isAgain && isCurrent())
  } catch {
    // a failed refresh keeps the last rows; the next tick tries again
  } finally {
    if (S.runId === run) S.isRunning = false
  }
}

// Events ask for an immediate refresh; nothing runs before the session is started (and never in a headless run).
function touch($: EngineInterface): void {
  if (S.isStarted) void refresh($)
}

// Starts the timer once. A headless run (no surface drawing: `claude -p`, the SDK) gets no timer and publishes
// nothing; a later event checks again, so a surface that attaches afterwards starts it.
function ensureStarted($: EngineInterface): void {
  if (S.isStarted) return
  if (S.isStarting) {
    S.wantStart = true
    return
  }
  S.isStarting = true
  void (async () => {
    try {
      if ((await $.session.surfaces()).length === 0) return
      const dirs = await resolveDirs($)
      if (dirs === null) return // no config directory to work in: stay quiet, a later event checks again
      S.dirs = dirs
      S.ended = false
      S.isStarted = true
      void $.settings
        .read()
        .then(s => {
          if (typeof s.effortLevel === 'string') S.settingsEffort = s.effortLevel
        })
        .catch(() => undefined) // settings are only a fallback for the effort label
      S.timer = $.clock.every(TICK_MS, () => touch($))
      touch($)
    } catch {
      // the next event tries again
    } finally {
      S.isStarting = false
      // a call that arrived during the check (a surface attached meanwhile) gets one more check
      const again = S.wantStart && !S.isStarted
      S.wantStart = false
      if (again) ensureStarted($)
    }
  })()
}

async function updateLive($: EngineInterface, change: (v: LiveState) => LiveState): Promise<void> {
  await update($, liveAtom, change)
  touch($)
}

// The session ended. `clear` and `resume` keep the process (and so the timer) going under a new session id: the old
// id is published as stale and the signature reset so the new id publishes at the next refresh. Any other reason is
// final: the timer stops and nothing is written after the stale record.
async function endSession($: EngineInterface, reason: string): Promise<void> {
  // Everything that stops a run in flight happens before the first await: a final end blocks every later publish,
  // and either way the run in flight is orphaned (its run id is stale), so it cannot republish the old id.
  const isFinal = reason !== 'clear' && reason !== 'resume'
  const record = S.lastRecord
  if (isFinal) {
    S.ended = true
    S.timer?.cancel()
    S.timer = null
    S.isStarted = false
  }
  S.runId += 1
  S.isRunning = false
  S.isAgain = false
  S.lastRecord = null
  S.lastSig = ''
  S.inflight = []
  if (record && S.dirs) {
    try {
      // a record with updated_at 0 is never fresh: peers drop this session at once
      await publishSelf(fsOf($), S.dirs, { ...record, waiting: false, waiting_kind: null, busy: false, updated_at: 0 })
    } catch {
      // an unwritable file just goes stale on its own
    }
  }
  await update($, liveAtom, v => ({ ...v, question: false, busy: false, pending: [] }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Show or hide the sessions pane; "lock" keeps it open, "unlock" lets it close',
      argumentHint: '[lock|unlock]',
    })
    const locked = await isLocked($)
    await update($, isLockedAtom, () => locked)
    ensureStarted($)
    if (locked) void ensurePane($)
    return next(e)
  })

  on('session.attach', ($, e, next) => {
    ensureStarted($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await endSession($, e.reason)
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    ensureStarted($)
    const cmd = parseCommand(e.args)
    if (cmd === 'lock') {
      await setLocked($, true)
      const opened = await openPane($)
      return { text: opened.isPlaced ? 'Sessions pane locked open.' : `Sessions pane locked; it opens when there is room (${opened.reason}).` }
    }
    if (cmd === 'unlock') {
      await setLocked($, false)
      return { text: 'Sessions pane unlocked: you can close it again.' }
    }
    if (cmd === 'unknown') return { text: 'Usage: /sessions [lock|unlock]' }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      if (await isLocked($)) return { text: 'Sessions pane is locked open. Run /sessions unlock to close it.' }
      await $.ui.close({ id: PANE })
      return { text: 'Sessions pane closed.' }
    }
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Sessions pane opened.' : `Sessions pane waits for room (${opened.reason}).` }
  })

  // A person's close (the pane's mark, ctrl+x x) is refused while locked; the plugin's own close and an unload pass.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (refusesClose(await isLocked($), e.origin.kind)) {
      $.ui.toast('Sessions pane is locked open. Run /sessions unlock to close it.')
      return { deny: 'the sessions pane is locked open' }
    }
    return next(e)
  })

  // ---- what this session knows about itself: model, effort, turn state, and what it waits on ----

  on('prompt.submit', async ($, e, next) => {
    ensureStarted($)
    await updateLive($, v => (v.question ? { ...v, question: false } : v))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    ensureStarted($)
    await updateLive($, v => ({ ...v, busy: true, question: false }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const isQuestion = e.reason === 'answer' && endsWithQuestion(e.answer)
      const now = Date.now()
      S.inflight = settleInflight(S.inflight)
      await updateLive($, v => ({ ...v, busy: false, pending: settleTurn(v.pending, now), question: isQuestion }))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? null : String(e.effort)
      const live = await read($, liveAtom)
      if (live.model !== e.model || (effort !== null && live.effort !== effort)) {
        await update($, liveAtom, v => ({ ...v, model: e.model, effort: effort ?? v.effort }))
      }
    }
    return yield* next(e)
  })

  // A permission dialog is about to show, unless a settings hook decides the request first. It is tracked per call:
  // paired with the running tool.call of the same tool and arguments (PermissionRequest has no tool_use_id), and it
  // ends when that call settles. Known gap: an approved tool that is still running keeps showing as waiting until
  // the call ends, because the engine raises no event for "the dialog was answered".
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    if (!isDecided(result)) {
      const live = await read($, liveAtom)
      const paired = pairPermission(S.inflight, live.pending, e.tool_name, callSig(e.tool_input))
      const entry: LiveCall = paired
        ? { id: paired.id, kind: 'permission', agentId: paired.agentId }
        : { id: `${ANON_PREFIX}${++S.anon}`, kind: 'permission', agentId: e.agent_id, at: Date.now(), tool: e.tool_name }
      await updateLive($, v => ({ ...v, pending: [...v.pending.filter(p => p.id !== entry.id), entry] }))
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const tool = String(e.tool)
    if (id !== undefined) S.inflight.push({ id, tool, sig: callSig(e, true), agentId: e.agentId })
    // The AskUserQuestion call is the dialog itself: it is open for exactly as long as the call is.
    if (id !== undefined && tool === 'AskUserQuestion') {
      await updateLive($, v => ({ ...v, pending: [...v.pending, { id, kind: 'ask', agentId: e.agentId }] }))
    }
    try {
      return await next(e)
    } finally {
      if (id !== undefined) {
        S.inflight = S.inflight.filter(c => c.id !== id)
        // clear only this call's own entry
        const live = await read($, liveAtom)
        if (live.pending.some(p => p.id === id)) {
          await updateLive($, v => ({ ...v, pending: v.pending.filter(p => p.id !== id) }))
        }
      }
    }
  })

  // ---- the pane ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const isLockedNow = await read($, isLockedAtom)
    const layout = layoutColumns(e.props.bodyColumns, list)

    return (
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Text dimColor wrap="truncate-end">
            {list.length === 0 ? 'No sessions seen yet' : summary(list)}
          </Text>
          <Button
            key="lock"
            label={isLockedNow ? 'Unlock' : 'Lock'}
            hotkey="l"
            onPress={async () => {
              const next = !(await isLocked($))
              await setLocked($, next)
              if (next) await ensurePane($)
            }}
          />
        </Box>
        {list.map(r => {
          const dot = dotOf(r.waiting)
          const stateColor = r.waiting === null ? undefined : dot.color
          return (
            <Box columnGap={1}>
              <Box width={1} flexShrink={0}>
                <Text color={dot.color} dimColor={dot.isDim}>
                  {dot.glyph}
                </Text>
              </Box>
              <Box width={1} flexShrink={0}>
                <Text bold>{r.isSelf ? '*' : ' '}</Text>
              </Box>
              <Box width={layout.nameW} flexShrink={0}>
                <Text bold={r.isSelf} wrap="truncate-end">
                  {truncateChars(r.name, MAX_NAME_CHARS)}
                </Text>
              </Box>
              {layout.showModel && (
                <Box width={layout.modelW} flexShrink={0}>
                  <Text dimColor wrap="truncate-end">
                    {rowModelEffort(r)}
                  </Text>
                </Box>
              )}
              <Box width={layout.stateW} flexShrink={0}>
                <Text color={stateColor} dimColor={r.state === 'idle'} wrap="truncate-end">
                  {r.state}
                </Text>
              </Box>
              {layout.showGoal && (
                <Box width={layout.goalW} flexShrink={0}>
                  <Text dimColor wrap="truncate-end">
                    {r.goal ?? '-'}
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
