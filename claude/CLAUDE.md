@AGENTS.md

## Claude Code mapping
The working protocol is in `AGENTS.md` (imported above). This file holds only what is specific to Claude Code.

- **Tiers to models.** fast = sonnet, standard and strong = opus, strongest reviewer = fable. Never Haiku. Kimi is
  retired: never use it. Non-mechanical reviews are never sonnet.
- **Dispatch.** The subagent tool is `Agent`; the peer tools are `ListAgents` and `SendMessage`. Sizing: the
  `sizing-dispatches` skill picks `subagent_type` (`worker-low`...`worker-max`, `explorer`) plus an explicit `model`;
  never bare `general-purpose` or `Explore` for sized work.
- **Effort.** Opus 5.5 sessions default to `medium` and fable to `high` (settings `modelSettings`). Step effort up or
  down for the rest of a turn with the `effort-<level>` skills (rules in `switching-effort`; on Opus 5.5, Sonnet 5.5
  and Fable 5.1 this keeps the cache). A lasting change is the user's `/effort`.
- **Advisor.** The `advisor` tool is the stronger reviewer. Never from explorer/low/medium subagents; the controller
  follows the "Advisor" rule in `AGENTS.md`. That rule overrides the harness's default advisor cadence.
- **Goal gate.** The Stop hook `~/.claude/hooks/goal-gate.mjs` reads `GOAL.md` from the session scratchpad.
- **Handoffs.** The `handoff-launch` skill opens the new session.
- **Toolkit.** MCP `ast-grep` and `repomix`. Browser work: call `browser_close` (playwright) and close the
  claude-in-chrome tabs you opened. Never run `/mcp`, `/model` or `/reload-plugins` mid-task.
- **Machine facts** live in `~/.claude/machine-notes.md`.
- **Per-topic rules** go in the project's `.claude/rules/<topic>.md` with `paths:`; persistent memory is the project's
  auto-memory.
