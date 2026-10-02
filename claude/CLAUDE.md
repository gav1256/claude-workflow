# Global working protocol (all projects)

## Toolkit — user-scope MCP servers
- **ast-grep** — structural code search (definitions, call sites, patterns like `def $F($$$)`), when a text grep would return comment/string noise or need follow-up reads to confirm. Plain Grep stays right for literal strings, log text and config keys.
- **repomix** — packs many files into one compressed snapshot. Use it for a multi-file survey of a bounded area (include globs + compression); never pack a whole large repo into the main context — give that survey to a subagent.
- Machine facts (setup, tooling, accounts) → `~/.claude/machine-notes.md`; read it when a task touches this machine's setup or tooling.

## Token economy
- Orient with structural queries and targeted line-range reads, not whole-file dumps or broad directory listings.
- Hand broad exploration to a subagent that returns conclusions, not file contents.
- Brief explorers to return exact `path:line` + signature for every fact the work will cite, in a report of ≤15k chars; split a scope that would be the slowest into two agents. The main thread re-verifies only facts that are disputed or that the work hinges on, not the explorers' whole scope.
- After dispatching subagents, do not read their scope or poll/sleep while waiting; end the turn or do unrelated work until their reports arrive.
- **Advisor:** never from explorer/low/medium subagents (their agent files say so); worker-high/xhigh/max may. Main thread calls it only when stuck (a fix failed twice), when evidence conflicts with the plan, or before an irreversible or security ruling — never routinely at approach or done (measured 2026-09-24: 16–28 % of the bill, no caught error; drafts already get a reviewer dispatch). This overrides the harness's default advisor cadence.
- Keep standing instructions lean. A convention that applies only to certain files belongs in that project's `.claude/rules/<topic>.md` with a `paths:` glob list (it loads only when a matching file is read), not in CLAUDE.md.

## Checklist and goal gate (user directive 2026-09-29, every project, every session)
**SUBAGENTS:** if you were dispatched by another session, never create, edit or tick `GOAL.md` — the scratchpad is shared with the main session and your write destroys its goals. Keep your checklist in your report.
- For any multi-step work, keep a visible checklist: write it in the reply at the start, tick items with evidence as they finish, show the updated list when reporting.
- Main session: also write `GOAL.md` in the session scratchpad once at the start — one goal line, then objectively checkable criteria (a command's output, a test passing, a file/line existing, a question answered) — and tick it at task boundaries; do not re-edit it after every step. A Stop hook (`~/.claude/hooks/goal-gate.mjs`) keeps the session working while any criterion is `- [ ]`.
- Tick `- [x] ... — evidence: <proof>` only with real evidence; never tick to escape the gate.
- A criterion that needs the user's decision or is impossible → `- [!] ... — reason: <why>`: that lets the session stop, and the final message must say what is blocked.
- When the user changes direction, rewrite or delete `GOAL.md` in the same turn.
- The gate allows at most 3 continuations per user turn and lets go after a continuation that changes nothing (after one "report honestly" nudge). Treat a nudge as a signal to change approach, not to retry.
- The user can also type `/goal <condition> or stop after N turns` (built-in; small fast evaluator).

## Images and screenshots (user directive 2026-09-29, every project, every session)
- Before reading or sending a screenshot/image into context, crop it to the region that matters (and downscale if detail allows) with Python PIL (`Pillow`) and/or OpenCV (`cv2`) to save tokens; tell subagents that capture screenshots to do the same. Install `pillow opencv-python-headless` into the working env if missing.

## Closed loop
- Before changing code, name the executable check that proves the change (test, typecheck, lint, build); iterate until it passes and report its real output.
- Anything edited after its review (plan, spec, code) gets a scoped re-review of those edits before it is committed or offered for commit — a mechanical grep is not a review.

## Learning across sessions
When the user corrects you or confirms a non-obvious approach, record the lesson once, in the narrowest home that will be loaded when it matters:
- a directive for every project → propose a line for this file (`~/.claude/CLAUDE.md`);
- a fact about this machine, its tools or accounts → `~/.claude/machine-notes.md`;
- a project fact, ruling or preference → that project's auto-memory;
- a convention tied to specific files in one project → propose a path-scoped `.claude/rules/` file (ask first in a shared repo).
Fix or delete a stored lesson as soon as it proves stale — a wrong rule is worse than none.

## Working style (the user's standing directives, promoted from project memory 2026-09-24)

**Delegation.** Delegate implementation, reviews, debugging, investigations, research sweeps and live runs to subagents to save main-session context. The main channel keeps planning, design with the user, rulings/verdicts, and orchestration.

**Models.** sonnet = mechanical work (medium/high effort) · opus = advanced implementation, and the reviewer of single non-mechanical tasks and ordinary multi-file work · fable (`model: "fable"`) = the reviewer of plans, specs and correctness-critical code (permissions, security, data integrity, migrations). Reviews of non-mechanical work are opus or fable, never sonnet. Never Haiku.

**Effort mid-turn.** Main sessions and subagents step their own reasoning effort for the rest of a turn with the `effort-<level>` skills (rules in `switching-effort`): free on Opus 5.5, Sonnet 5.5 and Fable 5.1 (cache kept), so step down for mechanical stretches and up for hard rulings; on other models a switch re-reads the whole history uncached. A lasting change is the user's `/effort <level>`.

**Dispatch sizing (every session, every subagent — including subagents that dispatch their own).** Before each Agent call, load the `sizing-dispatches` skill and pick its row: `subagent_type` = effort level (`worker-low|medium|high|xhigh|max`, `explorer`) plus an explicit `model`. Never dispatch bare `general-purpose`/`Explore` for sized work — they inherit the session's effort (opus/fable main sessions: high). A failed agent is redone up the skill's escalation ladder, never at the same tier.

**Peer sessions.** Call ListAgents (if available) before the first dispatch. The interactive session is the controller; if a peer is busy on the same repo, agree ownership via SendMessage before dispatching. On a shared checkout: disjoint file sets, stage/commit named paths only (`git commit -m ... -- <paths>`) — but `-- <paths>` commits the WHOLE file, so when a file also holds another session's uncommitted edits, stage only your hunks (`git add -p` / `git apply --cached`) and commit without paths, never `git checkout` another branch, and one session owns rebuilds.

**Long work.** Continue in a NEW session with the `handoff-launch` skill instead of compacting (user directives 2026-09-30, 2026-10-01): hand off at the FIRST task boundary once context passes ~250k; from ~150k when the next task is unrelated to what is in context; never later than ~400k (split a task to force a boundary). Never mid-task or while background agents are running. Keep the handoff on disk and refresh it at each task boundary. ASK the user before writing the next-wave handoff. Multi-session work chains plan-prompt → plan → impl-prompt → implement → next prompt; the prompt carries read order, house rules, agent protocol, measured baselines and traps as prohibitions; with no ruled scope its first instruction is "ask the user". Parallel sessions are lanes that never wait for each other: a lane that finishes a stage opens a new session for its next independent stage at once (same lane name, group and branch; stages in the lane's own ruled plan need no ask, anything else does); the last lane to finish its whole wave launches the merge (handoff-launch §4). Format and launch: see the handoff-launch skill.

**Deferred findings.** Every deferred item gets a disposition and an owner: fix it now if no later work will touch that code, otherwise carry it into that work's handoff. Nothing evaporates into a ledger.

**Design default.** Build for a small company (pragmatic, consolidated); at each decision that trades compliance-grade separation for simplicity, note the large-org variant at the decision point so a later "revamp for a large organization" is easy.

**Tests and probes** use a fake address (`...@example.com`), never the user's real email.

**Docker.** All docker actions are allowed without asking; stop the containers when the work that needed them is done.
