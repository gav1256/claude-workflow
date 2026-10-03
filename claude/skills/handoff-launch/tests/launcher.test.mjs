import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane } from "./helpers.mjs";

const fwd = (p) => p.split(path.sep).join("/");

// Registry lines exactly as the pre-stage-1 launcher wrote them: the legacy all_done flow must read them unchanged.
function legacyGroup(sb) {
  sb.git(sb.repo, "branch", "laneA"); sb.git(sb.repo, "branch", "laneB");
  const head = sb.git(sb.repo, "rev-parse", "--short", "laneA");
  const gd = path.join(sb.repo, ".superpowers", "sessions", "g0");
  fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, "A.done"), JSON.stringify({ name: "A", branch: "laneA", head, status: "done", tests: "3 passed", next_after_merge: ["A2"], at: "2026-01-01T00:00:00Z" }));
  const line = (name, branch, t) => ({ id: `${name}@${t}`, name, repo: fwd(sb.repo).toLowerCase(), branch, worktree: "x", generation: 1, mode: "window", group: "g0", title: name, handoff: "h.md", done_marker: fwd(path.join(gd, `${name}.done`)), launched_at: t, session_id: null, host_pid: null, host_start: null, pid_file: null });
  const regFile = path.join(sb.reg, "sessions.jsonl");
  fs.writeFileSync(regFile, [line("A", "laneA", "2026-01-01T00:00:00.000Z"), line("B", "laneB", "2026-01-01T00:00:01.000Z")].map((o) => JSON.stringify(o)).join("\n") + "\n");
  return { gd, head, regFile, line };
}

test("legacy group status output is unchanged", () => {
  const sb = sandbox();
  try {
    const { gd, head, regFile, line } = legacyGroup(sb);
    let r = sb.run("status", "--group", "g0");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, [
      `${"A".padEnd(28)} ${"laneA".padEnd(30)} DONE  head=${head} tests=3 passed next_after_merge=["A2"]`,
      `${"B".padEnd(28)} ${"laneB".padEnd(30)} open (lane still running its stages)`,
      "members=2 done=1 all_done=false merge_launched=false merge_lock=false", ""].join("\n"));
    fs.writeFileSync(path.join(gd, "B.done"), JSON.stringify({ name: "B", branch: "laneB", head, status: "blocked", tests: "n/a" }));
    fs.writeFileSync(path.join(gd, "merge.lock"), "");
    r = sb.run("status", "--group", "g0");
    assert.match(r.out, /\nmembers=2 done=2 all_done=true merge_launched=false merge_lock=true \(STALE lock: no merge entry - relaunch the merge with --force\)\n$/);
    assert.match(r.out, /^B {28}laneB {26}BLOCKED {2}head=/m);
    fs.appendFileSync(regFile, JSON.stringify(line("g0-merge", "int", "2026-01-01T00:00:02.000Z")) + "\n");
    r = sb.run("status", "--group", "g0");
    assert.match(r.out, /\nmembers=2 done=2 all_done=true merge_launched=true merge_lock=true\n$/);
    assert.equal(sb.run("status", "--group", "none").out, "members=0 done=0 all_done=false merge_launched=false merge_lock=false\n");
  } finally { sb.cleanup(); }
});

test("HL_NO_SPAWN records a lane launch and its worktree but starts nothing", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g9", "A");
    assert.ok(fs.existsSync(path.join(wt, "shared.txt")));
    const lines = sb.registry();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].name, "A"); assert.equal(lines[0].group, "g9"); assert.equal(lines[0].host_pid, null);
    assert.equal(lines[0].branch, "lane-A");
  } finally { sb.cleanup(); }
});

test("bg mode on Windows refuses a prompt containing % (cmd.exe would expand %VAR%)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    const odd = path.join(sb.tmp, "100%done.md");
    fs.writeFileSync(odd, "# odd\n");
    const r = sb.run("--repo", sb.repo, "--handoff", odd, "--name", "pct", "--model", "opus", "--effort", "high", "--mode", "bg");
    assert.equal(r.code, 2);
    assert.match(r.err, /contains %/);
    assert.equal(sb.registry().length, 0);
  } finally { sb.cleanup(); }
});
