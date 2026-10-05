---
name: sizing-dispatches
description: Use when about to dispatch a subagent with the Agent tool — implementation, review, exploration, debugging, research, test runs or live runs — before choosing its subagent_type and model; also when a dispatched agent failed or its work must be redone.
---

# Sizing dispatches

## Overview
The Agent tool sets `model` per call but not effort. Effort comes from the agent type's definition file, so each effort level is its own type (`~/.claude/agents/`): `worker-low`, `worker-medium`, `worker-high`, `worker-xhigh`, `worker-max`, plus the read-only `explorer` (medium effort, no advisor). An untyped dispatch (general-purpose, Explore) inherits the session effort (Opus 5.5 main sessions: medium, fable: high). That wastes it on light work.

**Every dispatch = one row below: `subagent_type` + explicit `model`.**

## Sizing table

| Task class | subagent_type | model |
|---|---|---|
| Run tests/build/lint and report by name; a one-line or copy edit | `worker-low` | sonnet |
| Live run / browser drive / simple testing against a checklist (user directive 2026-09-30) — Opus only if it creates or handles secrets or security config | `worker-medium` | sonnet |
| Mechanical multi-file edit (rename, i18n keys, config, formatting) with tests | `worker-medium` | sonnet |
| Locate code or collect `path:line` anchors | `explorer` | sonnet |
| Cross-cutting survey that feeds a plan or spec | `explorer` | opus |
| **Writing code, any task** (user directive 2026-10-05: all writing = sonnet; thinking = opus/fable) | effort DYNAMIC per task: `worker-medium` for routine, `worker-high` for real logic, `worker-xhigh` only when the task itself is hard | sonnet |
| Design before writing for concurrency, system design, math/calculators, security, permissions, data integrity, migrations, auth tokens: the exact behaviour, edge cases and tests the sonnet writer must satisfy | `worker-high` (`worker-xhigh` for the hardest) | opus |
| Review of mechanical work | `worker-medium` | sonnet |
| Review of one non-mechanical task | `worker-high` | opus |
| Review of an ordinary multi-file section | `worker-high` | opus |
| Review of a plan, spec or correctness-critical code (permissions, security, data integrity, migrations) | `worker-high`; `worker-xhigh` only when the question is genuinely HARD to reason about (difficulty, not importance or topic: a hard security question qualifies, a routine security review does not), or a `worker-high` Fable review already missed something (user directive 2026-10-05) | fable |
| Debugging, first attempt | `worker-high` | opus |
| Web research / vendor or doc comparison | `explorer` (has WebSearch/WebFetch) | sonnet; opus when it feeds a decision |

**Types missing?** If a dispatch says "Agent type 'worker-…' not found", the files in `~/.claude/agents/` were not loaded: use `general-purpose` with the row's model (it runs at session effort) and tell the user to restart.

**The advisor can't be removed by frontmatter** (`disallowedTools` does not reach it). A body line "Do not call the advisor tool." is the only control.

## Escalation (redo)
When a dispatch fails or its output is rejected:
- Redo one effort rung up (`worker-low` → `worker-medium` → `worker-high` → `worker-xhigh`) on the same model ONCE.
- A second failure switches model (sonnet → opus → fable) at `worker-high` or higher; `worker-max` + fable last.
- Earlier tiers unknown and it already failed twice: start at `worker-xhigh` + opus.
- `explorer` missed anchors: `explorer` + opus, then `worker-high` + opus told "read-only".
- The new prompt carries the failed attempt's output, findings and ruled-out hypotheses.

## Every dispatch prompt
- A worker may step its own effort for the rest of its turn with the `effort-<level>` skills (see `switching-effort`); the dispatch tier is still its starting point, and it must report any step-up.
- Always pass `model`. Explore's default may be Haiku, and Haiku is banned. A fork ignores `model`, so never fork when the model matters.
- Advisor: allowed only for `worker-high`, `worker-xhigh`, `worker-max`. The `explorer`, `worker-low` and `worker-medium` agent files carry "Do not call the advisor tool." in their body; add that line to the prompt only for a `general-purpose` fallback.
- Report contract by class: explorer → answers + `path:line` anchors, ≤15k chars; implementer → files changed + the proving command's real output; reviewer → findings ranked by severity, each with `path:line` and a failure scenario.

## Common mistakes
| Mistake | Fix |
|---|---|
| `general-purpose` + sonnet for a rename | It runs at session effort. Use `worker-medium`. |
| Everything heavy goes to `worker-xhigh` | Plan tasks with ordinary logic are `worker-high`. Keep xhigh for the correctness-critical rows. |
| Opus writing code | All code is written by sonnet (2026-10-05); opus/fable design, debug root causes, rule and review. Pick the sonnet effort per task, not per category. A sonnet writer that fails twice → opus redo (Escalation). If sonnet code quality degrades (rejected reviews, rework), report it to the user so it can go back to opus. |
| Retrying a failed task at the same tier | Climb one rung; a second failure switches model. |
| Sonnet reviewing non-mechanical work | Reviewer floor is opus. |
| A project agent with the same name | Project `.claude/agents/` wins over user scope on a name clash. Check that the project's copy uses `effort:` (not `effortLevel:`). |
