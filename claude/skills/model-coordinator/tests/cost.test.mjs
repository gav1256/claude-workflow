import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceOf, callCost, worstCase, monthKey, monthSpend, spendGate, createMeter, SpendBlocked } from "../cost.mjs";
import { ProviderError } from "../provider.mjs";
import * as store from "../store.mjs";

const LIMITS = { monthly_soft_usd: 7, monthly_hard_usd: 10 };
const PRICE = { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4 };
const cfg = (extra = {}) => ({ provider: "openai", openai: { model: "gpt-6-luna", max_output_tokens: 600 }, pricing: { "gpt-6-luna": PRICE }, limits: LIMITS, ...extra });

function tempCfgDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-cost-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

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
  } finally { delete process.env.CLAUDE_CONFIG_DIR; rm(dir); }
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
  } finally { delete process.env.CLAUDE_CONFIG_DIR; rm(dir); }
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
  } finally { delete process.env.CLAUDE_CONFIG_DIR; rm(dir); }
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
  } finally { delete process.env.CLAUDE_CONFIG_DIR; rm(dir); }
});
