import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, writeTranscript, writeSubagent, setAgents, coordRun, tx } from "./helpers.mjs";
import { callKey, shortHash } from "../recover-lib.mjs";

const MIN = 60000, SID = "aaaaaaaa-0000-0000-0000-000000000001";
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const agents = (sb) => JSON.parse(fs.readFileSync(path.join(sb.tmp, "agents.json"), "utf8"));
// A running background session (listed by claude agents) whose transcript repeats one call 5 times.
function loopingLane(sb, o = {}) {
  const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", ...o });
  setAgents(sb, [...agents(sb), { id: e.bg_id, sessionId: e.session_id, name: e.name, status: "running" }]);
  let t = tx({ start: Date.now() - 10 * MIN }).user("go");
  for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
  writeTranscript(sb, sb.repo, e.session_id, t.entries());
  return e;
}

test("report-only: a loop in a pre-stage-2 session gets one incident and one alert per signature, nothing stopped", () => {
  const sb = sandbox();
  try {
    loopingLane(sb, { coord: undefined });
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^report-only A: same call x5 .* - incident .*\/incidents\/A-1\.md, alerted$/m);
    const inc = sb.registry().filter((o) => o.incident);
    assert.equal(inc.length, 1); assert.equal(inc[0].mode, "report");
    assert.equal(sb.registry().filter((o) => o.stop_requested || o.kill_intent).length, 0);
    const alerts = () => fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => /^\d.*\.json$/.test(f));
    assert.equal(alerts().length, 1);
    assert.match(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", alerts()[0]), "utf8")).text, /Nothing was stopped\. Opt in: node .* recover --name A --mode auto$/);
    tick(sb);
    assert.equal(sb.registry().filter((o) => o.incident).length, 1); assert.equal(alerts().length, 1);
    const ix = path.join(sb.coord, "alerts", "index.json"), idx = JSON.parse(fs.readFileSync(ix, "utf8"));
    for (const k of Object.keys(idx)) idx[k] = new Date(Date.now() - 7 * 3600e3).toISOString();
    fs.writeFileSync(ix, JSON.stringify(idx));
    tick(sb);
    assert.equal(alerts().length, 2); assert.equal(sb.registry().filter((o) => o.incident).length, 1);
    assert.equal(agents(sb).length, 1);
  } finally { sb.cleanup(); }
});

test("auto ladder: stop request, delivery, grace, incident, kill, fresh restart (a bg lane restarts fresh)", () => {
  const sb = sandbox();
  try {
    const e = loopingLane(sb);
    let r = tick(sb);
    assert.match(r.out, /^LOOPING A \(gen 1\): same call x5 .* - stop requested: loop: /m);
    const stop = JSON.parse(fs.readFileSync(path.join(sb.reg, "stops", `${e.id.replace(/[^\w.-]+/g, "-")}.ladder.stop.json`), "utf8"));
    assert.equal(stop.reason_class, "ladder"); assert.match(stop.text, /^The coordinator flagged a loop \(a:main:/);
    assert.match(tick(sb).out, /stop request not delivered yet/);
    appendLine(sb, { stop_delivered: e.id, token: stop.token, at: new Date(Date.now() - 6 * MIN).toISOString() });
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^incident .*\/incidents\/A-1\.md for A/m);
    assert.match(r.out, /^killed A: closed$/m);
    assert.match(r.out, /^restarted A: fresh \(opus\/high\)/m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.kill_intent === e.id && o.kind === "ladder"));
    assert.ok(lines.some((o) => o.closed && o.id === e.id));
    assert.ok(lines.some((o) => o.restart === "A" && o.kind === "fresh" && o.from === e.id && o.n === 1));
    const relaunch = lines.filter((o) => o.name === "A" && o.launched_at).at(-1);
    assert.notEqual(relaunch.id, e.id); assert.equal(relaunch.mode, "bg");
    assert.equal(agents(sb).length, 0); // claude stop (fake) took it off the list
    assert.match(fs.readFileSync(lines.find((o) => o.incident).path, "utf8"), /## Last 20 tool calls\n1\. `Bash \{"command":"poll"\}`/);
  } finally { sb.cleanup(); }
});

test("a resumed session is not re-flagged by its pre-kill calls", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", launched_at: new Date(Date.now() - 5 * MIN).toISOString() });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    let t = tx({ start: Date.now() - 20 * MIN }).user("go");
    for (let i = 0; i < 6; i++) t = t.call("Bash", { command: "poll" }); // the loop that got it killed, before this launch line
    t.at(Date.now() - 2 * MIN).call("Read", { file_path: "incident.md" }).call("Edit", { file_path: "x" });
    writeTranscript(sb, sb.repo, SID, t.entries());
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /LOOPING/);
    assert.equal(sb.registry().filter((o) => o.stop_requested).length, 0);
  } finally { sb.cleanup(); }
});

test("legacy registry lines: no restart, no kill, report-only", () => {
  const sb = sandbox();
  try {
    const old = loopingLane(sb, { name: "L", bg_id: "bg-L", group: "g0", coord: undefined, model: undefined, effort: undefined });
    const gone = sessionLine(sb, { name: "M", id: "M@1", group: "g0", coord: undefined, model: undefined, effort: undefined, branch: "m" });
    appendLine(sb, { stop_requested: old.id, name: "L", why: "watchdog: same tool call x4", at: new Date(Date.now() - 60 * MIN).toISOString() });
    appendLine(sb, { kill_intent: gone.id, name: "M", why: "watchdog: still looping", at: new Date(Date.now() - 50 * MIN).toISOString() });
    appendLine(sb, { closed: "M", id: gone.id, at: new Date(Date.now() - 50 * MIN).toISOString() });
    const before = sb.registry().length;
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    const added = sb.registry().slice(before);
    assert.deepEqual(added.map((o) => Object.keys(o)[0]), ["incident"]);
    assert.equal(added[0].mode, "report");
    assert.equal(agents(sb).length, 1); // nothing stopped
  } finally { sb.cleanup(); }
});

test("tick.lock: a live holder blocks a second tick; a dead holder's lock is reclaimed", () => {
  const sb = sandbox();
  try {
    loopingLane(sb, { coord: undefined });
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "tick.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    let r = tick(sb);
    assert.equal(r.out, "tick: another tick holds tick.lock - skipped\n");
    assert.equal(sb.registry().filter((o) => o.incident).length, 0);
    assert.equal(fs.existsSync(path.join(sb.coord, "tick.json")), false);
    fs.writeFileSync(lock, JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid, at: new Date().toISOString() }));
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.equal(sb.registry().filter((o) => o.incident).length, 1);
    assert.equal(fs.existsSync(lock), false); // released after the run
    if (process.platform === "win32") { // a live pid whose process started after the lock was taken: PID reuse, reclaimed
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: "2020-01-01T00:00:00.000Z", at: new Date().toISOString() }));
      assert.notEqual(tick(sb).out, "tick: another tick holds tick.lock - skipped\n");
      assert.equal(fs.existsSync(lock), false);
    }
  } finally { sb.cleanup(); }
});

test("a tick that died after the kill: the next tick records the close and restarts, once", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    setAgents(sb, []); // the kill went through: the session is gone
    const inc = path.join(sb.coord, "incidents", "A-1.md");
    fs.mkdirSync(path.dirname(inc), { recursive: true }); fs.writeFileSync(inc, "# Incident A-1\n");
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: inc.split(path.sep).join("/"), signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: fresh/m);
    assert.ok(sb.registry().some((o) => o.closed && o.id === e.id));
    assert.equal(sb.registry().filter((o) => o.restart === "A" && o.from === e.id).length, 1);
    assert.equal(tick(sb).out, "tick: nothing to do\n");
    assert.equal(sb.registry().filter((o) => o.restart).length, 1);
  } finally { sb.cleanup(); }
});

test("a lane whose done marker exists is killed but not restarted", () => {
  const sb = sandbox();
  try {
    const marker = path.join(sb.repo, ".superpowers", "sessions", "g1", "A.done"), body = JSON.stringify({ head: "abc", status: "done" });
    fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, body);
    const e = sessionLine(sb, { name: "A", group: "g1", sid: SID, mode: "bg", bg_id: "bg-A", done_marker: marker.split(path.sep).join("/") });
    setAgents(sb, []);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = tick(sb);
    assert.match(r.out, /^A killed, not restarted: its done marker exists/m);
    assert.ok(sb.registry().some((o) => o.restart_skipped === e.id));
    assert.equal(sb.registry().filter((o) => o.restart).length, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), body); // the tick never writes a done marker
  } finally { sb.cleanup(); }
});

const LOOP_SIG = `a:main:${shortHash(callKey("Bash", { command: "poll" }))}`;
// The ladder reached its incident but the kill never started (or must be retried): stop, delivery, incident.
function killPending(sb, e, { stopFile = true } = {}) {
  const ago = (m) => new Date(Date.now() - m * MIN).toISOString();
  appendLine(sb, { stop_requested: e.id, name: e.name, why: "loop", reason_class: "ladder", signature: LOOP_SIG, token: "tk", at: ago(8) });
  if (stopFile) { fs.mkdirSync(path.join(sb.reg, "stops"), { recursive: true }); fs.writeFileSync(path.join(sb.reg, "stops", "A-1.ladder.stop.json"), JSON.stringify({ id: e.id, token: "tk", text: "x" })); }
  appendLine(sb, { stop_delivered: e.id, token: "tk", at: ago(7) });
  appendLine(sb, { incident: e.id, name: e.name, n: 1, path: "x/incidents/A-1.md", signature: LOOP_SIG, rule: "a", tokens: 1000, mode: "auto", at: ago(1) });
}

test("an incident whose kill never started, and the rule stopped meanwhile: cancelled, nothing killed, not pending; it can re-arm", () => {
  const sb = sandbox();
  try {
    const e = loopingLane(sb);
    killPending(sb, e);
    let t = tx({ start: Date.now() - 10 * MIN }).user("go");
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
    for (let i = 0; i < 18; i++) t = t.call("Read", { file_path: `f${i}` }); // it moved on: the repeated call left the window
    writeTranscript(sb, sb.repo, SID, t.entries());
    assert.match(tick(sb).out, new RegExp(`^cancelled the ladder ${LOOP_SIG} of A: the rule stopped firing before the kill`, "m"));
    assert.equal(sb.registry().filter((o) => o.kill_intent).length, 0);
    assert.equal(agents(sb).length, 1);
    assert.equal(fs.existsSync(path.join(sb.reg, "stops", "A-1.ladder.stop.json")), false); // never delivered later
    assert.doesNotMatch(tick(sb).out, /cancelled|kill/); // not pending any more
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" }); // the same loop again
    writeTranscript(sb, sb.repo, SID, t.entries());
    assert.match(tick(sb).out, /fired again within 60 min of its cancel: resumed at the grace step/);
  } finally { sb.cleanup(); }
});

test("an incident whose kill never started, and the rule still fires: killed and restarted", () => {
  const sb = sandbox();
  try {
    const e = loopingLane(sb);
    killPending(sb, e, { stopFile: false });
    const r = tick(sb);
    assert.match(r.out, /^killed A: closed$/m);
    assert.match(r.out, /^restarted A: fresh/m);
    assert.ok(sb.registry().some((o) => o.kill_intent === e.id && o.kind === "ladder"));
  } finally { sb.cleanup(); }
});

test("a pending ladder of a session switched to report mode: no kill, no restart, nothing written for it", () => {
  const sb = sandbox();
  try {
    const e = loopingLane(sb);
    killPending(sb, e, { stopFile: false });
    appendLine(sb, { recovery_mode: "A", mode: "report", at: new Date().toISOString() });
    const before = sb.registry().length;
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pending A: the recovery mode is report - no kill or restart \(incident x\/incidents\/A-1\.md\)$/m);
    assert.match(r.out, /^report-only A: same call x5 .* - incident x\/incidents\/A-1\.md, alerted$/m); // the scan reports it
    assert.equal(sb.registry().length, before); // no kill_intent, close, restart, cancel or stop request
    assert.equal(agents(sb).length, 1);
    assert.match(tick(sb).out, /^pending A: the recovery mode is report/m); // still pending: auto mode would resume it
  } finally { sb.cleanup(); }
});

test("a killed lane with a newer live generation is not restarted (two sessions never share a worktree)", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    sessionLine(sb, { name: "A", id: "A@2", gen: 2, sid: "sid-2", mode: "bg", bg_id: "bg-A2" });
    setAgents(sb, [{ id: "bg-A2", sessionId: "sid-2", name: "A", status: "running" }]);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    assert.match(tick(sb).out, /^A killed, not restarted: superseded by A@2$/m);
    assert.ok(sb.registry().some((o) => o.restart_skipped === e.id && o.why === "superseded by A@2"));
    assert.equal(sb.registry().filter((o) => o.restart).length, 0);
  } finally { sb.cleanup(); }
});

test("a killed lane whose newer generation's liveness is unknown: deferred with nothing written, decided once it answers", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    sessionLine(sb, { name: "A", id: "A@2", gen: 2, sid: "sid-2", mode: "bg", bg_id: "bg-A2" });
    setAgents(sb, [{ id: "bg-A2", sessionId: "sid-2", name: "A", status: "running" }]);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    appendLine(sb, { closed: "A", id: e.id, at: new Date().toISOString(), why: "loop ladder" }); // the tick died after the close
    const before = sb.registry().length;
    const r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restart of A deferred: its newer launch A@2 has liveness unknown \(process probe failed .*\) - the next tick retries$/m);
    assert.equal(sb.registry().length, before);
    assert.match(tick(sb).out, /^A killed, not restarted: superseded by A@2$/m);
  } finally { sb.cleanup(); }
});

test("a killed lane whose newer generation is gone without a close: blocked and alerted, never restarted from the old handoff", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", group: "g1", sid: SID, mode: "bg", bg_id: "bg-A" });
    sessionLine(sb, { name: "A", id: "A@2", group: "g1", gen: 2, sid: "sid-2", mode: "bg", bg_id: "bg-A2", handoff: path.join(sb.tmp, "stage2.md") });
    setAgents(sb, []); // both gone; A@2 has no {closed} line
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    assert.match(tick(sb).out, /^A killed, not restarted: superseded by A@2, which is gone - blocked, alert /m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.lane_blocked === "A" && o.handoff === path.join(sb.tmp, "stage2.md").split(path.sep).join("/")));
    assert.equal(lines.filter((o) => o.restart).length, 0);
    assert.equal(tick(sb).out, "tick: nothing to do\n");
  } finally { sb.cleanup(); }
});

test("a launcher that registers the session and then fails: {restart} with launcher_exit, no block, one alert, nothing pending", () => {
  const sb = sandbox();
  try {
    // A stand-in launcher: it records the new session's launch line, then exits 7 (as claude --bg can after starting).
    const stub = path.join(sb.tmp, "launcher-stub.cjs");
    fs.writeFileSync(stub, [
      'const fs = require("fs"), path = require("path"), a = process.argv.slice(2), name = a[a.indexOf("--name") + 1];',
      'fs.appendFileSync(path.join(process.env.HL_REGISTRY_DIR, "sessions.jsonl"), JSON.stringify({ id: name + "@stub", name, repo: "x", branch: "y", generation: 9, mode: "bg", launched_at: new Date().toISOString(), no_spawn: true }) + "\\n");',
      'console.error("claude --bg reported failure"); process.exit(7);'].join("\n"));
    const env = { HL_LAUNCH_MJS: stub };
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    setAgents(sb, []);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = coordRun(sb, ["tick"], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: fresh \(opus\/high\) - the launcher then failed \(the launcher exited 7: claude --bg reported failure, log .*\/restarts\/A-.*\.log\), but it registered the session - alert .*\.json$/m);
    const lines = sb.registry();
    assert.equal(lines.find((o) => o.restart === "A" && o.from === e.id).launcher_exit, "the launcher exited 7: claude --bg reported failure");
    assert.equal(lines.filter((o) => o.lane_blocked || o.restart_failed).length, 0);
    const d = path.join(sb.coord, "alerts");
    const al = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.equal(al.length, 1); // one alert: it was registered, but may not be running
    assert.match(JSON.parse(fs.readFileSync(path.join(d, al[0]), "utf8")).text, /^Restart of A was registered but its launcher exited 7: claude --bg reported failure \(log .*\)\. Check claude agents; if it is not running, stop\/judge it and relaunch by hand\.$/);
    assert.equal(coordRun(sb, ["tick"], { env }).out, "tick: nothing to do\n"); // nothing pending for that ladder
  } finally { sb.cleanup(); }
});

test("a restart that fails to launch: {restart_failed}, the lane is blocked, an alert names the log; never retried", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", handoff: path.join(sb.tmp, "missing.md") });
    setAgents(sb, []);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    assert.match(tick(sb).out, /^restart of A failed: the launcher exited 2: handoff not found: .* \(log .*\/restarts\/A-.*\.log\) - blocked, alert /m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.restart_failed === "A" && o.from === e.id));
    assert.equal(lines.filter((o) => o.restart).length, 0);
    assert.ok(lines.some((o) => o.lane_blocked === "A"));
    const d = path.join(sb.coord, "alerts"), [f] = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.match(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).text, /^Restart of A after a loop failed: .* Log: /);
    assert.equal(tick(sb).out, "tick: nothing to do\n");
  } finally { sb.cleanup(); }
});

test("a restart log that cannot be written: the restart is unaffected, and a failure says 'log not written' instead of a path", () => {
  const pending = (sb, handoff) => {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", ...(handoff ? { handoff } : {}) });
    setAgents(sb, []);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "restarts"), "a file where the log folder goes"); // the log write fails
    return e;
  };
  let sb = sandbox();
  try {
    pending(sb, path.join(sb.tmp, "missing.md"));
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restart of A failed: the launcher exited 2: handoff not found: .* \(log not written \(E[A-Z]+\)\) - blocked, alert /m);
    assert.match(sb.registry().find((o) => o.restart_failed === "A").log, /^not written \(E[A-Z]+\)$/);
    const d = path.join(sb.coord, "alerts"), [f] = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.match(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).text, / Log: not written \(E[A-Z]+\)\. /);
  } finally { sb.cleanup(); }
  sb = sandbox();
  try {
    const e = pending(sb, null);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: fresh \(opus\/high\)$/m);
    assert.ok(sb.registry().some((o) => o.restart === "A" && o.from === e.id));
  } finally { sb.cleanup(); }
});

test("an idle session whose finished turn repeated a call hours ago is not flagged", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", launched_at: new Date(Date.now() - 4 * 3600e3).toISOString() });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    let t = tx({ start: Date.now() - 3 * 3600e3 }).user("go");
    for (let i = 0; i < 4; i++) t = t.call("Bash", { command: "poll" });
    writeTranscript(sb, sb.repo, SID, t.say("done").turnDone().entries());
    assert.doesNotMatch(tick(sb).out, /LOOPING/);
    assert.equal(sb.registry().filter((o) => o.stop_requested).length, 0);
  } finally { sb.cleanup(); }
});

test("launch.mjs watchdog prints the tick's decisions and writes nothing", () => {
  const sb = sandbox();
  try {
    loopingLane(sb);
    const before = sb.registry().length;
    const r = sb.run("watchdog");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^LOOPING A \(gen 1\): same call x5 .* - would request stop: loop: /m);
    assert.equal(sb.registry().length, before);
    for (const f of ["looping.json", "tick.json", "tick.lock"]) assert.equal(fs.existsSync(path.join(sb.coord, f)), false, f);
    assert.equal(fs.existsSync(path.join(sb.reg, "stops")), false);
  } finally { sb.cleanup(); }
});

test("an unknown probe: the tick takes no action and says so", () => {
  const sb = sandbox();
  try {
    loopingLane(sb);
    const before = sb.registry().length;
    const r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail" } });
    assert.match(r.out, /^unknown A: liveness unknown \(process probe failed .*\) - no action$/m);
    assert.equal(sb.registry().length, before);
  } finally { sb.cleanup(); }
});

// Rule (d) waits stuck_min (30 min) from max(the notice, the parent's last main entry): a background agent loops while
// its parent sits idle (its turn ended 40 min ago).
test("a looping subagent: looping.json, its notice through the hook, then rule (d) puts the session on the ladder after stuck_min", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    writeTranscript(sb, sb.repo, SID, tx({ start: Date.now() - 40 * MIN }).user("go").call("Agent", { prompt: "find x", run_in_background: true }).say("waiting for the agent").turnDone(1).entries());
    let s = tx({ start: Date.now() - 4 * MIN }).user("task");
    for (let i = 0; i < 5; i++) s = s.call("Grep", { pattern: "x" });
    writeSubagent(sb, sb.repo, SID, "ag1", s.entries(), { agentType: "worker-high", requestShape: "background", description: "find x" });
    assert.doesNotMatch(tick(sb).out, /LOOPING/); // hooked: (d) waits for the notice
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "looping.json"), "utf8"))[SID]), ["ag1"]);
    const h = coordRun(sb, ["post-tool"], { input: { session_id: SID, agent_id: "ag1", tool_name: "Grep", tool_input: { pattern: "x" } }, env: { HL_SESSION_ID: e.id } });
    assert.match(JSON.parse(h.out).hookSpecificOutput.additionalContext, /^You are repeating `Grep \{"pattern":"x"\}`/);
    assert.doesNotMatch(tick(sb).out, /LOOPING/); // the notice is younger than stuck_min
    assert.equal(sb.registry().filter((o) => o.stop_requested).length, 0);
    const hs = path.join(sb.coord, "sessions", `${SID}.json`), st = JSON.parse(fs.readFileSync(hs, "utf8"));
    st.agent_notices.ag1 = new Date(Date.now() - 31 * MIN).toISOString();
    fs.writeFileSync(hs, JSON.stringify(st));
    assert.match(tick(sb).out, /^LOOPING A \(gen 1\): waiting on looping subagent worker-high ag1 .* - stop requested/m);
    assert.ok(sb.registry().some((o) => o.stop_requested === e.id && o.signature === "d:ag1"));
  } finally { sb.cleanup(); }
});
