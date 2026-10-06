import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { Checklist, LiveCall, LiveState, SessionRow, TaskProgress } from '../types'
import { collectRows, publishSelf } from './io'
import type { Fs } from './io'
import { ACCENT, DARK, GREEN, MAGENTA, PANE_HEADER, PINK, cardLayout, cardRows, doneRuns, progressRuns, rowDot, rowStatus, stepLine, titleColors } from './look'
import type { Run } from './look'
import { migrateFromSessionsPane } from './migrate'
import type { MigrationIo } from './migrate'
import { charLength } from './model'
import {
  COLLAPSE_MS,
  EMPTY_CHECKLIST,
  FRAME_MS,
  GENERIC_ERROR,
  GATE_MESSAGE,
  PLAN_TOOL,
  PROGRESS_TOOL,
  REASON_PERMISSION,
  REASON_QUESTION,
  STORE_KEY,
  applyTaskCreate,
  applyTaskUpdate,
  apiErrorSentence,
  applyTodos,
  beginTurn,
  clearNeedsYou,
  completeTurn,
  formatElapsed,
  isHideableTool,
  isRejection,
  isShrunk,
  noteToolOutcome,
  parseCommand as parseSimple,
  passesGate,
  planSteps,
  reportProgress,
  setNeedsYou,
  windowRows,
} from './model-clean'
import type { ToolOutcome, TurnEnd } from './model-clean'
import {
  LOCK_KEY,
  THEME_KEY,
  THEME_ROW,
  themeToastIs,
  themeToastOn,
  themeToastPick,
  TONE,
  applyAnyTaskCall,
  bandLabel,
  bandPressAction,
  findTheme,
  isDefaultTheme,
  themeArg,
  isTaskTool,
  progressFromChecklist,
  progressLabel,
  taskCallOk,
  taskProgress,
  baseName,
  claudeDirFrom,
  dirsOf,
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
  parseCommand as parseSessions,
  refusesClose,
  rowModelEffort,
  selfRecord,
  summary,
  truncateChars,
} from './model-sessions'
import type { Dirs, InflightCall, Published, SelfLive, ThemeName } from './model-sessions'

// One hooks module for the whole plugin. `claude plugin validate` follows `$` only into a function declared in the same
// file (never across an import), so every function that takes `$` lives here, in five sections: State (the atoms), Clean View (the checklist,
// the plan gate, the hidden tool rows), Sessions (the pane, the lock, what this session publishes), the hooks both share
// (registered once each, in a fixed order), and the band they draw in. The pure logic (no `$`) is in `model.ts`,
// `model-clean.ts`, `model-sessions.ts`, `look.ts`, `migrate.ts` and `io.ts`, each with its tests.

// =====================================================================
// State
// =====================================================================

// Everything the drawings read lives in $.state under this plugin's name, so a hot reload keeps it and a drawing that
// reads it redraws when it changes (at the engine's redraw rate, which is the throttle). Both features read each
// other's atoms directly: the sessions rows read the checklist, the band reads both.

// Clean View
export const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, EMPTY_CHECKLIST as Checklist)
export const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)
// The on/off switch. $.store keeps it between sessions; this mirror is what the hooks read, so a draw costs no store
// call. null: not loaded yet.
export const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, null as boolean | null)

// Sessions
export const rowsAtom = atom({ plugin: 'clean-view', key: 'rows' } as const, [] as SessionRow[])
export const isLockedAtom = atom({ plugin: 'clean-view', key: 'isLocked' } as const, false)
// What this session knows about itself (model, effort, the open dialogs, the question flag, its own task list).
export const liveAtom = atom({ plugin: 'clean-view', key: 'live' } as const, {
  model: null,
  effort: null,
  question: false,
  busy: false,
  pending: [],
  tasks: null,
} as LiveState)

// =====================================================================
// Clean View
// =====================================================================

// The Clean View feature: the on/off switch, the checklist (what `band.tsx` draws), the two tools Claude plans and
// reports with, the plan gate, and the hiding of the technical rows. The hooks every feature shares (session, turn,
// tool.call, command.run, the band) are registered once, in `shared.tsx`, which calls the handlers exported here.

const COMMAND_WINDOW_MS = 3000 // a slash command that starts a turn: its command.run is seen this shortly before turn.start

// Bookkeeping a reload may safely lose.
const CV = {
  areToolsReady: false, // both tools registered
  gateArmed: false, // the plan gate and the prompt section go together: armed only when the section was added and both tools exist
  commandAt: null as number | null, // when a command other than /simple or /sessions last ran
  timer: null as Timer | null, // the 250 ms frame clock: runs only while a job is working or a call is running
  collapseTimer: null as Timer | null,
  collapseJob: null as number | null,
  inflight: new Set<string>(), // the main loop's tool calls that are running
  waiting: null as Set<string> | null, // the calls a permission dialog or a question is waiting on
  lastError: null as { kind: string | undefined; text: string } | null, // the API error kind of this turn's StopFailure
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
      description: 'Every step of the job, in order, 2 to 8 short names. Plain English a non-technical person understands, under 40 characters each, starting with a verb. No file paths, file names, commands, code or tool names.',
    },
  },
  required: ['steps'],
}

const PROGRESS_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'The exact name of the step you are working on, as you gave it to plan_steps.' },
    percent: { type: 'number', minimum: 0, maximum: 100, description: 'How far along that step is, 0 to 100. Use 100 the moment the step is finished.' },
  },
  required: ['task', 'percent'],
}

const PROMPT_SECTION = [
  '# Clean View',
  'The person in this session is not technical. Tool calls, file changes and command output are hidden from them; all they see is one simple checklist above the prompt. Keep that checklist true.',
  `- For every request, even a quick question, call ${PLAN_TOOL} first, before any other tool, with every step of the job in order (2 to 8 steps). If that tool is deferred, load it with ToolSearch first. Until a plan exists, other tools are refused. If this session has TodoWrite or TaskCreate, its to-do list can be the plan instead.`,
  '- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
  `- Then call ${PROGRESS_TOOL} with the exact step name and a percent from 0 to 100 as real progress happens, and with 100 the moment a step finishes. Finishing a step starts the next one.`,
  '- If you are a subagent, ignore this section.',
].join('\n')

// ---------- the switch ----------

async function storedOn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(STORE_KEY)) !== false // no value means on: Clean View starts on
  } catch {
    return true
  }
}

// Reads the saved switch into the mirror, once: a later call keeps what is there.
async function loadEnabled($: EngineInterface): Promise<void> {
  if ((await read($, enabledAtom)) !== null) return
  const value = await storedOn($)
  await update($, enabledAtom, v => (v === null ? value : v))
}

// The hooks' read. Before the mirror is loaded (a hot reload in a session that started without it) one store read
// answers, without writing the mirror from inside a draw.
async function isOn($: EngineInterface): Promise<boolean> {
  const v = await read($, enabledAtom)
  return v !== null ? v : storedOn($)
}

// The switch moves first, so it always works; saving it is best effort. Turning it off ends the job and stops the timers.
async function setOn($: EngineInterface, value: boolean): Promise<void> {
  await update($, enabledAtom, () => value)
  if (!value) {
    CV.gateArmed = false
    await resetAll($)
  }
  $.ui.invalidate('ui.render')
  try {
    await $.store.set(STORE_KEY, value)
  } catch {
    // not saved: it holds for this session and the next start reads the old value
  }
}

async function flip($: EngineInterface): Promise<boolean> {
  const next = !(await isOn($))
  await setOn($, next)
  $.ui.toast(next ? 'Clean View is on' : 'Clean View is off')
  return next
}

// Registers the two tools once per module copy. The shared ensureSetup calls this at session.start, session.attach and
// turn.start, so a copy that missed it (a hot reload, a refused first try) still registers by the next turn. Until both
// tools exist the plan gate stays open.
async function ensureTools($: EngineInterface): Promise<void> {
  if (CV.areToolsReady) return
  try {
    await registerTools($)
    CV.areToolsReady = true
  } catch {
    // refused or early: the next event tries again
  }
}

async function registerTools($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'plan_steps',
    description:
      'Lay out every step of the job up front, in order, 2 to 8 short plain-English names a non-technical person understands (under 40 characters, starting with a verb; no file paths, file names, commands, code or tool names). The first step starts right away. Call this first for every request, even a quick question.',
    inputSchema: PLAN_SCHEMA,
  })
  await $.tool.register({
    name: 'report_progress',
    description:
      'Report how far along the current step is, by its exact step name and a percent from 0 to 100. Call it as real progress happens and with 100 the moment a step finishes; the next step then starts by itself.',
    inputSchema: PROGRESS_SCHEMA,
  })
}

// ---------- the checklist ----------

// Everything that moves the checklist goes through here: one update, then the frame clock and the collapse timer follow
// the phase it landed in.
async function change($: EngineInterface, fn: (cl: Checklist, now: number) => Checklist): Promise<Checklist> {
  const now = await $.clock.now()
  await update($, checklistAtom, cl => fn(cl, now))
  const cl = await read($, checklistAtom)
  syncTimers($, cl)
  return cl
}

// The meter moves while Claude is working, or while a call is running (one a permission dialog holds counts). A turn that
// ended and waits on the person, a stuck or stopped job and an idle session stand still.
function isAnimating(cl: Checklist): boolean {
  return cl.phase === 'working' || (cl.phase === 'needsYou' && CV.inflight.size > 0)
}

async function tick($: EngineInterface): Promise<void> {
  const cl = await read($, checklistAtom)
  if (!isAnimating(cl)) {
    syncTimers($, cl) // a frame that finds nothing to animate stops the clock
    return
  }
  await update($, tickAtom, n => n + 1)
}

// The frame clock runs only while there is something to animate; the collapse timer only while a finished job waits to
// shrink. An idle session has neither.
function syncTimers($: EngineInterface, cl: Checklist): void {
  const wantsFrames = isAnimating(cl)
  if (wantsFrames && CV.timer === null) CV.timer = $.clock.every(FRAME_MS, () => void tick($))
  if (!wantsFrames && CV.timer !== null) {
    CV.timer.cancel()
    CV.timer = null
  }
  const wantsCollapse = cl.phase === 'done' && !cl.isCollapsed
  if (wantsCollapse && CV.collapseJob !== cl.jobId) {
    CV.collapseTimer?.cancel()
    const job = cl.jobId
    CV.collapseJob = job
    CV.collapseTimer = $.clock.after(COLLAPSE_MS, () => void collapse($, job))
  }
  if (!wantsCollapse && CV.collapseTimer !== null) {
    CV.collapseTimer.cancel()
    CV.collapseTimer = null
    CV.collapseJob = null
  }
}

// A late timer for an older job does nothing.
async function collapse($: EngineInterface, job: number): Promise<void> {
  CV.collapseTimer = null
  CV.collapseJob = null
  await change($, cl => (cl.phase === 'done' && cl.jobId === job ? { ...cl, isCollapsed: true } : cl))
}

async function resetAll($: EngineInterface): Promise<void> {
  CV.inflight.clear()
  CV.waiting = null
  CV.lastError = null
  await update($, checklistAtom, () => EMPTY_CHECKLIST)
  await update($, tickAtom, () => 0)
  syncTimers($, EMPTY_CHECKLIST)
}

const reply = (s: string) => ({ result: s })

// A permission dialog or a question is waiting: switch to Needs you, and clear it when the calls it waits on have ended.
async function holdForPerson($: EngineInterface, reason: string, extra?: string): Promise<void> {
  CV.waiting = new Set([...CV.inflight, ...(extra === undefined ? [] : [extra])])
  await change($, cl => setNeedsYou(cl, reason))
}

// One main-loop call has ended: when none of the calls the dialog waited on is left, the person-wait is over.
async function releaseCall($: EngineInterface, id: string): Promise<void> {
  CV.inflight.delete(id)
  if (CV.waiting === null) return
  CV.waiting.delete(id)
  if (CV.waiting.size === 0) {
    CV.waiting = null
    await change($, cl => clearNeedsYou(cl))
  }
}

// What a main-loop call came to. A "no" at the permission dialog arrives as an error whose text the model read (`text`, set by the
// engine; else the result when it is text). A `deny` is another plugin's or a rule's answer, and the event cannot say it was
// the person's, so it counts as a failure and never as "you said no".
function outcomeOf(ran: { deny?: string; isError?: true | undefined; text?: string | undefined; result?: unknown } | undefined): ToolOutcome | null {
  if (ran === undefined) return null
  if (ran.deny !== undefined) return 'failed'
  if (ran.isError === true) return isRejection(ran.text ?? (typeof ran.result === 'string' ? ran.result : '')) ? 'rejected' : 'failed'
  return 'ok'
}


// ---------- the handlers `shared.tsx` calls from the hooks both features share ----------

// /clear and every other end: the job belongs to the session that is gone.
async function cleanSessionEnd($: EngineInterface): Promise<void> {
  await resetAll($)
}

// `/simple on|off`: the command's own answer.
async function runSimple($: EngineInterface, args: string | readonly string[] | undefined): Promise<{ text: string }> {
  const cmd = parseSimple(args)
  if (cmd === 'unknown') return { text: 'Usage: /simple [on|off]' }
  const was = await isOn($)
  const now = cmd === 'toggle' ? !was : cmd === 'on'
  await setOn($, now)
  const message = now ? 'Clean View is on' : 'Clean View is off'
  $.ui.toast(message)
  return { text: message }
}

// Any other slash command (a skill's too) may start a turn: the turn that follows has no job of its own.
async function noteOtherCommand($: EngineInterface): Promise<void> {
  CV.commandAt = await $.clock.now()
}

async function cleanTurnStart($: EngineInterface, text: string): Promise<void> {
  await loadEnabled($)
  CV.lastError = null
  if (await isOn($)) {
    // a slash command's turn, or a skill's (its command.run was just seen): no job, and no plan is asked for
    const at = CV.commandAt
    const isCommand = text.trim().startsWith('/') || (at !== null && (await $.clock.now()) - at < COMMAND_WINDOW_MS)
    CV.commandAt = null
    await change($, (cl, now) => beginTurn(cl, text, now, isCommand))
  }
}

async function cleanTurnComplete($: EngineInterface, e: { agentId?: string | undefined; reason: TurnEnd['reason'] }): Promise<void> {
  if (e.agentId === undefined && (await isOn($))) {
    const error = CV.lastError
    CV.lastError = null
    CV.waiting = null
    CV.inflight.clear() // nothing of this turn is still running
    await change($, (cl, now) => completeTurn(cl, { reason: e.reason, errorKind: error?.kind, text: error?.text ?? '' }, now))
  }
}

// What a tool.call hook does before the call runs: answer Clean View's own two tools, or refuse a tool until a plan exists.
// null: carry on (the call is the engine's).
async function cleanBeforeCall(
  $: EngineInterface,
  e: { tool: unknown; agentId?: string | undefined },
): Promise<{ result: string } | { deny: string } | null> {
  const tool = String(e.tool)
  if (tool === PLAN_TOOL || tool === PROGRESS_TOOL) {
    // a subagent's call, or one with Clean View off, is answered and changes nothing
    const isMain = e.agentId === undefined && (await isOn($))
    if (tool === PLAN_TOOL) {
      const steps = (e as { steps?: unknown }).steps
      if (!isMain) return reply(`Planned ${Array.isArray(steps) ? steps.length : 0} steps. The first one has started.`)
      let count = 0
      await change($, (cl, now) => {
        const r = planSteps(cl, steps, now)
        count = r.count
        return r.checklist
      })
      if (count === 0) return reply('No steps were given. Call plan_steps again with 2 to 8 short plain-English step names.')
      return reply(`Planned ${count} steps. The first one has started.`)
    }
    const input = e as { task?: unknown; percent?: unknown }
    if (!isMain) return reply('Progress noted.')
    if (CV.gateArmed && !(await read($, checklistAtom)).hasPlan) return { deny: GATE_MESSAGE } // a report needs a plan to report against
    let percent = 0
    await change($, (cl, now) => {
      const r = reportProgress(cl, input.task, input.percent, now)
      percent = r.percent
      return r.checklist
    })
    return reply(`Progress noted: ${percent}%.`)
  }

  if (e.agentId !== undefined || !(await isOn($))) return null
  // until a real plan exists, every other tool is refused (the few that make or stand for a plan always pass)
  const cl = await read($, checklistAtom)
  if (CV.gateArmed && !cl.hasPlan && !passesGate(tool)) return { deny: GATE_MESSAGE }
  return null
}

// The call is going to run (it passed the gate): a main-loop call of a session with Clean View on is tracked. Returns the
// id to hand to `cleanAfterCall`, or null for a call that is not tracked.
async function cleanBeginCall($: EngineInterface, e: { tool: unknown; agentId?: string | undefined; tool_use_id: string }): Promise<string | null> {
  if (e.agentId !== undefined || !(await isOn($))) return null
  // the next tool to run ends a wait on the person that no running call is part of
  if (CV.waiting !== null && CV.waiting.size === 0) {
    CV.waiting = null
    await change($, c => clearNeedsYou(c))
  }
  const id = e.tool_use_id
  CV.inflight.add(id)
  if (String(e.tool) === 'AskUserQuestion') await holdForPerson($, REASON_QUESTION, id)
  return id
}

// The call settled: its wait on the person is over, and it counts as a success, a failure or a "no". Bookkeeping never
// changes what the call returns.
async function cleanAfterCall(
  $: EngineInterface,
  e: unknown,
  id: string,
  ran: { deny?: string; isError?: true | undefined; text?: string | undefined; result?: unknown } | undefined,
): Promise<void> {
  try {
    await releaseCall($, id)
    const outcome = outcomeOf(ran)
    const ok = outcome === 'ok'
    const tool = String((e as { tool: unknown }).tool)
    await change($, (before, now) => {
      let c = before
      if (ok && tool === 'TodoWrite') c = applyTodos(c, e, now)
      else if (ok && tool === 'TaskCreate') c = applyTaskCreate(c, e, ran?.result, now)
      else if (ok && tool === 'TaskUpdate') c = applyTaskUpdate(c, e, now)
      return outcome === null ? c : noteToolOutcome(c, outcome)
    })
  } catch {
    // bookkeeping never changes what the call returns
  }
}

// ---------- the hooks only this feature has ----------

export function registerCleanView(on: On): void {
  // While Clean View is on, Claude is told to plan first and to report plainly.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // no checklist can be drawn in a headless run (print, no surface), and the other kinds of render are not the person's
    const isHeadless = e.traits.includes('print') || e.surfaces.length === 0
    if (isHeadless) CV.gateArmed = false
    if (isHeadless || e.traits.includes('bare') || e.traits.includes('analysis') || e.traits.includes('sdk-preset') || e.traits.includes('teammate') || !(await isOn($))) {
      return composed
    }
    // the gate and the section go together: Claude is refused tools only when it was told how to get them, and the tools exist
    CV.gateArmed = CV.areToolsReady
    return { sections: [...composed.sections, { id: 'clean-view:plan', text: PROMPT_SECTION, scope: 'session' as const }] }
  })

  // The kind of an API error, as Claude Code classifies it; turn.complete turns it into one calm sentence.
  on('classic.StopFailure', async ($, e, next) => {
    // the kind first, then the details; the model's own words (last_assistant_message) never decide anything
    CV.lastError = { kind: e.error, text: e.error_details ?? '' }
    const sentence = apiErrorSentence(e.error, e.error_details ?? '')
    // if the turn already ended with the generic sentence, this is the news that sharpens it
    await change($, cl => (cl.phase === 'stuck' && cl.stuckReason === GENERIC_ERROR ? { ...cl, stuckReason: sentence } : cl))
    return next(e)
  }).catch(($, e, next) => next(e)) // only observes: a failure here lets the event through unchanged

  // A permission dialog or a question dialog is about to wait on the person.
  on('classic.Notification', async ($, e, next) => {
    if (await isOn($)) {
      if (e.notification_type === 'permission_prompt') await holdForPerson($, REASON_PERMISSION)
      else if (e.notification_type === 'elicitation_dialog') await holdForPerson($, REASON_QUESTION)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // only observes: a failure here lets the event through unchanged

  // ---- drawing: the technical rows ----

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    // an errored row is shown, except the gate's own refusal, which is a message to Claude
    const isGate = p.isErrored && p.output === GATE_MESSAGE
    if ((p.isErrored && !isGate) || p.isInterrupted || !isHideableTool(p.tool) || !(await isOn($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const p = e.props
    // a refusal or an abort arrives as text: that is read in full. The answers of the two tools below are text too, and are hidden.
    const isOwn = p.tool === PLAN_TOOL || p.tool === PROGRESS_TOOL
    const isText = typeof p.output !== 'object' || p.output === null
    const isGate = p.isErrored && p.output === GATE_MESSAGE
    if ((p.isErrored && !isGate) || !isHideableTool(p.tool) || (isText && !isOwn && !isGate) || !(await isOn($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const calls = e.props.calls
    if (calls.length === 0 || !calls.every(c => isHideableTool(c.tool) && !c.isErrored && !c.isInterrupted) || !(await isOn($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // the "ctrl+b to run in background" hint under a running call
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (e.props.kind !== 'background_hint' || !(await isOn($))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })
}

// =====================================================================
// Sessions
// =====================================================================

// The Sessions feature: the pane that lists the running sessions, the lock, what this session publishes about itself for
// the other sessions' panes, and the theme offer. The hooks every feature shares (session, turn, tool.call,
// command.run, the band) are registered once, in `shared.tsx`, which calls the handlers exported here.

const PANE = 'sessions'
const TICK_MS = 4000 // one cheap refresh (file reads only, never the model)
const REPUBLISH_MS = 10_000 // own pane file rewritten at least this often so peers see it as fresh
const MAX_NAME_CHARS = 60

// Refresh bookkeeping that a reload may safely lose. What the session knows about itself (model, effort, the open
// dialogs, the question flag) is in `liveAtom`, so a hot reload keeps it.
const SS = {
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
  try {
    return (await $.store.get(LOCK_KEY)) === true
  } catch {
    return false
  }
}

async function setLocked($: EngineInterface, value: boolean): Promise<void> {
  await $.store.set(LOCK_KEY, value)
  await update($, isLockedAtom, () => value)
  $.ui.invalidate('ui.render')
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Sessions' })
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

// The saved lock into its mirror, and the pane reopened when it was left locked.
async function syncLock($: EngineInterface): Promise<void> {
  const locked = await isLocked($)
  await update($, isLockedAtom, () => locked)
  if (locked) void ensurePane($)
}

// A press of the band control, the Session Viewer button (or a click on one): open a closed pane, close an open one unless
// it is locked. A press is the person's own ask, so the open is placed at any width.
async function toggleFromBand($: EngineInterface): Promise<void> {
  try {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
    const action = bandPressAction(isOpen, await isLocked($))
    if (action === 'locked') {
      $.ui.toast('Sessions pane is locked')
      return
    }
    if (action === 'close') {
      await $.ui.close({ id: PANE })
      return
    }
    const opened = await openPane($)
    if (!opened.isPlaced) $.ui.toast(`Sessions pane waits for room (${opened.reason})`)
  } catch {
    // a refused press leaves the pane as it was
  }
}

// The pane's own Close button: the same rule as the lock gives a person's close.
async function closeFromPane($: EngineInterface): Promise<void> {
  try {
    if (await isLocked($)) {
      $.ui.toast('Sessions pane is locked')
      return
    }
    await $.ui.close({ id: PANE })
  } catch {
    // a refused close leaves the pane as it was
  }
}

// The pane's Lock button flips the lock; locking reopens a closed pane.
async function flipLock($: EngineInterface): Promise<void> {
  try {
    const next = !(await isLocked($))
    await setLocked($, next)
    if (next) await ensurePane($)
  } catch {
    // an unsaved lock leaves it as it was
  }
}

// Offers a theme (Clean View Dark first, Warm when asked for): finds the theme row of /config and this mod's option for
// it. On its own it sets the theme only over the default (`dark` or unset), so a theme the person chose is never
// replaced; with an asked-for run (`/sessions theme [dark|warm]`) it sets it whatever the theme is. When the engine
// refuses, or on any other theme, it says how to pick it. Run on its own once (the `themeOffered` flag is set before the
// attempt, so nothing retries). Returns the sentence it shows.
async function offerTheme($: EngineInterface, isForced: boolean, name: ThemeName = 'dark'): Promise<string | null> {
  try {
    if (!isForced && (await $.store.get(THEME_KEY)) === true) return null
    await $.store.set(THEME_KEY, true)
    let message = themeToastPick(name)
    try {
      const row = (await $.config.list()).find(r => r.key === THEME_ROW)
      const option = findTheme(name, row?.options)
      if (row !== undefined && option !== undefined) {
        if (row.value === option) {
          message = themeToastIs(name)
        } else if (isForced || isDefaultTheme(row.value)) {
          const result = await $.config.set({ key: THEME_ROW, value: option })
          if (result.deny === undefined) message = themeToastOn(name)
        }
      }
    } catch {
      // not listed or refused: the message tells the person to pick it
    }
    return message
  } catch {
    return null
  }
}

// The config directory from the environment; null (nothing is read or written) when none of the variables is set.
async function resolveDirs($: EngineInterface): Promise<{ dirs: Dirs; claudeDir: string } | null> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const profile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  const dir = claudeDirFrom(config, profile, home)
  return dir === null ? null : { dirs: dirsOf(dir), claudeDir: dir }
}

// The one-time move of the old sessions-pane mod's saved values (see migrate.ts), over `$`.
async function runMigration($: EngineInterface, claudeDir: string | null): Promise<void> {
  const io: MigrationIo = {
    claudeDir,
    getStore: key => $.store.get(key),
    setStore: (key, value) => $.store.set(key, value),
    list: path => $.fs.list(path),
    read: path => $.fs.read(path),
    themeRow: async () => {
      const row = (await $.config.list()).find(r => r.key === THEME_ROW)
      return row === undefined ? null : { value: row.value, options: row.options }
    },
  }
  await migrateFromSessionsPane(io)
}

// This session's checklist (the checklist atom of this plugin) is the first source of its task progress: it follows
// plan_steps, report_progress, TodoWrite and TaskCreate. It is live only while Clean View is on (its switch is not false;
// null means not loaded yet) and the checklist is not idle. With Clean View off the session's own list (TodoWrite,
// TaskCreate/TaskUpdate, tracked in the tool.call hook) is the fallback.
async function checklistTasks($: EngineInterface): Promise<TaskProgress | null> {
  try {
    if ((await read($, enabledAtom)) === false) return null
    return progressFromChecklist(await read($, checklistAtom))
  } catch {
    return null
  }
}

async function selfNow($: EngineInterface): Promise<SelfLive> {
  const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
  const live = await read($, liveAtom)
  const model = await $.session.model().catch(() => live.model)
  return {
    id,
    cwd,
    model: model || live.model,
    effort: live.effort ?? SS.settingsEffort,
    kind: liveKind(live.pending, live.question),
    busy: live.busy,
    tasks: (await checklistTasks($)) ?? taskProgress(live.tasks),
  }
}

// One refresh; a second call while one runs only asks for another pass, so refreshes never pile up. A refresh that has
// run for more than WATCHDOG_MS is dead (a hung `$` call): a new one replaces it, and the old one's cleanup is ignored.
async function refresh($: EngineInterface): Promise<void> {
  const dirs = SS.dirs
  if (dirs === null) return
  if (SS.isRunning) {
    if (!isStuck(SS.runStartedAt, Date.now())) {
      SS.isAgain = true
      return
    }
  }
  const run = ++SS.runId
  SS.isRunning = true
  SS.runStartedAt = Date.now()
  // A run is current until the session ends or a newer run replaces it; every effect re-checks right before it lands.
  const isCurrent = (): boolean => SS.runId === run && !SS.ended
  try {
    do {
      SS.isAgain = false
      const now = await $.clock.now()
      const before = await read($, liveAtom)
      const kept = expirePending(before.pending, SS.inflight, now)
      if (kept.length !== before.pending.length && isCurrent()) {
        await update($, liveAtom, v => ({ ...v, pending: expirePending(v.pending, SS.inflight, now) }))
      }
      const self = await selfNow($)
      if (!isCurrent()) return
      const record = selfRecord(self, baseName(self.cwd), now)
      SS.lastRecord = record
      const sig = JSON.stringify({ ...record, updated_at: 0 })
      if (sig !== SS.lastSig || now - SS.lastWriteAt >= REPUBLISH_MS) {
        if (!isCurrent()) return
        await publishSelf(fsOf($), dirs, record)
        SS.lastSig = sig
        SS.lastWriteAt = now
      }
      const list = await collectRows(fsOf($), dirs, now, self)
      const json = JSON.stringify(list)
      if (json !== SS.lastRows) {
        if (!isCurrent()) return
        SS.lastRows = json
        await update($, rowsAtom, () => list)
      }
      const status = list.length === 0 ? undefined : summary(list)
      if (status !== SS.lastStatus) {
        if (!isCurrent()) return
        SS.lastStatus = status
        $.ui.status(status)
      }
    } while (SS.isAgain && isCurrent())
  } catch {
    // a failed refresh keeps the last rows; the next tick tries again
  } finally {
    if (SS.runId === run) SS.isRunning = false
  }
}

// Events ask for an immediate refresh; nothing runs before the session is started (and never in a headless run).
function touch($: EngineInterface): void {
  if (SS.isStarted) void refresh($)
}

// Starts the timer once. A headless run (no surface drawing: `claude -p`, the SDK) gets no timer, publishes nothing and
// moves no saved value; a later event checks again, so a surface that attaches afterwards starts it.
function ensureStarted($: EngineInterface): void {
  if (SS.isStarted) return
  if (SS.isStarting) {
    SS.wantStart = true
    return
  }
  SS.isStarting = true
  void (async () => {
    try {
      if ((await $.session.surfaces()).length === 0) return
      // A surface is drawing (never a headless run): carry over what the sessions-pane mod saved, once, then offer the
      // Clean View Dark theme once.
      const found = await resolveDirs($)
      await runMigration($, found === null ? null : found.claudeDir)
      await syncLock($) // the move may have brought a lock
      void offerTheme($, false).then(message => {
        if (message !== null) $.ui.toast(message)
      })
      if (found === null) return // no config directory to work in: stay quiet, a later event checks again
      SS.dirs = found.dirs
      SS.ended = false
      SS.isStarted = true
      void $.settings
        .read()
        .then(s => {
          if (typeof s.effortLevel === 'string') SS.settingsEffort = s.effortLevel
        })
        .catch(() => undefined) // settings are only a fallback for the effort label
      SS.timer = $.clock.every(TICK_MS, () => touch($))
      touch($)
    } catch {
      // the next event tries again
    } finally {
      SS.isStarting = false
      // a call that arrived during the check (a surface attached meanwhile) gets one more check
      const again = SS.wantStart && !SS.isStarted
      SS.wantStart = false
      if (again) ensureStarted($)
    }
  })()
}

async function updateLive($: EngineInterface, change: (v: LiveState) => LiveState): Promise<void> {
  await update($, liveAtom, change)
  touch($)
}

// ---------- the handlers `shared.tsx` calls from the hooks both features share ----------

async function sessionsStart($: EngineInterface): Promise<void> {
  await syncLock($)
  ensureStarted($)
}

function sessionsAttach($: EngineInterface): void {
  ensureStarted($)
}

// The session ended. `clear` and `resume` keep the process (and so the timer) going under a new session id: the old
// id is published as stale and the signature reset so the new id publishes at the next refresh. Any other reason is
// final: the timer stops and nothing is written after the stale record.
async function sessionsEnd($: EngineInterface, reason: string): Promise<void> {
  // Everything that stops a run in flight happens before the first await: a final end blocks every later publish,
  // and either way the run in flight is orphaned (its run id is stale), so it cannot republish the old id.
  const isFinal = reason !== 'clear' && reason !== 'resume'
  const record = SS.lastRecord
  if (isFinal) {
    SS.ended = true
    SS.timer?.cancel()
    SS.timer = null
    SS.isStarted = false
  }
  SS.runId += 1
  SS.isRunning = false
  SS.isAgain = false
  SS.lastRecord = null
  SS.lastSig = ''
  SS.inflight = []
  if (record && SS.dirs) {
    try {
      // a record with updated_at 0 is never fresh: peers drop this session at once
      await publishSelf(fsOf($), SS.dirs, { ...record, waiting: false, waiting_kind: null, busy: false, updated_at: 0 })
    } catch {
      // an unwritable file just goes stale on its own
    }
  }
  await update($, liveAtom, v => ({ ...v, question: false, busy: false, pending: [], tasks: null }))
}

// `/sessions`, `/sessions lock|unlock|theme`: the command's own answer.
async function runSessions($: EngineInterface, args: string): Promise<{ text: string }> {
  ensureStarted($)
  const cmd = parseSessions(args)
  if (cmd === 'lock') {
    await setLocked($, true)
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Sessions pane locked open.' : `Sessions pane locked; it opens when there is room (${opened.reason}).` }
  }
  if (cmd === 'unlock') {
    await setLocked($, false)
    return { text: 'Sessions pane unlocked: you can close it again.' }
  }
  if (cmd === 'theme') {
    const name = themeArg(args)
    return { text: (await offerTheme($, true, name)) ?? themeToastPick(name) }
  }
  if (cmd === 'unknown') return { text: 'Usage: /sessions [lock|unlock|theme [dark|warm]]' }
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    if (await isLocked($)) return { text: 'Sessions pane is locked open. Run /sessions unlock to close it.' }
    await $.ui.close({ id: PANE })
    return { text: 'Sessions pane closed.' }
  }
  const opened = await openPane($)
  return { text: opened.isPlaced ? 'Sessions pane opened.' : `Sessions pane waits for room (${opened.reason}).` }
}

async function sessionsTurnStart($: EngineInterface): Promise<void> {
  ensureStarted($)
  await updateLive($, v => ({ ...v, busy: true, question: false }))
}

async function sessionsTurnComplete($: EngineInterface, e: { agentId?: string | undefined; reason: string; answer?: string }): Promise<void> {
  if (e.agentId === undefined) {
    const isQuestion = e.reason === 'answer' && endsWithQuestion(e.answer)
    const now = Date.now()
    SS.inflight = settleInflight(SS.inflight)
    await updateLive($, v => ({ ...v, busy: false, pending: settleTurn(v.pending, now), question: isQuestion }))
  }
}

type Ran = { deny?: string; isError?: true | undefined; text?: string | undefined; result?: unknown }

// The call is going to run: it is tracked so a PermissionRequest (which has no tool_use_id) can be paired with it, and an
// AskUserQuestion call is the dialog itself: open for exactly as long as the call is.
async function sessionsBeginCall($: EngineInterface, e: { tool: unknown; tool_use_id?: string | undefined; agentId?: string | undefined }): Promise<void> {
  const id = e.tool_use_id
  const tool = String(e.tool)
  if (id !== undefined) SS.inflight.push({ id, tool, sig: callSig(e, true), agentId: e.agentId })
  if (id !== undefined && tool === 'AskUserQuestion') {
    await updateLive($, v => ({ ...v, pending: [...v.pending, { id, kind: 'ask', agentId: e.agentId }] }))
  }
}

// The call settled: the main loop's own task list moves, and the call's own dialog entry goes. Bookkeeping never changes
// what the call returns.
async function sessionsAfterCall($: EngineInterface, e: { tool: unknown; tool_use_id?: string | undefined; agentId?: string | undefined }, ran: Ran | undefined): Promise<void> {
  const tool = String(e.tool)
  const id = e.tool_use_id
  // The main loop's own task list (a subagent's calls are not this session's progress).
  if (e.agentId === undefined && isTaskTool(tool) && ran !== undefined && ran.deny === undefined && ran.isError !== true && taskCallOk(ran.result)) {
    try {
      const result = ran.result
      await updateLive($, v => ({ ...v, tasks: applyAnyTaskCall(v.tasks ?? null, tool, e, result) }))
    } catch {
      // counting is no gate: a failure here leaves the list as it was
    }
  }
  if (id !== undefined) {
    try {
      SS.inflight = SS.inflight.filter(c => c.id !== id)
      // clear only this call's own entry
      const live = await read($, liveAtom)
      if (live.pending.some(p => p.id === id)) {
        await updateLive($, v => ({ ...v, pending: v.pending.filter(p => p.id !== id) }))
      }
    } catch {
      // bookkeeping never changes what the call returns
    }
  }
}

// ---------- the hooks only this feature has ----------

export function registerSessions(on: On): void {
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
      const paired = pairPermission(SS.inflight, live.pending, e.tool_name, callSig(e.tool_input))
      const entry: LiveCall = paired
        ? { id: paired.id, kind: 'permission', agentId: paired.agentId }
        : { id: `${ANON_PREFIX}${++SS.anon}`, kind: 'permission', agentId: e.agent_id, at: Date.now(), tool: e.tool_name }
      await updateLive($, v => ({ ...v, pending: [...v.pending.filter(p => p.id !== entry.id), entry] }))
    }
    return result
  })

  // ---- the pane ----

  // The panel: a spaced-caps header with a thin rule, one row per session (dot, name, model and effort, a segmented
  // meter, a status word), and a footer with the Lock toggle and Close.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rowsAtom)
    const isLockedNow = await read($, isLockedAtom)
    const width = Math.max(1, Math.floor(e.props.bodyColumns))
    const layout = layoutColumns(width, list)
    const rule = '─'.repeat(Math.max(0, width - PANE_HEADER.length - 1))
    const half = (isOn: boolean, label: string) => (
      <Text bold={isOn} color={isOn ? DARK : 'inactive'} backgroundColor={isOn ? ACCENT : undefined}>
        {label}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Text dimColor>{PANE_HEADER}</Text>
          <Text color="subtle" wrap="truncate-end">
            {rule}
          </Text>
        </Box>
        {list.length === 0 && <Text color={TONE.dim}>No sessions seen yet</Text>}
        {list.map(r => {
          const dot = rowDot(r)
          const status = rowStatus(r)
          return (
            <Box key={`session-${r.id}`} columnGap={1}>
              <Box width={1} flexShrink={0}>
                <Text color={dot.color} dimColor={dot.isDim}>
                  {dot.glyph}
                </Text>
              </Box>
              <Box width={1} flexShrink={0}>
                <Text bold color={MAGENTA}>
                  {r.isSelf ? '*' : ' '}
                </Text>
              </Box>
              <Box width={layout.nameW} flexShrink={0}>
                <Text bold={r.isSelf} color={TONE.name} wrap="truncate-end">
                  {truncateChars(r.name, MAX_NAME_CHARS)}
                </Text>
              </Box>
              {layout.showModel && (
                <Box width={layout.modelW} flexShrink={0}>
                  <Text color={TONE.dim} wrap="truncate-end">
                    {rowModelEffort(r)}
                  </Text>
                </Box>
              )}
              {layout.showMeter && (
                <Box width={layout.meterW} flexShrink={0} columnGap={1}>
                  {r.progress !== null && (
                    <Box flexShrink={0}>
                      {progressRuns(r.progress, layout.meterCells).map((run, i) => (
                        <Text key={`run-${i}`} color={run.color}>
                          {run.text}
                        </Text>
                      ))}
                    </Box>
                  )}
                  {r.progress !== null && (
                    <Text color={TONE.dim} wrap="truncate-end">
                      {progressLabel(r.progress)}
                    </Text>
                  )}
                </Box>
              )}
              <Box width={layout.stateW} flexShrink={0}>
                <Text bold={status.text === 'Working'} color={status.color} dimColor={status.text === 'Idle'} wrap="truncate-end">
                  {status.text}
                </Text>
              </Box>
            </Box>
          )
        })}
        <Box columnGap={1}>
          <Button key="lock" label="Lock" plain hotkey="l" onPress={() => flipLock($)} />
          <Box key="lock-state">
            <Text color="subtle">[</Text>
            {half(isLockedNow, ' On ')}
            <Text color="subtle">|</Text>
            {half(!isLockedNow, ' Off ')}
            <Text color="subtle">]</Text>
          </Box>
          <Button key="close" label="Close" plain hotkey="x" onPress={() => closeFromPane($)} />
        </Box>
      </Box>
    )
  })
}

// =====================================================================
// The hooks both features share
// =====================================================================

// The hooks both features need, registered once each so there is one ordered pass per event: session.start / attach /
// end, command.run, turn.start / complete and tool.call. The feature modules (`clean-view.tsx`, `sessions.tsx`) hold the
// handlers; this file only fixes the order they run in. Each handler is isolated: one that fails is skipped and the
// other still runs, as when they were two plugins.

const R = { isSimpleReady: false, isSessionsReady: false }

// A handler of one feature that fails must not take the other feature's handler down with it.
async function attempt(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
  } catch {
    // skipped; the next event runs it again
  }
}

// Registers the two tools and the two commands, each once per module copy. session.start fires again when the module
// hot-reloads; session.attach and turn.start call this too, so a copy that missed it still registers by the next turn.
async function ensureSetup($: EngineInterface): Promise<void> {
  await ensureTools($)
  if (!R.isSimpleReady) {
    try {
      await $.command.register({
        name: 'simple',
        description: 'Clean View: hide tool calls and command output and show one plain checklist. /simple on, /simple off, or no argument to flip',
        argumentHint: '[on|off]',
      })
      R.isSimpleReady = true
    } catch {
      // the next event tries again
    }
  }
  if (!R.isSessionsReady) {
    try {
      await $.command.register({
        name: 'sessions',
        description: 'Show or hide the sessions pane; "lock" keeps it open, "unlock" lets it close, "theme" offers the Clean View Dark theme ("theme warm" the Warm one)',
        argumentHint: '[lock|unlock|theme [dark|warm]]',
      })
      R.isSessionsReady = true
    } catch {
      // the next event tries again
    }
  }
}

export function registerShared(on: On): void {
  on('session.start', async ($, e, next) => {
    await ensureSetup($)
    await attempt(() => loadEnabled($))
    await attempt(() => sessionsStart($))
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await ensureSetup($)
    await attempt(() => loadEnabled($))
    await attempt(() => sessionsAttach($))
    return next(e)
  })

  // /clear and every other end
  on('session.end', async ($, e, next) => {
    await attempt(() => cleanSessionEnd($))
    await attempt(() => sessionsEnd($, e.reason))
    return next(e)
  })

  // One hook for the plugin's two commands; any other slash command (a skill's too) may start a turn, which the checklist
  // has to know.
  on('command.run', async ($, e, next) => {
    if (e.command === 'simple') return runSimple($, e.args)
    if (e.command === 'sessions') return runSessions($, e.args)
    await attempt(() => noteOtherCommand($))
    return next(e)
  }).catch(($, e, next) => (e.command === 'simple' ? { text: 'Clean View could not be changed just now. Try again.' } : next(e)))

  on('turn.start', async ($, e, next) => {
    await ensureSetup($)
    await attempt(() => cleanTurnStart($, e.text))
    await attempt(() => sessionsTurnStart($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await attempt(() => cleanTurnComplete($, e))
    await attempt(() => sessionsTurnComplete($, e))
    return next(e)
  })

  // In order: Clean View answers its own two tools or refuses a tool that has no plan behind it; then the call is tracked
  // by both features (the checklist's waits and failures, the sessions' pending dialogs and task list) while it runs.
  on('tool.call', async ($, e, next) => {
    const early = await cleanBeforeCall($, e)
    if (early !== null) return early
    const id = await cleanBeginCall($, e)
    await attempt(() => sessionsBeginCall($, e))
    let ran: Awaited<ReturnType<typeof next>> | undefined
    try {
      ran = await next(e)
      return ran
    } finally {
      if (id !== null) await cleanAfterCall($, e, id, ran)
      await sessionsAfterCall($, e, ran)
    }
  }).catch(($, e, next) => next(e)) // the gate fails open: a failure here lets the call through unchanged
}

// =====================================================================
// The band above the prompt, and the Session Viewer button
// =====================================================================

// The band above the prompt, drawn once for both features: the checklist as a round card (or nothing while no job
// runs), then one dim row with the two controls. The PromptHint site carries the Session Viewer button under the prompt.

// A letter, not a digit: a bare digit would press the button from an empty prompt and swallow the first number you type.
const CLEAN_HOTKEY = 'c' // pressed after ctrl+x tab (the band takes the keyboard); a click presses it in fullscreen
const SESSIONS_HOTKEY = 's'
const CARD_ROWS_OVERHEAD = 5 // the card's two border rows, its title and step lines, and the controls row

// Cuts a title to `max` characters (by code point) with an ellipsis.
function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

export function registerBand(on: On): void {
  // ---- the band above the prompt ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const enabled = await isOn($)
    const engine = await next(e) // other mods draw in this band too: their content stays
    const list = await read($, rowsAtom)
    const cleanLabel = enabled ? '● Clean View: ON' : '○ Clean View: OFF'

    // the two controls, one dim row
    const controls = (
      <Box key="controls" justifyContent="flex-end" columnGap={1}>
        <Button
          key="toggle"
          label={cleanLabel}
          hotkey={CLEAN_HOTKEY}
          dimColor
          onPress={async () => {
            await flip($)
          }}
        />
        <Button key="sessions" label={bandLabel(list)} plain dimColor hotkey={SESSIONS_HOTKEY} onPress={() => toggleFromBand($)} />
      </Box>
    )

    const cl = await read($, checklistAtom)
    if (!enabled || cl.phase === 'idle') {
      return (
        <Box flexDirection="column">
          {engine}
          {controls}
        </Box>
      )
    }

    const now = await $.clock.now()
    const frame = await read($, tickAtom)
    const columns = Math.max(1, Math.floor(e.props.bodyColumns))
    const layout = cardLayout(columns)
    const elapsed = formatElapsed((cl.finishedAt ?? now) - (cl.startedAt ?? now))
    const isDone = cl.phase === 'done'
    const title = cut(cl.title, Math.max(8, layout.inner - 14))
    const bars = (runs: Run[]) =>
      runs.map((run, i) => (
        <Text key={`bar-${i}`} color={run.color}>
          {run.text}
        </Text>
      ))

    // the badge, the title and `took ...` of a finished job: also the one line it shrinks to
    const doneLine = (width: number) => (
      <Box key="title" width={width} justifyContent="space-between">
        <Box columnGap={1} flexShrink={1}>
          <Text bold backgroundColor={GREEN} color={DARK}>
            {' ✓ All done '}
          </Text>
          <Text bold color={GREEN} wrap="truncate-end">
            {title}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {` took ${elapsed}`}
        </Text>
      </Box>
    )

    if (isDone && (isShrunk(cl, now) || cl.tasks.length === 0)) {
      return (
        <Box flexDirection="column">
          {engine}
          {doneLine(columns)}
          {controls}
        </Box>
      )
    }

    // the title line and the border of each state
    let border: string = MAGENTA
    let heading
    if (cl.phase === 'needsYou') {
      border = 'warning'
      heading = (
        <Box key="title" columnGap={1}>
          <Text bold inverse color="warning">
            {' Needs you '}
          </Text>
          <Text color="warning" wrap="truncate-end">
            {cl.needsYouReason ?? REASON_PERMISSION}
          </Text>
        </Box>
      )
    } else if (cl.phase === 'stuck') {
      border = 'error'
      heading = (
        <Text key="title" bold color="error" wrap="truncate-end">
          {`⚠ Stuck: ${cl.stuckReason ?? 'something went wrong'}`}
        </Text>
      )
    } else if (cl.phase === 'stopped') {
      border = 'inactive'
      heading = (
        <Text key="title" color="inactive" wrap="truncate-end">
          {`■ Stopped · ${cl.title} · you pressed Esc`}
        </Text>
      )
    } else if (isDone) {
      border = GREEN
      heading = doneLine(layout.inner)
    } else {
      const words = title.split(' ')
      const colors = titleColors(words.length)
      heading = (
        <Box key="title">
          <Text color={PINK}>{'✧ '}</Text>
          {words.map((w, i) => (
            <Text key={`w-${i}`} bold color={colors[i]}>
              {i < words.length - 1 ? `${w} ` : w}
            </Text>
          ))}
        </Box>
      )
    }

    // the second line: the step, or for a finished job the whole bar
    let second
    if (isDone) {
      const steps = `${cl.tasks.length} of ${cl.tasks.length} steps`
      const barCells = Math.max(4, layout.inner - charLength(steps) - 4 - 2)
      second = (
        <Box key="second" columnGap={1}>
          <Text color="inactive">{steps}</Text>
          <Box flexShrink={0}>{bars(doneRuns(barCells))}</Box>
          <Text color={GREEN}>100%</Text>
        </Box>
      )
    } else {
      second = (
        <Text key="second" color="inactive">
          {stepLine(cl.tasks)}
        </Text>
      )
    }

    const views = cardRows(cl.tasks, frame, cl.phase === 'needsYou', layout.meterW)
    const activeAt = Math.max(0, views.findIndex(v => v.kind === 'active'))
    const shown = windowRows(views, activeAt, Math.max(2, Math.min(10, e.props.maxRows - CARD_ROWS_OVERHEAD)))
    const rows = shown.map((v, i) => (
      <Box key={`row-${i}`} columnGap={1}>
        <Box width={1} flexShrink={0}>
          <Text color={v.glyphColor} dimColor={v.kind === 'upcoming'}>
            {v.glyph}
          </Text>
        </Box>
        <Box width={layout.labelW} flexShrink={0}>
          <Text bold={v.kind === 'active'} color={v.kind === 'active' ? 'text' : 'inactive'} dimColor={v.kind === 'done'} wrap="truncate-end">
            {v.name}
          </Text>
        </Box>
        <Box width={layout.meterW} flexShrink={0}>
          {bars(v.meter)}
        </Box>
        <Box width={layout.statusW} flexShrink={0}>
          <Text bold={v.kind === 'active'} color={v.labelColor} dimColor={v.kind === 'upcoming'} wrap="truncate-end">
            {v.label}
          </Text>
        </Box>
      </Box>
    ))

    return (
      <Box flexDirection="column">
        {engine}
        <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} width={columns}>
          {heading}
          {second}
          {rows}
        </Box>
        {controls}
      </Box>
    )
  })

  // ---- the Session Viewer button, bottom left under the prompt ----

  // `◇ Session Viewer · 3`, and ` · 1 waiting` in the warning colour; the engine's own hint line stays after it. A click
  // on it works only in the fullscreen terminal; the keyboard path is the `s` control in the band above.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rowsAtom)
    const engine = await next(e)
    const waiting = list.filter(r => r.waiting !== null).length
    return (
      <Box columnGap={2}>
        <Box flexShrink={0}>
          <Button key="viewer" label={list.length === 0 ? '◇ Session Viewer' : `◇ Session Viewer · ${list.length}`} plain dimColor onPress={() => toggleFromBand($)} />
          {waiting > 0 && <Text color="warning">{` · ${waiting} waiting`}</Text>}
        </Box>
        {engine}
      </Box>
    )
  })
}

