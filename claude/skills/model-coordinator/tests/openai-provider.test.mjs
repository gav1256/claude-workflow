import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenAILunaProvider, ConfigError } from "../openai-provider.mjs";
import { createMeter, callCost, worstCase, SpendBlocked } from "../cost.mjs";
import { ProviderError, ConfigError as BaseConfigError } from "../provider.mjs";
import { DECISION_SCHEMA, emptyDecision } from "../schema.mjs";
import * as store from "../store.mjs";

const KEY = "sk-test-FAKE-KEY-0123456789";
const PRICE = { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4 };
const NOW = Date.UTC(2026, 9, 7, 12);
const mkCfg = (over = {}) => ({
  provider: "openai",
  openai: { model: "gpt-6-luna", key_file: null, reasoning_effort: "none", timeout_ms: 50, max_retries: 2, max_output_tokens: 600, ...(over.openai ?? {}) },
  pricing: { "gpt-6-luna": PRICE },
  limits: { monthly_soft_usd: 7, monthly_hard_usd: 10 },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "openai")),
});
const INPUT = { v: 1, instructions: "be Luna", project: { name: "p" }, workers: [], focused_session_id: null, referents: {}, exchanges: [], message: "status?" };
const USAGE = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 200 };

function okBody(decision = emptyDecision({ reply: "hi" }), usage = USAGE) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision) }] }], usage };
}
const resp = (status, json, headers = {}) => ({ status, headers, json });

/** A fake fetch driven by a script of {status, headers, json|text}, "hang" or "network". It records every call. */
function fakeFetch(script) {
  const calls = [];
  let i = 0;
  const f = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const step = script[Math.min(i++, script.length - 1)];
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "hang") {
      return new Promise((_, reject) => {
        const err = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init.signal.aborted) err(); else init.signal.addEventListener("abort", err, { once: true });
      });
    }
    const h = Object.fromEntries(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const text = step.text ?? JSON.stringify(step.json ?? {});
    return { ok: step.status >= 200 && step.status < 300, status: step.status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) };
  };
  f.calls = calls;
  return f;
}

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-oai-"));
  const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, key: process.env.OPENAI_API_KEY };
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.OPENAI_API_KEY;
  return { dir, done() {
    if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
function setup(over = {}, script = [resp(200, okBody())], extra = {}) {
  const e = env();
  const cfg = mkCfg(over);
  const meter = createMeter({ cfg, store, now: () => NOW });
  const fetch = fakeFetch(script);
  const sleeps = [];
  const provider = createOpenAILunaProvider({ cfg, meter, fetch, sleep: async (ms) => { sleeps.push(ms); }, apiKey: KEY, ...extra });
  return { ...e, cfg, meter, fetch, sleeps, provider };
}
const usage = () => store.readJsonl("usage");

test("M3 constructor fails closed: provider none, no key, no price table", () => {
  const e = env();
  try {
    const cfg = mkCfg();
    const meter = createMeter({ cfg, store });
    const make = (c, o = {}) => () => createOpenAILunaProvider({ cfg: c, meter, fetch: fakeFetch([]), ...o });
    assert.throws(make({ ...cfg, provider: "none" }, { apiKey: KEY }), ConfigError);
    assert.throws(make(cfg), (x) => x instanceof ConfigError && /key/i.test(x.message)); // no key anywhere
    assert.throws(make({ ...cfg, pricing: {} }, { apiKey: KEY }), (x) => x instanceof ConfigError && /pric/i.test(x.message));
    assert.throws(make({ ...cfg, pricing: { "gpt-6-luna": { input_per_mtok: 1 } } }, { apiKey: KEY }), ConfigError);
    assert.throws(make(cfg, { apiKey: "   " }), ConfigError);
    assert.doesNotThrow(make(cfg, { apiKey: KEY }));
  } finally { e.done(); }
});

test("M3 key comes from OPENAI_API_KEY, or from key_file inside secrets/, never from outside", () => {
  const e = env();
  try {
    const cfg = mkCfg();
    const meter = createMeter({ cfg, store });
    const mk = (c) => () => createOpenAILunaProvider({ cfg: c, meter, fetch: fakeFetch([]) });
    process.env.OPENAI_API_KEY = KEY;
    assert.doesNotThrow(mk(cfg));
    delete process.env.OPENAI_API_KEY;
    const secrets = path.join(e.dir, "secrets");
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, "openai.key"), KEY + "\n");
    fs.writeFileSync(path.join(e.dir, "outside.key"), KEY);
    assert.doesNotThrow(mk(mkCfg({ openai: { key_file: "openai.key" } })));
    assert.doesNotThrow(mk(mkCfg({ openai: { key_file: path.join(secrets, "openai.key") } })));
    assert.throws(mk(mkCfg({ openai: { key_file: "../outside.key" } })), ConfigError);
    assert.throws(mk(mkCfg({ openai: { key_file: path.join(e.dir, "outside.key") } })), ConfigError);
    assert.throws(mk(mkCfg({ openai: { key_file: "missing.key" } })), ConfigError);
    fs.writeFileSync(path.join(secrets, "empty.key"), "\n");
    assert.throws(mk(mkCfg({ openai: { key_file: "empty.key" } })), ConfigError);
  } finally { e.done(); }
});

test("M4 request shape: model, reasoning none, strict schema, no tools, bearer key, store false", async () => {
  const s = setup();
  try {
    const d = await s.provider.decide(INPUT);
    assert.equal(d.reply, "hi");
    assert.equal(s.fetch.calls.length, 1);
    const { url, init, body } = s.fetch.calls[0];
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 600);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, "coordinator_decision");
    assert.deepEqual(body.text.format.schema, DECISION_SCHEMA);
    assert.ok(!("tools" in body) && !("tool_choice" in body));
    assert.deepEqual(body.input[0], { role: "developer", content: "be Luna" });
    assert.equal(body.input[1].role, "user");
    const user = JSON.parse(body.input[1].content);
    assert.ok(!("instructions" in user));
    assert.equal(user.message, "status?");
  } finally { s.done(); }
});

test("M4 reasoning_effort low is sent; null omits the reasoning key", async () => {
  const low = setup({ openai: { reasoning_effort: "low" } });
  try { await low.provider.decide(INPUT); assert.equal(low.fetch.calls[0].body.reasoning.effort, "low"); } finally { low.done(); }
  const none = setup({ openai: { reasoning_effort: null } });
  try { await none.provider.decide(INPUT); assert.ok(!("reasoning" in none.fetch.calls[0].body)); } finally { none.done(); }
});

test("M5 429 with retry-after 2 then 200: sleep 2000, two usage lines, retries 1 on the second", async () => {
  const s = setup({}, [resp(429, { error: { message: "slow down" } }, { "Retry-After": "2" }), resp(200, okBody())]);
  try {
    const d = await s.provider.decide(INPUT);
    assert.equal(d.reply, "hi");
    assert.equal(s.fetch.calls.length, 2);
    assert.deepEqual(s.sleeps, [2000]);
    const u = usage();
    assert.equal(u.length, 2);
    assert.equal(u[0].retries, 0);
    assert.equal(u[0].outcome, "http-429");
    assert.equal(u[1].retries, 1);
    assert.equal(u[1].attempt, 2);
    assert.equal(u[1].outcome, "ok");
    assert.equal(u[0].request_id, u[1].request_id);
  } finally { s.done(); }
});

test("429 without retry-after backs off 500 * 2^n; retry-after is capped at 20 s", async () => {
  const a = setup({}, [resp(429, {}), resp(429, {}), resp(200, okBody())]);
  try { await a.provider.decide(INPUT); assert.deepEqual(a.sleeps, [500, 1000]); } finally { a.done(); }
  const b = setup({}, [resp(429, {}, { "retry-after": "600" }), resp(200, okBody())]);
  try { await b.provider.decide(INPUT); assert.deepEqual(b.sleeps, [20000]); } finally { b.done(); }
});

test("M6 three 503s throw http-503 after exactly 3 fetches; a 401 throws after 1", async () => {
  const a = setup({}, [resp(503, {})]);
  try {
    await assert.rejects(a.provider.decide(INPUT), (e) => e instanceof ProviderError && e.code === "http-503");
    assert.equal(a.fetch.calls.length, 3);
    assert.equal(usage().length, 3);
    assert.equal(a.sleeps.length, 2, "no sleep after the last attempt");
  } finally { a.done(); }
  for (const status of [400, 401, 403, 404]) {
    const b = setup({}, [resp(status, { error: { message: "nope" } })]);
    try {
      await assert.rejects(b.provider.decide(INPUT), (e) => e instanceof ProviderError && e.code === `http-${status}` && e.retryable === false);
      assert.equal(b.fetch.calls.length, 1, `status ${status}`);
    } finally { b.done(); }
  }
});

test("network errors are retried, then give code network", async () => {
  const s = setup({}, ["network"]);
  try {
    await assert.rejects(s.provider.decide(INPUT), (e) => e instanceof ProviderError && e.code === "network");
    assert.equal(s.fetch.calls.length, 3);
    for (const u of usage()) assert.equal(u.estimated, true);
  } finally { s.done(); }
});

test("M7 a fetch that never resolves times out after 1 + max_retries attempts, each charged the worst case", async () => {
  const s = setup({ openai: { timeout_ms: 20 } }, ["hang"]);
  try {
    await assert.rejects(s.provider.decide(INPUT), (e) => e instanceof ProviderError && e.code === "timeout");
    assert.equal(s.fetch.calls.length, 3);
    const u = usage();
    assert.equal(u.length, 3);
    for (const line of u) {
      assert.equal(line.estimated, true);
      assert.equal(line.outcome, "timeout");
      assert.equal(line.input_tokens, null);
      assert.ok(line.cost_usd > worstCase(PRICE, 0, 600), "worst case includes the input estimate");
    }
    assert.equal(u[0].cost_usd, u[1].cost_usd);
  } finally { s.done(); }
});

test("M8 hard limit stops the call before any fetch", async () => {
  const s = setup();
  try {
    store.appendJsonl("usage", { month: "2026-10", cost_usd: 9.99999 });
    await assert.rejects(s.provider.decide(INPUT), (e) => e instanceof SpendBlocked && e instanceof ProviderError && e.code === "hard-limit");
    assert.equal(s.fetch.calls.length, 0);
    assert.equal(usage().length, 1, "nothing recorded for a call that never started");
  } finally { s.done(); }
});

test("hard limit is checked again before each retry", async () => {
  const s = setup({}, [resp(503, {}), resp(200, okBody())]);
  try {
    // the first (failed) attempt is charged its worst case; make that cross the limit
    store.appendJsonl("usage", { month: "2026-10", cost_usd: 9.995 });
    await assert.rejects(s.provider.decide(INPUT), (e) => e instanceof SpendBlocked);
    assert.equal(s.fetch.calls.length, 1);
  } finally { s.done(); }
});

test("M9 refusal, incomplete and non-JSON output_text each give their code", async () => {
  const refusal = { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot" }] }], usage: USAGE };
  const incomplete = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: USAGE };
  const notJson = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "not { json" }] }], usage: USAGE };
  const noMessage = { status: "completed", output: [{ type: "reasoning" }], usage: USAGE };
  for (const [body, code] of [[refusal, "refusal"], [incomplete, "incomplete"], [notJson, "not-json"], [noMessage, "bad-response"]]) {
    const s = setup({}, [resp(200, body)]);
    try {
      await assert.rejects(s.provider.decide(INPUT), (e) => e instanceof ProviderError && e.code === code, code);
      assert.equal(s.fetch.calls.length, 1, `${code} is not retried`);
      assert.equal(usage().length, 1, `${code} is still charged from its usage`);
      assert.equal(usage()[0].estimated, false);
    } finally { s.done(); }
  }
});

test("a 200 whose body is not JSON is charged the worst case and fails with bad-response", async () => {
  const s = setup({}, [{ status: 200, text: "<html>oops</html>" }]);
  try {
    await assert.rejects(s.provider.decide(INPUT), (e) => e instanceof ProviderError && e.code === "bad-response");
    assert.equal(usage()[0].estimated, true);
  } finally { s.done(); }
});

test("M10 the usage line matches callCost for the fake usage", async () => {
  const s = setup();
  try {
    await s.provider.decide(INPUT);
    const [u] = usage();
    assert.equal(u.input_tokens, 1000);
    assert.equal(u.cached_input_tokens, 400);
    assert.equal(u.output_tokens, 200);
    assert.equal(typeof u.latency_ms, "number");
    assert.equal(u.retries, 0);
    assert.equal(u.cost_usd, callCost(PRICE, { input: 1000, cached: 400, output: 200 }));
    assert.equal(u.estimated, false);
    assert.equal(s.meter.state().spent_usd, u.cost_usd);
  } finally { s.done(); }
});

test("M11 a 400 about reasoning throws reasoning-unsupported after 1 fetch and names the config knob", async () => {
  const body = { error: { message: "Unsupported value: 'reasoning.effort' does not support 'none'" } };
  const s = setup({}, [resp(400, body)]);
  try {
    await assert.rejects(s.provider.decide(INPUT), (e) => e instanceof ProviderError && e.code === "reasoning-unsupported"
      && /openai\.reasoning_effort/.test(e.message) && /none/.test(e.message));
    assert.equal(s.fetch.calls.length, 1);
  } finally { s.done(); }
});

test("a 400 that does not mention reasoning is a plain http-400", async () => {
  const s = setup({}, [resp(400, { error: { message: "bad schema" } })]);
  try { await assert.rejects(s.provider.decide(INPUT), (e) => e.code === "http-400"); } finally { s.done(); }
});

test("secrets never reach the usage ledger or an error message", async () => {
  const s = setup({}, [resp(401, { error: { message: `Incorrect API key provided: ${KEY}` } })]);
  try {
    await assert.rejects(s.provider.decide(INPUT), (e) => !String(e.message).includes(KEY) && !String(e.stack).includes(KEY));
    const f = path.join(s.dir, "state", "model-coordinator");
    for (const n of fs.readdirSync(f)) assert.ok(!fs.readFileSync(path.join(f, n), "utf8").includes(KEY), n);
  } finally { s.done(); }
});

test("R1 constructor needs max_output_tokens a positive integer, max_retries an integer >= 0, timeout_ms a positive finite number", () => {
  const e = env();
  try {
    const mk = (openai) => () => { const cfg = mkCfg({ openai }); return createOpenAILunaProvider({ cfg, meter: createMeter({ cfg, store }), fetch: fakeFetch([]), apiKey: KEY }); };
    for (const v of [null, undefined, 0, -1, 1.5, "600", NaN, Infinity]) assert.throws(mk({ max_output_tokens: v }), ConfigError, `max_output_tokens ${String(v)}`);
    for (const v of [null, undefined, -1, 1.5, "2", NaN, Infinity]) assert.throws(mk({ max_retries: v }), ConfigError, `max_retries ${String(v)}`);
    for (const v of [null, undefined, 0, -5, "20000", NaN, Infinity]) assert.throws(mk({ timeout_ms: v }), ConfigError, `timeout_ms ${String(v)}`);
    assert.doesNotThrow(mk({ max_retries: 0 }));
    assert.doesNotThrow(mk({ max_output_tokens: 1, timeout_ms: 0.5 }));
  } finally { e.done(); }
});

test("R2 a 200 that is incomplete, a refusal or non-JSON is recorded with that outcome, tokens unchanged", async () => {
  const refusal = { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot" }] }], usage: USAGE };
  const incomplete = { status: "incomplete", output: [], usage: USAGE };
  const notJson = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "not { json" }] }], usage: USAGE };
  for (const [body, outcome] of [[refusal, "refusal"], [incomplete, "incomplete"], [notJson, "not-json"]]) {
    const s = setup({}, [resp(200, body)]);
    try {
      await assert.rejects(s.provider.decide(INPUT), (x) => x.code === outcome);
      const [u] = usage();
      assert.equal(u.outcome, outcome);
      assert.equal(u.input_tokens, 1000);
      assert.equal(u.cost_usd, callCost(PRICE, { input: 1000, cached: 400, output: 200 }));
      assert.equal(u.estimated, false);
    } finally { s.done(); }
  }
  const ok = setup();
  try { await ok.provider.decide(INPUT); assert.equal(usage()[0].outcome, "ok"); } finally { ok.done(); }
});

test("R4 ConfigError has one home: the class from openai-provider is the one in provider.mjs", () => {
  assert.equal(ConfigError, BaseConfigError);
  const e = env();
  try {
    const cfg = mkCfg({});
    assert.throws(() => createOpenAILunaProvider({ cfg: { ...cfg, provider: "none" }, meter: createMeter({ cfg, store }), fetch: fakeFetch([]), apiKey: KEY }),
      (x) => x instanceof BaseConfigError && x instanceof Error && x.name === "ConfigError");
  } finally { e.done(); }
});

test("R6 an empty OPENAI_API_KEY counts as unset: a valid key_file is used; with neither it still fails closed", () => {
  const e = env();
  try {
    const secrets = path.join(e.dir, "secrets");
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, "openai.key"), KEY);
    const mk = (cfg) => () => createOpenAILunaProvider({ cfg, meter: createMeter({ cfg, store }), fetch: fakeFetch([]) });
    for (const empty of ["", "   "]) {
      process.env.OPENAI_API_KEY = empty;
      assert.doesNotThrow(mk(mkCfg({ openai: { key_file: "openai.key" } })), `env ${JSON.stringify(empty)}`);
      assert.throws(mk(mkCfg()), ConfigError);
    }
  } finally { e.done(); }
});
