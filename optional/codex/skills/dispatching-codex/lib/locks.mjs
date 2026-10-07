// Pipe locks, write-ahead records and the crash quarantine (addendum sections 4 and 5).
// The lock is a named pipe (an OS object freed when its holder dies, however it dies); the record next to it
// says what a dead holder left behind. A run takes the worktree pipe, then a slot pipe, and writes both records
// `active` before it spawns anything.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { WT_LOCKS, SLOT_LOCKS, PIPE_PREFIX, canonPath, atomicWriteJson } from "./paths.mjs";
import { resolveCodex } from "./binary.mjs";
import { listProcs, procFindings, killTree, startTime, listerVerified } from "./procs.mjs";

// paths.mjs does not export its run-id pattern (paths.mjs:24): the literal is duplicated here (addendum 4.2).
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const STAGE_TOKENS = new Set(["lister-not-run", "tree-not-checked"]);
const CONFIRM_MAX_AGE_MS = 30 * 60000;
const KNOWN_NAME_RE = /^(codex\.exe|codex-command-runner.*|cmd\.exe|conhost\.exe|ping\.exe)$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const msOf = (x) => {
  const n = Date.parse(x);
  return Number.isFinite(n) ? n : null;
};
const isPid = (n) => Number.isInteger(n) && n > 0;
const goodRunId = (id) => typeof id === "string" && RUN_ID_RE.test(id);

// ------------------------------------------------------------------------------- pipes

const heldNames = new Set(); // pipe names this process holds (busySlots counts only the others)
const nameOf = new WeakMap();

/** `\\.\pipe\<PIPE_PREFIX><name>`; resolves the listening server, or null when the name is taken. */
export function acquirePipe(name) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (e) => (e.code === "EADDRINUSE" ? resolve(null) : reject(e)));
    server.listen("\\\\.\\pipe\\" + PIPE_PREFIX + name, () => {
      server.on("error", () => {});
      server.unref(); // a forgotten release never keeps the process alive; the OS frees the pipe at exit
      heldNames.add(name);
      nameOf.set(server, name);
      resolve(server);
    });
  });
}

export async function releasePipe(server) {
  if (!server) return;
  heldNames.delete(nameOf.get(server));
  await new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
}

/** How many of slot-1..3 other processes hold right now (a probe takes and frees each free one). */
export async function busySlots() {
  let n = 0;
  for (const i of [1, 2, 3]) {
    const name = `slot-${i}`;
    if (heldNames.has(name)) continue;
    let s = await acquirePipe(name);
    if (s === null) { // another process's probe holds a free slot for a moment: look again once before counting it
      await sleep(150);
      s = await acquirePipe(name);
    }
    if (s === null) n++;
    else await releasePipe(s);
  }
  return n;
}

// ------------------------------------------------------------------------------- records

const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function kindOfPath(recordPath) {
  const dir = path.dirname(recordPath);
  if (sameDir(dir, WT_LOCKS)) return "worktree";
  if (sameDir(dir, SLOT_LOCKS)) return "slot";
  return null;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Writer temp files (`.<basename>.<pid>.<8 hex>.tmp`) next to the record: a writer died between write and rename. */
function tempFiles(recordPath) {
  const re = new RegExp(`^\\.${escRe(path.basename(recordPath))}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`);
  try {
    return fs.readdirSync(path.dirname(recordPath)).filter((n) => re.test(n)).map((n) => path.join(path.dirname(recordPath), n));
  } catch {
    return [];
  }
}
function deleteTemps(recordPath) {
  for (const f of tempFiles(recordPath)) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
}

// The first failing field of a record, or null.
function schemaField(r, kind) {
  if (r.v !== 1) return "v";
  if (r.state === "clean") return null;
  if (r.state !== "active") return "state";
  if (r.kind !== kind) return "kind";
  if (!goodRunId(r.run_id)) return "run_id";
  if (typeof r.run_dir !== "string") return "run_dir";
  if (!isPid(r.owner_pid)) return "owner_pid";
  if (typeof r.owner_start_time !== "string" || msOf(r.owner_start_time) === null) return "owner_start_time";
  if (!Array.isArray(r.child_pids) || !r.child_pids.every((c) => c && isPid(c.pid) && typeof c.at === "string")) return "child_pids";
  if (typeof r.host_started !== "boolean") return "host_started";
  if (typeof r.baseline !== "string" || !SHA_RE.test(r.baseline)) return "baseline";
  if (typeof r.tree_hash_pre !== "string" || !HASH_RE.test(r.tree_hash_pre)) return "tree_hash_pre";
  if (r.tree_hash_final !== null && !(typeof r.tree_hash_final === "string" && HASH_RE.test(r.tree_hash_final))) return "tree_hash_final";
  return null;
}

/**
 * `{prev, prevError, halfWritten}`. `prev` is the parsed object whenever the JSON parsed to an object (also when
 * validation fails); `prevError` is null, "unreadable", "invalid-json" or "invalid-schema:<field>".
 */
export function readRecord(recordPath) {
  const halfWritten = tempFiles(recordPath).length > 0;
  let text;
  try {
    text = fs.readFileSync(recordPath, "utf8");
  } catch (e) {
    return { prev: null, prevError: e.code === "ENOENT" ? null : "unreadable", halfWritten };
  }
  let prev;
  try { prev = JSON.parse(text); } catch { return { prev: null, prevError: "invalid-json", halfWritten }; }
  if (!prev || typeof prev !== "object" || Array.isArray(prev)) return { prev: null, prevError: "invalid-json", halfWritten };
  const field = schemaField(prev, kindOfPath(recordPath));
  return { prev, prevError: field ? `invalid-schema:${field}` : null, halfWritten };
}

// Whole-object write through atomicWriteJson, retried on the errors an antivirus scan or an open handle causes.
function writeObj(recordPath, obj) {
  for (let i = 0; ; i++) {
    try { atomicWriteJson(recordPath, obj); return; } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      sleepSync(100);
    }
  }
}

const nowIso = () => new Date().toISOString();
const keyOfRecord = (recordPath) => path.basename(recordPath, ".json");

/** `rec` carries cwd, run_id, run_dir, owner_pid, owner_start_time, baseline, tree_hash_pre (and optionally the rest). */
export function writeActive(recordPath, rec) {
  const kind = kindOfPath(recordPath);
  if (!kind) throw new Error("writeActive: the record is not in a lock folder");
  const obj = {
    v: 1, kind, key: keyOfRecord(recordPath), cwd: rec.cwd ?? null, run_id: rec.run_id, run_dir: rec.run_dir, state: "active",
    owner_pid: rec.owner_pid, owner_start_time: rec.owner_start_time,
    child_pids: (rec.child_pids ?? []).map((c) => ({ ...c })), host_started: rec.host_started ?? false,
    baseline: rec.baseline, tree_hash_pre: rec.tree_hash_pre, tree_hash_final: rec.tree_hash_final ?? null,
    updated_at: nowIso(),
  };
  const bad = schemaField(obj, kind);
  if (bad) throw new Error(`writeActive: invalid record field ${bad}`);
  writeObj(recordPath, obj);
}

function mutate(recordPath, fn) {
  const r = readRecord(recordPath);
  if (!r.prev || r.prevError || r.prev.state !== "active") {
    throw new Error(`record-${r.prevError ?? (r.prev ? "not-active" : "missing")}: ${path.basename(recordPath)}`);
  }
  const obj = { ...r.prev };
  fn(obj);
  obj.updated_at = nowIso();
  writeObj(recordPath, obj);
}

export function addChild(recordPath, pid) {
  if (!isPid(pid)) throw new TypeError(`addChild: pid must be a positive integer, got ${String(pid)}`);
  mutate(recordPath, (o) => { o.child_pids = [...o.child_pids, { pid, at: nowIso() }]; });
}
/** Written BEFORE the first --check-host spawn. */
export function markHostStarted(recordPath) {
  mutate(recordPath, (o) => { o.host_started = true; });
}
export function markTreeFinal(recordPath, hash) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new TypeError("markTreeFinal: hash must be 64 hex characters");
  mutate(recordPath, (o) => { o.tree_hash_final = hash; });
}

/** state "clean" (the rest of the object is kept); throws when the record is active for another run. */
export function writeClean(recordPath, runId, extra = {}) {
  const { prev } = readRecord(recordPath);
  const cur = prev && typeof prev === "object" ? prev : null;
  if (cur && cur.state === "active" && (cur.run_id ?? null) !== (runId ?? null)) {
    throw new Error(`writeClean: the record is active for run ${cur.run_id}`);
  }
  const obj = { ...(cur ?? {}) };
  delete obj.cleared_by;
  Object.assign(obj, {
    v: 1, kind: obj.kind ?? kindOfPath(recordPath), key: obj.key ?? keyOfRecord(recordPath), state: "clean",
    run_id: runId ?? null, updated_at: nowIso(), ...extra,
  });
  writeObj(recordPath, obj);
}

// ------------------------------------------------------------------------------- the quarantine decision (pure)

/** Addendum 4.3. `found` keeps the table's order; the stage tokens (`lister-not-run`, `tree-not-checked`) mean "not looked at yet". */
export function quarantine({ kind, prev, prevError = null, halfWritten = false, procs = null, tree = null, selfPid = process.pid }) {
  if (!prevError && !prev && !halfWritten) return { clear: true, verdict: "no-record", found: [] };
  if (!prevError && prev && prev.state === "clean") return { clear: true, verdict: "clean", found: [] };
  const found = [];
  const valid = !prevError && !!prev;
  if (prevError) found.push(`record-${prevError}`);
  if (halfWritten) found.push("record-half-written");
  if (valid && prev.host_started) found.push("host-check-started");
  if (procs === null) found.push("lister-not-run");
  else if (!procs.ok) found.push(`lister-blind:${procs.error}`);
  else if (procs.scope !== "full") found.push("lister-partial");
  else {
    const runId = goodRunId(prev?.run_id) ? prev.run_id : null;
    for (const f of procFindings({ rec: valid ? prev : null, rows: procs.rows, selfPid, listerPid: procs.listerPid, runId, mode: "quarantine" })) {
      found.push(f.text);
    }
  }
  if (kind === "worktree" && valid) {
    if (tree === null) found.push("tree-not-checked");
    else if (tree.error) found.push(`tree-unknown:${tree.error}`);
    else if (tree.head !== prev.baseline) found.push("head-moved");
    else if (![prev.tree_hash_pre, prev.tree_hash_final].filter(Boolean).includes(tree.hash)) found.push("tree-changed");
  }
  return found.length === 0
    ? { clear: true, verdict: "auto", found }
    : { clear: false, verdict: "quarantined", found };
}

// ------------------------------------------------------------------------------- acquire (the caller's staging, 4.4)

function verify(bin) {
  try { return listerVerified(bin ?? resolveCodex()); } catch { return { ok: false, why: "lister-unverified" }; }
}

async function evaluate(kind, key, recordPath, cwd, opts) {
  const r = readRecord(recordPath);
  let q = quarantine({ kind, ...r });
  if (q.verdict === "no-record" || q.verdict === "clean") {
    deleteTemps(recordPath);
    return { clear: true, prev: r.prev };
  }
  const real = (x) => x.found.filter((f) => !STAGE_TOKENS.has(f));
  if (real(q).length) return { clear: false, found: real(q) };
  // no static finding: the listing (about 30 s), only with a lister proven to see sandbox users
  const v = verify(opts.bin);
  const procs = v.ok ? listProcs({ scope: "full", maxAgeMs: 120000 }) : { ok: false, error: "lister-unverified" };
  q = quarantine({ kind, ...r, procs });
  if (real(q).length) return { clear: false, found: real(q) };
  if (kind === "worktree") {
    let tree;
    try {
      tree = opts.treeState ? await opts.treeState(cwd, r.prev.baseline) : { error: "no-tree-state" };
    } catch (e) {
      tree = { error: String(e?.message ?? e) };
    }
    if (!tree || typeof tree !== "object") tree = { error: "tree-state-invalid" };
    q = quarantine({ kind, ...r, procs, tree });
  }
  if (!q.clear) return { clear: false, found: real(q) };
  try {
    writeClean(recordPath, r.prev.run_id, { cleared_by: "auto" });
  } catch {
    return { clear: false, found: ["record-write-failed"] };
  }
  deleteTemps(recordPath);
  process.stderr.write(`codex-run: auto-cleared quarantine of run ${r.prev.run_id} (${kind} ${key})\n`);
  return { clear: true, prev: r.prev, cleared: "auto" };
}

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

/**
 * Takes the worktree pipe (named by the canonical path, so every spelling of it is one lock) and decides the
 * record. `{server, recordPath, prev, cleared?}`; `{busy}`; `{blocked:"cwd-missing"}` before any pipe;
 * `{quarantined, found}` with the pipe already released. `prev` is the record as found (before an auto-clear).
 */
export async function acquireWorktree(cwd, { treeState, bin } = {}) {
  let canon;
  try { canon = canonPath(cwd); } catch { return { blocked: "cwd-missing" }; }
  const key = sha1(canon);
  const server = await acquirePipe(`wt-${key}`);
  if (!server) return { busy: true };
  const recordPath = path.join(WT_LOCKS, `${key}.json`);
  let res;
  try {
    res = await evaluate("worktree", key, recordPath, cwd, { treeState, bin });
  } catch (e) {
    await releasePipe(server);
    throw e;
  }
  if (!res.clear) {
    await releasePipe(server);
    return { quarantined: true, found: res.found };
  }
  return { server, recordPath, prev: res.prev, ...(res.cleared ? { cleared: res.cleared } : {}) };
}

/**
 * slot-1..3 in order; a quarantined slot's pipe is released and the next one tried. When every slot was taken
 * and none quarantined, rescans up to 2 more times, 150 ms apart, before `{busy:true}` (a probe, such as another
 * process's busySlots, can hold a free slot for a moment).
 */
export async function acquireSlot({ bin } = {}) {
  const quarantined = [];
  for (let pass = 0; pass < 3; pass++) {
    for (const n of [1, 2, 3]) {
      const server = await acquirePipe(`slot-${n}`);
      if (!server) continue;
      const recordPath = path.join(SLOT_LOCKS, `${n}.json`);
      let res;
      try {
        res = await evaluate("slot", String(n), recordPath, null, { bin });
      } catch (e) {
        await releasePipe(server);
        throw e;
      }
      if (!res.clear) {
        await releasePipe(server);
        quarantined.push({ n, found: res.found });
        continue;
      }
      return { server, n, recordPath, prev: res.prev, ...(res.cleared ? { cleared: res.cleared } : {}) };
    }
    if (quarantined.length || pass === 2) break;
    await sleep(150);
  }
  return { busy: true, quarantined };
}

// ------------------------------------------------------------------------------- --clear-quarantine (section 5)

const rowLine = (c, row) => {
  const cmd = row?.cmd ? String(row.cmd).replace(/[\r\n]+/g, " ").slice(0, 120) : "?";
  return `${c.pid} ${c.name} ${c.why} user=${row?.user ?? "?"} start=${row?.start ?? "?"} cmd=${cmd}` +
    (KNOWN_NAME_RE.test(c.name) ? "" : " ?");
};
const sameStart = (a, b) => (a ?? null) === (b ?? null);

/**
 * The two-call confirmation: the first call lists and saves the listing (`reason:"confirm"`); a second call with
 * `yes` kills what was listed, re-lists, and clears only when nothing is left. `except` (pids, `yes` only) keeps
 * confirmed processes alive. Returns the ClearResult of the addendum (the CLI prints it as one JSON line).
 */
export async function clearQuarantine(target, { yes = false, except = [], bin, treeState } = {}) {
  const slotM = /^slot-([1-3])$/.exec(String(target));
  let label = String(target);
  let key;
  let recordPath;
  let pipeName;
  if (slotM) {
    key = slotM[1];
    recordPath = path.join(SLOT_LOCKS, `${key}.json`);
    pipeName = `slot-${key}`;
  } else {
    try { label = canonPath(target); } catch {
      return blank(label, { reason: "cwd-missing" });
    }
    key = sha1(label);
    recordPath = path.join(WT_LOCKS, `${key}.json`);
    pipeName = `wt-${key}`;
  }
  const pids = (except ?? []).map(Number);
  if (pids.length && !yes) return blank(label, { reason: "except-needs-yes" });
  const server = await acquirePipe(pipeName);
  if (!server) return blank(label, { reason: "busy" });
  try {
    return await clearLocked({ target, slot: !!slotM, label, key, recordPath, yes, pids, bin, treeState });
  } finally {
    await releasePipe(server);
  }
}

function blank(label, o = {}) {
  return {
    clear_quarantine: label, run: null, listed: [], notes: [], killed: [], new_candidates: [], excepted: [], survivors: [],
    cleared: false, reason: null, ...o,
  };
}

async function clearLocked({ target, slot, label, key, recordPath, yes, pids, bin, treeState }) {
  const r = readRecord(recordPath);
  const temps = tempFiles(recordPath);
  if (!r.prevError && (!r.prev || r.prev.state === "clean") && temps.length === 0) {
    return blank(label, { run: goodRunId(r.prev?.run_id) ? r.prev.run_id : null, reason: "not-quarantined" });
  }
  const prev = r.prev;
  const rec = !r.prevError && prev && prev.state === "active" ? prev : null;
  const runId = goodRunId(prev?.run_id) ? prev.run_id : null;
  const out = (o) => blank(label, { run: runId, ...o });
  const procOpts = { selfPid: process.pid, runId, mode: "quarantine" };

  process.stderr.write("codex-run: listing processes (about 30 s)\n");
  const L = listProcs({ scope: "full" });
  if (!L.ok) return out({ reason: `lister-blind:${L.error}` });
  const candidatesOf = (listing) => procFindings({ rec, rows: listing.rows, listerPid: listing.listerPid, ...procOpts }).map((f) => {
    const row = listing.rows.find((x) => x.pid === f.pid);
    return { pid: f.pid, why: f.why, name: row?.name ?? "", start: row?.start ?? null, text: f.text, row };
  });
  const cands = candidatesOf(L);

  // notes for the static findings
  const notes = [];
  if (r.prevError) notes.push(`note: record-${r.prevError}`);
  if (temps.length) notes.push("note: record-half-written");
  if (rec?.host_started) {
    notes.push("note: host-check-started (a host check ran outside the sandbox; untagged children of it that were never recorded cannot be traced)");
  }
  if (!slot && rec) {
    let tree;
    try { tree = treeState ? await treeState(String(target), rec.baseline) : { error: "no-tree-state" }; } catch (e) { tree = { error: String(e?.message ?? e) }; }
    let tn = null;
    if (!tree || tree.error) tn = `tree-unknown:${tree?.error ?? "tree-state-invalid"}`;
    else if (tree.head !== rec.baseline) tn = "head-moved";
    else if (![rec.tree_hash_pre, rec.tree_hash_final].filter(Boolean).includes(tree.hash)) tn = "tree-changed";
    if (tn) notes.push(`note: ${tn} (inspect git status and git diff before using the worktree)`);
  }
  if (!verify(bin).ok) notes.push("note: lister-unverified");

  const listed = cands.map((c) => rowLine(c, c.row));
  const confirmFile = path.join(path.dirname(recordPath), `${key}.clear-listing.json`);
  let confirmed = null;
  if (yes) {
    try {
      const f = JSON.parse(fs.readFileSync(confirmFile, "utf8"));
      const age = Date.now() - Date.parse(f.at);
      if (Number.isFinite(age) && age <= CONFIRM_MAX_AGE_MS && age >= -60000 && (f.run_id ?? null) === runId && Array.isArray(f.candidates)) confirmed = f.candidates;
    } catch { /* absent or unreadable: ask again */ }
  }
  if (!confirmed) {
    atomicWriteJson(confirmFile, {
      at: new Date().toISOString(), run_id: runId, candidates: cands.map((c) => ({ pid: c.pid, start: c.start, name: c.name, why: c.why })),
    });
    return out({ listed, notes, reason: "confirm" });
  }

  const excepted = [];
  for (const pid of pids) {
    const c = confirmed.find((x) => x.pid === pid);
    if (!c) return out({ listed, notes, reason: `except-unknown:${pid}` });
    excepted.push(c);
  }
  const isExcepted = (pid, start) => excepted.some((e) => e.pid === pid && sameStart(e.start, start));
  const matches = (c) => confirmed.some((x) => x.pid === c.pid &&
    (x.start !== null && x.start !== undefined ? x.start === c.start : c.start === null && String(x.name).toLowerCase() === c.name.toLowerCase()));
  const kill = [];
  const fresh = [];
  for (const c of cands) {
    if (isExcepted(c.pid, c.start)) continue;
    (matches(c) ? kill : fresh).push(c);
  }
  const byStart = (a, b) => (msOf(a.start) ?? Infinity) - (msOf(b.start) ?? Infinity);
  const order = [
    kill.filter((c) => ["tagged", "owner-alive", "child-alive"].includes(c.why)).sort(byStart),
    kill.filter((c) => c.why === "descendant").sort(byStart),
    kill.filter((c) => c.why === "sandbox-user").sort(byStart),
  ].flat();
  const killed = [];
  for (const c of order) {
    const st = startTime(c.pid);
    if (st === null) { killed.push({ pid: c.pid, ok: true, out: "gone" }); continue; }
    if (c.start !== null && st !== c.start) { killed.push({ pid: c.pid, ok: true, out: "skipped: pid reused (start time changed)" }); continue; }
    const k = killTree(c.pid);
    killed.push({ pid: c.pid, ok: k.ok, out: k.out });
  }
  const base = {
    listed, notes, killed, new_candidates: fresh.map((c) => c.text), excepted: excepted.map((e) => `${e.why}:${e.pid}:${e.name}`),
  };

  await sleep(1000);
  const L2 = listProcs({ scope: "full" });
  if (!L2.ok) return out({ ...base, survivors: [`lister-blind:${L2.error}`], reason: "survivors" });
  const left = candidatesOf(L2).filter((c) => !isExcepted(c.pid, c.start)).map((c) => c.text);
  if (left.length) return out({ ...base, survivors: left, reason: "survivors" });

  writeClean(recordPath, prev?.run_id ?? null, { cleared_by: "user" });
  deleteTemps(recordPath);
  try { fs.rmSync(confirmFile, { force: true }); } catch { /* best effort */ }
  if (!slot) {
    try { fs.rmSync(path.join(String(target), ".codex-tmp"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
    for (const n of [1, 2, 3]) {
      const s = await acquirePipe(`slot-${n}`);
      if (!s) continue; // a live run holds it: not ours to touch
      try {
        const sp = path.join(SLOT_LOCKS, `${n}.json`);
        const sr = readRecord(sp);
        if (runId && sr.prev && sr.prev.state === "active" && sr.prev.run_id === runId) {
          try { writeClean(sp, runId, { cleared_by: "user" }); } catch { /* the slot stays quarantined; the user can clear it */ }
        }
      } finally {
        await releasePipe(s);
      }
    }
  }
  return out({ ...base, cleared: true, reason: null });
}
