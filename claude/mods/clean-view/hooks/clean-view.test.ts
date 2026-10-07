import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { GREEN, MAGENTA, cardLayout, doneRuns, fillRuns, sweepRuns } from './look'
import { EFFORT_LEVELS, EFFORT_TOOL, MAX_AGENT_KEYS, clearLoop, clearMain, effectiveEffort, overrideOf, parseLevel, pruneAgents, setOverride } from './model-effort'
import type { EffortOverrides } from './model-effort'

import {
  PLAN_TOOL,
  PROGRESS_TOOL,
  EMPTY_CHECKLIST,
  apiErrorSentence,
  beginTurn,
  cleanName,
  clampPercent,
  completeTurn,
  formatElapsed,
  isHideableTool,
  isRejection,
  jobName,
  meterBar,
  nameWidth,
  noteToolOutcome,
  parseCommand,
  planSteps,
  reportProgress,
  rowViews,
  startJob,
  sweepBar,
  windowRows,
} from './model-clean'

// ---------- T1: the name cleaner and the local job name ----------

describe('cleanName', () => {
  test('T1: a backtick path disappears and the rest stays', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  })

  test('T1: a path disappears from the middle of a sentence, and so does a file name with a code extension', () => {
    expect(cleanName('Fix src/app/page.tsx and add tests')).toBe('Fix and add tests')
    expect(cleanName('Update Pricing.tsx, then style.css please')).toBe('Update then please')
    expect(cleanName('Open C:\\work\\notes now')).toBe('Open now')
  })

  test('T1: an 80-character name trims to 40 or fewer at a word boundary and gets an ellipsis', () => {
    const long = 'Build the whole pricing section with three plans and a friendly comparison table for visitors'
    expect(long.length).toBeGreaterThan(80)
    const out = cleanName(long)
    expect(Array.from(out).length).toBeLessThanOrEqual(40)
    expect(out.endsWith('…')).toBe(true)
    expect(long.startsWith(out.slice(0, -1))).toBe(true)
    expect(out).toBe('Build the whole pricing section with…')
    const eighty = 'a'.repeat(80)
    expect(Array.from(cleanName(eighty)).length).toBe(40) // one long word is cut hard
  })

  test('collapses whitespace, capitalises the first letter, and keeps a short name as it is', () => {
    expect(cleanName('  read   your\n brand   notes ')).toBe('Read your brand notes')
    expect(cleanName('x'.repeat(40))).toBe('X'.repeat(1) + 'x'.repeat(39))
  })

  test('nothing left means Working on it (or the fallback given)', () => {
    expect(cleanName('`code` src/a.ts')).toBe('Working on it')
    expect(cleanName('')).toBe('Working on it')
    expect(cleanName(undefined)).toBe('Working on it')
    expect(cleanName(42)).toBe('Working on it')
    expect(cleanName('app.js', 'Other')).toBe('Other')
  })

  test('triple fences and a stray tick are stripped; Hebrew is kept as it is', () => {
    expect(cleanName('Show ```ts\nconst a = 1\n``` result')).toBe('Show result')
    expect(cleanName('Fix the `broken thing')).toBe('Fix the broken thing')
    expect(cleanName('בנה את דף הבית')).toBe('בנה את דף הבית')
  })
})

describe('jobName', () => {
  test('is worked out locally: filler words go, at most 6 words, capitalised', () => {
    expect(jobName('Please can you build my landing page for the bakery with pricing')).toBe('Build my landing page for the')
    expect(jobName('I want you to add a contact form, and make it blue')).toBe('Add a contact form')
    expect(jobName("hey claude, let's polish the footer.")).toBe('Polish the footer')
  })

  test('a path in the prompt is dropped, a slash command or an empty prompt falls back', () => {
    expect(jobName('Fix `src/a.ts` and src/b.ts')).toBe('Fix and')
    expect(jobName('`only/code.ts`')).toBe('Working on your request')
    expect(jobName('')).toBe('Working on your request')
  })

  test('a question becomes Answer your question', () => {
    expect(jobName('What does this project do?')).toBe('Answer your question')
    expect(jobName('can you tell me how it works')).toBe('Tell me how it works')
  })
})

describe('time, meter and rows', () => {
  test('formatElapsed', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_000)).toBe('12s')
    expect(formatElapsed(72_000)).toBe('1m 12s')
    expect(formatElapsed(134_000)).toBe('2m 14s')
    expect(formatElapsed(3_900_000)).toBe('1h 05m')
    expect(formatElapsed(-5)).toBe('0s')
  })

  test('the meter is always 10 cells and fills to the percent; the sweep moves', () => {
    expect(meterBar(60)).toBe('██████░░░░')
    expect(meterBar(0)).toBe('░░░░░░░░░░')
    expect(meterBar(100)).toBe('██████████')
    expect(meterBar(250)).toBe('██████████')
    expect(meterBar(-3)).toBe('░░░░░░░░░░')
    const frames = new Set(Array.from({ length: 14 }, (_, i) => sweepBar(i)))
    expect(frames.size).toBeGreaterThan(5)
    for (const f of frames) {
      expect(Array.from(f).length).toBe(10)
      expect(f.split('█').length - 1).toBe(3)
    }
    expect(sweepBar(0)).toBe(sweepBar(14))
  })

  test('clampPercent', () => {
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(-4)).toBe(0)
    expect(clampPercent('55')).toBe(55)
    expect(clampPercent(Number.NaN)).toBe(0)
    expect(clampPercent(12.6)).toBe(13)
  })

  test('rows: done, current with a percent or a sweep, then Next and Up next; a held turn shows ‖', () => {
    const base = { hasReported: false, percent: 0 }
    const tasks = [
      { id: '1', name: 'A', status: 'done' as const, percent: 100, hasReported: true },
      { id: '2', name: 'B', status: 'active' as const, percent: 60, hasReported: true },
      { id: '3', name: 'C', status: 'upcoming' as const, ...base },
      { id: '4', name: 'D', status: 'upcoming' as const, ...base },
    ]
    const rows = rowViews(tasks, 3, false)
    expect(rows.map(r => r.glyph)).toEqual(['✓', '▶', '○', '○'])
    expect(rows.map(r => r.label)).toEqual(['Done', '60%', 'Next', 'Up next'])
    expect(rows[1]?.meter).toBe('██████░░░░')
    expect(rows[0]?.meter).toBe('██████████')
    const sweeping = rowViews([{ id: '1', name: 'A', status: 'active', ...base }], 3, false)
    expect(sweeping[0]?.label).toBe('Working')
    expect(sweeping[0]?.meter).toBe(sweepBar(3))
    const held = rowViews([{ id: '1', name: 'A', status: 'active', ...base }], 3, true)
    expect(held[0]?.glyph).toBe('‖')
  })

  test('windowRows keeps the current step in view; nameWidth never lets a row wrap', () => {
    const rows = Array.from({ length: 20 }, (_, i) => i)
    expect(windowRows(rows, 10, 6)).toEqual([8, 9, 10, 11, 12, 13])
    expect(windowRows(rows, 19, 6)).toEqual([14, 15, 16, 17, 18, 19])
    expect(windowRows([1, 2], 0, 6)).toEqual([1, 2])
    expect(nameWidth(['Build the pricing section'], 80)).toBe(25)
    expect(nameWidth(['Build the pricing section'], 40)).toBe(19) // 40 - (1+1+1+10+1+7)
    expect(nameWidth(['Build the pricing section'], 10)).toBe(6)
    expect(nameWidth(['x'.repeat(60)], 200)).toBe(40)
  })
})

describe('which rows may be hidden', () => {
  test('the allowlist, and other MCP tools, are hidden; the rest is the engine\'s', () => {
    for (const t of ['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent', 'ToolSearch', PLAN_TOOL, PROGRESS_TOOL, 'mcp__srv__lookup']) {
      expect(isHideableTool(t)).toBe(true)
    }
    for (const t of ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'SendUserMessage', 'SendUserFile', 'ProposeGoal', 'mcp__srv__authenticate', 'mcp__srv__complete_authentication', 'SuggestPlugins', 'OfferHelp', 'ShowGuide', 'mcp__srv__ShowCard', 'Skill', 'NewFutureTool']) {
      expect(isHideableTool(t)).toBe(false)
    }
  })
})

describe('trouble', () => {
  test('API errors become one calm sentence', () => {
    expect(apiErrorSentence('rate_limit', '')).toBe('you hit your usage limit, try again a little later')
    expect(apiErrorSentence('overloaded', '')).toBe("Claude's servers are busy, try again in a minute")
    expect(apiErrorSentence('server_error', 'API Error: 529')).toBe("Claude's servers are busy, try again in a minute")
    expect(apiErrorSentence('invalid_request', 'prompt is too long: 250000 tokens')).toBe('this chat is too long, type /compact and try again')
    expect(apiErrorSentence('unknown', 'fetch failed: ECONNRESET')).toBe('the internet connection dropped')
    expect(apiErrorSentence('authentication_failed', '')).toBe('you are signed out, type /login')
    expect(apiErrorSentence(undefined, 'Invalid API key')).toBe('you are signed out, type /login')
    expect(apiErrorSentence(undefined, 'weird')).toBe('something went wrong, try again in a moment')
  })

  test('a "no" at a permission is recognised, a plain error is not', () => {
    expect(isRejection("The user doesn't want to proceed with this tool use. The tool use was rejected")).toBe(true)
    expect(isRejection('Permission to use Bash has been denied.')).toBe(false) // a rule's denial is not the person's "no"
    expect(isRejection('Blocked by the policy plugin')).toBe(false)
    expect(isRejection('ENOENT: no such file')).toBe(false)
  })

  test('parseCommand', () => {
    expect(parseCommand('')).toBe('toggle')
    expect(parseCommand(undefined)).toBe('toggle')
    expect(parseCommand(' ON ')).toBe('on')
    expect(parseCommand('off')).toBe('off')
    expect(parseCommand(['off'])).toBe('off')
    expect(parseCommand('maybe')).toBe('unknown')
  })
})

describe('the checklist reducer', () => {
  const T0 = 1_000
  const job = () => startJob(EMPTY_CHECKLIST, 'Build my page', T0)

  test('a new job shows placeholder steps with no real plan yet', () => {
    const cl = job()
    expect(cl.tasks.map(t => [t.name, t.status])).toEqual([['Understand your request', 'active'], ['Plan the steps', 'upcoming']])
    expect(cl.hasPlan).toBe(false)
    expect(cl.phase).toBe('working')
  })

  test('T5: plan_steps replaces the placeholders (first step active, 2 to 8 names, cleaned), then report_progress at 100 checks off one and starts two', () => {
    const planned = planSteps(job(), ['Read your brand notes', 'Build `src/Pricing.tsx` now', 'Add the contact form'], T0)
    expect(planned.count).toBe(3)
    expect(planned.checklist.hasPlan).toBe(true)
    expect(planned.checklist.tasks.map(t => [t.name, t.status])).toEqual([['Read your brand notes', 'active'], ['Build now', 'upcoming'], ['Add the contact form', 'upcoming']])
    const reported = reportProgress(planned.checklist, 'Read your brand notes', 100, T0)
    expect(reported.percent).toBe(100)
    expect(reported.checklist.tasks.map(t => t.status)).toEqual(['done', 'active', 'upcoming'])
  })

  test('plan_steps takes at most 8 steps, drops blanks and repeats, and refuses an empty plan', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Step number ${i + 1}`)
    expect(planSteps(job(), many, T0).count).toBe(8)
    expect(planSteps(job(), ['One', ' ', 'one', 7, 'Two'], T0).count).toBe(2)
    const none = planSteps(job(), [], T0)
    expect(none.count).toBe(0)
    expect(none.checklist.hasPlan).toBe(false)
    expect(planSteps(job(), 'not a list', T0).count).toBe(0)
  })

  test('with no job running, plan_steps starts one with the fallback name', () => {
    const r = planSteps(EMPTY_CHECKLIST, ['One', 'Two'], T0)
    expect(r.checklist.phase).toBe('working')
    expect(r.checklist.title).toBe('Working on your request')
    expect(r.checklist.startedAt).toBe(T0)
  })

  test('report_progress: a step in the middle checks off every step before it, and the percent is clamped', () => {
    const planned = planSteps(job(), ['One', 'Two', 'Three', 'Four'], T0).checklist
    const r = reportProgress(planned, 'Three', 250, T0)
    expect(r.percent).toBe(100)
    expect(r.checklist.tasks.map(t => t.status)).toEqual(['done', 'done', 'done', 'active'])
    const mid = reportProgress(planned, 'two', 40, T0).checklist
    expect(mid.tasks.map(t => [t.status, t.percent])).toEqual([['done', 100], ['active', 40], ['upcoming', 0], ['upcoming', 0]])
    expect(reportProgress(planned, 'One', -9, T0).percent).toBe(0)
  })

  test('report_progress: a name close to a planned step is that step; a name that is not in the plan becomes a new step', () => {
    const planned = planSteps(job(), ['Build the pricing section', 'Add the contact form'], T0).checklist
    const close = reportProgress(planned, 'Build pricing section!', 30, T0).checklist
    expect(close.tasks.map(t => t.name)).toEqual(['Build the pricing section', 'Add the contact form'])
    expect(close.tasks[0]?.percent).toBe(30)
    const extra = reportProgress(planned, 'Fix the typo', 50, T0).checklist
    expect(extra.tasks.map(t => t.name)).toEqual(['Build the pricing section', 'Add the contact form', 'Fix the typo'])
    expect(extra.tasks.map(t => t.status)).toEqual(['done', 'upcoming', 'active'])
  })

  test('a step already checked off stays so when a lower percent arrives; one at 100 starts the next', () => {
    const planned = planSteps(job(), ['One', 'Two'], T0).checklist
    const done = reportProgress(planned, 'One', 100, T0).checklist
    expect(reportProgress(done, 'One', 20, T0).checklist.tasks.map(t => t.status)).toEqual(['done', 'active'])
  })

  test('a reply while the job waits continues it; a prompt while it works changes nothing; a new prompt starts a new job', () => {
    const planned = planSteps(job(), ['One', 'Two'], T0).checklist
    const waiting = { ...planned, phase: 'needsYou' as const, needsYouReason: 'x' }
    const reply = beginTurn(waiting, 'yes please', T0 + 5)
    expect(reply.phase).toBe('working')
    expect(reply.jobId).toBe(planned.jobId)
    expect(beginTurn(planned, 'another', T0 + 5)).toBe(planned)
    const finished = completeTurn({ ...planned, tasks: planned.tasks.map(t => ({ ...t, status: 'done' as const })) }, { reason: 'answer' }, T0 + 9)
    const fresh = beginTurn(finished, 'Please make the footer nicer', T0 + 20)
    expect(fresh.jobId).toBe(finished.jobId + 1)
    expect(fresh.title).toBe('Make the footer nicer')
    expect(fresh.hasPlan).toBe(false)
    expect(fresh.startedAt).toBe(T0 + 20)
  })

  test('a slash command or an empty prompt starts no job', () => {
    const done = completeTurn(job(), { reason: 'answer' }, T0)
    expect(beginTurn(done, '', 5)).toBe(done)
    const slash = beginTurn(done, '/review', 5)
    expect(slash.phase).toBe('idle')
    expect(slash.hasPlan).toBe(true) // no plan is asked for: the gate stays open
    expect(beginTurn(done, 'Expanded text of a skill', 5, true).hasPlan).toBe(true)
    expect(beginTurn(done, 'Expanded text of a skill', 5, true).phase).toBe('idle')
  })

  test('the end of a turn: done, needs you (steps left), stopped, refusal and error', () => {
    const planned = planSteps(job(), ['One', 'Two'], T0).checklist
    const left = completeTurn(planned, { reason: 'answer' }, T0 + 9)
    expect(left.phase).toBe('needsYou')
    expect(left.needsYouReason).toBe('Claude is waiting for your reply')
    const all = reportProgress(reportProgress(planned, 'One', 100, T0).checklist, 'Two', 100, T0).checklist
    const done = completeTurn(all, { reason: 'answer' }, T0 + 9_000)
    expect(done.phase).toBe('done')
    expect(done.finishedAt).toBe(T0 + 9_000)
    expect(completeTurn(job(), { reason: 'answer' }, T0).tasks).toEqual([]) // no plan: nothing was left open
    expect(completeTurn(planned, { reason: 'aborted' }, T0 + 3).phase).toBe('stopped')
    const refused = completeTurn(planned, { reason: 'refusal' }, T0)
    expect([refused.phase, refused.stuckReason]).toEqual(['stuck', "Claude couldn't help with that request"])
    const failed = completeTurn(planned, { reason: 'error', errorKind: 'rate_limit' }, T0)
    expect([failed.phase, failed.stuckReason]).toEqual(['stuck', 'you hit your usage limit, try again a little later'])
    expect(completeTurn(EMPTY_CHECKLIST, { reason: 'aborted' }, 1).phase).toBe('idle')
  })

  test('a turn that ends with steps left while background work runs keeps working: it waits on the work, not the person', () => {
    const planned = planSteps(job(), ['One', 'Two'], T0).checklist
    const asked = { ...planned, phase: 'needsYou' as const, needsYouReason: 'Claude needs your OK to continue' }
    for (const cl of [planned, asked]) {
      const left = completeTurn(cl, { reason: 'answer', isWaitingOnWork: true }, T0 + 9)
      expect([left.phase, left.needsYouReason, left.finishedAt]).toEqual(['working', null, null])
      expect(left.tasks).toEqual(planned.tasks)
    }
    const all = reportProgress(reportProgress(planned, 'One', 100, T0).checklist, 'Two', 100, T0).checklist
    expect(completeTurn(all, { reason: 'answer', isWaitingOnWork: true }, T0 + 9).phase).toBe('done') // nothing left open
    expect(completeTurn(planned, { reason: 'aborted', isWaitingOnWork: true }, T0 + 9).phase).toBe('stopped')
  })

  test('three failures in a row are Stuck, a "no" is Stuck at once, a success clears it', () => {
    let cl = planSteps(job(), ['One', 'Two'], T0).checklist
    cl = noteToolOutcome(cl, 'failed')
    cl = noteToolOutcome(cl, 'failed')
    expect(cl.phase).toBe('working')
    cl = noteToolOutcome(cl, 'failed')
    expect([cl.phase, cl.stuckReason]).toEqual(['stuck', 'a step keeps failing, Claude is trying another way'])
    cl = noteToolOutcome(cl, 'ok')
    expect([cl.phase, cl.stuckReason, cl.failStreak]).toEqual(['working', null, 0])
    const no = noteToolOutcome(cl, 'rejected')
    expect([no.phase, no.stuckReason]).toEqual(['stuck', 'you said no to a step, so Claude paused'])
    expect(noteToolOutcome(EMPTY_CHECKLIST, 'failed')).toBe(EMPTY_CHECKLIST)
  })
})

// ---------- the hooks, through the test kit ----------

const ENGINE = 'ENGINE DRAWS THIS'
const text = (s: string) => ({ type: 'Text' as const, props: {}, children: [s] })
const SURFACES = ['terminal', 'desktop'] as const

// $.state, $.store and $.clock in memory, and an engine bottom for every site and event the mod touches, so a
// pass-through shows as ENGINE and a model call would be seen.
function world(on: On, entries: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...entries }
  on('store.get', (_$, e) => ({ value: stored[e.key] }))
  const flags = { failStoreSet: false, failRegister: false }
  on('store.set', (_$, e) => {
    if (flags.failStoreSet) throw new Error('the store is not writable')
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('command.run', () => ({ text: '' }))
  const clock = mock.clock(on, { now: 1_000_000 })
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
  const log = { toasts: [] as string[], registered: [] as string[], commands: [] as string[], modelCalls: 0 }
  on('tool.register', (_$, e) => {
    if (flags.failRegister) throw new Error('registration refused')
    log.registered.push(String((e as { name?: string }).name))
    return { value: { tool: `mcp__clean-view__${(e as { name?: string }).name}` } } as never
  })
  on('command.register', (_$, e) => {
    log.commands.push(String((e as { name?: string }).name))
    return { value: { command: e.name } } as never
  })
  on('ui.toast', (_$, e) => {
    log.toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  on('model.complete', () => {
    log.modelCalls += 1
    throw new Error('Clean View must never call a model')
  })
  on('session.surfaces', () => ({ value: [] as never })) // headless as far as the sessions feature goes: it stays inert here
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'engine:intro', text: 'INTRO', scope: 'shared' as const }] }))
  on('classic.Notification', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('classic.Stop', () => bottom.stop() as never)
  const bottom = { toolCall: (_e: { tool: unknown }): unknown => ({ result: 'ok' }), stop: (): unknown => ({}) }
  on('tool.call', (_$, e) => bottom.toolCall(e) as never)
  const seen: { props: Record<string, unknown> } = { props: {} }
  on('ui.render', (_$, e) => {
    seen.props = e.props as Record<string, unknown> // what reached the engine's own drawing
    return text(ENGINE) as never
  })
  return { clock, state, log, stored, bottom, flags, seen }
}

const promptProps = (o: Record<string, unknown> = {}) =>
  ({ hasSurvey: false, isWorking: true, maxRows: 14, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {}, ...o }) as never
const toolProps = (o: Record<string, unknown> = {}) =>
  ({ tool_use_id: 'tu1', tool: 'Read', input: { file_path: '/a/b/app.ts' }, isRunning: false, isErrored: false, isInterrupted: false, ...o }) as never
const resultProps = (o: Record<string, unknown> = {}) =>
  ({ tool_use_id: 'tu1', tool: 'Edit', output: { structuredPatch: [] }, isErrored: false, ...o }) as never

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }
// the section and the gate go together: a compose that added the section arms the gate
const arm = ($: { prompt: { compose: (e: never) => Promise<{ sections: readonly { id: string }[] }> } }) => $.prompt.compose(COMPOSE as never)
const startTurn = (_$: unknown, prompt: string, turnId = 't1') => (_$ as { turn: { start: (e: { text: string; turnId: string }) => Promise<unknown> } }).turn.start({ text: prompt, turnId })

// the job's title as drawn: the words after the `✧ ` mark, up to the step line
function headline(w: string[]): string {
  const from = w.indexOf('✧ ')
  const to = w.findIndex((x, i) => i > from && x.startsWith('Step '))
  return from < 0 || to < 0 ? '' : w.slice(from + 1, to).join('')
}

// every text the band drew, in order
async function words(m: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return (await m.findAll({ type: 'Text' })).map(f => f.text)
}

const complete = ($: { turn: { complete: (e: never) => Promise<unknown> } }, o: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...o } as never)

test('T5: plan_steps then report_progress at 100 checks off step one and starts step two, and the tools answer as told', async ($, on) => {
  const { clock, log } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  expect(log.registered).toEqual(['plan_steps', 'report_progress', 'set_effort'])
  expect(log.commands).toEqual(['simple', 'sessions', 'shabbos'])
  await startTurn($, 'Please build my landing page')
  const planned = await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] } as never)
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  const reported = await $.tool.call({ tool: PROGRESS_TOOL, task: 'Read your brand notes', percent: 100 } as never)
  expect(reported.result).toBe('Progress noted: 100%.')
  await clock.settle()
  for (const surface of SURFACES) {
    const m = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: promptProps(), requestId: 'p1' })
    const rows = await words(m)
    expect(rows).toContain('Read your brand notes')
    expect(rows.filter(w => w === '✓')).toHaveLength(1)
    expect(rows).toContain('●')
    expect(rows).toContain('Done')
    expect(rows).toContain('Working') // step two has no percent yet
    expect(rows).toContain('Next')
    await m.unmount()
  }
  expect((await $.tool.call({ tool: PROGRESS_TOOL, task: 'Build the pricing section', percent: 999 } as never)).result).toBe('Progress noted: 100%.')
})

test('T2: a to-do list and a 60% report render ✓ / ▶ 60% / Next / Up next on terminal and desktop', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Build my landing page')
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', activeForm: 'Reading', status: 'completed' },
      { content: 'Build the pricing section', activeForm: 'Building', status: 'in_progress' },
      { content: 'Add the contact form', activeForm: 'Adding', status: 'pending' },
      { content: 'Polish the footer', activeForm: 'Polishing', status: 'pending' },
    ],
  } as never)
  await $.tool.call({ tool: PROGRESS_TOOL, task: 'Build the pricing section', percent: 60 } as never)
  await clock.settle()
  for (const surface of SURFACES) {
    const m = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: promptProps(), requestId: 'p2' })
    const w = await words(m)
    expect(w.filter(x => x === '✓')).toHaveLength(1)
    expect(w).toContain('●')
    expect(w).toContain('60%')
    expect(w).toContain('Next')
    expect(w).toContain('Up next')
    expect(w).toContain('░░░░') // the track of the 60% meter
    expect(w.filter(x => x === '█').length).toBeGreaterThanOrEqual(6) // its six filled cells, one colour each
    expect(w).toContain('Step 2 of 4')
    expect(w.indexOf('Read your brand notes')).toBeLessThan(w.indexOf('Build the pricing section'))
    expect(w.indexOf('Add the contact form')).toBeLessThan(w.indexOf('Polish the footer'))
    expect(headline(w)).toBe('Build my landing page') // the title line: the job name
    expect(await m.find({ text: ENGINE })).toBeDefined() // the engine's and other mods' content stays
    expect((await m.find({ key: 'toggle' }))?.text).toContain('Clean View: ON')
    expect((await m.find({ key: 'sessions' }))?.text).toContain('Sessions')
    await m.unmount()
  }
})

test('T2 (TaskCreate / TaskUpdate): the tasks become rows and follow the updates', async ($, on) => {
  const { clock, bottom } = world(on)
  let n = 0
  bottom.toolCall = e => (e.tool === 'TaskCreate' ? { result: { task: { id: String(++n), subject: 's' } } } : { result: { success: true } })
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Tidy up')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Sort the files', description: 'x' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write a summary', description: 'x' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await clock.settle()
  const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'p3' })
  const w = await words(m)
  expect(w).toContain('Sort the files')
  expect(w.filter(x => x === '✓')).toHaveLength(1)
  expect(w).toContain('●') // the second task starts when the first is done
  await m.unmount()
})

test('T3: a permission prompt shows Needs you and the reason, the current step shows ‖, and the next tool clears it', async ($, on) => {
  const { clock, bottom } = world(on)
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  bottom.toolCall = async e => {
    if (e.tool === 'Bash') await gate
    return { result: 'ok' }
  }
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Run the build')
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Run the build', 'Check the result'] } as never)
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm run build' } as never)
  await clock.settle()
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  await clock.settle()
  for (const surface of SURFACES) {
    const m = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: promptProps(), requestId: 'n1' })
    const w = await words(m)
    expect(w).toContain(' Needs you ')
    expect(w).toContain('Claude needs your OK to continue')
    expect(w).toContain('‖')
    expect(w).not.toContain('●')
    await m.unmount()
  }
  release()
  await call
  await clock.settle()
  const after = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'n2' })
  const w = await words(after)
  expect(w).not.toContain(' Needs you ')
  expect(w).toContain('●')
  await after.unmount()
})

test('a permission wait that no running call is part of ends when the next tool runs', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Run the build')
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Run the build', 'Check the result'] } as never)
  await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' } as never)
  await clock.settle()
  const draw = async (id: string) => {
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: id })
    const w = await words(m)
    await m.unmount()
    return w
  }
  expect(await draw('k1')).toContain(' Needs you ')
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await clock.settle()
  expect(await draw('k2')).not.toContain(' Needs you ')
})

// The session that ended its turn with Codex runs and a test suite in the background, steps still open (2026-10-07): the
// card said Needs you while Claude waited on its own background work.
test('a turn that ends while background work runs is not Needs you; one that ends with none, or on a question, is', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  const draw = async (id: string) => {
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: id })
    const w = await words(m)
    await m.unmount()
    return w
  }
  const shell = { id: 'bvwuzk0lq', type: 'shell', status: 'running', description: 'Codex run', command: 'node codex-run.mjs' }
  const stop = (tasks: unknown[]) => $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: tasks } as never)
  await startTurn($, 'Run the release work')
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Run the build', 'Check the result'] } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'bg1', command: 'node codex-run.mjs', run_in_background: true } as never)
  await stop([shell])
  await complete($, { answer: "I'm now waiting on that run and on the test suite." })
  await clock.settle()
  const idle = await draw('bg1')
  expect(idle).not.toContain(' Needs you ')
  expect(idle).not.toContain('Claude is waiting for your reply')
  expect(idle).toContain('Run the build')

  // the background task's notification starts the next turn; it ends with nothing left running: now it is the person's turn
  await startTurn($, '<task-notification>done</task-notification>', 't2')
  await stop([])
  await complete($, { answer: 'The run finished.', turnId: 't2' })
  await clock.settle()
  expect(await draw('bg2')).toContain(' Needs you ')

  // work still running, but the answer asks the person something: that is the person's turn too
  await startTurn($, 'go on', 't3')
  await stop([shell])
  await complete($, { answer: 'Should I merge it now?', turnId: 't3' })
  await clock.settle()
  expect(await draw('bg3')).toContain(' Needs you ')

  // a Stop seen in an earlier turn does not carry into a turn that saw none
  await startTurn($, 'go on', 't4')
  await stop([shell])
  await complete($, { answer: 'Still running.', turnId: 't4' })
  await startTurn($, 'go on', 't5')
  await complete($, { answer: 'Over to you.', turnId: 't5' })
  await clock.settle()
  expect(await draw('bg4')).toContain(' Needs you ')
})

// The review of that fix (2026-10-07): what counts as work, a bound on the wait, and what the Stop hook may not change.
describe('waiting on background work: what counts, how long, and the Stop hook', () => {
  const shell = { id: 'b1', type: 'shell', status: 'running', description: 'Codex run', command: 'node codex-run.mjs' }
  const stopWith = ($: { classic: { Stop: (e: never) => Promise<unknown> } }, tasks: unknown[], extra: Record<string, unknown> = {}) =>
    $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: tasks, ...extra } as never)
  // one planned job in a fresh world; `turn` runs a turn that ends with `tasks` listed by Stop and `answer` as its words
  async function rig($: Parameters<typeof startTurn>[0] & Record<string, any>, on: On) {
    const w = world(on)
    let n = 0
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Run the release work', 't0')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['Run the build', 'Check the result'] } as never)
    await complete($, { answer: 'Started.', turnId: 't0' }) // steps left open, nothing in the background: the person's turn
    const turn = async (tasks: unknown[], answer: string, extra: Record<string, unknown> = {}) => {
      const id = `r${++n}`
      await startTurn($, 'go on', id)
      await stopWith($, tasks, extra)
      await complete($, { answer, turnId: id })
      await w.clock.settle()
    }
    const draw = async () => {
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: `d${++n}` })
      const out = await words(m)
      await m.unmount()
      return out
    }
    const isNeedsYou = async () => (await draw()).includes(' Needs you ')
    return { ...w, turn, draw, isNeedsYou, start: (id: string) => startTurn($, 'go on', id) }
  }

  test('only running or pending subagent, shell and workflow tasks are work: a monitor, a done task or an unknown type is not', async ($, on) => {
    const r = await rig($, on)
    const work: unknown[] = [
      shell,
      { ...shell, status: 'pending' },
      { id: 'a', type: 'subagent', status: 'running', description: 'x' },
      { id: 'w', type: 'workflow', status: 'running', description: 'x', name: 'n' },
    ]
    const notWork: unknown[] = [
      { id: 'm', type: 'monitor', status: 'running', description: 'x', server: 's', tool: 't' },
      { ...shell, status: 'completed' },
      { ...shell, status: 'failed' },
      { id: 'z', type: 'something-new', status: 'running', description: 'x' },
    ]
    for (const task of work) {
      await r.turn([task], 'Waiting for it.')
      expect(await r.isNeedsYou()).toBe(false)
    }
    for (const task of notWork) {
      await r.turn([task], 'Waiting for it.')
      expect(await r.isNeedsYou()).toBe(true)
    }
    await r.turn([notWork[0], shell], 'Waiting for it.') // one real task among others is enough
    expect(await r.isNeedsYou()).toBe(false)
  })

  test('a question anywhere in the last paragraph is the person\'s turn; one in an earlier paragraph is not', async ($, on) => {
    const r = await rig($, on)
    await r.turn([shell], 'Should I merge it? I will wait for your answer.')
    expect(await r.isNeedsYou()).toBe(true)
    await r.turn([shell], 'Which one did you want?\n\nThe run is going; waiting on it now.')
    expect(await r.isNeedsYou()).toBe(false)
    await r.turn([shell], 'The run is going.\n\nShall I wait for it, or stop (your call)?  ')
    expect(await r.isNeedsYou()).toBe(true)
  })

  test('the wait on work lasts 20 minutes at most: then it is Needs you (the reply), and a new turn cancels the bound', async ($, on) => {
    const r = await rig($, on)
    await r.turn([shell], 'Waiting on the run.')
    expect(await r.isNeedsYou()).toBe(false)
    await r.clock.advance(19 * 60_000)
    expect(await r.isNeedsYou()).toBe(false)
    await r.clock.advance(61_000)
    const w = await r.draw()
    expect(w).toContain(' Needs you ')
    expect(w).toContain('Claude is waiting for your reply')

    // the work's notification starts a turn before the bound: it is not flipped later, whatever it takes
    await r.turn([shell], 'Waiting again.')
    await r.clock.advance(19 * 60_000)
    await r.start('late') // the next turn begins a minute before the bound
    await r.clock.advance(2 * 60_000) // past where the old bound would have fired
    expect(await r.isNeedsYou()).toBe(false)
    // and its end is judged on its own: the earlier stamp does not carry
    await stopWith($, [])
    await complete($, { answer: 'Over to you.', turnId: 'late' })
    await r.clock.settle()
    expect(await r.isNeedsYou()).toBe(true)
  })

  // A hot reload leaves the checklist atom (waitingSince) but a fresh module copy (no wait timer): the copy re-arms the bound
  // on its first session.attach / session.start with the time that is left, not a new 20 minutes (2026-10-07 carried Minor).
  describe('a copy loaded while a wait is on re-arms the bound with the time left', () => {
    const MIN = 60_000
    // the world's clock starts at 1_000_000; the checklist as the old copy saved it: waiting on work since `ago` ago
    function seeded(on: On, ago: number) {
      const w = world(on)
      const planned = planSteps(startJob(EMPTY_CHECKLIST, 'Run the release work', 1_000_000 - ago - 5), ['Run the build', 'Check the result'], 1_000_000 - ago - 5).checklist
      const waiting = completeTurn(planned, { reason: 'answer', isWaitingOnWork: true }, 1_000_000 - ago)
      expect([waiting.phase, waiting.waitingSince]).toEqual(['working', 1_000_000 - ago])
      w.state.set('clean-view/checklist', { value: waiting, version: 1 })
      const draw = async ($: Parameters<typeof startTurn>[0] & Record<string, any>) => {
        const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'rl' })
        const out = await words(m)
        await m.unmount()
        return out
      }
      return { ...w, draw }
    }

    test('15 minutes into the wait, attach then 5 more minutes: Needs you; 4 minutes is still Working', async ($, on) => {
      const r = seeded(on, 15 * MIN)
      await $.session.attach({ surface: 'terminal', clientId: 'c1' } as never)
      await r.clock.advance(4 * MIN)
      expect(await r.draw($)).not.toContain(' Needs you ')
      await r.clock.advance(MIN + 1_000)
      const w = await r.draw($)
      expect(w).toContain(' Needs you ')
      expect(w).toContain('Claude is waiting for your reply')
    })

    test('the same through session.start (the reload path), and the timer is the time left, not a fresh 20 minutes', async ($, on) => {
      const r = seeded(on, 15 * MIN)
      await $.session.start({ cwd: '/w' } as never)
      await r.clock.advance(5 * MIN + 1_000)
      expect(await r.draw($)).toContain(' Needs you ')
    })

    test('a wait already past the bound (25 minutes) ends at once on attach', async ($, on) => {
      const r = seeded(on, 25 * MIN)
      await $.session.attach({ surface: 'terminal', clientId: 'c1' } as never)
      await r.clock.settle()
      expect(await r.draw($)).toContain(' Needs you ')
    })

    // the normal path (a change() in a copy whose wait timer was never armed) uses the time left as well: not a fresh 20 minutes
    test('a change() 15 minutes into a wait with fresh state arms the bound at +5 minutes, not +20', async ($, on) => {
      const r = seeded(on, 15 * MIN)
      await $.tool.call({ tool: PROGRESS_TOOL, task: 'Run the build', percent: 30 } as never) // no attach or start: only change() syncs
      await r.clock.advance(4 * MIN)
      expect(await r.draw($)).not.toContain(' Needs you ')
      await r.clock.advance(MIN + 1_000)
      expect(await r.draw($)).toContain(' Needs you ')
    })

    test('a normal wait is armed with the time left too: attach again later does not push the bound out', async ($, on) => {
      const r = seeded(on, 15 * MIN)
      await $.session.attach({ surface: 'terminal', clientId: 'c1' } as never)
      await r.clock.advance(3 * MIN)
      await $.session.attach({ surface: 'terminal', clientId: 'c2' } as never) // the same wait: the timer is kept
      await r.clock.advance(2 * MIN + 1_000)
      expect(await r.draw($)).toContain(' Needs you ')
    })
  })

  test('while it waits on work the frame clock stands still', async ($, on) => {
    const r = await rig($, on)
    const tickNow = () => (r.state.get('clean-view/tick')?.value ?? 0) as number
    await r.start('t9')
    await r.clock.advance(1_000)
    expect(tickNow()).toBeGreaterThan(0) // working normally: it moves
    await stopWith($, [shell])
    await complete($, { answer: 'Waiting on the run.', turnId: 't9' })
    await r.clock.settle()
    const at = tickNow()
    await r.clock.advance(5_000)
    expect(tickNow()).toBe(at)
    expect(await r.isNeedsYou()).toBe(false)
  })

  test('the Stop hook: a subagent\'s Stop does not change the flag, and the result passes through unchanged, with a garbage task list too', async ($, on) => {
    const r = await rig($, on)
    const sub = { agent_id: 'sub1', agent_type: 'worker' }
    await r.start('s1')
    await stopWith($, [shell])
    await stopWith($, [], sub) // a subagent's Stop in between: it is not the main loop's word
    await complete($, { answer: 'Waiting on the run.', turnId: 's1' })
    await r.clock.settle()
    expect(await r.isNeedsYou()).toBe(false)
    await r.start('s2')
    await stopWith($, [])
    await stopWith($, [shell], sub)
    await complete($, { answer: 'Done.', turnId: 's2' })
    await r.clock.settle()
    expect(await r.isNeedsYou()).toBe(true)

    // the engine's answer to Stop is what the caller gets, with work listed or not
    r.bottom.stop = () => ({ block: 'keep going' })
    expect(await stopWith($, [shell])).toEqual({ block: 'keep going' })
    // garbage in the list (the one input a naive reader would throw on): the event goes through unchanged, and none of it counts
    expect(await stopWith($, [null, 7, 'x', { status: 'running' }])).toEqual({ block: 'keep going' })
    await r.start('s3')
    await stopWith($, [null, 7, 'x', { status: 'running' }])
    await complete($, { answer: 'Done.', turnId: 's3' })
    await r.clock.settle()
    expect(await r.isNeedsYou()).toBe(true)
  })
})

test('a question (AskUserQuestion) is Needs you while it is open, and a reply clears a wait for the person', async ($, on) => {
  const { clock, bottom } = world(on)
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  bottom.toolCall = async e => {
    if (e.tool === 'AskUserQuestion') await gate
    return { result: 'ok' }
  }
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Choose a colour for me')
  const ask = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] } as never)
  await clock.settle()
  const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'q1' })
  expect(await words(m)).toContain('Claude has a question for you')
  await m.unmount()
  release()
  await ask
  await clock.settle()
  const after = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'q2' })
  expect(await words(after)).not.toContain(' Needs you ')
  await after.unmount()
})

test('T4: /simple off hides the band so only the button stays, /simple on brings it back, no argument flips, and it is saved', async ($, on) => {
  const { clock, log, stored } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Build my landing page')
  await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
  await clock.settle()
  const run = (args: string) => $.command.run({ command: 'simple', args, origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  const draw = async (id: string) => {
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: id })
    const buttons = await m.findAll({ type: 'Button' })
    const w = await words(m)
    const hasEngine = (await m.find({ text: ENGINE })) !== undefined
    await m.unmount()
    return { buttons, w, hasEngine }
  }

  const on1 = await draw('s1')
  expect(on1.w).toContain('One step')

  expect(String((await run('off')).text)).toBe('Clean View is off')
  const off = await draw('s2')
  expect(off.buttons).toHaveLength(2) // the two controls
  expect(off.buttons[0]?.text).toContain('Clean View: OFF')
  expect(off.w).not.toContain('One step')
  expect(off.w.some(x => x.includes('Build my landing page'))).toBe(false)
  expect(off.hasEngine).toBe(true) // the rest of the band renders as normal
  expect(stored.enabled).toBe(false)
  expect(log.toasts.at(-1)).toBe('Clean View is off')

  expect(String((await run('')).text)).toBe('Clean View is on') // no argument flips
  expect((await draw('s3')).w).not.toContain('One step') // turning it off ended the job
  await startTurn($, 'Build another page', 't2')
  await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
  await clock.settle()
  expect((await draw('s4')).w).toContain('One step')
  expect(String((await run('maybe')).text)).toMatch(/Usage: \/simple/)
  expect(String((await run('on')).text)).toBe('Clean View is on')
})

test('T4: it starts on, and an off setting saved in an earlier session is read at start', async ($, on) => {
  world(on, { enabled: false })
  await $.session.start({ cwd: '/w' } as never)
  const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'o1' })
  expect((await m.find({ type: 'Button' }))?.text).toContain('Clean View: OFF')
  await m.unmount()
})

test('the button is there on every screen, even with nothing running; pressing it flips Clean View and toasts', async ($, on) => {
  const { clock, log } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  for (const surface of SURFACES) {
    const m = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: `b-${surface}` })
    const button = await m.find({ type: 'Button' })
    expect(button?.text).toContain('● Clean View: ON')
    expect(await m.find({ text: ENGINE })).toBeDefined()
    await m.press({ key: 'toggle' })
    await clock.settle()
    expect((await m.find({ type: 'Button' }))?.text).toContain('○ Clean View: OFF')
    expect(log.toasts.at(-1)).toBe('Clean View is off')
    await m.press({ key: 'toggle' })
    expect(log.toasts.at(-1)).toBe('Clean View is on')
    await m.unmount()
  }
})

test('the band stays out of the way of a survey', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w' } as never)
  const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ hasSurvey: true }), requestId: 'sv' })
  expect(await m.findAll({ type: 'Button' })).toHaveLength(0)
  expect(await m.find({ text: ENGINE })).toBeDefined()
  await m.unmount()
})

test('T6: any other tool is denied before a plan exists and allowed after (main agent only; a subagent is never denied; allow-listed tools always pass)', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w' } as never)
  await arm($)
  await startTurn($, 'Fix the bug')
  const denied = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(String(denied.deny ?? denied.text)).toContain(PLAN_TOOL)
  expect((await $.tool.call({ tool: 'Read', file_path: '/a.txt' } as never)).deny).toBeDefined()
  expect((await $.tool.call({ tool: PROGRESS_TOOL, task: 'x', percent: 5 } as never)).deny).toBeDefined() // not before a plan

  // a subagent is never gated
  expect((await $.tool.call({ tool: 'Bash', agentId: 'sub1', command: 'ls' } as never)).deny).toBeUndefined()
  // the allow-listed tools always pass
  for (const tool of ['ToolSearch', 'AskUserQuestion']) {
    expect((await $.tool.call({ tool, query: 'x', questions: [] } as never)).deny).toBeUndefined()
  }
  expect((await $.tool.call({ tool: 'TaskUpdate', taskId: '9', status: 'completed' } as never)).deny).toBeUndefined()
  // a plan opens the gate
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Find the bug', 'Fix it'] } as never)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
  // a finished job is over: the next request is a new job and asks for a plan again
  await $.tool.call({ tool: PROGRESS_TOOL, task: 'Fix it', percent: 100 } as never)
  await complete($)
  await startTurn($, 'Now add a footer', 't2')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined()
})

test('T6 (to-do list): TodoWrite and TaskCreate count as a plan', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w' } as never)
  await arm($)
  await startTurn($, 'Fix the bug')
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Find the bug', activeForm: 'x', status: 'in_progress' }] } as never)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
})

test('the gate and the tools are off when Clean View is off', async ($, on) => {
  world(on, { enabled: false })
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Fix the bug')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
  const sections = (await $.prompt.compose(COMPOSE as never)).sections
  expect(sections.map(s => s.id)).toEqual(['engine:intro'])
})

test('a subagent that calls plan_steps or report_progress is answered and changes nothing', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Fix the bug')
  await $.tool.call({ tool: PLAN_TOOL, steps: ['Find the bug', 'Fix it'] } as never)
  const r = await $.tool.call({ tool: PLAN_TOOL, agentId: 'sub1', steps: ['Other', 'Things', 'Entirely'] } as never)
  expect(r.result).toBe('Planned 3 steps. The first one has started.')
  await $.tool.call({ tool: PROGRESS_TOOL, agentId: 'sub1', task: 'Find the bug', percent: 100 } as never)
  await clock.settle()
  const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'sa' })
  const w = await words(m)
  expect(w).toContain('Find the bug')
  expect(w).not.toContain('Other')
  expect(w).not.toContain('✓')
  await m.unmount()
})

test('prompt.compose adds the plain-language section while on, and the section tells Claude what to do', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w' } as never)
  const { sections } = await $.prompt.compose(COMPOSE as never)
  expect(sections.map(s => s.id)).toEqual(['engine:intro', 'clean-view:plan'])
  const body = sections[1]?.text ?? ''
  expect(body).toContain(PLAN_TOOL)
  expect(body).toContain(PROGRESS_TOOL)
  expect(body).toContain('ToolSearch')
  expect(body).toContain('under 40 characters')
  expect(body).toContain('Build the pricing section')
  expect(body).toMatch(/file paths, file names, commands, code or tool names/)
  expect(body).toContain('TodoWrite or TaskCreate')
  expect(body).toContain('even a quick question')
})

test('the job name comes from the prompt, locally: no model is ever called', async ($, on) => {
  const { clock, log } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, 'Please can you build my landing page for the bakery with pricing')
  await clock.settle()
  const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'j1' })
  const w = await words(m)
  expect(headline(w)).toBe('Build my landing page for the')
  // placeholder steps show right away, before any plan
  expect(w).toContain('Understand your request')
  expect(w).toContain('Plan the steps')
  await m.unmount()
  expect(log.modelCalls).toBe(0)
})

test('a slash command does not start a job (and the band is just the button)', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/w' } as never)
  await startTurn($, '/review')
  await clock.settle()
  const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'sl' })
  expect(await words(m)).not.toContain('Understand your request')
  expect(await m.findAll({ type: 'Button' })).toHaveLength(2)
  await m.unmount()
})

describe('the technical rows', () => {
  test('rows of the allowlisted tools are hidden while on, and drawn by the engine when off', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    const drawn = async (component: 'ToolUse' | 'ToolResult' | 'ToolGroup', props: never, surface: 'terminal' | 'desktop' = 'terminal') => {
      const m = await $.ui.mount({ plugin: 'clean-view', surface, component, props, requestId: `r${Math.random()}` })
      const tree = await m.drawn()
      const isEngine = (await m.find({ text: ENGINE })) !== undefined
      await m.unmount()
      return { tree, isEngine }
    }
    for (const surface of SURFACES) {
      const use = await drawn('ToolUse', toolProps(), surface)
      expect(use.isEngine).toBe(false)
      expect(use.tree.type).toBe('Box')
      expect((await drawn('ToolResult', resultProps(), surface)).isEngine).toBe(false)
      const group = await drawn('ToolGroup', { calls: [{ tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }, { tool: 'Grep', input: {}, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded: false } as never, surface)
      expect(group.isEngine).toBe(false)
    }
    const run = (args: string) => $.command.run({ command: 'simple', args, origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    await run('off')
    expect((await drawn('ToolUse', toolProps())).isEngine).toBe(true)
    expect((await drawn('ToolResult', resultProps())).isEngine).toBe(true)
  })

  test('errored, interrupted, question, plan and content-for-the-person rows pass through while on', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    const isEngine = async (component: 'ToolUse' | 'ToolResult', props: never) => {
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component, props, requestId: `e${Math.random()}` })
      const found = (await m.find({ text: ENGINE })) !== undefined
      await m.unmount()
      return found
    }
    expect(await isEngine('ToolUse', toolProps({ isErrored: true }))).toBe(true)
    expect(await isEngine('ToolUse', toolProps({ isInterrupted: true }))).toBe(true)
    for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'SendUserMessage', 'SendUserFile', 'ProposeGoal', 'mcp__srv__authenticate', 'SuggestPlugins', 'OfferHelp', 'ShowGuide']) {
      expect(await isEngine('ToolUse', toolProps({ tool, input: {} }))).toBe(true)
      expect(await isEngine('ToolResult', resultProps({ tool, output: {} }))).toBe(true)
    }
    expect(await isEngine('ToolResult', resultProps({ isErrored: true }))).toBe(true)
    // a refusal or an abort arrives as text
    expect(await isEngine('ToolResult', resultProps({ output: 'The user doesn\'t want to proceed' }))).toBe(true)
    expect(await isEngine('ToolResult', resultProps({ output: null }))).toBe(true)
    // a group with one errored call, or one tool that is not hideable, is the engine's
    const group = async (calls: unknown[]) => {
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolGroup', props: { calls, isActive: false, isExpanded: false } as never, requestId: `g${Math.random()}` })
      const found = (await m.find({ text: ENGINE })) !== undefined
      await m.unmount()
      return found
    }
    const ok = { tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }
    expect(await group([ok, { ...ok, isErrored: true }])).toBe(true)
    expect(await group([ok, { ...ok, tool: 'SendUserMessage' }])).toBe(true)
    expect(await group([ok, ok])).toBe(false)
  })

  test('the answers of plan_steps and report_progress are text and are hidden too, unless they errored', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    const isEngine = async (props: never) => {
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolResult', props, requestId: `o${Math.random()}` })
      const found = (await m.find({ text: ENGINE })) !== undefined
      await m.unmount()
      return found
    }
    expect(await isEngine(resultProps({ tool: PLAN_TOOL, output: 'Planned 2 steps. The first one has started.' }))).toBe(false)
    expect(await isEngine(resultProps({ tool: PROGRESS_TOOL, output: 'Progress noted: 60%.' }))).toBe(false)
    expect(await isEngine(resultProps({ tool: PLAN_TOOL, output: 'Clean View needs a plan', isErrored: true }))).toBe(true)
    expect(await isEngine(resultProps({ tool: 'mcp__srv__lookup', output: 'text from another server' }))).toBe(true)
  })

  test('the background-run hint is blanked while on', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolProgress', props: { tool_use_id: 't', kind: 'background_hint', hint: '(ctrl+b to run in background)' } as never, requestId: 'h1' })
    expect(JSON.stringify(await m.drawn())).not.toContain('ctrl+b')
    await m.unmount()
  })
})

describe('the end of a job', () => {
  test('All done shows the time it took, then shrinks to one line after 5 seconds', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['Read your brand notes', 'Add the contact form'] } as never)
    await clock.advance(134_000)
    await $.tool.call({ tool: PROGRESS_TOOL, task: 'Add the contact form', percent: 100 } as never) // checks off the step before it too
    await complete($)
    await clock.settle()
    const draw = async (id: string) => {
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: id })
      const w = await words(m)
      const buttons = await m.findAll({ type: 'Button' })
      await m.unmount()
      return { w, buttons }
    }
    const full = await draw('d1')
    expect(full.w).toContain(' ✓ All done ') // the badge, the title and the time are three texts
    expect(full.w).toContain('Build my landing page')
    expect(full.w).toContain(' took 2m 14s')
    expect(full.w).toContain('2 of 2 steps')
    expect(full.w).toContain('100%')
    expect(full.w.filter(x => x === 'Done')).toHaveLength(2) // every step row
    expect(full.w).toContain('Read your brand notes') // the rows are still there
    await clock.advance(4_900)
    expect((await draw('d2')).w).toContain('Read your brand notes')
    await clock.advance(200)
    const shrunk = await draw('d3')
    expect(shrunk.w).toContain(' ✓ All done ')
    expect(shrunk.w).toContain(' took 2m 14s')
    expect(shrunk.w).not.toContain('Read your brand notes')
    expect(shrunk.w).not.toContain('2 of 2 steps')
    expect(shrunk.buttons).toHaveLength(2) // the controls stay
  })

  test('steps left over mean Needs you with Claude is waiting for your reply, and a reply continues the job', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    await complete($, { answer: 'Which colour do you like?' })
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: 'w1' })
    const w = await words(m)
    expect(w).toContain(' Needs you ')
    expect(w).toContain('Claude is waiting for your reply')
    await m.unmount()
    await startTurn($, 'Blue', 't2')
    await clock.settle()
    const after = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'w2' })
    const w2 = await words(after)
    expect(w2).not.toContain(' Needs you ')
    expect(headline(w2)).toBe('Build my landing page') // the same job, not a new one
    await after.unmount()
  })

  test('Esc is Stopped with the job name', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    await complete($, { reason: 'aborted', isAborted: true, answer: '' })
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: 'x1' })
    expect(await words(m)).toContain('■ Stopped · Build my landing page · you pressed Esc')
    await m.unmount()
  })

  test('an API error and a refusal are Stuck with one calm sentence', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    const stuckLine = async (id: string) => {
      await clock.settle()
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: id })
      const line = (await words(m)).find(x => x.startsWith('⚠ Stuck:'))
      await m.unmount()
      return line
    }
    await startTurn($, 'Build my landing page')
    await $.classic.StopFailure({ error: 'rate_limit', error_details: '429' } as never)
    await complete($, { reason: 'error', answer: 'API Error: 429' })
    expect(await stuckLine('e1')).toBe('⚠ Stuck: you hit your usage limit, try again a little later')

    await startTurn($, 'Try again', 't2')
    await $.classic.StopFailure({ error: 'overloaded' } as never)
    await complete($, { reason: 'error', answer: 'overloaded_error', turnId: 't2' })
    expect(await stuckLine('e2')).toBe("⚠ Stuck: Claude's servers are busy, try again in a minute")

    await startTurn($, 'Try once more', 't3')
    await $.classic.StopFailure({ error: 'invalid_request', error_details: 'prompt is too long: 300000 tokens' } as never)
    await complete($, { reason: 'error', answer: 'API Error', turnId: 't3' })
    expect(await stuckLine('e3')).toBe('⚠ Stuck: this chat is too long, type /compact and try again')

    await startTurn($, 'And again', 't4')
    await complete($, { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '', turnId: 't4' })
    expect(await stuckLine('e4')).toBe("⚠ Stuck: Claude couldn't help with that request")
  })

  test('you said no to a permission is Stuck at once, and the next success clears it; three failures in a row are Stuck too', async ($, on) => {
    const { clock, bottom } = world(on)
    let next: 'no' | 'fail' | 'ok' = 'ok'
    bottom.toolCall = () => {
      if (next === 'no') return { result: "The user doesn't want to proceed with this tool use. The tool use was rejected", isError: true }
      if (next === 'fail') return { result: 'boom', isError: true }
      return { result: 'ok' }
    }
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    const header = async (id: string) => {
      await clock.settle()
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: id })
      const w = await words(m)
      await m.unmount()
      return w.find(x => x.startsWith('⚠ Stuck:'))
    }
    next = 'no'
    await $.tool.call({ tool: 'Bash', command: 'rm -rf x' } as never)
    expect(await header('f1')).toBe('⚠ Stuck: you said no to a step, so Claude paused')
    next = 'ok'
    await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect(await header('f2')).toBeUndefined()
    next = 'fail'
    await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect(await header('f3')).toBeUndefined()
    await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect(await header('f4')).toBe('⚠ Stuck: a step keeps failing, Claude is trying another way')
    next = 'ok'
    await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect(await header('f5')).toBeUndefined()
  })
})

describe('animation', () => {
  test('a 250 ms clock moves the sweep only while a job is working; nothing runs while idle', async ($, on) => {
    const { clock, state } = world(on)
    const tickNow = async () => (state.get('clean-view/tick')?.value ?? 0) as number
    await $.session.start({ cwd: '/w' } as never)
    await clock.advance(10_000)
    expect(await tickNow()).toBe(0) // idle: no timer

    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    await clock.advance(1_000)
    expect(await tickNow()).toBe(4)
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'an1' })
    const blocks = (await m.findAll({ type: 'Text' })).filter(f => f.text === '█').map(f => f.props.color)
    expect(blocks).toEqual(sweepRuns(4).map(r => r.color)) // the brightest block has stepped four places
    expect(new Set(blocks).size).toBeGreaterThan(2)
    await m.unmount()

    // waiting on the person with no call running stands still
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' } as never)
    await clock.advance(500)
    expect(await tickNow()).toBe(4)

    // done: the clock stops, and so does the collapse timer once it has fired
    await $.tool.call({ tool: PROGRESS_TOOL, task: 'Another step', percent: 100 } as never)
    await complete($)
    const stopped = await tickNow()
    await clock.advance(60_000)
    expect(await tickNow()).toBe(stopped)
  })

  test('a stopped or stuck job does not animate either', async ($, on) => {
    const { clock, state } = world(on)
    const tickNow = async () => (state.get('clean-view/tick')?.value ?? 0) as number
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    await complete($, { reason: 'aborted', isAborted: true })
    const at = await tickNow()
    await clock.advance(10_000)
    expect(await tickNow()).toBe(at)
  })

  test('/clear ends the job and the clock', async ($, on) => {
    const { clock, state } = world(on)
    const tickNow = async () => (state.get('clean-view/tick')?.value ?? 0) as number
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await clock.advance(500)
    await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    await clock.advance(5_000)
    expect(await tickNow()).toBe(0)
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: 'cl' })
    expect(await words(m)).not.toContain('Understand your request')
    await m.unmount()
  })
})

describe('narrow terminals', () => {
  test('the columns are sized from bodyColumns: the meter shrinks to 5 cells and the status column is kept', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['Build the whole pricing section now', 'Add the contact form'] } as never)
    await clock.settle()
    for (const columns of [30, 40, 50, 120]) {
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ bodyColumns: columns }), requestId: `c${columns}` })
      const w = await words(m)
      expect(w).toContain('Working') // the status column stays
      expect(w).toContain('Next')
      const layout = cardLayout(columns)
      expect(layout.meterW).toBe(columns >= 50 ? 10 : 5)
      // every row fits: glyph, label, meter and status, one cell between each, inside the border and padding
      expect(1 + 1 + layout.labelW + 1 + layout.meterW + 1 + layout.statusW).toBeLessThanOrEqual(layout.inner)
      const rows = await m.findAll({ type: 'Box' })
      expect(rows.some(b => b.props.borderStyle === 'round' && b.props.width === columns)).toBe(true)
      await m.unmount()
    }
  })
})

// ---------- the fix round ----------

describe('C1: the gate and the prompt section go together', () => {
  test('C1: a headless run (print trait, or no surface) gets no section and no gate; a teammate or sdk-preset render adds nothing', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    await arm($)
    await startTurn($, 'Fix the bug')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined() // armed
    for (const odd of [{ traits: ['print'] }, { surfaces: [] }, { traits: ['teammate'] }, { traits: ['sdk-preset'] }]) {
      const { sections } = await $.prompt.compose({ ...COMPOSE, ...odd } as never)
      expect(sections.map(s => s.id)).toEqual(['engine:intro'])
    }
    // the headless compose disarmed it: the same tool now passes
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
    // an interactive compose arms it again
    await arm($)
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined()
  })

  test('C1: with no prompt section the gate is open', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug') // compose never ran
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
  })

  test('C1: when the tools could not be registered the section is added but the gate stays open', async ($, on) => {
    const { flags, log } = world(on)
    flags.failRegister = true
    await $.session.start({ cwd: '/w' } as never)
    const { sections } = await arm($)
    expect(sections.map(s => s.id)).toContain('clean-view:plan')
    await startTurn($, 'Fix the bug')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
    // the next turn registers them, and the next compose arms the gate
    flags.failRegister = false
    await startTurn($, 'Fix it again', 't2')
    expect(log.registered).toEqual(['plan_steps', 'report_progress', 'set_effort'])
    await arm($)
    await complete($)
    await startTurn($, 'One more', 't3')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined()
  })
})

describe('C2: a slash command or a skill does not close the gate', () => {
  test('C2: a slash turn has no job and no band rows, and its tools pass; a normal prompt is gated again', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await arm($)
    await startTurn($, '/review')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'c2a' })
    expect(await words(m)).not.toContain('Understand your request')
    expect(await m.findAll({ type: 'Button' })).toHaveLength(2)
    await m.unmount()
    await startTurn($, 'Now fix the bug', 't2')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined()
  })

  test('C2: a skill turn (its command.run was just seen, the turn text is the skill\'s own) also passes; a later prompt does not', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await arm($)
    await $.command.run({ command: 'my-skill', args: '', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    await startTurn($, 'Follow these steps to tidy the project')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeUndefined()
    await complete($)
    await clock.advance(10_000)
    await startTurn($, 'Fix the bug', 't2')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined()
    // /simple is not a turn-starting command
    await $.command.run({ command: 'simple', args: 'on', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    await complete($, { turnId: 't2' })
    await startTurn($, 'Fix the next bug', 't3')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined()
  })
})

describe('I1-I4', () => {
  const tickOf = (state: Map<string, { value: unknown }>) => (state.get('clean-view/tick')?.value ?? 0) as number

  test('I1: a turn that ends in Needs you runs no clock, and notes when it ended', async ($, on) => {
    const { clock, state } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    await clock.advance(1_000)
    const before = tickOf(state)
    expect(before).toBe(4)
    await complete($, { answer: 'Which colour?' }) // steps left: Needs you
    const checklist = state.get('clean-view/checklist')?.value as { phase: string; finishedAt: number | null }
    expect(checklist.phase).toBe('needsYou')
    expect(checklist.finishedAt).not.toBeNull()
    await clock.advance(10_000)
    expect(tickOf(state)).toBe(before)
  })

  test('I1: a running call that a permission dialog holds keeps the meter moving until it ends', async ($, on) => {
    const { clock, state, bottom } = world(on)
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    bottom.toolCall = async () => {
      await gate
      return { result: 'ok' }
    }
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Run the build')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['Run the build', 'Check the result'] } as never)
    const call = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm run build' } as never)
    await clock.settle()
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' } as never)
    const at = tickOf(state)
    await clock.advance(1_000)
    expect(tickOf(state)).toBeGreaterThan(at)
    release()
    await call
    await clock.settle()
    const after = tickOf(state)
    await clock.advance(2_000)
    expect(tickOf(state)).toBeGreaterThanOrEqual(after) // working again (the dialog is over)
  })

  test('I2: turning it off ends the job and stops the timers', async ($, on) => {
    const { clock, state } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    await clock.advance(500)
    expect(tickOf(state)).toBeGreaterThan(0)
    await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect((state.get('clean-view/checklist')?.value as { phase: string }).phase).toBe('idle')
    const stopped = tickOf(state)
    await clock.advance(10_000)
    expect(tickOf(state)).toBe(stopped)
  })

  test('I3: the toggle works even when the store fails (command and button)', async ($, on) => {
    const { clock, flags, log } = world(on)
    flags.failStoreSet = true
    await $.session.start({ cwd: '/w' } as never)
    const run = (args: string) => $.command.run({ command: 'simple', args, origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect(String((await run('off')).text)).toBe('Clean View is off')
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: 'i3' })
    expect((await m.find({ type: 'Button' }))?.text).toContain('Clean View: OFF')
    await m.press({ key: 'toggle' })
    await clock.settle()
    expect((await m.find({ type: 'Button' }))?.text).toContain('Clean View: ON')
    expect(log.toasts.at(-1)).toBe('Clean View is on')
    await m.unmount()
  })

  test('I4: the toggle button keeps hotkey c and takes no autofocus', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: 'i4' })
    const tree = JSON.stringify(await m.drawn())
    expect(tree).toContain('"hotkey":"c"')
    expect(tree).not.toContain('autoFocus')
    await m.unmount()
  })
})

describe('minor fixes', () => {
  const mountRow = async ($: never, component: 'ToolUse' | 'ToolResult', props: never) => {
    const m = await ($ as { ui: { mount: (a: never) => Promise<{ find: (q: { text: string }) => Promise<unknown>; unmount: () => Promise<void> }> } }).ui.mount({ plugin: 'clean-view', surface: 'terminal', component, props, requestId: `mr${Math.random()}` } as never)
    const isEngine = (await m.find({ text: ENGINE })) !== undefined
    await m.unmount()
    return isEngine
  }

  test('M1: the gate\'s own refusal row is hidden, any other errored row is shown', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    const gate = 'Clean View needs a plan before any other tool: call ' + PLAN_TOOL + ' first (load it with ToolSearch if it is deferred) with 2 to 8 short plain-English steps, then try this tool again.'
    expect(await mountRow($ as never, 'ToolUse', toolProps({ tool: 'Bash', isErrored: true, output: gate }))).toBe(false)
    expect(await mountRow($ as never, 'ToolResult', resultProps({ tool: 'Bash', isErrored: true, output: gate }))).toBe(false)
    expect(await mountRow($ as never, 'ToolUse', toolProps({ tool: 'Bash', isErrored: true, output: gate + ' extra' }))).toBe(true)
    expect(await mountRow($ as never, 'ToolUse', toolProps({ tool: 'Bash', isErrored: true, output: 'ENOENT' }))).toBe(true)
    expect(await mountRow($ as never, 'ToolResult', resultProps({ tool: 'Bash', isErrored: true, output: 'ENOENT' }))).toBe(true)
  })

  test('M2: a deny that is not the person\'s "no" is a failure, never "you said no"', async ($, on) => {
    const { clock, bottom } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step'] } as never)
    bottom.toolCall = () => ({ deny: "The user doesn't want to proceed (said by another plugin)" })
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'm2' })
    expect((await words(m)).find(x => x.startsWith('⚠ Stuck:'))).toBeUndefined()
    await m.unmount()
  })

  test('M3: the error kind decides first, then the error details; the model\'s own words never do', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    const sentence = async (failure: Record<string, unknown>, id: string, turn: string) => {
      await startTurn($, 'Build my landing page', turn)
      await $.classic.StopFailure(failure as never)
      await complete($, { reason: 'error', answer: 'the network is down and you hit your usage limit', turnId: turn })
      await clock.settle()
      const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: id })
      const line = (await words(m)).find(x => x.startsWith('⚠ Stuck:'))
      await m.unmount()
      return line
    }
    // the kind wins over details that say something else
    expect(await sentence({ error: 'rate_limit', error_details: 'ECONNRESET', last_assistant_message: 'network' }, 'a', 't1')).toBe('⚠ Stuck: you hit your usage limit, try again a little later')
    // an unclassified kind: the details decide
    expect(await sentence({ error: 'unknown', error_details: 'fetch failed: ECONNRESET', last_assistant_message: 'usage limit' }, 'b', 't2')).toBe('⚠ Stuck: the internet connection dropped')
    // the model's words alone (last_assistant_message, the answer) say nothing
    expect(await sentence({ error: 'unknown', last_assistant_message: 'you hit your usage limit' }, 'c', 't3')).toBe('⚠ Stuck: something went wrong, try again in a moment')
  })

  test('M3: a StopFailure that arrives after the turn ended sharpens the generic sentence', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await complete($, { reason: 'error', answer: '' })
    await $.classic.StopFailure({ error: 'overloaded' } as never)
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps({ isWorking: false }), requestId: 'm3b' })
    expect(await words(m)).toContain("⚠ Stuck: Claude's servers are busy, try again in a minute")
    await m.unmount()
  })

  test('M4: only the background-run hint is blanked', async ($, on) => {
    const { seen } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    const other = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolProgress', props: { tool_use_id: 't', kind: 'something_else', hint: 'KEEP THIS HINT' } as never, requestId: 'm4' })
    expect(seen.props.hint).toBe('KEEP THIS HINT') // another kind of progress row is the engine's, untouched
    await other.unmount()
    const bg = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolProgress', props: { tool_use_id: 't', kind: 'background_hint', hint: '(ctrl+b to run in background)' } as never, requestId: 'm4b' })
    expect(seen.props.hint).toBe('')
    await bg.unmount()
  })

  test('M7: every checklist row Box has a key', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build my landing page')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['One step', 'Another step', 'Third step'] } as never)
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'm7' })
    for (const key of ['row-0', 'row-1', 'row-2']) expect(await m.find({ key })).toBeDefined()
    await m.unmount()
  })
})

describe('M8: the card look', () => {
  type Found = { text: string; props: Record<string, unknown> }
  type Drawn = { findAll: (q: Record<string, unknown>) => Promise<Found[]>; find: (q: Record<string, unknown>) => Promise<Found | undefined>; unmount: () => Promise<void> }
  const draw = async ($: never, props: Record<string, unknown> = {}, id = 'k'): Promise<Drawn> => {
    const m = await ($ as { ui: { mount: (a: never) => Promise<never> } }).ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'AbovePrompt', props: promptProps(props), requestId: id } as never)
    return m as unknown as Drawn
  }

  test('the working card: a round magenta border, the ✧ mark, a gradient title, Step 1 of 2, Working and Next', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build a weather dashboard for New York City')
    await clock.settle()
    for (const surface of SURFACES) {
      const m = (await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: promptProps(), requestId: `l-${surface}` })) as unknown as Drawn
      const boxes = await m.findAll({ type: 'Box' })
      const card = boxes.find(b => b.props.borderStyle === 'round')
      expect(card?.props.borderColor).toBe(MAGENTA)
      const w = (await m.findAll({ type: 'Text' })).map(f => f.text)
      expect(w).toContain('✧ ')
      expect(headline(w)).toBe('Build a weather dashboard for New')
      expect(w).toContain('Step 1 of 2')
      expect(w).toContain('Working')
      expect(w).toContain('Next')
      expect(w).toContain('Understand your request')
      expect(w).toContain('Plan the steps')
      // the title is one text per word, in at least two colours; the current step is bold on the theme text colour
      const words = (await m.findAll({ type: 'Text' })).filter(f => f.props.bold === true && ['Build ', 'a ', 'weather ', 'dashboard ', 'for ', 'New'].includes(f.text))
      expect(words).toHaveLength(6)
      expect(new Set(words.map(f => f.props.color)).size).toBeGreaterThanOrEqual(2)
      expect((await m.find({ type: 'Text', text: 'Understand your request' }))?.props.bold).toBe(true)
      expect((await m.find({ type: 'Text', text: 'Plan the steps' }))?.props.color).toBe('inactive')
      // the dots: current magenta, upcoming hollow
      expect((await m.find({ type: 'Text', text: '●' }))?.props.color).toBe(MAGENTA)
      expect(await m.find({ type: 'Text', text: '○' })).toBeDefined()
      // the controls are one dim row under the card
      expect((await m.find({ key: 'toggle' }))?.props.dimColor).toBe(true)
      expect((await m.find({ key: 'sessions' }))?.props.dimColor).toBe(true)
      await m.unmount()
    }
  })

  test('the done card: a green border, the badge, N of N steps, a full-width bar, 100% and Done rows', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Build a weather dashboard')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['Pick the page style', 'Check the weather source', 'Build the dashboard', 'Publish it'] } as never)
    await clock.advance(64_000)
    await $.tool.call({ tool: PROGRESS_TOOL, task: 'Publish it', percent: 100 } as never)
    await complete($)
    await clock.settle()
    const m = await draw($ as never, { isWorking: false, bodyColumns: 80 }, 'done')
    const card = (await m.findAll({ type: 'Box' })).find(b => b.props.borderStyle === 'round')
    expect(card?.props.borderColor).toBe(GREEN)
    const w = (await m.findAll({ type: 'Text' })).map(f => f.text)
    expect(w).toContain(' ✓ All done ')
    expect((await m.find({ type: 'Text', text: ' ✓ All done ' }))?.props.backgroundColor).toBe(GREEN)
    expect(w).toContain('Build a weather dashboard')
    expect(w).toContain(' took 1m 04s')
    expect(w).toContain('4 of 4 steps')
    expect(w).toContain('100%')
    expect(w.filter(x => x === 'Done')).toHaveLength(4)
    expect(w.filter(x => x === '✓')).toHaveLength(4)
    // the full-width bar: green cells from dark to light, as wide as the card leaves room for
    const bar = (await m.findAll({ type: 'Text' })).filter(f => /^█+$/.test(f.text) && f.text.length > 1)
    expect(bar.reduce((n, f) => n + f.text.length, 0)).toBe(80 - 4 - '4 of 4 steps'.length - 4 - 2)
    expect(new Set(bar.map(f => f.props.color)).size).toBeGreaterThan(2)
    expect(doneRuns(10).every(r => /^#[0-9a-f]{6}$/.test(r.color))).toBe(true)
    await m.unmount()
  })

  test('Needs you, Stuck and Stopped keep their meaning in the border and the title line', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Run the build')
    await $.tool.call({ tool: PLAN_TOOL, steps: ['Run the build', 'Check the result'] } as never)
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' } as never)
    await clock.settle()
    const border = async (id: string) => {
      const m = await draw($ as never, {}, id)
      const color = (await m.findAll({ type: 'Box' })).find(b => b.props.borderStyle === 'round')?.props.borderColor
      await m.unmount()
      return color
    }
    expect(await border('n1')).toBe('warning')
    await complete($, { reason: 'aborted', isAborted: true })
    await clock.settle()
    expect(await border('n2')).toBe('inactive')
    await startTurn($, 'Try again', 't2')
    await complete($, { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '', turnId: 't2' })
    await clock.settle()
    expect(await border('n3')).toBe('error')
  })

  test('the bar of a step with a percent fills in the same gradient; the moving blocks and the fill are plain data', () => {
    const half = fillRuns(50, 10)
    expect(half.map(r => r.text).join('')).toBe('█████░░░░░')
    expect(new Set(half.filter(r => r.text[0] === '█').map(r => r.color)).size).toBeGreaterThan(2)
    expect(fillRuns(0, 10).map(r => r.text).join('')).toBe('░░░░░░░░░░')
    expect(fillRuns(100, 10).map(r => r.text).join('')).toBe('██████████')
    expect(fillRuns(1, 10).map(r => r.text).join('')).toBe('█░░░░░░░░░') // started is never empty
    expect(fillRuns(99, 10).map(r => r.text).join('')).toBe('█████████░') // unfinished is never full
    // the blocks of a step with no percent: five of them, and the brightest steps along
    const a = sweepRuns(0).map(r => r.color)
    const b = sweepRuns(1).map(r => r.color)
    expect(a).toHaveLength(5)
    expect(a).not.toEqual(b)
    expect(sweepRuns(5).map(r => r.color)).toEqual(a)
  })
})

describe('one plugin, set up once', () => {
  test('each tool and each command is registered once, however many starts, attaches and turns follow', async ($, on) => {
    const { log } = world(on)
    await $.session.start({ cwd: '/w' } as never)
    await $.session.attach({ surface: 'terminal', clientId: 'c1' } as never)
    await startTurn($, 'Build my landing page')
    await startTurn($, 'And more', 't2')
    await $.session.start({ cwd: '/w' } as never)
    expect(log.registered).toEqual(['plan_steps', 'report_progress', 'set_effort'])
    expect(log.commands).toEqual(['simple', 'sessions', 'shabbos'])
  })

  test('/sessions and /simple are answered by their own handler through the one command hook, and the other commands pass', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/w' } as never)
    const run = (command: string, args = '') => $.command.run({ command, args, origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect(String((await run('simple', 'off')).text)).toBe('Clean View is off')
    expect(String((await run('sessions', 'wat')).text)).toBe('Usage: /sessions [lock|unlock|theme [dark|warm]]')
    expect(String((await run('simple', 'wat')).text)).toBe('Usage: /simple [on|off]')
    expect(String((await run('other')).text)).toBe('') // the engine's answer
  })
})

// ---------- set_effort: the effort lever (the turn.step hook applies it to the next request) ----------

describe('set_effort: the pure rules', () => {
  test('M1: only the five levels, spelled exactly, are accepted', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const level of EFFORT_LEVELS) expect(parseLevel(level)).toBe(level)
    for (const bad of ['ultra', 'HIGH', ' high', '', 'extra high', 3, null, undefined, {}, ['high']]) expect(parseLevel(bad)).toBeNull()
    expect(EFFORT_TOOL).toBe('mcp__clean-view__set_effort')
  })

  test('M2/M3: one key per loop; clearing one loop leaves the others; a new turn clears only the main key', () => {
    const map: EffortOverrides = new Map()
    setOverride(map, undefined, 'high')
    setOverride(map, 'a1', 'low')
    expect(overrideOf(map, undefined)).toBe('high')
    expect(overrideOf(map, 'a1')).toBe('low')
    expect(overrideOf(map, 'a2')).toBeUndefined()
    expect(overrideOf(map, 'main')).toBeUndefined() // a subagent literally named "main" is not the main loop
    clearLoop(map, 'a1')
    expect(overrideOf(map, undefined)).toBe('high')
    expect(overrideOf(map, 'a1')).toBeUndefined()
    setOverride(map, 'a1', 'max')
    clearLoop(map, undefined)
    expect(overrideOf(map, undefined)).toBeUndefined()
    expect(overrideOf(map, 'a1')).toBe('max')
    setOverride(map, undefined, 'low')
    clearMain(map)
    expect(overrideOf(map, undefined)).toBeUndefined()
    expect(overrideOf(map, 'a1')).toBe('max') // a running subagent keeps its own
  })

  test('effort I2: pruneAgents bounds the subagent keys by the cap alone (the oldest go first) and never touches the main key', () => {
    const map: EffortOverrides = new Map()
    setOverride(map, undefined, 'high')
    setOverride(map, 'a1', 'low')
    pruneAgents(map) // under the cap: nothing goes, whatever an agent list would say
    expect(overrideOf(map, 'a1')).toBe('low')
    expect(overrideOf(map, undefined)).toBe('high')
    for (let i = 0; i < MAX_AGENT_KEYS + 5; i++) setOverride(map, `s${i}`, 'low')
    setOverride(map, 's0', 'high') // a later call is the newest again
    pruneAgents(map)
    expect([...map.keys()].filter(k => k.startsWith('agent:'))).toHaveLength(MAX_AGENT_KEYS)
    expect(overrideOf(map, 's0')).toBe('high')
    expect(overrideOf(map, 'a1')).toBeUndefined() // the oldest went
    expect(overrideOf(map, 's1')).toBeUndefined()
    expect(overrideOf(map, `s${MAX_AGENT_KEYS + 4}`)).toBe('low')
    expect(overrideOf(map, undefined)).toBe('high')
    pruneAgents(map, 2)
    expect([...map.keys()].filter(k => k.startsWith('agent:'))).toHaveLength(2)
    expect(overrideOf(map, undefined)).toBe('high')
  })

  test('M4: the effective effort is the override, else the engine effort; a model without effort shows none', () => {
    expect(effectiveEffort('low', 'high')).toBe('high')
    expect(effectiveEffort('low', undefined)).toBe('low')
    expect(effectiveEffort(7, undefined)).toBe('7')
    expect(effectiveEffort(undefined, 'high')).toBeNull()
    expect(effectiveEffort(undefined, undefined)).toBeNull()
  })
})

describe('set_effort: the tool and the turn.step hook', () => {
  type Sent = { agentId?: string; effort?: unknown; model: string }

  // The engine's bottom of turn.step records every request it is sent, and answers an empty end-of-turn.
  function effortWorld(on: On) {
    const w = world(on)
    const sent: Sent[] = []
    on('turn.step', async function* (_$, e) {
      sent.push(e as Sent)
      yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    return { ...w, sent }
  }
  const stepOf = async ($: { turn: { step: (e: never) => AsyncIterable<unknown> } }, o: Record<string, unknown> = {}) => {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5', effort: 'low', messageCount: 1, ...o } as never)) void _
  }
  const setEffort = ($: { tool: { call: (e: never) => Promise<{ result?: unknown; deny?: string }> } }, level: unknown, o: Record<string, unknown> = {}) =>
    $.tool.call({ tool: EFFORT_TOOL, level, ...o } as never)
  const liveEffort = (state: Map<string, { value: unknown }>) => (state.get('clean-view/live')?.value as { effort: string | null } | undefined)?.effort

  test('M1: set_effort is registered with the other two tools', async ($, on) => {
    const { log } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    expect(log.registered).toContain('set_effort')
  })

  test('M1: a valid level is stored and answered; any other value is an error and changes nothing', async ($, on) => {
    const { sent } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    for (const bad of ['ultra', 'HIGH', 3, undefined]) {
      const r = await setEffort($, bad)
      expect(r.deny).toContain('low, medium, high, xhigh, max')
      expect(r.result).toBeUndefined()
    }
    await stepOf($)
    expect(sent.at(-1)?.effort).toBe('low') // untouched by the refused calls
    for (const level of EFFORT_LEVELS) {
      const ok = await setEffort($, level)
      expect(ok.deny).toBeUndefined()
      expect(String(ok.result)).toContain(level)
      await stepOf($)
      expect(sent.at(-1)?.effort).toBe(level)
    }
    expect((await setEffort($, 'bogus')).deny).toBeDefined() // a refused call after a good one keeps the good one
    await stepOf($)
    expect(sent.at(-1)?.effort).toBe('max')
  })

  test('M2: the main loop override reaches the next step; a subagent step is unchanged; a subagent call only sets its own loop', async ($, on) => {
    const { sent } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await setEffort($, 'high')
    await stepOf($)
    await stepOf($, { agentId: 'sub1', effort: 'medium' })
    expect(sent.map(s => [s.agentId, s.effort])).toEqual([[undefined, 'high'], ['sub1', 'medium']])

    // a subagent's call is attributed by its agentId: it never touches the main loop
    await setEffort($, 'max', { agentId: 'sub1' })
    await stepOf($)
    await stepOf($, { agentId: 'sub1', effort: 'medium' })
    await stepOf($, { agentId: 'sub2', effort: 'medium' })
    expect(sent.slice(2).map(s => [s.agentId, s.effort])).toEqual([[undefined, 'high'], ['sub1', 'max'], ['sub2', 'medium']])
  })

  test('M2: set_effort is answered before the plan gate, with Clean View on or off', async ($, on) => {
    effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await arm($)
    await startTurn($, 'Fix the bug')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBeDefined() // the gate is armed, no plan yet
    expect((await setEffort($, 'high')).deny).toBeUndefined()
    await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect(String((await setEffort($, 'low')).result)).toContain('low')
  })

  test('M3: the main loop override ends with the main turn.complete, and a subagent turn.complete leaves it alone', async ($, on) => {
    const { sent } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await setEffort($, 'high')
    await setEffort($, 'max', { agentId: 'sub1' })
    await complete($, { agentId: 'sub1' }) // the subagent's run ended: only its own key goes
    await stepOf($)
    await stepOf($, { agentId: 'sub1', effort: 'medium' })
    expect(sent.map(s => [s.agentId, s.effort])).toEqual([[undefined, 'high'], ['sub1', 'medium']])
    await complete($) // the main turn ended
    await stepOf($)
    expect(sent.at(-1)?.effort).toBe('low')
  })

  test('effort M3/I2: a new turn.start clears the main override and keeps every subagent key, listed by the engine or not (a workflow agent is not listed)', async ($, on) => {
    const { sent } = effortWorld(on)
    // the list stays on purpose: sub2 is listed, sub1 is not, and both keep their override, so the list plays no part in the prune
    on('agent.list', () => ({ value: [{ id: 'sub2', status: 'running', description: 'bg', type: 'general-purpose' }] as never }))
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await setEffort($, 'high')
    await setEffort($, 'max', { agentId: 'sub1' }) // not in the engine list (a workflow agent): still running, keeps its own
    await setEffort($, 'xhigh', { agentId: 'sub2' }) // listed and running
    await startTurn($, 'Next request', 't2')
    await stepOf($)
    await stepOf($, { agentId: 'sub1', effort: 'medium' })
    await stepOf($, { agentId: 'sub2', effort: 'medium' })
    expect(sent.map(s => [s.agentId, s.effort])).toEqual([[undefined, 'low'], ['sub1', 'max'], ['sub2', 'xhigh']])
  })

  test('effort I2: with an unreadable agent list a new turn.start behaves the same: subagent keys kept, the main one cleared', async ($, on) => {
    const { sent } = effortWorld(on)
    on('agent.list', () => ({ deny: 'no list' }) as never)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await setEffort($, 'high')
    await setEffort($, 'max', { agentId: 'sub1' })
    await startTurn($, 'Next request', 't2')
    await stepOf($)
    await stepOf($, { agentId: 'sub1', effort: 'medium' })
    expect(sent.map(s => [s.agentId, s.effort])).toEqual([[undefined, 'low'], ['sub1', 'max']])
  })

  test('effort I2: past the cap a new turn.start drops the oldest subagent keys, not the newest', async ($, on) => {
    const { sent } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    for (let i = 0; i < MAX_AGENT_KEYS + 1; i++) await setEffort($, 'max', { agentId: `w${i}` })
    await startTurn($, 'Next request', 't2')
    await stepOf($, { agentId: 'w0', effort: 'medium' }) // the oldest was pruned
    await stepOf($, { agentId: `w${MAX_AGENT_KEYS}`, effort: 'medium' }) // the newest kept
    expect(sent.map(s => [s.agentId, s.effort])).toEqual([['w0', 'medium'], [`w${MAX_AGENT_KEYS}`, 'max']])
  })

  test('M4: the live effort Clean View shows is the effective one, and goes back with the turn', async ($, on) => {
    const { state } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await stepOf($)
    expect(liveEffort(state)).toBe('low')
    await setEffort($, 'xhigh')
    await stepOf($)
    expect(liveEffort(state)).toBe('xhigh')
    await complete($) // a) the turn ended: the viewer is back on the base effort at once, while idle
    expect(liveEffort(state)).toBe('low')
    await startTurn($, 'Next request', 't2')
    await stepOf($)
    expect(liveEffort(state)).toBe('low')
  })

  test('a) a subagent turn.complete does not reset the main effort shown', async ($, on) => {
    const { state } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await setEffort($, 'xhigh')
    await stepOf($)
    await complete($, { agentId: 'sub1' })
    expect(liveEffort(state)).toBe('xhigh')
  })

  test('effort I1: a step with no effort (a model without it) passes unchanged with an override set, and shows no effort', async ($, on) => {
    const { sent, state } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await setEffort($, 'high')
    await setEffort($, 'max', { agentId: 'sub1' })
    const noEffort = { turnId: 't1', index: 1, model: 'claude-haiku-5', messageCount: 2, effort: undefined }
    await stepOf($, noEffort)
    await stepOf($, { ...noEffort, agentId: 'sub1' })
    expect(sent[0]).toEqual(noEffort)
    expect(sent[0]?.effort).toBeUndefined()
    expect(sent[1]).toEqual({ ...noEffort, agentId: 'sub1' })
    expect(liveEffort(state) ?? null).toBeNull()
    await stepOf($) // back on a model with effort: the override applies again
    expect(sent[2]?.effort).toBe('high')
    expect(liveEffort(state)).toBe('high')
  })

  test('M4: a subagent override does not move the main effort shown', async ($, on) => {
    const { state } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    await setEffort($, 'max', { agentId: 'sub1' })
    await stepOf($, { agentId: 'sub1', effort: 'medium' })
    await stepOf($)
    expect(liveEffort(state)).toBe('low')
  })

  test('M5: with no override the step reaches the engine exactly as it came', async ($, on) => {
    const { sent } = effortWorld(on)
    await $.session.start({ cwd: '/w' } as never)
    await startTurn($, 'Fix the bug')
    const input = { turnId: 't1', index: 3, model: 'claude-opus-5', effort: 'medium', messageCount: 9 }
    await stepOf($, input)
    await stepOf($, { ...input, agentId: 'sub1', effort: 7 })
    await stepOf($, { turnId: 't1', index: 4, model: 'claude-haiku-5', messageCount: 2, effort: undefined })
    expect(sent[0]).toEqual(input)
    expect(sent[1]).toEqual({ ...input, agentId: 'sub1', effort: 7 })
    expect(sent[2]?.effort).toBeUndefined()
    expect(sent[2]).toEqual({ turnId: 't1', index: 4, model: 'claude-haiku-5', messageCount: 2, effort: undefined })
  })
})
