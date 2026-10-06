// Paths and small file helpers shared by every codex-run module.
// All values come from the environment at import time (os.homedir(), CLAUDE_CONFIG_DIR,
// CODEX_HOME, ...), never from hard-coded user paths. Importing this file writes nothing.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

export const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const STATE = path.join(CFG, "state", "codex");
export const USAGE_DIR = path.join(CFG, "state", "coord", "usage");
export const PACE = path.join(CFG, "state", "coord", "pace.json");
export const LEDGER = path.join(STATE, "runs.jsonl");
export const LAST_USAGE = path.join(STATE, "last-usage.json");
export const TESTED_VERSION = path.join(STATE, "tested-version");
export const ACL_STATE = path.join(STATE, "acl-scan.json");
export const WT_LOCKS = path.join(STATE, "worktree-locks");
export const SLOT_LOCKS = path.join(STATE, "slot-locks");
export const PIPE_PREFIX = process.env.CODEX_RUN_PIPE_PREFIX || "codex-run-";
export const HL_DIR = process.env.HL_SKILL_DIR || path.join(CFG, "skills", "handoff-launch");
export const REAL_TEMP = process.env.CODEX_RUN_TEMP || os.tmpdir();

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** STATE/runs/<runId>, created. Rejects ids that could escape the runs folder. */
export function runDir(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId) || runId.includes("..")) {
    throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  }
  const dir = path.join(STATE, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** "20261006T101500Z-a1b2c3" (UTC time, 3 random bytes in hex). */
export function newRunId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * One canonical spelling per existing path, so the same worktree spelled `C:\X\wt`, `c:/x/wt/`,
 * `\\?\C:\X\wt` or by its 8.3 short name maps to one lock pipe and one record.
 * Throws on a missing path (realpathSync.native does): callers turn that into `cwd-missing`
 * before any pipe is taken. Drive roots keep their one separator (`c:\`).
 */
export function canonPath(p) {
  return normalizeCanon(fs.realpathSync.native(p));
}

/** The pure string half of canonPath: strip `\\?\` / `\\?\UNC\`, use backslashes, trim, lower-case. */
export function normalizeCanon(raw) {
  let r = raw;
  if (r.startsWith("\\\\?\\UNC\\")) r = "\\\\" + r.slice(8);
  else if (r.startsWith("\\\\?\\")) r = r.slice(4);
  r = r.replace(/\//g, "\\");
  const isRoot = /^[A-Za-z]:\\$/.test(r);
  if (!isRoot) r = r.replace(/\\+$/, "");
  return r.toLowerCase();
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// An antivirus scan or an open handle can fail a write or a rename for a moment: up to 5 retries, 100 ms apart, on
// EPERM / EBUSY / EACCES only; anything else (and the sixth failure) is thrown as is.
function retrySync(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
      sleepSync(100);
    }
  }
}

/** Write JSON to a temp file in the same folder, then rename over the target (both steps retried; the temp file is removed on failure). */
export function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const text = JSON.stringify(obj, null, 2) + "\n";
  try {
    retrySync(() => fs.writeFileSync(tmp, text));
    retrySync(() => fs.renameSync(tmp, file));
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}
