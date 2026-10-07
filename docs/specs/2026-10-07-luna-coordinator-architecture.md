# Luna coordinator: intended architecture (for review)

Spec: `2026-10-07-luna-coordinator-request.md` (the user's request). This note says how the coordinator plugs into
the code that exists today. Code anchors are in this repo unless marked `~` (the deployed copy).

## Principles
- Luna interprets and routes. It has no tools. It returns one strict JSON `CoordinatorDecision` per call.
- A deterministic Node dispatcher validates every decision and is the only thing that acts.
- Claude and Codex workers code. The coordinator never edits project files, never commits, never runs coding tasks.
- Reuse: Claude workers via `handoff-launch` (`launch.mjs`, `live.mjs`, the registry); Codex workers via
  `dispatching-codex` (`codex-run.mjs` + `lib/locks.mjs`, `lib/usage.mjs`, `lib/binary.mjs`). No second integration.

## Placement
- Code: `claude/skills/model-coordinator/` (deployed to `~/.claude/skills/model-coordinator/`). The name avoids the
  existing hook-driven "coordinator" tick (`handoff-launch/coordinator.md`, `state/coord/`).
- Fixed state folder: `<CFG>/state/model-coordinator/` (CFG = `CLAUDE_CONFIG_DIR` or `~/.claude`), whatever the cwd.
- Command: `coordinator.cmd` shim in `~/.local/bin` (already on the user PATH) runs `node <skill>/cli.mjs`.
- Single instance: a named pipe `\\.\pipe\model-coordinator` (same pattern as `lib/locks.mjs:36 acquirePipe`). A
  second `coordinator` prints the open instance's pid and start time and exits.
- Storage: JSONL ledgers (the project's existing format), no database: `exchanges.jsonl`, `dispatch.jsonl`,
  `usage.jsonl`, `workers.jsonl`; plus `coordinator_records.md`. History is read only when a question needs it.

## Flow per user line
1. Deterministic pre-pass (`resolve.mjs`): explicit session id, command syntax (`/to <id> ...`, `/status`,
   `/restart-closed`), unique exact worker name or alias, "continue" with exactly one active worker. A hit builds
   the decision locally: no model call.
2. Otherwise build `CoordinatorInput` (`context.mjs`, target 1-3K tokens): stable instructions, compact project
   state, `WorkerSummary[]`, `focused_session_id`, last 4-6 exchanges, the message.
3. `provider.decide(input)`: `MockCoordinatorProvider` (scripted, tests) or `OpenAILunaProvider` (Responses API,
   `gpt-6-luna`, reasoning `none`, `text.format` strict `json_schema`, key from `OPENAI_API_KEY` or a key file under
   `<CFG>/secrets/`; timeout, bounded retries, 429 back-off honouring `retry-after`).
4. `validateDecision` (hand-written strict validator, same schema the API gets): enum action, every target id in
   the live worker table, message targets not finished/dead, length caps, no unknown fields. Invalid → one
   re-ask, then a `clarify` reply. Free-form model text is never executed: `worker_instruction` is only ever passed
   as text to a worker.
5. Dispatcher executes with an idempotency key (`request_id` = hash of user-turn id + action + targets), recorded
   in `dispatch.jsonl` before acting, so a retry never double-dispatches.

## Decision schema (adds one field to the spec's)
`record_update: { aliases: [{session_id, alias}], focus: string|null, note: string|null } | null`. The dispatcher
turns it into bounded sections of `coordinator_records.md`. Luna never supplies a path or file content.

## The write lock (code, not prompt)
- The coordinator process has exactly one file-write module (`store.mjs`). It resolves every target against a
  fixed allowlist inside the state folder (records file + the ledgers + brief files it hands to launchers) and
  refuses anything else, including symlink/junction escapes (compare real paths).
- Only `coordinator_records.md` ever receives model-derived content. Briefs given to workers carry the user's
  instruction text, not file writes.
- Luna has no tool, shell or file API; extra decision fields fail validation (`additionalProperties:false`).

## Claude workers
- Create: write a brief in the state folder, run `launch.mjs --handoff <brief> --name <label> --worktree <branch>
  --model opus --effort high` (launch.mjs refuses sonnet, `:712`). `launch.mjs` owns worktrees, occupancy (exit 3),
  the session cap and the registry; the dispatcher only reads its exit code and the registry line.
- Status: registry + `liveness` + `sessionState` + `goalOf` (`live.mjs:310,411,457`), plus a compact
  `<STATE>/workers/<id>.json` state update the worker brief asks the worker to write at the end of each turn.
- Lane classifier (open / unknown / finished / paused / closed_unfinished) in a new `status-lib.mjs` with
  `coord.mjs status --json`; "restart closed sessions" = `launch.mjs resume --closed` after a yes/no.
- Message delivery to a running session: see "Open question A".

## Codex workers
- A Codex worker = one linked worktree + branch the dispatcher creates (`git worktree add` under the target repo's
  `.claude/worktrees/codex-<label>`), plus a chain of `codex-run.mjs` runs tagged `--task <worker-id>`.
- Create: `codex-run.mjs --brief <file> --cwd <worktree> --mode write --model sol --effort medium --task <id>`,
  spawned as a child with stdout captured; the one JSON line is the result. If the coordinator restarts mid-run,
  the result is recovered from `<CFG>/state/codex/runs.jsonl` by task id.
- Message (follow-up): `--continue <last-run-id>` with a new brief, only after the previous run ended; a message
  that arrives during a run is queued and sent when it ends.
- Codex never commits; the dispatcher never commits. A finished Codex worker is `waiting_for_user` with its diff in
  its worktree; review and commit stay with the user or a Claude worker (project rule: Codex code is never
  reviewed by Codex alone).

## Codex resource manager (`codex-resources.mjs`)
Reuses, does not duplicate: `busySlots()` (`lib/locks.mjs:57`, 3 machine-wide slots shared with every Claude
lane's Codex runs), `latestReading()` + `mapWindows()` + `quotaDecision()` (`lib/usage.mjs:108,74,133`),
`resolveCodex()` (`lib/binary.mjs:24`). Adds only:
- `max_parallel_codex_jobs` (config, default 2) over the coordinator's OWN active Codex jobs.
- `CodexResourceState {active_jobs, max_parallel_jobs, available, capacity_available, usage_status}`:
  available = binary resolves (and a login marker exists in `CODEX_HOME`); usage_status ok / near_limit (≥85) /
  exhausted (≥95) / unknown (no reading), from `quotaDecision`.
- Gate before a NEW job: available → own cap → machine slots → quota → worktree free. Fail → fallback policy:
  `claude` (default) or `paid_api` (only if configured; off by default) or `refuse`. Running jobs are never
  stopped; a quota block affects only new jobs.

## Env isolation
- `codex-run.mjs` already passes `codex exec` an allowlisted env (`codex-run.mjs:72-92`), so `OPENAI_API_KEY`
  never reaches Codex and cannot switch it to paid API billing.
- Claude children: add `OPENAI_API_KEY` (and `ANTHROPIC_*` provider overrides) to the strip set in `cleanEnv` /
  `windowScript` (`live.mjs:591,600`). The coordinator sets `HL_MODEL_COORDINATOR=1` for its own process; `HL_*` is
  stripped from children already.

## Cost control
`usage.jsonl` per call: input, cached input, output tokens, latency, retries, estimated cost (price table in
config). Monthly soft limit $7 (warn), hard $10: no more provider calls; deterministic shortcuts, status and
running workers keep working; the condition is shown on every reply.

## Open questions for review
A. Message delivery to an already running Claude session (none exists today: the inbox is read only at a fresh
   launch, `launch.mjs:611`; stop files reach a session only at its next tool call with STOP meaning,
   `coord.mjs:54-83`). Candidates: a new non-stop "message" file class delivered by the PostToolUse /
   UserPromptSubmit hooks; `claude --bg --resume <sid> "<text>"` for idle background sessions; close + `--resume`
   for idle window sessions.
B. Codex: is there a safer resumable-session model than `--continue` (fresh `exec` on the dirty tree)? Is checking
   `CODEX_HOME` for a login marker the right "logged in" probe without reading secrets?
C. Codex quota: is `quotaDecision` with `eff = week_pct + 2 × busySlots` sound for a coordinator that may queue
   several jobs? What should happen when `week_resets_at` is missing (today: run at any pct)?
D. Concurrency: own cap 2 + machine slots 3 + one run per worktree: any race between the gate check and
   `codex-run.mjs` taking its slot (the script re-checks and returns `blocked codex-slots-full`; the dispatcher
   then queues or falls back)?
