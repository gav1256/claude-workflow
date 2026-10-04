import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, sessionLine, appendLine, writeTranscript, writeSubagent, setAgents, coordRun, tx, host, alive } from "./helpers.mjs";
import { callKey, shortHash } from "../recover-lib.mjs";
import { hasClaudeBelow, psq, sleep } from "../live.mjs";

const MIN = 60000, SID = "aaaaaaaa-0000-0000-0000-000000000001";
const LIVE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "live.mjs")).href;
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

test("report-only: two signatures flagged in one tick (an A,B,A,B loop) get two incidents, numbered apart, each alert on its own file", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", coord: undefined });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    let t = tx({ start: Date.now() - 10 * MIN }).user("go");
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" }).call("Read", { file_path: "x" });
    writeTranscript(sb, sb.repo, SID, t.entries());
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^report-only A: same call x5 .* - incident .*\/incidents\/A-1\.md, alerted$/m);
    assert.match(r.out, /^report-only A: same call x5 .* - incident .*\/incidents\/A-2\.md, alerted$/m);
    const keyOf = { [`a:main:${shortHash(callKey("Bash", { command: "poll" }))}`]: 'Bash {"command":"poll"}', [`a:main:${shortHash(callKey("Read", { file_path: "x" }))}`]: 'Read {"file_path":"x"}' };
    const inc = sb.registry().filter((o) => o.incident);
    assert.deepEqual(inc.map((o) => o.n), [1, 2]);
    assert.deepEqual(inc.map((o) => o.signature).sort(), Object.keys(keyOf).sort());
    assert.equal(new Set(inc.map((o) => o.path)).size, 2);
    const d = path.join(sb.coord, "alerts"), al = fs.readdirSync(d).filter((f) => /^\d.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
    assert.equal(al.length, 2);
    for (const o of inc) {
      assert.match(fs.readFileSync(o.path, "utf8"), new RegExp(`^- Signature: \`${o.signature}\` - same call x5 .*${keyOf[o.signature].replace(/[{}]/g, "\\$&")}$`, "m"));
      const mine = al.filter((a) => a.incident === o.path);
      assert.equal(mine.length, 1, o.path); assert.ok(mine[0].text.includes(keyOf[o.signature]), mine[0].text);
    }
  } finally { sb.cleanup(); }
});

test("report-only: alerts/index.json is written with each alert, so a tick that dies later in the scan never re-alerts it", () => {
  const sb = sandbox();
  try {
    loopingLane(sb, { coord: undefined }); // A: report-only, alerted first in the scan
    // B, after A in the scan: an auto lane at its kill step whose restart's launcher kills the tick (a tick dying mid-scan).
    const b = sessionLine(sb, { name: "B", sid: "sid-b", mode: "bg", bg_id: "bg-B", branch: "b" });
    setAgents(sb, [...agents(sb), { id: "bg-B", sessionId: "sid-b", name: "B", status: "running" }]);
    let t = tx({ start: Date.now() - 10 * MIN }).user("go");
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
    writeTranscript(sb, sb.repo, "sid-b", t.entries());
    const ago = (m) => new Date(Date.now() - m * MIN).toISOString(), sig = `a:main:${shortHash(callKey("Bash", { command: "poll" }))}`;
    appendLine(sb, { stop_requested: b.id, name: "B", why: "loop", reason_class: "ladder", signature: sig, token: "tk", at: ago(8) });
    appendLine(sb, { stop_delivered: b.id, token: "tk", at: ago(7) });
    const killer = path.join(sb.tmp, "kill-tick.cjs"), noop = path.join(sb.tmp, "noop.cjs");
    fs.writeFileSync(killer, "process.kill(process.ppid);"); fs.writeFileSync(noop, "");
    const alertsOfA = () => fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => /^\d.*-A(-\d+)?\.json$/.test(f)).length;
    const r = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: killer } });
    assert.equal(r.out, ""); // it died before printing anything
    assert.ok(sb.registry().some((o) => o.closed && o.id === b.id)); // at B's restart, after A's alert
    assert.equal(alertsOfA(), 1);
    const r2 = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: noop } }); // reclaims the dead tick's lock, restarts B
    assert.match(r2.out, /^restarted B: fresh/m);
    assert.equal(alertsOfA(), 1); // A not alerted again
  } finally { sb.cleanup(); }
});

test("a state write that fails at scan end or with an alert: one error line each, and the scan's lines are kept", () => {
  const sb = sandbox();
  try {
    loopingLane(sb, { coord: undefined });
    for (const f of ["looping.json", path.join("alerts", "index.json")]) fs.mkdirSync(path.join(sb.coord, f), { recursive: true }); // both writes fail
    const r = tick(sb);
    assert.equal(r.code, 0, r.err); // not a failed tick
    assert.match(r.out, /^report-only A: same call x5 .* - incident .*\/incidents\/A-1\.md, alerted$/m);
    assert.match(r.out, /^error: alerts\/index\.json not written \(E[A-Z]+\)$/m);
    assert.match(r.out, /^error: looping\.json not written \(E[A-Z]+\)$/m);
    assert.doesNotMatch(r.out, /tick failed|skipped this tick/);
    assert.match(fs.readFileSync(path.join(sb.coord, "last-tick.txt"), "utf8"), /^report-only A: .* alerted$/m);
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
  // The same transcripts under two launch lines: one before the loop (the positive control: flagged), one after it.
  const run = (launchedAt) => {
    const sb = sandbox();
    try {
      sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", launched_at: launchedAt });
      setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
      let t = tx({ start: Date.now() - 20 * MIN }).user("go");
      for (let i = 0; i < 6; i++) t = t.call("Bash", { command: "poll" }); // the loop that got it killed
      t.at(Date.now() - 2 * MIN).call("Read", { file_path: "incident.md" }).call("Edit", { file_path: "x" });
      writeTranscript(sb, sb.repo, SID, t.entries());
      // A subagent of the killed run: its calls predate the launch, but its file was touched since (mtime now).
      let s = tx({ start: Date.now() - 20 * MIN }).user("task");
      for (let i = 0; i < 5; i++) s = s.call("Grep", { pattern: "x" });
      writeSubagent(sb, sb.repo, SID, "ag1", s.entries());
      const r = tick(sb);
      assert.equal(r.code, 0, r.err);
      const looping = JSON.parse(fs.readFileSync(path.join(sb.coord, "looping.json"), "utf8"))[SID] || null;
      return { out: r.out, stops: sb.registry().filter((o) => o.stop_requested).length, looping };
    } finally { sb.cleanup(); }
  };
  const control = run(new Date(Date.now() - 2 * 3600e3).toISOString());
  assert.match(control.out, /^LOOPING A \(gen 1\): same call x6 /m);
  assert.deepEqual(Object.keys(control.looping || {}), ["ag1"]);
  const resumed = run(new Date(Date.now() - 5 * MIN).toISOString()); // the loop is before this launch line
  assert.doesNotMatch(resumed.out, /LOOPING/);
  assert.equal(resumed.stops, 0);
  assert.equal(resumed.looping, null); // nor are its subagent's pre-launch calls counted
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
    assert.equal(sb.registry().filter((o) => o.lane_blocked).length, 0); // it runs: held, never blocked
  } finally { sb.cleanup(); }
});

test("report mode over a pending ladder whose session is closed or gone: the lane is blocked and alerted once, and the ladder ends", () => {
  const sb = sandbox();
  try {
    const at = new Date().toISOString();
    const a = sessionLine(sb, { name: "A", group: "g1", sid: SID, mode: "bg", bg_id: "bg-A" });
    const b = sessionLine(sb, { name: "B", group: "g1", sid: "sid-b", mode: "bg", bg_id: "bg-B", branch: "b" });
    setAgents(sb, []); // killed under auto, the tick died before the restart, then the group was switched to report
    for (const e of [a, b]) {
      appendLine(sb, { incident: e.id, name: e.name, n: 1, path: `x/incidents/${e.name}-1.md`, signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
      appendLine(sb, { kill_intent: e.id, name: e.name, kind: "ladder", why: "loop ladder", at });
    }
    appendLine(sb, { closed: "A", id: a.id, at, why: "loop ladder" }); // A's close was recorded; B is gone without one
    appendLine(sb, { recovery_mode: "g1", mode: "report", at });
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pending A: the recovery mode is report and the session is closed - blocked, alert .*\.json$/m);
    assert.match(r.out, /^pending B: the recovery mode is report and the session is gone \(not listed by claude agents\) - blocked, alert .*\.json$/m);
    const lines = sb.registry();
    for (const n of ["A", "B"]) assert.equal(lines.filter((o) => o.lane_blocked === n && o.group === "g1" && o.incident === `x/incidents/${n}-1.md`).length, 1, n);
    // B's kill went through (kill_intent) and it is gone: its close is recorded first, as the auto path does, so its
    // launch line is never probed again; A already had its close.
    const closeB = lines.findIndex((o) => o.closed === "B" && o.id === b.id);
    assert.ok(closeB >= 0 && closeB < lines.findIndex((o) => o.lane_blocked === "B"), "B closed before its block");
    assert.equal(lines.filter((o) => o.closed && o.id === a.id).length, 1);
    assert.equal(lines.filter((o) => o.restart || o.restart_failed || o.restart_skipped || o.ladder_cancelled).length, 0);
    const d = path.join(sb.coord, "alerts"), al = fs.readdirSync(d).filter((f) => /^\d.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
    assert.equal(al.length, 2);
    assert.ok(al.some((x) => x.incident === "x/incidents/A-1.md" && / recovery mode is now report.* resume --group g1 --lane A$/.test(x.text)), JSON.stringify(al));
    assert.equal(tick(sb).out, "tick: nothing to do\n"); // terminal: no pending line every tick
  } finally { sb.cleanup(); }
});

test("report mode over a pending ladder whose lane was relaunched by hand: superseded ({restart_skipped}), never blocked; an unknown newer launch holds", () => {
  const sb = sandbox();
  try {
    const at = new Date().toISOString();
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at });
    appendLine(sb, { closed: "A", id: e.id, at, why: "loop ladder" }); // killed under auto; the tick died before the restart
    sessionLine(sb, { name: "A", id: "A@2", gen: 2, sid: "sid-2", mode: "bg", bg_id: "bg-A2" }); // relaunched by hand
    setAgents(sb, [{ id: "bg-A2", sessionId: "sid-2", name: "A", status: "running" }]);
    appendLine(sb, { recovery_mode: "A", mode: "report", at });
    const before = sb.registry().length;
    let r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail" } });
    assert.match(r.out, /^block of A deferred: its newer launch A@2 has liveness unknown \(process probe failed .*\) - the next tick retries$/m);
    assert.equal(sb.registry().length, before); // unknown: nothing written
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pending A: the recovery mode is report and the session is closed, not restarted: superseded by A@2$/m);
    const lines = sb.registry();
    assert.equal(lines.filter((o) => o.restart_skipped === e.id && o.why === "superseded by A@2").length, 1);
    assert.equal(lines.filter((o) => o.lane_blocked).length, 0);
    const d = path.join(sb.coord, "alerts");
    assert.equal(fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^\d/.test(f)).length : 0, 0);
    assert.equal(tick(sb).out, "tick: nothing to do\n"); // the ladder ended
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

test("a newer generation judged running earlier in the tick, gone by the restart decision: probed again, blocked, not superseded", () => {
  const sb = sandbox();
  try {
    // B's restart (a stand-in launcher) runs while A@2 dies: A@2 leaves the agents list.
    const stub = path.join(sb.tmp, "launcher-stub.cjs");
    fs.writeFileSync(stub, 'const fs = require("fs"), f = process.env.HL_AGENTS_JSON; fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, "utf8")).filter((a) => a.id !== "bg-A2")));');
    const at = new Date().toISOString();
    const a1 = sessionLine(sb, { name: "A", group: "g1", sid: SID, mode: "bg", bg_id: "bg-A" });
    const a2 = sessionLine(sb, { name: "A", id: "A@2", group: "g1", gen: 2, sid: "sid-2", mode: "bg", bg_id: "bg-A2" });
    const b = sessionLine(sb, { name: "B", group: "g1", sid: "sid-b", mode: "bg", bg_id: "bg-B", branch: "b" });
    setAgents(sb, [{ id: "bg-A2", sessionId: "sid-2", name: "A", status: "running" }]);
    // Pending in this order: A@2 (running, its rule stopped: cancelled - its liveness is judged here), B (killed:
    // restarted), A@1 (killed: its restart decision judges A@2 again).
    appendLine(sb, { incident: a2.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x2", rule: "a", tokens: 1000, mode: "auto", at });
    for (const [e, n] of [[b, 1], [a1, 2]]) {
      appendLine(sb, { incident: e.id, name: e.name, n, path: `x/incidents/${e.name}-${n}.md`, signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
      appendLine(sb, { kill_intent: e.id, name: e.name, kind: "ladder", why: "loop ladder", at });
      appendLine(sb, { closed: e.name, id: e.id, at, why: "loop ladder" });
    }
    const r = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: stub } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^cancelled the ladder a:main:x2 of A: /m);
    assert.match(r.out, /^restarted B: fresh/m);
    assert.match(r.out, /^A killed, not restarted: superseded by A@2, which is gone - blocked, alert /m);
    const lines = sb.registry();
    assert.equal(lines.filter((o) => o.restart_skipped === a1.id).length, 0);
    assert.ok(lines.some((o) => o.lane_blocked === "A" && o.incident === "x/incidents/A-2.md"));
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

test("a restart the session cap refuses is deferred: nothing terminal, one alert per lane, retried every tick, never --force; with RAM back the next tick restarts", () => {
  const sb = sandbox();
  try {
    const at = new Date().toISOString();
    // A: a bg lane (fresh restart) with a lane profile. W: a window lane with a session id (first restart: --resume) and
    // no profile (a line from before profiles). Both killed for a loop, their restarts pending.
    const a = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", branch: "a", profile: "python" });
    const w = sessionLine(sb, { name: "W", sid: "s-w", mode: "window", branch: "w" });
    setAgents(sb, []); // the kills went through
    for (const e of [a, w]) {
      const inc = path.join(sb.coord, "incidents", `${e.name}-1.md`).split(path.sep).join("/");
      fs.mkdirSync(path.dirname(inc), { recursive: true }); fs.writeFileSync(inc, `# Incident ${e.name}-1\n`);
      appendLine(sb, { incident: e.id, name: e.name, n: 1, path: inc, signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
      appendLine(sb, { kill_intent: e.id, name: e.name, kind: "ladder", why: "loop ladder", at });
    }
    const terminal = () => sb.registry().filter((o) => o.restart || o.restart_failed || o.restart_skipped || o.lane_blocked);
    const launchesOf = (n) => sb.registry().filter((o) => o.name === n && o.launched_at);
    const alertsDir = path.join(sb.coord, "alerts"), restarts = path.join(sb.coord, "restarts");
    const alertFiles = () => fs.readdirSync(alertsDir).filter((f) => /^\d/.test(f));
    const logs = () => fs.readdirSync(restarts);
    sb.env.HL_FREE_GB = "1"; // below min_free_gb (default 3): the launcher's cap refuses with exit 3
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    for (const n of ["A", "W"]) assert.match(r.out, new RegExp(`^restart of ${n} deferred: session cap \\(1\\.0 GB free RAM, min_free_gb 3\\) - retried at every tick, alert .*\\.json$`, "m"));
    assert.deepEqual(terminal(), []); // no {restart_failed}, no {lane_blocked}: the ladders stay pending
    assert.ok([a, w].every((e) => sb.registry().some((o) => o.closed && o.id === e.id)));
    assert.deepEqual([launchesOf("A").length, launchesOf("W").length], [1, 1]);
    assert.equal(alertFiles().length, 2);
    for (const f of alertFiles()) assert.match(JSON.parse(fs.readFileSync(path.join(alertsDir, f), "utf8")).text, /^Restart of [AW] after a loop is deferred: the session cap refused it \(1\.0 GB free RAM, min_free_gb 3\)\. Log: .*\/restarts\/[AW]-.*\.log\. Incident: .*The coordinator retries it at every tick/);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(alertsDir, "index.json"), "utf8"))).sort(), [`cap|${a.id}`, `cap|${w.id}`]);
    assert.equal(logs().length, 2);
    // The tick never passes --force; the fresh restart keeps the lane profile (A), the resume is --resume <sid> (W).
    const argvOf = (n) => fs.readFileSync(path.join(restarts, logs().find((f) => f.startsWith(`${n}-`))), "utf8").split("\n")[0];
    assert.doesNotMatch(argvOf("A") + argvOf("W"), /--force/);
    assert.match(argvOf("A"), / --profile python /);
    assert.match(argvOf("W"), /^node launch\.mjs --resume s-w --recovery /);
    assert.match(fs.readFileSync(path.join(restarts, logs()[0]), "utf8"), /^exit 3\nrefused - session cap: 1\.0 GB free RAM/m);
    // Next tick: still deferred, no second alert, and a retry that does not alert leaves no extra log.
    r = tick(sb);
    for (const n of ["A", "W"]) assert.match(r.out, new RegExp(`^restart of ${n} deferred: session cap \\(1\\.0 GB free RAM, min_free_gb 3\\)$`, "m"));
    assert.deepEqual([alertFiles().length, logs().length, terminal().length], [2, 2, 0]);
    // After alert_repeat_hours the still-deferred restart alerts again (once per lane).
    const ix = path.join(alertsDir, "index.json"), idx = JSON.parse(fs.readFileSync(ix, "utf8"));
    idx[`cap|${a.id}`] = new Date(Date.now() - 7 * 3600e3).toISOString();
    fs.writeFileSync(ix, JSON.stringify(idx));
    r = tick(sb);
    assert.match(r.out, /^restart of A deferred: session cap \(.*\) - retried at every tick, alert /m);
    assert.match(r.out, /^restart of W deferred: session cap \(1\.0 GB free RAM, min_free_gb 3\)$/m);
    assert.equal(alertFiles().length, 3);
    // RAM back: the next tick restarts both, once.
    sb.env.HL_FREE_GB = "64";
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: fresh \(opus\/high\)$/m);
    assert.match(r.out, /^restarted W: resume \(opus\/high\)$/m);
    assert.deepEqual(terminal().map((o) => [o.restart, o.from]), [["A", a.id], ["W", w.id]]);
    assert.equal(launchesOf("A").at(-1).profile, "python"); // merge rule 3: the fresh restart keeps the profile
    assert.equal(launchesOf("W").at(-1).profile, "full"); // and an entry without one resumes with full
    assert.equal(launchesOf("W").at(-1).session_id, "s-w");
    assert.equal(alertFiles().length, 3);
    assert.equal(tick(sb).out, "tick: nothing to do\n");
  } finally { sb.cleanup(); }
});

test("the tick's fresh restart of a pre-profile entry uses full (it ran with every plugin); one with a profile keeps it", () => {
  const sb = sandbox();
  try {
    const at = new Date().toISOString();
    const old = sessionLine(sb, { name: "O", sid: "s-o", mode: "bg", bg_id: "bg-o", branch: "o" }); // no profile: before profiles
    const lean = sessionLine(sb, { name: "L", sid: "s-l", mode: "bg", bg_id: "bg-l", branch: "l", profile: "lean" });
    setAgents(sb, []); // both killed
    for (const e of [old, lean]) {
      appendLine(sb, { incident: e.id, name: e.name, n: 1, path: `x/incidents/${e.name}-1.md`, signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
      appendLine(sb, { kill_intent: e.id, name: e.name, kind: "ladder", why: "loop ladder", at });
    }
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted O: fresh \(opus\/high\)$/m); assert.match(r.out, /^restarted L: fresh \(opus\/high\)$/m);
    const last = (n) => sb.registry().filter((o) => o.name === n && o.launched_at).at(-1);
    assert.equal(last("O").profile, "full"); assert.equal(last("L").profile, "lean");
    const logs = fs.readdirSync(path.join(sb.coord, "restarts")), argv = (n) => fs.readFileSync(path.join(sb.coord, "restarts", logs.find((f) => f.startsWith(`${n}-`))), "utf8").split("\n")[0];
    assert.match(argv("O"), / --profile full /); assert.match(argv("L"), / --profile lean /);
  } finally { sb.cleanup(); }
});

test("an exit 3 without the session-cap line, or the cap's line with another exit, is a failed restart, never a deferral", () => {
  for (const [code, text] of [[3, "lane A already wrote its done marker - start post-merge stages under a NEW group"], [1, "refused - session cap: 6 sessions running, max_sessions 6 (config x)"]]) {
    const sb = sandbox();
    try {
      const stub = path.join(sb.tmp, "launcher-stub.cjs");
      fs.writeFileSync(stub, `console.error(${JSON.stringify(text)}); process.exit(${code});`);
      const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
      setAgents(sb, []);
      appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
      appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
      const r = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: stub } });
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`^restart of A failed: the launcher exited ${code}: .* - blocked, alert `, "m"));
      assert.doesNotMatch(r.out, /deferred/);
      assert.ok(sb.registry().some((o) => o.restart_failed === "A") && sb.registry().some((o) => o.lane_blocked === "A"));
    } finally { sb.cleanup(); }
  }
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

test("a window lane with a session id, below fresh_at_tokens, first loop: resumed with --resume <sid> --recovery <incident>, its model and effort", () => {
  const sb = sandbox();
  try {
    const argvFile = path.join(sb.tmp, "launcher-argv.json"), stub = path.join(sb.tmp, "launcher-stub.cjs");
    fs.writeFileSync(stub, `require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`);
    // A window session with no host pid recorded 2 h after its launch reads as gone: the kill went through.
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "window", model: "fable", effort: "xhigh" });
    const inc = path.join(sb.coord, "incidents", "A-1.md").split(path.sep).join("/"), at = new Date().toISOString();
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: inc, signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at });
    const r = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: stub } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: resume \(fable\/xhigh\)$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), ["--resume", SID, "--recovery", inc, "--model", "fable", "--effort", "xhigh"]);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.closed && o.id === e.id));
    assert.equal(lines.filter((o) => o.restart === "A" && o.kind === "resume" && o.from === e.id && o.n === 1 && o.model === "fable" && o.effort === "xhigh").length, 1);
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

// The parent is blocked on a foreground Agent call while its subagent loops: rule (b) escalates (ruling: it keeps
// winning over (d)), and the incident names the real cause, the looping subagent and its repeated call.
test("a foreground Agent call over a looping subagent: the ladder kills, and the incident's Looping subagents section names the subagent's repeated call", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    writeTranscript(sb, sb.repo, SID, tx({ start: Date.now() - 40 * MIN }).user("go").call("Agent", { prompt: "find x" }, { result: false }).entries());
    let s = tx({ start: Date.now() - 4 * MIN }).user("task");
    for (let i = 0; i < 5; i++) s = s.call("Grep", { pattern: "x" });
    writeSubagent(sb, sb.repo, SID, "ag1", s.entries(), { agentType: "worker-high", requestShape: "foreground", description: "find x" });
    assert.match(tick(sb).out, /^LOOPING A \(gen 1\): Agent call outstanding with no activity for \d+ min - stop requested/m);
    // (b)'s grace counts from the stop request: age the request past grace_min.
    const regFile = path.join(sb.reg, "sessions.jsonl"), aged = new Date(Date.now() - 6 * MIN).toISOString();
    fs.writeFileSync(regFile, sb.registry().map((o) => JSON.stringify(o.stop_requested ? { ...o, at: aged } : o)).join("\n") + "\n");
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^incident .*\/incidents\/A-1\.md for A \(Agent call outstanding/m);
    assert.match(r.out, /^killed A: closed$/m);
    const inc = sb.registry().find((o) => o.incident === e.id);
    assert.equal(inc.signature, "b:Agent");
    const md = fs.readFileSync(inc.path, "utf8"), call = '`Grep \\{"pattern":"x"\\}`';
    assert.match(md, new RegExp(`^## Looping subagents\\n- ag1 \\(worker-high\\): same call x5 in the last 5 tool calls: Grep \\{"pattern":"x"\\}\\n  1\\. ${call}\\n(  [2-5]\\. ${call}\\n){4}\\n`, "m"));
  } finally { sb.cleanup(); }
});

test("coord.mjs tick: a failed tick exits 1 (an import failure, or a failure inside the tick); the hooks still exit 0", () => {
  const sb = sandbox();
  try {
    const missing = { HL_SKILL_DIR: path.join(sb.tmp, "missing") };
    let r = coordRun(sb, ["tick"], { env: missing });
    assert.equal(r.code, 1); assert.match(r.err, /^tick failed: /);
    fs.mkdirSync(path.join(sb.coord, "tick.json"), { recursive: true }); // the tick's first write fails
    r = tick(sb);
    assert.equal(r.code, 1); assert.match(r.out, /^tick failed: /m);
    assert.equal(fs.existsSync(path.join(sb.coord, "tick.lock")), false); // released all the same
    for (const sub of ["post-tool", "notify"]) {
      r = coordRun(sb, [sub], { input: { session_id: SID, tool_name: "Bash", tool_input: {}, notification_type: "permission_prompt" }, env: { ...missing, HL_SESSION_ID: "A@1" } });
      assert.equal(r.code, 0, sub); assert.equal(r.out, "", sub); assert.equal(r.err, "", sub);
    }
  } finally { sb.cleanup(); }
});

// ---------- guarded closes: superseded N-1, paused and incident windows ----------
test("superseded N-1 and paused windows close when idle; busy or waiting ones stay", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hosts = Array.from({ length: 10 }, () => host());
  try {
    const old = Date.now() - 40 * MIN;
    const idleT = tx({ start: old }).user("go").call("Bash", { command: "x" }).say("handed off").turnDone().entries();
    const busyT = tx({ start: old }).user("go").call("mcp__x__slow", {}, { result: false }).entries();
    const mk = (name, branch, i, t, gen) => { const e = sessionLine(sb, { name, id: `${name}@${gen}`, branch, gen, sid: `${name}-s${gen}`, host: hosts[i] }); if (t) writeTranscript(sb, sb.repo, e.session_id, t); return e; };
    const x1 = mk("X", "x", 0, idleT, 1); mk("X", "x", 1, null, 2);      // idle N-1, N running: closed
    mk("Y", "y", 2, busyT, 1); mk("Y", "y", 3, null, 2);                 // busy N-1: kept
    const z1 = mk("Z", "z", 4, idleT, 1); mk("Z", "z", 5, null, 2);      // idle but waiting on a permission: kept
    const p1 = mk("P", "p", 6, idleT, 1);                                // paused and idle: closed
    appendLine(sb, { paused: "P", at: new Date().toISOString() });
    // a report-only session (pre-stage-2 line) with an incident and a running gen 3, not N-1: kept
    const q1 = sessionLine(sb, { name: "Q", id: "Q@1", branch: "q", gen: 1, sid: "Q-s1", host: hosts[7], coord: undefined });
    writeTranscript(sb, sb.repo, q1.session_id, idleT);
    sessionLine(sb, { name: "Q", id: "Q@3", branch: "q", gen: 3, sid: "Q-s3", host: hosts[8], coord: undefined });
    appendLine(sb, { incident: q1.id, name: "Q", n: 1, path: "x/Q-1.md", signature: "a:main:x", mode: "report", at: new Date().toISOString() });
    // a paused, idle window of a report-only session: kept (only the N-1 close applies to report-only groups)
    const r1 = sessionLine(sb, { name: "R", id: "R@1", branch: "r", gen: 1, sid: "R-s1", host: hosts[9], coord: undefined });
    writeTranscript(sb, sb.repo, r1.session_id, idleT);
    appendLine(sb, { paused: "R", at: new Date().toISOString() });
    fs.mkdirSync(path.join(sb.coord, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "sessions", `${z1.session_id}.json`), JSON.stringify({ waiting_since: new Date().toISOString() }));
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would close X \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.equal(alive(hosts[0].pid), true);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed X \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.match(r.out, /^closed P \(gen 1\): paused: idle \d+ min$/m);
    assert.doesNotMatch(r.out, /close[ds]? [YZQR] /);
    assert.equal(alive(hosts[0].pid), false); assert.equal(alive(hosts[6].pid), false);
    for (const i of [1, 2, 3, 4, 5, 7, 8, 9]) assert.equal(alive(hosts[i].pid), true, `host ${i}`);
    assert.equal(sb.registry().filter((o) => o.kill_intent === r1.id).length, 0);
    const lines = sb.registry();
    for (const e of [x1, p1]) {
      assert.ok(lines.some((o) => o.kill_intent === e.id && o.kind === "close"), e.id);
      assert.ok(lines.some((o) => o.closed && o.id === e.id), e.id);
    }
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("sessionState knows the pending background agents only when the turn ended with a turn_duration record", () => {
  const sb = sandbox();
  try {
    const t = Date.now() - 40 * MIN, done = () => tx({ start: t }).user("go").say("done");
    const noField = done().turnDone().entries(); delete noField.at(-1).pendingBackgroundAgentCount; // the CLI writes the count only when it is not 0
    const ts = { "s-td": done().turnDone().entries(), "s-td2": done().turnDone(2).entries(), "s-nofield": noField, "s-end": done().entries() };
    for (const [sid, entries] of Object.entries(ts)) writeTranscript(sb, sb.repo, sid, entries);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const V = await import(${JSON.stringify(LIVE)});
for (const s of ${JSON.stringify(Object.keys(ts))}) { const x = V.sessionState({ id: s, mode: "window", session_id: s }); console.log(s, x.idle, x.bgKnown, x.bgAgents); }`], { env: sb.env, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ["s-td true true 0", "s-td2 false true 2", "s-nofield true true 0", "s-end true false 0"]);
  } finally { sb.cleanup(); }
});

test("the guarded close in a pre-stage-2 group and without a transcript; kept: claude below, background agents unknown, successor gone, a pending ladder", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  // C's host runs a node process (claude's stand-in below the window); it exits once its host is gone.
  const kid = path.join(sb.tmp, "kid.cjs");
  fs.writeFileSync(kid, "const pp = process.ppid; setInterval(() => { try { process.kill(pp, 0); } catch { process.exit(0); } }, 500); setTimeout(() => process.exit(0), 180000);\n");
  const hosts = [host(), host(), host(`& ${psq(process.execPath)} ${psq(kid)}`), host(), host(), host()];
  try {
    for (let i = 0; i < 40 && hasClaudeBelow(hosts[2].pid) !== true; i++) sleep(500);
    assert.equal(hasClaudeBelow(hosts[2].pid), true, "node runs below C's host");
    const at = new Date().toISOString(), old = Date.now() - 40 * MIN;
    const idleT = tx({ start: old }).user("go").say("handed off").turnDone().entries();
    const noTdT = tx({ start: old }).user("go").say("handed off").entries(); // no turn_duration record: background agents unknown
    const legacy = { group: "g0", coord: undefined, model: undefined, effort: undefined }; // a pre-stage-2 group: report-only
    const win = (name, i, t, o = {}) => { const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), gen: 1, sid: `${name}-s1`, host: hosts[i], ...o }); if (t) writeTranscript(sb, sb.repo, e.session_id, t); return e; };
    const bgN = (name, o = {}) => sessionLine(sb, { name, id: `${name}@2`, branch: name.toLowerCase(), gen: 2, sid: `${name}-s2`, mode: "bg", bg_id: `bg-${name}`, ...o });
    win("A", 0, idleT, legacy); bgN("A", legacy);   // idle N-1 of a report-only group, N running: closed
    win("B", 1, null, legacy); bgN("B", legacy);    // no transcript and no claude in the window: closed
    win("C", 2, null); bgN("C");                    // no transcript, but claude (node) runs below the host: kept
    win("D", 3, noTdT); bgN("D");                   // idle, but its turn has no turn_duration record: kept
    win("E", 4, idleT); bgN("E");                   // idle, but N is gone (not listed): kept
    win("F", 5, idleT);                             // paused, idle, with a pending auto ladder: the ladder is cancelled first, then closed
    appendLine(sb, { paused: "F", at });
    appendLine(sb, { incident: "F@1", name: "F", n: 1, path: "x/F-1.md", signature: "a:main:x", mode: "auto", at });
    setAgents(sb, ["A", "B", "C", "D"].map((n) => ({ id: `bg-${n}`, sessionId: `${n}-s2`, name: n, status: "running" })));
    const before = sb.registry().length;
    const dry = tick(sb, "--dry-run");
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /^would close A \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.match(dry.out, /^would close B \(gen 1\): superseded by generation 2: no claude running in the window$/m);
    assert.match(dry.out, /^skip close of F \(gen 1\): its loop ladder is pending - the ladder ends first$/m);
    assert.doesNotMatch(dry.out, /would close [CDEF] /);
    assert.equal(sb.registry().length, before);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed A \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.match(r.out, /^closed B \(gen 1\): superseded by generation 2: no claude running in the window$/m);
    assert.match(r.out, /^cancelled the ladder a:main:x of F: .* before the kill/m);
    assert.match(r.out, /^closed F \(gen 1\): paused: idle \d+ min$/m);
    assert.doesNotMatch(r.out, /close[ds]? [CDE] /);
    for (const i of [0, 1, 5]) assert.equal(alive(hosts[i].pid), false, `host ${i}`);
    for (const i of [2, 3, 4]) assert.equal(alive(hosts[i].pid), true, `host ${i}`);
    // Exactly these lines, and each kill_intent of kind close: a pre-stage-2 group gets nothing else.
    const added = sb.registry().slice(before);
    assert.deepEqual(added.map((o) => `${Object.keys(o)[0]} ${o.kill_intent || o.id || o.ladder_cancelled}`),
      ["ladder_cancelled F@1", "kill_intent A@1", "closed A@1", "kill_intent B@1", "closed B@1", "kill_intent F@1", "closed F@1"]);
    assert.ok(added.filter((o) => o.kill_intent).every((o) => o.kind === "close"));
    const n = sb.registry().length, again = tick(sb);
    assert.equal(again.code, 0, again.err);
    assert.doesNotMatch(again.out, /close/);
    assert.equal(sb.registry().length, n); // nothing more: no restart, no block, no second close
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("one tick that closes two superseded windows with background successors lists claude agents once", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hosts = [host(), host()];
  try {
    const idleT = tx({ start: Date.now() - 40 * MIN }).user("go").say("handed off").turnDone().entries();
    for (const [i, n] of ["A", "B"].entries()) {
      const e = sessionLine(sb, { name: n, id: `${n}@1`, branch: n.toLowerCase(), gen: 1, sid: `${n}-s1`, host: hosts[i] });
      writeTranscript(sb, sb.repo, e.session_id, idleT);
      sessionLine(sb, { name: n, id: `${n}@2`, branch: n.toLowerCase(), gen: 2, sid: `${n}-s2`, mode: "bg", bg_id: `bg-${n}` });
    }
    setAgents(sb, ["A", "B"].map((n) => ({ id: `bg-${n}`, sessionId: `${n}-s2`, name: n, status: "running" })));
    const log = path.join(sb.tmp, "agents.log");
    const r = coordRun(sb, ["tick"], { env: { HL_AGENTS_LOG: log } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed A \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.match(r.out, /^closed B \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).length : 0, 1); // the scan's list, reused by the closes
    for (const h of hosts) assert.equal(alive(h.pid), false);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});
