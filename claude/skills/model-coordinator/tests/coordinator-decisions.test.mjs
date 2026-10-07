// Task 4a: the coordinator routes non-shortcut lines through Decisions first, clarifies in code, falls back to Luna with a
// stricter bar, and records the path on every exchange. Nothing real runs: mock providers, fake adapters, fake fetch, sandboxes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inSandbox, fakeClaudeAdapter, fakeCodexAdapter, blockedOutcome, seedWorker } from "./mc-helpers.mjs";
import * as store from "../store.mjs";
import { DEFAULTS } from "../config.mjs";
import { emptyDecision } from "../schema.mjs";
import { ProviderError, MockCoordinatorProvider, MockDecisionsProvider } from "../provider.mjs";
import { createDispatcher, createWorkersView } from "../dispatcher.mjs";
import { createCoordinator } from "../coordinator.mjs";
import { createMeter, SpendBlocked } from "../cost.mjs";
import { createOpenAIDecisionsProvider } from "../decisions-provider.mjs";
import { createOpenAILunaProvider } from "../openai-provider.mjs";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const CFG = DEFAULTS;
const OK_CODEX = { available: true, usage_status: "ok", capacity_available: true, active_jobs: 0, max_parallel_jobs: 2 };

const ch = (choice, p, others = {}) => ({ type: "choice", choice, probs: new Map([[choice, p], ...Object.entries(others)]) });
const pr = (p) => ({ type: "predicate", pTrue: p });
/** Answers (Answers.byName) keyed by the request's own offered names. */
function answers(req, { route = ["auth-01", 0.95, {}], provider = ["claude", 0.95, {}], needs = 0.1, concerns = {} } = {}) {
  const byName = { route: ch(...route), provider: ch(...provider), needs_text: pr(needs) };
  for (const [name, id] of Object.entries(req.offered.concerns)) byName[name] = pr(concerns[id] ?? 0.05);
  return byName;
}
const say = (o) => (req) => answers(req, o);
const toWorker = (id, p = 0.95, extra = {}) => say({ route: [id, p, extra.others ?? {}], concerns: { [id]: 0.9, ...(extra.concerns ?? {}) } });
const lunaMsg = (ids, text, p = {}) => emptyDecision({ action: ids.length === 1 ? "message_session" : "message_multiple", target_session_ids: ids, worker_instruction: text, confidence: 0.9, ...p });

function rig({ dec = [], luna = [], cfg = CFG, cost, codexState, view, claude, codex, decisionsProvider, lunaProvider, poll } = {}) {
  const c = claude ?? fakeClaudeAdapter(), x = codex ?? fakeCodexAdapter();
  const lunaProv = lunaProvider ?? new MockCoordinatorProvider(luna);
  const decProv = decisionsProvider !== undefined ? decisionsProvider : dec === null ? null : new MockDecisionsProvider(dec);
  const base = createWorkersView({ store, claude: c, codex: x, now: () => NOW });
  let viewCalls = 0;
  const workersView = view ? async () => view(viewCalls++, base) : base;
  const real = createDispatcher({ cfg, store, claude: c, codex: x, workersView: base, now: () => NOW, repo: "C:/repo-example", lanes: () => [] });
  const counts = { dispatch: 0, args: [] };
  const dispatcher = { ...real, dispatch: (...a) => { counts.dispatch++; counts.args.push(a); return real.dispatch(...a); } };
  const coordinator = createCoordinator({ cfg, store, provider: lunaProv, decisions: decProv, dispatcher, workersView, poll, codexState, costState: cost, now: () => NOW, project: { repo: "repo-example" } });
  return { c, x, luna: lunaProv, dec: decProv, coordinator, counts, workersViewCalls: () => viewCalls };
}
const exchanges = () => store.readJsonl("exchanges");
const lastExchange = () => exchanges().at(-1);
const seedHistory = (ids = ["auth-01", "ui-02"]) => ids.forEach((id, i) => store.appendJsonl("exchanges", { turn_id: `h${i}`, at: "2026-10-07T11:00:00.000Z", user: `/to ${id} start`, reply: `${id}: delivered`, action: "message_session", targets: [id], instruction: "start", rule: "command", path: "shortcut" }));
const focusOn = (id) => store.appendJsonl("workers", { ev: "focus", worker_id: id, at: "2026-10-07T11:30:00.000Z" });

// ---- M1 paths -------------------------------------------------------------------------------------------------------

test("C-path-shortcut: a line that names one worker is a shortcut: no Decisions call, no Luna call", () => inSandbox(async () => {
  const r = rig({ dec: [] });
  seedWorker("auth-03");
  const out = await r.coordinator.handleLine("send this to auth-03", { turnId: "t1" });
  assert.equal(r.dec.calls.length, 0);
  assert.equal(r.luna.calls.length, 0);
  assert.equal(out.path, "shortcut");
  assert.equal(r.c.calls.message[0].worker, "auth-03");
  assert.equal(lastExchange().path, "shortcut");
}));

test("C-path-decisions: 'tell the other one to check it too' is one Decisions call, no Luna, delivered verbatim to the right worker", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("ui-02")] });
  seedWorker("auth-01"); seedWorker("ui-02"); seedHistory(); focusOn("auth-01");
  const line = "tell the other one to check it too";
  const out = await r.coordinator.handleLine(line, { turnId: "t1" });
  assert.equal(r.dec.calls.length, 1);
  assert.equal(r.luna.calls.length, 0);
  assert.equal(r.counts.dispatch, 1);
  assert.deepEqual(r.c.calls.message.map((m) => [m.worker, m.text]), [["ui-02", line]]);
  assert.equal(out.path, "decisions");
  assert.equal(out.decision.action, "message_session");
  assert.match(r.dec.calls[0].input, /^Message: tell the other one to check it too$/m);
}));

// ---- M2 coreference at turn level -----------------------------------------------------------------------------------

test("C-coref-focus: 'continue with it' goes to the focused worker", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("auth-01")] });
  seedWorker("auth-01"); seedWorker("ui-02"); seedHistory(); focusOn("auth-01");
  await r.coordinator.handleLine("continue with it", { turnId: "t1" });
  assert.match(r.dec.calls[0].input, /^Focused worker: auth-01$/m);
  assert.match(r.dec.calls[0].input, /singular=auth-01 other=ui-02/);
  assert.deepEqual(r.c.calls.message.map((m) => [m.worker, m.text]), [["auth-01", "continue with it"]]);
}));

test("C-coref-alias: an alias plus a pronoun goes through Decisions to the aliased worker", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("auth-01")] });
  seedWorker("auth-01", "claude", { extra: { aliases: ["login worker"] } }); seedWorker("ui-02");
  await r.coordinator.handleLine("ask the login worker about it", { turnId: "t1" });
  assert.equal(r.dec.calls.length, 1);
  const route = r.dec.calls[0].questions.find((q) => q.name === "route");
  assert.match(route.choices.find((c) => c.value === "auth-01").description, /aliases login worker/);
  assert.equal(r.c.calls.message[0].worker, "auth-01");
}));

test("C-coref-other-focus: 'the other one' with a focus goes to the other worker", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("ui-02")] });
  seedWorker("auth-01"); seedWorker("ui-02"); seedHistory(); focusOn("auth-01");
  await r.coordinator.handleLine("tell the other one to check it too", { turnId: "t1" });
  assert.match(r.dec.calls[0].input, /singular=auth-01 other=ui-02/);
  assert.equal(r.c.calls.message[0].worker, "ui-02");
}));

test("C-coref-other-nofocus: without a focus, routing 'the other one' to the singular referent clarifies; routing it to the other dispatches", async () => {
  const line = "tell the other one to check it too";
  await inSandbox(async () => {
    seedWorker("auth-01"); seedWorker("ui-02"); seedHistory(); // recent = [ui-02, auth-01]: singular ui-02, other auth-01
    const r = rig({ dec: [toWorker("ui-02")] });
    const a = await r.coordinator.handleLine(line, { turnId: "t1" });
    assert.match(r.dec.calls[0].input, /Focused worker: none/);
    assert.match(r.dec.calls[0].input, /singular=ui-02 other=auth-01/);
    assert.match(a.reply, /Which worker do you mean/);
    assert.equal(r.counts.dispatch, 0);
  });
  await inSandbox(async () => {
    seedWorker("auth-01"); seedWorker("ui-02"); seedHistory();
    const r = rig({ dec: [toWorker("auth-01")] });
    const b = await r.coordinator.handleLine(line, { turnId: "t2" });
    assert.equal(r.counts.dispatch, 1);
    assert.equal(r.c.calls.message[0].worker, "auth-01");
    assert.equal(b.decision.action, "message_session");
  });
});

test("C-coref-both: 'both of them' is a message_multiple to both workers", () => inSandbox(async () => {
  const r = rig({ dec: [say({ route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.9, "ui-02": 0.9 } })] });
  seedWorker("auth-01"); seedWorker("ui-02"); seedHistory();
  const out = await r.coordinator.handleLine("tell both of them to rebase", { turnId: "t1" });
  assert.equal(out.decision.action, "message_multiple");
  assert.deepEqual(r.c.calls.message.map((m) => m.worker).sort(), ["auth-01", "ui-02"]);
  assert.ok(r.c.calls.message.every((m) => m.text === "tell both of them to rebase"));
  assert.equal(r.counts.dispatch, 1);
}));

// ---- M3 clarify -----------------------------------------------------------------------------------------------------

async function clarifyCase(script, line = "poke the login thing") {
  const r = rig({ dec: [script] });
  seedWorker("auth-01"); seedWorker("ui-02");
  const out = await r.coordinator.handleLine(line, { turnId: "t1" });
  assert.equal(r.counts.dispatch, 0, "nothing dispatched");
  assert.equal(r.c.calls.message.length + r.c.calls.create.length, 0);
  assert.equal(r.luna.calls.length, 0, "no Luna call");
  assert.equal(out.path, "decisions");
  assert.equal(lastExchange().action, "clarify");
  assert.equal(lastExchange().reply, out.reply);
  assert.ok(out.reply.length > 0 && out.reply.length <= 2000);
  return out;
}

test("C-clarify-close: close probabilities clarify between the two workers", () => inSandbox(async () => {
  const out = await clarifyCase(say({ route: ["auth-01", 0.6, { "ui-02": 0.4 }], concerns: { "auth-01": 0.9 } }));
  assert.match(out.reply, /Which worker do you mean: auth-01 \(auth\) or ui-02 \(ui\)\?/);
}));
test("C-clarify-concern: an uncertain concern clarifies", () => inSandbox(async () => {
  const out = await clarifyCase(say({ route: ["auth-01", 0.95, {}], concerns: { "auth-01": 0.9, "ui-02": 0.5 } }));
  assert.match(out.reply, /Which worker do you mean/);
}));
test("C-clarify-refusal: a refusal clarifies with the worker list", () => inSandbox(async () => {
  const out = await clarifyCase(() => ({ route: { type: "refusal" } }));
  assert.match(out.reply, /I could not tell where that should go\. Workers: auth-01 \(running\), ui-02 \(running\)\./);
}));
test("C-clarify-risky: destructive wording without a 0.90 route clarifies", () => inSandbox(async () => {
  const out = await clarifyCase(say({ route: ["auth-01", 0.85, {}], concerns: { "auth-01": 0.9 } }), "delete the old branch now");
  assert.match(out.reply, /That looks destructive/);
}));

// ---- M4 outages and spend -------------------------------------------------------------------------------------------

for (const code of ["timeout", "http-429", "bad-response", "unusable"]) {
  test(`C-outage-${code}: Decisions ${code} routes through Luna with the stricter bar; path luna-fallback`, () => inSandbox(async () => {
    const lowThenHigh = [lunaMsg(["auth-01"], "go", { confidence: 0.7 }), lunaMsg(["auth-01"], "go", { confidence: 0.85 })];
    const r = rig({ dec: [new ProviderError(code, "down"), new ProviderError(code, "down")], luna: lowThenHigh });
    seedWorker("auth-01");
    const a = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
    assert.equal(a.path, "luna-fallback");
    assert.equal(r.counts.dispatch, 0, "0.7 is below the 0.8 fallback bar: a clarify");
    assert.match(a.reply, /Which worker do you mean/);
    const b = await r.coordinator.handleLine("poke the login thing again", { turnId: "t2" });
    assert.equal(b.path, "luna-fallback");
    assert.equal(r.counts.dispatch, 1);
    assert.equal(r.c.calls.message[0].worker, "auth-01");
    assert.equal(lastExchange().path, "luna-fallback");
  }));
}

test("C-outage-unusable-answers: an answer set that is not usable falls back to Luna", () => inSandbox(async () => {
  const r = rig({ dec: [{}], luna: [lunaMsg(["auth-01"], "go", { confidence: 0.9 })] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(out.path, "luna-fallback");
  assert.equal(r.luna.calls.length, 1);
  assert.equal(r.counts.dispatch, 1);
  assert.equal(lastExchange().route_p1, undefined, "an unusable answer leaves no route numbers");
}));

test("C-outage-both: Decisions and Luna both failing give the shortcuts text, nothing dispatched", () => inSandbox(async () => {
  const r = rig({ dec: [new ProviderError("timeout", "slow")], luna: [() => { throw new ProviderError("http-503", "down"); }] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.match(out.reply, /Luna is unavailable \(http-503/);
  assert.match(out.reply, /Use \/to <id> <text>/);
  assert.equal(r.counts.dispatch, 0);
}));

test("C-outage-hard-limit: a Decisions SpendBlocked is the shortcuts-only text and Luna is not called", () => inSandbox(async () => {
  const r = rig({ dec: [new SpendBlocked("monthly hard limit $10 reached ($10.00)")], luna: [lunaMsg(["auth-01"], "go")] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(out.path, "shortcuts-only");
  assert.equal(r.luna.calls.length, 0);
  assert.equal(r.counts.dispatch, 0);
  assert.match(out.reply, /monthly hard limit \$10 reached/);
  assert.match(out.reply, /Use \/to <id> <text>/);
  assert.equal(lastExchange().path, "shortcuts-only");
}));

test("C-outage-rethrow: an error that is not a ProviderError is not swallowed", () => inSandbox(async () => {
  const r = rig({ dec: [new Error("boom")], luna: [lunaMsg(["auth-01"], "go")] });
  seedWorker("auth-01");
  await assert.rejects(r.coordinator.handleLine("poke the login thing", { turnId: "t1" }), /boom/);
  assert.equal(r.luna.calls.length, 0);
}));

// a fake fetch for the real Decisions provider: answers every question from the request body
function decisionsFetch({ route = "auth-01", usage = { input_tokens: 1000 }, mode = "ok" } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (mode === "hang") return new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); });
    const answers = JSON.parse(init.body).questions.map((q) => {
      if (q.type === "choice") {
        const probabilities = q.choices.map((c) => ({ value: c.value, probability: c.value === (q.name === "route" ? route : "claude") ? 0.95 : 0.05 / Math.max(1, q.choices.length - 1) }));
        return { type: "choice", name: q.name, choice: q.name === "route" ? route : "claude", confidence: 0.9, probabilities };
      }
      const p = q.name === `concerns_${route.replace(/-/g, "_")}` ? 0.9 : 0.05;
      return { type: "predicate", name: q.name, choice: p > 0.5 ? "true" : "false", confidence: 0.9, probabilities: [{ value: true, probability: p }, { value: false, probability: 1 - p }] };
    });
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers, usage }) };
  };
  f.calls = calls;
  return f;
}
const lunaFetch = (decision) => {
  const f = async () => {
    f.calls++;
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision) }] }], usage: { input_tokens: 100, output_tokens: 20 } }) };
  };
  f.calls = 0;
  return f;
};
const realCfg = (over = {}) => ({
  ...DEFAULTS, provider: "openai",
  pricing: { "gpt-6-luna": { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4, decisions_input_per_mtok: 0.1 } },
  openai: { ...DEFAULTS.openai, timeout_ms: 2000, max_retries: 0 },
  decisions: { ...DEFAULTS.decisions, timeout_ms: 30, max_retries: 1 },
  ...over,
});

test("C-spend: Decisions spend that reaches the combined hard limit makes the NEXT turn call neither provider", () => inSandbox(async () => {
  const cfg = realCfg({ pricing: { "gpt-6-luna": { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4, decisions_input_per_mtok: 5 } } });
  const fetch = decisionsFetch({ usage: { input_tokens: 2000000 } }); // 2M tokens at $5 per M = $10
  const meter = createMeter({ cfg, store, now: () => NOW, api: "decisions" });
  const decisionsProvider = createOpenAIDecisionsProvider({ cfg, meter, fetch, sleep: async () => {}, apiKey: "sk-test-0000" });
  const luna = new MockCoordinatorProvider([lunaMsg(["auth-01"], "go")]);
  const r = rig({ cfg, decisionsProvider, lunaProvider: luna, cost: () => createMeter({ cfg, store, now: () => NOW }).state() });
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(a.path, "decisions");
  assert.equal(r.counts.dispatch, 1);
  assert.equal(fetch.calls.length, 1);
  assert.ok(a.notices.some((n) => /hard limit/.test(n)), "the notice shows the limit reached by this turn's own spend");
  const b = await r.coordinator.handleLine("poke the login thing again", { turnId: "t2" });
  assert.equal(b.path, "shortcuts-only");
  assert.match(b.reply, /No model call was made/);
  assert.equal(fetch.calls.length, 1, "no second Decisions call");
  assert.equal(luna.calls.length, 0, "no Luna call");
  assert.equal(r.counts.dispatch, 1);
}));

// ---- M5 no double dispatch ------------------------------------------------------------------------------------------

test("C-replay-same: the same turnId twice is one Decisions call and one dispatch; the second reply is the stored one", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("auth-01")] });
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  const b = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(r.dec.calls.length, 1);
  assert.equal(r.counts.dispatch, 1);
  assert.equal(r.c.calls.message.length, 1);
  assert.equal(b.reply, a.reply);
  assert.equal(exchanges().length, 1, "a replayed turn adds no second exchange");
}));

test("C-replay-changed: a second run whose scripted answers would differ is never consulted", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("auth-01"), toWorker("ui-02")] });
  seedWorker("auth-01"); seedWorker("ui-02");
  await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  const b = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(r.dec.calls.length, 1);
  assert.deepEqual(r.c.calls.message.map((m) => m.worker), ["auth-01"]);
  assert.match(b.reply, /auth-01/);
}));

test("C-replay-label: a replayed new-worker turn does not regenerate a suffixed label or start a second worker", () => inSandbox(async () => {
  const r = rig({ dec: [say({ route: ["new_session", 0.95, {}] }), say({ route: ["new_session", 0.95, {}] })] });
  const line = "start a worker to fix the login typo";
  const a = await r.coordinator.handleLine(line, { turnId: "t1" });
  const b = await r.coordinator.handleLine(line, { turnId: "t1" });
  assert.equal(r.dec.calls.length, 1);
  assert.equal(r.counts.dispatch, 1);
  assert.equal(r.c.calls.create.length, 1);
  assert.equal(r.c.calls.create[0].label, "fix-login-typo");
  assert.equal(b.reply, a.reply);
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "created").length, 1);
}));

test("C-replay-luna: the guard also covers the Luna path and the fallback path", () => inSandbox(async () => {
  const off = rig({ dec: null, luna: [lunaMsg(["auth-01"], "go"), lunaMsg(["auth-01"], "go again")] });
  seedWorker("auth-01");
  await off.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  await off.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(off.luna.calls.length, 1);
  assert.equal(off.counts.dispatch, 1);
  const fb = rig({ dec: [new ProviderError("timeout", "x")], luna: [lunaMsg(["auth-01"], "go2", { confidence: 0.95 }), lunaMsg(["auth-01"], "go3", { confidence: 0.95 })] });
  await fb.coordinator.handleLine("poke the login thing", { turnId: "t2" });
  await fb.coordinator.handleLine("poke the login thing", { turnId: "t2" });
  assert.equal(fb.dec.calls.length, 1);
  assert.equal(fb.luna.calls.length, 1);
  assert.equal(fb.counts.dispatch, 1);
}));

test("C-timeout-once: the real Decisions provider timing out on every attempt, then Luna routes: one dispatch, usage lines by api", () => inSandbox(async () => {
  const cfg = realCfg();
  const dFetch = decisionsFetch({ mode: "hang" });
  const lFetch = lunaFetch(lunaMsg(["auth-01"], "go", { confidence: 0.95 }));
  const decisionsProvider = createOpenAIDecisionsProvider({ cfg, meter: createMeter({ cfg, store, now: () => NOW, api: "decisions" }), fetch: dFetch, sleep: async () => {}, apiKey: "sk-test-0000" });
  const lunaProvider = createOpenAILunaProvider({ cfg, meter: createMeter({ cfg, store, now: () => NOW }), fetch: lFetch, sleep: async () => {}, apiKey: "sk-test-0000" });
  const r = rig({ cfg, decisionsProvider, lunaProvider, cost: () => createMeter({ cfg, store, now: () => NOW }).state() });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(out.path, "luna-fallback");
  assert.equal(r.counts.dispatch, 1);
  assert.equal(r.c.calls.message.length, 1);
  const usage = store.readJsonl("usage");
  const dec = usage.filter((u) => u.api === "decisions"), res = usage.filter((u) => u.api === "responses");
  assert.deepEqual(dec.map((u) => u.outcome), ["timeout", "timeout"], "1 + max_retries attempts, each charged");
  assert.equal(res.length, 1);
  assert.equal(res[0].outcome, "ok");
  assert.equal(dFetch.calls.length, 2);
  assert.equal(lFetch.calls, 1);
}));

// ---- M6 long messages and Codex eligibility ---------------------------------------------------------------------------

test("C-long: a 5000-character message routed to a worker is dispatched whole, and Decisions saw it whole", () => inSandbox(async () => {
  const msg = `please review ${"z".repeat(4986)}`;
  assert.equal(msg.length, 5000);
  const r = rig({ dec: [toWorker("auth-01")] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine(msg, { turnId: "t1" });
  assert.equal(out.path, "decisions");
  assert.equal(r.c.calls.message[0].text, msg);
  assert.ok(r.dec.calls[0].input.includes(`Message: ${msg}`));
  assert.equal(r.counts.dispatch, 1);
}));

test("C-too-long: a message over max_message_chars is the too-long reply, no model call", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("auth-01")], luna: [lunaMsg(["auth-01"], "go")] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine(`please review ${"z".repeat(6000)}`, { turnId: "t1" });
  assert.match(out.reply, /too long/);
  assert.match(out.reply, /Use \/to <id> <text>/);
  assert.equal(r.dec.calls.length, 0);
  assert.equal(r.luna.calls.length, 0);
  assert.equal(r.counts.dispatch, 0);
  assert.equal(out.path, "shortcuts-only");
}));

test("C-codex-eligible: only a working login with known quota and free capacity offers codex; with one choice the turn does not ask 'Claude or Codex?'", () => inSandbox(async () => {
  const states = {
    exhausted: { ...OK_CODEX, usage_status: "exhausted" }, "unknown quota": { ...OK_CODEX, usage_status: "unknown" },
    "full capacity": { ...OK_CODEX, capacity_available: false }, "no login": { ...OK_CODEX, available: false }, none: null,
  };
  let turn = 0;
  for (const [name, codexState] of Object.entries(states)) {
    const r = rig({ dec: [say({ route: ["new_session", 0.95, {}], provider: ["claude", 0.4, {}] })], codexState: () => codexState });
    const out = await r.coordinator.handleLine("start a worker to fix the login typo", { turnId: `t${++turn}` });
    assert.deepEqual(r.dec.calls[0].offered.provider, ["claude"], name);
    assert.deepEqual(r.dec.calls[0].questions.find((q) => q.name === "provider").choices.map((c) => c.value), ["claude"], name);
    assert.doesNotMatch(out.reply, /Claude or Codex/, name);
    assert.equal(r.counts.dispatch, 1, name);
    assert.equal(r.c.calls.create.length, 1, `${name}: a Claude worker was started`);
  }
  const ok = rig({ dec: [say({ route: ["new_session", 0.95, {}], provider: ["claude", 0.4, { codex: 0.6 }] })], codexState: () => OK_CODEX });
  const out = await ok.coordinator.handleLine("start a worker to fix the login typo", { turnId: "tok" });
  assert.deepEqual(ok.dec.calls[0].offered.provider, ["claude", "codex"]);
  assert.match(out.reply, /Should the new worker be Claude or Codex\?/, "two offered providers keep the margin rule");
  assert.equal(ok.counts.dispatch, 0);
}));

// ---- M7 Codex unavailable after selection -------------------------------------------------------------------------------

test("C-codex-late: Decisions picks codex while eligible, the dispatcher's gate says unavailable: the fallback reply, other workers untouched", () => inSandbox(async () => {
  const plan = say({ route: ["new_session", 0.95, {}], provider: ["codex", 0.95, {}] });
  const codex = fakeCodexAdapter({ start: blockedOutcome("unavailable", "codex-login-error", CFG) });
  const r = rig({ dec: [plan], codex, codexState: () => OK_CODEX });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("start a worker to fix the login typo", { turnId: "t1" });
  assert.equal(r.dec.calls[0].offered.provider.includes("codex"), true);
  assert.equal(codex.calls.start.length, 1, "the real dispatcher tried Codex");
  assert.match(out.reply, /Codex unavailable \(codex-login-error\): started a Claude worker instead/);
  assert.equal(r.c.calls.create.length, 1);
  assert.equal(r.c.calls.message.length, 0, "other workers untouched");
  assert.equal(r.counts.dispatch, 1);
  // with the refuse policy the same turn starts nothing
  const cfg = { ...DEFAULTS, codex: { ...DEFAULTS.codex, fallback: "refuse" } };
  const codex2 = fakeCodexAdapter({ start: blockedOutcome("unavailable", "codex-login-error", cfg) });
  const r2 = rig({ cfg, dec: [plan], codex: codex2, codexState: () => OK_CODEX });
  const out2 = await r2.coordinator.handleLine("start a worker to fix the login typo", { turnId: "t2" });
  assert.match(out2.reply, /No worker was started/);
  assert.equal(r2.c.calls.create.length, 0);
}));

// ---- M8 dead winner, decisions off ----------------------------------------------------------------------------------------

test("C-dead: the winner finished while Decisions was thinking: the advice reply, no dispatch, no Luna", () => inSandbox(async () => {
  const view = async (i, base) => {
    const ws = await base();
    return i === 0 ? ws : ws.map((w) => (w.id === "auth-01" ? { ...w, status: "finished" } : w));
  };
  const r = rig({ dec: [toWorker("auth-01")], view, luna: [lunaMsg(["auth-01"], "go")] });
  seedWorker("auth-01"); seedWorker("ui-02");
  const out = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(r.workersViewCalls(), 2, "the snapshot and the fresh view");
  assert.match(out.reply, /^auth-01 is finished\. Start a new one with \/new claude\|codex <label> <objective>\.$/);
  assert.equal(r.counts.dispatch, 0);
  assert.equal(r.c.calls.message.length, 0);
  assert.equal(r.luna.calls.length, 0);
  assert.equal(out.path, "decisions");
}));

test("C-off: decisions = null is today's Luna routing, path luna", () => inSandbox(async () => {
  const r = rig({ dec: null, luna: [lunaMsg(["auth-01"], "go")] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(out.path, "luna");
  assert.equal(r.luna.calls.length, 1);
  assert.equal(r.counts.dispatch, 1);
  assert.equal(lastExchange().path, "luna");
  assert.equal(lastExchange().route_p1, undefined);
  // the Luna bar is the ordinary one: 0.7 dispatches
  const r2 = rig({ dec: null, luna: [lunaMsg(["auth-01"], "go", { confidence: 0.7 })] });
  await r2.coordinator.handleLine("poke the login thing", { turnId: "t2" });
  assert.equal(r2.counts.dispatch, 1);
}));

// ---- M9 ledger ----------------------------------------------------------------------------------------------------------

test("C-ledger: every exchange carries its path; Decisions turns carry route_p1 and route_margin rounded to 3 decimals", () => inSandbox(async () => {
  let hard = false;
  const r = rig({ dec: [say({ route: ["auth-01", 0.9123, { "ui-02": 0.0456 }], concerns: { "auth-01": 0.9 } })], luna: [], cost: () => (hard ? { state: "hard", spent_usd: 10, soft: 7, hard: 10 } : null) });
  seedWorker("auth-01"); seedWorker("ui-02");
  await r.coordinator.handleLine("/to auth-01 hi", { turnId: "a" });
  await r.coordinator.handleLine("/status", { turnId: "b" });
  await r.coordinator.handleLine("/help", { turnId: "c" });
  await r.coordinator.handleLine("/to ghost-9 go", { turnId: "d" });
  await r.coordinator.handleLine("poke the login thing", { turnId: "e" });
  hard = true;
  const h = await r.coordinator.handleLine("poke the login thing", { turnId: "f" });
  assert.equal(h.path, "shortcuts-only");
  const byTurn = Object.fromEntries(exchanges().map((e) => [e.turn_id, e]));
  assert.deepEqual(["a", "b", "c", "d", "e", "f"].map((k) => byTurn[k].path), ["shortcut", "shortcut", "command", "error", "decisions", "shortcuts-only"]);
  assert.equal(byTurn.e.route_p1, 0.912);
  assert.equal(byTurn.e.route_margin, 0.867);
  for (const k of ["a", "b", "c", "d", "f"]) assert.equal(byTurn[k].route_p1, undefined, k);
  assert.equal(r.dec.calls.length, 1, "the hard-limit turn made no Decisions call");
  assert.equal(r.luna.calls.length, 0);
}));

// ---- M10 one cleaned line -----------------------------------------------------------------------------------------------

test("C-clean: the line is cleaned once; Decisions, the dispatched instruction and the Luna fallback all see the cleaned text", () => inSandbox(async () => {
  const dirty = "tell the other one\u202e to fix\u0007it";
  const cleaned = "tell the other one to fix it";
  const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
  const r = rig({ dec: [toWorker("ui-02"), new ProviderError("timeout", "x")], luna: [(input) => lunaMsg(["auth-01"], input.message, { confidence: 0.95 })] });
  seedWorker("auth-01"); seedWorker("ui-02"); seedHistory(); focusOn("auth-01");
  const a = await r.coordinator.handleLine(dirty, { turnId: "t1" });
  assert.equal(a.path, "decisions");
  assert.match(r.dec.calls[0].input, new RegExp(`^Message: ${cleaned}$`, "m"));
  assert.ok(!bad.test(r.dec.calls[0].input));
  assert.deepEqual(r.c.calls.message.map((m) => [m.worker, m.text]), [["ui-02", cleaned]]);
  assert.equal(a.decision.worker_instruction, cleaned);
  // the fallback gets the same cleaned line
  const b = await r.coordinator.handleLine(dirty, { turnId: "t2" });
  assert.equal(b.path, "luna-fallback");
  assert.equal(r.luna.calls[0].message, cleaned);
  assert.equal(r.c.calls.message[1].text, cleaned);
  // escape sequences go too, whole
  const r2 = rig({ dec: [toWorker("auth-01")] });
  seedWorker("auth-01");
  await r2.coordinator.handleLine("poke the \u001b[31mlogin\u001b[0m \u001b]8;;http://x.example\u0007thing\u001b]8;;\u0007\u009b2K now", { turnId: "t3" });
  assert.equal(r2.c.calls.message[0].text, "poke the login thing now");
  // shortcut and command paths keep the raw line
  const r3 = rig({ dec: [] });
  seedWorker("auth-01");
  await r3.coordinator.handleLine("/to auth-01 keep\u0007this", { turnId: "t4" });
  assert.equal(r3.dec.calls.length, 0);
  assert.match(lastExchange().reply, /Cannot do that: control-char/);
}));

// ---- fix round: per-turn lastEvent, fresh view, blank line --------------------------------------------------------------

test("C-last-event: a notice shows as 'Last event' in the next model turn's Decisions input, and the turn after shows none", () => inSandbox(async () => {
  const events = [[{ type: "started", worker_id: "cx-07" }], []];
  const r = rig({ dec: [toWorker("auth-01"), toWorker("auth-01"), toWorker("auth-01")], poll: async () => events.shift() ?? [] });
  seedWorker("auth-01");
  await r.coordinator.handleLine("poke the login thing", { turnId: "t0" });
  assert.match(r.dec.calls[0].input, /^Last event: none$/m);
  const tick = await r.coordinator.tick();
  assert.deepEqual(tick.notices, ["cx-07: queued Codex run started"]);
  const a = await r.coordinator.handleLine("poke the login thing again", { turnId: "t1" });
  assert.match(r.dec.calls[1].input, /^Last event: cx-07: queued Codex run started$/m);
  assert.deepEqual(a.notices, ["cx-07: queued Codex run started"]);
  const b = await r.coordinator.handleLine("poke the login thing once more", { turnId: "t2" });
  assert.match(r.dec.calls[2].input, /^Last event: none$/m);
  assert.deepEqual(b.notices, []);
}));

test("C-fresh-view-run: validation and dispatch use the fresh workers list (decision route and the brief writer route)", () => inSandbox(async () => {
  // the snapshot holds a live 'fix-login-typo'; by the fresh view it finished, so the label is free only in the fresh list
  const view = async (i, base) => {
    const ws = await base();
    return i === 0 ? ws : ws.map((x) => (x.id === "old-worker-01" ? { ...x, status: "finished" } : x));
  };
  const lines = [["start a worker to fix the login typo", "fix-login-typo"], [`start a worker to repair the login typo ${"and be careful ".repeat(40)}`, "repair-login-typo"]];
  for (const [k, [line, label]] of lines.entries()) {
    const r = rig({ dec: [say({ route: ["new_session", 0.95, {}] })], view });
    seedWorker("old-worker-01", "claude", { label });
    seedWorker("auth-01");
    const out = await r.coordinator.handleLine(line, { turnId: `t${k}` });
    assert.equal(r.counts.dispatch, 1, `line ${k}: validated against the fresh list, not clarified`);
    assert.equal(out.decision.new_session.label, label, `line ${k}`);
    const given = r.counts.args[0][1].workers;
    assert.equal(given.find((x) => x.id === "old-worker-01").status, "finished", `line ${k}: the dispatcher got the fresh list`);
    assert.equal(r.workersViewCalls() >= 2, true);
  }
}));

test("C-blank-line: a line that cleans to blank makes no model call and is the shortcuts-only reply", () => inSandbox(async () => {
  const r = rig({ dec: [toWorker("auth-01")], luna: [lunaMsg(["auth-01"], "go")] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("\u0007\u001b]0;title\u0007\u001b[31m", { turnId: "t1" });
  assert.equal(out.path, "shortcuts-only");
  assert.match(out.reply, /^I got no text to route\. /);
  assert.equal(r.dec.calls.length, 0);
  assert.equal(r.luna.calls.length, 0);
  assert.equal(r.counts.dispatch, 0);
  assert.equal(lastExchange().path, "shortcuts-only");
}));

// ---- Task 4b: the route-pinned Luna writer ----------------------------------------------------------------------------

const NEW_LINE = "start a new worker to design the auth architecture";
const newBrief = say({ route: ["new_session", 0.95, {}], needs: 0.95 });
const writerCreate = (o = {}) => emptyDecision({ action: "create_session", new_session: { needed: true, provider: "claude", label: o.label ?? "auth-design", objective: o.objective ?? "Design the auth architecture: sessions, tokens, rotation." },
  worker_instruction: o.instruction ?? "Start with a one-page design; list open questions first.", reply: o.reply ?? "", confidence: 0.9 });
const throwing = (e) => () => { throw e; };
const tightCfg = { ...CFG, context: { ...CFG.context, max_tokens: 50 } };

test("C-path-writer: the new-worker line is 1 Decisions call + 1 Luna call; create_session carries the writer's label, objective and instruction and the Decisions provider", () => inSandbox(async () => {
  const r = rig({ dec: [newBrief], luna: [writerCreate()] });
  seedWorker("ui-02");
  const out = await r.coordinator.handleLine(NEW_LINE, { turnId: "t1" });
  assert.equal(r.dec.calls.length, 1);
  assert.equal(r.luna.calls.length, 1);
  assert.equal(r.counts.dispatch, 1);
  assert.deepEqual(r.luna.calls[0].pinned_route, { action: "create_session", target_session_ids: [], provider: "claude", write: "brief" });
  const d = r.counts.args[0][0];
  assert.equal(d.action, "create_session");
  assert.equal(d.new_session.label, "auth-design");
  assert.equal(d.new_session.objective, "Design the auth architecture: sessions, tokens, rotation.");
  assert.equal(d.worker_instruction, "Start with a one-page design; list open questions first.");
  assert.equal(d.new_session.provider, "claude");
  assert.equal(r.c.calls.create.length, 1);
  assert.equal(out.path, "decisions");
  assert.equal(lastExchange().action, "create_session");
}));

test("C-pin: a writer answer with another action, targets, provider and needed flag cannot change the route", () => inSandbox(async () => {
  const sly = emptyDecision({ action: "message_session", target_session_ids: ["auth-01"], worker_instruction: "do this instead",
    new_session: { needed: false, provider: "codex", label: "sly-label", objective: "sly objective" }, confidence: 0.99, clarification: "x", reply: "hijack" });
  const r = rig({ dec: [newBrief], luna: [sly] });
  seedWorker("ui-02");
  await r.coordinator.handleLine(NEW_LINE, { turnId: "t1" });
  assert.equal(r.counts.dispatch, 1);
  const d = r.counts.args[0][0];
  assert.equal(d.action, "create_session");
  assert.deepEqual(d.target_session_ids, []);
  assert.equal(d.new_session.needed, true);
  assert.equal(d.new_session.provider, "claude");
  assert.equal(d.new_session.label, "sly-label"); // a writer-owned field
  assert.equal(d.reply, "");
  assert.equal(d.clarification, null);
  assert.equal(r.c.calls.message.length, 0);
  assert.equal(r.c.calls.create.length, 1);
}));

test("C-respond: for respond only the reply is used; instruction and new_session fields are dropped", () => inSandbox(async () => {
  const w = emptyDecision({ action: "respond", reply: "The coordinator routes your messages; it never runs them.", worker_instruction: "run rm -rf",
    new_session: { needed: true, provider: "codex", label: "bad-label", objective: "bad" }, target_session_ids: ["auth-01"] });
  const r = rig({ dec: [say({ route: ["respond", 0.95, {}] })], luna: [w] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("what do you do exactly", { turnId: "t1" });
  assert.deepEqual(r.luna.calls[0].pinned_route, { action: "respond", target_session_ids: [], provider: null, write: "reply" });
  assert.equal(out.reply, "The coordinator routes your messages; it never runs them.");
  assert.equal(out.decision.action, "respond");
  assert.equal(out.decision.worker_instruction, null);
  assert.deepEqual(out.decision.target_session_ids, []);
  assert.equal(out.decision.new_session.needed, false);
  assert.equal(r.c.calls.create.length + r.c.calls.message.length, 0);
  assert.equal(lastExchange().reply, out.reply);
}));

test("C-writer-reask: an invalid first answer gets one re-ask with the error codes; the second answer is dispatched once", () => inSandbox(async () => {
  const r = rig({ dec: [newBrief], luna: [writerCreate({ label: "Bad Label!" }), writerCreate({ label: "auth-design-2" })] });
  seedWorker("ui-02");
  await r.coordinator.handleLine(NEW_LINE, { turnId: "t1" });
  assert.equal(r.luna.calls.length, 2);
  assert.equal(r.luna.calls[0].validation_errors, undefined);
  assert.ok(r.luna.calls[1].validation_errors.some((e) => e.field === "new_session.label"));
  assert.deepEqual(r.luna.calls[1].pinned_route, r.luna.calls[0].pinned_route);
  assert.equal(r.counts.dispatch, 1);
  assert.equal(r.counts.args[0][0].new_session.label, "auth-design-2");
}));

test("C-respond-blank: a respond writer that returns no text is invalid, then the code clarify", () => inSandbox(async () => {
  const r = rig({ dec: [say({ route: ["respond", 0.95, {}] })], luna: [emptyDecision({ action: "respond", reply: "  " }), emptyDecision({ action: "respond", reply: "" })] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("what do you do exactly", { turnId: "t1" });
  assert.equal(r.luna.calls.length, 2);
  assert.match(out.reply, /^I could not write an answer\. Use \/to/);
  assert.equal(r.counts.dispatch, 0);
  assert.equal(lastExchange().action, "clarify");
}));

/** Every writer failure on the brief route: the code-built create is dispatched once, an exchange line is written. */
function briefFail(opts) {
  return inSandbox(async () => {
    const r = rig({ dec: [newBrief], ...opts });
    seedWorker("ui-02");
    const out = await r.coordinator.handleLine(NEW_LINE, { turnId: "t1" });
    assert.equal(r.dec.calls.length, 1);
    assert.equal(r.counts.dispatch, 1, "one dispatch whatever the writer did");
    const d = r.counts.args[0][0];
    assert.equal(d.action, "create_session");
    assert.equal(d.new_session.objective, NEW_LINE, "the code-built objective");
    assert.match(d.new_session.label, /^[a-z]/);
    assert.notEqual(d.new_session.label, "auth-design");
    assert.equal(d.worker_instruction, null);
    assert.equal(r.c.calls.create.length, 1);
    assert.equal(out.path, "decisions");
    assert.equal(exchanges().filter((e) => e.turn_id === "t1").length, 1);
    assert.equal(lastExchange().action, "create_session");
    return r;
  });
}

test("C-writer-fail-providererror: a ProviderError from the writer dispatches the code-built brief", () => briefFail({ luna: [throwing(new ProviderError("timeout", "slow"))] }));
test("C-writer-fail-overbudget: a writer input over budget dispatches the code-built brief, no Luna call", () => briefFail({ luna: [writerCreate()], cfg: tightCfg }));
test("C-writer-fail-invalid-twice: two invalid answers dispatch the code-built brief", () => briefFail({ luna: [writerCreate({ label: "Bad Label!" }), writerCreate({ label: "also bad!" })] }));
test("C-writer-fail-reask-throws: a first invalid answer whose re-ask throws ProviderError dispatches the code-built brief", () => briefFail({ luna: [writerCreate({ label: "Bad Label!" }), throwing(new ProviderError("http-503", "down"))] }));
test("C-writer-fail-reask-overbudget: a re-ask that cannot be built dispatches the code-built brief", () => inSandbox(async () => {
  // the budget is tiny only after the first writer call, so the first input is built and the re-ask throws context-over-budget
  const flag = { tight: false };
  const cfg = { ...CFG };
  Object.defineProperty(cfg, "context", { get: () => (flag.tight ? tightCfg.context : CFG.context) });
  const first = () => { flag.tight = true; return writerCreate({ label: "Bad Label!" }); };
  const r = rig({ dec: [newBrief], luna: [first, writerCreate()], cfg });
  seedWorker("ui-02");
  const out = await r.coordinator.handleLine(NEW_LINE, { turnId: "t2" });
  assert.equal(r.luna.calls.length, 1, "the re-ask was never sent");
  assert.equal(r.counts.dispatch, 1);
  assert.equal(r.counts.args[0][0].new_session.objective, NEW_LINE);
  assert.equal(out.decision.worker_instruction, null);
}));

test("C-writer-fail-reply: on the reply route a ProviderError and a context overflow say Luna is unavailable; two invalid answers give the code clarify; nothing is dispatched", async () => {
  const bad = () => emptyDecision({ action: "respond", reply: "bad\u0007text" });
  const cases = [
    [{ luna: [throwing(new ProviderError("timeout", "slow"))] }, /^Luna is unavailable \(timeout\)\. Use \/to/],
    [{ luna: [emptyDecision({ action: "respond", reply: "ok" })], cfg: tightCfg }, /^Luna is unavailable \(context-over-budget\)\. Use \/to/],
    [{ luna: [bad(), bad()] }, /^I could not write an answer\. Use \/to/],
    [{ luna: [bad(), throwing(new ProviderError("http-500", "down"))] }, /^Luna is unavailable \(http-500\)\. Use \/to/],
  ];
  for (const [opts, re] of cases) {
    await inSandbox(async () => {
      const r = rig({ dec: [say({ route: ["respond", 0.95, {}] })], ...opts });
      seedWorker("auth-01");
      const out = await r.coordinator.handleLine("what do you do exactly", { turnId: "t1" });
      assert.match(out.reply, re);
      assert.equal(r.counts.dispatch, 0);
      assert.equal(lastExchange().action, "clarify");
      assert.equal(lastExchange().reply, out.reply);
    });
  }
});

test("C-writer-rethrow: a writer error that is not a ProviderError is not swallowed", () => inSandbox(async () => {
  const r = rig({ dec: [newBrief], luna: [throwing(new TypeError("bug"))] });
  seedWorker("ui-02");
  await assert.rejects(() => r.coordinator.handleLine(NEW_LINE, { turnId: "t1" }), /bug/);
  assert.equal(r.counts.dispatch, 0);
}));

test("C-writer-fresh-view: the writer's decision is validated and dispatched against the fresh workers list", () => inSandbox(async () => {
  // the label 'auth-design' is held by a worker that is live in the snapshot and finished in the fresh view
  const view = async (i, base) => {
    const ws = await base();
    return i === 0 ? ws : ws.map((x) => (x.id === "old-worker-01" ? { ...x, status: "finished" } : x));
  };
  const r = rig({ dec: [newBrief], luna: [writerCreate({ label: "auth-design" })], view });
  seedWorker("old-worker-01", "claude", { label: "auth-design" });
  seedWorker("ui-02");
  await r.coordinator.handleLine(NEW_LINE, { turnId: "t1" });
  assert.equal(r.luna.calls.length, 1, "no re-ask: valid against the fresh list");
  assert.equal(r.counts.dispatch, 1);
  assert.equal(r.counts.args[0][1].workers.find((x) => x.id === "old-worker-01").status, "finished");
}));
