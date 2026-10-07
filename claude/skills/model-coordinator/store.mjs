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
const win = process.platform === "win32";
const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

function root() {
  const s = stateDir();
  fs.mkdirSync(s, { recursive: true });
  return fs.realpathSync.native(s);
}

export function resolveAllowed(rel) {
  if (typeof rel !== "string" || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new StoreError(`bad path: ${JSON.stringify(rel)}`);
  }
  if (!RULES.some((r) => r.test(rel))) throw new StoreError(`not in the allowlist: ${rel}`);
  const base = root(), parts = rel.split("/");
  let cur = base;
  for (const part of parts.slice(0, -1)) { // every folder below the root: a real folder, never a link
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== "ENOENT") throw e; fs.mkdirSync(cur); st = fs.lstatSync(cur); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new StoreError(`link or non-folder in path: ${rel}`);
    if (!same(fs.realpathSync.native(cur), cur)) throw new StoreError(`path escapes the state folder: ${rel}`);
  }
  const target = path.join(cur, parts.at(-1));
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new StoreError(`target is a link or not a file: ${rel}`);
    if (!same(fs.realpathSync.native(target), target)) throw new StoreError(`target escapes the state folder: ${rel}`);
  } catch (e) { if (e instanceof StoreError) throw e; if (e.code !== "ENOENT") throw e; }
  return target;
}

export function appendJsonl(name, obj) {
  if (!LEDGERS.has(name)) throw new StoreError(`unknown ledger ${name}`);
  fs.appendFileSync(resolveAllowed(`${name}.jsonl`), JSON.stringify(obj) + "\n");
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

/** Creates the file with `wx`. Returns false when it already exists (idempotency); the first content is kept. */
export function writeNew(rel, text) {
  try { fs.writeFileSync(resolveAllowed(rel), text, { flag: "wx" }); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; }
}

/** An fd for a child's stdio. The caller closes it. */
export const openOut = (rel) => fs.openSync(resolveAllowed(rel), "w");

export function rename(from, to) { fs.renameSync(resolveAllowed(from), resolveAllowed(to)); }

/** The only way model-derived content reaches a file: coordinator_records.md, at most 16 KiB. */
export function writeRecords(markdown) {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 16384) throw new StoreError("records too large");
  writeAtomic("coordinator_records.md", markdown);
}

export function readJsonl(name) {
  if (!LEDGERS.has(name)) throw new StoreError(`unknown ledger ${name}`);
  let t = ""; try { t = fs.readFileSync(path.join(stateDir(), `${name}.jsonl`), "utf8"); } catch { return []; }
  return t.split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}
