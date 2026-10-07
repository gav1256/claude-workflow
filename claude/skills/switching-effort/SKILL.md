---
name: switching-effort
description: Use when the next stretch of work in this turn is clearly lighter or heavier than the current reasoning effort — mechanical steps after hard thinking, or a hard ruling in the middle of routine work — in a main session or a subagent; also when the user asks to raise or lower effort.
---

# Switching effort mid-session

## The lever
Invoke the skill `effort-<level>` (`effort-low`, `effort-medium`, `effort-high`, `effort-xhigh`, `effort-max`) with the
Skill tool. Its frontmatter `effort:` overrides the session (or subagent) effort **from the next request until the end of
the current turn**; the next user message reverts to the session level. Invoke another `effort-*` skill to step again.
The `effort-*` skill echoes the level now in effect (its `${CLAUDE_EFFORT}` line). Bash `$CLAUDE_EFFORT` may still show the old level — do not rely on it.
(Verified with a PreToolUse hook logging `effort.level`: main session and subagents both switch; reverts next turn.)

The model cannot run `/effort`, hooks cannot set effort, and editing `settings.json` only affects new sessions.
A change that should outlast the turn → ask the user to type `/effort <level>`.

## Cache: only switch freely on cache-safe models
- **Cache kept:** Opus 5.5, Sonnet 5.5, Fable 5.1 on the Anthropic API key or a Claude subscription.
- **Cache lost (whole history re-read uncached):** every other model, and all models on Bedrock, Google Cloud,
  a Claude apps gateway, a HIPAA org, or with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` set.
On a cache-losing setup switch only when the rest of the turn is long and the mismatch is large, and never back and forth.
A subagent's effort never touches the parent's cache.

## When
| Work ahead in this turn | Switch to |
|---|---|
| Running commands, copying files, formatting, status reports, waiting on agents | `effort-low` |
| Straightforward edits, simple reviews, applying a known fix | `effort-medium` |
| Planning, debugging, non-trivial code, judging a review | `effort-high` |
| A very wide solution space AND a wrong technical call is highly expensive (user rule 2026-10-07; topic alone, e.g. security or migrations, is not enough) | `effort-xhigh` |
| Highly creative ideas needed | consult the strongest-reviewer advisor (Fable), effort unchanged |
| The hardest problem, after `xhigh` already failed on it | `effort-max` |

- Step down after the hard part is decided; step up before a decision, not after a wrong one.
- One switch per phase — not per tool call.
- Always pass a fresh `args` value (e.g. a short phase name): a repeat call with the same args is answered "already
  loaded above" and does nothing; with new args it is re-invoked.
- Known limit (root cause found 2026-10-07, Claude Code 2.1.292): in permission mode `auto` the skill's effort layer is
  usually LOST (the mid-stream result drain yields the Skill result without its effort layer; `default` mode works).
  The lever for it: after the `effort-<level>` skill, call the Clean View tool `set_effort` with that same level (the
  skill bodies say so; if the tool is deferred, load it with ToolSearch first). A `turn.step` hook of the Clean View
  mod then sends that effort with the next model request, per loop (a subagent's call sets only its own loop), and it
  ends with that loop's turn like the skill's (a new user turn clears the main loop's, and keeps a still-running
  background subagent's own). Without Clean View (no `set_effort`) in auto mode a switch is only a hint: size
  dispatches by tier (`sizing-dispatches`), use `/effort` for a lasting change. Check the transcript's assistant
  `effort` field when it matters. The status-line effort label shows the base level only.
- Subagents: the dispatch still picks the starting tier (`sizing-dispatches`); a worker may step itself up for a hard
  sub-problem it found, and must say so in its report.
- Do not use this to dodge `max`'s cost on a cache-losing model: there, pick the right tier at dispatch instead.
