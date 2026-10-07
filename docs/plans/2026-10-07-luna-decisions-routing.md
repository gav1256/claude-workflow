# Luna coordinator: Decisions-API routing, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the OpenAI Decisions API in front of the Luna coordinator's routing, keep Luna Responses as the
route-pinned text writer and the fallback router, track both costs, and close two small Codex-wrapper items.

**Architecture:** A pure module (`decisions.mjs`) builds the Decisions request from the live registry and turns the
answers into a `CoordinatorDecision` (or a code-written clarify) by fixed threshold rules. A thin provider
(`decisions-provider.mjs`) sends it with `fetch`, metered under its own `api`. `coordinator.mjs` calls Decisions
first, calls Luna only for text (with the route pinned by code), falls back to today's Luna routing on a Decisions
outage, and records which path decided each turn. The dispatcher stays the final authority.

**Tech Stack:** Node >= 20 ESM, `node:test`, no new dependencies (global `fetch`).

**Spec:** `docs/specs/2026-10-07-luna-decisions-routing-design.md` (approved 2026-10-07). Earlier plan for everything
not changed here: `docs/plans/2026-10-07-luna-coordinator.md`.

## Global Constraints
All of `docs/plans/2026-10-07-luna-coordinator.md` `## Global Constraints` (lines 40-87) apply. In short, plus the
Decisions-specific lines:
- Never execute model output. Model text is only ever passed as text to a worker or shown to the user.
- Decisions and Luna have no tools, no shell, no file API. Neither provider module imports `store.mjs`, `node:fs`
  write functions or `node:child_process` (`tests/write-surface.test.mjs` scans every module).
- A route comes only from code: `action`, `target_session_ids`, `new_session.needed`, `new_session.provider` are
  set from Decisions answers by `decisions.mjs`; a Luna writer answer can change only `reply`, `worker_instruction`,
  `new_session.label`, `new_session.objective`.
- The model cannot invent ids: an answer whose choice is not one of the offered values is unusable.
- No paid spend by default: `provider: "none"` default; the Decisions provider refuses to start without
  `provider: "openai"`, a key, and `pricing["gpt-6-luna"].decisions_input_per_mtok`.
- Monthly soft $7 / hard $10 apply to COMBINED Decisions + Responses spend; at the hard limit neither is called.
- One turn = one `turnId` = at most one `dispatcher.dispatch` call, whatever retries or fallbacks happen.
- Tests start nothing real: fake `fetch`, mock providers, sandboxes from `tests/mc-helpers.mjs`.
- Public repo; stage by name; batch-B files off limits; `codex-lib.mjs` is hash-pinned (do not edit).
- Suite: `timeout 900 node --test "claude/skills/model-coordinator/tests/*.test.mjs"` (407/407 at plan time).

## Review Focus
1. A worker id that went finished/dead between the snapshot and the answer: the existing advice reply, never a send
   (Task 3 test I-dead; Task 4 test C-dead).
2. More than 8 live workers: the concern predicates cover at most 8 workers INCLUDING the focused one; a route to a
   worker outside that set while a different worker is the only concerned one clarifies (Task 3 test I-nine).
3. Predicate probabilities arrive as `true`/`false` booleans or as `"true"`/`"false"` strings (the beta docs show
   strings in one place): both read the same, anything else is unusable (Task 2 test P-bool).
4. A Decisions timeout after the request reached OpenAI, then Luna routes: one dispatch, both calls metered (Task 4a
   test C-timeout-once, with the REAL Decisions provider over a fake fetch so the usage lines are real).
5. A user line with control or bidi characters reaches the Decisions input escaped/capped, and a code-built label
   from it still passes `LABEL_RE` or falls back to `worker-<n>` (Task 3 test L-ctrl).

## File structure
| File | Responsibility | Task |
|---|---|---|
| `config.mjs` | `decisions` defaults + validation | 1 |
| `cost.mjs` | per-api price, worst case and ledger field; combined state with breakdown | 1 |
| `openai-provider.mjs` | export `loadKey` (shared key loading); writer input unchanged otherwise | 2 |
| `decisions-provider.mjs` (new) | `createOpenAIDecisionsProvider`: fetch, retries, meter, answer-shape check | 2 |
| `provider.mjs` | `MockDecisionsProvider` | 2 |
| `decisions.mjs` (new) | pure: `buildDecisionsRequest`, `interpretAnswers`, `labelFrom`, fixed text rules | 3 |
| `coordinator.mjs` | Decisions first, fallback, clarify, `path` on exchanges (4a); writer call + merge (4b) | 4a, 4b |
| `context.mjs`, `instructions.md` | `pinned_route` in the writer input + instruction lines | 4b |
| `cli.mjs` | construct the Decisions provider + meter; notices; spend line in `/status` | 5 |
| `optional/codex/skills/dispatching-codex/` | item-15: key-not-in-sandbox pin; net fixture guard | 6 |

Order: Tasks 1, 3, 6 in parallel (disjoint files) -> Task 2 (needs 1) -> Task 4a (needs 2, 3) -> Task 4b (needs 4a)
-> Task 5 (needs 4b) -> existing Task 14 (e2e + docs) gains the three-path CLI cases.
Reviews: opus `worker-high` on every task; Codex `review` on Tasks 2, 3, 4a, 4b (Decisions) and 6 (Codex wrapper);
the plan itself gets one opus review and one Codex review before Task 1 starts.
Existing tests: where a task changes an exact-shape assertion, it edits that named assertion (listed in the task),
never weakens other tests.

---

### Task 1: config `decisions` block and per-api cost metering

**Files:**
- Modify: `claude/skills/model-coordinator/config.mjs` (DEFAULTS :11-20, `validate` :58-79)
- Modify: `claude/skills/model-coordinator/cost.mjs` (whole file, 63 lines)
- Test: `claude/skills/model-coordinator/tests/config.test.mjs`, `tests/cost.test.mjs` (append)

**Interfaces:**
- Produces: `DEFAULTS.decisions = { enabled: true, model: "gpt-6-luna", timeout_ms: 10000, max_retries: 1,
  min_route_probability: 0.8, min_margin: 0.2, concern_high: 0.8, concern_low: 0.3, needs_text_threshold: 0.5,
  risky_min_probability: 0.9, fallback_min_confidence: 0.8, max_input_chars: 16000, max_message_chars: 6000 }`
  (`max_message_chars` integer 500-12000 and below `max_input_chars`; `decisions.model` must be
  `"gpt-6-luna"`, the only model the Decisions API accepts; validation resets anything else). Add `"decisions"` to
  the section list `loadConfig` normalises (config.mjs ~:99) so a `decisions: null` in the file cannot crash `validate`.
- Produces: `decisionsPriceOf(cfg) -> {input_per_mtok} | null` (reads `cfg.pricing[cfg.decisions.model].decisions_input_per_mtok`,
  a finite number >= 0).
- Produces: `createMeter({cfg, store, now, api = "responses"})`. With `api: "decisions"`: `check(est)` uses
  `worst = est * rate / 1e6` (no output term, no `max_output_tokens` requirement) and throws `SpendBlocked("no
  decisions price ...")` without a price; `record({requestId, attempt, usage, estInputTokens, latencyMs, retries,
  outcome})` writes `{..., api: "decisions", input_tokens, cached_input_tokens: null, output_tokens: null, cost_usd}`
  with cost = `usage.input_tokens * rate / 1e6` ONLY when `Number.isFinite(usage?.input_tokens)`; otherwise the worst
  case and `estimated: true` (do not reuse `usageOf` from openai-provider.mjs: it requires `output_tokens`, which
  Decisions does not return). With `api: "responses"`: behaviour unchanged except every line also carries
  `api: "responses"`. `model` on a decisions line is `cfg.decisions.model`.
- Produces: `meter.state()` unchanged in shape (`{spent_usd, soft, hard, state}`), with `spent_usd` now the COMBINED
  month total (lines without `api` count as responses), and a new `meter.byApi() -> {decisions: number, responses:
  number}`. The spend gate uses the combined total for both apis. (Keeping `state()`'s keys avoids breaking the exact
  -shape assertions at cost.test.mjs:110 and cli.test.mjs:187.)

MUST items:
- M1: `loadConfig` validates `decisions`: `enabled` boolean; `model === "gpt-6-luna"`; the seven probabilities
  (`min_route_probability`, `min_margin`, `concern_high`, `concern_low`, `needs_text_threshold`,
  `risky_min_probability`, `fallback_min_confidence`) finite in [0,1]; `concern_low < concern_high`; `timeout_ms` > 0;
  `max_retries` integer 0-3; `max_input_chars` integer 2000-20000; `max_message_chars` integer 500-12000 and below
  `max_input_chars`; `decisions: null` in the file -> defaults, no
  crash. Each failure resets the field and adds an error string (existing pattern; CLI already refuses to start on
  errors). Test: one case per rule (`config.test.mjs` "D1 ...").
- M2: `decisionsPriceOf` returns null for missing / negative / NaN / string rates. Test "D2".
- M3: decisions meter check/record as above, including worst case on missing usage. Tests "D3a" (exact cost for
  1,000,000 input tokens at 0.10 = 0.10), "D3b" (usage null -> worst case recorded, `estimated: true`), "D3c" (usage
  `{}` or `input_tokens: "12"` -> worst case, never NaN or 0).
- M4: combined gate: responses lines summing $9.99 + a decisions check whose worst case is $0.02 -> `SpendBlocked`;
  decisions lines summing $10 block a responses check too; `byApi()` splits correctly; an old line without `api`
  counts as responses. Tests "D4a", "D4b", "D4c".
- M5: the existing cost and config tests still pass unchanged (responses behaviour unchanged).

- [ ] Step 1: write the D1-D4 tests (fake store = `{readJsonl: () => lines, appendJsonl: (n, o) => lines.push(o)}`).
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/cost.test.mjs claude/skills/model-coordinator/tests/config.test.mjs`; expect the new tests to FAIL.
- [ ] Step 3: implement. Sketch for the meter:
```js
export function decisionsPriceOf(cfg) {
  const r = cfg?.pricing?.[cfg?.decisions?.model]?.decisions_input_per_mtok;
  return typeof r === "number" && Number.isFinite(r) && r >= 0 ? { input_per_mtok: r } : null;
}
const apiOf = (u) => (u.api === "decisions" ? "decisions" : "responses");
// in createMeter({cfg, store, now = Date.now, api = "responses"}):
const dec = api === "decisions";
const p = dec ? decisionsPriceOf(cfg) : priceOf(cfg, cfg.openai.model);
const worst = (est) => (dec ? (est * p.input_per_mtok) / 1e6 : worstCase(p, est, cfg.openai.max_output_tokens));
```
- [ ] Step 4: run the two files, then the full suite; expect PASS.
- [ ] Step 5: commit `feat(model-coordinator): decisions config and per-api cost metering`.

---

### Task 2: `OpenAIDecisionsProvider` and `MockDecisionsProvider`

**Files:**
- Create: `claude/skills/model-coordinator/decisions-provider.mjs`
- Modify: `claude/skills/model-coordinator/openai-provider.mjs` (export `loadKey` :29; no behaviour change)
- Modify: `claude/skills/model-coordinator/provider.mjs` (add `MockDecisionsProvider`)
- Test: `claude/skills/model-coordinator/tests/decisions-provider.test.mjs` (new)

**Interfaces:**
- Consumes: `createMeter({..., api: "decisions"})`, `decisionsPriceOf` (Task 1); `loadKey(cfg, apiKey)`;
  `ProviderError`, `ConfigError` (provider.mjs).
- Produces: `createOpenAIDecisionsProvider({cfg, meter, fetch, sleep, apiKey}) -> { ask(req) }` where
  `req = {input: string, questions: Question[]}` and `Question = {type: "choice"|"predicate", name, instructions,
  choices?: [{value, description}]}`. `ask` resolves `Answers = { byName: { [name]: ChoiceAnswer | PredicateAnswer
  | {type: "refusal"} }, usage }` with `ChoiceAnswer = {type: "choice", choice: string, probs: Map<string, number>}`
  and `PredicateAnswer = {type: "predicate", pTrue: number}`.
- Produces: `class MockDecisionsProvider { constructor(script); calls: req[]; ask(req) }` - `script` like
  `MockCoordinatorProvider` (array of `Answers.byName` objects or functions `req => byName`, or one function); an item
  that is an `Error` is thrown. Returns `{byName, usage: null}`.
- Throws `ProviderError` codes: `timeout`, `network`, `http-<status>`, `bad-response`, `unusable` (shape check failed:
  a question without an answer, a choice not offered, the chosen value missing from `probabilities`, any probability
  not finite or outside [0,1], the probabilities summing above 1.02 (a truncated list summing below 1 is accepted),
  a predicate without a readable true probability). `refusal` is NOT thrown: it is returned as `{type: "refusal"}`.
  Refusal precedence: if ANY asked question has a refusal answer, `ask` returns `byName` with the refusal(s) and skips
  every other shape check (missing or malformed other answers are left out), so interpretation forces a clarify
  instead of an `unusable` fallback that could dispatch.
- Token estimate (both preflight and missing-usage charge): `est = Buffer.byteLength(body) + 1024`. A token is at least
  one byte of UTF-8, so the byte count plus a framing allowance is an upper bound on input tokens (unlike the
  bytes/3 estimate of `openai-provider.mjs:76-77`). Test "P-bound": a token-dense body (non-ASCII) that times out
  is charged at `est` and `est >= bytes`.

Construction refuses (ConfigError) unless: `cfg.provider === "openai"`, `cfg.decisions.enabled === true`,
`cfg.decisions.model === "gpt-6-luna"`, `decisionsPriceOf(cfg)` non-null, a meter is given, the key loads. Request:
`POST https://api.openai.com/v1/decisions`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`,
body `{model: cfg.decisions.model, input: req.input, questions: req.questions}`. Estimate `bytes + 1024` (above); `meter.check(est)`
before EVERY attempt; retries on 429/500/502/503/504/timeout/network up to `cfg.decisions.max_retries`, timeout
`cfg.decisions.timeout_ms`, the same Retry-After handling as `openai-provider.mjs:43-47`; every attempt recorded with
its outcome; the key never appears in an error, a record or a log.

Predicate reading: `pTrue` = the probability whose `value` is `true` or `"true"` (case-insensitive string); if only the
false entry is present, `1 - p(false)`; otherwise unusable.

MUST items:
- M1: request shape and headers exactly as above; no `tools`, no `store` field. Test "P-req" (fake fetch captures).
- M2: answer normalisation into `byName` with `probs` Map and `pTrue`; boolean and string predicate values. Tests
  "P-ok", "P-bool" (Review Focus 3).
- M3: `unusable` for each shape failure listed (one test per failure, "P-unusable-*"); `refusal` returned not thrown;
  a refusal plus a missing or malformed other answer -> returned (not `unusable`). Test "P-refusal-first".
- M4: retries and metering: 429 then 200 -> two usage lines (first `http-429` worst case, then `ok` real),
  `meter.check` called twice; hard limit reached -> `SpendBlocked` before any fetch. Tests "P-retry", "P-hard".
- M5: ConfigError for each missing precondition (one test each, "P-cfg-*"); the error text never contains the key
  (fake key `sk-test-0000`).
- M6: `MockDecisionsProvider` script semantics + `calls`. Test "P-mock".

- [ ] Step 1: write the tests with a fake `fetch(url, init)` returning `{status, headers: {get}, text: async () => body}`.
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/decisions-provider.test.mjs`; FAIL.
- [ ] Step 3: implement (mirror `openai-provider.mjs` attempt loop; record with `meter.record`).
- [ ] Step 4: run the file and the full suite; PASS (write-surface tests must still pass with the new module).
- [ ] Step 5: commit `feat(model-coordinator): OpenAI Decisions provider and mock`.

---

### Task 3: `decisions.mjs` - request builder and answer interpretation (pure)

**Files:**
- Create: `claude/skills/model-coordinator/decisions.mjs`
- Test: `claude/skills/model-coordinator/tests/decisions.test.mjs` (new)

**Interfaces:**
- Consumes: `toSummary` (workers.mjs:89), `FINISHED`, `MESSAGEABLE`, `validateDecision` (validate.mjs), `LABEL_RE`,
  `LIMITS`, `emptyDecision` (schema.mjs), `pronounOf` (resolve.mjs:174). Nothing with I/O.
- Produces:
  - `buildDecisionsRequest({workers, focusedId, referents, exchanges, lastEvent, message, codexEligible, cfg}) ->
    {input: string, questions: Question[], offered: {route: string[], provider: string[], concerns: {[questionName:
    string]: workerId}}}`
  - `interpretAnswers(byName, {offered, workers, focusedId, referents, message, cfg}) -> Result` with
    `Result = {kind: "plan", decision: CoordinatorDecision, writer: null | "reply" | "brief", meta: {p1, margin, winner}}
    | {kind: "clarify", text: string, meta} | {kind: "advice", text: string, meta} | {kind: "unusable", reason: string}`.
    `workers` here is the FRESH view read after the Decisions call (Task 4a), which may differ from the one the
    request was built from.
  - `labelFrom(message, taken: Set<string>) -> string` (passes `LABEL_RE`, unique against `taken`)
  - `takenNames(workers) -> Set<string>`: ids, labels and aliases of every non-finished worker (the same set
    validate.mjs ~:35 checks a new label against).
  - `RISKY_RE`, `TEXT_RE`, `EPS = 1e-9` (exported constants, for tests)

Tests in this task use a local cfg literal `{decisions: {...the Task 1 defaults...}}`, not `DEFAULTS` (Task 1 runs in
parallel). The advice text is local (coordinator.mjs `adviceFor` is not exported): "<id> is <status>. Start a new
one with /new claude|codex <label> <objective>." (finished) / "<id> is <status>. Use /restart-closed to reopen closed
sessions, or start a new one with /new." (dead).

Request builder:
- Live = workers with `MESSAGEABLE` status. Concern set = at most 8 live workers INCLUDING the focused one (if live):
  the focused worker first, then `referents.recent` order, then the rest by `created_at` descending (workers carry
  only `created_at`/`finished_at`, workers.mjs:26-31). An H of at most 8 keeps `message_multiple` within
  `LIMITS.targets` (8).
- `input` (a string, every field through one `clean()` that replaces C0/C1/bidi controls with a space). The MESSAGE
  IS NEVER CUT: routing must see everything that will be dispatched. If the message is longer than
  `cfg.decisions.max_message_chars`, the builder returns `{tooLong: true}` and Task 4a replies, without any model
  call: `That message is too long to route automatically. Use /to <id> <text> or /new claude|codex <label>
  <objective>.` Otherwise the other sections shrink until the input fits `cfg.decisions.max_input_chars` (exchanges
  6 -> 2 -> 0, then worker fields to id/label/status, then `Last event` dropped); if it still does not fit,
  `{tooLong: true}` as well. Test "B-long" (a 6001-char message -> tooLong; a 5999-char message is included whole).
  ```
  Message: <the WHOLE message (cleaned); never cut>
  Focused worker: <id or none>
  Referents: singular=<id|none> other=<id|none> both=<a,b|none> recent=<id,id,...|none>
  Recent turns (oldest first):
  - user: <200> | reply: <200> | action: <action> -> <targets>
  Last event: <the newest notice text, capped 150> | none
  Workers:
  - <id> [<provider>, <status>] label=<label> aliases=<a|b> objective=<200> task=<200> last=<150>
  ```
  last 6 exchanges. `lastEvent` is a string or null: Task 4a passes the last entry of `pendingNotices` (formatted
  notice strings, coordinator.mjs:68) read BEFORE the turn empties them, else null.
- Questions:
  - `route` choice, instructions: "Pick where the user's message should go. A worker id means the message is for that
    worker. new_session: the user wants a new worker started. status: the user asks how workers are doing. respond:
    the user wants an answer, explanation, summary or discussion from the coordinator itself. clarify: you cannot tell."
    Choices: one per live worker `{value: id, description: "<provider>, <status>; <label>; aliases <..>; goal <..>;
    now <..>; last <..>"}` capped at 300 chars, then `new_session`, `status`, `respond`, `clarify` with one-line
    descriptions.
  - `provider` choice, instructions "If a new worker is started, which kind fits: claude (default, any coding work) or
    codex (only when the user asks for Codex or the task suits it)". Choices `claude`, plus `codex` only when
    `codexEligible`.
  - `concerns_<id>` predicate per concern-set worker (id sanitised to `[a-z0-9_]`; `offered.concerns` maps the
    question name to the worker id), instructions "The user's message is meant for worker <id> (<label>)."
  - `needs_text` predicate, instructions "Starting the new worker needs a written brief because the goal is vague,
    long, or asks for a plan or explanation."
  - `provider` and `needs_text` are always asked in V1 (a new worker is always possible; their cost is input tokens
    only). Recorded deviation from spec section 4 ("asked only when a new worker is possible").

Interpretation (first matching rule wins; `c = cfg.decisions`):
```js
// 1. any refusal (checked FIRST, before any shape check) -> clarify (code text)
// 0. shape: every offered question must have an answer, else {kind:"unusable"} (the provider already checks; keep it pure-safe)
// ge(a, b) = a >= b - EPS   (float safety: 0.85 - 0.65 must count as a 0.2 margin)
// top2(answer) = {p1: probs.get(choice), p2: max(highest other reported prob, 1 - sum(all reported probs))}
//    (unreported probability mass counts as a possible runner-up: a truncated list can never inflate the margin)
// winner = byName.route.choice; isWorker = winner is a worker id in offered.route; pron = pronounOf(message)
// 2. referent contradictions, before ANY message route (single or multiple):
//    a. pron === "other" && (winner === focusedId || (!focusedId && winner === referents.singular)) -> clarify
//    b. pron === "other" && focusedId && H.includes(focusedId) -> clarify   (H as in rule 3)
//    c. (pron === "singular" || pron === "other") && H.length >= 2 -> clarify naming H
// 3. H = concern worker ids with ge(pTrue, c.concern_high); U = concern ids with pTrue > c.concern_low && !ge(pTrue, c.concern_high)
//    if (U.length && (isWorker || winner === "status")) -> clarify naming U + H (max 3)
//    if (H.length >= 2) {
//      if (RISKY_RE.test(message) && H.some((id) => !ge(pTrue(id), c.risky_min_probability))) -> clarify (risky text)
//      if (H.includes(winner)) -> message_multiple to H (each must be MESSAGEABLE in the fresh view, else advice for it)
//      else if (winner === "status") -> request_status for H; else -> clarify naming H }
// 4. {p1, p2} = top2(byName.route); margin = p1 - p2
//    if (!ge(p1, c.min_route_probability) || !ge(margin, c.min_margin)) -> clarify naming the top two
// 5. if isWorker:
//    a. the winner has NO concern answer (outside the concern set) -> clarify  (no consistency evidence)
//    b. H.length === 1 && !H.includes(winner) -> clarify naming winner and H[0]   (predicates point elsewhere)
//    c. !ge(pTrue(winner), c.concern_high) -> clarify
//    d. winner not MESSAGEABLE in the fresh view -> advice (finished/dead text above); winner missing from the
//       fresh view -> advice "<id> is no longer listed. Use /workers to see the current workers."
// 6. if RISKY_RE.test(message) && !ge(p1, c.risky_min_probability) -> clarify ("That looks destructive. Which worker, exactly? Use /to <id> <text>.")
// 7. new_session: provider = byName.provider winner ONLY when top2(byName.provider) passes the p1/margin rule;
//    otherwise -> clarify "Should the new worker be Claude or Codex? Use /new claude|codex <label> <objective>."
//    (no silent default; Codex being unavailable later is still the dispatcher's fallback policy);
//    writer = (message.length > 400 || TEXT_RE.test(message) || ge(needs_text.pTrue, c.needs_text_threshold)) ? "brief" : null;
//    new_session {needed: true, provider, label: labelFrom(message, takenNames(workers)), objective: message.slice(0, 1000)}
//      (the code-built fields are always filled; with writer "brief" Task 4b may replace label/objective/instruction)
//    status -> request_status, targets H (or [] = all); respond -> action respond, reply "", writer "reply"; clarify -> clarify
//    worker -> message_session [winner], worker_instruction = message (verbatim; Task 4a dispatches with verbatim: true
//    so a message over 4000 characters is not refused as too-long)
```
`RISKY_RE = /\b(delete|drop|reset|wipe|erase|purge|destroy|force[- ]push|rm\s+-rf|revert all|truncate)\b/i`.
`TEXT_RE = /\b(plan|explain|design|investigate|research|compare|propose|figure out|evaluate)\b/i`.
`labelFrom`: lowercase, words of `[a-z0-9]`, drop stop words (a, an, the, to, for, and, of, make, new, worker, please,
start, create), first 3 words joined by `-`, cut to 32 and a trailing `-` trimmed; base = that, or `worker` when
empty or failing `LABEL_RE`. Candidate n=1 is
`base`, n>=2 is `<base cut to 32 - len("-n"), trailing "-" trimmed>-n`; each candidate is re-checked against
`LABEL_RE` and `taken`; first that passes wins.
Clarify texts (code only, each under `LIMITS.clarification` 500):
- two or more workers: `Which worker do you mean: <id> (<label>) or <id> (<label>)? Use /to <id> <text> to be exact.`
- a worker vs a non-worker choice, or two non-worker choices: `Did you mean <phrase> or <phrase>? Use /to <id> <text>,
  /new claude|codex <label> <objective>, or /status to be exact.` with phrases `send it to <id> (<label>)`, `start a
  new worker`, `a status update`, `an answer from me`.
- no candidates: `I could not tell where that should go. Workers: <id (status), ...>. Use /to <id> <text> or /new.`
Every `decision` passes `validateForDispatch(decision, {workers, verbatim})` (coordinator.mjs:22; the TEST imports it,
`decisions.mjs` does not) with `verbatim = true` for `message_session` / `message_multiple` (the full user text may
exceed the 4000-character model cap; every other check still applies) and `false` for every other action, where it
equals `validateDecision` - assert it in the tests (it enforces the action-specific rules: no instruction/new_session
on respond, label uniqueness, targets messageable).

MUST items:
- M1: builder output: input format, control-character cleaning, cap at `max_input_chars`; choices from the live
  registry only (finished/dead excluded); codex offered only when eligible; concern set max 8 incl. focus. Tests
  "B-input", "B-ctrl", "B-cap", "B-choices", "B-codex", "B-nine" (9 live workers, focused is the oldest -> it is in).
- M2: every interpretation rule with a passing and a failing case at the boundaries: p1 0.80/margin 0.20 accept
  (including the float case p1 0.85, p2 0.65); 0.79 or 0.19 clarify; concern 0.80 is H, 0.30 is neither, 0.31 is U.
  Tests "I-*" (one per rule), including "I-dead" (winner finished in the fresh view -> advice; Review Focus 1),
  "I-nine" (9 live workers; winner outside the concern set while H = [another] -> clarify), "I-H-elsewhere" (rule 4a
  with 3 workers), "I-other" (focus contradiction; and without a focus via `referents.singular`), "I-risky",
  "I-risky-multi" ("wipe the db on both of them", H of two at 0.85 -> clarify), "I-clarify-text" (worker vs
  new_session top two -> the "Did you mean" text), "I-long" (a 5000-char message to a worker -> message_session with
  the full text; the verbatim flag is Task 4a's), and the Codex plan review cases: "I-outside-H-empty" (9 workers,
  the outside-set winner at 0.95, every concern low -> clarify), "I-other-multi" (focused auth-01, "tell the other one
  to check it too", concerns auth-01 0.95 and ui-02 0.95 -> clarify), "I-provider-unsure" (new_session 0.95, provider
  codex 0.55 / claude 0.45 -> clarify, not Claude), "I-truncated" (route list reports only winner 0.55 and one other
  0.10 with min_route_probability 0.5 / min_margin 0.3 -> p2 = 0.35, clarify), "I-refusal-first" (a refusal plus a
  missing answer -> clarify, not unusable).
- M3: the three spec paths at this level: "tell the other one to check it too" with referents.other = ui-02 and
  answers route ui-02 0.9 -> message_session [ui-02] verbatim, writer null; the auth-architecture new-worker line ->
  create_session, writer "brief"; "start a worker to fix the login typo" (needs_text 0.1) -> create_session with
  label `fix-login-typo`, writer null.
- M4: `labelFrom` cases incl. control/bidi/emoji-only input -> `worker` / `worker-2` (Review Focus 5, test "L-ctrl");
  a 3-word base of 32 chars already taken -> a suffixed label of at most 32 chars passing `LABEL_RE` ("L-long");
  a base equal to a live worker's id or alias -> suffixed ("L-taken").
- M5: no I/O: the module imports only the listed pure modules (a test reads the import lines).

- [ ] Step 1: write the B-, I-, L- tests as tables (`for (const [name, answers, expect] of cases) test(name, ...)`).
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/decisions.test.mjs`; FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run the file and the full suite; PASS.
- [ ] Step 5: commit `feat(model-coordinator): decisions request builder and interpretation`.

---

### Task 4a: coordinator integration - Decisions first, clarify, fallback, path

**Files:**
- Modify: `claude/skills/model-coordinator/coordinator.mjs` (`createCoordinator` :64, `turn` :108-159, `viaModel` :162-190)
- Test: `claude/skills/model-coordinator/tests/coordinator-decisions.test.mjs` (new); edit the exact-shape exchange
  assertion at `tests/coordinator.test.mjs` ~:285 to allow the new `path` field (no other existing test changes)

**Interfaces:**
- Consumes: `buildDecisionsRequest`, `interpretAnswers` (Task 3); `decisions.ask` (Task 2, or `MockDecisionsProvider`);
  `provider.decide` (Luna, fallback router only in this task); `validateForDispatch`, `dispatcher.peek/dispatch`
  (unchanged).
- Produces: `createCoordinator({..., decisions = null})`. Exchanges ledger lines gain `path: "shortcut" | "decisions" |
  "luna-fallback" | "luna" | "shortcuts-only" | "command" | "error"` and, on Decisions turns, `route_p1`,
  `route_margin` (rounded to 3 decimals). `out.path` is returned too. (`coordinator_records.md` is unchanged:
  exchanges are not part of it - spec section 8 "records" means this ledger.)
- Produces for 4b: `viaDecisions` calls `writeWith(res, ctx)` for a plan with `writer !== null`; in 4a `writeWith` is a
  stub that uses the code-built fields for "brief" (dispatch) and replies `Luna is unavailable (not wired). <SHORTCUTS>`
  for "reply" - Task 4b replaces it.

Turn flow (replace the `else` branch at :143-145; `cost` read once per turn):
```js
} else if (cost?.state === "hard") {
  out.reply = `${costNotices(cost)[0]} No model call was made. ${SHORTCUTS}`; path = "shortcuts-only";
} else if (decisions) {
  out.reply = await viaDecisions(line, r, workers, focusedId, exchanges, run, setDecision, setMeta); // sets path
} else {
  out.reply = await viaModel(line, r, workers, focusedId, exchanges, run, setDecision); path = "luna";
}
```
`viaDecisions`:
0. Turn idempotency (before any model call): if the exchanges ledger already has a line with this `turn_id`, reply
   with its stored reply and make no Decisions, Luna or dispatch call (a replayed turn can regenerate a different
   decision - for example a suffixed label because the first worker now holds the original one - and the
   dispatcher's request id hashes the decision, dispatcher.mjs:34-36, so only a turn-level guard makes one dispatch
   per turn hold). Applies to every model path (Decisions, Luna fallback, Luna). Known residual: a crash between
   `dispatch` and the exchange append; the dispatcher's request-id idempotency covers a replay with the same
   decision, and the residual is documented in a code comment.
1. `req = buildDecisionsRequest({..., lastEvent, codexEligible: codexEligible(safe(codexState)), cfg})` where
   `codexEligible(cs) = cs?.available === true && cs.usage_status === "ok" && cs.capacity_available === true`
   (`available` is only the login result, codex-resources.mjs:113-124; quota and capacity are separate fields of
   `resourceState`, :146-155). A full or quota-blocked Codex is not offered; the user can still ask for it with
   `/new codex ...`. `{tooLong: true}` -> the too-long reply, no model call.
2. `try { ans = await decisions.ask(req) } catch (e)`: `ProviderError` code `hard-limit` -> shortcuts-only reply
   (path `shortcuts-only`), no Luna call; any other `ProviderError` -> `viaModel(..., {minConfidence:
   Math.max(cfg.min_confidence, cfg.decisions.fallback_min_confidence)})`, path `luna-fallback`; a non-ProviderError
   rethrows.
3. `fresh = await workersView()` (a worker may have finished during the call); `res = interpretAnswers(ans.byName,
   {..., workers: fresh})`: `unusable` -> fallback as in 2; `clarify` / `advice` -> reply `res.text`,
   `setDecision(emptyDecision({action: "clarify", clarification: res.text.slice(0, 500)}))`; `plan` with
   `writer === null` -> `run(res.decision, {verbatim: res.decision.action === "message_session" ||
   res.decision.action === "message_multiple"})` validated against `fresh`; `plan` with a writer -> `writeWith`.
4. Path `decisions`; `meta.p1`/`meta.margin` into the exchange line.
`viaModel` gains an optional `{minConfidence}` parameter replacing `cfg.min_confidence` in `lowConfidence`. `run`
takes a workers list (default: the turn's snapshot) and uses that SAME list for `validateForDispatch` and for
`dispatcher.dispatch(d, {workers, ...})` (coordinator.mjs:124), so the dispatcher's FINISHED checks see the fresh view.

MUST items (each a test in `coordinator-decisions.test.mjs`, using `MockDecisionsProvider`, `MockCoordinatorProvider`
and a dispatcher that counts `dispatch` calls; M7 uses the real `createDispatcher` with `fakeCodexAdapter` /
`fakeClaudeAdapter` from `tests/mc-helpers.mjs`):
- M1 two of the three spec paths: "send this to auth-03" (single named worker -> `resolveLine` shortcut) -> 0 Decisions
  calls, 0 Luna calls, path `shortcut`; "tell the other one to check it too" -> 1 Decisions call, 0 Luna, dispatched
  to the right worker verbatim, path `decisions`. Tests "C-path-shortcut", "C-path-decisions". (The writer path is 4b.)
- M2 coreference at turn level: focused worker + "continue with it"; alias; "the other one" with and without a focus;
  "both of them" -> message_multiple. Tests "C-coref-*".
- M3 clarify paths: close probabilities, uncertain concern, refusal, risky -> no dispatch, code text reply.
  "C-clarify-*".
- M4 outages: Decisions `timeout`, `http-429`, `bad-response`, `unusable` -> Luna routing with the stricter bar (a Luna
  decision at confidence 0.7 now clarifies; at 0.85 dispatches), path `luna-fallback`; Luna also failing ->
  shortcuts-only text; Decisions `hard-limit` -> shortcuts-only without a Luna call; Decisions spend pushing the
  combined total to the hard limit -> the NEXT turn makes neither call (cost state hard). "C-outage-*", "C-spend".
- M5 no double dispatch: (a) the same `turnId` handled twice -> one dispatch and ONE Decisions call, also when the
  second run's scripted answers, writer text or the auto-suffixed label would differ ("C-replay-same",
  "C-replay-changed", "C-replay-label"); (b) "C-timeout-once": the REAL Decisions provider over a fake fetch that
  times out on every attempt, then Luna routes -> exactly one dispatch, decisions usage lines with outcome `timeout`
  and one responses line (Review Focus 4).
- M6 long message: a 5000-char message routed by Decisions to a worker is dispatched whole (verbatim) and the
  Decisions input carried it whole ("C-long"); a message over `max_message_chars` -> the too-long reply, no model
  call ("C-too-long"). Codex eligibility: exhausted quota, unknown quota and full capacity -> `codex` not offered
  ("C-codex-eligible").
- M7 Codex unavailable after selection: Decisions picks `new_session` + codex while eligible; the real dispatcher's
  codex gate (fake adapter) says unavailable -> the existing fallback reply (Claude or refuse per config), other
  workers untouched. "C-codex-late".
- M8 dead winner: the fresh view (second `workersView()` call) shows the winner finished -> advice reply, no dispatch
  ("C-dead"; the test's workersView returns a different list on its second call); `decisions = null` -> today's
  behaviour (all existing coordinator tests unchanged except the one named exchange assertion, plus "C-off").
- M9 exchanges carry `path` (+ `route_p1`, `route_margin` on Decisions turns); a hard-limit turn records
  `shortcuts-only`. "C-ledger".

- [ ] Step 1: write the tests.
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/coordinator-decisions.test.mjs`; FAIL.
- [ ] Step 3: implement `viaDecisions`, the fallback and the `path` field.
- [ ] Step 4: run the file, `tests/coordinator.test.mjs`, then the full suite; PASS.
- [ ] Step 5: commit `feat(model-coordinator): Decisions-first routing with Luna fallback`.

---

### Task 4b: pinned Luna writer and merge

**Files:**
- Modify: `claude/skills/model-coordinator/coordinator.mjs` (replace the 4a `writeWith` stub)
- Modify: `claude/skills/model-coordinator/context.mjs` (`buildInput` :92 gains `pinnedRoute`)
- Modify: `claude/skills/model-coordinator/instructions.md` (the text `instructionsText()` reads, context.mjs ~:24)
- Test: `claude/skills/model-coordinator/tests/coordinator-decisions.test.mjs` (append), `tests/context.test.mjs` (append)

**Interfaces:**
- Consumes: 4a's `writeWith(res, ctx)` hook; `buildInput`; `provider.decide`; `validateDecision`; Task 3 code-built
  fields already in `res.decision`.
- Produces: `buildInput({..., pinnedRoute})` adds `pinned_route: {action, target_session_ids, provider, write:
  "reply" | "brief"}`; `instructions.md` gains: "If pinned_route is present, the route is already decided: copy its
  action and targets, and write only reply (write=reply) or new_session.label, new_session.objective and
  worker_instruction (write=brief). Never change the route."

`writeWith(res, ctx)`:
1. `try { input = buildInput({..., pinnedRoute}); w = await provider.decide(input) } catch (e)`: a `ProviderError`
   or `e.message === "context-over-budget"` -> writer "brief": dispatch `res.decision` with its code-built fields;
   writer "reply": reply `Luna is unavailable (<code or "context-over-budget">). <SHORTCUTS>`. Anything else rethrows.
2. Merge by action - only these fields, everything else from `res.decision`:
   - `respond`: `reply` only.
   - `create_session`: `new_session.label`, `new_session.objective`, `worker_instruction` (each only when a string);
     `new_session.needed` and `new_session.provider` stay from `res.decision`.
3. `validateDecision(final, {workers: fresh})`; invalid -> one re-ask with the error codes (same pinned input plus
   `validationErrors`), merged the same way. The re-ask (its `buildInput` and `decide`) is inside the SAME catch as
   step 1: a `ProviderError` or `context-over-budget` there takes the step-1 failure path. Still invalid -> "brief":
   the code-built `res.decision`; "reply": a code clarify `I could not write an answer. <SHORTCUTS>`.
4. Dispatch via `run(final)` (`respond` replies with `final.reply` as `run` already does).

MUST items:
- M1 the third spec path: the auth-architecture new-worker line -> 1 Decisions + 1 Luna call, `create_session`
  dispatched with the writer's label/objective/instruction and the Decisions provider. "C-path-writer".
- M2 pinning: a writer answer with a different action, targets, provider and `new_session.needed` -> the dispatched
  decision keeps the route (asserted on the dispatcher's received decision). "C-pin".
- M3 respond: a writer answer for `respond` that also carries `worker_instruction` and `new_session` fields -> only
  `reply` is used, the decision validates, the reply is shown. "C-respond".
- M4 writer failures: `ProviderError`, `context-over-budget` (a writer input over budget), two invalid answers, and a
  first invalid answer whose re-ask throws `ProviderError` -> brief falls back to the code-built create (dispatched
  once, an exchange line written), reply gives the code text. "C-writer-fail-*".
- M5 `buildInput` with `pinnedRoute` includes `pinned_route`; without it the input is unchanged (existing context
  tests pass). "X-pinned".

- [ ] Step 1: write the tests.
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/coordinator-decisions.test.mjs claude/skills/model-coordinator/tests/context.test.mjs`; FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run both files and the full suite; PASS.
- [ ] Step 5: commit `feat(model-coordinator): route-pinned Luna writer`.

---

### Task 5: CLI wiring, notices and spend in `/status`

**Files:**
- Modify: `claude/skills/model-coordinator/cli.mjs` (provider block :149-160, `createCoordinator` call :185-187)
- Modify: `claude/skills/model-coordinator/coordinator.mjs` (`costNotices` :72-77 wording "Coordinator spend"; the
  `request_status` reply gains one spend line)
- Test: `claude/skills/model-coordinator/tests/cli.test.mjs` (append), `tests/coordinator.test.mjs` (append)

**Interfaces:**
- Consumes: `createOpenAIDecisionsProvider`, `createMeter({api: "decisions"})`, `meter.state()` (combined),
  `meter.byApi()`.
- Produces: when `cfg.provider === "openai"`: a responses meter (as today) and a decisions meter on the same store;
  `decisions = createOpenAIDecisionsProvider({cfg, meter: decMeter, apiKey, fetch: deps.fetch})` inside try; a
  `ConfigError` adds the note "Decisions routing not started: <msg>. Luna routes every message." and leaves
  `decisions = null`. The Luna and Decisions providers are constructed independently: either can run without the
  other (Luna off + Decisions on routes by Decisions; a writer turn then gets the Luna-unavailable fallback of 4b).
  Both read the key before the credential variables are removed from `process.env` (existing K7 order). `costState`
  returns the combined state; the `/status` spend line reads `byApi()`.

MUST items:
- M1: with a price table that has `decisions_input_per_mtok`, the coordinator gets a Decisions provider (spy via
  `deps`); without it, the note is shown and routing falls back to Luna. With a Decisions price but no Luna price,
  Decisions runs and Luna does not (both notes correct). Tests "K-dec-on", "K-dec-off", "K-dec-only".
- M2: after startup no credential variable is in `process.env` and both providers hold the key (extend the K7 test).
- M3: `/status` (and a Decisions `status` route) shows `Spend this month: $X (Decisions $a, Luna $b) of $7 soft / $10
  hard.`; cost notices say "Coordinator spend" and name the combined total. Tests "K-status-spend", "K-notice".
- M4: `decisions.enabled: false` -> no Decisions provider, no note, Luna routes. Test "K-dec-disabled".

- [ ] Step 1: tests; Step 2: run `timeout 600 node --test claude/skills/model-coordinator/tests/cli.test.mjs claude/skills/model-coordinator/tests/coordinator.test.mjs`, FAIL; Step 3: implement; Step 4: full suite PASS;
- [ ] Step 5: commit `feat(model-coordinator): wire Decisions provider, combined spend status`.

---

### Task 6: Codex wrapper items (request item 15)

**Files:**
- Modify: `optional/codex/skills/dispatching-codex/lib/readcheck.mjs` (:254-262 net fixture; `sandboxGroupCheck({run})`
  :272 is already injectable)
- Modify: `optional/codex/skills/dispatching-codex/lib/argv.mjs` (`execArgs`)
- Test: `optional/codex/skills/dispatching-codex/tests/argv.test.mjs` (EDIT the exact-array expectations at ~:15-16
  and ~:125 to include the new argument), `tests/readcheck*.test.mjs` / `tests/run.test.mjs` (append)

**Interfaces:** none consumed from Tasks 1-5. Independent.

MUST items:
- M1 (e10c8a7 re-review M5): pin that `CODEX_API_KEY` (any case) never reaches a SANDBOXED command. Today the key goes
  to the `codex exec` spawn env (`codex-run.mjs:79-82`) and is kept from tool commands only by Codex's default
  `shell_environment_policy` excludes. Make that explicit: `execArgs` passes the exclusion to `codex exec` (for example
  `-c shell_environment_policy.exclude=["CODEX_API_KEY"]` merged with the defaults, or the equivalent key the
  installed Codex documents; verify with `codex exec --help` / `codex --version` and the Codex config docs, do not
  guess; if the installed Codex has no such key, stop and report instead of inventing one). Test: the argv carries
  it. Host-side checks (`hostCheck`, codex-run.mjs ~:71, ~:589) keep the full env BY DESIGN (they run on the host,
  not in the sandbox): leave them unchanged and say so in a code comment next to the exclusion.
- M2 (re-review M7): `CODEX_RUN_NET_FIXTURE` must not act in production. Honour the variable only when
  `NODE_TEST_CONTEXT` is also set (node --test sets it in test processes); check that `mergeEnv` (run.test.mjs ~:156)
  passes `NODE_TEST_CONTEXT` to the spawned CLI so the I2 tests (run.test.mjs ~:905-935) still pass. Pure injection
  is not enough: those tests spawn the CLI and pass the fixture by env. Add a comment in run.test.mjs that the I2
  tests must run under `node --test` (a plain `node tests/run.test.mjs` has no `NODE_TEST_CONTEXT` and would use the
  real runner). Test: with the variable set and no
  `NODE_TEST_CONTEXT`, the real runner is chosen (assert via the injectable runner, never by running `net.exe`).

- [ ] Step 1: tests; Step 2: run `timeout 900 node --test "optional/codex/skills/dispatching-codex/tests/*.test.mjs"`
  (known flakes: `locks.test.mjs:408` EPERM rename; quarantine cases while real Codex sandbox processes run - rerun
  once before trusting a failure), FAIL on the new tests; Step 3: implement; Step 4: PASS;
- [ ] Step 5: commit `fix(dispatching-codex): pin CODEX_API_KEY exclusion, guard net fixture`.

---

### After Task 5: existing Task 14 additions
Task 14 (e2e + docs, `docs/plans/2026-10-07-luna-coordinator.md` Task 14) adds CLI-level cases on the mock providers:
the three spec paths end to end (stdin lines in, replies out, dispatcher effects in the sandbox), a Decisions outage
falling back to Luna, and the docs section "How messages are routed" (shortcuts -> Decisions -> Luna writer ->
dispatcher; config keys; rollback with `decisions.enabled: false`; cost ledger `api` field).

## Spec coverage check
Spec 3 flow -> Task 4a. Spec 4 questions -> Task 3 builder. Spec 5 rules/config -> Tasks 1 (config), 3 (rules).
Spec 6 text rules + pinning -> Tasks 3 (writer choice, labels), 4b (writer call + merge). Spec 7 failure -> Tasks 2
(error codes), 4a (fallback, idempotency), 4b (writer failures). Spec 8 cost/records/permissions -> Tasks 1, 4a
(path), 5 (status), write-surface scan (every task's full-suite run). Spec 9 tests -> Tasks 3, 4a, 4b, 14. Item 15
-> Task 6.
Recorded deviations from the spec (tell the user): (1) the per-turn `path` and probabilities go to the exchanges
ledger, not `coordinator_records.md` (that file renders workers, focus and notes only, `records.mjs:48`); (2)
`provider` and `needs_text` are asked on every Decisions call; (3) a Decisions-routed send to an existing worker is
dispatched verbatim (no 4000-character model cap), like `/to`; (4) `decisions.model` is its own config key pinned to
`gpt-6-luna`.
