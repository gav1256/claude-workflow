// Batch B, Parts 1-2 on disk: the status-line recorder (`coord.mjs statusline`), pace.json and `coord.mjs pace`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sandbox, coordRun, COORD_MJS, tx } from "./helpers.mjs";

const MIN = 60000, SID = "11111111-2222-3333-4444-555555555555";
const S = (ms) => Math.round(ms / 1000);
// A status-line stdin: the 5-hour window half gone, the weekly one half gone (pace-lib.test.mjs's numbers).
const status = (o = {}) => ({ session_id: SID, model: { id: "claude-opus-5-5" }, rate_limits: {
  five_hour: { used_percentage: 42, resets_at: S(Date.now() + 150 * MIN) }, seven_day: { used_percentage: 31, resets_at: S(Date.now() + 5040 * MIN) } }, ...o });
const usageFile = (sb, sid = SID) => path.join(sb.coord, "usage", `${sid}.json`);
const paceFile = (sb) => path.join(sb.coord, "pace.json");
const readJ = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("statusline: records the reading, writes pace.json, prints one short line", () => {
  const sb = sandbox();
  try {
    const r = coordRun(sb, ["statusline"], { input: status() });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "5h 42% │ wk 31%\n"); // no model, effort or context fields in this stdin: their segments are dropped
    const u = readJ(usageFile(sb));
    assert.deepEqual([u.provider, u.pct, u.week_pct, typeof u.ts], ["claude", 42, 31, "number"]);
    const p = readJ(paceFile(sb));
    assert.equal(p.claude.state, "ok"); assert.equal(p.claude.pct, 42); assert.ok(Date.now() - p.updated < MIN);
  } finally { sb.cleanup(); }
});

test("statusline: no rate_limits writes nothing and prints only the pace part of a fresh pace.json", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["statusline"], { input: { session_id: SID } });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    assert.equal(fs.existsSync(path.join(sb.coord, "usage")), false); assert.equal(fs.existsSync(paceFile(sb)), false);
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(paceFile(sb), JSON.stringify({ updated: Date.now(), claude: { state: "slow", ahead: 12.4, week_ahead: 2, since: Date.now() } }));
    r = coordRun(sb, ["statusline"], { input: { session_id: SID } });
    assert.equal(r.out, "pace slow +12\n");
    fs.writeFileSync(paceFile(sb), JSON.stringify({ updated: Date.now() - 16 * MIN, claude: { state: "slow", since: 1 } })); // stale = absent
    assert.equal(coordRun(sb, ["statusline"], { input: { session_id: SID } }).out, "");
  } finally { sb.cleanup(); }
});

test("statusline: one window missing is recorded as null; the same values under 60 s old are not rewritten", () => {
  const sb = sandbox();
  try {
    const one = status({ rate_limits: { seven_day: { used_percentage: 31, resets_at: S(Date.now() + 5040 * MIN) } } });
    assert.equal(coordRun(sb, ["statusline"], { input: one }).out, "wk 31%\n");
    const u = readJ(usageFile(sb));
    assert.equal(u.pct, null); assert.equal(u.resets_at, null);
    fs.writeFileSync(usageFile(sb), JSON.stringify({ ...u, ts: u.ts - 30000 })); // the same values, 30 s old
    coordRun(sb, ["statusline"], { input: one });
    assert.equal(readJ(usageFile(sb)).ts, u.ts - 30000); // unchanged: not rewritten
    coordRun(sb, ["statusline"], { input: status() });
    assert.equal(readJ(usageFile(sb)).pct, 42); // changed: rewritten
  } finally { sb.cleanup(); }
});

test("statusline: pace.json is recomputed only when older than 30 s", () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(sb.coord, { recursive: true });
    const young = { updated: Date.now() - 10000, claude: { state: "slow", ahead: 11, week_ahead: 0, since: 5 } };
    fs.writeFileSync(paceFile(sb), JSON.stringify(young));
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "5h 42% │ wk 31% │ pace slow +11\n");
    assert.deepEqual(readJ(paceFile(sb)), young); // under 30 s old: kept
    fs.writeFileSync(paceFile(sb), JSON.stringify({ ...young, updated: Date.now() - 40000 }));
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "5h 42% │ wk 31%\n");
    assert.equal(readJ(paceFile(sb)).claude.state, "ok");
  } finally { sb.cleanup(); }
});

test("statusline: a status line the user had before runs first with the same stdin", () => {
  const sb = sandbox();
  try {
    const script = path.join(sb.tmp, "chain.cjs");
    fs.writeFileSync(script, "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => console.log('mine ' + JSON.parse(s).session_id.slice(0, 8)));\n");
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "statusline-chain.json"), JSON.stringify({ command: `"${process.execPath}" "${script}"` }));
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "mine 11111111\n5h 42% │ wk 31%\n");
    fs.writeFileSync(path.join(sb.coord, "statusline-chain.json"), JSON.stringify({ command: "exit 3" })); // a failing chain prints nothing of it
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "5h 42% │ wk 31%\n");
  } finally { sb.cleanup(); }
});

test("statusline fails safe: garbage stdin, an unwritable usage dir, a session id that is not a plain id", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["statusline"], { input: "{oops" });
    assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    fs.mkdirSync(sb.coord, { recursive: true }); fs.writeFileSync(path.join(sb.coord, "usage"), "a file, not a dir");
    r = coordRun(sb, ["statusline"], { input: status() });
    assert.equal(r.code, 0); assert.equal(r.err, "");
    fs.rmSync(path.join(sb.coord, "usage"));
    r = coordRun(sb, ["statusline"], { input: status({ session_id: "../x" }) });
    assert.equal(r.code, 0); assert.equal(fs.existsSync(path.join(sb.coord, "usage")), false);
  } finally { sb.cleanup(); }
});

test("two recorders at once leave valid JSON in usage/ and pace.json", async () => {
  const sb = sandbox();
  try {
    const one = (sid, pct) => new Promise((done) => {
      const p = spawn(process.execPath, [COORD_MJS, "statusline"], { env: sb.env, windowsHide: true });
      p.on("close", done); p.stdin.end(JSON.stringify(status({ session_id: sid, rate_limits: { ...status().rate_limits, five_hour: { used_percentage: pct, resets_at: S(Date.now() + 150 * MIN) } } })));
    });
    for (let i = 0; i < 3; i++) await Promise.all([one("aaaa-1", 40 + i), one("bbbb-2", 50 + i), one("aaaa-1", 60 + i)]);
    for (const f of ["aaaa-1", "bbbb-2"]) assert.equal(typeof readJ(usageFile(sb, f)).pct, "number");
    const p = readJ(paceFile(sb));
    assert.equal(typeof p.claude.state, "string");
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "usage")).filter((f) => f.endsWith(".tmp")), []);
  } finally { sb.cleanup(); }
});

test("coord.mjs pace prints the table from the usage files (Codex included) and writes nothing; --json the object", () => {
  const sb = sandbox();
  try {
    assert.equal(coordRun(sb, ["pace"]).out, "no usage readings\n");
    fs.mkdirSync(path.join(sb.coord, "usage"), { recursive: true });
    const now = Date.now(), wk = S(now + 5040 * MIN);
    fs.writeFileSync(usageFile(sb), JSON.stringify({ ts: now - MIN, provider: "claude", pct: 60, resets_at: S(now + 150 * MIN), week_pct: 31, week_resets_at: wk }));
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-r1.json"), JSON.stringify({ ts: now - MIN, provider: "codex", pct: null, resets_at: null, week_pct: 12, week_resets_at: wk }));
    const r = coordRun(sb, ["pace"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^claude: slow {2}5h 60% ahead \+13 resets \S+Z {2}week 31% ahead -23 resets \S+Z {2}since \S+Z$/m);
    assert.match(r.out, /^codex: ok {2}5h - ahead - resets - {2}week 12% ahead -42 resets \S+Z {2}since \S+Z$/m);
    assert.equal(fs.existsSync(paceFile(sb)), false);
    // A corrupt Codex file, one with strings for numbers, and a list are skipped; the others still count.
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-bad.json"), "{");
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-str.json"), JSON.stringify({ ts: String(now), provider: "codex", week_pct: "99", week_resets_at: String(wk) }));
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-list.json"), "[1, 2]");
    assert.equal(coordRun(sb, ["pace"]).out.replace(/since \S+/g, ""), r.out.replace(/since \S+/g, ""));
    const j = JSON.parse(coordRun(sb, ["pace", "--json"]).out);
    assert.deepEqual([j.claude.state, j.codex.state, typeof j.updated], ["slow", "ok", "number"]);
  } finally { sb.cleanup(); }
});

test("statusline: the user's layout from a full stdin; the context from context_window, else the transcript's tail; the settings' effort", () => {
  const sb = sandbox();
  try {
    const t = (tokens) => { const f = path.join(sb.tmp, `t-${tokens}.jsonl`); fs.writeFileSync(f, tx({ start: Date.now() - MIN }).tokens(tokens - 1000, 900, 100).user("go").call("Read", {}).entries().map((x) => JSON.stringify(x)).join("\n") + "\n"); return f; };
    const full = (o = {}) => status({ model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, effort: { level: "medium" },
      context_window: { context_window_size: 1000000, used_percentage: 26, current_usage: { input_tokens: 1000, cache_read_input_tokens: 255000, cache_creation_input_tokens: 4000 } }, ...o });
    let r = coordRun(sb, ["statusline"], { input: full() });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 42% │ wk 31%\n");
    assert.ok(r.out.trim().length <= 110);
    // no context_window: Part 8's tokens from the transcript's tail, shown as a count (no window size to divide by)
    assert.equal(coordRun(sb, ["statusline"], { input: full({ context_window: undefined, transcript_path: t(402000) }) }).out, "◆ Opus 5.5 │ effort medium │ ctx 402k RELAY NOW │ 5h 42% │ wk 31%\n");
    // a window size and the tail's tokens, but no percentage: tokens / size
    assert.equal(coordRun(sb, ["statusline"], { input: full({ context_window: { context_window_size: 200000 }, transcript_path: t(12000) }) }).out, "◆ Opus 5.5 · 200k │ effort medium │ ctx ▰▱▱▱▱▱▱▱▱▱ 6% │ 5h 42% │ wk 31%\n");
    // no effort.level in stdin: the settings' (modelSettings for this model, else effortLevel); none: dropped
    fs.writeFileSync(path.join(sb.cfg, "settings.json"), JSON.stringify({ effortLevel: "high", modelSettings: { "claude-opus-5-5": { effortLevel: "low" } } }));
    assert.match(coordRun(sb, ["statusline"], { input: full({ effort: undefined }) }).out, /^◆ Opus 5\.5 · 1M │ effort low │ ctx /);
    fs.writeFileSync(path.join(sb.cfg, "settings.json"), JSON.stringify({ effortLevel: "high" }));
    assert.match(coordRun(sb, ["statusline"], { input: full({ effort: undefined }) }).out, /^◆ Opus 5\.5 · 1M │ effort high │ ctx /);
    fs.rmSync(path.join(sb.cfg, "settings.json"));
    assert.match(coordRun(sb, ["statusline"], { input: full({ effort: undefined }) }).out, /^◆ Opus 5\.5 · 1M │ ctx /);
    // no rate_limits: no 5h/wk part, nothing written
    assert.equal(coordRun(sb, ["statusline"], { input: { session_id: SID, model: { display_name: "Opus 5.5" } } }).out, "◆ Opus 5.5\n");
  } finally { sb.cleanup(); }
});
