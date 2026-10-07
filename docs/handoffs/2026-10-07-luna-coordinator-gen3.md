# Handoff: Luna coordinator, gen 3 (Task 10a review onward)

Written 2026-10-07 by lane `luna-coordinator` gen 2 at ~255k context. You are the new controller.

## Repo state
- Worktree `.claude/worktrees/jev-coordinator`, branch `jev-coordinator` (based on `stage2-loop-recovery`; never base
  on `main`; never switch the main checkout's branch). Working tree clean at handoff except `.codex-tmp/` (Codex review
  residue, untracked; never stage it).
- Spec (binding): `docs/specs/2026-10-07-luna-coordinator-request.md`. Design: `docs/specs/2026-10-07-luna-coordinator-architecture.md`
  ("Resolutions" A-G override earlier sections). Plan: `docs/plans/2026-10-07-luna-coordinator.md` (Global Constraints
  :40-87, Task summary + dependency table :2049-2096).
- Previous handoff (still valid for "How this lane works", suites, traps): `docs/handoffs/2026-10-07-luna-coordinator-gen2.md`.

## Task status
| Task | State | Commits |
|---|---|---|
| 1 env strip | APPROVED | 8d4f1b0 |
| 2 status-lib | APPROVED | 01a3f81, 34f00d8, 9c23993 |
| 3 resume --closed | APPROVED | 29bf30d, c49ba5b |
| 4 t10 Codex fixes | APPROVED (opus + 2 Codex reviews) | 463ce36, fb9399e, 4a1464c |
| 5 schema/validator/mock | APPROVED | e6beb43, 2a1bea6, be08d5d |
| 6 store/write lock/env | APPROVED | 8969d65, 32892d8, 8b3663c |
| 7 resolver/context | APPROVED | 02b3e1b, d6aee65, ab93883 |
| 8 Codex resource manager | APPROVED (opus + Codex) | 4aa9f02, b80537f |
| 9 Claude adapter + hook | APPROVED | d7cbd5e, 6e09fec |
| 10a Codex adapter part 1 | SEE "10a status" BELOW | - |
| 12 cost + OpenAI provider | APPROVED | fa89a18, 60101b9 |
| 10b, 11, 13, 14 | not started | - |

Suites at last run: model-coordinator 188/188; handoff-launch 568/568; Codex usage+locks 59/59 (full Codex suite
452/453, one load flake `run.test.mjs` I3 that passes alone).

### 10a status
Implemented, commit bff4998 (sonnet worker-high). M1-M6 done; model-coordinator suite 211/211; mutation checks
reported (childEnv, login reset, request-id lookup, spawnSync injection each caught). Carried Task 8 items done (real
login probe through injected spawnSync; fresh login re-check before spawn; events carry `at`).
**Next: opus `worker-high` review + Codex `review` (`--base bff4998~1`), both on bff4998.** Reviewer prompt: give the
implementer's coverage lines below and ask for mutation spot-checks.
Implementer coverage:
- M1 codex-adapter.mjs:100 ensureWorktree - "M1 ensureWorktree creates a linked worktree on codex-<id>; a second call is a no-op; a foreign path is refused"
- M2 :161 spawnAttempt - "M2 start spawns once: ..." and "M2 after the fake ends poll sets waiting_for_user ..."
- M3 :252 finish - "M3 a failed worker run gives status failed and releases the reservation"
- M4 :287 poll drain - "M4 Codex busy: the second worker is queued and holds no slot; poll starts it after the first ends, rechecking the gate"
- M5 :130 quarantineHint, :252 - "M5 quarantine: the hint is in the blockers and no --clear-quarantine is ever spawned"
- M6 :218 request lookup before the gate - "M6 no double spawn: same requestId again, after a restart, and while queued" + "a concurrent pair of identical requests spawns once"
Design choices beyond the plan (reviewer rules on each): attempt lines written whole (newest per attempt_id = state);
brief written at spawn time, attempt id `<workerId>.<seq>`; model text collapsed to single lines in the brief (cannot
inject a second `Files you own:`); gate blocks write no attempt line, spawn/brief failures write `blocked`; requeue
(worktree-busy / codex-slots-full, max 3) waits `deps.requeueDelayMs` (10 s); FIFO drain, busy gate keeps queued, other
refusals mark blocked; worker event written before the attempt line; poll() returns events finished/requeued/started/
blocked (Task 11 consumes them).
**Controller ruling already made (gen 2): fd leak.** The adapter cannot `closeSync` the `store.openOut` fds (write-surface
guard allows only named fs read functions), so 2 handles per Codex job stay open. Ruling: add `closeOut(fd)` to
`store.mjs` (a close, no new write path) and call it in the adapter right after spawn; include it in the 10a fix round
with a test (the fds are closed after spawn; `recordingSpawn` in mc-helpers then need not close them itself).
Gaps that belong to 10b (put in its brief): a run whose process dies without a result line stays `spawned` until
reconcile; no `planRun` yet, so a second request for a worker with a run in flight spawns and relies on codex-run's
`worktree-busy` + requeue.

## What is next, in order
1. Write `GOAL.md` in your scratchpad (copy the open items below).
2. Task 10a: review per the "How this lane works" section of gen2 (opus `worker-high` + Codex `review` with
   `--base <10a commit>~1`; write the Codex brief from `~/.claude/skills/dispatching-codex/templates/review.md`, at most
   80 lines; the one JSON line is truncated, read `~/.claude/state/codex/runs/<run>/last.json`; record `--verdict`).
3. Then 10b (needs 10a; opus + Codex), then 11 (needs 5,6,7,9,10b), then 13 (needs 3,8,11,12), then 14 (all).
4. Minors sweep (the `MINORS SWEEP` lines in carry.md) before the final review.
5. Final Fable `worker-high` whole-build review (`git diff 256e018..HEAD`), fix C/I, scoped re-review.
6. Run all three suites + the e2e spec test list (Task 14) and confirm existing Claude/Codex sessions still work.
7. Report to the user. Task 15 (deploy to `~/.claude`) only after the user's OK. The live OpenAI run waits for the
   user's key AND a price table for gpt-6-luna.

## Carried items (owner = that task's implementer brief): `~/.claude/experiments/2026-10-07-luna-coordinator/carry.md`
Read it before writing each implementer brief and paste the lines for that task. Highlights:
- Task 10b: planRun rule 3 / `widen` has no producer (remove it or add a `/to <id> --own` producer).
- Task 11: serialise provider calls (two concurrent decide() both pass meter.check); honour `/to` `verbatim:true` (skip
  only the too-long check); catch `context-over-budget` and reply; every status/ended worker event carries `at`;
  Task 12 M8 reply half (hard-limit reply via handleLine, /to shortcut still works) tests; batch status helper (Task 9
  status() probes every lane per call).
- Task 13: import ConfigError from provider.mjs; refuse to start (or show errors) when loadConfig returns errors.
- Task 14: /new --in reads `inWorktreeOf`; a /to over ~8 KiB to a BUSY lane arrives cut with a marker naming the
  `.delivered.json` file (Claude Code saves hook output > 10k chars to disk, `~/.claude/cache/changelog.md:5858`);
  idle wake carries the full text — test/document that, not "delivered whole". Docs: common-word labels route by exact
  name; `cfg.context.target_tokens` unused.
- Next task touching context.mjs: drop dead `st.exTok`; add exchange-survival asserts to the J1 Hebrew tests.
- DEFERRED to other owners (already messaged lane cw-batchB): pause-lib.mjs:95 starting-guard self-match;
  coordinator.md:83 "five hooks" count.

## Plan deviations already ruled (tell the user in the final report)
- Long `/to` to a busy Claude lane: hook delivers up to 8 KiB, then a cut marker naming the stored full text (above).
- `loginStatus` has no default process runner (codex-resources.mjs is not in CHILD_OK); codex-adapter injects
  `spawnSync`; without it Codex counts as unavailable (fail closed).
- `usageStatus` blocks a weekly pct with no reset even at low pct (stricter than the Codex wrapper; plan verbatim).
- Write-surface guard is an import allowlist: CHILD_OK = claude-adapter, codex-adapter, cli; OUTSIDE_OK = live.mjs,
  status-lib.mjs (add entries only with review).

## How this lane works
Unchanged from gen2 ("How this lane works"): sonnet writes all code (`worker-high` for real logic), opus `worker-high`
reviews every task, Codex `review` on Codex-specific tasks (10a, 10b), Fable only for the final whole-build review.
Fix rounds go to the same implementer (SendMessage) and a scoped re-review by the same reviewer. Briefs:
`~/.claude/experiments/2026-10-07-luna-coordinator/{impl-common,review-common}.md`. Reviews this gen consistently found
tests that could not fail: ask every reviewer to mutation-check the key tests.

## Open GOAL items
- 10a reviewed/approved (opus + Codex) · 10b · G10 Task 11 · G13 Task 13 · G16 Task 14 · Minors sweep · G14 final Fable
  review · G17 all suites + existing sessions work · G18 report to user.

## Traps (prohibitions)
- Never edit batch-B files: `claude/hooks/coord.mjs`, `recover*.mjs`, `pause-io.mjs`, `power.mjs`, handoff-launch
  `SKILL.md`, `coordinator.md`, `tests/helpers.mjs` (lane `cw-batchB` is live). `pause-lib.mjs` belongs to that lane too.
- Never give Luna a tool, shell or file API; never execute model output; never create paid OpenAI spend.
- Tests open no windows and make no real API/Codex/claude calls (except explicit Codex review runs).
- Public repo: no keys, personal paths or emails; stage by name, never `git add -A`; non-ASCII control characters as
  `\u` escapes. Never stage `.codex-tmp/`.
- Another lane may kill node processes matching `handoff-launch/tests` (it happened at 09:05Z): rerun a suite that
  failed oddly before trusting it.
- Usage pace has run ahead: keep dispatches lean.

## THE PROMPT
Read `docs/handoffs/2026-10-07-luna-coordinator-gen3.md` in this worktree (then gen2's "How this lane works" and the
plan's `## Global Constraints` and `## Task summary`). Follow "What is next, in order" from step 1. Sonnet writes all
code; opus reviews each task; Codex reviews Codex-specific diffs; Fable only reviews the whole build at the end. Report
to the user when the mock-provider spec test list passes.

## Relay notes (written at relay time)
- Gen 2 subagents are not reachable from gen 3: start fresh reviewers/implementers (give them the diff + coverage).
- Diff files from gen 2 lived in its scratchpad; regenerate with `git show <sha> > <your scratchpad>/task-N.diff`.
