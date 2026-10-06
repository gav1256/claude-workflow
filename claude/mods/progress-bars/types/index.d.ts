/** One task of the model's list, from TodoWrite or from TaskCreate / TaskUpdate. */
export type TaskItem = {
  id: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** What the turn bar draws from, held in $.state so a hot reload does not lose it. */
export type ProgressState = {
  /** The latest task list of the main loop; null until the model makes one. */
  tasks: TaskItem[] | null
  /** Tool calls the main loop started and finished since the turn began. */
  started: number
  finished: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bars': {
      progress: ProgressState
      /** The on/off switch, mirrored from $.store (loaded once at session start). null: not loaded yet. */
      enabled: boolean | null
    }
  }
}
