// Batch B, Part 4 in the tick: the pause close (pauseScan) - bg lanes by bg_id, the still-open lane once the pause lifts,
// busy lanes, the skip count and its one alert. Background lanes need no window host, so these run on every OS.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, coordRun, sessionLine, appendLine, writeTranscript, setAgents, tx } from "./helpers.mjs";

const MIN = 60000, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const LIVE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "live.mjs")).href;
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const manual = (sb) => { fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true }); fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "test", at: ago(5) })); };
// A bg lane whose turn ended `idleMin` ago (transcript) and that claude agents lists as idle; {paused} line `pausedMin` ago.
function bgLane(sb, name, { pausedMin = 3, idleMin = 4, bgId = `bg-${name}`, busy = false, effort = "high" } = {}) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, mode: "bg", bg_id: bgId, effort, supersedes: null });
  const t = tx({ start: Date.now() - (idleMin + 1) * MIN, step: 1000 }).user("go");
  writeTranscript(sb, sb.repo, e.session_id, (busy ? t.call("mcp__x__slow", {}, { result: false }) : t.say("state saved").turnDone()).entries());
  if (pausedMin != null) appendLine(sb, { paused: e.id, name, group: null, at: ago(pausedMin), reason: "manual pause", source: "manual", windows: [] });
  return e;
}
const list = (sb, names) => setAgents(sb, names.map((n) => ({ id: `bg-${n}`, sessionId: `${n}-s1`, name: n, status: "idle" })));

test("pause close: an idle paused bg lane is stopped by its bg_id while its pause applies; a {paused} line under 1 min old waits; a busy lane is left for the next tick", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const a = bgLane(sb, "A"), y = bgLane(sb, "Y", { pausedMin: 0 }), b = bgLane(sb, "B", { busy: true });
    list(sb, ["A", "Y", "B"]);
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would close A \(gen 1\): paused \(manual pause\)$/m);
    assert.equal(sb.registry().filter((o) => o.kill_intent).length, 0);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m);
    assert.doesNotMatch(r.out, /close[ds]? [YB] |skip close of [YB] /);
    assert.ok(sb.registry().some((o) => o.kill_intent === a.id && o.kind === "close"));
    // carry: the pause close's {closed} line says it is a pause close
    assert.equal(sb.registry().find((o) => o.closed && o.id === a.id)?.pause, true);
    for (const e of [y, b]) assert.equal(sb.registry().filter((o) => o.kill_intent === e.id).length, 0, e.id);
  } finally { sb.cleanup(); }
});

test("pause close once the pause lifted: a lane idle since its {paused} line is closed to be relaunched; one the user typed into is left alone", () => {
  const sb = sandbox();
  try {
    const s = bgLane(sb, "S", { pausedMin: 5, idleMin: 6 }); // idle since before its {paused} line
    const u = bgLane(sb, "U", { pausedMin: 5, idleMin: 1 }); // worked a minute ago, after its {paused} line
    list(sb, ["S", "U"]);
    const r = tick(sb); // no source is active
    assert.match(r.out, /^closed S \(gen 1\): paused, and its pause lifted: closed to relaunch$/m);
    assert.doesNotMatch(r.out, /close[ds]? U /);
    assert.equal(sb.registry().find((o) => o.closed && o.id === s.id)?.pause, true);
    assert.equal(sb.registry().filter((o) => o.kill_intent === u.id).length, 0);
  } finally { sb.cleanup(); }
});

test("pause close in both recovery modes: a pre-stage-2 (report-only) paused lane is closed too", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const e = sessionLine(sb, { name: "R", id: "R@1", branch: "r", sid: "R-s1", mode: "bg", bg_id: "bg-R", coord: undefined, model: undefined, effort: undefined });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    appendLine(sb, { paused: "R", at: ago(3) }); // written by hand, by name: still read
    list(sb, ["R"]);
    assert.match(tick(sb).out, /^closed R \(gen 1\): paused \(manual pause\)$/m);
  } finally { sb.cleanup(); }
});

test("pause close skips: a bg lane without a bg_id, or liveness unknown, is skipped and alerted once at the second tick", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const n = bgLane(sb, "N", { bgId: null });
    list(sb, ["N"]);
    let r = tick(sb);
    assert.match(r.out, /^skip close of N \(gen 1\): a background lane without a recorded bg_id cannot be stopped$/m);
    assert.doesNotMatch(r.out, /not closed for/);
    r = tick(sb);
    assert.match(r.out, /^paused lane N not closed for 2 ticks - alert .*\.json$/m);
    const alerts = fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => /-N\.json$/.test(f));
    assert.equal(alerts.length, 1);
    assert.match(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", alerts[0]), "utf8")).text, /^Paused lane N could not be closed for two ticks: a background lane without a recorded bg_id cannot be stopped\./);
    r = tick(sb);
    assert.doesNotMatch(r.out, /not closed for/); // alerted once
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "tick-state.json"), "utf8")).skips[n.id], 3);
    const k = bgLane(sb, "K");
    r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail" } }); // claude agents fails: liveness unknown
    assert.match(r.out, /^skip close of K \(gen 1\): liveness unknown \(.*\)$/m);
    assert.equal(sb.registry().filter((o) => o.kill_intent === k.id).length, 0);
  } finally { sb.cleanup(); }
});

test("pause close under pace hold: a normal lane is closed, a high lane's old {paused} line is not acted on while hold does not cover it", () => {
  const sb = sandbox();
  try {
    // a fresh reading 22.5 ahead of the 5-hour pace (the tick recomputes pace.json from usage/ first): hold
    fs.mkdirSync(path.join(sb.coord, "usage"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "usage", "s-1.json"), JSON.stringify({ ts: Date.now() - MIN, provider: "claude", pct: 70, resets_at: Math.round((Date.now() + 150 * MIN) / 1000), week_pct: 20, week_resets_at: Math.round((Date.now() + 5040 * MIN) / 1000) }));
    bgLane(sb, "N");
    bgLane(sb, "H", { effort: "xhigh", idleMin: 1 }); // high, worked after its old {paused} line
    list(sb, ["N", "H"]);
    const r = tick(sb);
    assert.match(r.out, /^closed N \(gen 1\): paused \(pace hold \(5h \+23 \/ week -34\)\)$/m);
    assert.doesNotMatch(r.out, /close[ds]? H /);
  } finally { sb.cleanup(); }
});

test("carry: a state file that cannot be written (tick-state.json is a directory) costs one error line; the tick goes on and exits 0", () => {
  const sb = sandbox();
  try {
    manual(sb);
    bgLane(sb, "N", { bgId: null }); // a skip changes the tick state, so the tick writes it
    bgLane(sb, "A");
    list(sb, ["N", "A"]);
    fs.mkdirSync(path.join(sb.coord, "pause", "tick-state.json"), { recursive: true });
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^error: pause\/tick-state\.json not written \(.+\)$/m);
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m); // the scan's lines are kept
    assert.doesNotMatch(r.out, /tick failed/);
    assert.ok(fs.existsSync(path.join(sb.coord, "last-tick.txt")));
  } finally { sb.cleanup(); }
});

test("carry: killTree's extra fields reach its already-gone {closed} line; other callers' lines are unchanged", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "G", id: "G@1", branch: "g", sid: "G-s1", mode: "bg", bg_id: null, no_spawn: true });
    const code = `import * as V from ${JSON.stringify(LIVE)}; const e = V.readRegistry().entries[0]; console.log(JSON.stringify([V.killTree(e, "t1", "close", { pause: true })]));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: sb.env, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already gone/);
    const closed = sb.registry().filter((o) => o.closed && o.id === e.id);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].pause, true);
    assert.match(closed[0].why, /^t1 \(already gone: /);
    // a caller that passes no extra fields writes none
    const sb2 = sandbox();
    try {
      const e2 = sessionLine(sb2, { name: "G", id: "G@1", branch: "g", sid: "G-s1", mode: "bg", bg_id: null, no_spawn: true });
      const r2 = spawnSync(process.execPath, ["--input-type=module", "-e", code.replace(', { pause: true }', "")], { env: sb2.env, encoding: "utf8", timeout: 60000 });
      assert.equal(r2.status, 0, r2.stderr);
      assert.equal("pause" in sb2.registry().find((o) => o.closed && o.id === e2.id), false);
    } finally { sb2.cleanup(); }
  } finally { sb.cleanup(); }
});

const RECOVER = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "recover.mjs")).href;
// recover.mjs's pausedFor(reg, e) for the registry's first entry, in a child with the sandbox env.
const pausedForFirst = (sb) => {
  const code = `import * as R from ${JSON.stringify(RECOVER)}; import * as V from ${JSON.stringify(LIVE)}; const reg = V.readRegistry(); console.log(JSON.stringify([R.pausedFor(reg, reg.entries[0]), R.pauseActive()]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: sb.env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};

test("loop exemption and restart deferral read the pause for THIS lane: a pace hold spares a high lane, a manual pause does not", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "H", id: "H@1", branch: "h", sid: "H-s1", priority: "high" });
    assert.deepEqual(pausedForFirst(sb), [false, false]);
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated: Date.now(), claude: { state: "hold", ahead: 22, week_ahead: 1, since: Date.now(), windows: { five_hour: { state: "hold" }, weekly: { state: "ok" } } } }));
    assert.deepEqual(pausedForFirst(sb), [false, true]); // a source is active, but its normal-low scope spares the high lane
    manual(sb);
    assert.deepEqual(pausedForFirst(sb), [true, true]);
  } finally { sb.cleanup(); }
});

test("pause close of a bg lane: a turn without a turn_duration record (background agents unknown) is not closed and is counted and alerted at the second tick", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const e = sessionLine(sb, { name: "U", id: "U@1", branch: "u", sid: "U-s1", mode: "bg", bg_id: "bg-U", supersedes: null });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 6 * MIN }).user("go").say("saved").entries()); // no turnDone
    appendLine(sb, { paused: e.id, name: "U", group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
    list(sb, ["U"]);
    let r = tick(sb);
    assert.doesNotMatch(r.out, /closed U /);
    assert.equal(sb.registry().filter((o) => o.kill_intent === e.id).length, 0);
    r = tick(sb);
    assert.match(r.out, /^paused lane U not closed for 2 ticks - alert .*\.json$/m);
    assert.equal(sb.registry().filter((o) => o.kill_intent === e.id).length, 0);
  } finally { sb.cleanup(); }
});

test("pause close: a lane not due is not counted or alerted for an unknown liveness", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const y = bgLane(sb, "Y", { pausedMin: 0 }); // its {paused} line is under 1 min old: not due
    list(sb, ["Y"]);
    const r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail" } });
    assert.doesNotMatch(r.out, /skip close of Y /);
    const f = path.join(sb.coord, "pause", "tick-state.json");
    assert.equal(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).skips[y.id] : undefined, undefined);
  } finally { sb.cleanup(); }
});
