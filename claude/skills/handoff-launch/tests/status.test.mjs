import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, launchLane, commitIn, writeDone, sessionLine, LAUNCH } from "./helpers.mjs";

const setup = (sb) => assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
const marker = (sb, name) => JSON.parse(fs.readFileSync(path.join(sb.repo, ".superpowers", "sessions", "g1", `${name}.done`), "utf8"));
const sidecar = (sb, name) => JSON.parse(fs.readFileSync(path.join(sb.repo, ".superpowers", "sessions", "g1", `${name}.overlap.json`), "utf8"));

test("overlap writes the files a finished lane shares with running lanes into its sidecar, never its done marker", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "shared.txt": "A\n", "a.txt": "A\n" }, "A work"));
    const hb = commitIn(sb, b, { "shared.txt": "B\n" }, "B work");
    commitIn(sb, c, { "c.txt": "C\n" }, "C work");
    const r = sb.run("overlap", "--group", "g1", "--repo", sb.repo);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^A \(finished\) <-> B \(running\): shared\.txt$/m);
    assert.doesNotMatch(r.out, /C \(running\)/);
    assert.deepEqual(sidecar(sb, "A"), { B: ["shared.txt"] });
    assert.equal(marker(sb, "A").overlap, undefined); // overlap never rewrites a done marker (M3)
    assert.equal(sb.git(b, "rev-parse", "HEAD"), hb);
    assert.equal(sb.git(b, "status", "--porcelain"), "");
    assert.match(sb.run("overlap", "--group", "g0", "--repo", sb.repo).err, /rolling-merge group/);
  } finally { sb.cleanup(); }
});

test("status on a rolling group drains finished lanes, then shows merge state and overlap", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "shared.txt": "A\n" }, "A work"));
    commitIn(sb, b, { "shared.txt": "B\n" }, "B work");
    let r = sb.run("status", "--group", "g1", "--no-merge");
    assert.match(r.out, /^A +lane-A +DONE {2}head=[0-9a-f]+ tests=ok {2}QUEUED {2}overlap=\{"B":\["shared\.txt"\]\}$/m);
    assert.match(r.out, /^B +lane-B +open \(lane still running its stages\)$/m);
    assert.match(r.out, /^members=2 done=1 all_done=false merge_launched=false merge_lock=false merged=0 queue=\[A\] merge_holder=none final_ready=false$/m);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1); // --no-merge
    r = sb.run("status", "--group", "g1");
    assert.match(r.out, /^merge: merged A -> int-g1 [0-9a-f]{7}$/m);
    assert.match(r.out, /^A +lane-A +DONE .* MERGED [0-9a-f]{7}/m);
    assert.match(r.out, /merged=1 queue=\[\] merge_holder=none final_ready=false$/m);
  } finally { sb.cleanup(); }
});

test("status and overlap with --dry-run write nothing: no merge, no overlap in the marker, no lock", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    const doneFile = writeDone(sb, "g1", "A", commitIn(sb, a, { "shared.txt": "A\n" }, "A work"));
    commitIn(sb, b, { "shared.txt": "B\n" }, "B work");
    const before = fs.readFileSync(doneFile, "utf8"), regBefore = sb.registry().length;
    let r = sb.run("status", "--group", "g1", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /^merge: /m);
    assert.match(r.out, /^A +lane-A +DONE .* QUEUED {2}overlap=\{"B":\["shared\.txt"\]\}$/m);
    assert.match(r.out, /merge_lock=false merged=0 queue=\[A\] merge_holder=none final_ready=false$/m);
    r = sb.run("overlap", "--group", "g1", "--repo", sb.repo, "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^A \(finished\) <-> B \(running\): shared\.txt$/m);
    assert.equal(fs.readFileSync(doneFile, "utf8"), before);
    assert.equal(fs.existsSync(path.join(sb.repo, ".superpowers", "sessions", "g1", "A.overlap.json")), false);
    assert.equal(sb.registry().length, regBefore);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1);
    assert.equal(fs.existsSync(path.join(sb.repo, ".superpowers", "sessions", "g1", "merge.lock")), false);
    assert.equal(fs.existsSync(path.join(sb.repo, ".claude", "worktrees", "_merge-g1")), false);
  } finally { sb.cleanup(); }
});

test("rolling status shows a non-object done marker as UNREADABLE (as the merge sees it) instead of crashing", () => {
  const sb = sandbox();
  try {
    setup(sb);
    launchLane(sb, "g1", "A");
    const f = writeDone(sb, "g1", "A", "x");
    fs.writeFileSync(f, "null");
    const r = sb.run("status", "--group", "g1", "--no-merge");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^A +lane-A +UNREADABLE marker \(not counted as done\)$/m);
    assert.match(r.out, /^members=1 done=0 all_done=false /m);
  } finally { sb.cleanup(); }
});

test("legacy status counts a null done marker as UNREADABLE, so all_done stays false", () => {
  const sb = sandbox();
  try {
    launchLane(sb, "g0", "A"); launchLane(sb, "g0", "B");
    writeDone(sb, "g0", "A", "x");
    fs.writeFileSync(writeDone(sb, "g0", "B", "x"), "null");
    const r = sb.run("status", "--group", "g0");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^B +lane-B +UNREADABLE marker \(not counted as done\)$/m);
    assert.match(r.out, /^members=2 done=1 all_done=false merge_launched=false merge_lock=false$/m);
  } finally { sb.cleanup(); }
});

test("status reports a merge session holding the lock and a dead merge process as STALE", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const lock = path.join(sb.repo, ".superpowers", "sessions", "g1", "merge.lock");
    fs.writeFileSync(lock, JSON.stringify({ holder: "session", token: "t", session: "g1-merge-A", lane: "A", head: "x", at: new Date().toISOString() }));
    let r = sb.run("status", "--group", "g1");
    assert.match(r.out, /^merge: queued: g1-merge-A is resolving A$/m);
    assert.match(r.out, /merge_launched=true merge_lock=true merged=0 queue=\[A\] merge_holder=g1-merge-A\(A\) final_ready=false$/m);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(lock, JSON.stringify({ holder: "drain", token: "t", pid: dead, lane: "A", at: new Date().toISOString() }));
    r = sb.run("status", "--group", "g1", "--no-merge");
    assert.match(r.out, /merge_holder=pid\d+\(A\) final_ready=false \(STALE: the merging process is gone - the next merge reclaims the lock\)$/m);
  } finally { sb.cleanup(); }
});

test("M1: status of a configured group with no lanes yet prints the rolling summary; a legacy one is unchanged", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const r = sb.run("status", "--group", "g1", "--repo", sb.repo);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^members=0 done=0 all_done=false merge_launched=false merge_lock=false merged=0 queue=\[\] merge_holder=none final_ready=false$/m);
    const l = sb.run("status", "--group", "g0", "--repo", sb.repo);
    assert.equal(l.out, "members=0 done=0 all_done=false merge_launched=false merge_lock=false\n");
  } finally { sb.cleanup(); }
});

test("a loop-blocked lane: LOOP-BLOCKED with its resume command, the drain skips it, final_ready counts it", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"); launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const b = sb.registry().find((o) => o.name === "B" && o.launched_at); // the launch line, not B's {starting} line
    fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ lane_blocked: "B", group: "g1", handoff: b.handoff, incident: "x/incidents/B-3.md", at: new Date().toISOString() }) + "\n");
    const r = sb.run("status", "--group", "g1");
    assert.match(r.out, /^merge: merged A -> int-g1 [0-9a-f]{7}$/m);
    assert.match(r.out, /^B +lane-B +open \(lane still running its stages\) {2}LOOP-BLOCKED \(incident x\/incidents\/B-3\.md - resume: launch\.mjs resume --group g1 --lane B\)$/m);
    assert.match(r.out, /^merge: FINAL_READY g1: .*not merged: B/m);
    assert.match(r.out, /final_ready=true$/m);
  } finally { sb.cleanup(); }
});

test("status notes incidents, liveness unknown and report-only groups", () => {
  const sb = sandbox();
  try {
    setup(sb);
    launchLane(sb, "g1", "A");
    const a = sb.registry().find((o) => o.name === "A" && o.launched_at), regFile = path.join(sb.reg, "sessions.jsonl");
    fs.appendFileSync(regFile, JSON.stringify({ incident: a.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", mode: "auto", at: new Date().toISOString() }) + "\n");
    let r = sb.run("status", "--group", "g1", "--no-merge");
    assert.match(r.out, /^A +lane-A +open \(lane still running its stages\) {2}incidents=1 \(latest x\/incidents\/A-1\.md\)$/m);
    assert.doesNotMatch(r.out, /^recovery:/m); // a group launched by a stage-2 launcher is auto
    fs.appendFileSync(regFile, JSON.stringify({ ...a, id: "A@live", no_spawn: undefined, host_pid: 4242, launched_at: new Date().toISOString() }) + "\n");
    const u = spawnSync(process.execPath, [LAUNCH, "status", "--group", "g1", "--no-merge"], { env: { ...sb.env, HL_FAKE_PROBE: "fail" }, encoding: "utf8" });
    assert.match(u.stdout, /^A +lane-A .* {2}liveness=unknown \(process probe failed/m);
    assert.equal(sb.run("group", "--group", "g2", "--repo", sb.repo, "--integration", "int-g2", "--target", "main").code, 0);
    sessionLine(sb, { name: "O", group: "g2", branch: "lane-O", coord: undefined, done_marker: path.join(sb.repo, ".superpowers", "sessions", "g2", "O.done").split(path.sep).join("/") });
    r = sb.run("status", "--group", "g2", "--no-merge");
    assert.match(r.out, /\nrecovery: report-only \(group launched before stage 2: loops are reported, never stopped - opt in: launch\.mjs recover --group g2 --mode auto\)\n$/);
  } finally { sb.cleanup(); }
});
