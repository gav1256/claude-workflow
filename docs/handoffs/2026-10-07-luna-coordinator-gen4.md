# Handoff: Luna coordinator, gen 4 (Decisions-API routing design + build wrap-up)

Written 2026-10-07 by lane `luna-coordinator` gen 3 at ~285k context. You are the new controller.

## Repo state
- Worktree `.claude/worktrees/jev-coordinator`, branch `jev-coordinator` (based on `stage2-loop-recovery`; never base
  on `main`; never switch the main checkout's branch). `.codex-tmp/` is Codex review residue: never stage it.
- Spec: `docs/specs/2026-10-07-luna-coordinator-request.md`; design `docs/specs/2026-10-07-luna-coordinator-architecture.md`;
  plan `docs/plans/2026-10-07-luna-coordinator.md` (Global Constraints :40-87, Task summary :2049-2096).
- How this lane works: gen2 handoff "How this lane works" (still valid) + gen3 handoff. Briefs:
  `~/.claude/experiments/2026-10-07-luna-coordinator/{impl-common,review-common,carry}.md` (impl-common now carries this
  session's Claude-Session line; update it to YOUR session id).

## Task status
| Task | State | Commits |
|---|---|---|
| 1-9, 12 | APPROVED (gen 1-2) | see gen3 handoff |
| 10a | APPROVED (opus + Codex) | bff4998, 06f60bc |
| 10b | APPROVED (opus + Codex) | 8f9b78c, 6190e8f, dbc7a94, 42fd606 |
| claim race (Task 9 code) | APPROVED (opus) | 7a54e24 (Windows rename is not an exclusive claim -> link+unlink) |
| 11 dispatcher + turn loop | opus APPROVED (10fce9a, e08601b); Codex rounds on e08601b/1ce894b/56e8326; LAST open item: stale-snapshot relaunch fix landed 120b814 (398/398) -> needs ONE Codex scoped re-review of 120b814 (brief template: gen3-briefs/t11-fix3-codex-review.md) | 10fce9a, e08601b, 1ce894b, 56e8326, 120b814 |
| 13 CLI + shim | ec1ca65 (398/398). Opus review: FIX NEEDED, 1 Important (I1 below); M1-M7, K1-K9 hold, 8 mutations caught | ec1ca65 |

Task 13 fix round (dispatch a fresh sonnet worker-high, then a scoped opus re-review; Codex review too since it
touches codex-adapter):
- I1 (Important): codex-adapter `homeOf`/`worktreePathOf` (~:141/:149, wired by cli.mjs:148) use the coordinator's
  start repo, not the worker's stored `repo` (dispatcher.mjs:191). No repo (coordinator started outside git): `/to
  codex-01 ...` throws in path.join(null), dispatcher replies "started; status pending", message lost. Wrong repo:
  creates `codex-codex-01` in the start repo. Fix: `worker.repo ?? repo`; neither -> `{ok:false, reason:"no repo"}`
  (a clear reply, not "pending"); tests for both halves.
- m1 (fix before ship, same round): coordinator.mjs:81/:147 appends "Codex is unavailable right now" to EVERY reply;
  show it only when the state changes, and in /status.
- m2: K9 per-lane `resume --closed --id <id>` is only spy-tested; add one `launch: "real"` case (HL_NO_SPAWN).
- m3: Ctrl+C / interactive restart prompt untested; Ctrl+C during the prompt precedes the rl SIGINT listener - make it
  exit cleanly (code 0, pipe released) and test what is feasible without a TTY, else document.
- Rulings accepted: --status lock-free; no TTY never asks; codexGate read-only probe; notice filtering; K8 wording;
  instance.json kept; coordinator.cmd LF is safe (optional `*.cmd text eol=crlf`).
| 14 e2e + docs | not started (needs 13) | - |

Check `git log --oneline -8` first: the Task 11 fix commit may have landed after this handoff was written.
Gen 3 subagents are NOT reachable from gen 4: if the Task 13 opus review or the Task 11 fix did not report, redo them
fresh (Task 13 review prompt: review-common.md + plan :1826-1901 + scratchpad brief t13-impl.md (copy in
`~/.claude/experiments/2026-10-07-luna-coordinator/` if the gen-3 scratchpad is gone) + `git show ec1ca65`).
Codex review briefs: `~/.claude/skills/dispatching-codex/templates/review.md`; run
`node ~/.claude/skills/dispatching-codex/codex-run.mjs --brief <f> --cwd <worktree> --mode review --base <sha>~1 --model sol --effort high --task <id>`
in the background; read `~/.claude/state/codex/runs/<run>/last.json`; record `--verdict`.

## NEW USER REQUEST (2026-10-07): Decisions API as the primary routing layer
The user pasted a long request (faithful condensed copy: `~/.claude/experiments/2026-10-07-luna-coordinator/decisions-request.md`; gen-3 briefs and GOAL.md copied to `gen3-briefs/` there).
Brainstorming path: ARCHITECTURAL (full process: questions -> approaches -> design sections -> spec -> user review ->
writing-plans). Research done (Codex run 20261007T124418Z-22bcd2, approved): OpenAI Decisions API exists (beta
2026-10-06): `POST /v1/decisions`, model `gpt-6-luna` only; body `{model, input (string or user messages), questions:
[{type:"choice"|"predicate"|"score", name?, instructions, choices:[{value, description?}] | levels}]}`; response
`{answers:[{type, name, choice, confidence, probabilities:[{value, probability}]} | {type:"refusal", name}], model,
usage{input_tokens, ...}}`; $0.10 / 1M input tokens, no output/cache charge; openai-node >= 7.30.0
`client.decisions.create`; no calibration guarantee; Decisions-specific rate limits unverified. The coordinator uses
`fetch` directly (openai-provider.mjs:55) - mirror that, no SDK dependency.

User answers so far:
1. Text generation trigger: **Decisions + fixed rules** (fixed rules first: message to an existing worker forwards the
   user's words unchanged; explain/summarise/plan requests and a new worker with a vague/long goal -> Luna text;
   otherwise a `needs_text` predicate probability decides).
2. Multi-worker: **same call, one predicate per live worker** (`concerns_<id>`, up to 8); several >= threshold -> send
   to all; any in the uncertain middle band -> clarify.
3. Decisions down: **old Luna routing (stricter confidence), then shortcuts-only reply**; same request id, no double
   dispatch.

Design part 1 (flow, approach A) was PRESENTED and is AWAITING the user's OK (ask them first thing):
- Approach A (recommended): Decisions in front; the existing Luna Responses provider becomes the text writer (called
  with the route pinned: it writes only worker_instruction/reply/brief and cannot change target/action) and the
  fallback router (today's code path). B (a new slim Luna generator schema) and C (no Luna routing fallback) rejected.
- Flow: shortcuts (resolve.mjs, unchanged) -> one Decisions call with questions `route` (choice: live workers described
  by id, provider, label, aliases, objective, current task, status, short last result; + `new_session`, `clarify`),
  `provider` (choice claude/codex; codex offered only when the Codex resource manager reports eligible; asked only when
  a new worker is possible), `concerns_<id>` predicates, `needs_text` predicate; input = message, focused id, worker
  summaries, last 4-6 turns, no transcripts -> thresholds (config `decisions.min_route_probability` 0.80,
  `decisions.min_margin` 0.20; tune by tests) -> forced clarify on refusal, unknown/finished target, contradicting
  focus, unclear risky request -> text needed? -> existing validate + dispatcher (final authority: Codex gate,
  conflicts, fallback, idempotency).
Still to present: part 2 cost/records (separate ledger fields: decision calls/input tokens/cost/latency vs Responses
calls/in/out/cache tokens/cost/latency; combined $7 soft / $10 hard; price table must include the decisions rate;
records unchanged; Luna/Decisions get no tools) and part 3 testing (three-path tests from the request section 14 +
coreference cases, close probabilities, Codex unavailable after selection, Decisions outage -> Luna fallback, retries
cannot double-dispatch, existing sessions unaffected, no project-file writes). Then write the spec
(`docs/specs/2026-10-07-luna-decisions-routing-design.md`), self-review, user review, writing-plans, plan review (opus;
Fable only if large/complex), execution. The user also asked: use Codex to review the Decisions integration during
planning/implementation (a Codex `review` of the plan + of each Decisions task diff).
Also fold in (request item 7): the small OpenAI-tool items in
`~/.claude/experiments/2026-10-02-parallel-sessions/codex-dual-gen2/t10-review-notes.md`: pin a test that
CODEX_API_KEY never reaches the Codex sandbox env (e10c8a7 re-review M5) and remove/guard the CODEX_RUN_NET_FIXTURE
knob in production (re-review M7). Those live in the Codex wrapper (`optional/codex/skills/dispatching-codex/`).

## Order after the relay
1. GOAL.md in your scratchpad (copy the open items below).
2. Collect the two in-flight results (Task 11 fix -> Codex scoped re-review; Task 13 opus review -> fix round).
3. Continue the Decisions design with the user (part 1 OK?, parts 2-3), spec, plan, build (sonnet writes; opus
   reviews; Codex reviews the Decisions diffs).
4. Task 14 after the Decisions work lands (its e2e list must include the three-path tests), Minors sweep (carry.md
   MINORS SWEEP lines), final Fable worker-high whole-build review (`git diff 256e018..HEAD`), all three suites, report.
   Task 15 deploy only after the user's OK; live OpenAI runs need the user's key and their OK (paid).

## Open GOAL items
G10 Task 11 (last Codex re-review) · G13 Task 13 review/fixes · D3 design agreed · D4 spec · D5 plan · D6 build · D7
tests · D8 t10 OpenAI items · G16 Task 14 · Minors sweep · G14 final Fable review · G17 suites + existing sessions ·
G18 report.

## Plan deviations to report to the user (add to gen3's list)
- Codex `--in <ref>` on a ref worktree with uncommitted changes: codex-run refuses (`dirty: ...`), the worker shows
  blocked with that list; commit first.
- Write-surface guard: the only dynamic import lives in `codex-lib.mjs`, pinned by sha256 in write-surface.test.mjs
  (edit => re-review + hash update).
- planRun rule 3 (`widen`) removed (no producer in V1).

## Peer note
Lane cw-batchB gen 8 (2026-10-07) claimed handoff-launch pace-*/pause-*/launch/recover-lib, coord.mjs, broadcast
SKILL.md for its Shabbat follow-up and merges to stage2-loop-recovery FIRST; jev-coordinator rebases/merges onto
theirs (we already changed launch.mjs and live.mjs; no further edits planned). They own the pause-lib.mjs:95 fix. OURS at merge time (agreed with cw-batchB): in the same
merge, change `coordinator.md:83` "five hooks" to "six" (the MC delivery hook added in d7cbd5e).

## Traps
Same as gen3 (batch-B files off limits; no Luna tools; no model-output execution; no paid spend; tests start nothing
real; public repo hygiene). Usage pace has run ahead: keep dispatches lean. Codex reviews find something new nearly
every round on dispatcher/codex-adapter: after the Task 11 stale-snapshot fix, accept remaining Minor-only Codex
findings into the Minors sweep instead of another round.

## THE PROMPT
Read `docs/handoffs/2026-10-07-luna-coordinator-gen4.md` in this worktree (then gen3's and gen2's "How this lane
works"). Write GOAL.md first. Collect the in-flight Task 11/13 results, then resume the Decisions-API design with the
user exactly where it stopped (ask whether design part 1 is right). Sonnet writes all code; opus reviews; Codex reviews
Codex- and Decisions-specific diffs; Fable only reviews the whole build at the end.
