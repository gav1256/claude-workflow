// Batch B, Parts 1-3: the pure pacer (pace-lib.mjs). No files, no clock: every case passes `now`.
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../pace-lib.mjs";
import { loadConfig } from "../recover-lib.mjs";

const MIN = 60000, NOW = Date.UTC(2026, 9, 6, 12, 0, 0), S = (ms) => Math.round(ms / 1000);
// 5-hour window half gone (resets in 150 min): allowed = 95 * 150 / 300 = 47.5. Weekly window half gone (resets in 5040
// min): allowedW = 95 * (5040 + 720) / 10080 = 54.29.
const R5 = S(NOW + 150 * MIN), RW = S(NOW + 5040 * MIN);
const rd = (o = {}) => ({ ts: NOW - MIN, pct: 30, resets_at: R5, week_pct: 40, week_resets_at: RW, ...o });
const stale = (o = {}) => rd({ ts: NOW - 11 * MIN, ...o });
// A previous pace.json whose claude entry has these per-window states.
const prevOf = (five, weekly, o = {}) => ({ updated: NOW - MIN, claude: { state: P.worse(five, weekly), since: NOW - 30 * MIN, resets_at: R5, week_resets_at: RW, windows: { five_hour: { state: five }, weekly: { state: weekly } }, ...o } });
const run = (readings, prev = null, now = NOW, cfg) => P.paceState({ readings, prev, now, cfg });
const five = (r, prev) => run([r], prev).claude.windows.five_hour.state;
const week = (r, prev) => run([r], prev).claude.windows.weekly.state;

test("5-hour bands: slow and hold enter above 10 / 20 ahead and leave below 5 / 15 (hysteresis both ways)", () => {
  assert.equal(five(rd({ pct: 57 })), "ok");                           // ahead 9.5
  assert.equal(five(rd({ pct: 60 })), "slow");                         // ahead 12.5
  assert.equal(five(rd({ pct: 57 }), prevOf("slow", "ok")), "slow");   // 9.5 >= 5: stays
  assert.equal(five(rd({ pct: 52 }), prevOf("slow", "ok")), "ok");     // 4.5 < 5: leaves
  assert.equal(five(rd({ pct: 70 })), "hold");                         // ahead 22.5
  assert.equal(five(rd({ pct: 63 }), prevOf("hold", "ok")), "hold");   // 15.5 >= 15: stays
  assert.equal(five(rd({ pct: 61 }), prevOf("hold", "ok")), "slow");   // 13.5: hold left, slow kept
  assert.equal(five(rd({ pct: 50 }), prevOf("hold", "ok")), "ok");     // 2.5: both left
  const e = run([rd({ pct: 60 })]).claude;
  assert.equal(e.ahead, 12.5); assert.equal(e.pct, 60); assert.equal(e.resets_at, R5);
});

test("5-hour exhausted at pct >= 95, kept until the window resets; the next window starts from ok", () => {
  assert.equal(five(rd({ pct: 95 })), "exhausted");
  assert.equal(five(stale({ pct: 96 })), "exhausted"); // pct never falls inside a window: a stale reading proves it
  assert.equal(five(rd({ pct: 40 }), prevOf("exhausted", "ok")), "exhausted");
  const reset = prevOf("exhausted", "ok", { resets_at: S(NOW - MIN) }); // the previous window reset a minute ago
  assert.equal(five(rd({ pct: 5, resets_at: S(NOW + 299 * MIN) }), reset), "ok");
});

test("entering slow or hold needs a fresh reading; staying and leaving use the newest one even when stale", () => {
  assert.equal(five(stale({ pct: 70 })), "ok");                         // stale: no entry
  assert.equal(five(stale({ pct: 70 }), prevOf("slow", "ok")), "slow"); // no escalation either
  assert.equal(five(stale({ pct: 70 }), prevOf("hold", "ok")), "hold");
  assert.equal(five(stale({ pct: 61 }), prevOf("hold", "ok")), "slow");
  assert.equal(five(stale({ pct: 52 }), prevOf("slow", "ok")), "ok");   // leaving slow on a stale reading
  assert.equal(run([stale({ pct: 70 })], prevOf("hold", "ok")).claude.windows.five_hour.basis, "stale");
  assert.equal(run([rd({ pct: 70 })]).claude.windows.five_hour.basis, "fresh");
  // the newest reading of the window wins, not the freshest-looking value
  assert.equal(five(rd({ pct: 70, ts: NOW - 2 * MIN })), "hold");
  assert.equal(run([rd({ pct: 70, ts: NOW - 2 * MIN }), rd({ pct: 40, ts: NOW - 3 * MIN })]).claude.pct, 70);
});

test("no reading for a window, or only readings of a window that reset: that window is ok (fail open)", () => {
  const e = run([rd({ pct: 99, resets_at: S(NOW - MIN), week_pct: 99, week_resets_at: S(NOW - MIN) })], prevOf("hold", "hold")).claude;
  assert.deepEqual([e.state, e.pct, e.ahead, e.week_pct, e.week_ahead], ["ok", null, null, null, null]);
  assert.deepEqual(e.windows, { five_hour: { state: "ok", basis: "none" }, weekly: { state: "ok", basis: "none" } });
  assert.deepEqual(run([]), {});
});

test("a reading stamped in the future (the clock moved back) never shadows the newer real ones: it is skipped", () => {
  const out = run([rd({ pct: 70, ts: NOW + 60 * MIN }), rd({ pct: 30, ts: NOW - 2 * MIN })]).claude;
  assert.deepEqual([out.pct, out.state], [30, "ok"]);
  assert.equal(run([rd({ pct: 70, ts: NOW + 30000 })]).claude.pct, 70); // under a minute ahead: clock jitter, kept
});

test("pace_floor spares the first minutes of a window", () => {
  const start = S(NOW + 300 * MIN); // the window just began: allowed = max(10, 0)
  assert.equal(run([rd({ pct: 15, resets_at: start })]).claude.ahead, 5);
  assert.equal(five(rd({ pct: 15, resets_at: start })), "ok");
  assert.equal(five(rd({ pct: 21, resets_at: start })), "slow");
  assert.equal(five(rd({ pct: 21, resets_at: start }), null), "slow");
  assert.equal(run([rd({ pct: 21, resets_at: start })], null, NOW, { ...P.PACE_DEFAULTS, pace_floor: 15 }).claude.windows.five_hour.state, "ok");
});

test("weekly: its own pace line with the grace head start, bands, the 90 % slow and 97 % exhausted", () => {
  assert.equal(week(rd({ week_pct: 56 })), "ok");     // ahead 1.7
  assert.equal(week(rd({ week_pct: 60 })), "slow");   // ahead 5.7
  assert.equal(week(rd({ week_pct: 65 })), "hold");   // ahead 10.7
  assert.equal(week(rd({ week_pct: 62 }), prevOf("ok", "hold")), "hold"); // 7.7 >= 7
  assert.equal(week(rd({ week_pct: 60 }), prevOf("ok", "hold")), "slow"); // 5.7 < 7, >= 2
  assert.equal(week(rd({ week_pct: 55 }), prevOf("ok", "slow")), "ok");   // 0.7 < 2 and < 90
  assert.equal(week(rd({ week_pct: 97 })), "exhausted");
  const wStart = S(NOW + 10080 * MIN); // the week just began: allowedW = 95 * 720 / 10080 = 6.8
  assert.equal(week(rd({ week_pct: 10, week_resets_at: wStart })), "ok");  // a normal first day is not throttled
  assert.equal(week(rd({ week_pct: 13, week_resets_at: wStart })), "slow");
  const late = S(NOW + 60 * MIN);      // an hour before the weekly reset: allowedW = 95, so 91 % is behind pace...
  assert.equal(week(rd({ week_pct: 91, week_resets_at: late })), "slow"); // ...but >= 90 % is slow all the same
  assert.equal(week(rd({ week_pct: 91, week_resets_at: late }), prevOf("ok", "slow")), "slow"); // >= 90 keeps it
  assert.equal(week(rd({ week_pct: 89, week_resets_at: late }), prevOf("ok", "slow")), "ok");
  assert.equal(week(rd({ week_pct: 65, ts: NOW - 5 * 60 * MIN })), "hold"); // 5 h old is fresh for the weekly window
  assert.equal(week(rd({ week_pct: 65, ts: NOW - 7 * 60 * MIN })), "ok");   // 7 h is not
});

test("hysteresis is per window: a weekly slow never holds the 5-hour window in slow", () => {
  const prev = prevOf("ok", "slow"); // merged state slow
  const e = run([rd({ pct: 55, week_pct: 58 })], prev).claude; // 5h ahead 7.5 (in the slow band's gap), weekly ahead 3.7
  assert.equal(e.windows.five_hour.state, "ok");
  assert.equal(e.windows.weekly.state, "slow");
  assert.equal(e.state, "slow");
  const e2 = run([rd({ pct: 55, week_pct: 50 })], { claude: { ...prev.claude, windows: undefined } }).claude; // no windows = ok
  assert.equal(e2.state, "ok");
});

test("the provider's state is the more severe window; since moves only when the state changes", () => {
  assert.equal(run([rd({ pct: 60, week_pct: 65 })]).claude.state, "hold");
  assert.equal(run([rd({ pct: 96, week_pct: 65 })]).claude.state, "exhausted");
  const prev = prevOf("slow", "ok");
  assert.equal(run([rd({ pct: 60 })], prev).claude.since, NOW - 30 * MIN);
  assert.equal(run([rd({ pct: 70 })], prev).claude.since, NOW);
  assert.equal(run([rd({ pct: 60 })]).claude.since, NOW); // no previous file: entered now
});

test("providers: provider absent = claude; a weekly-only provider (Codex) gets only the weekly bands and ahead null", () => {
  const codex = { ts: NOW - 3 * 3600e3, provider: "codex", pct: null, resets_at: null, week_pct: 60, week_resets_at: RW };
  const out = run([rd({ pct: 60, provider: undefined }), codex, { ts: "x", pct: 99 }, null]);
  assert.deepEqual(Object.keys(out).sort(), ["claude", "codex"]);
  assert.equal(out.claude.state, "slow");
  assert.deepEqual([out.codex.state, out.codex.ahead, out.codex.pct, out.codex.windows.five_hour.basis], ["slow", null, null, "none"]);
  const pace = { updated: NOW, ...out, note: "x", list: [1] };
  assert.deepEqual(P.providersOf(pace).map(([p]) => p), ["claude", "codex"]); // updated and other keys skipped
});

test("readingFromStatus: windows in epoch s, ms or ISO; a missing window is null; no rate_limits = no reading", () => {
  const iso = new Date(R5 * 1000).toISOString();
  for (const v of [R5, R5 * 1000, iso, String(R5)]) assert.equal(P.readingFromStatus({ rate_limits: { five_hour: { used_percentage: 42, resets_at: v } } }, NOW).resets_at, R5);
  assert.deepEqual(P.readingFromStatus({ session_id: "s", rate_limits: { five_hour: { used_percentage: 42, resets_at: R5 }, seven_day: { used_percentage: 31.5, resets_at: RW } } }, NOW),
    { ts: NOW, provider: "claude", pct: 42, resets_at: R5, week_pct: 31.5, week_resets_at: RW });
  assert.deepEqual(P.readingFromStatus({ rate_limits: { seven_day: { used_percentage: 31, resets_at: RW } } }, NOW),
    { ts: NOW, provider: "claude", pct: null, resets_at: null, week_pct: 31, week_resets_at: RW });
  assert.equal(P.readingFromStatus({ rate_limits: { five_hour: { used_percentage: 42 } } }, NOW), null); // no reset time
  for (const i of [{}, null, { rate_limits: null }, { rate_limits: [] }]) assert.equal(P.readingFromStatus(i, NOW), null);
});

test("sameReading: equal values under unchanged_s old are skipped; a change or an older file is written", () => {
  const r = rd({ ts: NOW });
  assert.equal(P.sameReading(r, { ...r, ts: NOW - 30000 }, NOW), true);
  assert.equal(P.sameReading(r, { ...r, ts: NOW - 61000 }, NOW), false);
  assert.equal(P.sameReading(r, { ...r, pct: 31, ts: NOW - 1000 }, NOW), false);
  assert.equal(P.sameReading(r, null, NOW), false);
  assert.equal(P.sameReading(r, { ...r, ts: NOW + 5000 }, NOW), false); // stamped in the future (the clock moved back): rewritten
});

test("paceFresh: pace.json older than stale_min, from the future, or without updated is absent", () => {
  assert.ok(P.paceFresh({ updated: NOW - 14 * MIN }, NOW));
  assert.equal(P.paceFresh({ updated: NOW - 16 * MIN }, NOW), null);
  assert.equal(P.paceFresh({ updated: NOW + 5 * MIN }, NOW), null);
  assert.equal(P.paceFresh({ claude: { state: "hold" } }, NOW), null);
  assert.ok(P.paceFresh({ updated: new Date(NOW - MIN).toISOString() }, NOW)); // an ISO updated is read too
});

test("gateDecision: low is denied at slow and above; normal and high get the notice with its since; a pause denies all", () => {
  const pace = (state) => ({ updated: NOW, claude: { state, ahead: 12.4, week_ahead: 6, since: NOW - MIN } });
  assert.equal(P.gateDecision({ pace: pace("ok"), priority: "low" }), null);
  assert.equal(P.gateDecision({ pace: null, priority: "low" }), null);
  assert.deepEqual(P.gateDecision({ pace: pace("slow"), priority: "low" }), { deny: P.SLOW_DENY_TEXT(pace("slow").claude) });
  assert.match(P.SLOW_DENY_TEXT(pace("slow").claude), /^Usage is ahead of pace \(5h \+12 \/ week \+6\)\. Low-priority lanes start no new agents now\./);
  for (const st of ["slow", "hold", "exhausted"]) assert.deepEqual(P.gateDecision({ pace: pace(st), priority: "normal" }), { notice: P.SLOW_NOTICE_TEXT(pace(st).claude), since: NOW - MIN });
  assert.match(P.SLOW_NOTICE_TEXT(pace("slow").claude), /^Usage ahead of pace \(5h \+12 \/ week \+6\): step effort down/);
  assert.deepEqual(P.gateDecision({ pace: pace("ok"), priority: "high", pause: { paused: true, reason: "manual" } }), { deny: P.PAUSE_TEXT("manual") });
  assert.equal(P.gateDecision({ pace: pace("ok"), priority: "high", pause: { paused: false, reason: null } }), null);
});

test("texts: the status line, the pace table and the status header", () => {
  const e = { state: "slow", ahead: 12.4, week_ahead: 3, pct: 42, week_pct: 31, resets_at: R5, week_resets_at: RW, since: NOW };
  assert.equal(P.statusLineText({ input: {}, reading: { pct: 42, week_pct: 31 }, entry: { ...e, state: "ok" } }), "5h 42% │ wk 31%"); // ok: no pace part
  assert.equal(P.statusLineText({ input: {}, reading: { pct: 42, week_pct: 31 }, entry: e }), "5h 42% │ wk 31% │ pace slow +12");
  assert.equal(P.statusLineText({ input: {}, reading: { pct: null, week_pct: 31 } }), "wk 31%");
  assert.equal(P.statusLineText({ input: {}, entry: e }), "pace slow +12");
  assert.equal(P.statusLineText({ input: {} }), "");
  const pace = { updated: NOW, claude: e, codex: { state: "ok", pct: null, ahead: null, resets_at: null, week_pct: 12, week_ahead: -20, week_resets_at: RW, since: NOW } };
  assert.equal(P.paceHeader(pace), "pace: claude 5h 42% wk 31% slow · codex wk 12% ok");
  assert.equal(P.paceHeader({ updated: NOW }), null);
  assert.deepEqual(P.paceTable(pace), [
    "claude: slow  5h 42% ahead +12 resets 2026-10-06T14:30Z  week 31% ahead +3 resets 2026-10-10T00:00Z  since 2026-10-06T12:00Z",
    "codex: ok  5h - ahead - resets -  week 12% ahead -20 resets 2026-10-10T00:00Z  since 2026-10-06T12:00Z"]);
  assert.deepEqual(P.paceTable({}), ["no usage readings"]);
});

test("the status line's layout: every documented field in order; a missing field drops its segment; the bar; the width cap", () => {
  const input = { model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, effort: { level: "medium" }, context_window: { context_window_size: 1000000, used_percentage: 26 }, tasks: [{ status: "running" }, { status: "completed" }] };
  const reading = { pct: 6, week_pct: 31 }, entry = { state: "slow", ahead: 12.4, week_ahead: 2 };
  assert.equal(P.statusLineText({ input, reading, entry }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(P.statusLineText({ input: { ...input, tasks: [] }, reading, entry: { ...entry, state: "ok" } }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ ◇ 0 agents");
  // each missing field drops its segment (and never throws)
  const drop = (patch, o = {}) => P.statusLineText({ input: { ...input, ...patch }, reading, entry, ...o });
  assert.equal(drop({ model: undefined }), "effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({ model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 4 } }), "◆ Opus 5.5 │ effort medium │ ctx ▱▱▱▱▱▱▱▱▱▱ 4% │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents"); // no window size: no `· 1M`, and no token count for a marker
  assert.equal(drop({ effort: undefined }), "◆ Opus 5.5 · 1M │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({ effort: undefined }, { effort: "high" }), "◆ Opus 5.5 · 1M │ effort high │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents"); // the settings' effort
  assert.equal(drop({ context_window: undefined }), "◆ Opus 5.5 │ effort medium │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({ tasks: undefined }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12");
  assert.equal(drop({}, { reading: { pct: 6, week_pct: null } }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({}, { reading: null, entry: null }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ ◇ 1 agents");
  // the context: used tokens / window size when no percentage; the relay marks from the tokens (Part 8)
  assert.equal(drop({ context_window: { context_window_size: 200000 } }, { tokens: 50000, reading: null, entry: null }), "◆ Opus 5.5 · 200k │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 25% │ ◇ 1 agents");
  assert.equal(drop({ context_window: { context_window_size: 1000000, used_percentage: 41 } }, { tokens: 410000, reading: null, entry: null }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▰▱▱▱▱▱▱ 41% RELAY NOW │ ◇ 1 agents");
  assert.equal(drop({ context_window: undefined }, { tokens: 263000, reading: null, entry: null }), "◆ Opus 5.5 │ effort medium │ ctx 263k relay │ ◇ 1 agents"); // no size: the count
  // the bar rounds to the nearest 10 %
  assert.deepEqual([0, 5, 26, 100].map(P.ctxBar), ["▱▱▱▱▱▱▱▱▱▱", "▰▱▱▱▱▱▱▱▱▱", "▰▰▰▱▱▱▱▱▱▱", "▰▰▰▰▰▰▰▰▰▰"]);
  assert.deepEqual([1000000, 200000, 1500000].map(P.windowText), ["1M", "200k", "1.5M"]);
  // the width cap (~110): the pace part goes first, then wk
  const wide = { ...input, model: { display_name: "Opus 5.5 with a long name" } };
  const l = P.statusLineText({ input: wide, reading, entry });
  assert.ok(l.length <= 110, l);
  assert.doesNotMatch(l, /pace slow/); // 121 chars with it
  assert.match(l, / │ wk 31% │ ◇ 1 agents$/); // wk still fits
  assert.equal(P.runningAgents("x"), null);
});

test("paceConfig: overrides, unknown keys and bad values reported and ignored", () => {
  assert.deepEqual(P.paceConfig(undefined), { pace: { ...P.PACE_DEFAULTS }, errors: [] });
  const r = P.paceConfig({ slow_enter: 12, nope: 1, hold_enter: -1 });
  assert.equal(r.pace.slow_enter, 12); assert.equal(r.pace.hold_enter, 20);
  assert.deepEqual(r.errors, ["unknown key pace.nope", "pace.hold_enter must be a positive number"]);
  assert.deepEqual(P.paceConfig(5).errors, ["pace must be a JSON object"]);
});

test("loadConfig reads the pace object: defaults when missing, its keys validated like the flat ones", () => {
  assert.deepEqual(loadConfig(null).config.pace, P.PACE_DEFAULTS);
  const r = loadConfig('{"tick_min": 3, "pace": {"slow_enter": 12, "bogus": 1}}');
  assert.equal(r.config.tick_min, 3); assert.equal(r.config.pace.slow_enter, 12); assert.equal(r.config.pace.hold_enter, 20);
  assert.deepEqual(r.errors, ["unknown key pace.bogus"]);
  assert.deepEqual(loadConfig('{"pace": 3}').errors, ["pace must be a JSON object"]);
});

test("Part 8: the context of a main thread, its status-line part and the nudge (once past relay_ctx, every 10 min past hard_ctx)", () => {
  const a = (n, o = {}) => ({ type: "assistant", message: { usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, ...o });
  assert.equal(P.contextOfEntries([a(10), a(20), { type: "user" }, a(99, { isSidechain: true })]), 20);
  assert.equal(P.contextOfEntries([{ type: "user" }]), null);
  assert.equal(P.contextOfStatus({ context_window: { current_usage: { input_tokens: 5, cache_read_input_tokens: 7 } } }), 12);
  assert.equal(P.contextOfStatus({}), null);
  const c = P.CTX_DEFAULTS;
  assert.deepEqual([P.ctxText(12400, c), P.ctxText(263000, c), P.ctxText(402000, c), P.ctxText(250000, c), P.ctxText(null, c)], ["ctx 12k", "ctx 263k relay", "ctx 402k RELAY NOW", "ctx 250k", null]);
  assert.equal(P.ctxNudge({ tokens: 250000, now: NOW, cfg: c }), null); // "past" 250k
  assert.deepEqual(P.ctxNudge({ tokens: 263000, now: NOW, cfg: c }), { kind: "relay", text: P.CTX_RELAY_TEXT(263000, c), ctx: { relay: true } });
  assert.equal(P.ctxNudge({ tokens: 300000, seen: { relay: true }, now: NOW, cfg: c }), null);
  assert.deepEqual(P.ctxNudge({ tokens: 402000, seen: { relay: true }, now: NOW, cfg: c }).ctx, { relay: true, hard_at: NOW });
  assert.equal(P.ctxNudge({ tokens: 402000, seen: { relay: true, hard_at: NOW - 9 * MIN }, now: NOW, cfg: c }), null);
  assert.ok(P.ctxNudge({ tokens: 402000, seen: { relay: true, hard_at: NOW - 10 * MIN }, now: NOW, cfg: c }));
  assert.ok(P.ctxNudge({ tokens: 402000, seen: { hard_at: NOW + 60 * MIN }, now: NOW, cfg: c })); // a marker from the future is stale
  assert.deepEqual(P.ctxConfig({ relay_ctx: 100000, hard_ctx: -1 }), { relay_ctx: 100000, hard_ctx: 400000 });
  assert.deepEqual(loadConfig('{"relay_ctx": 200000}').errors, []);
});

test("an early window reset (the reset time jumps away) clears exhausted; a drift under 5 min does not", () => {
  const day = 1440 * MIN;
  const wk = prevOf("ok", "exhausted", { week_resets_at: S(NOW + 2 * day) });
  assert.equal(week(rd({ week_pct: 1, week_resets_at: S(NOW + 7 * day) }), wk), "ok");
  assert.equal(week(rd({ week_pct: 40, week_resets_at: S(NOW + 2 * day + 4 * MIN) }), wk), "exhausted");
  const h5 = prevOf("exhausted", "ok", { resets_at: S(NOW + 30 * MIN) });
  assert.equal(five(rd({ pct: 1, resets_at: S(NOW + 300 * MIN) }), h5), "ok");
  assert.equal(five(rd({ pct: 40, resets_at: S(NOW + 30 * MIN + 240000) }), h5), "exhausted");
});

test("windowElapsed: minutes elapsed and total; non-working intervals are clipped and subtracted", () => {
  assert.deepEqual(P.windowElapsed(S(NOW + 150 * MIN), 300, NOW), { elapsed: 150, total: 300 });
  assert.deepEqual(P.windowElapsed(S(NOW + 150 * MIN), 300, NOW, []), { elapsed: 150, total: 300 });
  // one 60-min interval fully past (before now) and inside the window: both shrink; one clipped at the window start
  assert.deepEqual(P.windowElapsed(S(NOW + 150 * MIN), 300, NOW, [{ start: NOW - 100 * MIN, end: NOW - 40 * MIN }]), { elapsed: 90, total: 240 });
  assert.deepEqual(P.windowElapsed(S(NOW + 150 * MIN), 300, NOW, [{ start: NOW - 200 * MIN, end: NOW - 100 * MIN }]), { elapsed: 100, total: 250 });
});

test("input hardening: pct clamped, reserved provider names skipped, inverted hysteresis and pace null rejected", () => {
  assert.equal(run([rd({ pct: -50 })]).claude.pct, 0);
  assert.equal(run([rd({ pct: 250 })]).claude.pct, 100);
  const out = run([rd({ provider: "__proto__" }), rd({ provider: "constructor" }), rd({ provider: "prototype" }), rd({ provider: "updated" }), rd()]);
  assert.deepEqual(Object.keys(out), ["claude"]);
  assert.equal(Object.getPrototypeOf(out) === Object.prototype || Object.getPrototypeOf(out) === null, true);
  const r = P.paceConfig({ slow_leave: 12, slow_enter: 10 });
  assert.deepEqual(r.errors, ["pace.slow_leave must be below pace.slow_enter"]);
  assert.equal(r.pace.slow_leave, 5); assert.equal(r.pace.slow_enter, 10);
  assert.deepEqual(P.paceConfig(null).errors, ["pace must be a JSON object"]);
});
