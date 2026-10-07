import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpEnv, rmrf } from "./helpers.mjs";

// paths.mjs reads the environment at import, so set it before the dynamic imports.
const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = env.CODEX_HOME;
const P = await import("../lib/paths.mjs");
const { statusLine } = await import("../lib/status.mjs");
assert.equal(P.PACE.startsWith(env.root), true, "pace file must be inside the temp root");
after(() => env.cleanup());

const NOW = Date.now();
const sec = (ms) => Math.floor(ms / 1000);
const FUTURE = sec(NOW + 3 * 86400000);
const PAST = sec(NOW - 3600000);

function put(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
}
const codexUsage = (week, weekResets = FUTURE) => ({
  ts: NOW,
  rate_limits: { primary: { window_minutes: 10080, used_percent: week, resets_at: weekResets } },
});
const pace = (claude, updated = sec(NOW)) => ({ updated, claude });

beforeEach(() => {
  rmrf(path.join(env.CLAUDE_CONFIG_DIR, "state"));
});

test("both present: codex week with reset time, claude 5h and week", () => {
  put(P.LAST_USAGE, codexUsage(12));
  put(P.PACE, pace({ state: "ok", pct: 42, ahead: 0, resets_at: FUTURE, week_pct: 31, week_resets_at: FUTURE }));
  const s = statusLine();
  assert.match(s, /^codex week 12% \(resets [A-Z][a-z]{2} \d\d:\d\d\) · claude 5h 42% week 31%$/);
});

test("each piece missing", () => {
  assert.equal(statusLine(), "codex: no reading · claude: no reading");
  put(P.LAST_USAGE, codexUsage(12));
  assert.match(statusLine(), /^codex week 12% .* · claude: no reading$/);
  rmrf(P.LAST_USAGE);
  put(P.PACE, pace({ state: "ok", pct: 5, resets_at: FUTURE, week_pct: 6, week_resets_at: FUTURE }));
  assert.equal(statusLine(), "codex: no reading · claude 5h 5% week 6%");
});

test("a window past its reset counts 0", () => {
  put(P.LAST_USAGE, codexUsage(80, PAST));
  put(P.PACE, pace({ state: "ok", pct: 90, resets_at: PAST, week_pct: 70, week_resets_at: FUTURE }));
  const s = statusLine();
  assert.match(s, /^codex week 0% /);
  assert.match(s, /claude 5h 0% week 70%$/);
});

test("pace older than 15 minutes is absent", () => {
  put(P.PACE, pace({ state: "ok", pct: 5, resets_at: FUTURE, week_pct: 6, week_resets_at: FUTURE }, sec(NOW - 16 * 60000)));
  assert.match(statusLine(), /claude: no reading$/);
  put(P.PACE, pace({ state: "ok", pct: 5, resets_at: FUTURE, week_pct: 6, week_resets_at: FUTURE }, sec(NOW - 5 * 60000)));
  assert.match(statusLine(), /claude 5h 5% week 6%$/);
});

test("corrupt or odd JSON reads as no reading and never throws", () => {
  put(P.LAST_USAGE, "{not json");
  put(P.PACE, "][");
  assert.equal(statusLine(), "codex: no reading · claude: no reading");
  put(P.LAST_USAGE, "null");
  put(P.PACE, JSON.stringify({ updated: sec(NOW), claude: "x" }));
  assert.equal(statusLine(), "codex: no reading · claude: no reading");
  put(P.LAST_USAGE, JSON.stringify({ ts: NOW, rate_limits: { primary: { window_minutes: 7, used_percent: 1 } } }));
  assert.match(statusLine(), /^codex: no reading/);
});

test("quarantined slots are listed (A7); a live active slot and clean slots are not", () => {
  const rec = (n, o) => put(path.join(P.SLOT_LOCKS, `${n}.json`), o);
  rec(1, { v: 1, state: "clean", run_id: null });
  rec(2, { v: 1, kind: "slot", key: "2", state: "active", run_id: "run-dead", run_dir: "x", owner_pid: 2147483000,
    owner_start_time: new Date().toISOString(), child_pids: [], host_started: false,
    baseline: "a".repeat(40), tree_hash_pre: "b".repeat(64), tree_hash_final: null });
  rec(3, { v: 1, kind: "slot", key: "3", state: "active", run_id: "run-live", run_dir: "x", owner_pid: process.pid,
    owner_start_time: new Date().toISOString(), child_pids: [], host_started: false,
    baseline: "a".repeat(40), tree_hash_pre: "b".repeat(64), tree_hash_final: null });
  const s = statusLine();
  assert.match(s, /quarantined: slot 2 \(run-dead\)/);
  assert.doesNotMatch(s, /slot 1|slot 3/);
  rec(1, "{broken");
  assert.match(statusLine(), /slot 1 \(\?\)/);
});
