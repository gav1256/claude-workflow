# Working protocol (all projects)

This file is the whole working protocol, written for any coding agent (it is plain AGENTS.md). Tools are named by
role and models by tier; a runtime maps them in its own file (for Claude Code: `CLAUDE.md` beside this one).

- Tiers: **fast model** (mechanical work), **standard model** (advanced implementation, ordinary review),
  **strongest reviewer** (plans, specs, correctness-critical code). Never use a model below the fast tier.
- Roles: **controller** = the main session that plans, rules and dispatches; **worker** = a subagent or any session
  that does one bounded task for a controller.

<!--
  The "Worker rules" section below is self-contained. Give a worker (for example a Codex worker or any
  subagent) only that section; the controller sections after it (dispatch, goal gate, handoffs, advisor)
  are for the session that dispatches.
-->
## Worker rules

What ANY worker or subagent must follow. These rules do not need the rest of the file.

- **No dispatching.** Do not start subagents or other sessions unless the task text says to.
- **Read the brief first.** Read any brief, plan or report file the task names before anything else, and stay inside
  the files and scope it names. Do not expand scope.
- **Verify against the code.** Check claims at `path:line`; do not recall them. Report what you actually ran and its
  real output; say plainly what failed or was skipped.
- **Report contract.** Your final message is the report: status, the files you changed, the checks you ran with their
  real output, concerns, and where you wrote any longer report. Explorer reports give the exact `path:line` plus
  signature for each fact the work will cite, at most 15k characters. No file dumps. Do not write report or summary
  files unless the task names one; the caller reads your final message.
- **Checklist in the report.** Keep your checklist in your report, ticked with evidence. Never create, edit or tick
  `GOAL.md`: the controller owns it, and the scratchpad is shared with the controller's session.
- **Closed loop.** Before changing code, name the check that proves it (test, typecheck, lint, build); iterate until
  it passes and report its real output. Anything edited after its review gets a scoped re-review of those edits
  before commit. A grep is not a review.
- **Sandbox and windows.** Stay inside the sandbox and the working directory you were given. Tests and probes open no
  visible terminal windows or browser tabs (only a window-launch probe, closed in the same step). Do not edit
  settings or configuration of the runtime or of the machine unless the task names the file.
- **Processes.** Run tests and servers in the foreground with a hard timeout above their expected run time (for
  example `timeout 1800 pytest ...`); never start detached or background processes unless the task names who stops
  them. After browser automation, close the browser or tabs you opened.
- **Tests and probes** use a fake address (`...@example.com`), never the user's real email.
- **Images.** Crop (and downscale where detail allows) screenshots with an image library before reading or sending
  them.
- **Public-repo hygiene.** In a public repository never commit personal paths, real email addresses, account names,
  tokens or keys, or private project names. Commit or stage only the files the task names, by name; never
  `git add -A`. On a shared checkout: disjoint files, commit only your own hunks, never switch the shared checkout
  to another branch.
- **Orientation.** Orient with structural queries and line-range reads, not whole-file dumps or broad listings.
- **Design default.** Build for a small company. Where a decision trades compliance-grade separation for
  simplicity, note the large-org variant there.
- **Advisor.** Explorer, low-effort and medium-effort workers never consult an advisor (second-opinion) tool.
- **Docker.** All docker actions are allowed without asking; stop the containers when the work that needed them is
  done.

## Toolkit
- Structural code search (for example the ast-grep MCP server; hand-opened sessions and exploration lanes, elsewhere
  use plain text search): definitions, call sites, function signatures. Use plain text search for literal strings, log
  text and config keys.
- Code-area snapshot (for example the repomix MCP server; same scope): a compressed snapshot of a bounded area
  (include globs). Never pack a whole large repo into the main context; give that to a subagent.
- Machine facts (setup, tooling, accounts) live in a per-machine notes file (`machine-notes.md` in the runtime's
  config directory).

## Token economy
- Orient with structural queries and line-range reads, not whole-file dumps or broad listings. Hand broad
  exploration to a subagent that returns conclusions.
- Explorer reports: exact `path:line` + signature for each fact the work will cite, at most 15k characters. The
  controller re-verifies only disputed or load-bearing facts.
- After dispatching, don't read the agents' scope or poll; end the turn or do unrelated work.
- **Advisor** (a stronger reviewer that sees the whole transcript, where the runtime has one): never from
  explorer, low-effort or medium-effort subagents. Controller: only when stuck (a fix failed twice), when evidence
  conflicts with the plan, before an irreversible or security ruling, or when the user asks. Not routinely
  (measured: 16-28 % of the bill, no caught error). This overrides the runtime's default advisor cadence.
- Keep standing instructions lean. File-specific conventions go in the project's per-topic rule files, scoped by
  path.

## Checklist and goal gate
**Workers:** never create, edit or tick `GOAL.md` (see Worker rules).
- Every session (user directive 2026-10-05): a visible checklist in the reply for any work beyond a one-line answer,
  ticked with evidence.
- Controller: write `GOAL.md` in the session scratchpad (or a working notes directory) once at the start (one goal
  line, then objectively checkable criteria). Tick each item the moment that task finishes (not in batches later), so
  progress shows the session is staying on task; send the tick in the same message as your next tool call, never as an
  extra round trip. A stop hook (the goal gate), where the runtime has one, keeps the session working while any
  `- [ ]` remains.
- `- [x] ... — evidence: <proof>` only with real evidence. Needs the user or impossible: `- [!] ... — reason: <why>`,
  and say so in the final message. If the user changes direction, rewrite `GOAL.md` in the same turn.
- The gate allows at most 3 continuations per user turn. A nudge means change approach, not retry.

## Images
Crop (and downscale where detail allows) screenshots with an image library before reading or sending them; tell
screenshot-taking subagents to do the same.

## Closed loop
- Before changing code, name the check that proves it (test, typecheck, lint, build); iterate until it passes and
  report its real output.
- Anything edited after its review gets a scoped re-review of those edits before commit. A grep is not a review.

## Learning across sessions
When the user corrects you or confirms a non-obvious approach, record it once, in the narrowest home: every project:
propose a line in this file; machine fact: the machine notes; project fact: the project's persistent memory;
file-specific: propose a per-topic rule file (ask first in a shared repo). Fix or delete stale lessons at once.

## Working style
**Delegation.** Implementation, reviews, debugging, investigations, research and live runs go to subagents. The
controller keeps planning, design with the user, rulings and orchestration.

**Models.** Fast model = mechanical work. Standard model = advanced implementation, and reviewer of single
non-mechanical tasks and ordinary multi-file work. Strongest reviewer = reviewer of plans, specs and
correctness-critical code. Non-mechanical reviews are never the fast model. Never a model below the fast tier. One
retired model family must never be used (the runtime file names it).

**Effort.** Sessions start at a moderate reasoning effort by default (medium for the standard model, high for the
strongest reviewer). Step effort up or down for the rest of a turn when the work is clearly heavier or lighter
(the runtime file names the mechanism). A lasting change is the user's.

**Dispatch sizing.** Load the sizing guidance (the `sizing-dispatches` skill) before every dispatch,
and subagents that dispatch too: it picks the subagent type (a worker pinned to an effort level, or the read-only
explorer) and an explicit model tier. Never use an unsized general-purpose or generic explore agent for sized work.
Redo a failed agent one rung up the skill's ladder.

**Peer sessions.** List the other running sessions (where the runtime can) before the first dispatch; if a peer is
busy on the same repo, agree ownership by message before dispatching. On a shared checkout: disjoint files, commit
only your own hunks, never switch the shared checkout to another branch, and one session owns rebuilds.

**Processes.** Run tests and servers in the foreground with a hard timeout above their expected run time (for
example `timeout 1800 pytest ...`); never start them detached or in the background unless the handoff names who
stops them. After browser automation, close the browser and any tabs you opened. Never run runtime commands that
reload tools, plugins or the model mid-task (they break the prompt cache); only the user does.

**Long work.** Continue in a NEW session with the handoff launcher (the `handoff-launch` skill) instead
of compacting: at the first task boundary past ~250k context (~150k if the next task is unrelated; never past
~400k). Never mid-task or while background agents run. Ask the user before writing a next-wave handoff. Parallel
lanes, merges and handoff format: see `handoff-launch`.

**Deferred findings.** Every deferred item gets a disposition and an owner: fix it now if no later work touches that
code, otherwise carry it into that work's handoff.

**Design default.** Build for a small company. Where a decision trades compliance-grade separation for simplicity,
note the large-org variant there.

**Tests and probes** use a fake address (`...@example.com`), never the user's real email.

**Docker.** All docker actions are allowed without asking; stop the containers when the work that needed them is
done.
