// Batch B, Part 4: the watcher (`coord.mjs watch`): single instance, its one step (--once), its stop rule (a fake start
// time stands in for the clock), the tick starting it. HL_NO_SPAWN: nothing is ever started detached here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sandbox, coordRun, sessionLine, appendLine, writeTranscript, setAgents, tx, alive, COORD_MJS } from "./helpers.mjs";
import { sleep } from "../live.mjs";

const MIN = 60000, DAY = 24 * 60 * MIN, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const watch = (sb, ...a) => coordRun(sb, ["watch", ...a]);
const manual = (sb) => { fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true }); fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "t", at: ago(5) })); };
function bgLane(sb, name, pausedMin) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, mode: "bg", bg_id: `bg-${name}`, supersedes: null });
  writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
  setAgents(sb, [{ id: `bg-${name}`, sessionId: `${name}-s1`, name, status: "idle" }]);
  if (pausedMin != null) appendLine(sb, { paused: e.id, name, group: null, at: ago(pausedMin), reason: "manual pause", source: "manual", windows: [] });
  return e;
}
const startOf = (pid) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8" }).stdout.trim();

test("watch --once: nothing paused stops it at once and releases its lock", () => {
  const sb = sandbox();
  try {
    const r = watch(sb, "--once");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "watch: stopped - nothing is paused or waiting to resume\n");
    assert.equal(fs.existsSync(path.join(sb.coord, "watch.lock")), false);
  } finally { sb.cleanup(); }
});

test("watch --once: an open paused lane makes it run a tick (which closes it); a source with nothing to act on runs none", () => {
  const sb = sandbox();
  try {
    manual(sb);
    let r = watch(sb, "--once");
    assert.equal(r.out, "watch: one step done\n"); // a source, no lane: it waits, no tick
    assert.equal(fs.existsSync(path.join(sb.coord, "last-tick.txt")), false);
    bgLane(sb, "A", 3);
    r = watch(sb, "--once");
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m);
    assert.match(r.out, /^watch: one step done \(a tick ran\)$/m);
  } finally { sb.cleanup(); }
});

test("watch --once leaves out lanes the tick gave up on: a relaunch failed twice, a close alerted - no tick for them", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", supersedes: null }); // closed by a pause, relaunch failed twice
    appendLine(sb, { paused: a.id, name: "A", group: null, at: ago(30), reason: "manual pause", source: "manual", windows: [] });
    appendLine(sb, { closed: "A", id: a.id, at: ago(29), why: "paused" });
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pause", "tick-state.json"), JSON.stringify({ failed: { [a.id]: 2 }, alerted: ["B@1"] }));
    let r = watch(sb, "--once");
    assert.equal(r.out, "watch: stopped - nothing is paused or waiting to resume\n");
    manual(sb);
    bgLane(sb, "B", 3); // open, paused, its close alerted
    setAgents(sb, [{ id: "bg-B", sessionId: "B-s1", name: "B", status: "idle" }]);
    r = watch(sb, "--once");
    assert.equal(r.out, "watch: one step done\n"); // nothing it can act on: no tick
    assert.equal(fs.existsSync(path.join(sb.coord, "last-tick.txt")), false);
  } finally { sb.cleanup(); }
});

test("watch steps in one process: fresh liveness every step (no memo across steps), and a 5-min back-off after a tick that did nothing", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const e = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", mode: "bg", bg_id: "bg-A", supersedes: null });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    appendLine(sb, { paused: e.id, name: "A", group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
    const running = JSON.stringify([{ id: "bg-A", sessionId: "A-s1", name: "A", status: "working" }]); // busy: never closed
    const agents = path.join(sb.tmp, "agents.json");
    fs.writeFileSync(agents, running);
    const script = `const fs = await import("node:fs"), C = await import(${JSON.stringify(pathToFileURL(COORD_MJS).href)});
const step = (last) => C.watchStep({ now: Date.now(), started: Date.now(), last });
const out = [], a = await step(null); out.push(a.ticked, a.last?.acted);
fs.writeFileSync(${JSON.stringify(agents)}, "[]"); // A's background session is gone now
out.push((await step(null)).ticked);
fs.writeFileSync(${JSON.stringify(agents)}, ${JSON.stringify(running)});
out.push((await step({ at: Date.now() - 60000, acted: false })).ticked, (await step({ at: Date.now() - 6 * 60000, acted: false })).ticked);
console.log(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: sb.env, encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    // ticked (busy: nothing acted); then gone - seen at once, so no tick; then running again but backing off; 6 min later a tick
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)), [true, false, false, false, true]);
  } finally { sb.cleanup(); }
});

test("watch stops itself 8 days after its start even while a source is active", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const r = watch(sb, "--once", "--started", String(Date.now() - 8 * DAY - MIN));
    assert.equal(r.out, "watch: stopped - 8 days since its start - the next tick restarts it if it is still needed\n");
  } finally { sb.cleanup(); }
});

test("the tick starts the watcher while a source is active over an open lane, or a lane waits for its resume; at most once a minute", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "R", id: "R@1", branch: "r", sid: "R-s1", mode: "bg", bg_id: "bg-R", supersedes: null });
    setAgents(sb, [{ id: "bg-R", sessionId: "R-s1", name: "R", status: "running" }]);
    assert.doesNotMatch(coordRun(sb, ["tick"]).out, /watcher/); // no source: not needed
    manual(sb);
    assert.match(coordRun(sb, ["tick", "--dry-run"]).out, /^would start the watcher \(a pause is active\)$/m);
    assert.equal(fs.existsSync(path.join(sb.coord, "watch-start.json")), false);
    assert.match(coordRun(sb, ["tick"]).out, /^watcher started \(a pause is active\)$/m); // HL_NO_SPAWN: recorded only
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "watch-start.json"), "utf8")).by, "tick");
    assert.doesNotMatch(coordRun(sb, ["tick"]).out, /watcher/); // started under a minute ago
  } finally { sb.cleanup(); }
});

test("one watcher at a time: a live holder keeps the lock; a dead holder's lock is taken; --stop with none running says so", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  try {
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "watch.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, start: startOf(holder.pid), at: new Date().toISOString() }));
    assert.equal(watch(sb, "--once").out, "watch: another watcher runs\n");
    const r = watch(sb, "--stop");
    assert.equal(r.out, `watch: stopped ${holder.pid}\n`);
    for (let i = 0; i < 50 && alive(holder.pid); i++) sleep(100);
    assert.equal(alive(holder.pid), false);
    fs.writeFileSync(lock, JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid, start: new Date().toISOString(), at: new Date().toISOString() }));
    assert.equal(watch(sb, "--once").out, "watch: stopped - nothing is paused or waiting to resume\n"); // the dead holder's lock was taken
    assert.equal(watch(sb, "--stop").out, "watch: no watcher running\n");
  } finally { try { holder.kill(); } catch {} sb.cleanup(); }
});

// Task 14 carried minors (coord.mjs pauseNow, goal-gate's every-Stop call): a cheap existence check first, and an SDK / -p
// run is never recorded in the pause manifest.
const pauseNowIn = (sb, env = {}) => {
  const script = `const C = await import(${JSON.stringify(pathToFileURL(COORD_MJS).href)}); console.log(JSON.stringify(await C.pauseNow({ session_id: "hand-s1", cwd: "/w" }, process.env)));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
};
test("pauseNow with no pause state is not paused and reads no pause files; a stale pace.json alone is not a pause", () => {
  const sb = sandbox();
  try {
    assert.deepEqual(pauseNowIn(sb), { paused: false, reason: null });
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated: Date.now() - DAY, claude: { state: "hold", ahead: 22, since: 5 } }));
    assert.deepEqual(pauseNowIn(sb), { paused: false, reason: null });
    assert.equal(fs.existsSync(path.join(sb.coord, "pause", "seen")), false);
  } finally { sb.cleanup(); }
});

test("pauseNow records a paused hand-opened session, but not an SDK / -p run (sdk-cli)", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const seen = path.join(sb.coord, "pause", "seen");
    assert.equal(pauseNowIn(sb, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).paused, true);
    assert.equal(fs.existsSync(seen), false, "an sdk-cli run is not recorded");
    assert.equal(pauseNowIn(sb, { CLAUDE_CODE_ENTRYPOINT: "cli" }).paused, true);
    assert.deepEqual(fs.readdirSync(seen), ["hand-s1.json"]);
  } finally { sb.cleanup(); }
});
