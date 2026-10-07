import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FAKE_CODEX, makeRepo, addWorktree, rmrf, tmpEnv } from "./helpers.mjs";

// Host checks write into runDir(runId) under CLAUDE_CONFIG_DIR/state/codex/runs: point it at a temp folder before paths.mjs loads.
const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
const { sandboxCheck, hostCheck } = await import("../lib/checks.mjs");
const { runDir } = await import("../lib/paths.mjs");
after(() => env.cleanup());

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
    fs.readFileSync(path.join(runDir("h1"), "check-1.cmd"), "utf8"),
    '@echo off\r\necho "a b" & exit /b 4\r\nexit /b %ERRORLEVEL%\r\n',
  );
  assert.equal(fs.existsSync(path.join(repo, ".codex-tmp", "h1", "check-1.cmd")), false, "nothing under the sandbox-writable .codex-tmp");
}));

// B3-2: a host check file lives in the host-only run folder (the sandbox is denied there), never in .codex-tmp; cwd stays the worktree.
test("hostCheck: the .cmd is written under runDir(runId), not .codex-tmp, and the check runs with cwd = worktree", withRepo(async (repo) => {
  const wt = addWorktree(repo, "hostlane");
  const r = await hostCheck({ cwd: wt, runId: "hd1", n: 2, cmd: "cd" });
  assert.equal(r.exit, 0);
  assert.ok(r.tail.toLowerCase().includes(path.basename(wt).toLowerCase()), r.tail);
  const file = path.join(runDir("hd1"), "check-2.cmd");
  assert.ok(fs.existsSync(file), file);
  assert.ok(path.resolve(file).startsWith(path.resolve(env.CLAUDE_CONFIG_DIR) + path.sep));
  assert.equal(fs.existsSync(path.join(wt, ".codex-tmp")), false, "hostCheck creates no .codex-tmp");
}));

test("hostCheck: a file planted at the old .codex-tmp path is not executed", withRepo(async (repo) => {
  const marker = path.join(path.dirname(repo), "planted-ran.txt");
  const planted = path.join(repo, ".codex-tmp", "hp1", "check-1.cmd");
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, `@echo off\r\necho planted> "${marker}"\r\n`);
  const r = await hostCheck({ cwd: repo, runId: "hp1", n: 1, cmd: "echo real" });
  assert.equal(r.exit, 0);
  assert.match(r.tail, /real/);
  assert.equal(fs.existsSync(marker), false, "the planted file never ran");
  assert.match(fs.readFileSync(planted, "utf8"), /planted/, "and was left untouched");
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

// I2: the host writes the check file create-only; a symlink pre-planted at the path (Codex can plant one in .codex-tmp) makes the
// check refuse, and the link's target is untouched. A symlink needs Developer Mode or admin: without it the tests skip.
function plantFileLink(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (e) {
    if (e.code === "EPERM") { console.log(`# skipped: no symlink privilege (${e.code})`); return false; }
    throw e;
  }
}

// `folder(repo, id)` is where that runner writes its check files (sandbox: .codex-tmp\<id>, host: the run folder).
for (const [name, run, folder] of [
  ["sandboxCheck", (repo, runId) => sandboxCheck({ bin, cwd: repo, runId, n: 1, cmd: "echo ran" }),
    (repo, id) => path.join(repo, ".codex-tmp", id)],
  ["hostCheck", (repo, runId) => hostCheck({ cwd: repo, runId, n: 1, cmd: "echo ran", onStart: () => { started = true; } }),
    (repo, id) => path.join(path.dirname(runDir("probe-" + id)), id)],
]) {
  let started = false;
  test(`I2: ${name} refuses a pre-planted symlink at the check path; the target is unchanged`, withRepo(async (repo) => {
    started = false;
    const target = path.join(path.dirname(repo), "victim.txt");
    fs.writeFileSync(target, "keep\n");
    if (!plantFileLink(path.join(folder(repo, "l1"), "check-1.cmd"), target)) return;
    await assert.rejects(run(repo, "l1"), (e) => e.code === "ELINKED" && /linked-path/.test(e.message));
    assert.equal(started, false, "nothing ran");
    assert.equal(fs.readFileSync(target, "utf8"), "keep\n", "the host wrote nothing through the link");
  }));

  test(`I2: ${name} refuses a run folder that is a symlink (lstat after mkdir)`, withRepo(async (repo) => {
    const target = path.join(path.dirname(repo), "victim-dir");
    fs.mkdirSync(target);
    fs.mkdirSync(path.dirname(folder(repo, "l2")), { recursive: true });
    try {
      fs.symlinkSync(target, folder(repo, "l2"), "dir");
    } catch (e) {
      if (e.code === "EPERM") { console.log("# skipped: no symlink privilege"); return; }
      throw e;
    }
    await assert.rejects(run(repo, "l2"), (e) => e.code === "ELINKED");
    assert.deepEqual(fs.readdirSync(target), [], "nothing written through the folder link");
  }));
}

test("hostCheck: onStart throwing prevents the spawn", withRepo(async (repo) => {
  await assert.rejects(
    hostCheck({ cwd: repo, runId: "h4", n: 1, cmd: "echo hi", onStart: () => { throw new Error("no record"); } }),
    /no record/,
  );
}));
