import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FAKE_CODEX, makeRepo, addWorktree, rmrf } from "./helpers.mjs";
import { sandboxCheck, hostCheck } from "../lib/checks.mjs";

const bin = { cmd: process.execPath, args: [FAKE_CODEX] };

function withRepo(fn) {
  return async () => {
    const repo = makeRepo();
    try {
      await fn(repo);
    } finally {
      rmrf(path.dirname(repo));
    }
  };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function waitGone(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

// a command that records its own pid, then sleeps forever
const sleeper = (pidFile) =>
  `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},1e9)" "${pidFile}"`;

test("sandboxCheck: quotes and & survive, exit code propagates, file is written with CRLF", withRepo(async (repo) => {
  const r = await sandboxCheck({ bin, cwd: repo, runId: "r1", n: 1, cmd: 'echo "a b" & exit /b 4' });
  assert.equal(r.exit, 4);
  assert.equal(r.cmd, 'echo "a b" & exit /b 4');
  assert.match(r.tail, /"a b"/);
  assert.equal(r.timeout, undefined);
  const f = path.join(repo, ".codex-tmp", "r1", "check-1.cmd");
  assert.equal(fs.readFileSync(f, "utf8"), '@echo off\r\necho "a b" & exit /b 4\r\nexit /b %ERRORLEVEL%\r\n');
}));

test("sandboxCheck: exit 0, stderr is in the tail, tail is at most 300 chars", withRepo(async (repo) => {
  const ok = await sandboxCheck({ bin, cwd: repo, runId: "r1", n: 2, cmd: "echo fine" });
  assert.equal(ok.exit, 0);
  assert.match(ok.tail, /fine/);
  const e = await sandboxCheck({ bin, cwd: repo, runId: "r1", n: 3, cmd: "echo oops 1>&2 & exit /b 2" });
  assert.equal(e.exit, 2);
  assert.match(e.tail, /oops/);
  const long = await sandboxCheck({ bin, cwd: repo, runId: "r1", n: 4, cmd: `echo ${"x".repeat(500)}END` });
  assert.ok(long.tail.length <= 300);
  assert.ok(long.tail.endsWith("END"));
}));

test("sandboxCheck: runs with cwd = worktree whose path has a space; onPid called", withRepo(async (repo) => {
  const wt = addWorktree(repo, "lane");
  assert.ok(wt.includes(" "));
  const pids = [];
  const r = await sandboxCheck({
    bin, cwd: wt, runId: "r2", n: 1, cmd: "cd & exit /b 0", onPid: (p) => pids.push(p),
  });
  assert.equal(r.exit, 0);
  assert.equal(pids.length, 1);
  assert.ok(Number.isInteger(pids[0]));
  assert.ok(r.tail.toLowerCase().includes(path.basename(wt).toLowerCase()), r.tail);
  assert.ok(fs.existsSync(path.join(wt, ".codex-tmp", "r2", "check-1.cmd")));
}));

test("sandboxCheck: a timeout kills the whole tree and reports exit null", withRepo(async (repo) => {
  const pidFile = path.join(repo, ".codex-tmp", "sleeper.pid");
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const t0 = Date.now();
  const r = await sandboxCheck({
    bin, cwd: repo, runId: "r3", n: 1, cmd: sleeper(pidFile), timeoutMs: 4000,
  });
  assert.equal(r.timeout, true);
  assert.equal(r.exit, null);
  assert.ok(Date.now() - t0 < 20000);
  assert.ok(fs.existsSync(pidFile), "the check process did start");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(await waitGone(pid), "the check's own process is gone");
}));

test("sandboxCheck: a missing binary gives exit null and an explaining tail", withRepo(async (repo) => {
  const r = await sandboxCheck({
    bin: { cmd: path.join(repo, "no-such-codex.exe"), args: [] }, cwd: repo, runId: "r4", n: 1, cmd: "echo hi",
  });
  assert.equal(r.exit, null);
  assert.equal(r.timeout, undefined);
  assert.match(r.tail, /spawn/i);
}));

test("hostCheck: onStart before spawn, onPid after, host:true, exit and tail", withRepo(async (repo) => {
  const events = [];
  const r = await hostCheck({
    cwd: repo, runId: "h1", n: 1, cmd: 'echo "a b" & exit /b 4',
    onStart: () => events.push("start"), onPid: (p) => events.push("pid:" + typeof p),
  });
  assert.deepEqual(events, ["start", "pid:number"]);
  assert.equal(r.host, true);
  assert.equal(r.exit, 4);
  assert.match(r.tail, /"a b"/);
  assert.equal(
    fs.readFileSync(path.join(repo, ".codex-tmp", "h1", "check-1.cmd"), "utf8"),
    '@echo off\r\necho "a b" & exit /b 4\r\nexit /b %ERRORLEVEL%\r\n',
  );
}));

test("hostCheck: worktree path with a space and & in the command", withRepo(async (repo) => {
  const wt = path.join(path.dirname(repo), "lane a&b (x)");
  execFileSync("git", ["worktree", "add", "-q", "-b", "laneamp", wt], { cwd: repo, windowsHide: true });
  const r = await hostCheck({ cwd: wt, runId: "h2", n: 1, cmd: "cd & echo a&echo b" });
  assert.equal(r.exit, 0);
  assert.ok(r.tail.toLowerCase().includes("lane a&b (x)"), r.tail);
  assert.ok(r.tail.endsWith("a\nb"), JSON.stringify(r.tail));
}));

test("hostCheck: timeout kills the tree", withRepo(async (repo) => {
  const pidFile = path.join(os.tmpdir(), `cdx-host-${process.pid}-${Date.now()}.pid`);
  try {
    const r = await hostCheck({ cwd: repo, runId: "h3", n: 1, cmd: sleeper(pidFile), timeoutMs: 4000 });
    assert.equal(r.timeout, true);
    assert.equal(r.exit, null);
    assert.equal(r.host, true);
    assert.ok(fs.existsSync(pidFile));
    assert.ok(await waitGone(Number(fs.readFileSync(pidFile, "utf8"))));
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
}));

test("hostCheck: onStart throwing prevents the spawn", withRepo(async (repo) => {
  await assert.rejects(
    hostCheck({ cwd: repo, runId: "h4", n: 1, cmd: "echo hi", onStart: () => { throw new Error("no record"); } }),
    /no record/,
  );
}));
