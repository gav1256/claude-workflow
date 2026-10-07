import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decisionsPriceOf, priceOf, callCost, worstCase, monthKey, monthSpend, spendGate, createMeter, SpendBlocked } from "../cost.mjs";
import { ProviderError } from "../provider.mjs";
import * as store from "../store.mjs";

const LIMITS = { monthly_soft_usd: 7, monthly_hard_usd: 10 };
const PRICE = { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4 };
const cfg = (extra = {}) => ({ provider: "openai", openai: { model: "gpt-6-luna", max_output_tokens: 600 }, pricing: { "gpt-6-luna": PRICE }, limits: LIMITS, ...extra });

let savedCfgDir;
function tempCfgDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-cost-"));
  savedCfgDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}
function rm(d) {
  if (savedCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfgDir;
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test("M1 spendGate: ok, soft, would-pass-the-limit and at-the-limit", () => {
  assert.deepEqual(spendGate({ spent: 6.99, worst: 0.001, limits: LIMITS }), { allow: true, state: "ok" });
  assert.deepEqual(spendGate({ spent: 7.0, worst: 0.001, limits: LIMITS }), { allow: true, state: "soft" });
  const near = spendGate({ spent: 9.999, worst: 0.002, limits: LIMITS });
  assert.equal(near.allow, false);
  assert.equal(near.state, "hard");
  assert.match(near.reason, /could pass the hard limit/);
  const at = spendGate({ spent: 10, worst: 0, limits: LIMITS });
  assert.equal(at.allow, false);
  assert.equal(at.state, "hard");
  assert.match(at.reason, /hard limit \$10 reached/);
});

test("M1 spendGate fails closed on non-numeric limits or amounts", () => {
  assert.equal(spendGate({ spent: 1, worst: 0.1, limits: { monthly_soft_usd: 7 } }).allow, false);
  assert.equal(spendGate({ spent: 1, worst: 0.1, limits: { monthly_soft_usd: 7, monthly_hard_usd: "10" } }).allow, false);
  assert.equal(spendGate({ spent: NaN, worst: 0.1, limits: LIMITS }).allow, false);
  assert.equal(spendGate({ spent: 1, worst: undefined, limits: LIMITS }).allow, false);
  assert.equal(spendGate({ spent: 1, worst: 0.1, limits: undefined }).allow, false);
});

test("M2 monthSpend counts only the current UTC month", () => {
  const now = Date.UTC(2026, 9, 7, 12); // 2026-10
  assert.equal(monthKey(now), "2026-10");
  assert.equal(monthKey(Date.UTC(2026, 8, 30, 23, 59)), "2026-09");
  const lines = [{ month: "2026-09", cost_usd: 8 }, { month: "2026-10", cost_usd: 1.5 }, { month: "2026-10", cost_usd: 0.5 }, { month: "2026-10", cost_usd: "bad" }];
  assert.equal(monthSpend(lines, now), 2);
  assert.equal(monthSpend([], now), 0);
});

test("M2 meter ignores last month's usage lines", () => {
  const dir = tempCfgDir();
  try {
    store.appendJsonl("usage", { month: "2026-09", cost_usd: 9.99 });
    const now = () => Date.UTC(2026, 9, 7);
    const m = createMeter({ cfg: cfg(), store, now });
    assert.equal(m.state().spent_usd, 0);
    assert.equal(m.state().state, "ok");
    assert.equal(m.check(1000).state, "ok");
  } finally { rm(dir); }
});

test("priceOf needs all three prices as non-negative numbers", () => {
  assert.deepEqual(priceOf(cfg(), "gpt-6-luna"), PRICE);
  assert.equal(priceOf(cfg(), "other"), null);
  assert.equal(priceOf({}, "gpt-6-luna"), null);
  assert.equal(priceOf(cfg({ pricing: { "gpt-6-luna": { input_per_mtok: 1, cached_input_per_mtok: 0.1 } } }), "gpt-6-luna"), null);
  assert.equal(priceOf(cfg({ pricing: { "gpt-6-luna": { ...PRICE, output_per_mtok: -1 } } }), "gpt-6-luna"), null);
  assert.equal(priceOf(cfg({ pricing: { "gpt-6-luna": { ...PRICE, output_per_mtok: "4" } } }), "gpt-6-luna"), null);
  assert.equal(priceOf(cfg({ pricing: { "gpt-6-luna": { ...PRICE, input_per_mtok: NaN } } }), "gpt-6-luna"), null);
});

test("callCost and worstCase are in USD per million tokens", () => {
  // 1000 input of which 400 cached, 200 output: 600*1 + 400*0.1 + 200*4 = 1440 per 1e6
  assert.ok(Math.abs(callCost(PRICE, { input: 1000, cached: 400, output: 200 }) - 0.00144) < 1e-12);
  assert.equal(callCost(PRICE, { input: 100, cached: 500, output: 0 }), 500 * 0.1 / 1e6, "cached above input never gives negative uncached");
  assert.ok(Math.abs(worstCase(PRICE, 2000, 600) - (2000 + 2400) / 1e6) < 1e-12);
});

test("M3 meter throws SpendBlocked('no price table') without pricing", () => {
  const dir = tempCfgDir();
  try {
    const m = createMeter({ cfg: cfg({ pricing: {} }), store });
    assert.throws(() => m.check(100), (e) => e instanceof SpendBlocked && /no price table/.test(e.message));
    assert.throws(() => m.record({ requestId: "r", attempt: 1, usage: null, estInputTokens: 1, latencyMs: 1, retries: 0, outcome: "x" }), SpendBlocked);
    assert.deepEqual(store.readJsonl("usage"), []);
  } finally { rm(dir); }
});

test("M11 SpendBlocked is a ProviderError with code hard-limit and not retryable", () => {
  const e = new SpendBlocked("why");
  assert.ok(e instanceof ProviderError);
  assert.ok(e instanceof Error);
  assert.equal(e.code, "hard-limit");
  assert.equal(e.retryable, false);
  assert.equal(e.message, "why");
});

test("meter check blocks at the hard limit and gives state()", () => {
  const dir = tempCfgDir();
  try {
    const now = () => Date.UTC(2026, 9, 7);
    const m = createMeter({ cfg: cfg(), store, now });
    store.appendJsonl("usage", { month: "2026-10", cost_usd: 7.5 });
    assert.deepEqual(m.state(), { spent_usd: 7.5, soft: 7, hard: 10, state: "soft" });
    assert.equal(m.check(1000).state, "soft");
    store.appendJsonl("usage", { month: "2026-10", cost_usd: 2.5 });
    assert.equal(m.state().state, "hard");
    assert.throws(() => m.check(1), (e) => e instanceof SpendBlocked && /hard limit/.test(e.message));
  } finally { rm(dir); }
});

test("M10 record writes the usage line: cached tokens, latency, retries, cost; without usage it charges the worst case", () => {
  const dir = tempCfgDir();
  try {
    const now = () => Date.UTC(2026, 9, 7, 8, 30);
    const m = createMeter({ cfg: cfg(), store, now });
    const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 200 };
    m.record({ requestId: "req-1", attempt: 2, usage, estInputTokens: 900, latencyMs: 123, retries: 1, outcome: "ok" });
    m.record({ requestId: "req-1", attempt: 3, usage: null, estInputTokens: 2000, latencyMs: 20000, retries: 2, outcome: "timeout" });
    const [a, b] = store.readJsonl("usage");
    assert.equal(a.at, "2026-10-07T08:30:00.000Z");
    assert.equal(a.month, "2026-10");
    assert.equal(a.model, "gpt-6-luna");
    assert.equal(a.request_id, "req-1");
    assert.equal(a.input_tokens, 1000);
    assert.equal(a.cached_input_tokens, 400);
    assert.equal(a.output_tokens, 200);
    assert.equal(a.latency_ms, 123);
    assert.equal(a.retries, 1);
    assert.equal(a.cost_usd, callCost(PRICE, { input: 1000, cached: 400, output: 200 }));
    assert.equal(a.estimated, false);
    assert.equal(b.input_tokens, null);
    assert.equal(b.estimated, true);
    assert.equal(b.cost_usd, worstCase(PRICE, 2000, 600));
    assert.equal(b.outcome, "timeout");
  } finally { rm(dir); }
});

test("R1 meter check fails closed when max_output_tokens is not a positive integer", () => {
  const dir = tempCfgDir();
  try {
    for (const v of [null, undefined, 0, -1, "600", NaN]) {
      const m = createMeter({ cfg: cfg({ openai: { model: "gpt-6-luna", max_output_tokens: v } }), store });
      assert.throws(() => m.check(100), (e) => e instanceof SpendBlocked && /max_output_tokens/.test(e.message), String(v));
    }
  } finally { rm(dir); }
});

// ---- Decisions metering (Decisions-routing Task 1, M2-M4) ----

const DEC_RATE = 0.1;
const decCfg = (extra = {}) => cfg({
  decisions: { model: "gpt-6-luna" },
  pricing: { "gpt-6-luna": { ...PRICE, decisions_input_per_mtok: DEC_RATE } },
  ...extra,
});
const fakeStore = (lines = []) => ({ lines, readJsonl: () => lines, appendJsonl: (_n, o) => lines.push(o) });
const NOW = () => Date.UTC(2026, 9, 7, 8, 30);

test("D2 decisionsPriceOf: a non-negative finite number, else null", () => {
  assert.deepEqual(decisionsPriceOf(decCfg()), { input_per_mtok: 0.1 });
  const c = (r) => ({ decisions: { model: "gpt-6-luna" }, pricing: { "gpt-6-luna": { decisions_input_per_mtok: r } } });
  assert.deepEqual(decisionsPriceOf(c(0)), { input_per_mtok: 0 });
  for (const r of [undefined, -1, Number.NaN, "0.1", null, Infinity]) assert.equal(decisionsPriceOf(c(r)), null, String(r));
  assert.equal(decisionsPriceOf({ decisions: { model: "gpt-6-luna" }, pricing: {} }), null);
  assert.equal(decisionsPriceOf({ pricing: {} }), null);
  assert.equal(decisionsPriceOf({}), null);
});

test("D3a decisions record: 1,000,000 input tokens at 0.10 costs exactly 0.10", () => {
  const s = fakeStore();
  const m = createMeter({ cfg: decCfg(), store: s, now: NOW, api: "decisions" });
  m.record({ requestId: "r1", attempt: 1, usage: { input_tokens: 1_000_000 }, estInputTokens: 900, latencyMs: 50, retries: 0, outcome: "ok" });
  assert.equal(s.lines.length, 1);
  const l = s.lines[0];
  assert.equal(l.cost_usd, 0.1);
  assert.equal(l.api, "decisions");
  assert.equal(l.model, "gpt-6-luna");
  assert.equal(l.input_tokens, 1_000_000);
  assert.equal(l.cached_input_tokens, null);
  assert.equal(l.output_tokens, null);
  assert.equal(l.estimated, false);
  assert.equal(l.month, "2026-10");
  assert.equal(l.request_id, "r1");
  assert.equal(l.latency_ms, 50);
});

test("D3b decisions record with usage null charges the worst case and flags estimated", () => {
  const s = fakeStore();
  const m = createMeter({ cfg: decCfg(), store: s, now: NOW, api: "decisions" });
  m.record({ requestId: "r2", attempt: 1, usage: null, estInputTokens: 2_000_000, latencyMs: 10000, retries: 1, outcome: "timeout" });
  const l = s.lines[0];
  assert.equal(l.cost_usd, 0.2, "2,000,000 est tokens * 0.10 / 1e6");
  assert.equal(l.estimated, true);
  assert.equal(l.input_tokens, null);
  assert.equal(l.api, "decisions");
});

test("D3c decisions record with usage {} or a string input_tokens charges the worst case, never NaN or 0", () => {
  for (const usage of [{}, { input_tokens: "12" }, { input_tokens: Number.NaN }, { input_tokens: null }]) {
    const s = fakeStore();
    const m = createMeter({ cfg: decCfg(), store: s, now: NOW, api: "decisions" });
    m.record({ requestId: "r3", attempt: 1, usage, estInputTokens: 1_000_000, latencyMs: 5, retries: 0, outcome: "ok" });
    const l = s.lines[0];
    assert.equal(l.cost_usd, 0.1, JSON.stringify(usage));
    assert.equal(l.estimated, true);
    assert.equal(l.input_tokens, null);
  }
});

test("D3 decisions check uses worst = est * rate / 1e6 (no output term) and needs a price, not max_output_tokens", () => {
  const s = fakeStore([{ month: "2026-10", cost_usd: 9.99, api: "responses" }]);
  const noOut = decCfg({ openai: { model: "gpt-6-luna" } }); // no max_output_tokens
  const m = createMeter({ cfg: noOut, store: s, now: NOW, api: "decisions" });
  assert.equal(m.check(50_000).allow, true, "worst $0.005 fits");
  assert.throws(() => m.check(200_000), SpendBlocked, "worst $0.02 does not");
  const nopr = createMeter({ cfg: decCfg({ pricing: { "gpt-6-luna": PRICE } }), store: s, now: NOW, api: "decisions" });
  assert.throws(() => nopr.check(1), (e) => e instanceof SpendBlocked && /no decisions price/.test(e.message));
  assert.throws(() => nopr.record({ requestId: "x", attempt: 1, usage: null, estInputTokens: 1, latencyMs: 1, retries: 0, outcome: "ok" }), SpendBlocked);
});

test("D4a responses $9.99 + a decisions check with worst case $0.02 is blocked", () => {
  const s = fakeStore([{ month: "2026-10", cost_usd: 9.99, api: "responses" }]);
  const m = createMeter({ cfg: decCfg(), store: s, now: NOW, api: "decisions" });
  assert.throws(() => m.check(200_000), (e) => e instanceof SpendBlocked && /hard limit/.test(e.message));
  assert.equal(m.check(50_000).allow, true);
});

test("D4b decisions lines summing $10 block a responses check too", () => {
  const s = fakeStore([{ month: "2026-10", cost_usd: 6, api: "decisions" }, { month: "2026-10", cost_usd: 4, api: "decisions" }]);
  const m = createMeter({ cfg: decCfg(), store: s, now: NOW });
  assert.throws(() => m.check(1), (e) => e instanceof SpendBlocked && /hard limit/.test(e.message));
  assert.equal(m.state().state, "hard");
});

test("D4c byApi splits the month; a line without api counts as responses; other months are ignored", () => {
  const s = fakeStore([
    { month: "2026-10", cost_usd: 1.5, api: "decisions" },
    { month: "2026-10", cost_usd: 2, api: "responses" },
    { month: "2026-10", cost_usd: 0.25 }, // old line, no api
    { month: "2026-09", cost_usd: 99, api: "decisions" },
  ]);
  const m = createMeter({ cfg: decCfg(), store: s, now: NOW });
  assert.deepEqual(m.byApi(), { decisions: 1.5, responses: 2.25 });
  assert.deepEqual(m.state(), { spent_usd: 3.75, soft: 7, hard: 10, state: "ok" });
  const d = createMeter({ cfg: decCfg(), store: s, now: NOW, api: "decisions" });
  assert.deepEqual(d.byApi(), { decisions: 1.5, responses: 2.25 });
});

test("D4 responses lines now also carry api: responses", () => {
  const s = fakeStore();
  const m = createMeter({ cfg: cfg(), store: s, now: NOW });
  m.record({ requestId: "q", attempt: 1, usage: { input_tokens: 10, output_tokens: 5 }, estInputTokens: 10, latencyMs: 1, retries: 0, outcome: "ok" });
  assert.equal(s.lines[0].api, "responses");
  assert.equal(s.lines[0].model, "gpt-6-luna");
});

test("F1 decisions record: zero, negative or fractional input_tokens charge the exact estimate, flagged estimated", () => {
  for (const input_tokens of [0, -5, -1_000_000, 1.5]) {
    const s = fakeStore();
    const m = createMeter({ cfg: decCfg(), store: s, now: NOW, api: "decisions" });
    m.record({ requestId: "f1", attempt: 1, usage: { input_tokens }, estInputTokens: 2_000_000, latencyMs: 5, retries: 0, outcome: "ok" });
    assert.equal(s.lines[0].cost_usd, 0.2, String(input_tokens));
    assert.equal(s.lines[0].estimated, true);
    assert.equal(s.lines[0].input_tokens, null);
  }
});

test("F1 responses record: zero, negative or fractional counts charge the worst case, flagged estimated", () => {
  const bad = [
    { input_tokens: 0, output_tokens: 10 }, { input_tokens: -100, output_tokens: 10 }, { input_tokens: 1.5, output_tokens: 10 },
    { input_tokens: 100, output_tokens: -10 }, { input_tokens: 100, output_tokens: 0 }, { input_tokens: 100, output_tokens: 2.5 },
    { input_tokens: 100 }, { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: -1 } },
    { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0.5 } },
  ];
  for (const usage of bad) {
    const s = fakeStore();
    const m = createMeter({ cfg: cfg(), store: s, now: NOW });
    m.record({ requestId: "f1", attempt: 1, usage, estInputTokens: 2000, latencyMs: 5, retries: 0, outcome: "ok" });
    assert.equal(s.lines[0].cost_usd, worstCase(PRICE, 2000, 600), JSON.stringify(usage));
    assert.equal(s.lines[0].estimated, true);
    assert.equal(s.lines[0].input_tokens, null);
  }
  // cached may be 0
  const s = fakeStore();
  createMeter({ cfg: cfg(), store: s, now: NOW }).record({ requestId: "f1", attempt: 1, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } }, estInputTokens: 2000, latencyMs: 1, retries: 0, outcome: "ok" });
  assert.equal(s.lines[0].estimated, false);
});

test("F1 two negative-usage responses can no longer lower monthly spend", () => {
  const s = fakeStore([{ month: "2026-10", cost_usd: 5, api: "responses" }]);
  const m = createMeter({ cfg: cfg(), store: s, now: NOW });
  for (let i = 0; i < 2; i++) m.record({ requestId: "n" + i, attempt: 1, usage: { input_tokens: -9_000_000, output_tokens: -9_000_000 }, estInputTokens: 1000, latencyMs: 1, retries: 0, outcome: "ok" });
  assert.ok(monthSpend(s.lines, NOW()) > 5);
  const d = createMeter({ cfg: decCfg(), store: s, now: NOW, api: "decisions" });
  const before = monthSpend(s.lines, NOW());
  d.record({ requestId: "n3", attempt: 1, usage: { input_tokens: -9_000_000 }, estInputTokens: 1000, latencyMs: 1, retries: 0, outcome: "ok" });
  assert.ok(monthSpend(s.lines, NOW()) >= before);
});

test("F1 a record with no usage and a non-finite estimate charges the hard limit, never NaN", () => {
  for (const est of [undefined, Number.NaN, Infinity, "x"]) {
    for (const api of ["responses", "decisions"]) {
      const s = fakeStore();
      const m = createMeter({ cfg: decCfg(), store: s, now: NOW, api });
      m.record({ requestId: "nf", attempt: 1, usage: null, estInputTokens: est, latencyMs: 1, retries: 0, outcome: "timeout" });
      assert.equal(s.lines[0].cost_usd, LIMITS.monthly_hard_usd, `${api} ${est}`);
      assert.equal(s.lines[0].estimated, true);
    }
  }
});

test("F5 createMeter throws on an api other than responses or decisions", () => {
  for (const api of ["decision", "Responses", "", null, 5]) assert.throws(() => createMeter({ cfg: decCfg(), store: fakeStore(), now: NOW, api }), /api must be/, String(api));
  assert.doesNotThrow(() => createMeter({ cfg: decCfg(), store: fakeStore(), now: NOW }));
});
