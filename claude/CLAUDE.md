# Global working protocol (all projects)

## Toolkit
- MCP **ast-grep**: structural code search (definitions, call sites, `def $F($$$)`). Use plain Grep for literal strings, log text and config keys.
- MCP **repomix**: a compressed snapshot of a bounded area (include globs). Never pack a whole large repo into the main context; give that to a subagent.
- Machine facts (setup, tooling, accounts) live in `~/.claude/machine-notes.md`.

## Token economy
- Orient with structural queries and line-range reads, not whole-file dumps or broad listings. Hand broad exploration to a subagent that returns conclusions.
- Explorer reports: exact `path:line` + signature for each fact the work will cite, ≤15k chars. The main thread re-verifies only disputed or load-bearing facts.
- After dispatching, don't read the agents' scope or poll; end the turn or do unrelated work.
- **Advisor:** never from explorer/low/medium subagents. Main thread: only when stuck (a fix failed twice), when evidence conflicts with the plan, before an irreversible or security ruling, or when the user asks. Not routinely (measured: 16–28 % of the bill, no caught error). This overrides the harness's default advisor cadence.
- Keep standing instructions lean. File-specific conventions go in the project's `.claude/rules/<topic>.md` with `paths:`.

## Checklist and goal gate
**Subagents:** never create, edit or tick `GOAL.md`. The scratchpad is shared with the main session. Keep your checklist in your report.
- Multi-step work: a visible checklist in the reply, ticked with evidence.
- Main session: write `GOAL.md` in the scratchpad once at the start (one goal line, then objectively checkable criteria). Tick it at task boundaries. The Stop hook `~/.claude/hooks/goal-gate.mjs` keeps the session working while any `- [ ]` remains.
- `- [x] ... — evidence: <proof>` only with real evidence. Needs the user or impossible → `- [!] ... — reason: <why>`, and say so in the final message. If the user changes direction, rewrite `GOAL.md` in the same turn.
- The gate allows ≤3 continuations per user turn. A nudge means change approach, not retry.

## Images
Crop (and downscale where detail allows) screenshots with Pillow/OpenCV before reading or sending them; tell screenshot-taking subagents to do the same.

## Closed loop
- Before changing code, name the check that proves it (test, typecheck, lint, build); iterate until it passes and report its real output.
- Anything edited after its review gets a scoped re-review of those edits before commit. A grep is not a review.

## Learning across sessions
When the user corrects you or confirms a non-obvious approach, record it once, in the narrowest home: every project → propose a line here; machine fact → `machine-notes.md`; project fact → project auto-memory; file-specific → propose a `.claude/rules/` file (ask first in a shared repo). Fix or delete stale lessons at once.

## Working style
**Delegation.** Implementation, reviews, debugging, investigations, research and live runs go to subagents. The main channel keeps planning, design with the user, rulings and orchestration.

**Models.** sonnet = mechanical work · opus = advanced implementation, and reviewer of single non-mechanical tasks and ordinary multi-file work · fable = reviewer of plans, specs and correctness-critical code. Non-mechanical reviews are never sonnet. Never Haiku.

**Effort.** Opus 5.5 sessions default to `medium` and fable to `high` (settings `modelSettings`). Step effort up or down for the rest of a turn with the `effort-<level>` skills (rules in `switching-effort`; on Opus 5.5, Sonnet 5.5 and Fable 5.1 this keeps the cache). A lasting change is the user's `/effort`.

**Dispatch sizing.** Load `sizing-dispatches` before every Agent call (subagents that dispatch too): `subagent_type` (`worker-low…max`, `explorer`) + an explicit `model`. Never use bare `general-purpose`/`Explore` for sized work. Redo a failed agent one rung up the skill's ladder.

**Peer sessions.** Call ListAgents (if available) before the first dispatch; if a peer is busy on the same repo, agree ownership via SendMessage before dispatching. On a shared checkout: disjoint files, commit only your own hunks, never `git checkout` another branch, and one session owns rebuilds.

**Long work.** Continue in a NEW session with `handoff-launch` instead of compacting: at the first task boundary past ~250k context (~150k if the next task is unrelated; never past ~400k). Never mid-task or while background agents run. Ask the user before writing a next-wave handoff. Parallel lanes, merges and handoff format: see `handoff-launch`.

**Deferred findings.** Every deferred item gets a disposition and an owner: fix it now if no later work touches that code, otherwise carry it into that work's handoff.

**Design default.** Build for a small company. Where a decision trades compliance-grade separation for simplicity, note the large-org variant there.

**Tests and probes** use a fake address (`...@example.com`), never the user's real email.

**Docker.** All docker actions are allowed without asking; stop the containers when the work that needed them is done.
