// Batch B, Part 4 in the tick: resuming (order, cap, min_pause_min, probe resume, cap refusal, failures) and the manifest.
// A fake launcher (HL_LAUNCH_MJS) stands in for the fresh launch the tick spawns (freshLaunchArgs: --supersedes <the
// closed entry>, --resume-note <reason>): it logs them and appends the lane's next launch line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun, sessionLine, appendLine, writeTranscript, setAgents, tx, emptyHost } from "./helpers.mjs";

const MIN = 60000, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const FAKE = `const fs = require("fs"), path = require("path");
const a = process.argv.slice(2), id = a[a.indexOf("--supersedes") + 1], note = a.includes("--resume-note") ? a[a.indexOf("--resume-note") + 1] : "-";
fs.appendFileSync(path.join(process.env.HL_SANDBOX_TMP, "launches.txt"), id + "|" + note + "|" + a.includes("--recovery") + "\\n");
const mode = process.env.HL_FAKE_RESUME || "ok";
if (mode === "cap") { console.error("refused - session cap: 6 sessions running, max_sessions 6 (config x)"); process.exit(3); }
if (mode === "fail") { console.error("boom"); process.exit(1); }
const reg = path.join(process.env.HL_REGISTRY_DIR, "sessions.jsonl");
const e = fs.readFileSync(reg, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.id === id && o.launched_at);
if (mode === "startfail") { fs.appendFileSync(reg, JSON.stringify({ starting: null, name: e.name, at: new Date().toISOString() }) + "\\n"); console.error("spawn boom"); process.exit(1); } // a window spawn that failed after the launcher wrote {starting}
fs.appendFileSync(reg, JSON.stringify({ ...e, id: e.name + "@r" + Date.now(), generation: (e.generation || 1) + 1, launched_at: new Date().toISOString(), supersedes: e.id, no_spawn: true }) + "\\n");
`;
function fake(sb) { const f = path.join(sb.tmp, "fake-launch.cjs"); fs.writeFileSync(f, FAKE); return f; }
const tick = (sb, env = {}, ...a) => coordRun(sb, ["tick", ...a], { env: { HL_LAUNCH_MJS: fake(sb), HL_SANDBOX_TMP: sb.tmp, ...env } });
const launchLog = (sb) => { try { return fs.readFileSync(path.join(sb.tmp, "launches.txt"), "utf8").trim().split("\n").map((l) => l.split("|")); } catch { return []; } };
const launched = (sb) => launchLog(sb).map(([id]) => id);
// A window lane a pause closed `closedMin` ago.
function closedLane(sb, name, { effort = "high", source = "manual", reason = "manual pause", closedMin = 20, windows = [] } = {}) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, effort, supersedes: null });
  appendLine(sb, { paused: e.id, name, group: null, at: ago(closedMin + 1), reason, source, windows });
  appendLine(sb, { closed: name, id: e.id, at: ago(closedMin), why: "paused", pause: true });
  return e;
}
// The newest Claude reading (the tick recomputes pace.json from usage/ first): a 5-hour window under pace, read minAgo ago.
const setUsage = (sb, minAgo) => { fs.mkdirSync(path.join(sb.coord, "usage"), { recursive: true }); fs.writeFileSync(path.join(sb.coord, "usage", "s-1.json"), JSON.stringify({ ts: Date.now() - minAgo * MIN, provider: "claude", pct: 20, resets_at: Math.round((Date.now() + 150 * MIN) / 1000), week_pct: 20, week_resets_at: Math.round((Date.now() + 5040 * MIN) / 1000) })); };
// A transcript last written before the lane's {paused} line (3 min ago), so the lane did not work after it.
const quietTranscript = (sb, e, entries) => { const f = writeTranscript(sb, sb.repo, e.session_id, entries); const t = new Date(Date.now() - 6 * MIN); fs.utimesSync(f, t, t); return f; };
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "tick-state.json"), "utf8"));

test("resume: high first, then the oldest pause, max_resumes_per_tick per tick; a still-active source keeps them; a dry run relaunches nothing", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "L", { effort: "medium", closedMin: 50 }); closedLane(sb, "N1", { closedMin: 40 }); closedLane(sb, "N2", { closedMin: 30 }); closedLane(sb, "H", { effort: "xhigh", closedMin: 10 });
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "t", at: ago(60) }));
    let r = tick(sb);
    assert.doesNotMatch(r.out, /relaunch/); assert.deepEqual(launched(sb), []);
    fs.rmSync(path.join(sb.coord, "pause", "manual.json"));
    r = tick(sb, {}, "--dry-run");
    assert.deepEqual(r.out.split("\n").filter((l) => l.startsWith("would relaunch")), ["would relaunch H after its pause (manual pause)", "would relaunch N1 after its pause (manual pause)", "would relaunch N2 after its pause (manual pause)"]);
    assert.deepEqual(launched(sb), []);
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(launched(sb), ["H@1", "N1@1", "N2@1"]);
    assert.deepEqual(launchLog(sb)[0], ["H@1", "manual pause", "false"]); // fresh, the pause's reason as its first line, no incident
    assert.match(r.out, /^relaunched H after its pause \(manual pause\)$/m);
    tick(sb);
    assert.deepEqual(launched(sb), ["H@1", "N1@1", "N2@1", "L@1"]);
    tick(sb);
    assert.equal(launched(sb).length, 4); // all back: nothing pending
  } finally { sb.cleanup(); }
});

test("resume: a lane closed for pace waits min_pause_min; then a fresh 5-hour reading resumes it in full", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "P", { source: "pace", reason: "pace hold (x)", closedMin: 5, windows: ["five_hour"] });
    setUsage(sb, 1); // fresh
    tick(sb);
    assert.deepEqual(launched(sb), []);
    const reg = path.join(sb.reg, "sessions.jsonl"); // the close is 20 min old now
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(/"closed":"P","id":"P@1","at":"[^"]+"/, `"closed":"P","id":"P@1","at":"${ago(20)}"`));
    let r = tick(sb);
    assert.match(r.out, /^relaunched P after its pause \(pace hold \(x\)\)$/m);
    const key = Object.keys(state(sb).repause)[0];
    assert.equal(state(sb).repause[key].n, 1);
    // The pace pauses its relaunch again within 6 h of it: the second minimum pause is 2 x 15 min.
    const f = path.join(sb.coord, "pause", "tick-state.json");
    fs.writeFileSync(f, JSON.stringify({ ...state(sb), repause: { [key]: { n: 1, at: Date.now() - 60 * MIN } } }));
    const p2 = sb.registry().filter((o) => o.launched_at && o.name === "P").at(-1);
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(`"launched_at":"${p2.launched_at}"`, `"launched_at":"${ago(30)}"`)); // it ran 30 min ago
    appendLine(sb, { paused: p2.id, name: "P", group: null, at: ago(26), reason: "pace hold (y)", source: "pace", windows: ["five_hour"] });
    appendLine(sb, { closed: "P", id: p2.id, at: ago(25), why: "paused", pause: true });
    r = tick(sb);
    assert.doesNotMatch(r.out, /relaunched P/); // 25 min < 30
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(new RegExp(`"closed":"P","id":"${p2.id}","at":"[^"]+"`), `"closed":"P","id":"${p2.id}","at":"${ago(31)}"`));
    r = tick(sb);
    assert.match(r.out, /^relaunched P after its pause \(pace hold \(y\)\)$/m);
    assert.equal(state(sb).repause[key].n, 2);
  } finally { sb.cleanup(); }
});

test("probe resume: a pace pause that ended on a stale 5-hour reading relaunches one window lane, waits probe_wait_min, then the next", () => {
  const sb = sandbox();
  try {
    for (const n of ["A", "B", "C"]) closedLane(sb, n, { source: "pace", reason: "pace hold (x)", closedMin: 30 + n.charCodeAt(0), windows: ["five_hour"] });
    setUsage(sb, 20); // the newest 5-hour reading is stale
    let r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.match(r.out, /^relaunch of C after its pause failed/m);
    assert.equal(state(sb).probe ?? null, null); // a failed probe relaunch records no probe: the next tick tries again
    fs.rmSync(path.join(sb.tmp, "launches.txt"));
    r = tick(sb);
    assert.match(r.out, /^relaunched C after its pause \(pace hold \(x\)\) - a probe resume$/m); // the oldest pause first
    assert.deepEqual(launched(sb), ["C@1"]);
    assert.equal(state(sb).probe.id, "C@1");
    tick(sb);
    assert.deepEqual(launched(sb), ["C@1"]); // waiting for a fresh reading
    const f = path.join(sb.coord, "pause", "tick-state.json");
    fs.writeFileSync(f, JSON.stringify({ ...state(sb), probe: { id: "C@1", at: Date.now() - 11 * MIN } }));
    tick(sb);
    assert.deepEqual(launched(sb), ["C@1", "B@1"]); // none in 10 min: the next lane is probed
    setUsage(sb, 1);
    tick(sb);
    assert.deepEqual(launched(sb), ["C@1", "B@1", "A@1"]); // a fresh reading confirmed: the rest in full
    assert.equal(state(sb).probe, null);
  } finally { sb.cleanup(); }
});

test("a restricted tick (launch.mjs watchdog --repo) leaves the machine-wide pause state alone: no prune, no resume, the probe kept", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "A", { source: "pace", reason: "pace hold (x)", closedMin: 40, windows: ["five_hour"] });
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true });
    const ts = { skips: { "gone@1": 1 }, alerted: ["gone@1"], probe: { id: "X@1", at: Date.now() - 2 * MIN }, failed: { "gone@2": 1 }, repause: {} };
    fs.writeFileSync(path.join(sb.coord, "pause", "tick-state.json"), JSON.stringify(ts));
    const r = sb.run("watchdog", "--repo", sb.repo, "--stop-looping");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /relaunch/);
    assert.deepEqual(state(sb), ts); // untouched: an unrestricted tick owns it
    assert.equal(sb.registry().filter((o) => o.launched_at && o.name === "A").length, 1);
  } finally { sb.cleanup(); }
});

test("resume: a cap refusal defers the rest of the tick; a relaunch that fails twice is alerted once and left to the user", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "A", { closedMin: 30 }); closedLane(sb, "B", { closedMin: 20 });
    let r = tick(sb, { HL_FAKE_RESUME: "cap" });
    assert.match(r.out, /^relaunch of A after its pause deferred: session cap \(6 sessions running, max_sessions 6\) - the next tick retries$/m);
    assert.deepEqual(launched(sb), ["A@1"]); // B not tried this tick
    r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.match(r.out, /^relaunch of A after its pause failed: the launcher exited 1: boom \(log .*\) - the next tick retries$/m);
    r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.match(r.out, /^gave up relaunching A - alert .*\.json$/m);
    const before = launched(sb).length;
    r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.ok(!launched(sb).slice(before).includes("A@1")); // given up: only B is tried
  } finally { sb.cleanup(); }
});

test("the manifest: a pause close adds its lane, a paused hand-opened session its row; once resumed, one alert for the hand-opened ones and the archive", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", mode: "bg", bg_id: "bg-A", supersedes: null });
    quietTranscript(sb, e, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    setAgents(sb, [{ id: "bg-A", sessionId: "A-s1", name: "A", status: "idle" }]);
    appendLine(sb, { paused: e.id, name: "A", group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
    coordRun(sb, ["pause"]);
    const hand = "99999999-8888-7777-6666-555555555555";
    coordRun(sb, ["agent-gate"], { input: { session_id: hand, cwd: "/p", tool_name: "Agent", tool_input: {} } }); // the hook records it
    let r = tick(sb);
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m);
    const m = JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8"));
    assert.deepEqual(m.sessions.map((x) => [x.name, x.closed, x.session_id]), [["A", true, "A-s1"], [`hand-opened ${hand.slice(0, 8)}`, false, hand]]);
    assert.match(m.how_to_resume, /resume --paused/);
    coordRun(sb, ["resume"]);
    r = tick(sb);
    assert.match(r.out, /^relaunched A after its pause \(manual pause\)$/m);
    assert.match(r.out, /^the pause ended: 1 hand-opened session\(s\) to resume by hand - alert .*\.json$/m);
    assert.match(r.out, /^pause manifest archived: .*\/paused-\d{4}-\d\d-\d\d-\d{4}\.json$/m);
    assert.equal(fs.existsSync(path.join(sb.coord, "paused.json")), false);
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause", "seen")), []);
    const alert = fs.readdirSync(path.join(sb.coord, "alerts")).find((f) => /-paused\.json$/.test(f));
    assert.match(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", alert), "utf8")).text, new RegExp(`claude --resume ${hand} \\(in /p\\)`));
  } finally { sb.cleanup(); }
});

// ---- carried items (Task 13 brief M2-M6) ----
test("a lane that worked after its {paused} line is not relaunched by the tick (one activity rule with resume --paused)", () => {
  const sb = sandbox();
  try {
    const e = closedLane(sb, "W", { closedMin: 30 });
    closedLane(sb, "Z", { closedMin: 30 });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 5 * MIN }).user("back by hand").say("ok").turnDone().entries()); // written after the {paused} line + 1 min
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(launched(sb), ["Z@1"]);
    assert.doesNotMatch(r.out, /relaunched W /);
  } finally { sb.cleanup(); }
});

test("no fresh pace.json: a pace-caused pause resumes through the probe path", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "P", { source: "pace", reason: "pace hold (x)", closedMin: 30, windows: ["five_hour"] });
    closedLane(sb, "Q", { source: "pace", reason: "pace hold (x)", closedMin: 20, windows: ["five_hour"] });
    assert.equal(fs.existsSync(path.join(sb.coord, "pace.json")), false);
    const r = tick(sb);
    assert.match(r.out, /^relaunched P after its pause \(pace hold \(x\)\) - a probe resume$/m);
    assert.deepEqual(launched(sb), ["P@1"]); // one lane, not the full cap: unknown pace is not a reset
    assert.equal(state(sb).probe.id, "P@1");
  } finally { sb.cleanup(); }
});

test("a manifest that cannot be written is one error line; the tick goes on (its state and lines survive)", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", mode: "bg", bg_id: "bg-A", supersedes: null });
    quietTranscript(sb, e, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    setAgents(sb, [{ id: "bg-A", sessionId: "A-s1", name: "A", status: "idle" }]);
    appendLine(sb, { paused: e.id, name: "A", group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
    coordRun(sb, ["pause"]);
    fs.mkdirSync(path.join(sb.coord, "paused.json"), { recursive: true }); // a directory where the manifest goes
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m);
    assert.match(r.out, /^error: paused\.json not written \(\w+\)$/m);
    assert.ok(fs.existsSync(path.join(sb.coord, "last-tick.txt")));
  } finally { sb.cleanup(); }
});

test("a seen record of a lifted pause is not listed under a new pause; the archive clears seen/", () => {
  const sb = sandbox();
  try {
    const seenDir = path.join(sb.coord, "pause", "seen"), oldId = "11111111-2222-3333-4444-555555555555", newId = "99999999-8888-7777-6666-555555555555";
    fs.mkdirSync(seenDir, { recursive: true });
    fs.writeFileSync(path.join(seenDir, `${oldId}.json`), JSON.stringify({ session_id: oldId, cwd: "/old", reason: "manual pause", at: ago(180) })); // an earlier pause, lifted
    const e = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", mode: "bg", bg_id: "bg-A", supersedes: null });
    quietTranscript(sb, e, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    setAgents(sb, [{ id: "bg-A", sessionId: "A-s1", name: "A", status: "idle" }]);
    appendLine(sb, { paused: e.id, name: "A", group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
    coordRun(sb, ["pause"]); // the new pause starts now
    coordRun(sb, ["agent-gate"], { input: { session_id: newId, cwd: "/p", tool_name: "Agent", tool_input: {} } });
    tick(sb);
    const m = JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8"));
    assert.deepEqual(m.sessions.map((x) => x.session_id), ["A-s1", newId]); // not oldId
    assert.equal(fs.existsSync(path.join(seenDir, `${oldId}.json`)), false);
    coordRun(sb, ["resume"]);
    tick(sb);
    assert.equal(fs.existsSync(path.join(sb.coord, "paused.json")), false);
    assert.deepEqual(fs.readdirSync(seenDir), []);
  } finally { sb.cleanup(); }
});

test("a paused window the user exited is closed as a pause close (pause: true) and relaunched; one that worked after its {paused} line is not", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox(), hosts = [emptyHost(), emptyHost()];
  try {
    const old = Date.now() - 60 * MIN, idleTx = (start) => tx({ start }).user("go").call("Bash", { command: "x" }).say("handed off").turnDone().entries();
    const a = sessionLine(sb, { name: "E", id: "E@1", branch: "e", sid: "E-s1", host: hosts[0], supersedes: null });
    const b = sessionLine(sb, { name: "F", id: "F@1", branch: "f", sid: "F-s1", host: hosts[1], supersedes: null });
    for (const [x, mtime] of [[a, old], [b, Date.now() - 40 * MIN]]) { const f = writeTranscript(sb, sb.repo, x.session_id, idleTx(old)); fs.utimesSync(f, new Date(mtime), new Date(mtime)); }
    for (const x of [a, b]) appendLine(sb, { paused: x.id, name: x.name, group: null, at: ago(50), reason: "manual pause", source: "manual", windows: [] });
    // A restricted tick runs the gone scan alone (the pause close is an unrestricted tick's).
    const r = sb.run("watchdog", "--repo", sb.repo, "--stop-looping");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed E \(gen 1\): claude exited$/m);
    assert.match(r.out, /^closed F \(gen 1\): claude exited$/m);
    const closes = sb.registry().filter((o) => o.closed);
    assert.equal(closes.find((o) => o.id === "E@1").pause, true);
    assert.equal(closes.find((o) => o.id === "F@1").pause, undefined); // it worked after its line: an ordinary close
    const t = tick(sb); // the pause is lifted: only E is relaunched
    assert.deepEqual(launched(sb), ["E@1"]);
    assert.match(t.out, /^relaunched E after its pause \(manual pause\)$/m);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

// ---- fix round: F1, F2 ----
test("a window spawn that fails after its {starting} line keeps its failure count: the second failure gives up and alerts", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "A", { closedMin: 30 });
    let r = tick(sb, { HL_FAKE_RESUME: "startfail" });
    assert.match(r.out, /^relaunch of A after its pause failed: .* - the next tick retries$/m);
    assert.equal(state(sb).failed["A@1"], 1);
    tick(sb, { HL_FAKE_RESUME: "startfail" }); // the {starting} line is under 5 min old: the lane is left alone, its count kept
    assert.equal(launched(sb).length, 1);
    assert.equal(state(sb).failed["A@1"], 1);
    const reg = path.join(sb.reg, "sessions.jsonl"); // five minutes pass
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").split("\n").map((l) => (l.includes('"starting"') ? JSON.stringify({ ...JSON.parse(l), at: ago(10) }) : l)).join("\n"));
    r = tick(sb, { HL_FAKE_RESUME: "startfail" });
    assert.match(r.out, /^gave up relaunching A - alert .*\.json$/m);
    assert.equal(state(sb).failed["A@1"], 2);
  } finally { sb.cleanup(); }
});

function bgLane(sb, name, sid) {
  const e = sessionLine(sb, { name, id: name + "@1", branch: name.toLowerCase(), sid, mode: "bg", bg_id: "bg-" + name, supersedes: null });
  quietTranscript(sb, e, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
  appendLine(sb, { paused: e.id, name, group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
  return e;
}
test("a lane resumed by hand does not hold its pause's manifest: the next pause alerts its own hand-opened sessions", () => {
  const sb = sandbox();
  try {
    const hand1 = "11111111-2222-3333-4444-555555555555", hand2 = "99999999-8888-7777-6666-555555555555";
    const e = bgLane(sb, "A", "A-s1");
    setAgents(sb, [{ id: "bg-A", sessionId: "A-s1", name: "A", status: "idle" }]);
    coordRun(sb, ["pause"]);
    coordRun(sb, ["agent-gate"], { input: { session_id: hand1, cwd: "/p", tool_name: "Agent", tool_input: {} } });
    tick(sb);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8")).sessions.length, 2);
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("back by hand").say("ok").turnDone().entries()); // worked after its line
    coordRun(sb, ["resume"]);
    let r = tick(sb);
    assert.match(r.out, /^the pause ended: 1 hand-opened/m);
    assert.match(r.out, /^pause manifest archived: /m);
    assert.equal(fs.existsSync(path.join(sb.coord, "paused.json")), false);
    // pause 2
    coordRun(sb, ["pause"]);
    coordRun(sb, ["agent-gate"], { input: { session_id: hand2, cwd: "/q", tool_name: "Agent", tool_input: {} } });
    r = tick(sb);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8")).sessions.map((x) => x.session_id), [hand2]);
    coordRun(sb, ["resume"]);
    r = tick(sb);
    assert.match(r.out, /^the pause ended: 1 hand-opened session\(s\) to resume by hand - alert .*\.json$/m);
    const texts = fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => /-paused\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", f), "utf8")).text);
    assert.ok(texts.some((t) => t.includes(hand2)));
  } finally { sb.cleanup(); }
});

test("safety net: a new pause archives the manifest of an ended pause (hand_alerted set) before its own rows go in", () => {
  const sb = sandbox();
  try {
    const hand2 = "99999999-8888-7777-6666-555555555555";
    const old = closedLane(sb, "L", { closedMin: 300 }); // still pending: its row has no resumed_at
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "paused.json"), JSON.stringify({ paused_at: ago(400), how_to_resume: "x", hand_alerted: ago(200), sessions: [{ key: "lane:x", name: "L", repo: old.repo, group: null, generation: 1, closed: true }, { key: "hand:z", name: "hand-opened z", session_id: "z", closed: false }] }));
    coordRun(sb, ["pause"]);
    coordRun(sb, ["agent-gate"], { input: { session_id: hand2, cwd: "/q", tool_name: "Agent", tool_input: {} } });
    const r = tick(sb);
    assert.match(r.out, /^pause manifest archived: .*paused-\d{4}-\d\d-\d\d-\d{4}\.json$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8")).sessions.map((x) => x.session_id), [hand2]);
    assert.ok(fs.readdirSync(sb.coord).some((f) => /^paused-.*\.json$/.test(f)));
  } finally { sb.cleanup(); }
});
