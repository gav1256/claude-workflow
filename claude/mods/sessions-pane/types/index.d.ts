export type WaitKind = 'permission' | 'question' | 'ask'

export type SessionState = 'waiting' | 'asking' | 'busy' | 'idle'

/** A tool call of this session that waits on the person: a permission dialog or an AskUserQuestion dialog. */
export type LiveCall = {
  id: string
  kind: 'permission' | 'ask'
  /** The subagent loop the call runs in; absent for the main loop. */
  agentId?: string
  /** Set on an entry that could not be paired with a running call (an `anon-` id): when it was made, and its tool. */
  at?: number
  tool?: string
}

/** One task of the session's own list (TodoWrite, TaskCreate/TaskUpdate, plan_steps/report_progress). */
export type TaskItem = {
  id: string
  name?: string
  status: 'pending' | 'in_progress' | 'completed'
  /** The percent (0-100) reported for the step in progress (report_progress). */
  percent?: number
}

/** The session's task progress as it is published to the other sessions. */
export type TaskProgress = {
  done: number
  total: number
  /** The name of the task in progress, when it has one. */
  activeName?: string
  /** The percent (0-100) of the step in progress; the meter fills done + percent/100 steps. */
  percent?: number
}

/** What this session knows about itself, held in $.state so a hot reload does not lose it. */
export type LiveState = {
  model: string | null
  effort: string | null
  /** The last turn ended on a question, and no prompt has answered it yet. */
  question: boolean
  busy: boolean
  pending: LiveCall[]
  /** The session's own task list (main loop only); null before it made one. Absent in state kept by an older load. */
  tasks?: TaskItem[] | null
}

/** What a row's meter shows: live task progress first, else the GOAL.md checklist. */
export type RowProgress = TaskProgress & { source: 'tasks' | 'goal' }

/** One row of the sessions pane. */
export type SessionRow = {
  id: string
  name: string
  isSelf: boolean
  model: string
  effort: string
  state: SessionState
  waiting: WaitKind | null
  /** `done/total` of the session's GOAL.md checklist, or null when it has none. */
  goal: string | null
  /** The meter of the row: task progress, else the goal count, else null (nothing drawn). */
  progress: RowProgress | null
}

declare module 'claude-code' {
  interface PluginState {
    'sessions-pane': {
      rows: SessionRow[]
      isLocked: boolean
      live: LiveState
    }
  }
}
