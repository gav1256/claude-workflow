// S4: the tick marks every open lane at sunset; idle lanes close at once, busy lanes after the grace.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, writeTranscript, setAgents, tx, host, alive, waitFor } from "./helpers.mjs";
import * as Q from "../pause-lib.mjs";

const MIN = 60000, NOW = Date.UTC(2026, 9, 7, 15), iso = (t) => new Date(t).toISOString();
const RECOVER = new URL("../recover.mjs", import.meta.url).href;
const table = (sb, start) => fs.writeFileSync(sb.offtimes, JSON.stringify({ tz: "Asia/Jerusalem", until: NOW + 100 * 864e5,
  intervals: [{ start, end: NOW + 25 * 60 * MIN, kind: "shabbat" }] }));
// Inject the child's clock too; step exercises time advancing between the scan and its new lines.
function tick(sb, { dryRun = false, env = {}, step = 0 } = {}) {
  const code = `const RealDate = Date; let clock = ${NOW}; const time = () => { const t = clock; clock += ${step}; return t; };
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [time()])); } static now() { return time(); }
  }; const R = await import(${JSON.stringify(RECOVER)}); console.log(R.tick({ dryRun: ${dryRun} }).join("\\n"));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...sb.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  assert.doesNotMatch(r.stdout, /tick failed|^error /m);
  return r.stdout.replace(/\r/g, "");
}
function bgLane(sb, name, { busy = false, bgId = `bg-${name}` } = {}) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, mode: "bg", bg_id: bgId,
    supersedes: null, launched_at: iso(NOW - 2 * 60 * MIN) });
  const t = tx({ start: NOW - 5 * MIN, step: 1000 }).user("go");
  writeTranscript(sb, sb.repo, e.session_id, (busy ? t.call("mcp__x__slow", {}, { result: false }) : t.say("state saved").turnDone()).entries());
  return e;
}
const list = (sb, names) => setAgents(sb, names.map((n) => ({ id: `bg-${n}`, sessionId: `${n}-s1`, name: n, status: "idle" })));
const linesOf = (sb, e) => sb.registry().filter((o) => o.paused === e.id);
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "tick-state.json"), "utf8"));
const alerts = (sb, name) => fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => f.endsWith(`-${name}.json`));

function sunsetAndGrace(sb) {
  table(sb, NOW - 3 * MIN);
  const i = bgLane(sb, "I"), b = bgLane(sb, "B", { busy: true });
  list(sb, ["I", "B"]);
  const first = tick(sb);
  for (const e of [i, b]) {
    assert.match(first, new RegExp(`^Shabbat/Yom Tov: \\{paused\\} written for ${e.name} \\(gen 1\\)$`, "m"));
    assert.deepEqual(linesOf(sb, e), [Q.shabbatLine(e, Q.shabbatSource([{ start: NOW - 3 * MIN, end: NOW + 25 * 60 * MIN }], NOW), iso(NOW))]);
  }
  assert.equal(sb.registry().find((o) => o.closed && o.id === i.id)?.pause, true);
  assert.equal(sb.registry().some((o) => o.kill_intent === b.id), false);
  tick(sb); // The newest Shabbat line is already from this interval: never re-mark a busy lane.
  assert.equal(linesOf(sb, b).length, 1);
  table(sb, NOW - 11 * MIN);
  const second = tick(sb);
  assert.match(second, /^closed B \(gen 1\): Shabbat\/Yom Tov began 11 min ago: closed by force after the 10-min grace$/m);
  assert.equal(linesOf(sb, b).at(-1).forced, true);
  assert.equal(linesOf(sb, b).at(-1).by, "tick");
  assert.ok(sb.registry().some((o) => o.kill_intent === b.id && o.kind === "close"));
  assert.equal(sb.registry().find((o) => o.closed && o.id === b.id)?.pause, true);
  return [i, b];
}

test("sunset closes idle lanes at once and a busy one after the grace", () => {
  const sb = sandbox();
  try { sunsetAndGrace(sb); } finally { sb.cleanup(); }
});

test("the manifest rows carry source shabbat", () => {
  const sb = sandbox();
  try {
    sunsetAndGrace(sb);
    const m = JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8"));
    assert.deepEqual(m.sessions.map((r) => [r.name, r.source]), [["I", "shabbat"], ["B", "shabbat"]]);
  } finally { sb.cleanup(); }
});

test("a tick-written line closes an idle lane even when the clock advances while marking", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 3 * MIN);
    const e = bgLane(sb, "I"); list(sb, ["I"]);
    assert.match(tick(sb, { step: 1 }), /^closed I \(gen 1\): paused \(Shabbat\/Yom Tov \(shabbat\)\)$/m);
    assert.equal(sb.registry().find((o) => o.closed && o.id === e.id)?.pause, true);
  } finally { sb.cleanup(); }
});

test("the lead hour writes no line and closes nothing", () => {
  const sb = sandbox();
  try {
    table(sb, NOW + 30 * MIN);
    bgLane(sb, "I"); list(sb, ["I"]);
    tick(sb);
    assert.equal(sb.registry().some((o) => o.paused || o.kill_intent || o.closed), false);
  } finally { sb.cleanup(); }
});

test("a bg lane without a bg_id is counted and alerted, never killed", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 11 * MIN);
    const e = bgLane(sb, "N", { bgId: null }); list(sb, ["N"]);
    assert.match(tick(sb), /^skip close of N \(gen 1\): a background lane without a recorded bg_id cannot be stopped$/m);
    assert.equal(state(sb).skips[e.id], 1);
    assert.match(tick(sb), /^paused lane N not closed for 2 ticks - alert .*\.json$/m);
    tick(sb);
    assert.equal(alerts(sb, "N").length, 1);
    assert.equal(state(sb).skips[e.id], 3);
    assert.equal(sb.registry().some((o) => o.kill_intent === e.id || o.closed), false);
    assert.equal(linesOf(sb, e).length, 1);
  } finally { sb.cleanup(); }
});

test("a dry run at sunset writes nothing", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 3 * MIN);
    bgLane(sb, "I"); list(sb, ["I"]);
    const before = sb.registry();
    assert.match(tick(sb, { dryRun: true }), /^would write the Shabbat \{paused\} line of I \(gen 1\)$/m);
    assert.deepEqual(sb.registry(), before);
    assert.equal(fs.existsSync(sb.coord), false);
  } finally { sb.cleanup(); }
});

test("Shabbat lines are due once per interval and force starts exactly at the grace", () => {
  const sh = Q.shabbatSource([{ start: NOW, end: NOW + 60 * MIN }], NOW), e = { id: "I@1", name: "I" };
  const line = Q.shabbatLine(e, sh, iso(NOW));
  assert.deepEqual(line, { paused: "I@1", name: "I", group: null, at: iso(NOW), reason: sh.reason, source: "shabbat", windows: [], end: sh.end, by: "tick" });
  assert.equal(Q.shabbatLineDue(null, sh), true);
  assert.equal(Q.shabbatLineDue({ ...line, source: "manual" }, sh), true);
  assert.equal(Q.shabbatLineDue({ ...line, at: iso(Date.parse(sh.since) - 1) }, sh), true);
  assert.equal(Q.shabbatLineDue({ ...line, at: sh.since }, sh), false);
  assert.equal(Q.shabbatLineDue(line, sh), false);
  assert.equal(Q.shabbatForceDue(sh, NOW + 10 * MIN - 1), false);
  assert.equal(Q.shabbatForceDue(sh, NOW + 10 * MIN), true);
  assert.equal(Q.shabbatForceDue(null, NOW), false);
  assert.equal(Q.shabbatForceDue({ ...sh, source: "manual" }, NOW + 11 * MIN), false);
  assert.equal(Q.shabbatLine(e, sh, iso(NOW), { forced: true }).forced, true);
  assert.equal(Q.laneRow(e, { priority: "high", reason: sh.reason }).source, null);
});

test("sunset marks unknown lanes but leaves closed and gone lanes alone", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 3 * MIN);
    const u = bgLane(sb, "U"), c = bgLane(sb, "C"), g = sessionLine(sb, { name: "G", sid: "G-s1", launched_at: iso(NOW - 2 * 60 * MIN), supersedes: null });
    appendLine(sb, { closed: c.name, id: c.id, at: iso(NOW - MIN) });
    list(sb, ["U", "C"]);
    tick(sb, { env: { HL_FAKE_PROBE: "fail" } });
    assert.equal(linesOf(sb, u).length, 1);
    assert.equal(linesOf(sb, c).length, 0);
    assert.equal(linesOf(sb, g).length, 0);
    assert.equal(sb.registry().some((o) => o.kill_intent), false);
  } finally { sb.cleanup(); }
});

test("past the grace unknown liveness and a pending ladder are counted and alerted", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 11 * MIN);
    const u = bgLane(sb, "U", { busy: true }); list(sb, ["U"]);
    for (let n = 1; n <= 2; n++) {
      assert.match(tick(sb, { env: { HL_FAKE_PROBE: "fail" } }), /^skip close of U \(gen 1\): liveness unknown/m);
      assert.equal(state(sb).skips[u.id], n);
    }
    assert.equal(alerts(sb, "U").length, 1);
    const p = bgLane(sb, "P", { busy: true }); list(sb, ["U", "P"]);
    appendLine(sb, { incident: p.id, path: "test-incident.json", signature: "test", mode: "auto", at: iso(NOW - MIN) });
    appendLine(sb, { recovery_mode: p.name, mode: "report", at: iso(NOW) }); // The ladder stays pending instead of being cancelled before pauseScan.
    table(sb, NOW - 3 * MIN);
    assert.match(tick(sb), /^skip close of P \(gen 1\): its loop ladder is pending - the ladder ends first$/m);
    assert.equal(state(sb).skips[p.id], undefined);
    table(sb, NOW - 11 * MIN);
    for (let n = 1; n <= 2; n++) {
      assert.match(tick(sb), /^skip close of P \(gen 1\): its loop ladder is pending - the ladder ends first$/m);
      assert.equal(state(sb).skips[p.id], n);
    }
    assert.equal(alerts(sb, "P").length, 1);
    assert.equal(sb.registry().some((o) => o.kill_intent === p.id), false);
  } finally { sb.cleanup(); }
});

test("a failed force kill is counted and alerted and refreshes the paused line first", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 11 * MIN);
    const e = bgLane(sb, "K", { busy: true }); list(sb, ["K"]);
    for (let n = 1; n <= 2; n++) {
      const out = tick(sb, { env: { HL_FAKE_CLAUDE: "0", HL_FAKE_PROBE: "fail:claude" } });
      assert.match(out, /^not closed K \(gen 1\): Shabbat\/Yom Tov began 11 min ago: closed by force.*kill failed/m);
      assert.equal(state(sb).skips[e.id], n);
      const reg = sb.registry(), intent = reg.findLastIndex((o) => o.kill_intent === e.id);
      assert.equal(reg[intent - 1].forced, true);
      assert.equal(reg[intent - 1].paused, e.id);
    }
    assert.equal(alerts(sb, "K").length, 1);
    assert.equal(sb.registry().some((o) => o.closed), false);
  } finally { sb.cleanup(); }
});

test("a lane first seen past the grace is forced even when idle; dry run writes nothing", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 11 * MIN);
    const e = bgLane(sb, "I"), fresh = bgLane(sb, "F"); list(sb, ["I", "F"]);
    appendLine(sb, { paused: e.id, name: e.name, source: "shabbat", at: iso(NOW - 10 * MIN), reason: "Shabbat/Yom Tov (shabbat)" });
    const before = sb.registry();
    assert.match(tick(sb, { dryRun: true }), /^would force-close I \(gen 1\): Shabbat\/Yom Tov began 11 min ago: closed by force after the 10-min grace$/m);
    assert.deepEqual(sb.registry(), before);
    const out = tick(sb);
    for (const lane of [e, fresh]) {
      assert.match(out, new RegExp(`^closed ${lane.name} \\(gen 1\\): Shabbat/Yom Tov began 11 min ago: closed by force`, "m"));
      assert.equal(sb.registry().find((o) => o.closed && o.id === lane.id)?.pause, true);
    }
    assert.equal(linesOf(sb, fresh).at(-1).forced, true);
    assert.equal(linesOf(sb, e).at(-1).forced, true);
    const reg = sb.registry(), forced = reg.findIndex((o) => o.paused === e.id && o.forced);
    assert.ok(forced < reg.findIndex((o) => o.kill_intent === e.id));
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8")).sessions[0].source, "shabbat");
  } finally { sb.cleanup(); }
});

test("a window lane busy past the grace is force-closed (Windows only)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox(), h = host();
  try {
    table(sb, NOW - 11 * MIN);
    const e = sessionLine(sb, { name: "W", id: "W@1", branch: "w", sid: "W-s1", host: h, supersedes: null, launched_at: iso(NOW - 2 * 60 * MIN) });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: NOW - 5 * MIN, step: 1000 }).user("go").call("mcp__x__slow", {}, { result: false }).entries());
    assert.match(tick(sb), /^closed W \(gen 1\): Shabbat\/Yom Tov began 11 min ago: closed by force/m);
    assert.ok(sb.registry().some((o) => o.kill_intent === e.id && o.kind === "close"));
    assert.equal(sb.registry().find((o) => o.closed && o.id === e.id)?.pause, true);
    assert.equal(linesOf(sb, e).at(-1).forced, true);
    waitFor(() => !alive(h.pid), 10000, () => "the window host is still running");
  } finally { h.kill(); sb.cleanup(); }
});

test("a busy window lane before the grace is kept (Windows only)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox(), h = host();
  try {
    table(sb, NOW - 5 * MIN);
    const e = sessionLine(sb, { name: "W", id: "W@1", branch: "w", sid: "W-s1", host: h,
      supersedes: null, launched_at: iso(NOW - 2 * 60 * MIN) });
    writeTranscript(sb, sb.repo, e.session_id,
      tx({ start: NOW - 5 * MIN, step: 1000 }).user("go").call("mcp__x__slow", {}, { result: false }).entries());
    assert.doesNotMatch(tick(sb), /closed W|closed by force/);
    assert.ok(alive(h.pid));
    assert.equal(sb.registry().some((o) => o.closed && o.id === e.id || o.kill_intent === e.id), false);
    assert.equal(linesOf(sb, e).length, 1);
    assert.equal(linesOf(sb, e)[0].forced, undefined);
  } finally { h.kill(); sb.cleanup(); }
});
