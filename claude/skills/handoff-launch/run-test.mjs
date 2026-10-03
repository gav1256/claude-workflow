// Runs a fan-out group's test command with a hard timeout that kills the whole process tree. spawnSync's own timeout
// kills only the shell, and on Windows a surviving grandchild keeps the output pipe open, so the caller would hang.
// Usage: node run-test.mjs <cwd> <timeout ms> <log file> <command>. Exit code: the command's, or 124 on timeout.
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const [cwd, ms, log, cmd] = process.argv.slice(2);
const out = fs.openSync(log, "w");
const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", out, out], detached: process.platform !== "win32" });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  fs.writeSync(out, `\n[run-test] timed out after ${Math.round(Number(ms) / 1000)} s - process tree killed\n`);
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
  else try { process.kill(-child.pid, "SIGKILL"); } catch {}
}, Number(ms));
child.on("error", (e) => { fs.writeSync(out, `\n[run-test] ${e.message}\n`); });
child.on("close", (code) => { clearTimeout(timer); process.exit(timedOut ? 124 : code ?? 1); });
