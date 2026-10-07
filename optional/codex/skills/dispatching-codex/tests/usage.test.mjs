import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpEnv, TESTS_DIR, rmrf } from "./helpers.mjs";

// paths.mjs reads the environment at import, so set it before the dynamic imports.
const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = env.CODEX_HOME;
const P = await import("../lib/paths.mjs");
const U = await import("../lib/usage.mjs");
assert.equal(P.USAGE_DIR.startsWith(env.root), true, "usage dir must be inside the temp root");
after(() => env.cleanup());

const FX = (n) => path.join(TESTS_DIR, "fixtures", n);
const NOW = Date.parse("2026-10-06T10:30:00.000Z");

function putRollout(day, threadId, fixture, stamp = "2026-10-06T00-30-00") {
  const [y, m, d] = day.split("-");
  const dir = path.join(P.CODEX_HOME, "sessions", y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
  fs.copyFileSync(FX(fixture), f);
  return f;
}

beforeEach(() => {
  rmrf(path.join(P.CODEX_HOME, "sessions"));
  rmrf(P.USAGE_DIR);
  rmrf(P.STATE);
});

test("findRollout: today, yesterday's UTC folder at 00:30 UTC, and missing", () => {
  const f = putRollout("2026-10-06", "t-today", "rollout-weekly.jsonl");
  assert.equal(U.findRollout("t-today", NOW), f);
  const y = putRollout("2026-10-05", "t-yday", "rollout-both.jsonl", "2026-10-05T23-55-00");
  assert.equal(U.findRollout("t-yday", Date.parse("2026-10-06T00:30:00.000Z")), y);
  assert.equal(U.findRollout("t-none", NOW), null);
  assert.equal(U.findRollout("../x", NOW), null);
});

test("findRollout: finds a run's rollout in tomorrow's UTC folder (local-date folder names, UTC+3 at 22:00 UTC)", () => {
  const late = Date.parse("2026-10-06T22:30:00.000Z");
  const f = putRollout("2026-10-07", "t-tomorrow", "rollout-weekly.jsonl", "2026-10-07T01-20-00");
  assert.equal(U.findRollout("t-tomorrow", late), f);
});

test("lastRateLimits: weekly-only fixture, ts is the event's epoch ms (13 digits)", () => {
  const r = U.lastRateLimits(FX("rollout-weekly.jsonl"));
  assert.equal(r.ts, Date.parse("2026-10-06T09:02:00.000Z"));
  assert.match(String(r.ts), /^\d{13}$/);
  assert.equal(r.rl.primary.used_percent, 25);
  assert.equal(r.rl.secondary, null);
});

test("lastRateLimits: newest valid event wins, trailing junk skipped; no event gives null", () => {
  assert.equal(U.lastRateLimits(FX("rollout-both.jsonl")).rl.primary.used_percent, 33);
  const f = path.join(env.root, "empty.jsonl");
  fs.writeFileSync(f, '{"type":"session_meta","payload":{}}\n');
  assert.equal(U.lastRateLimits(f), null);
  assert.equal(U.lastRateLimits(path.join(env.root, "nope.jsonl")), null);
});

test("mapWindows: weekly-only, both, none", () => {
  const w = U.mapWindows(U.lastRateLimits(FX("rollout-weekly.jsonl")).rl);
  assert.deepEqual(w, { pct: null, resets_at: null, week_pct: 25, week_resets_at: 1791801438 });
  const b = U.mapWindows(U.lastRateLimits(FX("rollout-both.jsonl")).rl);
  assert.deepEqual(b, { pct: 33, resets_at: 1791000000, week_pct: 41, week_resets_at: 1791600000 });
  assert.deepEqual(U.mapWindows({}), { pct: null, resets_at: null, week_pct: null, week_resets_at: null });
  assert.deepEqual(U.mapWindows(null), { pct: null, resets_at: null, week_pct: null, week_resets_at: null });
});

test("recordUsage: numeric fields, 13-digit ts, provider and codex- prefix; null reading writes nothing", () => {
  U.recordUsage("20261006T000000Z-aaaaaa", U.lastRateLimits(FX("rollout-both.jsonl")));
  const file = path.join(P.USAGE_DIR, "codex-20261006T000000Z-aaaaaa.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(j.provider, "codex");
  assert.match(String(j.ts), /^\d{13}$/);
  for (const k of ["ts", "pct", "resets_at", "week_pct", "week_resets_at"]) assert.equal(typeof j[k], "number", k);
  const last = JSON.parse(fs.readFileSync(P.LAST_USAGE, "utf8"));
  assert.equal(last.ts, j.ts);
  assert.equal(last.rate_limits.primary.used_percent, 33);

  U.recordUsage("20261006T000001Z-bbbbbb", U.lastRateLimits(FX("rollout-weekly.jsonl")));
  const w = JSON.parse(fs.readFileSync(path.join(P.USAGE_DIR, "codex-20261006T000001Z-bbbbbb.json"), "utf8"));
  assert.equal(w.pct, null);
  assert.equal(w.week_pct, 25);

  const before = fs.readdirSync(P.USAGE_DIR).length;
  U.recordUsage("20261006T000002Z-cccccc", null);
  assert.equal(fs.readdirSync(P.USAGE_DIR).length, before);
  assert.throws(() => U.recordUsage("../evil", U.lastRateLimits(FX("rollout-both.jsonl"))));
});

test("recordUsage: 21 runs keep the newest 20 codex files and leave other providers alone", () => {
  fs.mkdirSync(P.USAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(P.USAGE_DIR, "claude-x.json"), "{}");
  const reading = U.lastRateLimits(FX("rollout-both.jsonl"));
  const t0 = Date.now() / 1000 - 100;
  for (let i = 0; i < 21; i++) {
    const id = `20261006T0000${String(i).padStart(2, "0")}Z-r${i}`;
    U.recordUsage(id, reading);
    const f = path.join(P.USAGE_DIR, `codex-${id}.json`);
    fs.utimesSync(f, t0 + i, t0 + i);
  }
  const codex = fs.readdirSync(P.USAGE_DIR).filter((n) => n.startsWith("codex-"));
  assert.equal(codex.length, 20);
  assert.equal(codex.some((n) => n.includes("-r0.json")), false, "oldest pruned");
  assert.equal(codex.some((n) => n.includes("-r20.json")), true);
  assert.equal(fs.existsSync(path.join(P.USAGE_DIR, "claude-x.json")), true);
});

test("latestReading: newest event across rollouts; old rollouts skipped; LAST_USAGE fallback; none", () => {
  assert.equal(U.latestReading(NOW), null);
  const a = putRollout("2026-10-06", "t-a", "rollout-weekly.jsonl"); // event 09:02
  putRollout("2026-10-06", "t-b", "rollout-both.jsonl"); // event 10:05, newer
  assert.equal(U.latestReading(NOW).ts, Date.parse("2026-10-06T10:05:00.000Z"));
  // An 8+ day old rollout file is ignored.
  const old = Date.now() / 1000 - 9 * 86400;
  for (const f of fs.readdirSync(path.dirname(a)).map((n) => path.join(path.dirname(a), n))) fs.utimesSync(f, old, old);
  assert.equal(U.latestReading(Date.now()), null);
  // LAST_USAGE is the fallback.
  fs.mkdirSync(P.STATE, { recursive: true });
  fs.writeFileSync(P.LAST_USAGE, JSON.stringify({ ts: 1790000000000, rate_limits: { primary: null } }));
  assert.equal(U.latestReading(Date.now()).ts, 1790000000000);
});

const HOUR = 3600000;
const rl = (week, extra = {}) => ({
  primary: { used_percent: week, window_minutes: 10080, resets_at: Math.floor((NOW + 48 * HOUR) / 1000) },
  secondary: null,
  rate_limit_reached_type: null,
  ...extra,
});
const dec = (reading, o = {}) => U.quotaDecision({ reading, now: NOW, busySlots: 0, mode: "write", model: "sol", ...o });

test("quotaDecision: run, unknown, stale", () => {
  const fresh = { ts: NOW - HOUR, rl: rl(10) };
  assert.deepEqual(dec(fresh), { action: "run", notes: [] });
  assert.deepEqual(dec(null).notes, ["codex-quota-unknown"]);
  assert.equal(dec(null).action, "run");
  const nullReset = { ts: NOW, rl: { primary: { used_percent: 99, window_minutes: 10080, resets_at: null }, secondary: null } };
  assert.deepEqual(dec(nullReset), { action: "block", reason: "codex-quota-unknown-reset", notes: ["codex-quota-unknown"] });
  const stale = dec({ ts: NOW - 7 * HOUR, rl: rl(10) });
  assert.equal(stale.action, "run");
  assert.deepEqual(stale.notes, ["codex-quota-stale"]);
});

test("quotaDecision: busy slots add 2 points and cross 85 and 95", () => {
  const r = { ts: NOW, rl: rl(81) };
  assert.equal(dec(r, { busySlots: 1 }).action, "run"); // 83
  assert.equal(dec(r, { busySlots: 2 }).action, "downgrade"); // 85
  const r2 = { ts: NOW, rl: rl(91) };
  assert.equal(dec(r2, { busySlots: 1 }).action, "downgrade"); // 93
  const b = dec(r2, { busySlots: 2 }); // 95
  assert.equal(b.action, "block");
  assert.equal(b.reason, `codex-quota ${new Date(r2.rl.primary.resets_at * 1000).toISOString()}`);
});

test("quotaDecision: downgrade only for write on sol", () => {
  const r = { ts: NOW, rl: rl(88) };
  assert.equal(dec(r).action, "downgrade");
  assert.equal(dec(r, { model: "luna" }).action, "run");
  assert.equal(dec(r, { mode: "review" }).action, "run");
});

test("quotaDecision: reached type with a future resets_at blocks; a past one does not", () => {
  const r = { ts: NOW, rl: rl(10, { rate_limit_reached_type: "primary" }) };
  const b = dec(r);
  assert.equal(b.action, "block");
  assert.match(b.reason, /^codex-quota 20\d\d-\d\d-\d\dT/);
  const past = { ts: NOW, rl: { primary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor((NOW - HOUR) / 1000) }, secondary: null, rate_limit_reached_type: "primary" } };
  assert.equal(dec(past).action, "run");
});

test("quotaDecision: no reset at all -> unknown-reset block only at high pct or a reached type", () => {
  const low = { ts: NOW, rl: { primary: { used_percent: 50, window_minutes: 10080, resets_at: null }, secondary: null } };
  assert.deepEqual(dec(low), { action: "run", notes: ["codex-quota-unknown"] });
  const reached = { ts: NOW, rl: { primary: { used_percent: 10, window_minutes: 10080, resets_at: null }, secondary: null, rate_limit_reached_type: "primary" } };
  assert.equal(dec(reached).reason, "codex-quota-unknown-reset");
});
test("latestReading: only the last 10 day folders (tomorrow .. today-8, UTC) are walked", () => {
  putRollout("2026-09-06", "t-old", "rollout-both.jsonl"); // fresh mtime, newest event
  assert.equal(U.latestReading(NOW), null);
  putRollout("2026-10-06", "t-new", "rollout-weekly.jsonl");
  assert.equal(U.latestReading(NOW).ts, Date.parse("2026-10-06T09:02:00.000Z"));
});

test("latestReading: walks tomorrow's UTC folder too (Codex names folders by local date)", () => {
  const late = Date.parse("2026-10-06T22:30:00.000Z");
  putRollout("2026-10-07", "t-tomorrow", "rollout-weekly.jsonl", "2026-10-07T01-20-00"); // event 2026-10-06T09:02
  assert.equal(U.latestReading(late).ts, Date.parse("2026-10-06T09:02:00.000Z"));
});

test("quotaDecision: a window past its resets_at counts 0", () => {
  const r = { ts: NOW, rl: { primary: { used_percent: 99, window_minutes: 10080, resets_at: Math.floor((NOW - HOUR) / 1000) }, secondary: null, rate_limit_reached_type: null } };
  assert.equal(dec(r).action, "run");
  assert.equal(dec(r, { busySlots: 1 }).action, "run"); // 0 + 2
});

test("codexTokens sums turn.completed usage, ignores junk, missing file gives zeros", () => {
  const f = path.join(env.root, "events.jsonl");
  const ev = (u) => JSON.stringify({ type: "turn.completed", usage: u });
  fs.writeFileSync(f, [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    ev({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }),
    "garbage turn.completed {",
    ev({ input_tokens: 200, cached_input_tokens: 0, output_tokens: 5 }),
  ].join("\n") + "\n");
  assert.deepEqual(U.codexTokens(f), { in: 1200, cached: 800, out: 55 });
  assert.deepEqual(U.codexTokens(path.join(env.root, "nope")), { in: 0, cached: 0, out: 0 });
});
