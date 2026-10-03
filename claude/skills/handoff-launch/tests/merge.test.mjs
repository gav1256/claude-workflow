import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, launchLane, commitIn, writeDone, LAUNCH } from "./helpers.mjs";

const setup = (sb, group = "g1", extra = []) => {
  const r = sb.run("group", "--group", group, "--repo", sb.repo, "--integration", `int-${group}`, "--target", "main", ...extra);
  assert.equal(r.code, 0, r.err + r.out);
};
const show = (sb, ref, file) => spawnSync("git", ["-C", sb.repo, "show", `${ref}:${file}`], { encoding: "utf8" });
const gdir = (sb, g) => path.join(sb.repo, ".superpowers", "sessions", g);
const lockOf = (sb, g) => path.join(gdir(sb, g), "merge.lock");
const scratch = (sb, g) => path.join(sb.repo, ".claude", "worktrees", `_merge-${g}`);
const merge = (sb, ...a) => sb.run("merge", "--group", "g1", "--repo", sb.repo, ...a);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("group writes config.json and refuses bad input", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node check.cjs"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(gdir(sb, "g1"), "config.json"), "utf8"));
    assert.deepEqual(cfg, { integration: "int-g1", target: "main", test: "node check.cjs", test_timeout_min: 30, mode: "window" });
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "x", "--target", "main").code, 2); // exists
    assert.equal(sb.run("group", "--group", "g2", "--repo", sb.repo, "--integration", "main", "--target", "main").code, 2);
    assert.equal(sb.run("group", "--group", "g3", "--repo", sb.repo, "--integration", "i", "--target", "nope").code, 2);
    launchLane(sb, "g4", "A"); // a legacy group that already launched lanes stays legacy
    const r = sb.run("group", "--group", "g4", "--repo", sb.repo, "--integration", "int-g4", "--target", "main");
    assert.equal(r.code, 3); assert.match(r.err, /stays a legacy/);
  } finally { sb.cleanup(); }
});

test("a finished lane merges while another lane is still running", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    const ha = commitIn(sb, a, { "a.txt": "from A\n" }, "A work");
    const hb = commitIn(sb, b, { "b.txt": "from B\n" }, "B work");
    const mainBefore = sb.git(sb.repo, "rev-parse", "main");
    writeDone(sb, "g1", "A", ha);
    const r = sb.run("merge", "--group", "g1", "--repo", a, "--lane", "A"); // run from the lane's own worktree
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /merged A -> int-g1 [0-9a-f]{7}/);
    assert.equal(show(sb, "int-g1", "a.txt").stdout, "from A\n");
    assert.notEqual(show(sb, "int-g1", "b.txt").status, 0);
    assert.equal(sb.git(b, "rev-parse", "HEAD"), hb);
    assert.equal(sb.git(b, "status", "--porcelain"), "");
    assert.equal(sb.git(sb.repo, "rev-parse", "main"), mainBefore);
    assert.equal(sb.git(sb.repo, "status", "--porcelain"), "");
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.ok(sb.registry().some((o) => o.merged === "A" && o.group === "g1" && o.head === ha && o.by === "drain"));
    assert.match(sb.git(sb.repo, "log", "-1", "--format=%s", "int-g1"), /^Merge lane A \(lane-A @ [0-9a-f]{7}\) into int-g1$/);
    assert.equal(sb.git(sb.repo, "rev-list", "--parents", "-n", "1", "int-g1").split(" ").length, 3); // a real merge commit
    assert.match(merge(sb).out, /nothing to merge/);
  } finally { sb.cleanup(); }
});

test("a failing test command aborts the merge and launches a merge session with the output", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node check.cjs"]);
    const d = launchLane(sb, "g1", "D");
    writeDone(sb, "g1", "D", commitIn(sb, d, { FAIL: "x\n" }, "D adds FAIL"));
    const r = merge(sb, "--lane", "D");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /TEST FAILED D \(exit 1\) after a clean merge - merge session g1-merge-D launched/);
    assert.notEqual(show(sb, "int-g1", "FAIL").status, 0);
    assert.equal(sb.git(scratch(sb, "g1"), "status", "--porcelain", "--untracked-files=no"), "");
    const lock = JSON.parse(fs.readFileSync(lockOf(sb, "g1"), "utf8"));
    assert.equal(lock.holder, "session"); assert.equal(lock.session, "g1-merge-D"); assert.equal(lock.lane, "D");
    const s = sb.registry().filter((o) => o.name === "g1-merge-D");
    assert.equal(s.length, 1);
    assert.ok(same(s[0].worktree, scratch(sb, "g1")));
    assert.equal(s[0].branch, "int-g1");
    assert.match(fs.readFileSync(s[0].handoff, "utf8"), /the test command failed \(exit 1\)[\s\S]*`node check\.cjs`/);
  } finally { sb.cleanup(); }
});

test("a conflicting lane launches a merge session; after it resolves, the queue drains", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C"), e = launchLane(sb, "g1", "E");
    writeDone(sb, "g1", "B", commitIn(sb, b, { "shared.txt": "line1\nB\nline3\n" }, "B edits line2"));
    assert.match(merge(sb, "--lane", "B").out, /merged B/);
    const intBefore = sb.git(sb.repo, "rev-parse", "int-g1");
    const hc = commitIn(sb, c, { "shared.txt": "line1\nC\nline3\n" }, "C edits line2");
    writeDone(sb, "g1", "C", hc);
    const r = merge(sb, "--lane", "C");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /CONFLICT C: 1 file\(s\): shared\.txt - merge session g1-merge-C launched/);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
    const wt = scratch(sb, "g1");
    assert.equal(sb.git(wt, "status", "--porcelain", "--untracked-files=no"), "");
    const s = sb.registry().find((o) => o.name === "g1-merge-C");
    assert.match(fs.readFileSync(s.handoff, "utf8"), /- Conflicting files:\n {2}- shared\.txt/);
    // E finishes while the merge session works: queued, nothing touched
    writeDone(sb, "g1", "E", commitIn(sb, e, { "e.txt": "E\n" }, "E work"));
    const q = merge(sb, "--lane", "E");
    assert.equal(q.code, 0); assert.match(q.out, /queued: g1-merge-C is resolving C/);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
    // the merge session resolves C in the merge worktree, then runs the handoff's last step
    spawnSync("git", ["-C", wt, "merge", "--no-ff", "--no-commit", hc], { env: sb.env });
    fs.writeFileSync(path.join(wt, "shared.txt"), "line1\nB+C\nline3\n");
    sb.git(wt, "add", "shared.txt"); sb.git(wt, "commit", "-q", "-m", "Merge lane C into int-g1");
    const d = sb.run("merge", "--group", "g1", "--repo", wt);
    assert.equal(d.code, 0, d.err + d.out);
    assert.match(d.out, /merged C -> int-g1 by g1-merge-C; merge\.lock released/);
    assert.match(d.out, /merged E -> int-g1 [0-9a-f]{7}/);
    assert.match(d.out, /FINAL_READY g1/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.equal(show(sb, "int-g1", "e.txt").stdout, "E\n");
  } finally { sb.cleanup(); }
});

test("a live merge holds the lock: a second merge prints queued and changes nothing", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const held = JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "X", at: new Date().toISOString() });
    fs.writeFileSync(lockOf(sb, "g1"), held);
    const r = merge(sb, "--lane", "A");
    assert.equal(r.code, 0); assert.match(r.out, new RegExp(`queued: merge.lock is held by merge process ${process.pid}`));
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), held);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1); // not even created
  } finally { sb.cleanup(); }
});

test("a dead merge process's lock is reclaimed and its half merge aborted, never committed", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    assert.match(merge(sb).out, /merged A/);
    const hb = commitIn(sb, b, { "b.txt": "B\n" }, "B work");
    writeDone(sb, "g1", "B", hb);
    spawnSync("git", ["-C", scratch(sb, "g1"), "merge", "--no-ff", "--no-commit", hb], { env: sb.env }); // the crash left this
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "dead", pid: deadPid(), lane: "B", at: new Date().toISOString() }));
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /reclaimed merge\.lock from a dead merge process and aborted its unfinished merge/);
    assert.match(r.out, /merged B -> int-g1/);
    assert.match(sb.git(sb.repo, "log", "-1", "--format=%s", "int-g1"), /^Merge lane B /);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
  } finally { sb.cleanup(); }
});

test("two lanes finishing at the same moment: each is merged exactly once", async () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    writeDone(sb, "g1", "B", commitIn(sb, b, { "b.txt": "B\n" }, "B work"));
    const go = (lane) => new Promise((res) => {
      const p = spawn(process.execPath, [LAUNCH, "merge", "--group", "g1", "--repo", sb.repo, "--lane", lane], { env: sb.env });
      let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => res({ code, out }));
    });
    const [x, y] = await Promise.all([go("A"), go("B")]);
    assert.equal(x.code, 0, x.out); assert.equal(y.code, 0, y.out);
    const subjects = sb.git(sb.repo, "log", "--merges", "--format=%s", "int-g1").split("\n");
    assert.equal(subjects.filter((s) => s.startsWith("Merge lane A ")).length, 1);
    assert.equal(subjects.filter((s) => s.startsWith("Merge lane B ")).length, 1);
    assert.equal(sb.registry().filter((o) => o.merged).length, 2);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
  } finally { sb.cleanup(); }
});

test("a lane that finishes while another merge holds the lock is merged by the holder", () => {
  const sb2 = sandbox();
  try {
    const hook = path.join(sb2.tmp, "hook.cjs"), flagFile = path.join(sb2.tmp, "hook.out");
    setup(sb2, "g1", ["--test", `node ${hook.split(path.sep).join("/")}`]);
    const a = launchLane(sb2, "g1", "A"), f = launchLane(sb2, "g1", "F");
    const hf = commitIn(sb2, f, { "f.txt": "F\n" }, "F work");
    const markerF = path.join(gdir(sb2, "g1"), "F.done");
    // The test command plays lane F: during A's merge it writes F's done marker and runs F's merge call.
    fs.writeFileSync(hook, [
      "const fs = require('fs'), { spawnSync } = require('child_process');",
      `if (!fs.existsSync(${JSON.stringify(flagFile)})) {`,
      `  fs.writeFileSync(${JSON.stringify(markerF)}, JSON.stringify({ name: 'F', branch: 'lane-F', head: ${JSON.stringify(hf)}, status: 'done', tests: 'ok', at: new Date().toISOString() }));`,
      `  const r = spawnSync(process.execPath, [${JSON.stringify(LAUNCH)}, 'merge', '--group', 'g1', '--repo', ${JSON.stringify(sb2.repo)}, '--lane', 'F'], { encoding: 'utf8' });`,
      `  fs.writeFileSync(${JSON.stringify(flagFile)}, r.stdout + r.stderr);`,
      "}",
    ].join("\n"));
    writeDone(sb2, "g1", "A", commitIn(sb2, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb2, "--lane", "A");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(fs.readFileSync(flagFile, "utf8"), /queued: merge\.lock is held by merge process/);
    assert.match(r.out, /merged A -> int-g1/);
    assert.match(r.out, /merged F -> int-g1/);
  } finally { sb2.cleanup(); }
});

test("a hanging test command times out, is killed, and its merge is aborted", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node hang.cjs", "--test-timeout-min", "0.05"]);
    const h = launchLane(sb, "g1", "H");
    writeDone(sb, "g1", "H", commitIn(sb, h, { "h.txt": "H\n" }, "H work"));
    const t0 = Date.now();
    const r = merge(sb);
    assert.ok(Date.now() - t0 < 60000, "took too long");
    assert.match(r.out, /TEST FAILED H \(exit 124\)/);
    const s = sb.registry().find((o) => o.name === "g1-merge-H");
    assert.match(fs.readFileSync(s.handoff, "utf8"), /timed out after 3 s/);
    assert.notEqual(show(sb, "int-g1", "h.txt").status, 0);
  } finally { sb.cleanup(); }
});

test("integration branch checked out elsewhere: ERROR, lock released, nothing changed", () => {
  const sb = sandbox();
  try {
    setup(sb);
    sb.git(sb.repo, "branch", "int-g1", "main");
    sb.git(sb.repo, "worktree", "add", path.join(sb.tmp, "elsewhere"), "int-g1");
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR integration branch int-g1 is checked out at .*elsewhere/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), sb.git(sb.repo, "rev-parse", "main"));
  } finally { sb.cleanup(); }
});

test("a dirty merge worktree stops the drain with ERROR and releases the lock", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    merge(sb);
    const intBefore = sb.git(sb.repo, "rev-parse", "int-g1");
    fs.writeFileSync(path.join(scratch(sb, "g1"), "shared.txt"), "hand edit\n");
    writeDone(sb, "g1", "B", commitIn(sb, b, { "b.txt": "B\n" }, "B work"));
    const r = merge(sb);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR merge worktree .* is not clean/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
  } finally { sb.cleanup(); }
});

test("a marker head that is not a commit blocks only that lane", () => {
  const sb = sandbox();
  try {
    setup(sb);
    launchLane(sb, "g1", "X");
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "X", "0123456789abcdef0123456789abcdef01234567", { at: "2026-01-01T00:00:00Z" });
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /MERGE-BLOCKED X: .*not a commit/);
    assert.match(r.out, /merged A -> int-g1/);
    assert.match(r.out, /FINAL_READY g1: .*not merged: X/);
  } finally { sb.cleanup(); }
});

test("legacy group: merge prints the legacy flow and touches nothing", () => {
  const sb = sandbox();
  try {
    const a = launchLane(sb, "g0", "A");
    writeDone(sb, "g0", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = sb.run("merge", "--group", "g0", "--repo", sb.repo, "--lane", "A");
    assert.equal(r.code, 0);
    assert.match(r.out, /^legacy group g0 \(no config\.json\)/);
    assert.equal(fs.existsSync(lockOf(sb, "g0")), false);
  } finally { sb.cleanup(); }
});

test("a merge session's launch prompt carries no lane done-marker instruction", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "g1-merge-Z", "--group", "g1", "--model", "opus", "--effort", "high");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(JSON.parse(r.out).prompt, /done marker/);
  } finally { sb.cleanup(); }
});

test("a done marker that parses to a non-object is unreadable: never merged, never open, no FINAL_READY", async () => {
  const { groupLanes } = await import("../merge.mjs");
  const { classify } = await import("../merge-lib.mjs");
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    launchLane(sb, "g1", "N");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(path.join(gdir(sb, "g1"), "N.done"), "null");
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /merged A -> int-g1/);
    assert.doesNotMatch(r.out, /merged N|FINAL_READY/);
    // every non-object JSON value is unreadable, not "open" (a lane that would silently never merge)
    const f = path.join(sb.tmp, "odd.done");
    for (const text of ["null", "false", "0", '"done"', "[]", "{bad"]) {
      fs.writeFileSync(f, text);
      const [l] = classify(groupLanes({ entries: [{ name: "Q", group: "g1", repo: "r", launched_at: "t", done_marker: f }], merges: [], group: "g1", repoKey: "r" }));
      assert.equal(l.state, "unreadable", `marker ${text}`);
    }
  } finally { sb.cleanup(); }
});
