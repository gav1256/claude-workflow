// The one module of the coordinator process that writes files. Every write goes through an allowlist of relative
// paths under the state folder, with every folder checked as a real (non-link) folder and the real path compared.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.mjs";

export class StoreError extends Error {}

const LEDGERS = new Set(["exchanges", "dispatch", "usage", "workers", "codex-attempts"]);
const RULES = [
  /^coordinator_records\.md$/,
  /^(exchanges|dispatch|usage|workers|codex-attempts)\.jsonl$/,
  /^instance\.json$/,
  /^briefs\/[a-z0-9][a-z0-9.-]{0,79}\.md$/,
  /^messages\/[0-9a-f]{16}\/[0-9a-f]{32}(\.delivered)?\.json$/,
  /^codex-out\/[a-z0-9][a-z0-9.-]{0,79}\.(out|err)$/,
];
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i; // Windows device names, whatever the extension
const MSG_FILE = /^messages\/([0-9a-f]{16})\/([0-9a-f]{32})\.json$/;
const MSG_DELIVERED = /^messages\/([0-9a-f]{16})\/([0-9a-f]{32})\.delivered\.json$/;
const win = process.platform === "win32";
const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

function root() {
  const s = stateDir();
  fs.mkdirSync(s, { recursive: true });
  return fs.realpathSync.native(s);
}

export function resolveAllowed(rel, { moveSource = false } = {}) { // moveSource: rename sources and writeNew targets are never written through
  if (typeof rel !== "string" || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new StoreError(`bad path: ${JSON.stringify(rel)}`);
  }
  if (!RULES.some((r) => r.test(rel))) throw new StoreError(`not in the allowlist: ${rel}`);
  if (rel.split("/").some((p) => DEVICE.test(p.split(".")[0]))) throw new StoreError(`device name: ${rel}`);
  const base = root(), parts = rel.split("/");
  let cur = base;
  for (const part of parts.slice(0, -1)) { // every folder below the root: a real folder, never a link
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) {
      if (e.code !== "ENOENT") throw e;
      try { fs.mkdirSync(cur); } catch (e2) { if (e2.code !== "EEXIST") throw e2; } // lost a race: re-check below
      st = fs.lstatSync(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new StoreError(`link or non-folder in path: ${rel}`);
    if (!same(fs.realpathSync.native(cur), cur)) throw new StoreError(`path escapes the state folder: ${rel}`);
  }
  const target = path.join(cur, parts.at(-1));
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new StoreError(`target is a link or not a file: ${rel}`);
    if (st.nlink > 1 && !moveSource) throw new StoreError(`target has more than one hard link: ${rel}`);
    if (!same(fs.realpathSync.native(target), target)) throw new StoreError(`target escapes the state folder: ${rel}`);
  } catch (e) { if (e instanceof StoreError) throw e; if (e.code !== "ENOENT") throw e; }
  return target;
}

export function appendJsonl(name, obj) {
  if (!LEDGERS.has(name)) throw new StoreError(`unknown ledger ${name}`);
  const f = resolveAllowed(`${name}.jsonl`);
  let lead = "";
  try { // a torn last line (no newline) must not swallow the next record
    const size = fs.statSync(f).size;
    if (size > 0) {
      const fd = fs.openSync(f, "r"), b = Buffer.alloc(1);
      try { fs.readSync(fd, b, 0, 1, size - 1); } finally { fs.closeSync(fd); }
      if (b[0] !== 10) lead = "\n";
    }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  fs.appendFileSync(f, lead + JSON.stringify(obj) + "\n");
}

export function writeAtomic(rel, text) {
  const f = resolveAllowed(rel), tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, f); return; } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

const TEMP_SUFFIX = /\.\d+\.\d+(\.[a-z0-9]{1,8})?\.tmp$/;
/** Removes temp files of our own pattern, older than 60 s, left in the folder by a crash (they hold a second link). */
function sweepStaleTemps(rel, f) {
  const dir = path.dirname(f), relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  let names; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!TEMP_SUFFIX.test(n) || !RULES.some((r) => r.test(relDir + n.replace(TEMP_SUFFIX, "")))) continue;
    const p = path.join(dir, n);
    try { const st = fs.lstatSync(p); if (st.isFile() && Date.now() - st.mtimeMs > 60000) fs.rmSync(p, { force: true }); } catch { /* raced or busy: next time */ }
  }
}

/**
 * Creates the file atomically: the content goes to a temp file in the same checked folder, then a hard link gives it
 * its name, so the name never exists empty or partial. Returns false when it already exists (idempotency); the first
 * content is kept. The temp file is always removed. Needs hard-link support (NTFS; not FAT/exFAT).
 */
export function writeNew(rel, text) {
  const f = resolveAllowed(rel, { moveSource: true }); // an existing name is never written through (link gives EEXIST)
  sweepStaleTemps(rel, f);
  const tmp = `${f}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: "wx" });
    fs.linkSync(tmp, f);
    return true;
  } catch (e) { if (e.code === "EEXIST") return false; throw e; } finally { fs.rmSync(tmp, { force: true }); }
}

/** An fd for a child's stdio. The caller closes it with closeOut. */
export const openOut = (rel) => fs.openSync(resolveAllowed(rel), "w");

/** Closes an fd from openOut (a close only: no new write path). A bad or already closed fd is ignored. */
export function closeOut(fd) {
  try { fs.closeSync(fd); } catch { /* already closed */ }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Only the delivery claim: messages/<key>/<rid>.json -> messages/<key>/<rid>.delivered.json. The claim is exclusive: a hard
 * link creates the claimed name (only one process can create it; the others get EEXIST, or ENOENT when the source is already
 * gone, and throw without touching the source), then the pending name is unlinked. A plain rename can succeed for several
 * processes at once on Windows. A failed unlink after the link never throws: the claim stands.
 *
 * Invariant for the leftover (both names are one file after a failed unlink): the claimed name holds the content and marks the
 * request as handed over, so the hook skips a pending name beside it. A later hook run (or message()) drops that pending leftover
 * through dropDuplicate; it never frees a slot by touching the claimed name. unclaim, the one re-queue, does the opposite for the
 * same-file case: it drops the claimed name so the pending name is the single surviving name.
 */
export function rename(from, to) {
  const m = MSG_FILE.exec(from);
  if (!m || to !== `messages/${m[1]}/${m[2]}.delivered.json`) throw new StoreError(`rename not allowed: ${from} -> ${to}`);
  const src = resolveAllowed(from, { moveSource: true }), dst = resolveAllowed(to);
  fs.linkSync(src, dst); // the claim: throws for every process but one
  for (let i = 0; ; i++) {
    try { fs.unlinkSync(src); return; } catch (e) {
      if (e.code === "ENOENT") return;
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) return; // the claim stands; a later hook run drops the pending leftover (dropDuplicate, same-file case)
      sleepMs(50);
    }
  }
}

/** True when both names resolve to one file (hard links of the same inode). Either name missing: false. */
function sameFile(a, b) {
  try { const x = fs.statSync(a, { bigint: true }), y = fs.statSync(b, { bigint: true }); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}

/**
 * Only the re-queue of a claimed message: messages/<key>/<rid>.delivered.json -> messages/<key>/<rid>.json. When the pending name
 * already is the same file (a claim whose unlink never happened) there is nothing to move: the claimed name is unlinked instead,
 * so the pending name is the single surviving name (the hook skips a rid whose claimed name exists, so keeping both would strand
 * the message and fill a hook slot forever). Never loses the content: the pending name stays.
 */
export function unclaim(from, to) {
  const m = MSG_DELIVERED.exec(from);
  if (!m || to !== `messages/${m[1]}/${m[2]}.json`) throw new StoreError(`unclaim not allowed: ${from} -> ${to}`);
  const src = resolveAllowed(from, { moveSource: true }), dst = resolveAllowed(to, { moveSource: true });
  if (sameFile(src, dst)) { fs.unlinkSync(src); return; }
  fs.renameSync(src, dst);
}

/**
 * Removes a pending message file (messages/<key>/<rid>.json) only while its claimed copy (<rid>.delivered.json) exists: the
 * request was already handed over, so the pending copy is a duplicate. Never removes the only copy; an absent file is fine. When both
 * names are one file (a claim whose unlink failed) the claimed name holds the content, so the pending name is the leftover and is
 * unlinked: the message is neither lost (the claimed name stays) nor delivered twice (the hook skips a pending name beside a claimed
 * one, and a re-queue goes through unclaim, which removes the claimed name instead). Residual window: an unclaim running at the
 * same instant on the same rid could unlink the claimed name after this unlink; unclaim runs only in the sender that made the claim.
 */
export function dropDuplicate(rel) {
  const m = MSG_FILE.exec(rel);
  if (!m) throw new StoreError(`dropDuplicate not allowed: ${rel}`);
  const pending = resolveAllowed(rel, { moveSource: true }), claimed = resolveAllowed(`messages/${m[1]}/${m[2]}.delivered.json`, { moveSource: true });
  try { fs.statSync(pending); fs.statSync(claimed); } catch { return; } // either name gone: nothing to drop (the only copy stays)
  try { fs.unlinkSync(pending); } catch (e) { if (e.code !== "ENOENT") throw e; }
}

/** The only way model-derived content reaches a file: coordinator_records.md, at most 16 KiB. */
export function writeRecords(markdown) {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 16384) throw new StoreError("records too large");
  writeAtomic("coordinator_records.md", markdown);
}

export function readJsonl(name) {
  if (!LEDGERS.has(name)) throw new StoreError(`unknown ledger ${name}`);
  const f = resolveAllowed(`${name}.jsonl`);
  let t = ""; try { t = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return t.split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}
