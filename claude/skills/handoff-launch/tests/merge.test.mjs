import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, launchLane, commitIn, writeDone, LAUNCH } from "./helpers.mjs";
import { pathToFileURL } from "node:url";
import { testExitLabel, mergeOne, drain } from "../merge.mjs";
import { conflictHandoff, key } from "../merge-lib.mjs";

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
    assert.deepEqual(fs.readdirSync(gdir(sb, "g1")).filter((f) => f.startsWith("merge.lock")), []); // no reclaimed-* or temp files left
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

test("a merge left unfinished in the merge worktree with no lock is aborted, then the lane merges", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    assert.match(merge(sb).out, /merged A/);
    const hb = commitIn(sb, b, { "b.txt": "B\n" }, "B work");
    writeDone(sb, "g1", "B", hb);
    spawnSync("git", ["-C", scratch(sb, "g1"), "merge", "--no-ff", "--no-commit", hb], { env: sb.env }); // merge left behind, lock deleted
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /aborted an unfinished merge left in the merge worktree/);
    assert.match(r.out, /merged B -> int-g1 [0-9a-f]{7}/);
    assert.equal(show(sb, "int-g1", "b.txt").stdout, "B\n");
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
  } finally { sb.cleanup(); }
});

test("a session's lane turning blocked keeps merge.lock: nothing else merges", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C"), e = launchLane(sb, "g1", "E");
    writeDone(sb, "g1", "B", commitIn(sb, b, { "shared.txt": "line1\nB\nline3\n" }, "B edits line2"));
    assert.match(merge(sb).out, /merged B/);
    const hc = commitIn(sb, c, { "shared.txt": "line1\nC\nline3\n" }, "C edits line2");
    writeDone(sb, "g1", "C", hc);
    assert.match(merge(sb).out, /CONFLICT C: .* merge session g1-merge-C launched/);
    const intBefore = sb.git(sb.repo, "rev-parse", "int-g1"), lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8");
    writeDone(sb, "g1", "E", commitIn(sb, e, { "e.txt": "E\n" }, "E work"));
    writeDone(sb, "g1", "C", hc, { status: "blocked" });
    const r = merge(sb, "--lane", "E");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /queued: g1-merge-C holds merge\.lock for C, which is now blocked - finish or abort that session's merge, then merge --skip C --why <reason> or merge --force/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
    assert.notEqual(show(sb, "int-g1", "e.txt").status, 0);
    assert.doesNotMatch(r.out, /FINAL_READY/);
  } finally { sb.cleanup(); }
});

test("a merge-session launcher that exits non-zero: lock released unless it registered the session", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node check.cjs"]);
    const d = launchLane(sb, "g1", "D");
    writeDone(sb, "g1", "D", commitIn(sb, d, { FAIL: "x\n" }, "D adds FAIL"));
    const u = (f) => pathToFileURL(path.join(path.dirname(LAUNCH), f)).href;
    const drive = path.join(sb.tmp, "drive.mjs"), failNoReg = path.join(sb.tmp, "fail-noreg.cjs"), failReg = path.join(sb.tmp, "fail-reg.cjs");
    // drain() with launch.mjs swapped for a fake launcher; the registry is read the way launch.mjs reads it.
    fs.writeFileSync(drive, [
      'import fs from "node:fs";',
      `import { drain } from ${JSON.stringify(u("merge.mjs"))};`,
      `import { key } from ${JSON.stringify(u("merge-lib.mjs"))};`,
      "const [REG, launchMjs, root] = process.argv.slice(2);",
      "const readRegistry = () => { const entries = [], closed = new Set(), merges = [];",
      "  if (fs.existsSync(REG)) for (const l of fs.readFileSync(REG, 'utf8').split(/\\r?\\n/)) { if (!l.trim()) continue; const o = JSON.parse(l);",
      "    if (o.closed) closed.add(o.id || o.closed); else if (o.merged || o.merge_blocked) merges.push(o); else if (o.name && o.launched_at) entries.push(o); }",
      "  return { entries, closed, stops: new Map(), merges }; };",
      "const append = (o) => fs.appendFileSync(REG, JSON.stringify(o) + '\\n');",
      "const r = drain({ readRegistry, append, launchMjs, root, repoKey: key(root), group: 'g1' });",
      "console.log(r.lines.join('\\n')); process.exit(r.code);",
    ].join("\n"));
    fs.writeFileSync(failNoReg, "process.stdout.write('fake launcher: could not start\\n'); process.exit(7);\n");
    fs.writeFileSync(failReg, [
      "const { spawnSync } = require('child_process');",
      `const r = spawnSync(process.execPath, [${JSON.stringify(LAUNCH)}, ...process.argv.slice(2)], { encoding: 'utf8' });`,
      "process.stdout.write('fake launcher: claude --bg reported failure\\n'); process.exit(r.status === 0 ? 7 : 9);",
    ].join("\n"));
    const run = (launcher) => spawnSync(process.execPath, [drive, path.join(sb.reg, "sessions.jsonl"), launcher, sb.repo], { env: sb.env, encoding: "utf8" });
    const r1 = run(failNoReg);
    assert.equal(r1.status, 1, r1.stderr + r1.stdout);
    assert.match(r1.stdout, /ERROR could not launch merge session g1-merge-D: fake launcher: could not start/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    const r2 = run(failReg);
    assert.equal(r2.status, 0, r2.stderr + r2.stdout);
    assert.match(r2.stdout, /TEST FAILED D \(exit 1\) after a clean merge - merge session g1-merge-D launched/);
    assert.match(r2.stdout, /merge session g1-merge-D was registered but its launcher exited 7: [\s\S]*claude --bg reported failure - if that session is not running, merge --force retries the lane/);
    const lock = JSON.parse(fs.readFileSync(lockOf(sb, "g1"), "utf8"));
    assert.equal(lock.holder, "session"); assert.equal(lock.session, "g1-merge-D");
    assert.equal(sb.registry().filter((o) => o.name === "g1-merge-D").length, 1);
  } finally { sb.cleanup(); }
});

test("a test run without an exit code is reported as killed, not exit null", () => {
  assert.equal(testExitLabel({ status: 1 }, 1000), "exit 1");
  assert.equal(testExitLabel({ status: null, error: { code: "ETIMEDOUT" } }, 120000), "killed: no result after 120 s");
  assert.equal(testExitLabel({ status: null, signal: "SIGKILL" }, 1000), "killed by SIGKILL: no exit code");
  const md = conflictHandoff({ group: "g1", lane: "T", branch: "lane-T", head: "abc", integration: "int", target: "main", wt: "w",
    before: "def", reason: "test-failed", conflicts: [], output: "", code: null, exit: "killed: no result after 120 s", test: "t",
    launchMjs: "l", root: "r", at: "now" });
  assert.match(md, /the test command failed \(killed: no result after 120 s\) after a clean merge/);
  assert.doesNotMatch(md, /exit null/);
});

test("overlap with a running lane is written into the finished lane's marker and its merge-session handoff", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node check.cjs"]);
    const rl = launchLane(sb, "g1", "R"), d = launchLane(sb, "g1", "D");
    commitIn(sb, rl, { "shared.txt": "line1\nR\nline3\n" }, "R edits shared (still running)");
    writeDone(sb, "g1", "D", commitIn(sb, d, { FAIL: "x\n", "shared.txt": "line1\nline2\nD\n" }, "D edits shared, adds FAIL"));
    const r = merge(sb);
    assert.match(r.out, /TEST FAILED D \(exit 1\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gdir(sb, "g1"), "D.done"), "utf8")).overlap, { R: ["shared.txt"] });
    const s = sb.registry().find((o) => o.name === "g1-merge-D");
    assert.match(fs.readFileSync(s.handoff, "utf8"), /- Files this lane shares with lanes still running \(they merge later\):\n {2}- running lane R: shared\.txt/);
  } finally { sb.cleanup(); }
});

test("a lane whose head is already in the integration branch counts as merged, without an empty merge commit", () => {
  const sb = sandbox();
  try {
    setup(sb);
    launchLane(sb, "g1", "K");
    const base = sb.git(sb.repo, "rev-parse", "main");
    writeDone(sb, "g1", "K", base);
    // Through `merge`: the ancestry check in groupLanes classifies K merged as soon as int-g1 exists.
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /FINAL_READY g1/);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), base);
    // mergeOne's own "already" result (reached when a lane lands in the integration branch between scan and merge).
    const one = mergeOne({ wt: scratch(sb, "g1"), gd: gdir(sb, "g1"), lane: { name: "K", branch: "lane-K", marker: { head: base } },
      cfg: { integration: "int-g1", target: "main", test: null, test_timeout_min: 30 }, owns: () => true });
    assert.deepEqual(one, { result: "already", sha: base });
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), base);
  } finally { sb.cleanup(); }
});

function conflictPair(sb) {
  setup(sb);
  const b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C");
  writeDone(sb, "g1", "B", commitIn(sb, b, { "shared.txt": "line1\nB\nline3\n" }, "B edits line2"));
  merge(sb, "--lane", "B");
  const hc = commitIn(sb, c, { "shared.txt": "line1\nC\nline3\n" }, "C edits line2");
  writeDone(sb, "g1", "C", hc);
  assert.match(merge(sb, "--lane", "C").out, /CONFLICT C/);
  return { c, hc };
}

test("--skip gives up on a lane, frees its merge session's lock, and the group can finish", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const r = merge(sb, "--skip", "C", "--why", "needs the user");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /skipped C \(needs the user\); released merge\.lock held by g1-merge-C/);
    assert.match(r.out, /FINAL_READY g1: .*not merged: C/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.ok(sb.registry().some((o) => o.merge_blocked === "C" && o.why === "needs the user"));
  } finally { sb.cleanup(); }
});

test("--force clears a stale session lock and retries the lane (a second merge session)", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    spawnSync("git", ["-C", scratch(sb, "g1"), "merge", "--no-ff", "--no-commit", "lane-C"], { env: sb.env }); // session died mid-resolution
    sb.git(scratch(sb, "g1"), "merge", "--abort"); // --force refuses a half merge: the person aborts it first
    const r = merge(sb, "--force");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /cleared merge\.lock \(merge session g1-merge-C \(lane C\)\)\n/);
    assert.match(r.out, /CONFLICT C/);
    assert.equal(sb.registry().filter((o) => o.name === "g1-merge-C").length, 2);
    assert.equal(JSON.parse(fs.readFileSync(lockOf(sb, "g1"), "utf8")).session, "g1-merge-C");
  } finally { sb.cleanup(); }
});

test("merge --dry-run shows the queue and the lock and changes nothing", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb, "--dry-run");
    assert.equal(r.code, 0);
    assert.match(r.out, /would merge, in order: \[A\]; merge\.lock: nobody/);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1);
  } finally { sb.cleanup(); }
});

test("a merged lane cannot be reopened; a skipped lane re-done with a new head is merged", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), x = launchLane(sb, "g1", "X");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    merge(sb);
    const again = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--worktree", "lane-A", "--group", "g1", "--reopen");
    assert.equal(again.code, 3); assert.match(again.err, /already merged/);
    const h1 = commitIn(sb, x, { "x.txt": "v1\n" }, "X v1");
    writeDone(sb, "g1", "X", h1);
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "Z", at: new Date().toISOString() }));
    merge(sb, "--skip", "X", "--why", "wrong approach"); // skip while the lock is busy: X is not merged
    fs.rmSync(lockOf(sb, "g1"));
    launchLane(sb, "g1", "X", ["--reopen"]);
    const h2 = commitIn(sb, x, { "x.txt": "v2\n" }, "X v2");
    writeDone(sb, "g1", "X", h2);
    const r = merge(sb);
    assert.match(r.out, /merged X -> int-g1/);
    assert.equal(show(sb, "int-g1", "x.txt").stdout, "v2\n");
  } finally { sb.cleanup(); }
});

test("a lane whose merge session holds merge.lock cannot be reopened", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "C", "--model", "opus", "--effort", "high", "--worktree", "lane-C", "--group", "g1", "--reopen");
    assert.equal(r.code, 3); assert.match(r.err, /lane C is already merged \(or being merged\) into int-g1/);
    assert.ok(fs.existsSync(path.join(gdir(sb, "g1"), "C.done")));
  } finally { sb.cleanup(); }
});

// Controller ruling: settleSession keeps a merge session's lock while its lane is blocked or unreadable, so --skip of
// that lane is the way out: it frees the lock (head taken from the lock when the marker has none) and the queue drains.
test("--skip of a blocked or unreadable lane frees its merge session's lock and the next lane merges", () => {
  for (const turn of ["blocked", "unreadable"]) {
    const sb = sandbox();
    try {
      const { hc } = conflictPair(sb);
      const e = launchLane(sb, "g1", "E");
      writeDone(sb, "g1", "E", commitIn(sb, e, { "e.txt": "E\n" }, "E work"));
      if (turn === "blocked") writeDone(sb, "g1", "C", hc, { status: "blocked" });
      else fs.writeFileSync(path.join(gdir(sb, "g1"), "C.done"), "{bad");
      assert.match(merge(sb).out, new RegExp(`holds merge\\.lock for C, which is now ${turn}`), turn);
      const r = merge(sb, "--skip", "C", "--why", "x");
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(r.out, /skipped C \(x\); released merge\.lock held by g1-merge-C/, turn);
      assert.match(r.out, /merged E -> int-g1 [0-9a-f]{7}/, turn);
      assert.equal(fs.existsSync(lockOf(sb, "g1")), false, turn);
      assert.ok(sb.registry().some((o) => o.merge_blocked === "C" && o.head === hc && o.why === "x"), turn);
    } finally { sb.cleanup(); }
  }
});

test("--skip refuses a lane it cannot skip: not a member, no head, already merged, no lane name", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    launchLane(sb, "g1", "O");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    assert.match(merge(sb).out, /merged A/);
    const before = sb.registry().length;
    let r = merge(sb, "--skip", "nobody", "--why", "x");
    assert.equal(r.code, 1); assert.match(r.out, /ERROR lane nobody is not a member of group g1/);
    r = merge(sb, "--skip", "O", "--why", "x");
    assert.equal(r.code, 1); assert.match(r.out, /ERROR lane O has no done marker with a head/);
    r = merge(sb, "--skip", "A", "--why", "x");
    assert.equal(r.code, 1); assert.match(r.out, /ERROR lane A is already merged into int-g1/);
    r = merge(sb, "--skip");
    assert.equal(r.code, 2); assert.match(r.err, /--skip needs a lane name/);
    r = merge(sb, "--skip", "--why", "x");
    assert.equal(r.code, 2); assert.match(r.err, /--skip needs a lane name/);
    assert.equal(sb.registry().length, before);
  } finally { sb.cleanup(); }
});

// Controller ruling: --dry-run never merges, launches or writes - not even with --force / --skip, not even overlap.
test("merge --dry-run with --skip and --force still writes nothing: no lock change, no record, no overlap", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const rl = launchLane(sb, "g1", "R"), d = launchLane(sb, "g1", "D");
    commitIn(sb, rl, { "d.txt": "R\n" }, "R edits d.txt (still running)");
    writeDone(sb, "g1", "D", commitIn(sb, d, { "d.txt": "D\n" }, "D work"));
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8"), regBefore = sb.registry().length;
    const markerBefore = fs.readFileSync(path.join(gdir(sb, "g1"), "D.done"), "utf8"), intBefore = sb.git(sb.repo, "rev-parse", "int-g1");
    const r = merge(sb, "--dry-run", "--force", "--skip", "C", "--why", "x");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /would merge, in order: \[C,D\]; merge\.lock: merge session g1-merge-C \(lane C\)/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    assert.equal(sb.registry().length, regBefore);
    assert.equal(fs.readFileSync(path.join(gdir(sb, "g1"), "D.done"), "utf8"), markerBefore);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
  } finally { sb.cleanup(); }
});

test("--force never clears a live merge process's lock", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const held = JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "A", at: new Date().toISOString() });
    fs.writeFileSync(lockOf(sb, "g1"), held);
    const r = merge(sb, "--force");
    assert.equal(r.code, 1, r.err + r.out);
    assert.match(r.out, new RegExp(`not cleared: merge\\.lock is held by merge process ${process.pid} .*, which is alive`));
    assert.doesNotMatch(r.out, /queued/); // a refused --force exits without draining
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), held);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1);
  } finally { sb.cleanup(); }
});

test("legacy group: merge --force / --skip / --dry-run print the legacy flow and leave its merge.lock alone", () => {
  const sb = sandbox();
  try {
    const a = launchLane(sb, "g0", "A");
    writeDone(sb, "g0", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g0"), ""); // the legacy launch guard
    const before = sb.registry().length;
    for (const extra of [["--force"], ["--skip", "A", "--why", "x"], ["--dry-run"]]) {
      const r = sb.run("merge", "--group", "g0", "--repo", sb.repo, ...extra);
      assert.equal(r.code, 0, extra.join(" "));
      assert.match(r.out, /^legacy group g0 \(no config\.json\)/, extra.join(" "));
      assert.equal(fs.readFileSync(lockOf(sb, "g0"), "utf8"), "", extra.join(" "));
    }
    assert.equal(sb.registry().length, before);
  } finally { sb.cleanup(); }
});

// Fix round 1: a merge session that is still running owns its lock and the merge worktree.
const lastEntry = (sb, name) => sb.registry().filter((o) => o.name === name && o.launched_at).at(-1);
const appendReg = (sb, o) => fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify(o) + "\n");

test("--force refuses while the lock's merge session window is still running, and clears once it is gone", { skip: process.platform !== "win32" }, async () => {
  const sb = sandbox();
  // A real live host: checkHost wants a powershell process whose start time fits the registry entry.
  const host = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 120"], { stdio: "ignore", windowsHide: true });
  try {
    conflictPair(sb);
    const e = lastEntry(sb, "g1-merge-C");
    appendReg(sb, { ...e, id: `${e.name}@live`, launched_at: new Date().toISOString(), host_pid: host.pid, host_start: null, pid_file: null });
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8");
    const r = merge(sb, "--force");
    assert.equal(r.code, 1, r.err + r.out);
    assert.match(r.out, new RegExp(`not cleared: g1-merge-C is still running \\(host pid ${host.pid}\\) - launch\\.mjs stop --name g1-merge-C or close its window, then re-run`));
    assert.doesNotMatch(r.out, /CONFLICT|queued/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    assert.equal(sb.registry().filter((o) => o.name === "g1-merge-C").length, 2);
    await new Promise((res) => { host.on("exit", res); host.kill(); }); // the window is gone now
    const f = merge(sb, "--force");
    assert.equal(f.code, 0, f.err + f.out);
    assert.match(f.out, /cleared merge\.lock \(merge session g1-merge-C \(lane C\)\)/);
    assert.match(f.out, /CONFLICT C/);
  } finally { host.kill(); sb.cleanup(); }
});

// Fix round 2: before its session runs `git merge` there is no MERGE_HEAD yet, so only the holder itself may skip.
test("--skip of a lane whose running merge session holds the lock is refused unless that session asks (--session)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const host = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 120"], { stdio: "ignore", windowsHide: true });
  try {
    const { hc } = conflictPair(sb);
    const e = lastEntry(sb, "g1-merge-C");
    appendReg(sb, { ...e, id: `${e.name}@live`, launched_at: new Date().toISOString(), host_pid: host.pid, host_start: null, pid_file: null });
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8"), regBefore = sb.registry().length;
    for (const extra of [[], ["--session", "someone-else"], ["--force"]]) { // a person, a wrong name, --force --skip
      const r = merge(sb, "--skip", "C", "--why", "x", ...extra);
      assert.equal(r.code, 1, extra.join(" ") + r.err + r.out);
      assert.equal(r.out, "not skipped: g1-merge-C is still running and holds C - let it finish, or stop it (launch.mjs stop --name g1-merge-C) and re-run\n", extra.join(" "));
      assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore, extra.join(" "));
      assert.equal(sb.registry().length, regBefore, extra.join(" "));
    }
    const r = merge(sb, "--skip");
    assert.equal(r.code, 2); // value checks still come first
    assert.equal(merge(sb, "--skip", "C", "--session").code, 2);
    assert.equal(merge(sb, "--skip", "C", "--session", "--why", "x").code, 2);
    // the session itself (its handoff's skip command names it) may skip its own lane
    const s = merge(sb, "--skip", "C", "--session", "g1-merge-C", "--why", "x");
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, /skipped C \(x\); released merge\.lock held by g1-merge-C/);
    assert.ok(sb.registry().some((o) => o.merge_blocked === "C" && o.head === hc));
    assert.match(fs.readFileSync(e.handoff, "utf8"), /--skip C --session g1-merge-C --why "<reason>"/);
  } finally { host.kill(); sb.cleanup(); }
});

test("--force refuses while the lock's bg merge session is still listed by claude agents", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const e = lastEntry(sb, "g1-merge-C");
    appendReg(sb, { ...e, id: `${e.name}@bg`, mode: "bg", session_id: null, pid_file: null, bg_id: "bg-abc123", launched_at: new Date().toISOString() });
    const agents = path.join(sb.tmp, "agents.json"), lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8");
    fs.writeFileSync(agents, JSON.stringify([{ id: "bg-abc123", status: "running" }]));
    const r = merge(sb, "--force");
    assert.equal(r.code, 1, r.err + r.out);
    assert.match(r.out, /not cleared: g1-merge-C is still running \(bg session bg-abc123\) - launch\.mjs stop --name g1-merge-C/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    fs.writeFileSync(agents, "[]"); // the bg session ended
    const f = merge(sb, "--force");
    assert.equal(f.code, 0, f.err + f.out);
    assert.match(f.out, /cleared merge\.lock \(merge session g1-merge-C \(lane C\)\)/);
  } finally { sb.cleanup(); }
});

test("--skip of a lane whose merge is still in progress in the merge worktree is refused until it is aborted", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const wt = scratch(sb, "g1");
    spawnSync("git", ["-C", wt, "merge", "--no-ff", "--no-commit", "lane-C"], { env: sb.env }); // the session is mid-resolution
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8"), regBefore = sb.registry().length;
    const r = merge(sb, "--skip", "C", "--why", "x");
    assert.equal(r.code, 1, r.err + r.out);
    assert.match(r.out, /ERROR C's merge is still in progress in .*_merge-g1 - git merge --abort there first \(a dead session: merge --force\)/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    assert.equal(sb.registry().length, regBefore);
    assert.equal(spawnSync("git", ["-C", wt, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).status, 0); // untouched
    sb.git(wt, "merge", "--abort"); // the session's own path: abort, then skip
    const s = merge(sb, "--skip", "C", "--why", "x");
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, /skipped C \(x\); released merge\.lock held by g1-merge-C/);
  } finally { sb.cleanup(); }
});

test("--force --skip runs the skip first, so it still has the session lock's head", () => {
  const sb = sandbox();
  try {
    const { hc } = conflictPair(sb);
    fs.writeFileSync(path.join(gdir(sb, "g1"), "C.done"), "{bad"); // no head in the marker: only the lock has it
    const r = merge(sb, "--force", "--skip", "C", "--why", "x");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /skipped C \(x\); released merge\.lock held by g1-merge-C\nno merge\.lock to clear/);
    assert.ok(sb.registry().some((o) => o.merge_blocked === "C" && o.head === hc));
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
  } finally { sb.cleanup(); }
});

test("--force refuses a session lock whose lane is already merged; a plain merge records it and releases the lock", () => {
  const sb = sandbox();
  try {
    const { hc } = conflictPair(sb);
    const wt = scratch(sb, "g1");
    spawnSync("git", ["-C", wt, "merge", "--no-ff", "--no-commit", hc], { env: sb.env });
    fs.writeFileSync(path.join(wt, "shared.txt"), "line1\nB+C\nline3\n");
    sb.git(wt, "add", "shared.txt"); sb.git(wt, "commit", "-q", "-m", "Merge lane C into int-g1"); // committed, never ran merge
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8");
    const r = merge(sb, "--force");
    assert.equal(r.code, 1, r.err + r.out);
    assert.match(r.out, /not cleared: lane C is already merged - run merge without --force \(it records the merge and releases the lock\)/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    const d = merge(sb);
    assert.equal(d.code, 0, d.err + d.out);
    assert.match(d.out, /merged C -> int-g1 by g1-merge-C; merge\.lock released/);
    assert.ok(sb.registry().some((o) => o.merged === "C" && o.head === hc && o.by === "g1-merge-C"));
  } finally { sb.cleanup(); }
});

// Final review fixes.
test("F1: a merge session whose window process is dead is reported STALE by merge and status", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const e = lastEntry(sb, "g1-merge-C");
    appendReg(sb, { ...e, id: `${e.name}@dead`, launched_at: new Date().toISOString(), host_pid: deadPid(), host_start: null, pid_file: null });
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8");
    const m = merge(sb);
    assert.equal(m.code, 0, m.err + m.out);
    assert.match(m.out, /^queued: g1-merge-C is resolving C - STALE: /m);
    const s = sb.run("status", "--group", "g1", "--repo", sb.repo);
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, /^merge: queued: g1-merge-C is resolving C - STALE: /m);
    assert.match(s.out, /final_ready=false \(STALE: g1-merge-C closed without merging C - merge --force retries it/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore); // reported, never cleared on its own
  } finally { sb.cleanup(); }
});

test("F1: a bg merge session no longer listed by claude agents is STALE; a listed one is not", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const e = lastEntry(sb, "g1-merge-C");
    appendReg(sb, { ...e, id: `${e.name}@bg`, mode: "bg", session_id: null, pid_file: null, bg_id: "bg-abc123", launched_at: new Date().toISOString() });
    const agents = path.join(sb.tmp, "agents.json");
    fs.writeFileSync(agents, JSON.stringify([{ id: "bg-abc123", status: "running" }]));
    let m = merge(sb);
    assert.match(m.out, /^queued: g1-merge-C is resolving C$/m);
    fs.writeFileSync(agents, "[]");
    m = merge(sb);
    assert.match(m.out, /^queued: g1-merge-C is resolving C - STALE: /m);
  } finally { sb.cleanup(); }
});

test("F2: a multi-lane drain refreshes merge.lock's `at` before each merge (same token)", () => {
  const sb = sandbox();
  try {
    const rec = path.join(sb.tmp, "rec.cjs"), log = path.join(sb.tmp, "locks.log");
    fs.writeFileSync(rec, `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(log)}, fs.readFileSync(${JSON.stringify(lockOf(sb, "g1"))}, 'utf8') + '\\n');\n`);
    setup(sb, "g1", ["--test", `node ${rec.split(path.sep).join("/")}`]);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    writeDone(sb, "g1", "B", commitIn(sb, b, { "b.txt": "B\n" }, "B work"));
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /merged A -> int-g1[\s\S]*merged B -> int-g1/);
    const seen = fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(seen.length, 2);
    assert.equal(seen[0].token, seen[1].token);
    assert.equal(seen[0].holder, "drain"); assert.equal(seen[1].pid, seen[0].pid);
    assert.notEqual(seen[0].at, seen[1].at);
    assert.deepEqual(seen.map((s) => s.lane), ["A", "B"]); // the refresh records the lane being merged now
  } finally { sb.cleanup(); }
});

test("F3: --force refuses a session lock while a merge is in progress in the merge worktree; clears once it is aborted", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const wt = scratch(sb, "g1");
    spawnSync("git", ["-C", wt, "merge", "--no-ff", "--no-commit", "lane-C"], { env: sb.env }); // the session is mid-resolution
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8"), regBefore = sb.registry().length;
    const r = merge(sb, "--force");
    assert.equal(r.code, 1, r.err + r.out);
    assert.match(r.out, /^not cleared: a merge is in progress in .*_merge-g1 - if g1-merge-C is gone, git merge --abort there first, then re-run merge --force$/m);
    assert.doesNotMatch(r.out, /CONFLICT|queued|aborted/);
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    assert.equal(sb.registry().length, regBefore);
    assert.equal(spawnSync("git", ["-C", wt, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).status, 0); // untouched
    sb.git(wt, "merge", "--abort");
    const f = merge(sb, "--force");
    assert.equal(f.code, 0, f.err + f.out);
    assert.match(f.out, /cleared merge\.lock \(merge session g1-merge-C \(lane C\)\)/);
    assert.match(f.out, /CONFLICT C/);
  } finally { sb.cleanup(); }
});

// In-process drain with fs.linkSync swapped out (merge.mjs calls fs.linkSync on the shared node:fs object).
function inProcessDrain(sb, linkSync) {
  const readRegistry = () => {
    const entries = [], merges = [];
    for (const o of sb.registry()) { if (o.merged || o.merge_blocked) merges.push(o); else if (o.name && o.launched_at) entries.push(o); }
    return { entries, closed: new Set(), stops: new Map(), merges };
  };
  const ctx = { readRegistry, append: (o) => appendReg(sb, o), launchMjs: LAUNCH, root: sb.repo, repoKey: key(sb.repo), group: "g1" };
  const orig = fs.linkSync;
  fs.linkSync = linkSync;
  try { return drain(ctx); } finally { fs.linkSync = orig; }
}

test("M2: a filesystem without hard links gives one ERROR line (exit 1), no stack trace, no lock left", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = inProcessDrain(sb, () => { throw Object.assign(new Error("operation not permitted, link"), { code: "EPERM" }); });
    assert.deepEqual(r, { code: 1, lines: ["ERROR merge.lock needs a filesystem with hard links (EPERM)"] });
    assert.deepEqual(fs.readdirSync(gdir(sb, "g1")).filter((f) => f.startsWith("merge.lock")), []);
  } finally { sb.cleanup(); }
});

test("M4: a lock that vanishes on every attempt says to run merge again, not queued", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = inProcessDrain(sb, () => { throw Object.assign(new Error("file already exists, link"), { code: "EEXIST" }); });
    assert.deepEqual(r, { code: 0, lines: ["merge.lock changed hands repeatedly - run merge again"] });
  } finally { sb.cleanup(); }
});

test("group rejects an unknown flag; config.json rejects an unknown key", () => {
  const sb = sandbox();
  try {
    const r = sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main", "--tests", "node check.cjs");
    assert.equal(r.code, 2); assert.match(r.err, /unknown flag --tests/);
    assert.equal(fs.existsSync(path.join(gdir(sb, "g1"), "config.json")), false);
    setup(sb);
    const f = path.join(gdir(sb, "g1"), "config.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), tests: "x" }));
    const m = merge(sb);
    assert.equal(m.code, 1); assert.match(m.out, /ERROR config: unknown key tests/);
  } finally { sb.cleanup(); }
});

test("a link error other than missing hard links is reported as such", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = inProcessDrain(sb, () => { throw Object.assign(new Error("permission denied, link"), { code: "EACCES" }); });
    assert.deepEqual(r, { code: 1, lines: ["ERROR could not create merge.lock (EACCES)"] });
  } finally { sb.cleanup(); }
});

test("--why with a newline is collapsed to one line in the record and the output", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "Z", at: new Date().toISOString() }));
    const r = merge(sb, "--skip", "A", "--why", "first line\n  second line");
    assert.match(r.out, /^skipped A \(first line second line\)$/m);
    assert.equal(sb.registry().find((o) => o.merge_blocked === "A").why, "first line second line");
  } finally { sb.cleanup(); }
});

test("--force clears a legacy (empty) merge.lock in a rolling group, then the lane merges", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), "");
    const r = merge(sb, "--force");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^cleared merge\.lock \(a legacy merge launch\)$/m);
    assert.match(r.out, /merged A -> int-g1/);
  } finally { sb.cleanup(); }
});

test("--force clears a drain lock older than the test timeout, then the lane merges", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "Z", at: "2026-01-01T00:00:00.000Z" }));
    assert.match(merge(sb).out, /queued: merge\.lock is held by merge process \d+ \(lane Z, since 2026-01-01T00:00:00\.000Z\).*older than the test timeout/);
    const r = merge(sb, "--force");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^cleared merge\.lock \(merge process \d+ \(lane Z, since 2026-01-01T00:00:00\.000Z\)\)$/m);
    assert.match(r.out, /merged A -> int-g1/);
  } finally { sb.cleanup(); }
});

test("rolling --reopen is refused while a drain lock is held for the same lane", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    const marker = writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "A", at: new Date().toISOString() }));
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--worktree", "lane-A", "--group", "g1", "--reopen");
    assert.equal(r.code, 3); assert.match(r.err, /already merged \(or being merged\)/);
    assert.ok(fs.existsSync(marker));
  } finally { sb.cleanup(); }
});

test("tri-state: a failed or timed-out probe makes --force and --skip refuse, and merge and status never call it STALE", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const e = lastEntry(sb, "g1-merge-C");
    appendReg(sb, { ...e, id: `${e.name}@dead`, no_spawn: undefined, launched_at: new Date().toISOString(), host_pid: deadPid(), host_start: null, pid_file: null });
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8");
    for (const fake of ["fail", "timeout"]) {
      const env = { ...sb.env, HL_FAKE_PROBE: fake };
      const run = (...a) => { const r = spawnSync(process.execPath, [LAUNCH, ...a], { env, encoding: "utf8" }); return { code: r.status, out: (r.stdout || "").replace(/\r/g, "") }; };
      const why = fake === "fail" ? "failed" : "timed out";
      let r = run("merge", "--group", "g1", "--repo", sb.repo, "--force");
      assert.equal(r.code, 1, fake + r.out);
      assert.match(r.out, new RegExp(`^not cleared: g1-merge-C's liveness is unknown \\(.*${why}.*\\) - nothing cleared`, "m"));
      r = run("merge", "--group", "g1", "--repo", sb.repo, "--skip", "C", "--why", "x");
      assert.equal(r.code, 1, fake + r.out);
      assert.match(r.out, /^not skipped: g1-merge-C holds C and its liveness is unknown/m);
      r = run("merge", "--group", "g1", "--repo", sb.repo);
      assert.match(r.out, /^queued: g1-merge-C is resolving C \(liveness unknown: .* - not judged STALE\)$/m);
      r = run("status", "--group", "g1", "--repo", sb.repo, "--no-merge");
      assert.match(r.out, /final_ready=false \(liveness of g1-merge-C unknown: .* - not judged STALE\)$/m);
      assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    }
    if (process.platform === "win32") assert.match(merge(sb).out, /^queued: g1-merge-C is resolving C - STALE: /m); // a real probe: the pid is dead
  } finally { sb.cleanup(); }
});
