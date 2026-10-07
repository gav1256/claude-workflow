import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mcEnv, withEnv, FAKE_CODEX_CLI } from "./mc-helpers.mjs";
import { codexSkillDir } from "../paths.mjs";
import { DEFAULTS } from "../config.mjs";
import { loginStatus, createLoginCache, usageStatus, createAllowance, codexGate, fallbackFor, resourceState } from "../codex-resources.mjs";

const usage = await import(pathToFileURL(path.join(codexSkillDir(), "lib", "usage.mjs")).href);
const NOW = Date.parse("2026-10-07T12:00:00Z");
const FUTURE = Math.floor(NOW / 1000) + 3 * 86400;
const cfg = (over = {}) => ({ ...structuredClone(DEFAULTS), ...over, codex: { ...DEFAULTS.codex, ...(over.codex ?? {}) } });
const reading = (weekPct, weekReset = FUTURE) => ({ ts: NOW, rl: { primary: { used_percent: 5, window_minutes: 300, resets_at: FUTURE },
  secondary: { used_percent: weekPct, window_minutes: 10080, resets_at: weekReset } } });
const fakeBin = (env, login) => ({ ...env, CODEX_RUN_BIN: process.execPath, CODEX_RUN_BIN_ARGS: JSON.stringify([FAKE_CODEX_CLI]), FAKE_LOGIN: login });
const run = (env, login) => {
  const bin = { cmd: process.execPath, args: [FAKE_CODEX_CLI] };
  return withEnv(fakeBin(env, login), () => loginStatus(bin, { env: process.env, timeoutMs: login === "hang" ? 500 : 15000, spawnSync }));
};

test("M1 the login probe env has no credential name in any case, no HL_*, and has CODEX_HOME", async () => {
  const env = mcEnv({ Openai_Api_Key: "x", codex_api_key: "x", Codex_Run_Env_Allow: "x", CLAUDECODE: "1", AI_AGENT: "a" });
  const dump = path.join(env.root, "env-dump.txt");
  const before = { ...process.env };
  try {
    const bin = { cmd: process.execPath, args: [FAKE_CODEX_CLI] };
    await withEnv({ ...env, FAKE_LOGIN: "chatgpt", FAKE_ENV_DUMP: dump }, () => {
      // the seeds are really in process.env, so a probe that forgot the strip would pass them on
      assert.equal(process.env.Openai_Api_Key, "x");
      assert.ok(process.env.HL_REGISTRY_DIR);
      assert.equal(loginStatus(bin, { env: process.env, spawnSync }), "chatgpt");
    });
    const names = fs.readFileSync(dump, "utf8").split("\n").filter(Boolean);
    assert.ok(names.length > 3, "the fake CLI wrote its env names");
    for (const n of names.map((x) => x.toLowerCase())) {
      assert.ok(!["openai_api_key", "codex_api_key", "codex_run_env_allow", "ai_agent"].includes(n), n);
      assert.ok(!n.startsWith("hl_"), n);
      assert.ok(!(n.startsWith("claude") && n !== "claude_config_dir"), n);
    }
    assert.ok(names.includes("CODEX_HOME"));
    // withEnv restored process.env: the seeded names do not leak into later tests
    assert.deepEqual({ ...process.env }, before);
    assert.equal(process.env.Openai_Api_Key, undefined);
    assert.equal(process.env.HL_REGISTRY_DIR, before.HL_REGISTRY_DIR);
  } finally { env.cleanup(); }
});

test("M2 loginStatus maps chatgpt/api_key/none/garbage/hang and never returns raw output", async () => {
  const env = mcEnv();
  try {
    const want = { chatgpt: "chatgpt", api_key: "api_key", none: "none", garbage: "unknown", hang: "unknown" };
    for (const [login, expected] of Object.entries(want)) {
      const t0 = Date.now();
      const got = await run(env, login);
      assert.equal(got, expected, login);
      assert.equal(typeof got, "string");
      assert.ok(!/SECRET|sk-/.test(JSON.stringify(got)), "raw output must not be returned");
      if (login === "hang") assert.ok(Date.now() - t0 < 10000, "the hang case is cut by timeoutMs");
    }
    // the same classes when the CLI writes to stderr
    await withEnv(fakeBin({ ...env, FAKE_STREAM: "stderr" }, "chatgpt"), () => {
      assert.equal(loginStatus({ cmd: process.execPath, args: [FAKE_CODEX_CLI] }, { spawnSync }), "chatgpt");
    });
    // a missing binary and a missing runner are "unknown", not a throw
    assert.equal(loginStatus({ cmd: path.join(env.root, "nope.exe"), args: [] }, { spawnSync }), "unknown");
    assert.equal(loginStatus({ cmd: process.execPath, args: [] }), "unknown");
  } finally { env.cleanup(); }
});

test("M3 the login cache calls the probe once within its TTL and again after it", async () => {
  let t = 1000, calls = 0;
  const cache = createLoginCache(async () => { calls++; return "chatgpt"; }, 300000, () => t);
  assert.equal(await cache({}), "chatgpt");
  t += 299999;
  assert.equal(await cache({}), "chatgpt");
  assert.equal(calls, 1);
  t += 2;
  await cache({});
  assert.equal(calls, 2);
  // concurrent callers share one probe
  t += 400000;
  await Promise.all([cache({}), cache({}), cache({})]);
  assert.equal(calls, 3);
});

test("M4 usageStatus: null, exhausted, near_limit, unknown-reset, ok, and the model is passed through", () => {
  const u = (r, model = "sol", busy = 0, lib = usage) => usageStatus(r, { now: NOW, busySlots: busy, lib, model });
  assert.deepEqual(u(null), { status: "unknown", why: "no-reading", blocks: false });
  assert.deepEqual(u({ ts: NOW }), { status: "unknown", why: "no-reading", blocks: false });
  const ex = u(reading(99));
  assert.equal(ex.status, "exhausted");
  assert.equal(ex.blocks, true);
  assert.match(ex.why, /^codex-quota /);
  const near = u(reading(88));
  assert.equal(near.status, "near_limit");
  assert.equal(near.blocks, false);
  const unk = u(reading(99, null));
  assert.deepEqual(unk, { status: "unknown", why: "codex-quota-unknown-reset", blocks: true });
  assert.deepEqual(u(reading(10)), { status: "ok", why: null, blocks: false });
  // luna: no downgrade, still near_limit through the wrapper's effective pct
  const luna = u(reading(88), "luna");
  assert.equal(luna.status, "near_limit");
  assert.equal(luna.blocks, false);
  // busy slots count 2 each: 80 + 2*3 = 86 is near_limit, 10 + 2*3 is ok
  assert.equal(u(reading(80), "luna", 3).status, "near_limit");
  // the quotaDecision spy gets exactly the model passed in, never a constant
  const seen = [];
  const spy = { mapWindows: usage.mapWindows, quotaDecision: (a) => { seen.push(a.model); return usage.quotaDecision(a); } };
  u(reading(50), "luna", 0, spy);
  u(reading(50), "astra", 0, spy);
  assert.deepEqual(seen, ["luna", "astra"]);
  // a low pct with no reset cannot be waited out: unknown and blocking (Resolution C); no weekly window at all does not block
  assert.deepEqual(u(reading(50, null)), { status: "unknown", why: "no-reset", blocks: true });
  const noWeek = u({ ts: NOW, rl: { primary: { used_percent: 5, window_minutes: 300, resets_at: FUTURE } } });
  assert.deepEqual(noWeek, { status: "unknown", why: "no-weekly-window", blocks: false });
});

function fakeLib(over = {}) {
  return { resolveCodex: () => ({ cmd: "codex", args: [] }), busySlots: async () => 0, latestReading: () => reading(10),
    mapWindows: usage.mapWindows, quotaDecision: usage.quotaDecision, ...over };
}
const gate = (o) => codexGate({ cfg: cfg(), lib: fakeLib(), login: async () => "chatgpt", allowance: createAllowance(2),
  worktreeCheck: () => ({ ok: true }), attemptId: "a1", now: NOW, ...o });

test("M5 gate order: lib, login, own cap, slots, quota, worktree, then reserve", async () => {
  let r = await gate({ lib: null });
  assert.deepEqual([r.ok, r.kind, r.reason], [false, "unavailable", "codex-skill-absent"]);
  r = await gate({ lib: fakeLib({ resolveCodex: () => { throw new Error("x"); } }) });
  assert.deepEqual([r.kind, r.reason], ["unavailable", "codex-not-found"]);
  r = await gate({ login: async () => "api_key" });
  assert.deepEqual([r.ok, r.kind, r.reason], [false, "unavailable", "codex-login-api_key"]);
  assert.equal(r.state.available, false);
  for (const who of ["none", "unknown"]) assert.equal((await gate({ login: async () => who })).reason, `codex-login-${who}`);

  const full = createAllowance(2);
  full.reserve("x"); full.reserve("y");
  r = await gate({ allowance: full });
  assert.deepEqual([r.kind, r.reason], ["busy", "codex-own-cap"]);
  assert.equal(r.state.available, true);
  assert.equal(r.state.capacity_available, false);

  r = await gate({ lib: fakeLib({ busySlots: async () => 3 }) });
  assert.deepEqual([r.kind, r.reason], ["busy", "codex-slots-full"]);
  r = await gate({ lib: fakeLib({ busySlots: async () => { throw new Error("probe"); } }) });
  assert.deepEqual([r.kind, r.reason], ["busy", "codex-slots-full"]);

  r = await gate({ lib: fakeLib({ latestReading: () => reading(99) }) });
  assert.equal(r.kind, "exhausted");
  assert.equal(r.state.usage_status, "exhausted");
  assert.equal(r.state.capacity_available, true);
  r = await gate({ lib: fakeLib({ latestReading: () => reading(99, null) }) });
  assert.deepEqual([r.kind, r.reason], ["unknown", "codex-quota-unknown-reset"]);

  const a = createAllowance(2);
  r = await gate({ allowance: a, worktreeCheck: () => ({ ok: false, reason: "worktree-busy" }) });
  assert.deepEqual([r.kind, r.reason], ["conflict", "worktree-busy"]);
  assert.equal(a.active(), 0, "a conflict reserves nothing");

  const b = createAllowance(2);
  r = await gate({ allowance: b });
  assert.equal(r.ok, true);
  assert.equal(b.active(), 1);
  assert.equal(r.state.active_jobs, 1);
  assert.equal(r.state.usage_status, "ok");
  assert.deepEqual(r.bin, { cmd: "codex", args: [] });
  // no reading yet (first run): unknown but not blocking
  r = await gate({ lib: fakeLib({ latestReading: () => null }) });
  assert.equal(r.ok, true);
  assert.equal(r.state.usage_status, "unknown");
  // the order itself: login is checked before the own cap, the cap before the slot probe
  let probed = 0;
  r = await gate({ allowance: full, lib: fakeLib({ busySlots: async () => { probed++; return 0; } }) });
  assert.equal(r.reason, "codex-own-cap");
  assert.equal(probed, 0);
  assert.equal(resourceState({ cfg: cfg(), allowance: b, gate: r }).max_parallel_jobs, 2);
});

test("M6 five gates through withLock with max 2 give exactly 2 ok; release frees one", async () => {
  const allowance = createAllowance(2);
  const lib = fakeLib({ busySlots: async () => { await new Promise((r) => setTimeout(r, 10)); return 0; } });
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) =>
    allowance.withLock(() => gate({ allowance, lib, attemptId: `a${i}` }))));
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.filter((r) => !r.ok && r.reason === "codex-own-cap").length, 3);
  assert.equal(allowance.active(), 2);
  allowance.release("a1");
  const next = await allowance.withLock(() => gate({ allowance, lib, attemptId: "a6" }));
  assert.equal(next.ok, true);
  assert.equal(allowance.active(), 2);
  allowance.rebuild(["x"]);
  assert.equal(allowance.active(), 1);
  // a throwing job does not wedge the lock
  await assert.rejects(allowance.withLock(() => { throw new Error("boom"); }));
  assert.equal(await allowance.withLock(() => "after"), "after");
  assert.deepEqual(resourceState({ cfg: cfg(), allowance }), { active_jobs: 1, max_parallel_jobs: 2, available: false, capacity_available: false, usage_status: "unknown" });
});

test("M7 fallbackFor", () => {
  const c = cfg();
  assert.deepEqual(fallbackFor("busy", c, { isNewWorker: true, queueLength: 0 }), { action: "queue", reason: "Codex busy" });
  assert.equal(fallbackFor("busy", c, { isNewWorker: false, queueLength: 3 }).action, "queue");
  assert.equal(fallbackFor("busy", c, { isNewWorker: true, queueLength: 4 }).action, "claude");
  assert.equal(fallbackFor("busy", cfg({ codex: { fallback: "refuse" } }), { isNewWorker: true, queueLength: 4 }).action, "refuse");
  assert.equal(fallbackFor("busy", c, { isNewWorker: false, queueLength: 4 }).action, "refuse");
  assert.equal(fallbackFor("exhausted", c, { isNewWorker: false, queueLength: 0 }).action, "refuse");
  assert.equal(fallbackFor("unavailable", cfg({ codex: { fallback: "refuse" } }), { isNewWorker: true, queueLength: 0 }).action, "refuse");
  assert.equal(fallbackFor("unavailable", c, { isNewWorker: true, queueLength: 0 }).action, "claude");
  assert.equal(fallbackFor("unknown", c, { isNewWorker: true, queueLength: 0 }).action, "claude");
  assert.equal(fallbackFor("conflict", c, { isNewWorker: true, queueLength: 0 }).action, "clarify");
});
