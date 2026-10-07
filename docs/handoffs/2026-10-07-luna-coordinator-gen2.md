# Handoff: Luna coordinator, gen 2 (implementation, Tasks 2-review onward)

Written 2026-10-07 by lane `luna-coordinator` gen 1 at ~260k context. You are the new controller.

## Repo state
- Worktree `.claude/worktrees/jev-coordinator`, branch `jev-coordinator`, rebased on `stage2-loop-recovery` tip
  (never base on `main`; never switch the main checkout's branch).
- Spec (user's request, binding): `docs/specs/2026-10-07-luna-coordinator-request.md`.
- Design: `docs/specs/2026-10-07-luna-coordinator-architecture.md`; its "Resolutions" A-G override earlier sections
  (A = user ruling: message delivery uses documented features only: hook-delivered message files + `--bg` workers
  woken with `claude --resume <sid> --bg`; B-E = Codex review 20261007T071947Z-2eac22; F = batch-B file ownership;
  G = t10 items in scope).
- Plan: `docs/plans/2026-10-07-luna-coordinator.md` (commit 256e018). Fable reviewed it (8 Important fixed in
  81e00c5), opus re-reviewed twice (approve at 256e018). 16 tasks: 1-9, 10a, 10b, 11-15, plus a Final Fable review.
  Its "Task summary" section has the implementer/reviewer per task and the dependency table.
- Paid-API fallback is DEFERRED to V2 (Fable I3; plan "Deferred" section): config refuses `fallback: "paid_api"`.

## Task status (commits on `jev-coordinator`)
| Task | State | Commits | Next action |
|---|---|---|---|
| 1 env strip | APPROVED (opus) | 8d4f1b0 | none; 3 test Minors carried (carry.md) |
| 2 status-lib | review fixes done, 554/554 | 01a3f81, 34f00d8 | **scoped opus re-review of 34f00d8** (fixes 1-5 of the Task 2 review; item 5 was a controller ruling: ladder-killed / lane_blocked lanes = closed_unfinished "blocked after loop ladder") |
| 3 resume --closed | not started | - | after Task 2 re-review approves |
| 4 t10 Codex fixes | implemented | 463ce36 | opus review + Codex review |
| 5 schema/validator/mock | APPROVED (opus + scoped re-review) | e6beb43, 2a1bea6, be08d5d | none |
| 6 store/write lock/env | implemented, 46/46 | 8969d65 | **opus review** (correctness-critical: write lock, real-path/junction checks, write-surface test) |
| 7-15 | not started | - | per the dependency table |

### Task 4
Implemented, commit 463ce36 (lib/usage.mjs, lib/locks.mjs + their tests). M1-M5 done: unknown reset blocks at high
pct or a reached type (`codex-quota-unknown-reset`); latestReading walks only the last 9 UTC day folders; busySlots
re-probes once after 150 ms; acquireSlot scans 3 passes. Targeted 16/16; full Codex suite 447/451 with
locks.test.mjs:408 (known flake) + procs EPERM + run.test "WTR clean" failures that pass in isolation (real Codex
sandbox processes were running). Implementer concern: the busySlots test is only weakly red (50 ms hold race).
**Next: opus review + Codex `review` run (`--base 463ce36~1`), both on commit 463ce36.**
Ask the reviewer to judge the weak busySlots test and to rerun the suite with no real Codex processes running.

## How this lane works (keep doing it)
- Sonnet writes ALL code (`worker-medium` routine, `worker-high` real logic; per the plan's Task summary).
- Every task review: opus `worker-high`. User rule 2026-10-07: NO per-task Fable; Fable only for the Final
  whole-build review (large and complex). Codex `review` mode also on Codex-specific tasks (4, 8, 10a, 10b):
  `node ~/.claude/skills/dispatching-codex/codex-run.mjs --brief <file> --cwd <worktree> --mode review --base <sha>
  --model sol --effort high --task <id>`; the one JSON line is truncated: read findings from
  `~/.claude/state/codex/runs/<run>/last.json`; record `--verdict`.
- Reusable briefs (copy, don't rewrite): `~/.claude/experiments/2026-10-07-luna-coordinator/impl-common.md` and
  `review-common.md`. Implementer prompt = "read impl-common.md; your task section is plan lines A-B" + task notes.
  Reviewer prompt = review-common.md + diff file (`git show <sha> > <scratchpad>/task-N.diff`) + the implementer's
  coverage lines + the task test command.
- Fix rounds: send the review findings to the SAME implementer agent (SendMessage, it keeps context); then a scoped
  re-review by the same reviewer agent of just the fix diff. Minors on user-requested features are fixed, not deferred
  (memory `finish-user-features-fully`), unless cheaper in the next task that touches the file.
- Carried Minors: `~/.claude/experiments/2026-10-07-luna-coordinator/carry.md` (Task 8: P2 withEnv restore; Task 9:
  Task 1 env-strip test Minors; Task 10b: P1 planRun rule 3 `widen` has no producer; Task 12: prompt must say
  new_session all-null for non-create actions; noNew error field renamed to `new_session`). Put each into that
  task's implementer prompt.
- Parallel implementers in this one worktree on DISJOINT files work (impl-common.md says how); only start a task
  whose dependencies are reviewed and approved.
- Suites: model-coordinator `timeout 900 node --test "claude/skills/model-coordinator/tests/*.test.mjs"`;
  handoff-launch `timeout 900 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` (~10 min, 554 tests);
  Codex `timeout 900 node --test "optional/codex/skills/dispatching-codex/tests/*.test.mjs"` (known flakes:
  locks.test.mjs:408 EPERM rename; quarantine cases when real Codex sandbox processes run).

## What is next, in order
1. Write `GOAL.md` in your scratchpad (copy the open items below), then dispatch in one message: the Task 2 scoped
   re-review, the Task 6 opus review, and the Task 4 next step (see Task 4).
2. Then Task 3 (after Task 2 approves), Task 7 (needs 5, 6), Task 8 (needs 4, 6), Task 12 (needs 5, 6) in parallel
   where files are disjoint; then 9, 10a, 10b, 11, 13, 14 per the dependency table.
3. Final Fable `worker-high` whole-build review (`git diff 256e018..HEAD`), fix C/I, scoped re-review.
4. Run all three suites + the e2e spec test list (Task 14) and confirm existing Claude/Codex sessions still work.
5. Report to the user. Task 15 (deploy to `~/.claude`) only after the user's OK. The live OpenAI run waits for the
   user's key AND a price table for gpt-6-luna.

## Open GOAL items (from gen 1)
- G5 t10 Codex items (Task 4) · G6 env strip (Task 1 done; coordinator launchEnv/childEnv in Task 6) · G7 status-lib
  (Task 2) · G8 resume --closed (Task 3) · G9 provider abstraction (Task 5 done; OpenAILunaProvider = Task 12) · G10
  dispatcher validation + write lock (Tasks 5, 6, 11) · G11 Codex resource manager (Task 8) · G12 cost limits (Task 12)
  · G13 `coordinator` command (Task 13) · G14 every task opus-reviewed, final Fable review · G15 Codex review on
  Codex diffs · G16 spec test list passes on mock (Task 14) · G17 existing suites pass · G18 report to user.

## Traps (prohibitions)
- Never edit batch-B files: `claude/hooks/coord.mjs`, `recover*.mjs`, `pause-io.mjs`, `power.mjs`, handoff-launch
  `SKILL.md`, `coordinator.md`, `tests/helpers.mjs` (lane `cw-batchB` is live). `live.mjs`/`launch.mjs` are fine.
- Never give Luna a tool, shell or file API; never execute model output; never create paid OpenAI spend.
- Tests open no windows and make no real API/Codex/claude calls (except explicit Codex review runs).
- Public repo: no keys, personal paths or emails; stage by name, never `git add -A`; write non-ASCII control
  characters as `\u` escapes (raw bidi bytes were caught once).
- `launch.mjs` refuses `--model sonnet`; Claude workers default to opus.
- Usage pace has run ahead: keep dispatches lean; step effort down for mechanical steps.

## THE PROMPT
Read `docs/handoffs/2026-10-07-luna-coordinator-gen2.md` in this worktree, then the plan's `## Global Constraints`
and `## Task summary`. Follow "What is next, in order" from step 1. Sonnet writes all code; opus reviews each task;
Codex reviews Codex-specific diffs; Fable only reviews the whole build at the end. Report to the user when the
mock-provider spec test list passes.
