// Task 6b leak fixes: claude spawned without a shell (L1), a hung tick holder (L2), sessions a dead launcher left
// untracked (L3), growing files and handles (L5-L7), orphaned processes (L9).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, sessionLine, appendLine, setAgents, coordRun, launchLane, commitIn, writeDone, writeTranscript, tx, LAUNCH } from "./helpers.mjs";
import * as V from "../live.mjs";
import * as L from "../recover-lib.mjs";

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LIVE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "live.mjs")).href;
const RECOVER = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "recover.mjs")).href;
const fwd = (p) => p.split(path.sep).join("/");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const raw = (sb) => sb.registry(); // every line, {starting} lines included
const runEnv = (sb, env, ...a) => { const r = spawnSync(process.execPath, [LAUNCH, ...a], { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 180000 }); return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") }; };
// Run code against live.mjs in a child with the sandbox env: it reads the sandbox's files, never the real ones.
function inLive(sb, code, env = {}) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const V = await import(${JSON.stringify(LIVE)});\n${code}`], { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: (r.stdout || "").trim(), err: r.stderr || "" };
}
const exited = (child, ms = 15000) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done(true);
  const t = setTimeout(() => done(false), ms);
  child.once("exit", () => { clearTimeout(t); done(true); });
});

// ---------- L1 ----------
test("L1: exeFromWhere takes the first .exe line of where.exe's output, or null", () => {
  assert.equal(V.exeFromWhere("C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\nC:\\bin\\claude.exe\r\n"), "C:\\bin\\claude.exe");
  assert.equal(V.exeFromWhere("C:\\a\\claude.EXE\nC:\\b\\claude.exe\n"), "C:\\a\\claude.EXE");
  assert.equal(V.exeFromWhere("  C:\\with space\\claude.exe  \r\n"), "C:\\with space\\claude.exe");
  assert.equal(V.exeFromWhere("C:\\npm\\claude.cmd\r\n"), null);
  assert.equal(V.exeFromWhere(""), null);
  assert.equal(V.exeFromWhere(null), null);
});

test("L1: a claude spawn uses claude.exe without a shell; the .cmd fallback passes ONE command string (no DEP0190)", () => {
  assert.deepEqual(V.claudeSpawn(["agents", "--json"], { exe: "C:/bin/claude.exe" }), ["C:/bin/claude.exe", ["agents", "--json"], { shell: false }]);
  assert.deepEqual(V.claudeSpawn(["stop", "a b"], { exe: null }), ['claude "stop" "a b"', [], { shell: true }]);
  const sb = sandbox();
  try { // the fallback's shape through a real shell (echo stands in for claude): no args array, so Node warns nothing
    const r = inLive(sb, `const { spawnSync } = await import("node:child_process");
const [f, a, o] = V.claudeSpawn(["x y"], { exe: null });
console.log(spawnSync("echo" + f.slice("claude".length), a, { ...o, encoding: "utf8" }).stdout.trim());`);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /x y/);
    assert.doesNotMatch(r.err, /DEP0190|Warning/);
  } finally { sb.cleanup(); }
});

test("L1: claude agents runs only for a background session - a window entry, status and the tick never consult it", () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.env.HL_AGENTS_JSON, "not json"); // any agents-list call fails, and says so
    const why = (e) => inLive(sb, `V.sessionState(${JSON.stringify(e)}); console.log(JSON.stringify(V.probeWhy()));`);
    let r = why({ id: "w@1", name: "w", mode: "window", session_id: "s-w" });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "null");
    r = why({ id: "b@1", name: "b", mode: "bg", bg_id: "bg-b", session_id: "s-b" });
    assert.equal(r.out, JSON.stringify("claude agents --json is not JSON"));
    // A registry with only window entries: no agents-list failure anywhere in status or tick output.
    sessionLine(sb, { name: "W1", sid: "s-w1", branch: "w1", launched_at: new Date().toISOString() }); // no pid file yet: unknown
    sessionLine(sb, { name: "W2", sid: "s-w2", branch: "w2", group: "g1" }); // no pid recorded: gone
    const t = tick(sb);
    assert.equal(t.code, 0, t.err);
    assert.match(t.out, /^unknown W1: liveness unknown \(starting \(no pid file yet\)\) - no action$/m);
    const s = sb.run("status", "--group", "g1");
    assert.equal(s.code, 0, s.err);
    for (const o of [t.out, t.err, s.out, s.err]) assert.doesNotMatch(o, /claude agents|HL_AGENTS_JSON/);
  } finally { sb.cleanup(); }
});

// ---------- L2 ----------
// A sleeping node child and the start time the OS reports for it (what the tick reads back).
function sleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  return { child, start: V.procInfo([child.pid])?.get(child.pid)?.start };
}
test("L2: a hung tick (lock > 10 min old, live holder, matching start) is killed, then the tick runs", { skip: process.platform !== "win32" }, async () => {
  const sb = sandbox(), { child, start } = sleeper();
  try {
    assert.ok(start, "the child's start time");
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "tick.lock"), at = iso(11 * MIN);
    fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start, at }));
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^tick: killed hung tick ${child.pid} \\(lock held since ${esc(at)}\\)$`, "m"));
    assert.match(fs.readFileSync(path.join(sb.coord, "last-tick.txt"), "utf8"), new RegExp(`^tick: killed hung tick ${child.pid} `, "m"));
    assert.equal(await exited(child), true, "the hung holder exited");
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).last_run)); // the tick ran
    assert.equal(raw(sb).length, 0); // the tick's own process is not a session: nothing in the registry
    assert.equal(fs.existsSync(lock), false);
  } finally { child.kill(); sb.cleanup(); }
});

test("L2: an old lock whose holder's start time does not match (beyond 2 s) or cannot be read, or whose age cannot be read, is reclaimed, its process never killed", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox(), { child, start } = sleeper();
  try {
    assert.ok(start, "the child's start time");
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "tick.lock"), off = (ms) => new Date(Date.parse(start) + ms).toISOString();
    const cases = [[off(-HOUR), iso(11 * MIN), {}], [off(HOUR), iso(11 * MIN), {}], [start, iso(11 * MIN), { HL_FAKE_PROBE: "fail" }],
      [start, "not-a-date", {}], // a lock whose age cannot be read is never judged hung
      [off(-5000), iso(11 * MIN), {}]]; // within the reclaim's 10 s PID-reuse tolerance, beyond the kill's 2 s
    for (const [s, at, env] of cases) {
      fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: s, at }));
      const r = coordRun(sb, ["tick"], { env });
      assert.equal(r.code, 0, r.err);
      assert.doesNotMatch(r.out, /killed hung tick|another tick holds/, `${s} ${at}`);
      assert.equal(fs.existsSync(lock), false, `${s} ${at}`); // reclaimed, then released
      assert.equal(V.pidAlive(child.pid), true, `${s} ${at}`);
    }
  } finally { child.kill(); sb.cleanup(); }
});

test("L2: a hung holder killed, then another tick takes the lock first: skipped, and last-tick.txt still records the kill", { skip: process.platform !== "win32" }, async () => {
  const sb = sandbox(), { child, start } = sleeper();
  try {
    assert.ok(start, "the child's start time");
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "tick.lock"), JSON.stringify({ pid: child.pid, start, at: iso(11 * MIN) }));
    // Another tick wins the race between the reclaim and this tick's own create: its fresh lock (here: this process's
    // pid) appears just before the second exclusive create.
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const fs = (await import("node:fs")).default, V = await import(${JSON.stringify(LIVE)}), R = await import(${JSON.stringify(RECOVER)});
const orig = fs.writeFileSync; let n = 0;
fs.writeFileSync = function (f, d, o) { if (o?.flag === "wx" && String(f).endsWith("tick.lock") && ++n === 2) orig.call(fs, f, JSON.stringify({ pid: process.pid, start: V.selfStart(), at: V.now() })); return orig.apply(fs, arguments); };
console.log(R.tick().join("\\n"));`], { env: sb.env, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const kill = new RegExp(`^tick: killed hung tick ${child.pid} `, "m"), skipped = /^tick: another tick holds tick\.lock - skipped$/m;
    assert.match(r.stdout, kill); assert.match(r.stdout, skipped);
    const last = fs.readFileSync(path.join(sb.coord, "last-tick.txt"), "utf8");
    assert.match(last, kill); assert.match(last, skipped);
    assert.equal(await exited(child), true, "the hung holder exited");
    assert.equal(fs.existsSync(path.join(sb.coord, "tick.json")), false); // this tick did not run
  } finally { child.kill(); sb.cleanup(); }
});

// ---------- L3 ----------
test("L3: a launch appends {starting} right before its launch line - window, bg and --resume, HL_NO_SPAWN included", () => {
  const sb = sandbox();
  try {
    let r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "W", "--model", "opus", "--effort", "high");
    assert.equal(r.code, 0, r.err);
    let [s, e] = raw(sb);
    assert.deepEqual(Object.keys(s), ["starting", "name", "pid_file", "at"]); // a lone session: no group, as event lines
    assert.equal(s.starting, e.session_id); assert.equal(s.name, "W"); assert.equal(s.pid_file, e.pid_file); assert.ok(Date.parse(s.at));
    assert.equal(e.name, "W"); assert.ok(e.launched_at); assert.equal("starting" in e, false);
    r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--group", "g1", "--model", "opus", "--effort", "high", "--mode", "bg");
    assert.equal(r.code, 0, r.err);
    [s, e] = raw(sb).slice(2);
    assert.deepEqual(s, { starting: null, name: "B", group: "g1", pid_file: null, at: s.at });
    assert.equal(e.name, "B"); assert.equal(e.mode, "bg");
    sessionLine(sb, { name: "R", sid: "s-r", branch: "r" });
    r = sb.run("--resume", "s-r");
    assert.equal(r.code, 0, r.err);
    [s, e] = raw(sb).slice(-2);
    assert.equal(s.starting, "s-r"); assert.equal(s.name, "R"); assert.equal(s.pid_file, e.pid_file);
    assert.equal(e.resumed_from, "R@1"); assert.equal(raw(sb).length, 7); // 2 + 2 + R's own launch line + 2
  } finally { sb.cleanup(); }
});

test("L3: startsWithoutLaunch - a later launch line of the name (and session id, when known) tracks a {starting} line", () => {
  const now = Date.parse("2026-01-01T01:00:00Z"), at = (m) => new Date(now - m * MIN).toISOString();
  const S = (name, starting, m = 5) => ({ starting, name, pid_file: null, at: at(m) }), E = (name, session_id) => ({ id: `${name}@x`, name, launched_at: at(1), session_id });
  const names = (lines) => L.startsWithoutLaunch(lines, now, 3 * MIN).map((o) => o.name);
  assert.deepEqual(names([S("A", "s1"), E("A", "s1"), S("B", null), E("B", "s9"), S("C", "s3")]), ["C"]);
  assert.deepEqual(names([E("A", "s1"), S("A", "s1")]), ["A"]); // a launch line before it is an older launch's
  assert.deepEqual(names([S("A", "s1"), E("A", "s2")]), ["A"]); // another session of the same name
  assert.deepEqual(names([S("A", "s1", 2), S("B", null, 4)]), ["B"]); // younger than 3 min: still starting
  assert.deepEqual(names([S("A", null), { closed: "A", id: "A@x", at: at(1) }, { stop_requested: "A@x", name: "A", at: at(1) }]), ["A"]); // event lines never track it
});

// A {starting} line a launcher left behind. window: its pid file path is recorded; pid: the pid file's content (null: no file).
function startingLine(sb, { name, sid = null, group, ageMs = 4 * MIN, window = true, pid = null }) {
  const f = window ? path.join(sb.reg, "pids", `${name}.pid`) : null;
  if (f && pid != null) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, pid); }
  appendLine(sb, { starting: sid, name, ...(group ? { group } : {}), pid_file: f && fwd(f), at: iso(ageMs) });
}
const untrackedOf = (out) => out.split("\n").filter((l) => l.startsWith("UNTRACKED "));
const UT = (name, pid, state) => `UNTRACKED ${name}: launcher died before registering it - pid ${pid} ${state}`;

test("L3: status and the tick report a {starting} line with no launch line after 3 min as UNTRACKED, report-only; unknown is printed", () => {
  const sb = sandbox();
  try {
    startingLine(sb, { name: "U", sid: "s-u", pid: `${process.pid} ${new Date().toISOString()}` }); // probe fails below: unknown
    startingLine(sb, { name: "T", sid: "s-t", pid: `${process.pid} x` }); sessionLine(sb, { name: "T", sid: "s-t", branch: "t" }); // tracked
    startingLine(sb, { name: "M", sid: "s-m1" }); sessionLine(sb, { name: "M", sid: "s-m2", branch: "m" }); // another session id: not this one's
    startingLine(sb, { name: "Bt", window: false }); sessionLine(sb, { name: "Bt", mode: "bg", branch: "bt" }); // bg: tracked by its name
    startingLine(sb, { name: "Bu", window: false, group: "g2" }); // bg, never registered: no pid to probe
    startingLine(sb, { name: "Y", sid: "s-y", ageMs: MIN }); // younger than 3 min: still starting
    startingLine(sb, { name: "Old", sid: "s-o", ageMs: 25 * HOUR }); // no pid file after 24 h: nothing
    startingLine(sb, { name: "OldBg", window: false, ageMs: 25 * HOUR });
    const want = [UT("U", process.pid, "unknown"), UT("M", "?", "gone"), UT("Bu", "?", "unknown")];
    const before = raw(sb).length, env = { HL_FAKE_PROBE: "fail" };
    const s = runEnv(sb, env, "status", "--group", "g1");
    assert.equal(s.code, 0, s.err);
    assert.deepEqual(untrackedOf(s.out), want);
    const t = coordRun(sb, ["tick"], { env });
    assert.equal(t.code, 0, t.err);
    assert.deepEqual(untrackedOf(t.out), want);
    assert.equal(raw(sb).length, before); // report-only: nothing closed, stopped or killed
    assert.deepEqual(untrackedOf(sb.run("status", "--group", "g1").out).slice(1), want.slice(1)); // tracked ones never show
  } finally { sb.cleanup(); }
});

test("L3: an UNTRACKED window whose host still runs reads running and is never touched; a gone one stops showing after 24 h", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const host = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 120"], { stdio: "ignore", windowsHide: true });
  try {
    const start = V.procInfo([host.pid])?.get(host.pid)?.start, dead = spawnSync(process.execPath, ["-e", ""]).pid;
    assert.ok(start, "the host's start time");
    startingLine(sb, { name: "R", sid: "s-r", pid: `${host.pid} ${start}` });
    startingLine(sb, { name: "G", sid: "s-g", pid: `${dead} ${new Date().toISOString()}` });
    startingLine(sb, { name: "ROld", sid: "s-ro", ageMs: 25 * HOUR, pid: `${host.pid} ${start}` }); // still running: still shown
    startingLine(sb, { name: "GOld", sid: "s-go", ageMs: 25 * HOUR, pid: `${dead} ${new Date().toISOString()}` }); // gone after 24 h: nothing
    const want = [UT("R", host.pid, "running"), UT("G", dead, "gone"), UT("ROld", host.pid, "running")];
    assert.deepEqual(untrackedOf(sb.run("status", "--group", "g1").out), want);
    const before = raw(sb).length, t = tick(sb);
    assert.equal(t.code, 0, t.err);
    assert.deepEqual(untrackedOf(t.out), want);
    assert.equal(raw(sb).length, before);
    assert.equal(V.pidAlive(host.pid), true); // report-only: never killed
  } finally { host.kill(); sb.cleanup(); }
});

// Two runs differ only in temp paths, times and random ids: mask those, nothing else.
function norm(sb, s) {
  let t = String(s);
  const t1 = sb.tmp, variants = [t1, t1.toLowerCase(), fwd(t1), fwd(t1).toLowerCase()].flatMap((v) => [v.replace(/\\/g, "\\\\"), v]);
  for (const v of [...new Set(variants)].sort((a, b) => b.length - a.length)) t = t.split(v).join("<tmp>");
  return t.replace(/\d{4}-\d\d-\d\dT\d\d[:-]\d\d[:-]\d\d(?:[.-]\d+)?Z/g, "<t>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
}
test("L3: a {starting} line before every launch line changes nothing - status, tick, merge drain and launch are byte-identical", () => {
  const flow = (withStarting) => {
    const sb = sandbox();
    try {
      assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
      const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
      writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
      commitIn(sb, b, { "b.txt": "B\n" }, "B work");
      sessionLine(sb, { name: "L", sid: "s-l", mode: "bg", bg_id: "bg-L", branch: "l", coord: undefined }); // report-only loop
      setAgents(sb, [{ id: "bg-L", sessionId: "s-l", name: "L", status: "running" }]);
      let t = tx({ start: Date.now() - 10 * MIN }).user("go");
      for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
      writeTranscript(sb, sb.repo, "s-l", t.entries());
      // The same registry without any {starting} line, or with one 10 min old before every launch line.
      const lines = [];
      for (const o of raw(sb).filter((x) => !("starting" in x))) {
        if (withStarting && o.launched_at) lines.push({ starting: o.session_id ?? null, name: o.name, ...(o.group ? { group: o.group } : {}), pid_file: o.pid_file ?? null, at: iso(10 * MIN) });
        lines.push(o);
      }
      fs.writeFileSync(path.join(sb.reg, "sessions.jsonl"), lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
      const res = [sb.run("status", "--group", "g1", "--no-merge"), tick(sb), sb.run("merge", "--group", "g1"), sb.run("status", "--group", "g1"),
        sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "opus", "--effort", "high", "--worktree", "lane-B", "--group", "g1")];
      return { res: res.map((r) => ({ code: r.code, out: norm(sb, r.out), err: norm(sb, r.err) })), added: raw(sb).slice(lines.length).map((o) => norm(sb, JSON.stringify(o))) };
    } finally { sb.cleanup(); }
  };
  const plain = flow(false), starting = flow(true);
  assert.deepEqual(starting, plain);
  const all = JSON.stringify(plain);
  assert.match(all, /merged A -> int-g1/); assert.match(all, /report-only L: same call x5/); assert.match(all, /"generation\\":2/); // the flows ran
});

// ---------- L5 / L6 / L7 ----------
test("L5: writeAtomic removes its .tmp when the rename fails, then throws", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hl-wa-"));
  try {
    const target = path.join(d, "x.json");
    fs.mkdirSync(target); // a rename onto a directory fails
    assert.throws(() => V.writeAtomic(target, "{}"), (e) => typeof e.code === "string");
    assert.deepEqual(fs.readdirSync(d), ["x.json"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("L5: a tick prunes exactly the old prunable files once an hour; --dry-run only lists them", () => {
  const sb = sandbox();
  try {
    const at = new Date().toISOString(), OLD = 15 * DAY;
    const put = (dir, rel, ageMs = 0, text = "{}") => {
      const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
      if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); }
      return f;
    };
    sessionLine(sb, { name: "C", sid: "sid-c", mode: "bg", bg_id: "bg-c", branch: "c" }); appendLine(sb, { closed: "C", id: "C@1", at });
    sessionLine(sb, { name: "G", sid: "sid-g", mode: "bg", bg_id: "bg-g", branch: "g" }); // not listed by claude agents: gone
    sessionLine(sb, { name: "R", sid: "sid-r", mode: "bg", bg_id: "bg-r", branch: "r" }); // listed: running
    setAgents(sb, [{ id: "bg-r", sessionId: "sid-r", name: "R", status: "running" }]);
    sessionLine(sb, { name: "U", sid: "sid-u", branch: "u", launched_at: at }); // a window with no pid file yet: unknown
    const gone = [
      put(sb.coord, "restarts/A-2026-01-01T00-00-00-000Z.log", OLD),
      put(sb.coord, "alerts/sent-2026-01-01T00-00-00-000Z-A.json", OLD),
      put(sb.coord, "sessions/sid-c.json", OLD),
      put(sb.coord, "sessions/sid-g.json", OLD),
      put(sb.coord, "looping.json.123.abcdef12.tmp", 2 * HOUR),
      put(sb.coord, "sessions/sid-r.json.123.abcdef12.tmp", 2 * HOUR),
      put(sb.reg, "session-hooks.json.123.abcdef12.tmp", 2 * HOUR),
      put(sb.reg, "stops/A.ladder.stop.json.123.abcdef12.tmp", 2 * HOUR),
    ];
    const kept = [
      put(sb.coord, "restarts/A-new.log"),
      put(sb.coord, "alerts/sent-new-A.json"),
      put(sb.coord, "alerts/2026-01-01T00-00-00-000Z-A.json", OLD), // unclaimed: an alert never dies silently
      put(sb.coord, "alerts/claimed-sid-1-1767225600000-2026-01-01T00-00-00-000Z-B.json", OLD),
      // its entries older than alert_repeat_hours (6 h) can no longer suppress an alert: they go, the file stays
      put(sb.coord, "alerts/index.json", OLD, JSON.stringify({ "A@1|a:main:x": iso(7 * HOUR), "orphans|4242": iso(7 * HOUR), "B@1|b:Bash": iso(HOUR) })),
      put(sb.coord, "incidents/A-1.md", OLD, "# Incident A-1\n"), // never pruned
      put(sb.coord, "sessions/sid-r.json", OLD), // running
      put(sb.coord, "sessions/sid-u.json", OLD), // unknown: never pruned
      put(sb.coord, "sessions/sid-none.json", OLD), // no launch line to judge it by
      put(sb.coord, "sessions/sid-new.json"),
      put(sb.coord, "fresh.json.123.abcdef12.tmp"),
      // .tmp files writeAtomic did not name (<file>.<pid>.<8 hex>.tmp) are never ours to remove, however old
      put(sb.reg, "notes.tmp", 2 * HOUR), put(sb.reg, "stops/x.stop.json.tmp", 2 * HOUR), put(sb.coord, "x.json.1.ABCDEF12.tmp", 2 * HOUR),
    ];
    const lp = path.join(sb.coord, "looping.json");
    fs.writeFileSync(lp, JSON.stringify({ "sid-c": { a1: { key: "k" } }, "sid-u": { a2: { key: "k" } } }));
    let r = tick(sb, "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.split("\n").filter((l) => l.startsWith("would prune ")).sort(),
      [...gone.map((f) => `would prune ${fwd(f)}`), "would prune looping.json entry sid-c (its session is closed)",
        "would prune alerts/index.json entry A@1|a:main:x (older than alert_repeat_hours)", "would prune alerts/index.json entry orphans|4242 (older than alert_repeat_hours)"].sort());
    for (const f of [...gone, ...kept]) assert.ok(fs.existsSync(f), f);
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^prune: removed 8 file\(s\) \(restart logs 1, sent alerts 1, session states 2, tmp files 4\), dropped 1 looping\.json entry and 2 alerts\/index\.json entries$/m);
    for (const f of gone) assert.equal(fs.existsSync(f), false, f);
    for (const f of kept) assert.ok(fs.existsSync(f), f);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(lp, "utf8"))), ["sid-u"]);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", "index.json"), "utf8"))), ["B@1|b:Bash"]);
    const again = put(sb.coord, "restarts/B-2026-01-01T00-00-00-000Z.log", OLD);
    r = tick(sb); // within the hour: no prune
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /prune/);
    assert.ok(fs.existsSync(again));
  } finally { sb.cleanup(); }
});

// ---------- L9 ----------
test("L9: orphans() keeps big python/node/pytest/chrome processes whose parent is gone or newer, biggest first", () => {
  const t0 = Date.now(), P = (pid, ppid, name, mb, created = t0) => ({ pid, ppid, name, mb, created });
  const pids = (procs, o) => L.orphans(procs, o).map((p) => p.pid);
  assert.deepEqual(pids([P(1, 99, "Python.EXE", 400), P(2, 99, "pythonw.exe", 400), P(3, 99, "node", 400), P(4, 99, "pytest.exe", 400),
    P(5, 99, "chrome.exe", 400), P(6, 99, "notepad.exe", 4000), P(7, 99, "nodejs.exe", 4000)]).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(pids([P(1, 99, "node", 299), P(2, 99, "node", 300)]), [2]);
  assert.deepEqual(pids([P(1, 99, "node", 250)], { minMb: 200 }), [1]);
  assert.deepEqual(pids([P(10, 1, "node", 500), P(1, 0, "cmd.exe", 5, t0 - 1000)]), []); // its parent runs
  assert.deepEqual(pids([P(10, 1, "node", 500), P(1, 0, "cmd.exe", 5, t0 + 1000)]), [10]); // pid 1 was reused after it started
  assert.deepEqual(pids([P(10, 1, "node", 500, null), P(1, 0, "cmd.exe", 5, t0 + 1000)]), []); // no start time: only a missing parent counts
  assert.deepEqual(pids([P(1, 99, "node", 400), P(2, 99, "chrome", 900), P(3, 99, "python", 600)]), [2, 3, 1]);
  assert.deepEqual(L.orphans(null), []);
});

test("L9: the tick reports an orphan once an hour (orphans.json, its line, one alert), status shows a fresh report; re-alerted only after alert_repeat_hours", () => {
  const sb = sandbox();
  try {
    const t0 = Date.now() - HOUR;
    fs.writeFileSync(sb.env.HL_FAKE_PROCS, JSON.stringify([
      { pid: 4242, ppid: 999, name: "python.exe", mb: 1126, created: t0 }, // its parent is not running: an orphan
      { pid: 5151, ppid: 6000, name: "node.exe", mb: 800, created: t0 }, // its parent runs: not one
      { pid: 6000, ppid: 1, name: "WindowsTerminal.exe", mb: 90, created: t0 - HOUR },
    ]));
    const line = new RegExp(`^${esc(`ORPHAN python.exe pid 4242 1126 MB (parent 999 gone) since ${new Date(t0).toISOString()}`)}$`, "m");
    const alerts = () => { const d = path.join(sb.coord, "alerts"); return fs.readdirSync(d).filter((f) => /^\d.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))); };
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, line);
    const rep = path.join(sb.coord, "orphans.json"), o = JSON.parse(fs.readFileSync(rep, "utf8"));
    assert.deepEqual(o.orphans.map((x) => x.pid), [4242]); assert.ok(Date.parse(o.at));
    assert.deepEqual(alerts().map((a) => a.text), ["Orphaned processes hold 1126 MB: python.exe 4242 1126 MB"]);
    assert.match(sb.run("status", "--group", "g1").out, line);
    assert.doesNotMatch(tick(sb).out, /ORPHAN/); // at most once an hour
    const hk = path.join(sb.coord, "housekeeping.json"), hourAgo = () => { const j = JSON.parse(fs.readFileSync(hk, "utf8")); j.orphans_at = iso(2 * HOUR); fs.writeFileSync(hk, JSON.stringify(j)); };
    hourAgo();
    r = tick(sb);
    assert.match(r.out, line); assert.equal(alerts().length, 1); // scanned again, alerted once within alert_repeat_hours
    const ix = path.join(sb.coord, "alerts", "index.json"), idx = JSON.parse(fs.readFileSync(ix, "utf8"));
    assert.ok(Date.parse(idx["orphans|4242"]));
    idx["orphans|4242"] = iso(7 * HOUR); fs.writeFileSync(ix, JSON.stringify(idx));
    hourAgo(); tick(sb);
    assert.equal(alerts().length, 2);
    fs.writeFileSync(rep, JSON.stringify({ ...o, at: iso(3 * HOUR) })); // a stale report is not shown
    assert.doesNotMatch(sb.run("status", "--group", "g1").out, /ORPHAN/);
  } finally { sb.cleanup(); }
});
