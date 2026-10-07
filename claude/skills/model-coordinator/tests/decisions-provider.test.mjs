import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenAIDecisionsProvider } from "../decisions-provider.mjs";
import { createMeter, SpendBlocked } from "../cost.mjs";
import { ProviderError, ConfigError, MockDecisionsProvider } from "../provider.mjs";

const KEY = "sk-test-0000";
const NOW = Date.UTC(2026, 9, 7, 12);
const mkCfg = (over = {}) => ({
  provider: "openai",
  openai: { model: "gpt-6-luna", key_file: null, reasoning_effort: "none", timeout_ms: 50, max_retries: 1, max_output_tokens: 600 },
  decisions: { enabled: true, model: "gpt-6-luna", timeout_ms: 50, max_retries: 1 },
  pricing: { "gpt-6-luna": { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4, decisions_input_per_mtok: 0.1 } },
  limits: { monthly_soft_usd: 7, monthly_hard_usd: 10 },
  ...over,
});
const QUESTIONS = [
  { type: "choice", name: "route", instructions: "Which worker?", choices: [{ value: "w1", description: "one" }, { value: "w2", description: "two" }, { value: "none", description: "nobody" }] },
  { type: "predicate", name: "needs_text", instructions: "Does it need a written reply?" },
];
const REQ = { input: "status of w1?", questions: QUESTIONS };
const routeAns = (over = {}) => ({ type: "choice", name: "route", choice: "w1", confidence: 0.9,
  probabilities: [{ value: "w1", probability: 0.9 }, { value: "w2", probability: 0.07 }, { value: "none", probability: 0.03 }], ...over });
const predAns = (over = {}) => ({ type: "predicate", name: "needs_text", choice: "true", confidence: 0.7,
  probabilities: [{ value: true, probability: 0.7 }, { value: false, probability: 0.3 }], ...over });
const okBody = (answers = [routeAns(), predAns()], usage = { input_tokens: 1000000 }) => ({ answers, model: "gpt-6-luna", usage });
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
    return { ok: step.status >= 200 && step.status < 300, status: step.status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, text: async () => text };
  };
  f.calls = calls;
  return f;
}

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dec-"));
  const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, key: process.env.OPENAI_API_KEY };
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.OPENAI_API_KEY;
  return { dir, done() {
    if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
const fakeStore = (lines = []) => ({ lines, readJsonl: () => lines, appendJsonl: (n, o) => lines.push(o) });
function setup(script = [resp(200, okBody())], { cfg = mkCfg(), lines = [], extra = {} } = {}) {
  const e = env();
  const store = fakeStore(lines);
  const meter = createMeter({ cfg, store, now: () => NOW, api: "decisions" });
  const checks = [];
  const counting = { ...meter, check: (n) => { checks.push(n); return meter.check(n); } };
  const fetch = fakeFetch(script);
  const sleeps = [];
  const provider = createOpenAIDecisionsProvider({ cfg, meter: counting, fetch, sleep: async (ms) => { sleeps.push(ms); }, apiKey: KEY, ...extra });
  return { ...e, cfg, store, meter, checks, fetch, sleeps, provider };
}
/** Every recorded decisions line is a decisions line with a finite, positive cost (a NaN cost would count as 0). */
const assertLines = (lines) => {
  assert.ok(lines.length > 0);
  for (const l of lines) { assert.equal(l.api, "decisions"); assert.ok(Number.isFinite(l.cost_usd) && l.cost_usd > 0, `cost ${l.cost_usd}`); }
};
const rejectsWith = async (p, code) => assert.rejects(p, (x) => x instanceof ProviderError && x.code === code, `expected ProviderError ${code}`);

test("P-req request shape and headers; no tools, no store", async () => {
  const s = setup();
  try {
    await s.provider.ask(REQ);
    assert.equal(s.fetch.calls.length, 1);
    const { url, init, body } = s.fetch.calls[0];
    assert.equal(url, "https://api.openai.com/v1/decisions");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.deepEqual(Object.keys(body).sort(), ["input", "model", "questions"]);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.input, REQ.input);
    assert.deepEqual(body.questions, QUESTIONS);
    assert.ok(!("tools" in body) && !("store" in body) && !("tool_choice" in body));
  } finally { s.done(); }
});

test("P-ok choice and predicate answers normalise into byName; usage is returned", async () => {
  const s = setup();
  try {
    const a = await s.provider.ask(REQ);
    assert.deepEqual(Object.keys(a.byName).sort(), ["needs_text", "route"]);
    const r = a.byName.route;
    assert.equal(r.type, "choice");
    assert.equal(r.choice, "w1");
    assert.ok(r.probs instanceof Map);
    assert.deepEqual([...r.probs.entries()], [["w1", 0.9], ["w2", 0.07], ["none", 0.03]]);
    assert.deepEqual(a.byName.needs_text, { type: "predicate", pTrue: 0.7 });
    assert.deepEqual(a.usage, { input_tokens: 1000000 });
  } finally { s.done(); }
});

test("P-ok a truncated probability list (sum below 1) is accepted; a sum of 1.02 is accepted", async () => {
  const s = setup([resp(200, okBody([routeAns({ probabilities: [{ value: "w1", probability: 0.9 }] }), predAns({ probabilities: [{ value: true, probability: 0.52 }, { value: false, probability: 0.5 }] })]))]);
  try {
    const a = await s.provider.ask(REQ);
    assert.equal(a.byName.route.probs.size, 1);
    assert.equal(a.byName.needs_text.pTrue, 0.52);
  } finally { s.done(); }
});

test("P-bool predicate values as booleans or strings read the same; false-only gives 1 - p; anything else unusable", async () => {
  const cases = [
    [[{ value: true, probability: 0.8 }, { value: false, probability: 0.2 }], 0.8],
    [[{ value: "true", probability: 0.8 }, { value: "false", probability: 0.2 }], 0.8],
    [[{ value: "TRUE", probability: 0.8 }, { value: "False", probability: 0.2 }], 0.8],
    [[{ value: false, probability: 0.25 }], 0.75],
    [[{ value: "false", probability: 0.25 }], 0.75],
    [[{ value: false, probability: 0.1 }, { value: true, probability: 0.6 }], 0.6], // true entry wins, order does not matter
  ];
  for (const [probabilities, want] of cases) {
    const s = setup([resp(200, okBody([routeAns(), predAns({ probabilities })]))]);
    try {
      const a = await s.provider.ask(REQ);
      assert.ok(Math.abs(a.byName.needs_text.pTrue - want) < 1e-12, JSON.stringify(probabilities));
    } finally { s.done(); }
  }
  for (const probabilities of [[], [{ value: "maybe", probability: 0.5 }], [{ value: 1, probability: 0.5 }], [{ value: "yes", probability: 0.9 }]]) {
    const s = setup([resp(200, okBody([routeAns(), predAns({ probabilities })]))]);
    try { await rejectsWith(s.provider.ask(REQ), "unusable"); } finally { s.done(); }
  }
});

const UNUSABLE = {
  "missing answer": () => [routeAns()],
  "missing answer for the first question": () => [predAns()],
  "choice not offered": () => [routeAns({ choice: "w9" })],
  "choice not a string": () => [routeAns({ choice: 1 })],
  "chosen value missing from probabilities": () => [routeAns({ probabilities: [{ value: "w2", probability: 0.1 }] }), predAns()],
  "probability NaN-like (string)": () => [routeAns({ probabilities: [{ value: "w1", probability: "0.9" }] }), predAns()],
  "probability null": () => [routeAns({ probabilities: [{ value: "w1", probability: null }] }), predAns()],
  "probability above 1": () => [routeAns({ probabilities: [{ value: "w1", probability: 1.2 }] }), predAns()],
  "probability below 0": () => [routeAns({ probabilities: [{ value: "w1", probability: 0.9 }, { value: "w2", probability: -0.1 }] }), predAns()],
  "probabilities sum above 1.02": () => [routeAns({ probabilities: [{ value: "w1", probability: 0.9 }, { value: "w2", probability: 0.2 }] }), predAns()],
  "probabilities not an array": () => [routeAns({ probabilities: { w1: 0.9 } }), predAns()],
  "probability for a value not offered": () => [routeAns({ probabilities: [{ value: "w1", probability: 0.9 }, { value: "w9", probability: 0.05 }] }), predAns()],
  "wrong answer type for the question": () => [routeAns({ type: "predicate" }), predAns()],
  "predicate without a readable true probability": () => [routeAns(), predAns({ probabilities: [{ value: "maybe", probability: 0.4 }] })],
  "predicate probability above 1": () => [routeAns(), predAns({ probabilities: [{ value: true, probability: 1.5 }] })],
  "predicate probabilities sum above 1.02": () => [routeAns(), predAns({ probabilities: [{ value: true, probability: 0.9 }, { value: false, probability: 0.9 }] })],
};
UNUSABLE["P-above-1-alone: a choice probability of 1.01 (sum 1.01 <= 1.02)"] = () => [routeAns({ probabilities: [{ value: "w1", probability: 1.01 }] }), predAns()];
UNUSABLE["P-above-1-alone: a predicate true probability of 1.01 (sum 1.01 <= 1.02)"] = () => [routeAns(), predAns({ probabilities: [{ value: true, probability: 1.01 }] })];
for (const [name, make] of Object.entries(UNUSABLE)) {
  test(`P-unusable-${name}: ProviderError unusable, billed attempt recorded, no retry`, async () => {
    const s = setup([resp(200, { answers: make(), model: "gpt-6-luna", usage: { input_tokens: 500 } })]);
    try {
      await rejectsWith(s.provider.ask(REQ), "unusable");
      assert.equal(s.fetch.calls.length, 1);
      assert.equal(s.store.lines.length, 1);
      assert.equal(s.store.lines[0].outcome, "unusable");
      assert.equal(s.store.lines[0].input_tokens, 500);
    } finally { s.done(); }
  });
}

test("P-refusal a refusal answer is returned, not thrown", async () => {
  const s = setup([resp(200, okBody([routeAns(), { type: "refusal", name: "needs_text" }]))]);
  try {
    const a = await s.provider.ask(REQ);
    assert.deepEqual(a.byName.needs_text, { type: "refusal" });
    assert.equal(a.byName.route.choice, "w1");
    assert.equal(s.store.lines[0].outcome, "ok");
  } finally { s.done(); }
});

test("P-refusal-first a refusal plus a missing or malformed other answer is returned, not unusable", async () => {
  const bodies = [
    [{ type: "refusal", name: "route" }], // other answer missing
    [{ type: "refusal", name: "route" }, predAns({ probabilities: "garbage" })], // other answer malformed
    [{ type: "refusal", name: "route" }, predAns({ probabilities: [{ value: true, probability: 7 }] })],
    [routeAns({ choice: "w9" }), { type: "refusal", name: "needs_text" }], // choice not offered
  ];
  for (const answers of bodies) {
    const s = setup([resp(200, okBody(answers))]);
    try {
      const a = await s.provider.ask(REQ);
      const refused = Object.values(a.byName).filter((x) => x.type === "refusal");
      assert.equal(refused.length, 1, JSON.stringify(answers));
      assert.equal(s.store.lines[0].outcome, "ok");
      // a malformed other answer is left out, never passed on half-read
      for (const x of Object.values(a.byName)) if (x.type === "choice") assert.ok(x.probs instanceof Map && x.probs.has(x.choice));
      if (answers[0].type === "refusal") assert.equal(a.byName.route.type, "refusal");
    } finally { s.done(); }
  }
  const s = setup([resp(200, okBody([routeAns({ choice: "w9" }), { type: "refusal", name: "needs_text" }]))]);
  try {
    const a = await s.provider.ask(REQ);
    assert.ok(!("route" in a.byName), "an invalid-choice answer is left out");
  } finally { s.done(); }
});

test("P-retry 429 then 200: two usage lines (http-429 worst case, then ok real), check called twice, Retry-After honoured", async () => {
  const s = setup([resp(429, {}, { "Retry-After": "2" }), resp(200, okBody())]);
  try {
    const a = await s.provider.ask(REQ);
    assert.equal(a.byName.route.choice, "w1");
    assert.equal(s.fetch.calls.length, 2);
    assert.equal(s.checks.length, 2);
    assert.deepEqual(s.sleeps, [2000]);
    const [l1, l2] = s.store.lines;
    assert.equal(l1.api, "decisions");
    assert.equal(l1.outcome, "http-429");
    assert.equal(l1.estimated, true);
    assert.equal(l1.attempt, 1);
    assert.ok(l1.cost_usd > 0);
    assert.equal(l2.outcome, "ok");
    assert.equal(l2.estimated, false);
    assert.equal(l2.attempt, 2);
    assert.equal(l2.retries, 1);
    assert.equal(l2.input_tokens, 1000000);
    assert.ok(Math.abs(l2.cost_usd - 0.1) < 1e-12);
    assert.equal(l1.request_id, l2.request_id);
    assertLines(s.store.lines);
  } finally { s.done(); }
});

test("P-retry 5xx and network errors retry up to max_retries then throw; 400 and 401 do not retry", async () => {
  let s = setup([resp(503, {})], { cfg: mkCfg({ decisions: { enabled: true, model: "gpt-6-luna", timeout_ms: 50, max_retries: 2 } }) });
  try {
    await rejectsWith(s.provider.ask(REQ), "http-503");
    assert.equal(s.fetch.calls.length, 3);
    assert.deepEqual(s.sleeps, [500, 1000]);
  } finally { s.done(); }
  s = setup(["network", "network"]);
  try {
    await rejectsWith(s.provider.ask(REQ), "network");
    assert.equal(s.fetch.calls.length, 2);
    assert.deepEqual(s.store.lines.map((l) => l.outcome), ["network", "network"]);
    assertLines(s.store.lines);
  } finally { s.done(); }
  for (const code of [400, 401]) {
    s = setup([resp(code, {})]);
    try {
      await rejectsWith(s.provider.ask(REQ), `http-${code}`);
      assert.equal(s.fetch.calls.length, 1);
    } finally { s.done(); }
  }
});

test("P-timeout a hung request times out, is retried, then throws timeout; each attempt charged the worst case", async () => {
  const s = setup(["hang", "hang"]);
  try {
    await rejectsWith(s.provider.ask(REQ), "timeout");
    assert.equal(s.fetch.calls.length, 2);
    assert.deepEqual(s.store.lines.map((l) => l.outcome), ["timeout", "timeout"]);
    assert.ok(s.store.lines.every((l) => l.estimated === true && l.cost_usd > 0));
    assertLines(s.store.lines);
    assert.equal(new Set(s.checks).size, 1); // the same finite estimate on every attempt
  } finally { s.done(); }
});

test("P-bound a token-dense (non-ASCII) body that times out is charged at est = bytes + 1024, and est >= bytes", async () => {
  const cfg = mkCfg({
    decisions: { enabled: true, model: "gpt-6-luna", timeout_ms: 30, max_retries: 0 },
    pricing: { "gpt-6-luna": { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4, decisions_input_per_mtok: 1 } },
  });
  const req = { input: "\u{1F600}中文שלום".repeat(200), questions: QUESTIONS };
  const s = setup(["hang"], { cfg });
  try {
    await rejectsWith(s.provider.ask(req), "timeout");
    const bytes = Buffer.byteLength(JSON.stringify({ model: "gpt-6-luna", input: req.input, questions: req.questions }));
    const est = bytes + 1024;
    assert.deepEqual(s.checks, [est]);
    assert.ok(est >= bytes);
    assertLines(s.store.lines);
    assert.equal(Math.round(s.store.lines[0].cost_usd * 1e6), est); // rate 1 per Mtok: cost = est / 1e6
  } finally { s.done(); }
});

test("P-bad-response a non-JSON body or a body without answers is bad-response (no retry)", async () => {
  for (const step of [{ status: 200, text: "<html>" }, resp(200, { model: "x" }), resp(200, []), resp(200, { answers: "nope" })]) {
    const s = setup([step]);
    try {
      await rejectsWith(s.provider.ask(REQ), "bad-response");
      assert.equal(s.fetch.calls.length, 1);
      assert.equal(s.store.lines[0].outcome, "bad-response");
    } finally { s.done(); }
  }
});

test("P-usage a 200 without usable usage is charged the worst case, never zero", async () => {
  for (const usage of [undefined, null, {}, { input_tokens: "12" }]) {
    const s = setup([resp(200, { answers: [routeAns(), predAns()], model: "gpt-6-luna", usage })]);
    try {
      await s.provider.ask(REQ);
      assert.equal(s.store.lines[0].estimated, true);
      assertLines(s.store.lines);
    } finally { s.done(); }
  }
});

test("P-hard at the hard limit SpendBlocked is thrown before any fetch", async () => {
  const lines = [{ month: "2026-10", api: "responses", cost_usd: 10 }];
  const s = setup([resp(200, okBody())], { lines });
  try {
    await assert.rejects(s.provider.ask(REQ), (x) => x instanceof SpendBlocked);
    assert.equal(s.fetch.calls.length, 0);
    assert.equal(lines.length, 1);
  } finally { s.done(); }
});

test("P-hard the retry is blocked too when the first attempt's charge reached the limit", async () => {
  const lines = [{ month: "2026-10", api: "responses", cost_usd: 9.9998 }];
  const s = setup([resp(503, {}), resp(200, okBody())], { lines });
  try {
    // first check passes (worst case ~0.0001), the recorded 503 charges the worst case, the second check blocks
    await assert.rejects(s.provider.ask(REQ), (x) => x instanceof SpendBlocked);
    assert.equal(s.fetch.calls.length, 1);
  } finally { s.done(); }
});

test("P-cfg-* each missing precondition is a ConfigError without the key in its text", () => {
  const e = env();
  try {
    const cfg = mkCfg();
    const meter = createMeter({ cfg, store: fakeStore(), api: "decisions" });
    const make = (c, o = {}) => () => createOpenAIDecisionsProvider({ cfg: c, meter, fetch: fakeFetch([]), apiKey: KEY, ...o });
    const dec = (o) => ({ ...cfg, decisions: { ...cfg.decisions, ...o } });
    const withGpt5 = { ...cfg, pricing: { ...cfg.pricing, "gpt-5": { decisions_input_per_mtok: 0.1 } } }; // priced, so only the model check can reject it
    const decP = (o) => ({ ...withGpt5, decisions: { ...cfg.decisions, ...o } });
    const cases = {
      "provider none": [make({ ...cfg, provider: "none" }), /provider: "openai"/],
      "provider missing": [make({ ...cfg, provider: undefined }), /provider: "openai"/],
      "decisions disabled": [make(dec({ enabled: false })), /decisions.enabled/],
      "enabled not boolean true": [make(dec({ enabled: "yes" })), /decisions.enabled/],
      "no decisions block": [make({ ...cfg, decisions: undefined }), /decisions.enabled/],
      "wrong model": [make(decP({ model: "gpt-5" })), /decisions.model must be "gpt-6-luna"/],
      "no price": [make({ ...cfg, pricing: {} }), /Decisions price/],
      "negative price": [make({ ...cfg, pricing: { "gpt-6-luna": { decisions_input_per_mtok: -1 } } }), /Decisions price/],
      "string price": [make({ ...cfg, pricing: { "gpt-6-luna": { decisions_input_per_mtok: "0.1" } } }), /Decisions price/],
      "no meter": [make(cfg, { meter: undefined }), /cost meter/],
      "no cfg": [make(undefined), /provider: "openai"/],
      "empty key": [make(cfg, { apiKey: "   " }), /key/i],
      "bad timeout": [make(dec({ timeout_ms: 0 })), /timeout_ms/],
      "bad retries": [make(dec({ max_retries: -1 })), /max_retries/],
    };
    for (const [name, [fn, re]] of Object.entries(cases)) {
      assert.throws(fn, (x) => x instanceof ConfigError && re.test(x.message) && !x.message.includes(KEY), name);
    }
    assert.throws(make(cfg, { apiKey: undefined }), (x) => x instanceof ConfigError && /key/i.test(x.message)); // no key anywhere
    assert.doesNotThrow(make(cfg));
  } finally { e.done(); }
});

test("P-cfg key from OPENAI_API_KEY or from a key file inside secrets/, never from outside", () => {
  const e = env();
  try {
    const cfg = mkCfg();
    const meter = createMeter({ cfg, store: fakeStore(), api: "decisions" });
    const mk = (c) => () => createOpenAIDecisionsProvider({ cfg: c, meter, fetch: fakeFetch([]) });
    process.env.OPENAI_API_KEY = KEY;
    assert.doesNotThrow(mk(cfg));
    delete process.env.OPENAI_API_KEY;
    const secrets = path.join(e.dir, "secrets");
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, "openai.key"), KEY + "\n");
    fs.writeFileSync(path.join(e.dir, "outside.key"), KEY);
    assert.doesNotThrow(mk(mkCfg({ openai: { ...cfg.openai, key_file: "openai.key" } })));
    assert.throws(mk(mkCfg({ openai: { ...cfg.openai, key_file: "../outside.key" } })), ConfigError);
  } finally { e.done(); }
});

test("P-key the key never appears in an error, a usage record or a log line", async () => {
  const logs = [];
  const origErr = console.error, origLog = console.log, origWarn = console.warn;
  console.error = (...a) => logs.push(a.join(" ")); console.log = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
  const errors = [];
  const lines = [];
  try {
    for (const script of [["network", "network"], ["hang", "hang"], [resp(500, { error: KEY }), resp(401, { error: `bad key ${KEY}` })], [{ status: 200, text: KEY }], [resp(200, okBody([routeAns({ choice: KEY })]))]]) {
      const s = setup(script, { lines });
      try { await s.provider.ask(REQ); } catch (x) { errors.push(String(x.message), x.code, JSON.stringify(x)); } finally { s.done(); }
    }
  } finally { console.error = origErr; console.log = origLog; console.warn = origWarn; }
  assert.ok(errors.length > 0 && lines.length > 0);
  for (const t of [...errors, ...logs, JSON.stringify(lines)]) assert.ok(!String(t).includes(KEY), `key leaked in: ${t}`);
});

test("P-mock MockDecisionsProvider: array script in order, functions get the request, Error items throw, calls recorded, usage null", async () => {
  const byName1 = { route: { type: "choice", choice: "w1", probs: new Map([["w1", 1]]) } };
  const mock = new MockDecisionsProvider([byName1, (req) => ({ echo: { type: "refusal", seen: req.input } }), new ProviderError("timeout", "slow")]);
  const a1 = await mock.ask(REQ);
  assert.deepEqual(a1, { byName: byName1, usage: null });
  const a2 = await mock.ask({ input: "second", questions: [] });
  assert.equal(a2.byName.echo.seen, "second");
  assert.equal(a2.usage, null);
  await assert.rejects(mock.ask(REQ), (x) => x instanceof ProviderError && x.code === "timeout");
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.calls[0], REQ);
  await assert.rejects(mock.ask(REQ), (x) => x instanceof ProviderError && x.code === "mock-exhausted");
  assert.equal(mock.calls.length, 4);

  const fn = new MockDecisionsProvider((req) => ({ n: { type: "predicate", pTrue: req.input.length / 10 } }));
  assert.equal((await fn.ask({ input: "12345", questions: [] })).byName.n.pTrue, 0.5);
  assert.equal((await fn.ask({ input: "1234567890", questions: [] })).byName.n.pTrue, 1);
  assert.equal(fn.calls.length, 2);

  const plainErr = new MockDecisionsProvider([new Error("boom")]);
  await assert.rejects(plainErr.ask(REQ), /boom/);
});

test("P-throw a non-ProviderError thrown while normalising a 200 is recorded as bad-response (real usage) before it propagates", async () => {
  const bad = { ...REQ, questions: [{ type: "choice", name: "route", instructions: "x", choices: [null] }] }; // c.value on null throws a TypeError
  for (const [usage, tokens, estimated] of [[{ input_tokens: 700 }, 700, undefined], [undefined, null, true]]) {
    const s = setup([resp(200, { answers: [routeAns()], model: "gpt-6-luna", usage })]);
    try {
      await assert.rejects(s.provider.ask(bad), (x) => x instanceof TypeError && !(x instanceof ProviderError));
      assert.equal(s.fetch.calls.length, 1);
      assert.equal(s.store.lines.length, 1);
      assert.equal(s.store.lines[0].outcome, "bad-response");
      if (tokens !== null) assert.equal(s.store.lines[0].input_tokens, tokens); else assert.equal(s.store.lines[0].estimated, estimated);
      assertLines(s.store.lines);
    } finally { s.done(); }
  }
});

test("P-badreq questions missing, not an array or empty is bad-request before any meter.check or fetch", async () => {
  for (const req of [undefined, null, {}, { input: "x" }, { input: "x", questions: "q" }, { input: "x", questions: {} }, { input: "x", questions: [] }]) {
    const s = setup([resp(200, okBody())]);
    try {
      await rejectsWith(s.provider.ask(req), "bad-request");
      assert.equal(s.checks.length, 0);
      assert.equal(s.fetch.calls.length, 0);
      assert.equal(s.store.lines.length, 0);
    } finally { s.done(); }
  }
});
