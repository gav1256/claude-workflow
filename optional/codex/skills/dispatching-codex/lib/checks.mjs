// Check runners for write mode (spec Part 2 step 4, plan Task 7).
//  - sandboxCheck: `codex sandbox -P :workspace ... -- cmd.exe /d /c <check-N.cmd>`, no model call.
//  - hostCheck: the same .cmd file run by cmd.exe outside the sandbox (explicit --check-host opt-in).
// Both write a `check-<n>.cmd` file (so quotes and & survive), enforce a timeout with a tree kill, and return the last 300
// characters of stdout+stderr. The sandbox check's file is `<cwd>\.codex-tmp\<runId>\check-<n>.cmd` (it runs inside the sandbox
// anyway); the host check's file is in the host-only run folder (runDir(runId)), which the sandbox is denied (B3-2: a sandbox
// process must not be able to rewrite a file the host then executes).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cmdFileText, sandboxArgs } from "./argv.mjs";
import { mkdirNoLink, writeNew, runDir } from "./paths.mjs";

const TAIL_CHARS = 300;
const KEEP_BYTES = 64 * 1024; // rolling output buffer
const KILL_GRACE_MS = 5000;

// Local `taskkill /T /F /PID` (plan Task 5's procs.killTree has the same contract; this module does not
// depend on it so Task 7 stands alone).
function killTree(pid) {
  const r = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// I2: Codex can write into .codex-tmp, so the host writes the check file create-only (`wx`: a pre-planted file or symlink makes
// it fail, never a write through the link) into a run folder that is not a link. Both failures throw `code: "ELINKED"`
// (the caller blocks the run).
// `dir` is `<cwd>\.codex-tmp\<runId>` for a sandbox check and runDir(runId) for a host check.
function writeCheckFile(dir, n, cmd) {
  mkdirNoLink(dir);
  const file = path.join(dir, `check-${n}.cmd`);
  try {
    writeNew(file, cmdFileText(cmd));
  } catch (e) {
    if (e.code === "EEXIST") throw Object.assign(new Error(`linked-path: check file already exists: check-${n}.cmd`), { code: "ELINKED" });
    throw e;
  }
  return file;
}

const tailOf = (buf) => buf.toString("utf8").replace(/\r\n/g, "\n").trimEnd().slice(-TAIL_CHARS);

/** Spawn, collect output, enforce the timeout. Resolves { exit, tail, timeout? }; never rejects. */
function run(file, args, { cwd, timeoutMs, onPid, verbatim = false, env }) {
  return new Promise((resolve) => {
    const chunks = [];
    let kept = 0;
    let timedOut = false;
    let done = false;
    let timer;
    let graceTimer;
    const finish = (exit, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      const r = { exit, tail: extra ? extra : tailOf(Buffer.concat(chunks)) };
      if (timedOut) { r.exit = null; r.timeout = true; }
      resolve(r);
    };
    const onData = (d) => {
      chunks.push(d);
      kept += d.length;
      while (kept > KEEP_BYTES && chunks.length > 1) kept -= chunks.shift().length;
    };
    let child;
    try {
      child = spawn(file, args, {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: verbatim, ...(env ? { env } : {}),
      });
    } catch (e) {
      finish(null, `spawn error: ${e.message}`);
      return;
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => finish(null, `spawn error: ${e.message}`));
    child.on("close", (code) => finish(code));
    if (child.pid !== undefined && onPid) onPid(child.pid);
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      graceTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
    }, timeoutMs);
  });
}

/** `bin` is resolveCodex()'s `{ cmd, args }` (or a plain executable path). */
export async function sandboxCheck({ bin, cwd, runId, n, cmd, timeoutMs = 600000, onPid, env }) {
  const { cmd: exe, args: pre = [] } = typeof bin === "string" ? { cmd: bin, args: [] } : bin;
  const cmdFile = writeCheckFile(path.join(cwd, ".codex-tmp", String(runId)), n, cmd);
  const r = await run(exe, [...pre, ...sandboxArgs({ profile: ":workspace", cwd, cmdFile })], { cwd, timeoutMs, onPid, env });
  return { cmd, ...r };
}

/**
 * Runs outside the sandbox; `onStart()` is called right before the spawn (the caller writes `host_started`). The check file is
 * written to the host-only run folder (never under the sandbox-writable .codex-tmp); the check's cwd is still the worktree.
 */
export async function hostCheck({ cwd, runId, n, cmd, timeoutMs = 600000, onStart, onPid }) {
  const cmdFile = writeCheckFile(runDir(runId), n, cmd);
  if (onStart) onStart();
  // /s strips the outer pair of quotes, so the path is wrapped twice; verbatim, so node adds no quoting: survives spaces, `&` and parentheses in the worktree path
  const r = await run(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", `""${cmdFile}""`], {
    cwd, timeoutMs, onPid, verbatim: true,
  });
  return { cmd, ...r, host: true };
}
