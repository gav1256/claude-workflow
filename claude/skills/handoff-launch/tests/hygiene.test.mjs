// Batch A in the tick: closes follow the supersedes chain (Part 1), background tasks keep a window (Part 2), windows
// whose claude is gone (Part 3), the union restart guard's co-tenant alert, lanes.json (Part 5) and the Playwright reaper
// (Part 8). All in the stage-2 sandbox; windows are hidden powershell stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, writeTranscript, setAgents, coordRun, tx, host, emptyHost, jobHost, hasPython, alive, LAUNCH } from "./helpers.mjs";
import { key } from "../merge-lib.mjs";
import { CAUSE_PLACEHOLDER } from "../recover-lib.mjs";

const MIN = 60000, win = process.platform !== "win32";
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const idle = (start = Date.now() - 40 * MIN) => tx({ start }).user("go").call("Bash", { command: "x" }).say("handed off").turnDone().entries();
const bgRun = (sb, list) => setAgents(sb, list.map(([id, sid, name]) => ({ id, sessionId: sid, name, status: "running" })));

test("the tick closes a window only when its own successor runs: a co-tenant on the same checkout never closes it", { skip: win }, () => {
  const sb = sandbox();
  const h = host();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", gen: 1, sid: "a-s1", host: h, supersedes: null });
    writeTranscript(sb, sb.repo, a.session_id, idle());
    // A launch that landed on A's checkout without replacing it (--force): same repo + branch, newer generation.
    sessionLine(sb, { name: "T", id: "T@2", gen: 2, sid: "t-s2", mode: "bg", bg_id: "bg-T", supersedes: null, launched_at: new Date(Date.now() - 3600e3).toISOString() });
    bgRun(sb, [["bg-T", "t-s2", "T"]]);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /close[ds]? A /);
    assert.equal(alive(h.pid), true);
    // Its relay (supersedes A@1) runs: now A is superseded.
    sessionLine(sb, { name: "A", id: "A@3", gen: 3, sid: "a-s3", mode: "bg", bg_id: "bg-A3", supersedes: "A@1", launched_at: new Date(Date.now() - 1800e3).toISOString() });
    bgRun(sb, [["bg-T", "t-s2", "T"], ["bg-A3", "a-s3", "A"]]);
    r = tick(sb);
    assert.match(r.out, /^closed A \(gen 1\): superseded by generation 3: idle \d+ min$/m);
    assert.equal(alive(h.pid), false);
  } finally { h.kill(); sb.cleanup(); }
});

test("an idle superseded window with a background shell task running is kept until the task's notification", { skip: win }, () => {
  const sb = sandbox();
  const h = host();
  try {
    const x = sessionLine(sb, { name: "X", id: "X@1", gen: 1, sid: "x-s1", host: h, supersedes: null });
    const t = idle(), res = t.findIndex((o) => Array.isArray(o.message?.content) && o.message.content[0]?.type === "tool_result");
    t[res].toolUseResult = { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "b1" }; // run_in_background
    const f = writeTranscript(sb, sb.repo, x.session_id, t);
    sessionLine(sb, { name: "X", id: "X@2", gen: 2, sid: "x-s2", mode: "bg", bg_id: "bg-X2", supersedes: "X@1", launched_at: new Date(Date.now() - 3600e3).toISOString() });
    bgRun(sb, [["bg-X2", "x-s2", "X"]]);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /close[ds]? X /);
    assert.equal(alive(h.pid), true);
    // The task's notification arrives (a queue-operation enqueue, as Claude Code writes it): now the window is idle.
    fs.appendFileSync(f, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(Date.now() - 30 * MIN).toISOString(),
      content: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>" }) + "\n");
    fs.utimesSync(f, new Date(Date.now() - 30 * MIN), new Date(Date.now() - 30 * MIN));
    r = tick(sb);
    assert.match(r.out, /^closed X \(gen 1\): superseded by generation 2: idle \d+ min$/m);
  } finally { h.kill(); sb.cleanup(); }
});

test("windows whose claude is gone: a dead start alerts once, shows in status and closes after dead_close_min; an exited one closes at once; claude or a user's job keeps a window", { skip: win }, () => {
  const sb = sandbox();
  const hosts = [emptyHost(), emptyHost(), host(), ...(hasPython() ? [jobHost()] : [])];
  try {
    const old = Date.now() - 40 * MIN;
    const w = sessionLine(sb, { name: "W", id: "W@1", group: "g9", branch: "w", sid: "w-s1", host: hosts[0], supersedes: null }); // no transcript
    // A dead start leaves only metadata records, never an assistant one.
    writeTranscript(sb, sb.repo, w.session_id, [{ type: "mode", mode: "default", timestamp: new Date(old).toISOString() }]);
    fs.utimesSync(path.join(sb.env.HL_PROJECTS_DIR, path.resolve(sb.repo).replace(/[^a-zA-Z0-9]/g, "-"), `${w.session_id}.jsonl`), new Date(old), new Date(old));
    const e = sessionLine(sb, { name: "E", id: "E@1", group: "g9", branch: "e", sid: "e-s1", host: hosts[1], supersedes: null });
    const ef = writeTranscript(sb, sb.repo, e.session_id, idle(old)); fs.utimesSync(ef, new Date(old), new Date(old));
    sessionLine(sb, { name: "K", id: "K@1", group: "g9", branch: "k", sid: "k-s1", host: hosts[2], supersedes: null }); // claude runs, no transcript yet
    if (hosts[3]) sessionLine(sb, { name: "J", id: "J@1", group: "g9", branch: "j", sid: "j-s1", host: hosts[3], supersedes: null });
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would alert DEAD START W \(gen 1\) and close its window at /m);
    assert.match(dry.out, /^would close E \(gen 1\): claude exited$/m);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^DEAD START W \(gen 1\): claude exited right after the launch - alert .*\.json$/m);
    assert.match(r.out, /^closed E \(gen 1\): claude exited$/m);
    assert.doesNotMatch(r.out, /[KJ] \(gen 1\)/);
    const alertsDir = path.join(sb.coord, "alerts");
    const texts = fs.readdirSync(alertsDir).filter((f) => /^\d.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(alertsDir, f), "utf8")).text);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^DEAD START: W \(w\): its window is open but claude exited right after the launch at .* UTC\. Read the error in that window, fix it, relaunch\. The coordinator closes the window at .* UTC\.$/);
    assert.equal(alive(hosts[0].pid), true); assert.equal(alive(hosts[1].pid), false); assert.equal(alive(hosts[2].pid), true);
    if (hosts[3]) assert.equal(alive(hosts[3].pid), true);
    r = tick(sb);
    assert.doesNotMatch(r.out, /DEAD START|close[ds]? W/); // one alert per entry; not yet dead_close_min
    // status shows the dead start on W's line while its window is open.
    const ds = sb.registry().find((o) => o.dead_start === w.id);
    assert.ok(ds?.at, "a {dead_start} line for W");
    const st = sb.run("status", "--group", "g9").out;
    assert.ok(st.split("\n").some((l) => l.startsWith("W ") && l.endsWith(`  DEAD-START (since ${ds.at})`)), st);
    assert.doesNotMatch(st, /^[EK] .*DEAD-START/m);
    // dead_close_min after the alert: the guarded no-claude close.
    const reg = path.join(sb.reg, "sessions.jsonl");
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(/("dead_start":"W@1"[^\n]*"at":")[^"]+/, `$1${new Date(Date.now() - 61 * MIN).toISOString()}`));
    r = tick(sb);
    assert.match(r.out, /^closed W \(gen 1\): dead start: no claude in the window since .*$/m);
    assert.equal(alive(hosts[0].pid), false);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

// Fix wave item 1 (spec Part 3): a window whose transcript reads idle can still hold a user's job - claude was /exit-ed
// there and the user runs a test. The guarded close (the tick) and the launch-time close both look below the host first:
// a job without claude keeps the window, and a failed probe below it is no close.
test("an idle superseded window whose claude exited and where the user runs a job is kept by the tick and by the launch-time close", { skip: win || !hasPython() }, () => {
  const sb = sandbox();
  const h = jobHost();
  try {
    const j = sessionLine(sb, { name: "J", id: "J@1", gen: 1, sid: "j-s1", host: h, supersedes: null });
    writeTranscript(sb, sb.repo, j.session_id, idle()); // idle 40 min: the relay handed off, then claude was /exit-ed
    sessionLine(sb, { name: "J", id: "J@2", gen: 2, sid: "j-s2", mode: "bg", bg_id: "bg-J2", supersedes: "J@1", launched_at: new Date(Date.now() - 3600e3).toISOString() });
    bgRun(sb, [["bg-J2", "j-s2", "J"]]);
    const kept = /^skip close of J \(gen 1\): its window runs python\.exe, no claude$/m;
    const dry = tick(sb, "--dry-run");
    assert.equal(dry.code, 0, dry.err); assert.match(dry.out, kept);
    let r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail:below" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^skip close of J \(gen 1\): the process probe below its window failed \(process probe failed \(HL_FAKE_PROBE=fail:below\)\)$/m);
    r = tick(sb);
    assert.equal(r.code, 0, r.err); assert.match(r.out, kept); assert.doesNotMatch(r.out, /close[ds]? J /);
    assert.equal(alive(h.pid), true);
    assert.equal(sb.registry().filter((o) => o.kill_intent || o.closed).length, 0);
    // The launch-time close of J's next relay (chain J@3 -> J@2 -> J@1: J@1 is beyond the direct predecessor). A real
    // launch runs it after its window started; its dry run decides the same way.
    const launch = (env = {}) => {
      const x = spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "J", "--model", "opus", "--effort", "high", "--supersedes", "J@2", "--dry-run"], { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 180000 });
      assert.equal(x.status, 0, x.stderr);
      return JSON.parse(x.stdout).auto_close;
    };
    assert.deepEqual(launch().filter((l) => / J \(gen 1,/.test(l)).map((l) => l.replace(/pid \d+/, "pid N")), ["skip J (gen 1, pid N): its window runs python.exe, no claude - nothing done"]);
    assert.deepEqual(launch({ HL_FAKE_PROBE: "fail:below" }).filter((l) => / J \(gen 1,/.test(l)).map((l) => l.replace(/pid \d+/, "pid N")),
      ["skip J (gen 1, pid N): the process probe below its window failed (process probe failed (HL_FAKE_PROBE=fail:below)) - nothing done"]);
    assert.equal(alive(h.pid), true);
  } finally { h.kill(); sb.cleanup(); }
});

test("a coordinator restart that dies at once is a failed restart: {restart_failed} and {lane_blocked}, LOOP-BLOCKED in status", { skip: win }, () => {
  const sb = sandbox();
  const h = emptyHost();
  try {
    const at = new Date().toISOString();
    const w1 = sessionLine(sb, { name: "W", id: "W@1", group: "g9", branch: "w", gen: 1, sid: "w-s1", supersedes: null });
    appendLine(sb, { incident: w1.id, name: "W", n: 1, path: "x/incidents/W-1.md", signature: "a:main:x", rule: "a", mode: "auto", at });
    appendLine(sb, { kill_intent: w1.id, name: "W", kind: "ladder", at }); appendLine(sb, { closed: "W", id: w1.id, at });
    sessionLine(sb, { name: "W", id: "W@2", group: "g9", branch: "w", gen: 2, sid: "w-s2", host: h, supersedes: w1.id });
    appendLine(sb, { restart: "W", n: 1, kind: "fresh", from: w1.id, handoff: w1.handoff, model: "opus", effort: "high", at }); // the tick writes it after the launch line
    // Fix round 1: a same-name lane of another group with the same incident number - never this lane's incident.
    appendLine(sb, { incident: "W@7", name: "W", group: "g8", n: 1, path: "x/incidents/g8-W-1.md", signature: "a:main:y", rule: "a", mode: "report", at });
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would alert DEAD START W \(gen 2\) and close its window at \S+ - a coordinator restart: would write \{restart_failed\} and \{lane_blocked\}$/m);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^DEAD START W \(gen 2\): claude exited right after the launch - alert /m);
    assert.match(r.out, /^restart of W failed: its window is a dead start - blocked$/m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.restart_failed === "W" && o.from === w1.id && o.n === 1));
    assert.ok(lines.some((o) => o.lane_blocked === "W" && o.group === "g9" && o.incident === "x/incidents/W-1.md"));
    // Alerted exactly like a restart that failed to launch: its incident and ALERT.restartFailed's relaunch hint.
    const alertsDir = path.join(sb.coord, "alerts"), [af] = fs.readdirSync(alertsDir).filter((f) => /^\d.*\.json$/.test(f)), al = JSON.parse(fs.readFileSync(path.join(alertsDir, af), "utf8"));
    assert.equal(al.incident, "x/incidents/W-1.md");
    assert.match(al.text, /^DEAD START: W \(w\): .* It was the coordinator's restart after a loop, so the lane is blocked\. Incident: x\/incidents\/W-1\.md\. Fix it, then: node .+launch\.mjs resume --group g9 --lane W$/);
    assert.match(sb.run("status", "--group", "g9").out, /LOOP-BLOCKED \(incident x\/incidents\/W-1\.md/);
    assert.equal(alive(h.pid), true); // closed only dead_close_min after the alert, or by a relaunch (provenance.test.mjs)
  } finally { h.kill(); sb.cleanup(); }
});

test("the union restart guard: a killed lane next to a running co-tenant is not restarted, and the user is alerted", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", id: "A@1", sid: "a-s1", mode: "bg", bg_id: "bg-A" });
    sessionLine(sb, { name: "T", id: "T@2", gen: 2, sid: "t-s2", mode: "bg", bg_id: "bg-T", supersedes: null });
    bgRun(sb, [["bg-T", "t-s2", "T"]]);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^A killed, not restarted: an open newer launch T shares its checkout - alert .*\.json$/m);
    assert.ok(sb.registry().some((o) => o.restart_skipped === e.id && o.why === "an open newer launch T shares its checkout"));
    assert.equal(sb.registry().filter((o) => o.restart).length, 0);
  } finally { sb.cleanup(); }
});

test("lanes.json: the newest open running or unknown entry per lane, with id, scope, priority and checklist; a --repo tick rewrites only its key", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", id: "A@1", branch: "lane-a", sid: "a-s1", mode: "bg", bg_id: "bg-A", scope: "Stage A", model: "fable", effort: "high", supersedes: null });
    sessionLine(sb, { name: "B", id: "B@1", branch: "lane-b", sid: "b-s1", mode: "bg", bg_id: "bg-B", supersedes: null });
    sessionLine(sb, { name: "C", id: "C@1", branch: "lane-c", sid: "c-s1", mode: "bg", bg_id: "bg-C", supersedes: null }); // not listed: gone
    bgRun(sb, [["bg-A", "a-s1", "A"], ["bg-B", "b-s1", "B"]]);
    assert.equal(tick(sb).code, 0);
    const f = path.join(sb.coord, "lanes.json"), rk = key(sb.repo);
    let j = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.deepEqual(j.repos[rk].map((l) => [l.id, l.name, l.branch, l.scope, l.priority, l.liveness, l.goal]),
      [["A@1", "A", "lane-a", "Stage A", "high", "running", "no GOAL.md"], ["B@1", "B", "lane-b", null, "normal", "running", "no GOAL.md"]]);
    fs.writeFileSync(f, JSON.stringify({ at: j.at, repos: { "c:/elsewhere": [{ id: "Z@1" }], [rk]: [] } }));
    const r = sb.run("watchdog", "--repo", sb.repo, "--stop-looping");
    assert.equal(r.code, 0, r.err);
    j = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.deepEqual(j.repos["c:/elsewhere"], [{ id: "Z@1" }]);
    assert.deepEqual(j.repos[rk].map((l) => l.id), ["A@1", "B@1"]);
  } finally { sb.cleanup(); }
});

test("the Playwright reaper (hourly): kills orphans with Playwright's signature only, and removes stale --isolated profile dirs", () => {
  const sb = sandbox();
  try {
    const old = Date.now() - 5 * 3600e3;
    fs.writeFileSync(sb.env.HL_FAKE_PROCS, JSON.stringify([
      { pid: 9001, ppid: 4, name: "claude.exe", mb: 300, created: old, cmd: "claude" },
      { pid: 9002, ppid: 9001, name: "node.exe", mb: 60, created: old, cmd: "node C:/cfg/mcp-servers/node_modules/@playwright/mcp/cli.js --isolated" },
      { pid: 9003, ppid: 9002, name: "chrome.exe", mb: 200, created: old, cmd: `chrome.exe --remote-debugging-pipe --user-data-dir=${sb.temp}\\playwright_chromiumdev_profile-live` },
      { pid: 9101, ppid: 9999, name: "chrome.exe", mb: 500, created: old, cmd: "chrome.exe --remote-debugging-pipe --user-data-dir=C:\\T\\playwright_chromiumdev_profile-gone" },
      { pid: 9201, ppid: 9998, name: "chrome.exe", mb: 400, created: old, cmd: "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"" },
    ]));
    const mk = (n, ageH) => { const d = path.join(sb.temp, n); fs.mkdirSync(d); const t = new Date(Date.now() - ageH * 3600e3); fs.utimesSync(d, t, t); return d; };
    const stale = mk("playwright_chromiumdev_profile-old", 30), fresh = mk("playwright_chromiumdev_profile-new", 1), used = mk("playwright_chromiumdev_profile-live", 30);
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would kill Playwright orphan chrome\.exe 9101 \(parent 9999 gone\)$/m);
    assert.match(dry.out, /^would remove the stale Playwright profile .*playwright_chromiumdev_profile-old$/m);
    assert.equal(fs.existsSync(stale), true);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^killed Playwright orphan chrome\.exe 9101 \(parent 9999 gone\) \(HL_FAKE_PROCS: nothing really killed\)$/m);
    assert.doesNotMatch(r.out, /Playwright orphan [^\n]*(9002|9003|9201)/);
    assert.match(r.out, /^removed 1 stale Playwright profile dir\(s\) from the temp dir$/m);
    assert.deepEqual([fs.existsSync(stale), fs.existsSync(fresh), fs.existsSync(used)], [false, true, true]);
    assert.match(r.out, /^ORPHAN chrome\.exe pid 9201 400 MB/m); // the user's own Chrome: reported as before, never killed
  } finally { sb.cleanup(); }
});

// ---------- plan-review amendments and carry notes owned by Task 5 ----------

// Amendment 6: HL_FAKE_PROBE=fail:below fails only the host-below probe, so liveness still reads running (lanes.json
// records it) and the gone scan reaches the probe: a failed probe there is no action - no close, no alert.
test("a failed host-below probe in the gone scan: a quiet window whose host is empty is neither closed nor alerted, and its liveness stays running", { skip: win }, () => {
  const sb = sandbox();
  const h = emptyHost();
  try {
    const old = Date.now() - 40 * MIN;
    const e = sessionLine(sb, { name: "Q", id: "Q@1", branch: "q", sid: "q-s1", host: h, supersedes: null });
    const f = writeTranscript(sb, sb.repo, e.session_id, idle(old)); fs.utimesSync(f, new Date(old), new Date(old)); // quiet: claude exited 40 min ago
    const r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail:below" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^skip the gone scan of 1 window\(s\): the process probe below their hosts failed \(process probe failed \(HL_FAKE_PROBE=fail:below\)\) - no action$/m);
    assert.doesNotMatch(r.out, /close[ds]? Q |DEAD START/);
    assert.equal(fs.existsSync(path.join(sb.coord, "alerts")) ? fs.readdirSync(path.join(sb.coord, "alerts")).filter((x) => /^\d/.test(x)).length : 0, 0);
    assert.equal(sb.registry().filter((o) => o.kill_intent || o.closed || o.dead_start).length, 0);
    const lanes = JSON.parse(fs.readFileSync(path.join(sb.coord, "lanes.json"), "utf8")).repos[key(sb.repo)];
    assert.deepEqual(lanes.map((l) => [l.id, l.liveness]), [["Q@1", "running"]]);
    assert.equal(alive(h.pid), true);
    // Control: the same tick with the probe working closes it (claude exited).
    assert.match(tick(sb).out, /^closed Q \(gen 1\): claude exited$/m);
    assert.equal(alive(h.pid), false);
  } finally { h.kill(); sb.cleanup(); }
});

// Carry (Task 3): a fresh coordinator restart passes the lane's effective priority (a hand-set one survives) and the
// killed entry as --supersedes. Amendment 7: the tick's {restart} line carries the entry's group.
const stubLauncher = (sb) => {
  const argvFile = path.join(sb.tmp, "launcher-argv.json"), stub = path.join(sb.tmp, "launcher-stub.cjs");
  fs.writeFileSync(stub, `require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`);
  return { argvFile, stub };
};
const killedLane = (sb, o) => {
  const e = sessionLine(sb, { name: "W", mode: "bg", supersedes: null, ...o });
  const inc = `x/incidents/W-${e.group}-1.md`, at = new Date().toISOString();
  appendLine(sb, { incident: e.id, name: "W", n: 1, path: inc, signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
  appendLine(sb, { kill_intent: e.id, name: "W", kind: "ladder", why: "loop ladder", at });
  return { e, inc };
};

test("a fresh coordinator restart carries --priority <effective> and --supersedes <killed id>; its {restart} line carries the group", () => {
  const sb = sandbox();
  try {
    const { argvFile, stub } = stubLauncher(sb);
    const { e, inc } = killedLane(sb, { id: "W@1", group: "g1", branch: "w1", sid: "w-s1", bg_id: "bg-W1" }); // not listed: the kill went through
    appendLine(sb, { priority: "W", group: "g1", value: "low", at: new Date().toISOString() }); // hand-set after the launch: survives the restart
    const r = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: stub } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted W: fresh \(opus\/high\)$/m);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.deepEqual(argv.slice(argv.indexOf("--recovery"), argv.indexOf("--recovery") + 2), ["--recovery", inc]);
    assert.deepEqual(argv.slice(-4), ["--priority", "low", "--supersedes", e.id]);
    assert.deepEqual(argv.slice(argv.indexOf("--group"), argv.indexOf("--group") + 2), ["--group", "g1"]);
    const rs = sb.registry().filter((o) => o.restart === "W");
    assert.equal(rs.length, 1);
    assert.equal(rs[0].group, "g1");
    assert.equal(rs[0].from, e.id);
  } finally { sb.cleanup(); }
});

test("two groups with a lane of the same name: one group's coordinator restart never makes the other's dead start a failed restart", { skip: win }, () => {
  const sb = sandbox();
  const h = emptyHost();
  try {
    const { stub } = stubLauncher(sb);
    // g2's W: a window whose claude died at its launch (no transcript, empty host), launched by hand - not a restart.
    sessionLine(sb, { name: "W", id: "W@2", gen: 2, group: "g2", branch: "w2", sid: "w-s2", host: h, supersedes: null });
    // g1's W: killed for a loop; this tick restarts it (stub launcher) and appends {restart: "W", group: "g1"} after g2's line.
    const { e } = killedLane(sb, { id: "W@1", group: "g1", branch: "w1", sid: "w-s1", bg_id: "bg-W1" });
    const r = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: stub } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted W: fresh \(opus\/high\)$/m);
    assert.match(r.out, /^DEAD START W \(gen 2\): claude exited right after the launch - alert .*\.json$/m);
    assert.doesNotMatch(r.out, /restart of W failed/);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.restart === "W" && o.group === "g1" && o.from === e.id));
    assert.ok(lines.some((o) => o.dead_start === "W@2" && o.group === "g2"));
    assert.equal(lines.filter((o) => o.restart_failed || o.lane_blocked).length, 0);
    assert.equal(alive(h.pid), true);
  } finally { h.kill(); sb.cleanup(); }
});

// Fix round 1: the previous incident a restart reads (is its Cause filled? if not, one rung up) is the lane's own
// group's - names are unique per group, so a same-name lane of another group with the same incident number never counts.
test("a restart reads its own group's previous incident: another group's same-name lane with a filled Cause never counts", () => {
  const sb = sandbox();
  try {
    const { stub } = stubLauncher(sb);
    const at = new Date().toISOString(), cause = (t) => `# incident\n\n## Cause\n${t}\n`;
    const p1 = path.join(sb.tmp, "W-1.md"), p8 = path.join(sb.tmp, "g8-W-1.md");
    fs.writeFileSync(p1, cause(CAUSE_PLACEHOLDER)); fs.writeFileSync(p8, cause("The brief named the wrong file."));
    const w1 = sessionLine(sb, { name: "W", id: "W@1", group: "g1", branch: "w1", sid: "w-s1", mode: "bg", bg_id: "bg-W1", supersedes: null });
    appendLine(sb, { incident: w1.id, name: "W", group: "g1", n: 1, path: p1, signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
    appendLine(sb, { kill_intent: w1.id, name: "W", kind: "ladder", at }); appendLine(sb, { closed: "W", id: w1.id, at });
    const w2 = sessionLine(sb, { name: "W", id: "W@2", gen: 2, group: "g1", branch: "w1", sid: "w-s2", mode: "bg", bg_id: "bg-W2", supersedes: w1.id });
    appendLine(sb, { restart: "W", group: "g1", n: 1, kind: "fresh", from: w1.id, handoff: w2.handoff, model: "opus", effort: "high", at });
    // Another group's lane W: incident number 1 too, its Cause filled, recorded later.
    appendLine(sb, { incident: "W@5", name: "W", group: "g8", n: 1, path: p8, signature: "a:main:y", rule: "a", tokens: 1000, mode: "report", at });
    appendLine(sb, { incident: w2.id, name: "W", group: "g1", n: 2, path: path.join(sb.tmp, "W-2.md"), signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at });
    appendLine(sb, { kill_intent: w2.id, name: "W", kind: "ladder", why: "loop ladder", at });
    const r = coordRun(sb, ["tick"], { env: { HL_LAUNCH_MJS: stub } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted W: fresh \(opus\/xhigh\)$/m); // its own first incident's Cause is empty: one rung up
  } finally { sb.cleanup(); }
});
