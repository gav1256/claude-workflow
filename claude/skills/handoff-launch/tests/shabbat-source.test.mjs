// S3: the off table supplies the pause source and the Agent/Stop text, in a private coord sandbox.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, coordRun, sessionLine, COORD_MJS } from "./helpers.mjs";

const MIN = 60000, NOW = Date.UTC(2026, 9, 6, 12), SKILL = fileURLToPath(new URL("../", import.meta.url));
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const table = (start) => ({ tz: "Asia/Jerusalem", until: start + 100 * 864e5, intervals: [{ start, end: start + 25 * 60 * MIN, kind: "shabbat" }] });
function child(sb, code, env = {}) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...sb.env, ...env }, cwd: sb.tmp, encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return JSON.parse(r.stdout);
}
const url = (f) => JSON.stringify(pathToFileURL(f).href);

test("gate text in the lead hour", () => {
  const sb = sandbox();
  try {
    put(sb.offtimes, table(Date.now() + 30 * MIN));
    const r = coordRun(sb, ["agent-gate"], { input: { tool_name: "Agent", session_id: "probe-1" }, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } });
    assert.equal(r.code, 0, r.err);
    const d = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /^Shabbat\/Yom Tov in (29|30) min: finish the current step, save state, end your turn\.$/);
  } finally { sb.cleanup(); }
});

test("off: no shabbat source and plain 7-day pacing", () => {
  const sb = sandbox();
  try {
    put(sb.offtimes, table(NOW - 60 * MIN));
    const r = child(sb, `
      const PI = await import(${url(path.join(SKILL, "pause-io.mjs"))}), P = await import(${url(path.join(SKILL, "pace-lib.mjs"))}), fs = await import("node:fs");
      const now = ${NOW}, readings = [{ ts: now, week_pct: 40, week_resets_at: (now + 5040 * 60000) / 1000 }];
      const on = { sources: PI.readSources(now), off: PI.readOffTimes(now), pace: P.paceState({ readings, now, off: PI.readOffTimes(now) }) };
      fs.mkdirSync(${JSON.stringify(sb.coord)}, { recursive: true });
      fs.writeFileSync(PI.SHABBOS, JSON.stringify({ enabled: false }));
      const off = PI.readOffTimes(now);
      process.stdout.write(JSON.stringify({ on, off, sources: PI.readSources(now), pace: P.paceState({ readings, now, off }), plain: P.paceState({ readings, now }), window: P.windowElapsed(readings[0].week_resets_at, 10080, now, off) }));
    `);
    assert.equal(r.on.sources[0]?.source, "shabbat");
    assert.equal(r.on.off.length, 1);
    assert.deepEqual(r.off, []);
    assert.deepEqual(r.sources, []);
    assert.deepEqual(r.pace, r.plain);
    assert.notEqual(r.on.pace.claude.week_ahead, r.plain.claude.week_ahead);
    assert.deepEqual(r.window, { elapsed: 5040, total: 10080 });
  } finally { sb.cleanup(); }
});

test("coord.mjs offNear's table path and lead are pause-io's and pause-lib's", () => {
  const sb = sandbox();
  try {
    put(sb.offtimes, table(NOW));
    for (const env of [{ HL_OFFTIMES_FILE: "offtimes.json" }, { HL_OFFTIMES_FILE: sb.offtimes }]) {
      const r = child(sb, `
        const C = await import(${url(COORD_MJS)}), PI = await import(${url(path.join(SKILL, "pause-io.mjs"))}), Q = await import(${url(path.join(SKILL, "pause-lib.mjs"))});
        const now = ${NOW}, end = now + 25 * 60 * 60000;
        process.stdout.write(JSON.stringify({ paths: [C.OFFTIMES, PI.OFFTIMES_FILE], lead: [C.OFF_LEAD_MS, Q.SHABBAT_LEAD_MIN * 60000], near: [now - 61 * 60000, now - 60 * 60000, now, end - 1, end].map(C.offNear) }));
      `, env);
      assert.deepEqual(r.paths, [sb.offtimes, sb.offtimes]);
      assert.deepEqual(r.lead, [60 * MIN, 60 * MIN]);
      assert.deepEqual(r.near, [false, true, true, true, false]);
    }
    const defaults = child(sb, `
      const C = await import(${url(COORD_MJS)}), PI = await import(${url(path.join(SKILL, "pause-io.mjs"))});
      process.stdout.write(JSON.stringify([C.OFFTIMES, PI.OFFTIMES_FILE]));
    `, { HL_OFFTIMES_FILE: "" });
    assert.deepEqual(defaults, [path.join(SKILL, "offtimes.json"), path.join(SKILL, "offtimes.json")]);
  } finally { sb.cleanup(); }
});

test("the table pre-filter leaves missing, invalid and expired tables to readSources", () => {
  const sb = sandbox();
  try {
    const valid = table(NOW), o = valid.intervals[0];
    for (const [t, near] of [[null, false], ["unreadable JSON", false], [{ ...valid, tz: "wrong" }, true],
      [{ ...valid, until: NOW }, true], [{ ...valid, intervals: [o, o] }, true],
      [{ ...valid, intervals: [{ start: NOW + MIN, end: NOW + 2 * MIN }, o] }, true],
      [{ ...valid, intervals: [{ start: NOW, end: NOW }] }, false]]) {
      if (t === null) fs.rmSync(sb.offtimes);
      else if (typeof t === "string") fs.writeFileSync(sb.offtimes, t);
      else put(sb.offtimes, t);
      const r = child(sb, `
        const C = await import(${url(COORD_MJS)}), PI = await import(${url(path.join(SKILL, "pause-io.mjs"))});
        process.stdout.write(JSON.stringify({ near: C.offNear(${NOW}), sources: PI.readSources(${NOW}), off: PI.readOffTimes(${NOW}) }));
      `);
      assert.deepEqual(r, { near, sources: [], off: [] });
    }
  } finally { sb.cleanup(); }
});

test("a lane's Stop in the lead hour: the Shabbat text, then a {paused} line with source shabbat and end", () => {
  const sb = sandbox();
  try {
    const now = Date.now(), t = table(now + 30 * MIN);
    sessionLine(sb, { name: "H", id: "H@1", priority: "high", sid: "lane-1", group: "g1", supersedes: null, launched_at: new Date(now - MIN).toISOString() });
    put(sb.offtimes, t);
    const stop = (active) => coordRun(sb, ["stop"], { input: { session_id: "lane-1", hook_event_name: "Stop", stop_hook_active: active }, env: { HL_SESSION_ID: "H@1" } });
    const r = stop(false);
    assert.equal(r.code, 0, r.err);
    const prompt = JSON.parse(r.out);
    assert.equal(prompt.decision, "block");
    assert.match(prompt.reason, /^Shabbat\/Yom Tov in (29|30) min: finish the current step, save state, end your turn\.$/);
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    const continuation = stop(true);
    assert.equal(continuation.code, 0, continuation.err);
    assert.equal(continuation.out, "");
    const lines = sb.registry().filter((o) => o.paused);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].paused, lines[0].name, lines[0].group, lines[0].reason, lines[0].source, lines[0].windows, lines[0].end], ["H@1", "H", "g1", "Shabbat/Yom Tov (shabbat)", "shabbat", [], t.intervals[0].end]);
    assert.ok(Date.parse(lines[0].at) >= now);
    assert.equal(stop(true).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 1);
  } finally { sb.cleanup(); }
});
