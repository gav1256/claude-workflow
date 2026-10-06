// A stand-in for a codex-run controller that the test then kills (addendum section 8.2).
//   node crash-controller.mjs <mode> <cwd> <outFile> --tree <head>:<hash> [--add-child [<pid>]]
// Env: the test's (same pipe prefix, CLAUDE_CONFIG_DIR, CODEX_RUN_PROCS, FAKE_CODEX_SCENARIO).
// It takes the worktree pipe and a slot pipe (both must be clear), writes both records `active` with
// itself as the owner, writes <outFile> (JSON: ownerPid, runId, runDir, wtRecord, slotRecord + mode pids), then:
//   exec-detached  spawns the fake `codex exec` (detached, hidden, stdin piped then ended; args tag the run id
//                  through `-o <runDir>\last.json`); adds codexPid; records it with addChild only with
//                  --add-child; idles until killed.
//   host           markHostStarted, writes TMP\<runId>\check-1.cmd (PING -n 60), runs it with cmd.exe (not
//                  detached), addChild(cmd pid) on both records, adds cmdPid; idles.
//   active-exit    optional `--add-child <pid>`; exits 0 at once without writeClean (a stale active record).
// The test kills it with process.kill(ownerPid) (TerminateProcess); the OS frees its pipes.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson, canonPath, newRunId, runDir } from "../lib/paths.mjs";
import { resolveCodex } from "../lib/binary.mjs";
import { cmdFileText } from "../lib/argv.mjs";
import { startTime } from "../lib/procs.mjs";
import { acquireSlot, acquireWorktree, addChild, markHostStarted, writeActive } from "../lib/locks.mjs";

const [mode, cwd, outFile, ...rest] = process.argv.slice(2);
const flagVal = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const die = (msg, code = 5) => {
  process.stderr.write(`crash-controller: ${msg}\n`);
  process.exit(code);
};
if (!["exec-detached", "host", "active-exit"].includes(mode) || !cwd || !outFile) die("usage: <mode> <cwd> <outFile> --tree <head>:<hash>", 2);
const tree = /^([0-9a-f]{40}):([0-9a-f]{64})$/.exec(flagVal("--tree") ?? "");
if (!tree) die("--tree <40-hex head>:<64-hex hash> is required", 2);
const [, HEAD, HASH] = tree;
const ai = rest.indexOf("--add-child");
const addChildFlag = ai >= 0;
const addChildPid = addChildFlag && /^\d+$/.test(rest[ai + 1] ?? "") ? Number(rest[ai + 1]) : undefined;

const treeState = () => ({ head: HEAD, hash: HASH });
const w = await acquireWorktree(cwd, { treeState });
if (!w.server) die(`worktree not clear: ${JSON.stringify(w)}`);
const s = await acquireSlot({});
if (!s.server) die(`slot not clear: ${JSON.stringify(s)}`);

const runId = newRunId();
const dir = runDir(runId);
const startedAt = startTime(process.pid);
if (!startedAt) die("startTime(self) is null");
const rec = {
  cwd: canonPath(cwd), run_id: runId, run_dir: dir, owner_pid: process.pid, owner_start_time: startedAt,
  child_pids: [], host_started: false, baseline: HEAD, tree_hash_pre: HASH, tree_hash_final: null,
};
writeActive(w.recordPath, rec);
writeActive(s.recordPath, rec);

const out = { ownerPid: process.pid, runId, runDir: dir, wtRecord: w.recordPath, slotRecord: s.recordPath };
const publish = (extra = {}) => {
  Object.assign(out, extra);
  atomicWriteJson(outFile, out);
};
const record = (pid) => {
  addChild(w.recordPath, pid);
  addChild(s.recordPath, pid);
};
publish();

if (mode === "exec-detached") {
  const bin = resolveCodex();
  const child = spawn(bin.cmd, [...bin.args, "exec", "-C", cwd, "-o", path.join(dir, "last.json")], {
    detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
  });
  child.on("error", () => {});
  if (child.pid === undefined) die("spawn of the fake failed");
  child.stdin.end();
  child.unref();
  if (addChildFlag) record(child.pid);
  publish({ codexPid: child.pid });
  setInterval(() => {}, 1000);
} else if (mode === "host") {
  markHostStarted(w.recordPath);
  markHostStarted(s.recordPath);
  const tmp = path.join(cwd, ".codex-tmp", runId);
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, "check-1.cmd");
  fs.writeFileSync(file, cmdFileText("C:\\Windows\\System32\\PING.EXE -n 60 127.0.0.1 >nul"));
  const cmd = spawn("C:\\Windows\\System32\\cmd.exe", ["/d", "/c", file], { windowsHide: true, stdio: "ignore" });
  cmd.on("error", () => {});
  if (cmd.pid === undefined) die("spawn of cmd.exe failed");
  record(cmd.pid);
  publish({ cmdPid: cmd.pid });
  setInterval(() => {}, 1000);
} else {
  if (addChildPid !== undefined) record(addChildPid);
  process.exit(0);
}
