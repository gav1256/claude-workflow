# Luna coordinator: Decisions API as the primary routing layer (design)

Date: 2026-10-07. Lane `luna-coordinator`, branch `jev-coordinator`. Status: draft for user review.
Source request: the user's Decisions request of 2026-10-07 (sections 1-15, condensed copy kept with the lane's briefs).
Builds on the Luna coordinator design (`2026-10-07-luna-coordinator-architecture.md`) and plan
(`docs/plans/2026-10-07-luna-coordinator.md`); everything not named here stays as built.

Core principle (user): the Decisions API decides; Luna Responses runs only when language must be generated;
deterministic code validates and executes; Claude and Codex workers do the file work.

## 1. User answers that bind this design
1. Text generation trigger: Decisions plus fixed rules. A message to an existing worker forwards the user's words
   unchanged; explain/summarise/plan requests and a new worker with a vague or long goal get Luna text; otherwise the
   `needs_text` predicate decides.
2. Multi-worker: one Decisions call, one predicate per live worker (`concerns_<id>`, up to 8). Several workers at or
   above the threshold: send to all. Any worker in the uncertain middle band: clarify.
3. Decisions down: the old Luna routing with a stricter confidence bar, then a shortcuts-only reply. Same request
   (turn) id, never a double dispatch.
4. Approach A (agreed 2026-10-07): Decisions in front; the existing Luna Responses provider becomes the text writer
   (route pinned) and the fallback router. Rejected: B (a new slim Luna writer schema), C (no Luna routing fallback).

## 2. The Decisions API (as researched, beta 2026-10-06)
`POST https://api.openai.com/v1/decisions`, model `gpt-6-luna` only. Body `{model, input, questions}`; `input` is a
string or user messages; each question is `{type: "choice"|"predicate"|"score", name, instructions, choices?:
[{value, description?}]}`. Response `{answers: [{type, name, choice, confidence, probabilities: [{value,
probability}]} | {type: "refusal", name}], model, usage: {input_tokens, ...}}`. Price $0.10 per 1M input tokens, no
output or cache charge. No calibration guarantee; Decisions-specific rate limits are not published. The coordinator
calls it with `fetch` (as `openai-provider.mjs` does), no SDK dependency, `store` not applicable.

## 3. Flow
```
user line
 -> resolveLine (resolve.mjs, unchanged): /to, /new, /status, exact id or unique name or alias, single worker +
    "continue" ... -> validate -> dispatcher                       [path = "shortcut", no OpenAI call]
 -> cost gate: hard limit reached -> shortcuts-only reply           [no OpenAI call]
 -> ONE Decisions call (questions in section 4)
      ok    -> interpret (section 5): a RoutePlan or a forced clarify
      outage/unusable -> old Luna routing (section 7)               [path = "luna-fallback"]
 -> needs text? (section 6) -> Luna writer call with the route pinned
 -> validateForDispatch + dispatcher (unchanged final authority: Codex gate, conflicts, fallback to Claude,
    idempotency by turn id)                                         [path = "decisions"]
```
A `RoutePlan` is a `CoordinatorDecision` (schema.mjs) built by code from the answers: `action`, `target_session_ids`,
`new_session.provider` come from Decisions; `worker_instruction`, `reply`, `new_session.label/objective`,
`clarification` come from fixed rules or the Luna writer. Nothing the model returns is executed.

## 4. The Decisions call
Input (a string, capped, built by a new pure builder that reuses `workers.mjs` `toSummary` and `resolve.mjs`
`referents`): the user message; the focused worker id; the live workers (finished excluded) as compact summaries; the
resolver's referents (singular / other / both / recent); the last 4-6 exchanges (user text, reply, action, targets,
each capped); the last relevant Codex/worker event if any. Never transcripts, project history or source files.

Questions:
- `route` (choice). Choices built from the live registry each turn: one per messageable worker (`value` = worker id;
  `description` = provider, label, aliases, objective, current task, status, short last result; capped at 300 chars),
  plus `new_session`, `status` (the user asks how workers are doing), `respond` (the user wants an answer,
  explanation, summary or discussion from the coordinator itself, nothing sent to a worker), `clarify`. The model
  cannot invent an id: an answer outside the offered values is unusable (section 7).
- `provider` (choice: `claude`, and `codex` only when `resourceState`/`codexGate` reports Codex eligible: logged in,
  usage ok, a free or queueable slot). Asked only when a new worker is possible.
- `concerns_<id>` (predicate), one per live messageable worker, at most 8 (the 8 most recently active plus the
  focused one when there are more): "the message is meant for this worker".
- `needs_text` (predicate), asked only when a new worker is possible: "starting this worker needs a written brief
  (the goal is vague, long, or needs planning)".

Note for review: `status` and `respond` are additions to the part-1 choice list. Without them, a question to the
coordinator ("what are the workers doing?", "summarise the results") has no correct route; the old Luna schema has
`request_status` and `respond` actions for the same reason.

## 5. Interpretation (pure, deterministic; thresholds from config)
Config (new block, validated like the others; invalid values reset and refuse start, as today):
`decisions: { enabled: true, timeout_ms: 10000, max_retries: 1, min_route_probability: 0.80, min_margin: 0.20,
concern_high: 0.80, concern_low: 0.30, needs_text_threshold: 0.50, risky_min_probability: 0.90,
fallback_min_confidence: 0.80 }`. Values are tuned by the test table (section 9), not by live calls.

Order of rules (first match wins):
1. Any refusal answer, or an answer missing for a question that was asked -> forced clarify (refusal) or unusable
   (missing; section 7).
2. Concerns: H = workers with `p(true) >= concern_high`, U = workers with `concern_low < p(true) < concern_high`.
   U non-empty and the route winner is a worker or `status` -> clarify ("Did you mean X or Y?"). |H| >= 2: winner one of
   H -> `message_multiple` to H; winner `status` -> `request_status` for H; any other winner -> clarify. This rule needs
   no route threshold (a message for two workers splits the single-choice `route` probability between them).
3. Route: top choice probability `p1`, runner-up `p2`. Accept only when `p1 >= min_route_probability` and
   `p1 - p2 >= min_margin`; otherwise clarify, naming the top two candidates.
4. Consistency: route winner is a worker W but `concerns_W` is below `concern_high` -> clarify. Winner W is not
   messageable now (finished/dead since the snapshot) -> the existing advice reply ("W is finished. Start a new one
   ...").
5. Focus contradiction: the resolver marks the message as "the other one" and the winner is the focused worker ->
   clarify.
6. Risky and unclear: the message matches the destructive-intent list (delete, drop, reset, wipe, force push, rm -rf,
   revert all, ... as a code constant) and `p1 < risky_min_probability` -> clarify.
7. Winner `new_session`: provider from the `provider` answer under the same probability/margin rule; Codex picked but
   no longer eligible is left to the dispatcher's Codex gate (fallback to Claude or refuse, per `codex.fallback`).
   Winner `status` -> `request_status` (targets = H, or all live workers). Winner `respond` -> `respond` (Luna text).
   Winner `clarify` -> clarify. Winner worker W (and |H| <= 1) -> `message_session` to W.

Clarification text is written by code from the candidates (no model text): "Which worker do you mean: auth-01 (fix
login) or ui-02 (header)? Use /to <id> <text> to be exact."

## 6. When Luna writes text (fixed rules first)
- `message_session` / `message_multiple`: forward the user's words unchanged (`worker_instruction` = the line), no
  Luna call.
- `request_status`, `clarify`: code text, no Luna call.
- `respond`: Luna writer call (reply only).
- `create_session`: Luna writer call when the line is longer than 400 characters, or matches the plan/explain/design
  list, or `needs_text >= needs_text_threshold`. Otherwise code builds it: `objective` = the user's line (capped),
  `label` = a slug of the first meaningful words that passes `LABEL_RE`, made unique against existing labels.

The Luna writer is the existing `OpenAILunaProvider.decide()` with the same strict schema. Its input carries a
`pinned_route` block (action, targets, provider) and an instruction to write only the text fields. Code then copies
ONLY `reply`, `worker_instruction`, `new_session.label`, `new_session.objective` from the answer onto the RoutePlan;
action, targets, provider and `new_session.needed` always come from the RoutePlan, so the writer cannot change the
route even if it tries. The result still goes through `validateDecision` (one re-ask on errors, then the code-built
fallback text for create, or a clarify for respond).

## 7. Failure and fallback
- Decisions outage: timeout, network error, HTTP 429/5xx after `max_retries`, non-JSON body, or an unusable answer
  set (missing answer, choice outside the offered values, probabilities missing or not numbers). Fallback = today's
  `viaModel` Luna routing with `min_confidence = max(cfg.min_confidence, decisions.fallback_min_confidence)`.
- Luna also fails (ProviderError, hard limit, context over budget) -> shortcuts-only reply naming the error.
- Decisions disabled (`decisions.enabled: false`, no Decisions price, `provider: "none"`) -> today's Luna routing
  unchanged (with the normal `min_confidence`), so turning Decisions off is a safe rollback.
- A refusal is not an outage: it forces a clarify, no fallback.
- Idempotency: the Decisions call and any fallback happen before dispatch, inside one turn with one `turnId`. The
  turn makes at most one `dispatcher.dispatch` call; `dispatcher.peek(d, {turnId})` keeps a retried turn from
  dispatching twice (unchanged). Test: Decisions fails after a timeout whose request may have reached OpenAI, Luna
  routes, one dispatch.
- Codex unavailable between decision and dispatch: unchanged dispatcher behaviour (`codex.fallback`), other workers
  untouched.

## 8. Cost, records, permissions
- Usage ledger lines gain `api: "decisions" | "responses"` (lines without it count as responses). Decisions lines
  record calls, input tokens, cost, latency, retries, outcome; Responses lines are unchanged (input, cached, output
  tokens). `/status` shows both and the combined month total.
- Price table: `pricing["gpt-6-luna"].decisions_input_per_mtok` (0.10). Missing or invalid -> the Decisions provider
  does not start (notice), Luna routing runs as today. Decisions worst case = estimated input tokens x rate (no
  output charge); the meter checks before every attempt, retries included; usage missing -> charge the worst case.
- Limits: the $7 soft / $10 hard monthly limits apply to the combined spend (`monthSpend` already sums every line). At
  the hard limit neither provider is called; shortcuts, `/status` and running workers keep working.
- Records: `coordinator_records.md` keeps its format; each exchange gains `path` (shortcut / decisions /
  luna-fallback / shortcuts-only) and, for Decisions turns, `route_p1`, `route_margin` (for tuning; no prompt text).
- Permissions: Decisions and Luna get no tools, no shell, no file API. Neither provider imports the store. The
  dispatcher stays the only writer (`write-surface.test.mjs` allowlist; the new provider module is added to no
  write-capable list). The key is read once, sent only in the Authorization header, never logged (as today); the CLI
  still removes credential variables from `process.env` after the providers read them.

## 9. Testing (all on mock providers; no paid calls, no real workers)
New `MockDecisionsProvider` (scripted answers per message, records calls) beside `MockCoordinatorProvider`.
- Three paths: "send this to auth-03" -> no Decisions or Luna call; "tell the other one to check it too" -> Decisions
  only, routed to the right worker; "make a new worker and give it a detailed plan for investigating whether our auth
  architecture should be replaced" -> Decisions (`new_session` + provider) then one Luna writer call.
- Coreference: focused worker, aliases, "him", "that one", "the other one" (with and without a focus).
- One vs several workers; ambiguous -> clarify; uncertain middle band -> clarify.
- Close probabilities (p1 0.79; margin 0.19) -> clarify; boundary values exactly at the thresholds accept.
- Refusal, an id not offered, a finished or dead winner, missing probabilities.
- Codex: not offered when ineligible; eligible at decision time and unavailable at dispatch -> fallback per config.
- Outages: timeout, 429, 5xx, non-JSON -> Luna routing with the stricter bar; Luna also down -> shortcuts-only.
- No double dispatch across retries and fallback (dispatcher call count = 1).
- Writer pinning: a Luna answer that changes action/targets/provider has no effect.
- Spend: the Decisions meter blocks at the hard limit; combined spend crosses the hard limit -> both blocked; usage
  lines carry `api`.
- Safety: existing Claude/Codex sessions unaffected; no project-file writes (write-surface guard covers the new
  modules).
- Request item 15 (Codex wrapper, `optional/codex/skills/dispatching-codex/`): a test that `CODEX_API_KEY` never
  reaches the Codex sandbox env (e10c8a7 re-review M5); `CODEX_RUN_NET_FIXTURE` removed or guarded so it cannot act
  outside tests (re-review M7).
- Codex `review` runs on the plan and on each Decisions task diff.

## 10. Files (expected)
New: `decisions-provider.mjs` (OpenAIDecisionsProvider: fetch, retries, metering, answer shape check),
`decisions.mjs` (pure: build input and questions; interpret answers into a RoutePlan or clarify; fixed text rules),
tests for both. Changed: `coordinator.mjs` (Decisions first, writer call, fallback, `path` field), `provider.mjs`
(MockDecisionsProvider), `cost.mjs` (per-api pricing and ledger field), `config.mjs` (decisions block + validation),
`context.mjs` (pinned-route input for the writer), `cli.mjs` (construct the Decisions provider; notices),
`records.mjs` (path field), `write-surface.test.mjs` (scan the new modules). Codex wrapper: the two item-15 tests and
guard.

## 11. Out of scope
Score questions; live tuning against the real API (needs the user's key and OK); any change to resolve.mjs shortcuts,
the dispatcher's authority, or the Claude/Codex adapters.
