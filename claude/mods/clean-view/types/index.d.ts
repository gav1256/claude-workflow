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

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      /** The on/off switch, mirrored from $.store (loaded once at session start). null: not loaded yet. */
      cleanViewEnabled: boolean | null
      checklist: Checklist
      /** Frame counter of the meter's moving sweep. It moves only while a job is working or waiting on the person. */
      tick: number
    }
  }
}
