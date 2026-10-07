# Handoff: Luna coordinator, gen 6 (Task 5 fix re-review, Task 14 review, Minors sweep, final Fable review, suites, report, Task 15)

Written 2026-10-07 by lane `luna-coordinator` gen 5 at ~270k context. You are the new controller.

## Repo state
- Worktree `.claude/worktrees/jev-coordinator`, branch `jev-coordinator` (based on `stage2-loop-recovery`; never base on
  `main`; never switch the main checkout's branch). `.codex-tmp/` is Codex residue: never stage it.
- Extra worktree `.claude/worktrees/jev-codex-review` (detached, ours): used ONLY to run Codex reviews at a fixed commit
  so commits in the main worktree never "head-move" a running review. `git -C <it> checkout --detach <sha>` before each
  run. Remove it (`git worktree remove`) when the lane is done.
- Plans: Decisions plan `docs/plans/2026-10-07-luna-decisions-routing.md` (Global Constraints :20-37; Task 5 :506-537;
  "After Task 5" :574-579; Recorded deviations :586-590); old plan `docs/plans/2026-10-07-luna-coordinator.md` (Global
  Constraints :40-87; Task 14 :1902-1987; Task 15 :1988-2020).
- Briefs: `~/.claude/experiments/2026-10-07-luna-coordinator/` - `impl-common.md` (Claude-Session line: update to YOUR
  session), `review-common.md` (points at the OLD plan), `gen5-briefs/rev-common5.md` (the gen-5 reviewer note: plan +
  build the coverage table + mutation checks), `carry.md` (MINORS SWEEP lines), `gen5-briefs/` (every gen-5 brief and
  diff), `gen5-briefs/GOAL-gen5.md` (gen-5 checklist with evidence).

## Status (gen 5 commits 3f4c04a..3286c2e, suite 597+ green at 8b171f5)
| Item | State |
|---|---|
| D-Tasks 1, 2, 3, 4a, 4b, 6 | APPROVED: opus review + one Codex review each, every Critical/Important fixed and opus re-reviewed (evidence in GOAL-gen5.md) |
| D-Task 5 (8b171f5) | opus review: 1 Important (CLI by_api untested) + 3 Minors -> fix round 3286c2e (K-once-status-spend, state word on spend line "- ok." / "- soft limit reached." / "- hard limit reached: model calls paused.", no double pause sentence, codex-resources test loads the real lib under mcEnv). NEEDS opus scoped re-review (diff `gen5-briefs/d5-fix.diff`). No Codex review for Task 5 (plan). |
| e2bd61d (codex-adapter test isolation, debugger) | opus APPROVED (inside the Task 5 review) |
| Task 14 (e2e + docs) | built b9d99b3, NEEDS opus review (section below) |
| Minors sweep | open: `carry.md` MINORS SWEEP lines (9) incl. the Codex Medium on dispatcher.mjs:280, plus any "Task 14"/"Task 11" lines Task 14 does not close |
| G14 final Fable review, G17 suites + sessions, G18 report | open |
| Task 15 deploy + live OpenAI run | USER APPROVED 2026-10-07 ("approval for 15 now"), but ONLY after G14 + G17. Key: the user puts it in `openai.key_file` (secrets folder) or `OPENAI_API_KEY` - never ask them to paste it in chat. Needs the real `pricing["gpt-6-luna"].decisions_input_per_mtok` (and responses prices): ask the user for the number if unknown; the CLI refuses to start Decisions without it (by design). |

## Task 14 (committed b9d99b3 by gen 5, NOT yet reviewed)
- Brief `gen5-briefs/t14.md`; diff `gen5-briefs/t14.diff` (3286c2e..b9d99b3). e2e 29/29; full suite 629/629.
- Implementer coverage: M1 tests/e2e.test.mjs:159-527 (23 spec tests); M2 SKILL.md; M3 README row + INSTALL_PROMPT
  lines (deviation: verification expects "Spend this month:" since --status has no "workers:" line); M4 e2e:608/:622/:641
  (three paths at CLI level); M5 :666 (outage -> luna-fallback); M6 SKILL.md "How messages are routed"; M7 carried items:
  item 9 already at coordinator.test.mjs:237, item 11 already at coordinator.mjs:168 + dispatcher.mjs:264 (+ e2e:455),
  item 14 documented (target_tokens reserved), item 22 e2e:527 (9003-char /to to a busy lane: cut + .delivered.json
  marker) and :548 (idle wake, full text).
- Deviations to rule on in the review: mcSandbox lives in e2e.test.mjs (not mc-helpers); three spec rows follow the
  code, not the plan text (duplicate = coordinator replay; finished worker /to = shortcut error text, not clarify;
  Claude launch exit 1 = dead, Codex failure = failed); Luna record-only test hashes the repo excluding .claude.

## Order (next steps)
1. GOAL.md in your scratchpad (open items below). Update impl-common.md's Claude-Session line.
2. One message: opus scoped re-review of 3286c2e (send the Task 5 brief `gen5-briefs/fix-d5.md` + `d5-fix.diff`) and
   the opus review of Task 14 (section above). Task 14 has no Codex review.
3. Fix rounds (sonnet medium) for Critical/Important; opus scoped re-review.
4. Minors sweep (sonnet medium): all `carry.md` MINORS SWEEP lines + leftovers; opus review of the sweep diff.
5. Final Fable `worker-high` whole-build review: `git diff 256e018..HEAD` (write it to a file); fix C/I; scoped re-review.
6. All three suites (commands below), confirm existing Claude/Codex sessions work, report to the user with the plan
   deviations (gen3 + gen4 lists, the Decisions plan's 4, plus gen 5's below). Then Task 15 with the user's OK above.

## How this lane works (user rules, 2026-10-07)
- Sonnet writes ALL code (medium for fix rounds/sweep, high for real logic). Opus `worker-high` reviews every task
  (review-common.md + rev-common5.md + plan range + diff file + coverage lines; ask for mutation checks). Fable only for
  the final whole-build review (`worker-high`).
- Codex: ONE review per Decisions/Codex task (all done); no extra Codex rounds; Codex for stuck-debugging. Codex
  quarantine: other lanes' Codex sandbox processes block runs. Run `--clear-quarantine <worktree>` WITHOUT `--yes`, read
  `listed`; only with 0 listed run it with `--yes`; never `--yes` while processes are listed. A background poll loop
  (every 120 s) worked well.
- Parallel implementers in this worktree on DISJOINT files; each commits only its files by name.
- Suites: model-coordinator `timeout 900 node --test "claude/skills/model-coordinator/tests/*.test.mjs"` (~600+);
  Codex `timeout 1500 node --test "tests/*.test.mjs"` from `optional/codex/skills/dispatching-codex` (458; flakes under
  load: run.test.mjs 'active' vs 'clean' WTR rows, procs row 10, locks.test.mjs:408 EPERM - rerun once alone);
  handoff-launch `timeout 900 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` (~10 min).

## Plan deviations to report (gen 5 additions)
- A single offered provider (only Claude, when Codex is not eligible) is taken without the probability/margin rule
  (spec line 92 has no exception; asking "Claude or Codex?" when Codex is not offered misled). Codex review flagged it;
  kept by controller ruling.
- `cleanLine` strips ANSI/OSC sequences, C1 and bidi controls and turns other C0 controls into a space BEFORE routing;
  the worker receives the cleaned text (Trojan-Source safe; the validator refused those characters anyway).
- The turn replay guard runs before every branch (shortcuts and commands too), not only model turns; an existing
  coordinator.test.mjs duplicate test was rewritten for it (reviewer-approved).
- A blank-after-cleaning line gets "I got no text to route." with no model call; a hard-limit turn says the pause once.
- Usage figures that are zero, negative or non-integer are charged as the estimate (fail closed); a non-finite estimate
  charges the monthly hard limit (cannot occur through the providers: check() refuses first).
- Found and fixed: before ae600ba the live Codex wrapper let `CODEX_API_KEY` reach sandboxed commands (Codex 0.160
  applies no default env excludes; live probe). Main still has the old wrapper until this branch merges: tell the user.

## Peer note
Lane cw-batchB (gen 9) owns handoff-launch pace-*/pause-*/launch/recover-lib, coord.mjs, broadcast SKILL.md,
pause-lib.mjs and merges to stage2-loop-recovery first; jev-coordinator merges onto theirs. OURS at merge time:
`coordinator.md:83` "five hooks" -> "six". Lane `coordinator` (gen 5) runs Property V1 in Realestate_Backend: Codex
slots are shared.

## Traps
Batch-B files off limits (coord.mjs, recover*.mjs, pause-io.mjs, power.mjs, handoff-launch SKILL.md, coordinator.md,
tests/helpers.mjs, pause-lib.mjs); no Luna/Decisions tools; never execute model output; no paid spend before Task 15;
tests start nothing real; public repo hygiene (stage by name, no personal paths/emails/keys, control chars as `\u`
escapes); `codex-lib.mjs` hash-pinned; heredocs in bash expand `$7`/`$10` - quote them (`<<'EOF'`).

## THE PROMPT
Read `docs/handoffs/2026-10-07-luna-coordinator-gen6.md` in this worktree first. Write GOAL.md, then follow "Order"
from step 2. Sonnet writes all code; opus reviews every task; no more Codex reviews (all
done) except for stuck-debugging; Fable only for the final whole-build review. Task 15 is user-approved but only after
the final review and suites, and the key never goes through chat.
