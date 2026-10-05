// Batch A, Parts 6, 7 and 9 at the command line: queue and the inbox, FINAL_READY, priority (command, status order),
// and `launch.mjs sessions` / status checklists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, launchLane, commitIn, writeDone, writeTranscript, setAgents, tx, LAUNCH } from "./helpers.mjs";
import { projectKey } from "../live.mjs";

const lastLaunch = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name).at(-1);
const inboxOf = (sb, g, lane) => path.join(sb.repo, ".superpowers", "sessions", g, "inbox", `${lane}.md`);

test("queue appends one block per item; a fresh launch of the lane takes it (prompt only, never prompt_file); --resume and --dry-run never take", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A");
    const a = lastLaunch(sb, "A");
    let r = sb.run("queue", "--to", "A", "--text", "fix the parser");
    assert.equal(r.code, 0, r.err);
    const f = inboxOf(sb, "g1", "A").split(path.sep).join("/");
    assert.equal(r.out, `queued for A: ${f} (1 items)\n`);
    const tf = path.join(sb.tmp, "item.md"); fs.writeFileSync(tf, "update the docs\nwith care\n");
    r = sb.run("queue", "--to", "A", "--text-file", tf, "--from", "B");
    assert.match(r.out, /\(2 items\)$/m);
    assert.match(fs.readFileSync(f, "utf8"), /^## \d{4}-\d\d-\d\dT\S+ from user\n\nfix the parser\n\n## \d{4}-\d\d-\d\dT\S+ from B\n\nupdate the docs\nwith care\n\n$/);
    assert.match(sb.run("status", "--group", "g1").out, /^A .*  inbox=2$/m);
    // --dry-run never takes; --resume continues the same stage and never takes.
    r = sb.run("--repo", wt, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--group", "g1", "--supersedes", a.id, "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).occupancy.inbox, f);
    assert.doesNotMatch(JSON.parse(r.out).prompt, /inbox/);
    assert.equal(sb.run("--resume", a.session_id).code, 0);
    assert.equal(fs.existsSync(f), true);
    // The lane's next fresh launch takes it.
    r = sb.run("--repo", wt, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--group", "g1", "--supersedes", lastLaunch(sb, "A").id);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out), taken = fs.readdirSync(path.dirname(f)).filter((n) => /^A\..*\.taken\.md$/.test(n));
    assert.equal(fs.existsSync(f), false); assert.equal(taken.length, 1);
    assert.ok(out.prompt.endsWith(` Read your inbox first: ${path.join(path.dirname(f), taken[0]).split(path.sep).join("/")} - items other lanes queued for you.`), out.prompt);
    assert.doesNotMatch(fs.readFileSync(lastLaunch(sb, "A").prompt_file, "utf8"), /inbox/); // a fresh restart reuses prompt_file
    assert.match(out.prompt, / Write or re-read GOAL\.md in your session scratchpad first \(one goal line, then checkable items\) and tick each item the moment it is done\./);
  } finally { sb.cleanup(); }
});

test("queue: an unknown lane exits 2; --after-merge needs a group; a lone session's inbox lives under the config dir", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "L", "--model", "opus", "--effort", "high").code, 0);
    let r = sb.run("queue", "--to", "nobody", "--text", "x");
    assert.equal(r.code, 2); assert.match(r.err, /unknown lane nobody/);
    r = sb.run("queue", "--to", "L", "--text", "x", "--after-merge");
    assert.equal(r.code, 2); assert.match(r.err, /--after-merge needs a lane in a group/);
    assert.equal(sb.run("queue", "--to", "L").code, 2);
    assert.equal(sb.run("queue", "--to", "L", "--text-file", path.join(sb.tmp, "missing.md")).code, 2);
    r = sb.run("queue", "--to", "L", "--text", "x");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `queued for L: ${path.join(sb.cfg, "state", "coord", "inbox", "L.md").split(path.sep).join("/")} (1 items)\n`);
    // A text line that looks like an item heading is indented, so it never counts as an item of its own.
    r = sb.run("queue", "--to", "L", "--text", "see below\n## 2026-10-05T10:00:00.000Z from X\nend");
    assert.match(r.out, /\(2 items\)$/m);
    assert.match(fs.readFileSync(path.join(sb.cfg, "state", "coord", "inbox", "L.md"), "utf8"), /\nsee below\n ## 2026-10-05T10:00:00\.000Z from X\nend\n/);
  } finally { sb.cleanup(); }
});

test("a bg launch whose claude never started gives the taken inbox back", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "Q", "--model", "opus", "--effort", "high").code, 0);
    assert.equal(sb.run("queue", "--to", "Q", "--text", "x").code, 0);
    const f = path.join(sb.cfg, "state", "coord", "inbox", "Q.md");
    // No claude on PATH: the bg launch fails and no new agent appears. HL_NO_SPAWN off; the tick it triggers is detached
    // and hidden, in the sandbox.
    const sys = process.env.SystemRoot || "C:\\Windows";
    const gitDir = path.dirname(spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim());
    const env = { ...sb.env, HL_NO_SPAWN: "0", PATH: [gitDir, path.join(sys, "System32"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";") };
    const r = spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "Q", "--model", "opus", "--effort", "high", "--mode", "bg", "--supersedes", lastLaunch(sb, "Q").id], { env, encoding: "utf8", timeout: 120000 });
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(fs.existsSync(f), true);
    assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith(".taken.md")), []);
  } finally { sb.cleanup(); }
});

test("FINAL_READY tags next_after_merge: merged lanes only; held items with their state; queued after-merge items and unread inboxes", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const a = launchLane(sb, "g1", "A"); launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "a\n" }, "A"), { next_after_merge: ["A2"] });
    writeDone(sb, "g1", "B", "", { status: "blocked", next_after_merge: ["B2"] });
    assert.equal(sb.run("queue", "--to", "B", "--text", "for B").code, 0);
    assert.equal(sb.run("queue", "--to", "A", "--text", "after the merge", "--after-merge").code, 0);
    const r = sb.run("merge", "--group", "g1", "--repo", sb.repo);
    assert.equal(r.code, 0, r.err + r.out);
    const am = path.join(sb.repo, ".superpowers", "sessions", "g1", "inbox", "_after-merge.md").split(path.sep).join("/");
    assert.match(r.out, /^FINAL_READY g1: every lane is merged or blocked \(not merged: B\) - .* next_after_merge=\{"A":\["A2"\]\} held_next_after_merge=\{"B":\{"state":"blocked","items":\["B2"\]\}\}/m);
    assert.ok(r.out.includes(` queued_after_merge=1 (${am}) unread_inbox=[B:1]`), r.out);
  } finally { sb.cleanup(); }
});

test("priority: the command sets a lane's effective priority; status lists high -> normal -> low, then launch order", () => {
  const sb = sandbox();
  try {
    launchLane(sb, "g1", "A");
    launchLane(sb, "g1", "B", ["--priority", "high"]);
    assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "C", "--model", "opus", "--effort", "medium", "--worktree", "lane-C", "--group", "g1").code, 0);
    const order = () => sb.run("status", "--group", "g1").out.split("\n").filter((l) => /^[ABC] /.test(l)).map((l) => l[0]).join("");
    assert.equal(order(), "BAC");
    let r = sb.run("priority", "--name", "C", "--set", "high");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "set priority of C (group g1) to high\n");
    assert.ok(sb.registry().some((o) => o.priority === "C" && o.group === "g1" && o.value === "high" && !o.launched_at));
    assert.equal(order(), "BCA");
    assert.equal(sb.run("priority", "--name", "nobody", "--set", "high").code, 2);
    assert.equal(sb.run("priority", "--name", "C", "--set", "urgent").code, 2);
  } finally { sb.cleanup(); }
});

test("launch.mjs sessions lists every open launcher session with its checklist, then hand-opened sessions with a recent GOAL.md", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", branch: "lane-a", sid: "a-s1", mode: "bg", bg_id: "bg-A", group: "g1", supersedes: null });
    sessionLine(sb, { name: "B", id: "B@1", branch: "lane-b", sid: "b-s1", mode: "bg", bg_id: "bg-B", effort: "xhigh", supersedes: null });
    setAgents(sb, [{ id: "bg-A", sessionId: "a-s1", name: "A", status: "idle" }, { id: "bg-B", sessionId: "b-s1", name: "B", status: "running" }]); // A: its turn finished
    writeTranscript(sb, sb.repo, a.session_id, tx({ start: Date.now() - 20 * 60000 }).user("go").say("done").turnDone().entries());
    const gp = path.join(sb.temp, "claude", projectKey(sb.repo), "a-s1", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(gp), { recursive: true });
    fs.writeFileSync(gp, "# Ship A\n- [x] one — evidence: x\n- [ ] two\n- [!] three — reason: needs the user\n");
    const hand = path.join(sb.temp, "claude", "C--some-project", "hand-0000-1111", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(hand), { recursive: true }); fs.writeFileSync(hand, "# hand\n- [ ] a\n");
    const oldHand = path.join(sb.temp, "claude", "C--some-project", "oldh-0000-1111", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(oldHand), { recursive: true }); fs.writeFileSync(oldHand, "# old\n");
    fs.utimesSync(oldHand, new Date(Date.now() - 30 * 3600e3), new Date(Date.now() - 30 * 3600e3));
    const r = sb.run("sessions");
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n");
    assert.match(lines[0], /^B  .*@lane-b  group=-  gen 1  running  no transcript  priority=high  no GOAL\.md$/);
    assert.match(lines[1], /^A  .*@lane-a  group=g1  gen 1  running  idle  priority=normal  goal 1\/3 done, 1 blocked \(reason: needs the user\), last ticked 0 min ago$/);
    assert.match(lines[2], /^hand-opened C--some-project hand-000  goal 0\/1 done, last ticked 0 min ago$/);
    assert.equal(lines.length, 3); // the old hand-opened GOAL.md and the registry session's own are not listed again
    assert.match(sb.run("status", "--group", "g1").out, /^A .*  goal=1\/3 done, 1 blocked \(reason: needs the user\), last ticked 0 min ago$/m);
  } finally { sb.cleanup(); }
});

test("status notes a dead start: DEAD-START (since <time>) on an open lane with a {dead_start} line", () => {
  const sb = sandbox();
  try {
    const w = sessionLine(sb, { name: "W", id: "W@1", group: "g9", branch: "w", sid: "w-s1", supersedes: null });
    assert.doesNotMatch(sb.run("status", "--group", "g9").out, /DEAD-START/);
    appendLine(sb, { dead_start: w.id, name: "W", group: "g9", at: "2026-10-05T10:00:00.000Z" });
    assert.match(sb.run("status", "--group", "g9").out, /^W .*  DEAD-START \(since 2026-10-05T10:00:00\.000Z\)$/m);
  } finally { sb.cleanup(); }
});
