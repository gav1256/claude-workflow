// Clean View (the checklist) and Sessions (the pane) share one plugin, so one contract.

/** One row of the checklist. */
export type TaskStatus = 'done' | 'active' | 'upcoming'

export type CleanTask = {
  id: string
  /** Plain words, already through the name cleaner (at most 40 characters). */
  name: string
  status: TaskStatus
  /** 0 to 100. A done step is 100. */
  percent: number
  /** True once Claude has reported a percent for the step, so the meter shows it instead of the moving sweep. */
  hasReported: boolean
}

/** idle: no job. working: Claude is on it. needsYou: waiting on the person. stuck: failed or refused. stopped: Esc. done: finished. */
export type Phase = 'idle' | 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

/** What the band draws from, held in $.state so a hot reload keeps it. */
export type Checklist = {
  /** The job's name, 2 to 6 plain words. */
  title: string
  phase: Phase
  tasks: CleanTask[]
  /** The reason shown beside the Needs you badge. */
  needsYouReason: string | null
  /** The one plain sentence shown after "Stuck:". */
  stuckReason: string | null
  /** Milliseconds since the epoch; null until a job starts / finishes. */
  startedAt: number | null
  finishedAt: number | null
  /** True once a finished job has shrunk to one line. */
  isCollapsed: boolean
  /** Counts jobs; a late timer for an older job is ignored. */
  jobId: number
  /** True once a real plan exists (plan_steps, TodoWrite or TaskCreate); the plan gate lets tools through from then on. */
  hasPlan: boolean
  /** Failed tool calls in a row; a success resets it. */
  failStreak: number
}

export type WaitKind = 'permission' | 'question' | 'ask'

export type SessionState = 'waiting' | 'asking' | 'busy' | 'agents' | 'idle'

/** One running subagent of a session, as the agents popup lists it (strings cut to 40 characters). */
export type AgentEntry = {
  name: string
  model: string
  effort: string
}

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

/** One task of the session's own list (TodoWrite, TaskCreate/TaskUpdate): the fallback progress while Clean View is off. */
export type TaskItem = {
  id: string
  name?: string
  status: 'pending' | 'in_progress' | 'completed'
  /** The percent (0-100) reported for the step in progress. */
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
  /** Running subagents of the session; null or absent: unknown (a registry-only session, or an older record). */
  agents?: number | null
  /** Their model and effort, at most 12; null or absent: not published. */
  agentList?: AgentEntry[] | null
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      /** The Clean View on/off switch, mirrored from $.store (loaded once at session start). null: not loaded yet. */
      cleanViewEnabled: boolean | null
      checklist: Checklist
      /** Frame counter of the meter's moving sweep. It moves only while a job is working or waiting on the person. */
      tick: number
      /** The sessions pane's rows. */
      rows: SessionRow[]
      /** The id of the session whose agents popup is shown; null before any. */
      agentsView: string | null
      /** Whether the sessions pane is locked open (mirrored from $.store). */
      isLocked: boolean
      /** What this session knows about itself (model, effort, open dialogs, its own task list). */
      live: LiveState
    }
  }
}
