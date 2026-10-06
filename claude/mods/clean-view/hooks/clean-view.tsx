import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { Checklist } from '../types'
import {
  COLLAPSE_MS,
  EMPTY_CHECKLIST,
  FRAME_MS,
  GENERIC_ERROR,
  GATE_MESSAGE,
  LABEL_CELLS,
  METER_CELLS,
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
  nameWidth,
  noteToolOutcome,
  parseCommand,
  passesGate,
  planSteps,
  charLength,
  reportProgress,
  rowViews,
  setNeedsYou,
  windowRows,
} from './model'
import type { ToolOutcome } from './model'

// What the band draws from. It lives in $.state, so a hot reload keeps it, and a drawing that reads it redraws when it
// changes (at the engine's redraw rate, which is the throttle).
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, EMPTY_CHECKLIST as Checklist)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

// The on/off switch. $.store keeps it between sessions; this mirror is what the hooks read, so a draw costs no store
// call. null: not loaded yet.
const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, null as boolean | null)

// Warm look. Done, Needs you and Stuck keep the theme's own colours.
const AMBER = '#e0a050' // the current step and its meter
const ORANGE = '#d97757' // the header
const SAND = '#b8a88a' // dimmed text

// A letter, not a digit: a bare digit would press the button from an empty prompt and swallow the first number you type.
const BUTTON_HOTKEY = 'c' // pressed after ctrl+x tab (the band takes the keyboard); a click presses it in fullscreen

const COMMAND_WINDOW_MS = 3000 // a slash command that starts a turn: its command.run is seen this shortly before turn.start

// Bookkeeping a reload may safely lose.
const S = {
  areToolsReady: false, // both tools registered
  isCommandReady: false,
  gateArmed: false, // the plan gate and the prompt section go together: armed only when the section was added and both tools exist
  commandAt: null as number | null, // when a command other than /simple last ran
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
    S.gateArmed = false
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

// Registers the two tools and the command once per module copy. session.start fires again when the module hot-reloads;
// session.attach and turn.start call this too, so a copy that missed it still registers by the next turn.
async function ensureSetup($: EngineInterface): Promise<void> {
  if (!S.areToolsReady) {
    try {
      await registerTools($)
      S.areToolsReady = true
    } catch {
      // refused or early: the next event tries again, and until both tools exist the gate stays open
    }
  }
  if (!S.isCommandReady) {
    try {
      await $.command.register({
        name: 'simple',
        description: 'Clean View: hide tool calls and command output and show one plain checklist. /simple on, /simple off, or no argument to flip',
        argumentHint: '[on|off]',
      })
      S.isCommandReady = true
    } catch {
      // the next event tries again
    }
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
  return cl.phase === 'working' || (cl.phase === 'needsYou' && S.inflight.size > 0)
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
  if (wantsFrames && S.timer === null) S.timer = $.clock.every(FRAME_MS, () => void tick($))
  if (!wantsFrames && S.timer !== null) {
    S.timer.cancel()
    S.timer = null
  }
  const wantsCollapse = cl.phase === 'done' && !cl.isCollapsed
  if (wantsCollapse && S.collapseJob !== cl.jobId) {
    S.collapseTimer?.cancel()
    const job = cl.jobId
    S.collapseJob = job
    S.collapseTimer = $.clock.after(COLLAPSE_MS, () => void collapse($, job))
  }
  if (!wantsCollapse && S.collapseTimer !== null) {
    S.collapseTimer.cancel()
    S.collapseTimer = null
    S.collapseJob = null
  }
}

// A late timer for an older job does nothing.
async function collapse($: EngineInterface, job: number): Promise<void> {
  S.collapseTimer = null
  S.collapseJob = null
  await change($, cl => (cl.phase === 'done' && cl.jobId === job ? { ...cl, isCollapsed: true } : cl))
}

async function resetAll($: EngineInterface): Promise<void> {
  S.inflight.clear()
  S.waiting = null
  S.lastError = null
  await update($, checklistAtom, () => EMPTY_CHECKLIST)
  await update($, tickAtom, () => 0)
  syncTimers($, EMPTY_CHECKLIST)
}

const reply = (s: string) => ({ result: s })

// A permission dialog or a question is waiting: switch to Needs you, and clear it when the calls it waits on have ended.
async function holdForPerson($: EngineInterface, reason: string, extra?: string): Promise<void> {
  S.waiting = new Set([...S.inflight, ...(extra === undefined ? [] : [extra])])
  await change($, cl => setNeedsYou(cl, reason))
}

// One main-loop call has ended: when none of the calls the dialog waited on is left, the person-wait is over.
async function releaseCall($: EngineInterface, id: string): Promise<void> {
  S.inflight.delete(id)
  if (S.waiting === null) return
  S.waiting.delete(id)
  if (S.waiting.size === 0) {
    S.waiting = null
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

// ---------- drawing helpers ----------

function headerWidth(columns: number, buttonCells: number): number {
  return Math.max(10, columns - buttonCells - 1)
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    await ensureSetup($)
    await loadEnabled($)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await ensureSetup($)
    await loadEnabled($)
    return next(e)
  })

  // /clear and every other end: the job belongs to the session that is gone.
  on('session.end', async ($, e, next) => {
    await resetAll($)
    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    if (cmd === 'unknown') return { text: 'Usage: /simple [on|off]' }
    const was = await isOn($)
    const now = cmd === 'toggle' ? !was : cmd === 'on'
    await setOn($, now)
    const message = now ? 'Clean View is on' : 'Clean View is off'
    $.ui.toast(message)
    return { text: message }
  }).catch(() => ({ text: 'Clean View could not be changed just now. Try again.' }))

  // Any other slash command (a skill's too) may start a turn: the turn that follows has no job of its own.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'simple') S.commandAt = await $.clock.now()
    return next(e)
  }).catch(($, e, next) => next(e))

  // While Clean View is on, Claude is told to plan first and to report plainly.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // no checklist can be drawn in a headless run (print, no surface), and the other kinds of render are not the person's
    const isHeadless = e.traits.includes('print') || e.surfaces.length === 0
    if (isHeadless) S.gateArmed = false
    if (isHeadless || e.traits.includes('bare') || e.traits.includes('analysis') || e.traits.includes('sdk-preset') || e.traits.includes('teammate') || !(await isOn($))) {
      return composed
    }
    // the gate and the section go together: Claude is refused tools only when it was told how to get them, and the tools exist
    S.gateArmed = S.areToolsReady
    return { sections: [...composed.sections, { id: 'clean-view:plan', text: PROMPT_SECTION, scope: 'session' as const }] }
  })

  // ---- what the person sends, and how a turn ends ----

  on('turn.start', async ($, e, next) => {
    await ensureSetup($)
    await loadEnabled($)
    S.lastError = null
    if (await isOn($)) {
      // a slash command's turn, or a skill's (its command.run was just seen): no job, and no plan is asked for
      const at = S.commandAt
      const isCommand = e.text.trim().startsWith('/') || (at !== null && (await $.clock.now()) - at < COMMAND_WINDOW_MS)
      S.commandAt = null
      await change($, (cl, now) => beginTurn(cl, e.text, now, isCommand))
    }
    return next(e)
  })

  // The kind of an API error, as Claude Code classifies it; turn.complete turns it into one calm sentence.
  on('classic.StopFailure', async ($, e, next) => {
    // the kind first, then the details; the model's own words (last_assistant_message) never decide anything
    S.lastError = { kind: e.error, text: e.error_details ?? '' }
    const sentence = apiErrorSentence(e.error, e.error_details ?? '')
    // if the turn already ended with the generic sentence, this is the news that sharpens it
    await change($, cl => (cl.phase === 'stuck' && cl.stuckReason === GENERIC_ERROR ? { ...cl, stuckReason: sentence } : cl))
    return next(e)
  }).catch(($, e, next) => next(e)) // only observes: a failure here lets the event through unchanged

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && (await isOn($))) {
      const error = S.lastError
      S.lastError = null
      S.waiting = null
      S.inflight.clear() // nothing of this turn is still running
      await change($, (cl, now) => completeTurn(cl, { reason: e.reason, errorKind: error?.kind, text: error?.text ?? '' }, now))
    }
    return next(e)
  })

  // A permission dialog or a question dialog is about to wait on the person.
  on('classic.Notification', async ($, e, next) => {
    if (await isOn($)) {
      if (e.notification_type === 'permission_prompt') await holdForPerson($, REASON_PERMISSION)
      else if (e.notification_type === 'elicitation_dialog') await holdForPerson($, REASON_QUESTION)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // only observes: a failure here lets the event through unchanged

  // ---- the two tools, the plan gate, and what the main loop's other tools tell us ----

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isOwn = tool === PLAN_TOOL || tool === PROGRESS_TOOL
    if (isOwn) {
      // a subagent's call, or one with Clean View off, is answered and changes nothing
      const steps = tool === PLAN_TOOL ? (e as { steps?: unknown }).steps : undefined
      const isMain = e.agentId === undefined && (await isOn($))
      if (tool === PLAN_TOOL) {
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
      if (S.gateArmed && !(await read($, checklistAtom)).hasPlan) return { deny: GATE_MESSAGE } // a report needs a plan to report against
      let percent = 0
      await change($, (cl, now) => {
        const r = reportProgress(cl, input.task, input.percent, now)
        percent = r.percent
        return r.checklist
      })
      return reply(`Progress noted: ${percent}%.`)
    }

    if (e.agentId !== undefined || !(await isOn($))) return next(e)

    // until a real plan exists, every other tool is refused (the few that make or stand for a plan always pass)
    const cl = await read($, checklistAtom)
    if (S.gateArmed && !cl.hasPlan && !passesGate(tool)) return { deny: GATE_MESSAGE }

    // the next tool to run ends a wait on the person that no running call is part of
    if (S.waiting !== null && S.waiting.size === 0) {
      S.waiting = null
      await change($, c => clearNeedsYou(c))
    }
    const id = e.tool_use_id
    S.inflight.add(id)
    if (tool === 'AskUserQuestion') await holdForPerson($, REASON_QUESTION, id)
    let ran: Awaited<ReturnType<typeof next>> | undefined
    try {
      ran = await next(e)
      return ran
    } finally {
      try {
        await releaseCall($, id)
        const outcome = outcomeOf(ran)
        const ok = outcome === 'ok'
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
  }).catch(($, e, next) => next(e)) // the gate fails open: a failure here lets the call through unchanged

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

  // ---- drawing: the band above the prompt ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const enabled = await isOn($)
    const engine = await next(e) // other mods draw in this band too: their content stays
    const label = enabled ? '● Clean View: ON' : '○ Clean View: OFF'
    const button = (
      <Button
        key="toggle"
        label={label}
        hotkey={BUTTON_HOTKEY}
        onPress={async () => {
          await flip($)
        }}
      />
    )
    const cl = await read($, checklistAtom)
    if (!enabled || cl.phase === 'idle') {
      return (
        <Box flexDirection="column">
          {engine}
          <Box justifyContent="flex-end">{button}</Box>
        </Box>
      )
    }

    const now = await $.clock.now()
    const frame = await read($, tickAtom)
    const columns = e.props.bodyColumns
    const headW = headerWidth(columns, charLength(label) + 4) // `[ label ]`
    const elapsed = formatElapsed((cl.finishedAt ?? now) - (cl.startedAt ?? now))
    const shrunk = isShrunk(cl, now)

    // the header's words for each state
    let words
    if (cl.phase === 'needsYou') {
      words = (
        <Box columnGap={1}>
          <Text bold inverse color="warning">
            {' Needs you '}
          </Text>
          <Text color="warning" wrap="truncate-end">
            {cl.needsYouReason ?? REASON_PERMISSION}
          </Text>
        </Box>
      )
    } else if (cl.phase === 'stuck') {
      words = (
        <Text bold color="error" wrap="truncate-end">
          {`⚠ Stuck: ${cl.stuckReason ?? 'something went wrong'}`}
        </Text>
      )
    } else if (cl.phase === 'stopped') {
      words = (
        <Text color={SAND} wrap="truncate-end">
          {`■ Stopped · ${cl.title} · you pressed Esc`}
        </Text>
      )
    } else if (cl.phase === 'done') {
      words = (
        <Text bold color="success" wrap="truncate-end">
          {`✓ All done · ${cl.title} · took ${elapsed}`}
        </Text>
      )
    } else {
      words = (
        <Text bold color={ORANGE} wrap="truncate-end">
          {`${cl.title} · ${elapsed}`}
        </Text>
      )
    }
    const head = (
      <Box width={headW} flexShrink={0}>
        {words}
      </Box>
    )

    let rows = null
    if (!shrunk && cl.tasks.length > 0) {
      const views = rowViews(cl.tasks, frame, cl.phase === 'needsYou')
      const activeAt = Math.max(0, views.findIndex(v => v.kind === 'active'))
      const shown = windowRows(views, activeAt, Math.max(2, Math.min(10, e.props.maxRows - 3)))
      const nameW = nameWidth(shown.map(v => v.name), columns)
      rows = shown.map((v, i) => {
        const dim = v.kind !== 'active'
        const glyphColor = v.kind === 'done' ? 'success' : v.kind === 'active' ? AMBER : SAND
        const meterColor = v.kind === 'done' ? 'success' : v.kind === 'active' ? AMBER : SAND
        return (
          <Box key={`row-${i}`} columnGap={1}>
            <Box width={1} flexShrink={0}>
              <Text color={glyphColor} dimColor={v.kind === 'upcoming'}>
                {v.glyph}
              </Text>
            </Box>
            <Box width={nameW} flexShrink={0}>
              <Text bold={v.kind === 'active'} dimColor={dim} color={v.kind === 'active' ? undefined : SAND} wrap="truncate-end">
                {v.name}
              </Text>
            </Box>
            <Box width={METER_CELLS} flexShrink={0}>
              <Text color={meterColor} dimColor={v.kind === 'upcoming'}>
                {v.meter}
              </Text>
            </Box>
            <Box width={LABEL_CELLS} flexShrink={0}>
              <Text dimColor={dim} color={v.kind === 'active' ? AMBER : SAND} wrap="truncate-end">
                {v.label}
              </Text>
            </Box>
          </Box>
        )
      })
    }

    return (
      <Box flexDirection="column">
        {engine}
        <Box columnGap={1}>
          {head}
          {button}
        </Box>
        {rows}
      </Box>
    )
  })
}
