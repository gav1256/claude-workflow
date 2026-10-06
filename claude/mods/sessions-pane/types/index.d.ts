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

/** What this session knows about itself, held in $.state so a hot reload does not lose it. */
export type LiveState = {
  model: string | null
  effort: string | null
  /** The last turn ended on a question, and no prompt has answered it yet. */
  question: boolean
  busy: boolean
  pending: LiveCall[]
}

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
