import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, launchLane, commitIn, writeDone } from "./helpers.mjs";

const setup = (sb) => assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
const marker = (sb, name) => JSON.parse(fs.readFileSync(path.join(sb.repo, ".superpowers", "sessions", "g1", `${name}.done`), "utf8"));

test("overlap writes the files a finished lane shares with running lanes into its done marker", () => {
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
    assert.deepEqual(marker(sb, "A").overlap, { B: ["shared.txt"] });
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
