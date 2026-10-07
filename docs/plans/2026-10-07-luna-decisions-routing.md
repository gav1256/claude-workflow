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
2. More than 8 live workers: the concern predicates cover the 8 most recent plus the focused one, and a route to a
   worker outside that set still needs its concern answer to be absent-safe (Task 3 test I-nine).
3. Predicate probabilities arrive as `true`/`false` booleans or as `"true"`/`"false"` strings (the beta docs show
   strings in one place): both read the same, anything else is unusable (Task 2 test P-bool).
4. A Decisions timeout after the request reached OpenAI, then Luna routes: one dispatch, both calls metered (Task 4
   test C-timeout-once).
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
| `context.mjs` | `pinned_route` in the writer input + instruction lines | 4 |
| `coordinator.mjs` | Decisions first, writer call, fallback, `path` on exchanges | 4 |
| `cli.mjs` | construct the Decisions provider + meter; notices; spend line in `/status` | 5 |
| `optional/codex/skills/dispatching-codex/` | item-15: key-not-in-sandbox test; net fixture guard | 6 |

Order: Tasks 1, 3, 6 in parallel (disjoint files) -> Task 2 (needs 1) -> Task 4 (needs 2, 3) -> Task 5 (needs 4) ->
existing Task 14 (e2e + docs) gains the three-path CLI cases.
Reviews: opus `worker-high` on every task; Codex `review` on Tasks 2, 3, 4 (Decisions) and 6 (Codex wrapper); the
plan itself gets one opus review and one Codex review before Task 1 starts.

---

### Task 1: config `decisions` block and per-api cost metering

**Files:**
- Modify: `claude/skills/model-coordinator/config.mjs` (DEFAULTS :11-20, `validate` :58-79)
- Modify: `claude/skills/model-coordinator/cost.mjs` (whole file, 63 lines)
- Test: `claude/skills/model-coordinator/tests/config.test.mjs`, `tests/cost.test.mjs` (append)

**Interfaces:**
- Produces: `DEFAULTS.decisions = { enabled: true, timeout_ms: 10000, max_retries: 1, min_route_probability: 0.8,
  min_margin: 0.2, concern_high: 0.8, concern_low: 0.3, needs_text_threshold: 0.5, risky_min_probability: 0.9,
  fallback_min_confidence: 0.8, max_input_chars: 8000 }`.
- Produces: `decisionsPriceOf(cfg) -> {input_per_mtok} | null` (reads `cfg.pricing[cfg.openai.model].decisions_input_per_mtok`,
  a finite number >= 0).
- Produces: `createMeter({cfg, store, now, api = "responses"})`. With `api: "decisions"`: `check(est)` uses
  `worst = est * rate / 1e6` (no output term, no `max_output_tokens` requirement) and throws `SpendBlocked("no
  decisions price ...")` without a price; `record({requestId, attempt, usage, estInputTokens, latencyMs, retries,
  outcome})` writes `{..., api: "decisions", input_tokens, cached_input_tokens: null, output_tokens: null, cost_usd}`
  with cost = `usage.input_tokens * rate / 1e6`, worst case when usage is missing. With `api: "responses"`: behaviour
  unchanged except every line also carries `api: "responses"`.
- Produces: `meter.state()` -> `{spent_usd, soft, hard, state, by_api: {decisions, responses}}`; `spent_usd` is the
  combined month total (lines without `api` count as responses); the spend gate uses the combined total for both apis.

MUST items:
- M1: `loadConfig` validates `decisions`: `enabled` boolean; the six probabilities finite in [0,1];
  `concern_low < concern_high`; `timeout_ms` > 0; `max_retries` integer 0-3; `max_input_chars` integer 2000-20000.
  Each failure resets the field and adds an error string (existing pattern; CLI already refuses to start on errors).
  Test: one case per rule (`config.test.mjs` "D1 ...").
- M2: `decisionsPriceOf` returns null for missing / negative / NaN / string rates. Test "D2".
- M3: decisions meter check/record as above, including worst case on missing usage. Tests "D3a" (exact cost for
  1,000,000 input tokens at 0.10 = 0.10), "D3b" (usage null -> worst case recorded, `estimated: true`).
- M4: combined gate: responses lines summing $9.99 + a decisions check whose worst case is $0.02 -> `SpendBlocked`;
  `state().by_api` splits correctly; an old line without `api` counts as responses. Tests "D4a", "D4b".
- M5: the existing cost and config tests still pass unchanged (responses behaviour unchanged).

- [ ] Step 1: write the D1-D4 tests (fake store = `{readJsonl: () => lines, appendJsonl: (n, o) => lines.push(o)}`).
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/cost.test.mjs claude/skills/model-coordinator/tests/config.test.mjs`; expect the new tests to FAIL.
- [ ] Step 3: implement. Sketch for the meter:
```js
export function decisionsPriceOf(cfg) {
  const r = cfg?.pricing?.[cfg?.openai?.model]?.decisions_input_per_mtok;
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
  a question without an answer, a choice not offered, probabilities missing/not finite/not summing to 0.98-1.02, a
  predicate without a readable true probability). `refusal` is NOT thrown: it is returned as `{type: "refusal"}`.

Construction refuses (ConfigError) unless: `cfg.provider === "openai"`, `cfg.decisions.enabled === true`,
`cfg.openai.model` is a string, `decisionsPriceOf(cfg)` non-null, a meter is given, the key loads. Request: `POST
https://api.openai.com/v1/decisions`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`, body
`{model: cfg.openai.model, input: req.input, questions: req.questions}`. Estimate `ceil(bytes/3)`; `meter.check(est)`
before EVERY attempt; retries on 429/500/502/503/504/timeout/network up to `cfg.decisions.max_retries`, timeout
`cfg.decisions.timeout_ms`, the same Retry-After handling as `openai-provider.mjs:43-47`; every attempt recorded with
its outcome; the key never appears in an error, a record or a log.

Predicate reading: `pTrue` = the probability whose `value` is `true` or `"true"` (case-insensitive string); if only the
false entry is present, `1 - p(false)`; otherwise unusable.

MUST items:
- M1: request shape and headers exactly as above; no `tools`, no `store` field. Test "P-req" (fake fetch captures).
- M2: answer normalisation into `byName` with `probs` Map and `pTrue`; boolean and string predicate values. Tests
  "P-ok", "P-bool" (Review Focus 3).
- M3: `unusable` for each shape failure listed (one test per failure, "P-unusable-*"); `refusal` returned not thrown.
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
- Consumes: `toSummary` (workers.mjs:89), `FINISHED`, `MESSAGEABLE` (validate.mjs), `LABEL_RE`, `emptyDecision`
  (schema.mjs). Nothing with I/O.
- Produces:
  - `buildDecisionsRequest({workers, focusedId, referents, exchanges, message, codexEligible, cfg}) -> {input: string,
    questions: Question[], offered: {route: string[], provider: string[], concerns: string[]}}`
  - `interpretAnswers(byName, {offered, workers, focusedId, referents, message, cfg}) -> Result` with
    `Result = {kind: "plan", decision: CoordinatorDecision, writer: null | "reply" | "brief", meta: {p1, margin, winner}}
    | {kind: "clarify", text: string, meta} | {kind: "advice", text: string, meta} | {kind: "unusable", reason: string}`
  - `labelFrom(message, takenLabels: Set<string>) -> string` (passes `LABEL_RE`, unique)
  - `RISKY_RE`, `TEXT_RE` (exported constants, for tests)

Request builder:
- Live = workers with `MESSAGEABLE` status. Concern set = the focused worker (if live) plus the most recently active
  live workers (by `updated_at`/`last_event_at`, whatever the worker object carries; fall back to id order) up to 8.
- `input` (a string, every field through one `clean()` that replaces C0/C1/bidi controls with a space, then the whole
  string capped at `cfg.decisions.max_input_chars`):
  ```
  Message: <message, capped 2000>
  Focused worker: <id or none>
  Referents: singular=<id|none> other=<id|none> both=<a,b|none>
  Recent turns (oldest first):
  - user: <200> | reply: <200> | action: <action> -> <targets>
  Workers:
  - <id> [<provider>, <status>] label=<label> aliases=<a|b> objective=<200> task=<200> last=<150>
  ```
  last 6 exchanges.
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
  - `concerns_<id>` predicate per concern-set worker (id sanitised to `[a-z0-9_]`; keep a name->id map in `offered`),
    instructions "The user's message is meant for worker <id> (<label>)."
  - `needs_text` predicate, instructions "Starting the new worker needs a written brief because the goal is vague,
    long, or asks for a plan or explanation."

Interpretation (first matching rule wins; `c = cfg.decisions`):
```js
// 0. shape: every offered question must have an answer, else {kind:"unusable"} (the provider already checks; keep it pure-safe)
// 1. any refusal -> clarify (code text)
// 2. H = concern ids with pTrue >= c.concern_high; U = concern ids with c.concern_low < pTrue < c.concern_high
//    winner = byName.route.choice; isWorker = offered.route worker ids include winner
//    if (U.length && (isWorker || winner === "status")) -> clarify naming U ∪ H (max 3)
//    if (H.length >= 2) { if (H.includes(winner)) -> message_multiple to H;
//                         else if (winner === "status") -> request_status for H; else -> clarify naming H }
// 3. p1 = probs.get(winner); p2 = max other prob (0 if none); margin = p1 - p2
//    if (p1 < c.min_route_probability || margin < c.min_margin) -> clarify naming top two
// 4. if isWorker: concern answer present and pTrue < c.concern_high -> clarify; worker not MESSAGEABLE -> advice
// 5. if isWorker && referents.other-marked message (pronoun "other") && winner === focusedId -> clarify
// 6. if RISKY_RE.test(message) && p1 < c.risky_min_probability -> clarify ("That looks destructive: which worker, exactly? Use /to <id> <text>.")
// 7. new_session: provider winner from byName.provider under the same p1/margin rule, else "claude";
//    writer = (message.length > 400 || TEXT_RE.test(message) || needs_text.pTrue >= c.needs_text_threshold) ? "brief" : null;
//    writer null -> new_session {needed:true, provider, label: labelFrom(message, taken), objective: message.slice(0,1000)}
//    status -> request_status, targets H or []; respond -> action respond, writer "reply"; clarify -> clarify
//    worker -> message_session [winner], worker_instruction = message (verbatim)
```
`RISKY_RE = /\b(delete|drop|reset|wipe|erase|purge|destroy|force[- ]push|rm\s+-rf|revert all|truncate)\b/i`.
`TEXT_RE = /\b(plan|explain|design|investigate|research|compare|propose|figure out|evaluate)\b/i`.
`labelFrom`: lowercase, words of `[a-z0-9]`, drop stop words (a, an, the, to, for, and, of, make, new, worker, please,
start, create), first 3 words joined by `-`, cut to 32, must pass `LABEL_RE`; else `worker`; then append `-2`, `-3`, ...
until not in `takenLabels`.
Clarify text: `Which worker do you mean: <id> (<label>) or <id> (<label>)? Use /to <id> <text> to be exact.`; for
no candidates: `I could not tell where that should go. Workers: <id (status), ...>. Use /to <id> <text> or /new.`
Every `decision` passes `validateShape` (schema.mjs) - assert it in the tests.

MUST items:
- M1: builder output: input format, control-character cleaning, cap at `max_input_chars`; choices from the live
  registry only (finished/dead excluded); codex offered only when eligible; concern set max 8 incl. focus. Tests
  "B-input", "B-ctrl", "B-cap", "B-choices", "B-codex", "B-nine" (9 live workers, focused is the oldest -> it is in).
- M2: every interpretation rule with a passing and a failing case at the boundaries: p1 0.80/margin 0.20 accept;
  0.79 or 0.19 clarify; concern 0.80 is H, 0.30 is neither, 0.31 is U. Tests "I-*" (one per rule), including
  "I-dead" (Review Focus 1), "I-nine" (route to a live worker outside the concern set: rule 4 skips the missing concern
  answer), "I-other" (focus contradiction), "I-risky".
- M3: the three spec paths at this level: "tell the other one to check it too" with referents.other = ui-02 and
  answers route ui-02 0.9 -> message_session [ui-02] verbatim, writer null; the auth-architecture new-worker line ->
  create_session, writer "brief"; "start a worker to fix the login typo" (needs_text 0.1) -> create_session with
  label `fix-login-typo`, writer null.
- M4: `labelFrom` cases incl. control/bidi/emoji-only input -> `worker` / `worker-2` (Review Focus 5, test "L-ctrl").
- M5: no I/O: the module imports only the listed pure modules (a test reads the import lines).

- [ ] Step 1: write the B-, I-, L- tests as tables (`for (const [name, answers, expect] of cases) test(name, ...)`).
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/decisions.test.mjs`; FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run the file and the full suite; PASS.
- [ ] Step 5: commit `feat(model-coordinator): decisions request builder and interpretation`.

---

### Task 4: coordinator integration (Decisions first, pinned writer, fallback, path)

**Files:**
- Modify: `claude/skills/model-coordinator/coordinator.mjs` (`createCoordinator` :64, `turn` :108-159, `viaModel` :162-190)
- Modify: `claude/skills/model-coordinator/context.mjs` (`buildInput` :92 gains `pinnedRoute`; `instructionsText` :23)
- Test: `claude/skills/model-coordinator/tests/coordinator-decisions.test.mjs` (new); existing coordinator tests unchanged

**Interfaces:**
- Consumes: `buildDecisionsRequest`, `interpretAnswers` (Task 3); `decisions.ask` (Task 2, or `MockDecisionsProvider`);
  `provider.decide` (Luna); `validateForDispatch`, `dispatcher.peek/dispatch` (unchanged).
- Produces: `createCoordinator({..., decisions = null})`. Exchanges ledger lines gain `path: "shortcut" | "decisions" |
  "luna-fallback" | "luna" | "shortcuts-only" | "command" | "error"` and, on Decisions turns, `route_p1`, `route_margin`
  (rounded to 3 decimals). `out.path` is returned too. (`coordinator_records.md` is unchanged: exchanges are not part
  of it - spec section 8 "records" means this ledger.)
- Produces: `buildInput({..., pinnedRoute})` adds `pinned_route: {action, target_session_ids, provider, write:
  "reply"|"brief"}` to the input; `instructionsText()` gains: "If pinned_route is present, the route is already
  decided: copy its action and targets, write only reply (write=reply) or new_session.label, new_session.objective and
  worker_instruction (write=brief). Never change the route."

Turn flow (replace the `else` branch at :143-145):
```js
} else if (decisions && !(costHard)) {
  out.reply = await viaDecisions(line, r, workers, focusedId, exchanges, run, setDecision, meta);
} else {
  out.reply = await viaModel(line, r, workers, focusedId, exchanges, run, setDecision); // path "luna" (Decisions off)
}
```
`viaDecisions`:
1. `req = buildDecisionsRequest({..., codexEligible: safe(codexState)?.available === true, cfg})`.
2. `try { ans = await decisions.ask(req) } catch (e)`: `ProviderError` with code `hard-limit` -> shortcuts-only reply
   (path `shortcuts-only`); any other `ProviderError` -> `viaModel(..., {minConfidence: max(cfg.min_confidence,
   cfg.decisions.fallback_min_confidence)})` with path `luna-fallback`; non-ProviderError rethrows.
3. `res = interpretAnswers(ans.byName, ...)`: `unusable` -> fallback as in 2; `clarify` -> reply `res.text`,
   `setDecision(emptyDecision({action: "clarify", clarification: res.text}))`; `advice` -> reply `res.text`
   (decision clarify); `plan` with `writer === null` -> `run(res.decision)`.
4. `plan` with a writer: `w = await provider.decide(buildInput({..., pinnedRoute}))` inside try; on `ProviderError`:
   writer "brief" -> use the code-built create fields (`labelFrom` + message as objective) and dispatch; writer
   "reply" -> reply "Luna is unavailable (<code>). <SHORTCUTS>". Merge: `final = {...res.decision, reply: w.reply,
   worker_instruction: w.worker_instruction ?? res.decision.worker_instruction, new_session: {...res.decision.new_session,
   label: w.new_session?.label ?? code label, objective: w.new_session?.objective ?? code objective}}` - only these
   four fields; then `validateDecision(final)`; invalid -> one re-ask with the error codes, then the code-built
   fields; `respond` -> reply `final.reply` (no dispatch needed: `run` handles `respond` as today).
5. Path `decisions`; meta p1/margin into the exchange line.
`viaModel` gains an optional `{minConfidence}` parameter replacing `cfg.min_confidence` in `lowConfidence`.

MUST items (each a test in `coordinator-decisions.test.mjs`, using `MockDecisionsProvider`, `MockCoordinatorProvider`,
a spy dispatcher from `tests/mc-helpers.mjs` or a local one that counts `dispatch` calls):
- M1 three paths: "send this to auth-03" (`/to`-less exact-id shortcut that `resolveLine` already resolves) -> 0
  Decisions calls, 0 Luna calls, path `shortcut`; "tell the other one to check it too" -> 1 Decisions call, 0 Luna,
  dispatched to the right worker verbatim, path `decisions`; the auth-architecture line -> 1 Decisions + 1 Luna call,
  `create_session` dispatched with the writer's label/objective/instruction. Tests "C-path-shortcut",
  "C-path-decisions", "C-path-writer".
- M2 coreference at turn level: focused worker + "continue with it"; alias; "the other one"; "both of them" ->
  message_multiple. Tests "C-coref-*".
- M3 clarify paths: close probabilities, uncertain concern, refusal, risky -> no dispatch, code text reply. "C-clarify-*".
- M4 outages: Decisions `timeout`, `http-429`, `bad-response`, `unusable` -> Luna routing with the stricter bar (a Luna
  decision at confidence 0.7 now clarifies; at 0.85 dispatches), path `luna-fallback`; Luna also failing ->
  shortcuts-only text; Decisions `hard-limit` -> shortcuts-only without a Luna call. "C-outage-*".
- M5 no double dispatch: the same `turnId` handled twice (replay) -> one dispatch; Decisions timeout then Luna routes ->
  one dispatch (Review Focus 4, "C-timeout-once").
- M6 writer pinning: a writer answer with a different action, targets and provider -> dispatched decision keeps the
  route (asserted on the dispatcher's received decision). "C-pin".
- M7 Codex unavailable after selection: Decisions picks `new_session` + codex while eligible; dispatcher's codex gate
  says unavailable -> the existing fallback reply (Claude or refuse per config), other workers untouched. "C-codex-late".
- M8 dead winner -> advice reply, no dispatch ("C-dead"); `decisions = null` -> today's behaviour (all existing
  coordinator tests unchanged, plus "C-off").
- M9 exchanges carry `path` (+ `route_p1`, `route_margin` on Decisions turns). "C-ledger".

- [ ] Step 1: write the tests.
- [ ] Step 2: run `timeout 300 node --test claude/skills/model-coordinator/tests/coordinator-decisions.test.mjs`; FAIL.
- [ ] Step 3: implement `viaDecisions`, the `pinnedRoute` input and the instruction lines.
- [ ] Step 4: run the file, `tests/coordinator.test.mjs`, `tests/context.test.mjs`, then the full suite; PASS.
- [ ] Step 5: commit `feat(model-coordinator): Decisions-first routing with pinned Luna writer and fallback`.

---

### Task 5: CLI wiring, notices and spend in `/status`

**Files:**
- Modify: `claude/skills/model-coordinator/cli.mjs` (provider block :149-160, `createCoordinator` call :185-187)
- Modify: `claude/skills/model-coordinator/coordinator.mjs` (`costNotices` :72-77 wording "Coordinator spend"; the
  `request_status` reply gains one spend line)
- Test: `claude/skills/model-coordinator/tests/cli.test.mjs` (append), `tests/coordinator.test.mjs` (append)

**Interfaces:**
- Consumes: `createOpenAIDecisionsProvider`, `createMeter({api: "decisions"})`, `meter.state().by_api`.
- Produces: when `cfg.provider === "openai"`: a responses meter (as today) and a decisions meter on the same store;
  `decisions = createOpenAIDecisionsProvider({cfg, meter: decMeter, apiKey, fetch: deps.fetch})` inside try; a
  `ConfigError` adds the note "Decisions routing not started: <msg>. Luna routes every message." and leaves
  `decisions = null`. Both providers read the key before the credential variables are removed from `process.env`
  (existing K7 order). `costState` returns the combined state.

MUST items:
- M1: with a price table that has `decisions_input_per_mtok`, the coordinator gets a Decisions provider (spy via
  `deps`); without it, the note is shown and routing falls back to Luna. Tests "K-dec-on", "K-dec-off".
- M2: after startup no credential variable is in `process.env` and both providers hold the key (extend the K7 test).
- M3: `/status` (and a Decisions `status` route) shows `Spend this month: $X (Decisions $a, Luna $b) of $7 soft / $10
  hard.`; cost notices say "Coordinator spend" and name the combined total. Tests "K-status-spend", "K-notice".
- M4: `decisions.enabled: false` -> no Decisions provider, no note, Luna routes. Test "K-dec-disabled".

- [ ] Step 1: tests; Step 2: run `timeout 600 node --test claude/skills/model-coordinator/tests/cli.test.mjs claude/skills/model-coordinator/tests/coordinator.test.mjs`, FAIL; Step 3: implement; Step 4: full suite PASS;
- [ ] Step 5: commit `feat(model-coordinator): wire Decisions provider, combined spend status`.

---

### Task 6: Codex wrapper items (request item 15)

**Files:**
- Modify: `optional/codex/skills/dispatching-codex/readcheck.mjs` (:254-256 net fixture)
- Modify (only if needed for M1): `optional/codex/skills/dispatching-codex/codex-run.mjs` (:76-82 env builders)
- Test: `optional/codex/skills/dispatching-codex/tests/` (the existing env and readcheck test files; append)

**Interfaces:** none consumed from Tasks 1-5. Independent.

MUST items:
- M1 (e10c8a7 re-review M5): pin that `CODEX_API_KEY` (any case) never reaches a sandboxed command. Today the key goes
  to the `codex exec` spawn env (`codex-run.mjs:79-82`) and is kept from tool commands only by Codex's default
  `shell_environment_policy` excludes. Make that explicit: pass the exclusion to `codex exec` on the argv (for example
  `-c shell_environment_policy.exclude=["CODEX_API_KEY","*_API_KEY"]` or the equivalent key the installed Codex
  documents; verify with `codex exec --help` / the Codex config docs, do not guess) and add a test asserting the argv
  carries it, plus a test that the env built for host-side and sandboxed checks has no `codex_api_key` in any case.
- M2 (re-review M7): `CODEX_RUN_NET_FIXTURE` must not act in production. Replace the env knob with an injected runner
  (the readcheck function takes `{runNet}`; tests pass a fake), or honour the variable only when `NODE_TEST_CONTEXT`
  is also set. Test: with the variable set and no test context, the real runner is chosen (assert by injection spy,
  not by running `net.exe`).

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
Spec 3 flow -> Task 4. Spec 4 questions -> Task 3 builder. Spec 5 rules/config -> Tasks 1 (config), 3 (rules).
Spec 6 text rules + pinning -> Tasks 3 (writer choice, labels), 4 (writer call + merge). Spec 7 failure -> Tasks 2
(error codes), 4 (fallback, idempotency). Spec 8 cost/records/permissions -> Tasks 1, 4 (path), 5 (status), write-surface
scan (every task's full-suite run). Spec 9 tests -> Tasks 3, 4, 14. Item 15 -> Task 6.
Deviation from the spec, recorded: the per-turn `path` and probabilities go to the exchanges ledger, not
`coordinator_records.md` (that file renders workers, focus and notes only, `records.mjs:48`).
