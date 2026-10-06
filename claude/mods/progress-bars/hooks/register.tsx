import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProgressState } from '../types'
import {
  EMPTY_PROGRESS,
  STORE_KEY,
  applyTaskCall,
  collapses,
  parseCommand,
  RUNNING_BAR,
  stripFences,
  summarize,
  taskCallOk,
  tasksFromTodos,
  toolLabel,
  turnLine,
} from './model'

// What the turn bar draws from. It lives in $.state, so a hot reload keeps it, and a drawing that reads it redraws
// when it changes (at the engine's redraw rate, which is the throttle).
const progress = atom({ plugin: 'progress-bars', key: 'progress' } as const, EMPTY_PROGRESS as ProgressState)

// The on/off switch. $.store keeps it between sessions; this mirror is what the render hooks read, so a draw costs no
// store call. null: not loaded yet.
const enabledAtom = atom({ plugin: 'progress-bars', key: 'enabled' } as const, null as boolean | null)

// Bookkeeping a reload may safely lose.
const S = { isRegistered: false }

async function storedOn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(STORE_KEY)) !== false // no value means on
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

// The render hooks' read. Before the mirror is loaded (a hot reload in a session that started without it) one store
// read answers, without writing the mirror from inside a draw.
async function isOn($: EngineInterface): Promise<boolean> {
  const v = await read($, enabledAtom)
  return v !== null ? v : storedOn($)
}

async function setOn($: EngineInterface, value: boolean): Promise<void> {
  await $.store.set(STORE_KEY, value)
  await update($, enabledAtom, () => value)
  $.ui.invalidate('ui.render')
}

// Registers the command once per module copy. session.start fires again when the module hot-reloads; session.attach and
// turn.start call this too, so a copy that missed it still registers the command by the next turn.
async function ensureCommand($: EngineInterface): Promise<void> {
  if (S.isRegistered) return
  S.isRegistered = true
  try {
    await $.command.register({
      name: 'bars',
      description: 'Progress bars instead of code: tool rows, results and fenced code become one line',
      argumentHint: '[on|off|status]',
    })
  } catch {
    // a refused or repeated registration leaves the command as it was
  }
}

async function resetProgress($: EngineInterface, all: boolean): Promise<void> {
  await update($, progress, v => (all ? EMPTY_PROGRESS : { ...v, started: 0, finished: 0 }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensureCommand($)
    await loadEnabled($)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await ensureCommand($)
    await loadEnabled($)
    return next(e)
  })

  // /clear and every other end: the task list belongs to the session that is gone.
  on('session.end', async ($, e, next) => {
    await resetProgress($, true)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await ensureCommand($)
    await loadEnabled($)
    await resetProgress($, false)
    return next(e)
  })

  on('command.run', { command: 'bars' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    if (cmd === 'unknown') return { text: 'Usage: /bars [on|off|status]' }
    const was = await isOn($)
    if (cmd === 'status') return { text: was ? 'Progress bars are on.' : 'Progress bars are off.' }
    const now = cmd === 'toggle' ? !was : cmd === 'on'
    await setOn($, now)
    const text = now ? 'Progress bars on.' : 'Progress bars off.'
    $.ui.toast(text)
    return { text }
  })

  // The main loop's tool calls: counted for the fallback bar; a task list is read from TodoWrite, TaskCreate and
  // TaskUpdate when the call did not fail. A subagent's calls (agentId set) are neither counted nor read.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    await update($, progress, v => ({ ...v, started: v.started + 1 }))
    let ran: Awaited<ReturnType<typeof next>> | undefined
    try {
      ran = await next(e)
      return ran
    } finally {
      const ok = ran !== undefined && ran.deny === undefined && ran.isError !== true && taskCallOk(ran.result)
      await update($, progress, v => {
        let tasks = v.tasks
        if (ok && tool === 'TodoWrite') tasks = tasksFromTodos(e) ?? tasks
        else if (ok && (tool === 'TaskCreate' || tool === 'TaskUpdate')) tasks = applyTaskCall(tasks, tool, e, ran?.result)
        return { ...v, tasks, finished: v.finished + 1 }
      })
    }
  }).catch(($, e, next) => next(e)) // counting is no gate: a failure here lets the call through unchanged

  // ---- drawing ----

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if (!collapses(p.tool) || p.isErrored || p.isInterrupted || !(await isOn($))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const label = toolLabel(p.tool, p.input)
    if (p.isRunning) {
      return (
        <Box columnGap={1}>
          <Text color="suggestion">▸</Text>
          <Text wrap="truncate-end">{label}</Text>
          <Text color="suggestion" dimColor>
            {RUNNING_BAR}
          </Text>
        </Box>
      )
    }
    return (
      <Box columnGap={1}>
        <Text color="success">✓</Text>
        <Text wrap="truncate-end">{label}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const p = e.props
    // a refusal or an abort arrives as text: that is read in full
    if (!collapses(p.tool) || p.isErrored || typeof p.output !== 'object' || p.output === null || !(await isOn($))) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor wrap="truncate-end">
        {`  ⎿ ${summarize(p.tool, p.output)}`}
      </Text>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await isOn($))) return next(e)
    const text = stripFences(e.props.text)
    if (text === e.props.text) return next(e)
    return next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.props.isWorking || e.props.hasSurvey || !(await isOn($))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const line = turnLine(await read($, progress), e.props.bodyColumns)
    const engine = await next(e)
    return (
      <Box flexDirection="column">
        {engine}
        <Box columnGap={1}>
          <Text color="suggestion">{line.bar}</Text>
          <Text dimColor wrap="truncate-end">
            {line.label}
          </Text>
        </Box>
      </Box>
    )
  })
}
