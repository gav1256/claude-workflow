# Handoff: Luna coordinator, gen 5 (Decisions build: reviews + Tasks 2, 4a, 4b, 5; then Task 14, sweep, final)

Written 2026-10-07 by lane `luna-coordinator` gen 4 at ~300k context. You are the new controller.

## Repo state
- Worktree `.claude/worktrees/jev-coordinator`, branch `jev-coordinator` (based on `stage2-loop-recovery`; never base on
  `main`; never switch the main checkout's branch). `.codex-tmp/` is Codex review residue: never stage it. HEAD 405d0b2,
  tree clean.
- Old spec/design/plan (Tasks 1-14): `docs/specs/2026-10-07-luna-coordinator-request.md`,
  `docs/specs/2026-10-07-luna-coordinator-architecture.md`, `docs/plans/2026-10-07-luna-coordinator.md`.
- NEW (approved by the user 2026-10-07): spec `docs/specs/2026-10-07-luna-decisions-routing-design.md`; plan
  `docs/plans/2026-10-07-luna-decisions-routing.md` (Global Constraints :20-37; Task 1 :73, 2 :138, 3 :200, 4a :359,
  4b :455, 5 :506, 6 :539; deviations to report at the end of the file).
- Briefs: `~/.claude/experiments/2026-10-07-luna-coordinator/` - `impl-common.md` (has THIS lane's old session id in
  the Claude-Session line: update it to yours), `review-common.md` (points at the OLD plan: tell reviewers the plan +
  task line range), `carry.md` (MINORS SWEEP lines), `gen4-briefs/` (all gen-4 briefs; `dec-impl-template.md` is the
  Decisions implementer brief template: fill N, RANGE, OTHER, CMD).

## Status
| Item | State |
|---|---|
| Tasks 1-13 (old plan) | APPROVED. Task 11: Codex rounds ended (79f7632, 1a2588d); last Codex review: 1 Medium -> carry.md. Task 13: 2c1b3e4 opus APPROVED. Suite 411 at 1a2588d. |
| Decisions plan | APPROVED (opus review + re-review; Codex plan review's 10 findings folded in 466b799; user waived more Codex re-checks) |
| D-Task 1 config + per-api cost | built eb76b83 (sonnet), 428/428. NEEDS opus review. Implementer note: `decisions: null` adds a config error (CLI refuses to start), stricter than the plan's "no crash" - ruled OK by gen 4. |
| D-Task 3 decisions.mjs (pure) | built 58b736c (sonnet), 473/473, 14 mutation probes caught. NEEDS opus review + ONE Codex review. Rule on: (a) a message with a control char -> plan fails validateDecision -> `unusable` -> Luna fallback (maybe clean the instruction instead); (b) provider p1/margin rule also applies when only `claude` is offered (a low single-choice answer clarifies); (c) H / message_multiple target order = concern-set order. |
| D-Task 6 Codex wrapper | built 405d0b2 (sonnet), dispatching-codex suite 456/456. NEEDS opus review + ONE Codex review. Note: exclude list = `["CODEX_API_KEY","*KEY*","*SECRET*","*TOKEN*"]` (defaults repeated in case `exclude` replaces them; unverified whether additive). |
| D-Task 2 provider | NOT started (needs Task 1 approved) |
| D-Tasks 4a, 4b, 5 | NOT started (4a needs 2 + 3; 4b needs 4a; 5 needs 4b) |
| Task 14 e2e + docs | not started (after Task 5; plan "After Task 5" adds the three-path CLI cases + routing docs) |

## How this lane works (user rules, 2026-10-07)
- Sonnet writes ALL code. Effort (user): **medium** = everyday features / clear steps laid out in the plan; **high** =
  complex multi-file reasoning, deep logic tracing, intricate dependencies; never low for plan coding; **xhigh is
  overkill**. Assignments: Task 2 high, 4a high, 4b high, 5 medium, fix rounds / Minors sweep medium.
- Opus `worker-high` reviews every task (review-common.md + the plan line range + the diff file + the coverage lines;
  ask for mutation checks). Fable only for the final whole-build review (`worker-high`).
- Codex: ONE `review` per Decisions/Codex-specific task diff (Tasks 2, 3, 4a, 4b, 6); fold its findings in; NO extra
  Codex re-check rounds (user: "No need to double check everything with codex, if it's approved then start
  building"). Scoped re-reviews of Critical/Important fixes go to the opus reviewer. If a build problem stumps Claude
  (a fix failed twice, an unexplained failure), call Codex for stuck-debugging (user). Codex review command:
  `node ~/.claude/skills/dispatching-codex/codex-run.mjs --brief <f> --cwd <worktree> --mode review --base <ref> --model sol --effort high --task <id>`
  in the background; there is no `--head`: the patch is `<base>...HEAD`, so name the files to review in the brief.
  Read `~/.claude/state/codex/runs/<run>/last.json`; record `codex-run.mjs --verdict <run> approve|rework|reject "<note>"`.
- Codex `blocked worktree-quarantined`: the check also sees OTHER lanes' live Codex sandbox processes. First run
  `--clear-quarantine <worktree>` WITHOUT `--yes` and read `listed`; only when it lists 0 processes run it with
  `--yes` (user OK given 2026-10-07 for this worktree). Never `--yes` while processes are listed (they may be cw-batchB's).
- Parallel implementers in this one worktree on DISJOINT files; each commits only its files by name
  (`git commit -- <paths>` for docs you commit yourself while a worker has staged files).
- Suites: model-coordinator `timeout 900 node --test "claude/skills/model-coordinator/tests/*.test.mjs"` (473);
  Codex `timeout 900 node --test "optional/codex/skills/dispatching-codex/tests/*.test.mjs"` from that folder (456;
  flakes: locks.test.mjs:408 EPERM, run.test.mjs ~:1264 'active' vs 'clean' under load - rerun once); handoff-launch
  `timeout 900 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` (~10 min).
- PowerShell `Get-Content`/`Set-Content` without `-Encoding UTF8` mangles non-ASCII (it happened once in the plan):
  edit docs with the Edit tool.

## Order (next steps)
1. GOAL.md in your scratchpad (copy the open items below). Update impl-common.md's Claude-Session line.
2. One message: opus reviews of D-Tasks 1, 3, 6 (three agents) + Codex reviews of 3 and 6 (sequential, one background
   chain) + Task 2 implementer (sonnet worker-high; Task 1 is small and its review is unlikely to change Task 2's
   interface - if it does, fold it into Task 2's fix round).
3. Fix rounds (sonnet medium) for C/I findings; opus scoped re-review. Minors -> carry.md (or fix in the next task
   touching the file).
4. Task 4a (after 2 + 3 approved), then 4b, then 5; opus + one Codex review each (Codex not for 5).
5. Task 14 (old plan Task 14 + the Decisions additions), Minors sweep (carry.md MINORS SWEEP lines incl. the Codex
   Medium on dispatcher.mjs:280), final Fable worker-high whole-build review (`git diff 256e018..HEAD`), all three
   suites, confirm existing Claude/Codex sessions work, report to the user (plan deviations: gen3 + gen4 lists + the
   Decisions plan's deviations). Task 15 deploy and any live OpenAI run only with the user's OK (paid; needs key and
   `pricing["gpt-6-luna"]` incl. `decisions_input_per_mtok`).

## Open GOAL items
D6 Decisions build (Tasks 1, 3, 6 built; 2, 4a, 4b, 5 open) · D7 three-path + coreference + outage tests pass (Tasks
3, 4a, 4b) · D8 t10 OpenAI items (built in Task 6, needs review) · G16 Task 14 · Minors sweep · G14 final Fable review ·
G17 all three suites + existing sessions · G18 report.

## Plan deviations to report (add to gen3/gen4 lists)
- Task 11/13 fix rounds: a replay of a create whose worker died before launching starts a NEW worker id (auth-02)
  instead of reusing the dead id (1a2588d); a Codex request with no repo anywhere gets "no repo" before the queue gate.
- Decisions: see the plan's "Recorded deviations" (exchanges ledger not coordinator_records.md; provider/needs_text
  always asked; Decisions sends to a worker verbatim; `decisions.model` own key) + `decisions: null` is a config error.

## Peer note
Lane cw-batchB (gen 9, Shabbat build S3-S6) owns handoff-launch pace-*/pause-*/launch/recover-lib, coord.mjs,
broadcast SKILL.md, pause-lib.mjs, and merges to stage2-loop-recovery first; jev-coordinator merges onto theirs. OURS
at merge time: `coordinator.md:83` "five hooks" -> "six".

## Traps
Batch-B files off limits (coord.mjs, recover*.mjs, pause-io.mjs, power.mjs, handoff-launch SKILL.md, coordinator.md,
tests/helpers.mjs, pause-lib.mjs); no Luna/Decisions tools; never execute model output; no paid spend; tests start
nothing real; public repo hygiene (stage by name, no personal paths/emails/keys, non-ASCII control chars as `\u`
escapes); `codex-lib.mjs` hash-pinned. Usage pace has run ahead: keep dispatches lean.

## THE PROMPT
Read `docs/handoffs/2026-10-07-luna-coordinator-gen5.md` in this worktree first (then the Decisions plan's Global
Constraints and the task sections you dispatch). Write GOAL.md, then follow "Order" from step 2. Sonnet writes all code
(effort per the handoff); opus reviews every task; one Codex review per Decisions/Codex task, no extra Codex rounds;
Codex for stuck-debugging; Fable only for the final whole-build review.
