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

## Resolutions (user ruling + Codex review 20261007T071947Z-2eac22)
These override the sections above where they differ.

A. Message delivery to a running Claude worker (user ruling 2026-10-07: documented features only).
   - A message is a file `<CFG>/state/model-coordinator/messages/<regId>/<seq>.json` (dispatcher-written).
   - A new hook script owned by this skill, registered for launched sessions next to the existing hooks
     (`live.mjs:548-556`), delivers pending messages as `additionalContext` on PostToolUse (busy session: next tool
     call) and UserPromptSubmit (window session: next typed prompt), then marks them delivered. It never touches
     the stop-file classes in `coord.mjs` (owned by the batch-B lane).
   - Claude workers that the coordinator creates run as background sessions (`launch.mjs --mode bg`). For an idle
     one (`claude agents --json` status idle/done), the dispatcher runs `claude --resume <sid> --bg "<message>"`.
     If Claude Code answers with a `note:` that it started a copy, the dispatcher stops the copy at once
     (`claude stop <id>`) and leaves the message queued for hook delivery.
   - Not used: the inbox socket (its message wire format is undocumented) and relaying through a Claude call.
   - The reply says which path was used: delivered / woke idle worker / queued until the worker next runs.
B. Codex sessions.
   - Logged-in check: run the resolved binary's `login status` (timeout, sanitized env, intended `CODEX_HOME`),
     keep both streams private, expose only `chatgpt | api_key | none | unknown`; only `chatgpt` counts as
     available. No credential file is read. Cache the result for a few minutes.
   - Continuation keeps the wrapper's fresh-exec model (no native `exec resume`, no `resume --last`). Every
     follow-up brief is rebuilt from durable task context: original goal, constraints, owned paths, the prior
     validated result, and the new instruction.
   - Transitions: `--continue <run>` only when the baseline HEAD is unchanged, the residue matches and the new
     instruction stays inside the owned paths. After the user commits (HEAD moved, clean tree): a fresh run with
     a new scope. Scope growth on a dirty tree: `clarify` to the user, never a silent broadening.
   - Results: the dispatcher spawns `codex-run.mjs` detached and hidden with stdout to a file in the state folder,
     records `{worker_id, attempt, run_id?, pid, state}` before spawning, and persists the parsed JSON line on exit.
     `runs.jsonl` is a summary only. On restart, pending attempts are reconciled with the live process and the
     lock/quarantine records; unresolved ones become `unknown` and keep their worktree ownership.
C. Quota. `week_pct + 2 × busySlots` is a heuristic, not a reservation. Usage and capacity are rechecked when a
   queued job actually starts; queued jobs hold no slot. A reading without `week_resets_at` (or an exhaustion
   signal without a reset) is `unknown`: new subscription dispatches pause or take the configured fallback, with
   bounded rechecks; active jobs are never stopped. The wrapper's own final quota check and downgrade stay.
D. Concurrency. The pipe locks make gate-to-spawn safe for physical concurrency (`worktree-busy`,
   `codex-slots-full`, quarantine blocks). The coordinator serializes reservation of its own 2-job allowance
   before spawning, rebuilds it on restart from pending attempts, and releases it on any blocked attempt. Same
   pipe namespace and state paths as Claude lanes' Codex runs.
E. Credential boundary (Codex high finding). Every child the coordinator starts gets a case-insensitively
   sanitized env without `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_RUN_ENV_ALLOW`, unless the paid-API
   fallback is explicitly configured (then only that worker gets a key). `launch.mjs` children already lose `HL_*`;
   add these three names to the strip set in `cleanEnv`/`windowScript` (`live.mjs:591,600`). Codex workers require
   `chatgpt` login (B), so a stored API-key login is never used silently.
F. File ownership with the busy batch-B lane. Batch B changes `claude/hooks/coord.mjs`, `recover*.mjs`,
   `pause-io.mjs`, `power.mjs`, `SKILL.md`, `coordinator.md` and `tests/helpers.mjs`. This work does not edit
   them: the lane classifier lives in a new `status-lib.mjs` that the coordinator imports directly (no
   `coord.mjs status`), and `resume --closed` goes in `launch.mjs`. `live.mjs` and `launch.mjs` are not batch-B
   files. Test helpers are used as they are; new helpers go in a new file.
G. t10-review-notes items in scope (Codex tool, needed by the resource manager): `quotaDecision` with a missing
   `week_resets_at` runs at any pct (must block as unknown at high pct); `busySlots` spurious slots-full;
   `latestReading` walks the whole sessions tree (prune to recent date folders). The dispatcher surfaces
   `worktree-quarantined` and the `--clear-quarantine` hint to the user; it never clears quarantine itself.
   Everything else in that file stays out of scope.
