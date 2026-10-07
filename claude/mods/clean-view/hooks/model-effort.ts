// The pure rules of the set_effort tool: which levels exist, and the per-loop override the turn.step hook applies. No `$`
// here. The tool exists because, in permission mode `auto`, an `effort-<level>` skill's effort layer is usually lost; a
// `turn.step` hook that passes the wanted effort to `next` applies it to the next model request every time.

import { PLUGIN_NAME } from './model'

export const EFFORT_TOOL = `mcp__${PLUGIN_NAME}__set_effort`

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

// The exact spelling of a level, or null (any other value, a number, a wrong case, is refused and changes nothing).
export function parseLevel(value: unknown): EffortLevel | null {
  return EFFORT_LEVELS.find(level => level === value) ?? null
}

// One override per model loop: the main loop (no agentId) and each subagent by its own id, so a subagent's call can
// never change the main loop's effort.
export type EffortOverrides = Map<string, EffortLevel>

const MAIN_KEY = 'main'
const AGENT_PREFIX = 'agent:'
export const MAX_AGENT_KEYS = 32 // the bound on subagent keys (the oldest go first)
export const loopKey = (agentId: string | undefined): string => (agentId === undefined ? MAIN_KEY : `${AGENT_PREFIX}${agentId}`)

// A later call of the same loop moves it to the newest place (the Map keeps insertion order, which the cap in pruneAgents uses).
export function setOverride(map: EffortOverrides, agentId: string | undefined, level: EffortLevel): void {
  const key = loopKey(agentId)
  map.delete(key)
  map.set(key, level)
}

export const overrideOf = (map: EffortOverrides, agentId: string | undefined): EffortLevel | undefined => map.get(loopKey(agentId))

// A loop's turn ended: only its own key goes (a subagent's end never clears the main loop's, nor the reverse).
export function clearLoop(map: EffortOverrides, agentId: string | undefined): void {
  map.delete(loopKey(agentId))
}

// A new user turn starts: the main loop's override from an earlier turn does not survive (a crash path may have left it).
// A subagent (or workflow agent) still running keeps its own (see pruneAgents).
export const clearMain = (map: EffortOverrides): void => clearLoop(map, undefined)

// Bounds the subagent keys by size alone: when more than `cap` exist the oldest go (insertion order; a later call of the same
// loop is the newest). Not by the engine's agent list: a workflow agent is not listed by `$.agent.list()` yet is running, so
// a list-based prune would drop its override. A normal subagent's key is cleared at its own turn.complete. The main key is
// never touched.
export function pruneAgents(map: EffortOverrides, cap: number = MAX_AGENT_KEYS): void {
  const keys = [...map.keys()].filter(k => k.startsWith(AGENT_PREFIX))
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) map.delete(k)
}

// What the next request is sent and what Clean View shows: the override, else the engine's own. A model that takes no
// effort (`effort` absent) is sent none whatever is asked, so it shows none either.
export function effectiveEffort(engine: string | number | undefined, override: EffortLevel | undefined): string | null {
  if (engine === undefined) return null
  return override ?? String(engine)
}
