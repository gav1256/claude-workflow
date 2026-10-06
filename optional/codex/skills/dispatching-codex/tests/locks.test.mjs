import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpEnv, TESTS_DIR, FAKE_CODEX, rmrf } from "./helpers.mjs";

// paths.mjs reads the environment at import: set it before the dynamic imports.
const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = env.CODEX_HOME;
process.env.CODEX_RUN_PIPE_PREFIX = env.CODEX_RUN_PIPE_PREFIX;
process.env.CODEX_RUN_BIN = env.CODEX_RUN_BIN;
process.env.CODEX_RUN_BIN_ARGS = env.CODEX_RUN_BIN_ARGS;
process.env.FAKE_CODEX_SCENARIO = env.FAKE_CODEX_SCENARIO;
delete process.env.CODEX_RUN_PROCS;
const P = await import("../lib/paths.mjs");
const PR = await import("../lib/procs.mjs");
const L = await import("../lib/locks.mjs");
assert.equal(P.WT_LOCKS.startsWith(env.root), true, "lock dir must be inside the temp root");

const CONTROLLER = path.join(TESTS_DIR, "crash-controller.mjs");
const bin = { cmd: process.execPath, args: [FAKE_CODEX] };
const SBX = "TESTHOST\\CodexSandboxOffline";
const T0 = "2026-10-06T10:00:00.0000000Z";
const RID = "20261006T100000Z-aaaaaa";
const H = "a".repeat(40);
const X = "b".repeat(64);
const Y = "c".repeat(64);
const treeOk = () => ({ head: H, hash: X });

// ---- bookkeeping: every process a test starts is killed by pid at the end; every temp dir removed ----
const own = new Set();
const track = (pid) => { if (Number.isInteger(pid)) own.add(pid); return pid; };
const held = new Set();
const hold = (srv) => { if (srv) held.add(srv); return srv; };
async function release(r) {
  const srv = r?.server ?? r;
  if (srv && typeof srv.close === "function") { held.delete(srv); await L.releasePipe(srv); }
}
after(() => {
  for (const pid of own) PR.killTree(pid);
  env.cleanup();
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, ms = 15000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return !!(await fn());
}
const waitGone = (pid, ms = 10000) => waitFor(() => !alive(pid), ms);
const rand = () => crypto.randomBytes(4).toString("hex");

function mkdir(name = "wt") {
  const d = path.join(env.root, `${name} ${rand()}`); // a space in the path, on purpose
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const wtRecord = (cwd) => path.join(P.WT_LOCKS, sha1(P.canonPath(cwd)) + ".json");
const slotRecord = (n) => path.join(P.SLOT_LOCKS, `${n}.json`);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

function validRec(kind, o = {}) {
  return {
    v: 1, kind, key: "k", cwd: "c:\\x", run_id: RID, run_dir: "d", state: "active", owner_pid: 1000,
    owner_start_time: T0, child_pids: [], host_started: false, baseline: H, tree_hash_pre: X, tree_hash_final: null,
    updated_at: "2026-10-06T10:00:00.000Z", ...o,
  };
}
const mk = (pid, o = {}) => ({ pid, ppid: null, name: "x.exe", user: "TESTHOST\\me", cmd: null, session: 1, start: null, ...o });
const FULL_EMPTY = { ok: true, scope: "full", session: 1, rows: [] };

function fixture(obj) {
  const f = path.join(env.root, `fx-${rand()}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  process.env.CODEX_RUN_PROCS = f;
  PR.resetListCache();
  return f;
}
const logLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const lists = (f) => logLines(f).filter((l) => l.startsWith("list:"));
const probeOk = () => {
  fs.mkdirSync(path.dirname(PR.LISTER_PROBE), { recursive: true });
  fs.writeFileSync(PR.LISTER_PROBE, JSON.stringify({ version: "0.160.0", ok: true, at: new Date().toISOString() }));
};

beforeEach(() => {
  rmrf(P.WT_LOCKS);
  rmrf(P.SLOT_LOCKS);
  PR.resetListCache();
  delete process.env.CODEX_RUN_PROCS;
  probeOk();
});
afterEach(async () => { for (const s of [...held]) await release(s); });

// ---- child processes: lock racers and the crash controller ----
const HELPER = path.join(env.root, "lock-child.mjs");
fs.writeFileSync(HELPER, `
import fs from "node:fs";
const L = await import(${JSON.stringify(pathToFileURL(path.join(TESTS_DIR, "..", "lib", "locks.mjs")).href)});
const [mode, arg, startFile] = process.argv.slice(2);
if (startFile && mode !== "writer") while (!fs.existsSync(startFile)) await new Promise((r) => setTimeout(r, 2));
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (mode === "worktree") {
  const r = await L.acquireWorktree(arg, { treeState: () => ({ head: "${H}", hash: "${X}" }) });
  say({ server: !!r.server, busy: !!r.busy, quarantined: !!r.quarantined, blocked: r.blocked ?? null });
} else if (mode === "slot") {
  const r = await L.acquireSlot({});
  say({ server: !!r.server, n: r.n ?? null, busy: !!r.busy });
} else if (mode === "pipe" || mode === "pipe-exit") {
  const s = await L.acquirePipe(arg);
  say({ server: !!s });
  if (mode === "pipe-exit") { await new Promise((r) => setTimeout(r, 200)); process.exit(0); }
} else if (mode === "writer") {
  for (let i = 0; i < Number(startFile); i++) L.addChild(arg, 100000 + i);
  say({ done: true });
  process.exit(0);
}
setInterval(() => {}, 1000);
`);

function childEnv(extra = {}) {
  const e = { ...process.env, ...extra };
  delete e.CODEX_RUN_PROCS;
  return e;
}

/** Spawns lock-child.mjs; resolves to its single JSON line. The child stays alive (tracked) unless it exits itself. */
function runChild(args, extraEnv) {
  const c = spawn(process.execPath, [HELPER, ...args], { env: childEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  track(c.pid);
  let buf = "";
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  const result = new Promise((resolve, reject) => {
    c.stdout.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); } }
    });
    c.on("exit", () => setTimeout(() => reject(new Error(`child exited without output: ${err}`)), 500));
  });
  result.catch(() => {});
  return { child: c, result };
}

function writeScenario(obj) {
  const f = path.join(env.root, `sc-${rand()}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

/** Starts crash-controller; resolves once its outFile has the fields the mode produces. */
async function startController(mode, cwd, { sc = {}, extra = [] } = {}) {
  const outFile = path.join(env.root, `out-${rand()}.json`);
  const c = spawn(process.execPath, [CONTROLLER, mode, cwd, outFile, "--tree", `${H}:${X}`, ...extra], {
    env: childEnv({ FAKE_CODEX_SCENARIO: writeScenario(sc) }), stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  track(c.pid);
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  const need = { "exec-detached": "codexPid", host: "cmdPid", "active-exit": "runId" }[mode];
  const read = () => { try { return readJson(outFile); } catch { return null; } };
  const ok = await waitFor(() => {
    if (c.exitCode !== null && c.exitCode !== 0) throw new Error(`controller failed (${c.exitCode}): ${err}`);
    return read()?.[need] !== undefined;
  }, 30000);
  assert.ok(ok, `controller did not publish ${need}: ${err}`);
  const out = read();
  track(out.ownerPid);
  track(out.codexPid);
  track(out.cmdPid);
  return { child: c, out };
}
async function killOwner(c) {
  if (c.child.exitCode === null) process.kill(c.out.ownerPid);
  assert.equal(await waitGone(c.out.ownerPid), true, "controller must be dead");
  await new Promise((r) => setTimeout(r, 500)); // the OS closes the dead process's handles (its pipes) a moment later
}
async function readPidFile(f) {
  assert.equal(await waitFor(() => { try { return !!readJson(f).grandchild; } catch { return false; } }), true, "fake wrote its pidFile");
  const p = readJson(f);
  track(p.pid);
  track(p.grandchild);
  return p;
}

// =============================================================================== quarantine() (pure)

const procsOk = (rows = [], o = {}) => ({ ok: true, scope: "full", session: 1, rows, ...o });
const q = (o) => L.quarantine({ kind: "worktree", ...o });

test("quarantine: no record and clean record clear without a listing", () => {
  assert.deepEqual(q({ prev: null }), { clear: true, verdict: "no-record", found: [] });
  assert.deepEqual(q({ prev: { v: 1, state: "clean" }, halfWritten: true }), { clear: true, verdict: "clean", found: [] });
  assert.deepEqual(q({ kind: "slot", prev: { v: 1, state: "clean" } }).verdict, "clean");
});

test("quarantine: found is collected in the table's order, stage tokens included", () => {
  const prev = validRec("worktree");
  assert.deepEqual(q({ prev }).found, ["lister-not-run", "tree-not-checked"]);
  assert.deepEqual(q({ prev: validRec("worktree", { host_started: true }), halfWritten: true }).found,
    ["record-half-written", "host-check-started", "lister-not-run", "tree-not-checked"]);
  assert.deepEqual(q({ kind: "slot", prev }).found, ["lister-not-run"]);
  assert.deepEqual(q({ prev: null, halfWritten: true }).found, ["record-half-written", "lister-not-run"]);
  assert.deepEqual(q({ prev: { v: 1 }, prevError: "invalid-schema:state" }).found, ["record-invalid-schema:state", "lister-not-run"]);
  assert.deepEqual(q({ prev: null, prevError: "invalid-json", procs: procsOk() }).found, ["record-invalid-json"]);
  assert.equal(q({ prev }).clear, false);
  assert.equal(q({ prev }).verdict, "quarantined");
});

test("quarantine: lister outcomes", () => {
  const prev = validRec("worktree");
  const tree = { head: H, hash: X };
  assert.deepEqual(q({ prev, procs: { ok: false, error: "lister-timeout" }, tree }).found, ["lister-blind:lister-timeout"]);
  assert.deepEqual(q({ prev, procs: { ok: false, error: "lister-unverified" }, tree }).found, ["lister-blind:lister-unverified"]);
  assert.deepEqual(q({ prev, procs: procsOk([], { scope: "session" }), tree }).found, ["lister-partial"]);
  assert.deepEqual(q({ prev, procs: procsOk([]), tree }), { clear: true, verdict: "auto", found: [] });
});

test("quarantine: conditions (a) and (b) and rules 3-5 come from procFindings; selfPid is excluded", () => {
  const prev = validRec("slot", { child_pids: [{ pid: 2000, at: "2026-10-06T10:00:10.000Z" }] });
  const rows = [
    mk(10, { user: SBX }),
    mk(11, { cmd: "C:\\x\\" + RID.toLowerCase() + "\\last.json" }),
    mk(1000, { start: T0 }),
    mk(2000, { start: "2026-10-06T10:00:11.0000000Z" }),
    mk(12, { ppid: 2000, start: "2026-10-06T10:00:12.0000000Z" }),
    mk(13, { cmd: RID, ppid: 1 }), // the caller's own shell
    mk(1, { start: "2026-10-06T12:00:00.0000000Z" }),
  ];
  const r = L.quarantine({ kind: "slot", prev, procs: procsOk(rows), selfPid: 13 });
  assert.deepEqual(r.found, ["sandbox-user:10:x.exe", "tagged:11:x.exe", "owner-alive:1000:x.exe",
    "child-alive:2000:x.exe", "descendant:12:x.exe"]);
  assert.equal(r.clear, false);
});

test("quarantine: with a record error only rule 1 (and rule 2 for a well-formed run id) run", () => {
  const rows = [mk(10, { user: SBX }), mk(11, { cmd: "x " + RID }), mk(1000, { start: T0 }), mk(12, { ppid: 1000, start: T0 })];
  const bad = { ...validRec("slot"), owner_start_time: undefined };
  assert.deepEqual(L.quarantine({ kind: "slot", prev: bad, prevError: "invalid-schema:owner_start_time", procs: procsOk(rows) }).found,
    ["record-invalid-schema:owner_start_time", "sandbox-user:10:x.exe", "tagged:11:x.exe"]);
  const weird = { ...bad, run_id: "..\\x" };
  assert.deepEqual(L.quarantine({ kind: "slot", prev: weird, prevError: "invalid-schema:run_id", procs: procsOk(rows) }).found,
    ["record-invalid-schema:run_id", "sandbox-user:10:x.exe"]);
  assert.deepEqual(L.quarantine({ kind: "slot", prev: null, halfWritten: true, procs: procsOk(rows) }).found,
    ["record-half-written", "sandbox-user:10:x.exe"]);
});

test("quarantine: the tree must match the record (head, then hash against pre or final)", () => {
  const prev = validRec("worktree", { tree_hash_final: Y });
  const ok = procsOk();
  assert.deepEqual(q({ prev, procs: ok, tree: { error: "git-failed" } }).found, ["tree-unknown:git-failed"]);
  assert.deepEqual(q({ prev, procs: ok, tree: { head: "d".repeat(40), hash: X } }).found, ["head-moved"]);
  assert.deepEqual(q({ prev, procs: ok, tree: { head: H, hash: "e".repeat(64) } }).found, ["tree-changed"]);
  assert.equal(q({ prev, procs: ok, tree: { head: H, hash: X } }).clear, true);
  assert.equal(q({ prev, procs: ok, tree: { head: H, hash: Y } }).clear, true);
  // a null final hash never matches; the pre hash still does
  assert.equal(q({ prev: validRec("worktree"), procs: ok, tree: { head: H, hash: Y } }).clear, false);
  assert.equal(q({ prev: validRec("worktree"), procs: ok, tree: { head: H, hash: X } }).clear, true);
  // a slot has no tree
  assert.equal(q({ kind: "slot", prev, procs: ok, tree: { head: "d".repeat(40), hash: "e".repeat(64) } }).clear, true);
  // the tree is judged only against a valid record
  assert.deepEqual(q({ prev: null, prevError: "invalid-json", procs: ok, tree: { head: "d".repeat(40) } }).found, ["record-invalid-json"]);
});

// =============================================================================== records

test("readRecord: missing, unreadable, invalid json, non-object", () => {
  const dir = mkdir("rec");
  const f = path.join(P.WT_LOCKS, "k1.json");
  assert.deepEqual(L.readRecord(f), { prev: null, prevError: null, halfWritten: false });
  fs.mkdirSync(f, { recursive: true }); // a directory where the file should be
  assert.deepEqual(L.readRecord(f), { prev: null, prevError: "unreadable", halfWritten: false });
  fs.rmSync(f, { recursive: true });
  fs.writeFileSync(f, "{");
  assert.deepEqual(L.readRecord(f), { prev: null, prevError: "invalid-json", halfWritten: false });
  fs.writeFileSync(f, "[1]");
  assert.deepEqual(L.readRecord(f), { prev: null, prevError: "invalid-json", halfWritten: false });
  fs.writeFileSync(f, "null");
  assert.equal(L.readRecord(f).prevError, "invalid-json");
  assert.ok(dir);
});

test("readRecord: schema validation names the first failing field and keeps prev", () => {
  const f = path.join(P.WT_LOCKS, "k2.json");
  const base = validRec("worktree");
  assert.deepEqual(L.readRecord(f).prevError, null);
  writeJson(f, base);
  assert.deepEqual(L.readRecord(f), { prev: base, prevError: null, halfWritten: false });
  const cases = [
    ["v", { v: 2 }], ["state", { state: "weird" }], ["kind", { kind: "slot" }], ["run_id", { run_id: "..\\x" }],
    ["run_id", { run_id: 5 }], ["run_dir", { run_dir: 5 }], ["owner_pid", { owner_pid: 0 }], ["owner_pid", { owner_pid: 1.5 }],
    ["owner_start_time", { owner_start_time: "nope" }], ["owner_start_time", { owner_start_time: undefined }],
    ["child_pids", { child_pids: {} }], ["child_pids", { child_pids: [{ pid: 0, at: "x" }] }], ["child_pids", { child_pids: [{ pid: 5 }] }],
    ["host_started", { host_started: "no" }], ["baseline", { baseline: "xyz" }], ["tree_hash_pre", { tree_hash_pre: "ab" }],
    ["tree_hash_final", { tree_hash_final: "ab" }],
  ];
  for (const [field, patch] of cases) {
    const rec = { ...base, ...patch };
    writeJson(f, rec);
    const r = L.readRecord(f);
    assert.equal(r.prevError, `invalid-schema:${field}`, JSON.stringify(patch));
    assert.equal(r.prev.run_id, rec.run_id);
  }
  writeJson(f, { ...base, baseline: "a".repeat(64), tree_hash_final: Y }); // sha256 repos and a final hash are valid
  assert.equal(L.readRecord(f).prevError, null);
  writeJson(f, { v: 1, state: "clean" }); // a clean record needs only v
  assert.equal(L.readRecord(f).prevError, null);
  writeJson(f, { state: "clean" });
  assert.equal(L.readRecord(f).prevError, "invalid-schema:v");
  // the kind is the folder's kind
  const sf = path.join(P.SLOT_LOCKS, "1.json");
  writeJson(sf, validRec("slot"));
  assert.equal(L.readRecord(sf).prevError, null);
  writeJson(sf, validRec("worktree"));
  assert.equal(L.readRecord(sf).prevError, "invalid-schema:kind");
});

test("readRecord: halfWritten is a writer's temp file next to the record, nothing else", () => {
  const f = path.join(P.WT_LOCKS, "k3.json");
  writeJson(f, validRec("worktree"));
  for (const n of [".k3.json.x.tmp", ".k3.json.12.abc.tmp", ".other.json.1.0123abcd.tmp", "k3.json.1.0123abcd.tmp", ".k3.json.1.0123abcd.tmp.bak"]) {
    fs.writeFileSync(path.join(P.WT_LOCKS, n), "x");
  }
  assert.equal(L.readRecord(f).halfWritten, false);
  fs.writeFileSync(path.join(P.WT_LOCKS, ".k3.json.1234.0123abcd.tmp"), "x");
  assert.equal(L.readRecord(f).halfWritten, true);
  fs.rmSync(f);
  assert.equal(L.readRecord(f).halfWritten, true); // also without a record
  const g = path.join(P.WT_LOCKS, "no.dir", "k.json");
  assert.deepEqual(L.readRecord(g), { prev: null, prevError: null, halfWritten: false }); // folder absent
});

test("record writes: whole objects through a rename, mutations are read-modify-write", () => {
  const f = path.join(P.WT_LOCKS, "w1.json");
  L.writeActive(f, { cwd: "c:\\x", run_id: RID, run_dir: "d", owner_pid: 1000, owner_start_time: T0, baseline: H, tree_hash_pre: X });
  let r = L.readRecord(f);
  assert.equal(r.prevError, null);
  assert.equal(r.prev.state, "active");
  assert.equal(r.prev.kind, "worktree");
  assert.equal(r.prev.key, "w1");
  assert.deepEqual([r.prev.child_pids, r.prev.host_started, r.prev.tree_hash_final], [[], false, null]);
  assert.equal(typeof r.prev.updated_at, "string");
  const sf = path.join(P.SLOT_LOCKS, "2.json");
  L.writeActive(sf, { run_id: RID, run_dir: "d", owner_pid: 1000, owner_start_time: T0, baseline: H, tree_hash_pre: X });
  assert.equal(L.readRecord(sf).prev.kind, "slot");
  assert.equal(L.readRecord(sf).prev.key, "2");

  const before = Date.now();
  L.addChild(f, 2345);
  L.addChild(f, 2346);
  L.markHostStarted(f);
  L.markTreeFinal(f, Y);
  r = L.readRecord(f);
  assert.deepEqual(r.prev.child_pids.map((c) => c.pid), [2345, 2346]);
  assert.ok(Date.parse(r.prev.child_pids[0].at) >= before - 1000);
  assert.equal(r.prev.host_started, true);
  assert.equal(r.prev.tree_hash_final, Y);
  assert.equal(r.prev.run_id, RID);
  assert.equal(r.prevError, null);
  assert.deepEqual(fs.readdirSync(P.WT_LOCKS), ["w1.json"]); // no temp files left
  assert.throws(() => L.addChild(f, 0));
  assert.throws(() => L.addChild(path.join(P.WT_LOCKS, "absent.json"), 5), /record/);
  writeJson(f, { v: 1, state: "clean" });
  assert.throws(() => L.addChild(f, 5), /record/);
});

test("writeClean: keeps the object, adds extras, refuses another run's active record", () => {
  const f = path.join(P.WT_LOCKS, "c1.json");
  L.writeActive(f, { cwd: "c:\\x", run_id: RID, run_dir: "d", owner_pid: 1000, owner_start_time: T0, baseline: H, tree_hash_pre: X });
  assert.throws(() => L.writeClean(f, "20261006T100001Z-bbbbbb"), /active/);
  assert.equal(L.readRecord(f).prev.state, "active");
  L.writeClean(f, RID, { cleared_by: "auto" });
  const r = L.readRecord(f);
  assert.equal(r.prevError, null);
  assert.equal(r.prev.state, "clean");
  assert.equal(r.prev.cleared_by, "auto");
  assert.equal(r.prev.run_id, RID);
  L.writeClean(f, "20261006T100001Z-bbbbbb"); // a clean record may be rewritten by anyone
  assert.equal(L.readRecord(f).prev.run_id, "20261006T100001Z-bbbbbb");
  const g = path.join(P.WT_LOCKS, "c2.json"); // no record at all, run id null
  L.writeClean(g, null, { cleared_by: "user" });
  assert.deepEqual([L.readRecord(g).prev.state, L.readRecord(g).prev.run_id, L.readRecord(g).prev.cleared_by], ["clean", null, "user"]);
  fs.writeFileSync(g, "{"); // an unreadable record is replaced
  L.writeClean(g, null, { cleared_by: "user" });
  assert.equal(L.readRecord(g).prevError, null);
});

test("record writes retry on EPERM and then throw the last error", () => {
  const f = path.join(P.WT_LOCKS, "e1.json");
  fs.mkdirSync(f, { recursive: true }); // renaming a file onto a directory fails with EPERM
  const t0 = Date.now();
  assert.throws(() => L.writeActive(f, { run_id: RID, run_dir: "d", owner_pid: 1000, owner_start_time: T0, baseline: H, tree_hash_pre: X }),
    (e) => ["EPERM", "EBUSY", "EACCES"].includes(e.code));
  assert.ok(Date.now() - t0 >= 450, `5 retries, 100 ms apart (took ${Date.now() - t0} ms)`);
  assert.deepEqual(fs.readdirSync(P.WT_LOCKS), ["e1.json"]); // the failed temp file is removed
});

test("record writes are atomic: a reader never sees a half file while another process rewrites it", { timeout: 60000 }, async () => {
  const f = path.join(P.WT_LOCKS, "a1.json");
  L.writeActive(f, { cwd: "c:\\x", run_id: RID, run_dir: "d", owner_pid: 1000, owner_start_time: T0, baseline: H, tree_hash_pre: X });
  const w = runChild(["writer", f, "250"]);
  let bad = 0;
  let good = 0;
  while (w.child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 3)); // let the child's exit event through; a reader that never closes the file starves the writer
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; } // a sharing violation is not a half file
    try { JSON.parse(text); good++; } catch { bad++; }
  }
  assert.deepEqual(await w.result, { done: true });
  assert.equal(bad, 0);
  assert.ok(good > 0);
  assert.equal(L.readRecord(f).prev.child_pids.length, 250);
});

// =============================================================================== pipes

test("acquirePipe: two processes, one name: exactly one wins; the name is free after exit and after a kill", { timeout: 60000 }, async () => {
  const name = "t-" + rand();
  const a = runChild(["pipe", name]);
  assert.deepEqual(await a.result, { server: true });
  const mine = hold(await L.acquirePipe(name));
  assert.equal(mine, null, "taken by the other process");
  const b = runChild(["pipe", name]);
  assert.deepEqual(await b.result, { server: false });
  process.kill(a.child.pid); // TerminateProcess: the OS frees the pipe
  assert.equal(await waitGone(a.child.pid), true);
  let again = null;
  assert.equal(await waitFor(async () => (again = hold(await L.acquirePipe(name))) !== null, 5000, 50), true, "free after the holder was killed");
  assert.equal(await L.acquirePipe(name), null);
  await release(again);
  const c = runChild(["pipe-exit", name]); // holds it, then exits normally
  assert.deepEqual(await c.result, { server: true });
  assert.equal(await waitGone(c.child.pid), true);
  let last = null;
  assert.equal(await waitFor(async () => (last = hold(await L.acquirePipe(name))) !== null, 5000, 50), true, "free after the holder exited");
  await release(last);
  const free = hold(await L.acquirePipe(name)); // and after our own release
  assert.ok(free);
});

test("busySlots counts the other slots held now, not the ones this process holds", { timeout: 60000 }, async () => {
  assert.equal(await L.busySlots(), 0);
  const other = runChild(["pipe", "slot-2"]);
  assert.deepEqual(await other.result, { server: true });
  assert.equal(await L.busySlots(), 1);
  const mine = await L.acquireSlot({}); // slot-1: ours
  assert.equal(mine.n, 1);
  hold(mine.server);
  assert.equal(await L.busySlots(), 1, "own slot not counted");
  const third = hold(await L.acquirePipe("slot-3"));
  assert.equal(await L.busySlots(), 1, "a slot taken through acquirePipe by this process is still ours");
  await release(third);
  process.kill(other.child.pid);
  assert.equal(await waitGone(other.child.pid), true);
  assert.equal(await waitFor(async () => (await L.busySlots()) === 0, 5000, 50), true);
});

// =============================================================================== acquireWorktree / acquireSlot

test("acquireWorktree: a missing cwd is blocked before any pipe or record", async () => {
  const r = await L.acquireWorktree(path.join(env.root, "no-such-" + rand()), { treeState: treeOk, bin });
  assert.deepEqual(r, { blocked: "cwd-missing" });
  assert.equal(fs.existsSync(P.WT_LOCKS), false);
});

test("acquireWorktree: first run takes the pipe (no record), the second is busy, release frees it", async () => {
  const dir = mkdir();
  const a = await L.acquireWorktree(dir, { treeState: treeOk, bin });
  hold(a.server);
  assert.ok(a.server);
  assert.equal(a.prev, null);
  assert.equal(a.cleared, undefined);
  assert.equal(a.recordPath, wtRecord(dir));
  assert.deepEqual(await L.acquireWorktree(dir, { treeState: treeOk, bin }), { busy: true });
  await release(a);
  const b = await L.acquireWorktree(dir, { treeState: treeOk, bin });
  hold(b.server);
  assert.ok(b.server);
});

test("case 4: Review Focus 1 spellings of one path are one lock (two processes racing, exactly one wins)", { timeout: 60000 }, async () => {
  const dir = mkdir("Race Dir");
  const spellings = [dir, dir.replace(/\\/g, "/").toUpperCase() + "/"];
  const start = path.join(env.root, `start-${rand()}`);
  const racers = spellings.map((s) => runChild(["worktree", s, start]));
  await new Promise((r) => setTimeout(r, 1500)); // both imported and polling
  fs.writeFileSync(start, "go");
  const res = await Promise.all(racers.map((r) => r.result));
  assert.equal(res.filter((r) => r.server).length, 1, JSON.stringify(res));
  assert.equal(res.filter((r) => r.busy).length, 1, JSON.stringify(res));
});

test("acquireSlot: slot-1..3 in order; 4 racing runs get 3 slots and one busy", { timeout: 60000 }, async () => {
  const start = path.join(env.root, `start-${rand()}`);
  const racers = [0, 1, 2, 3].map(() => runChild(["slot", "-", start]));
  await new Promise((r) => setTimeout(r, 2000));
  fs.writeFileSync(start, "go");
  const res = await Promise.all(racers.map((r) => r.result));
  assert.deepEqual(res.filter((r) => r.server).map((r) => r.n).sort(), [1, 2, 3], JSON.stringify(res));
  assert.equal(res.filter((r) => r.busy).length, 1);
  for (const r of racers) process.kill(r.child.pid); // free the slots for the next tests
  for (const r of racers) assert.equal(await waitGone(r.child.pid), true);
  await new Promise((r) => setTimeout(r, 500));
});

test("acquireSlot: a quarantined slot is skipped (pipe released) and the next one is taken", async () => {
  writeJson(slotRecord(1), validRec("slot", { host_started: true }));
  const s = await L.acquireSlot({ bin });
  hold(s.server);
  assert.equal(s.n, 2);
  assert.equal(s.recordPath, slotRecord(2));
  assert.equal(s.prev, null);
  // slot-1's pipe was released: taking it by hand works
  const p1 = hold(await L.acquirePipe("slot-1"));
  assert.ok(p1);
  await release(p1);
});

test("acquireSlot: all taken or quarantined is busy and names the quarantined ones (no stage tokens)", async () => {
  writeJson(slotRecord(1), validRec("slot", { host_started: true }));
  writeJson(slotRecord(3), { ...validRec("slot"), owner_start_time: undefined });
  const p2 = hold(await L.acquirePipe("slot-2"));
  const r = await L.acquireSlot({ bin });
  assert.deepEqual(r, { busy: true, quarantined: [
    { n: 1, found: ["host-check-started"] },
    { n: 3, found: ["record-invalid-schema:owner_start_time"] },
  ] });
  await release(p2);
  assert.deepEqual(await (async () => { const x = await L.acquireSlot({ bin }); hold(x.server); return x.n; })(), 2);
});

test("acquireSlot: a stale slot record with no survivors is auto-cleared (no tree check)", async () => {
  writeJson(slotRecord(1), validRec("slot"));
  const log = path.join(env.root, `log-${rand()}`);
  fixture({ log, full: { ok: true, rows: [mk(777777, { name: "notepad.exe", cmd: "notepad" })] } });
  const s = await L.acquireSlot({ bin });
  hold(s.server);
  assert.equal(s.n, 1);
  assert.equal(s.cleared, "auto");
  assert.equal(s.prev.state, "active");
  assert.equal(readJson(slotRecord(1)).state, "clean");
  assert.equal(readJson(slotRecord(1)).cleared_by, "auto");
  assert.deepEqual(lists(log), ["list:full"]);
});

test("acquireWorktree: quarantine with a static finding lists nothing and releases the pipe", async () => {
  const dir = mkdir();
  writeJson(wtRecord(dir), validRec("worktree", { host_started: true }));
  const log = path.join(env.root, `log-${rand()}`);
  fixture({ log });
  const r = await L.acquireWorktree(dir, { treeState: treeOk, bin });
  assert.deepEqual(r, { quarantined: true, found: ["host-check-started"] });
  assert.deepEqual(logLines(log), []);
  const again = await L.acquireWorktree(dir, { treeState: treeOk, bin }); // not busy: the pipe was released
  assert.equal(again.quarantined, true);
});

test("acquireWorktree: staging, treeState is called with the caller's cwd and the baseline after the listing", async () => {
  const dir = mkdir();
  writeJson(wtRecord(dir), validRec("worktree"));
  const log = path.join(env.root, `log-${rand()}`);
  fixture({ log, full: FULL_EMPTY });
  const calls = [];
  const r = await L.acquireWorktree(dir, { bin, treeState: (cwd, b) => { calls.push([cwd, b, lists(log).length]); return { head: H, hash: X }; } });
  hold(r.server);
  assert.equal(r.cleared, "auto");
  assert.deepEqual(calls, [[dir, H, 1]]);
  // no treeState: tree-unknown; a throwing treeState: tree-unknown with its message
  writeJson(wtRecord(dir), validRec("worktree"));
  await release(r);
  PR.resetListCache();
  assert.deepEqual(await L.acquireWorktree(dir, { bin }), { quarantined: true, found: ["tree-unknown:no-tree-state"] });
  PR.resetListCache();
  assert.deepEqual(await L.acquireWorktree(dir, { bin, treeState: () => { throw new Error("git exploded"); } }),
    { quarantined: true, found: ["tree-unknown:git exploded"] });
  assert.deepEqual(await L.acquireWorktree(dir, { bin, treeState: () => ({ error: "weird" }) }),
    { quarantined: true, found: ["tree-unknown:weird"] });
});

test("acquireWorktree: auto-clear writes the clean record, deletes stale temps, says so on stderr", async () => {
  const dir = mkdir();
  writeJson(wtRecord(dir), validRec("worktree"));
  const stale = path.join(P.WT_LOCKS, `.${path.basename(wtRecord(dir))}.99.deadbeef.tmp`);
  // a half-written temp is a finding: stays quarantined and the temp stays
  fs.writeFileSync(stale, "x");
  fixture({ full: FULL_EMPTY });
  const r0 = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  assert.deepEqual(r0, { quarantined: true, found: ["record-half-written"] });
  assert.equal(fs.existsSync(stale), true);
  // once cleared by hand (the file removed), the clean record path deletes stale temps too
  fs.rmSync(stale);
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (c, ...a) => { lines.push(String(c)); return true; };
  let r;
  try { r = await L.acquireWorktree(dir, { bin, treeState: treeOk }); } finally { process.stderr.write = orig; }
  hold(r.server);
  assert.equal(r.cleared, "auto");
  assert.ok(lines.some((l) => l.includes(`codex-run: auto-cleared quarantine of run ${RID} (worktree ${sha1(P.canonPath(dir))})`)), lines.join("|"));
  const rec = readJson(wtRecord(dir));
  assert.deepEqual([rec.state, rec.cleared_by], ["clean", "auto"]);
  // a clean record + a stale temp: clear, temp deleted
  await release(r);
  fs.writeFileSync(stale, "x");
  const r2 = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  hold(r2.server);
  assert.ok(r2.server);
  assert.equal(fs.existsSync(stale), false);
});

test("acquireWorktree: a failing writeClean inside the auto-clear is quarantined as record-write-failed, pipe released", { timeout: 30000 }, async () => {
  const dir = mkdir();
  const rp = wtRecord(dir);
  writeJson(rp, validRec("worktree"));
  fixture({ full: FULL_EMPTY });
  const r = await L.acquireWorktree(dir, {
    bin,
    treeState: () => { fs.rmSync(rp); fs.mkdirSync(rp); return { head: H, hash: X }; }, // the record becomes unwritable
  });
  assert.deepEqual(r, { quarantined: true, found: ["record-write-failed"] });
  fs.rmSync(rp, { recursive: true });
  const again = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  hold(again.server);
  assert.ok(again.server, "the pipe was released");
});

// =============================================================================== the six cases (spec:197-203, addendum 8.4)

const BASE = (extra = {}) => ({ sleepMs: 60000, grandchild: "detached", grandchildMs: 90000, ...extra });

test("case 1: controller killed right after spawn, before any pid is recorded: quarantined by (b) then (a)", { timeout: 120000 }, async () => {
  const dir = mkdir();
  const tag = "cdx-gc-" + rand();
  const pidFile = path.join(env.root, `pids-${rand()}.json`);
  const c = await startController("exec-detached", dir, { sc: BASE({ grandchildTag: tag, pidFile }) });
  const pids = await readPidFile(pidFile);
  assert.equal(pids.pid, c.out.codexPid);
  await killOwner(c);
  assert.ok(alive(pids.pid) && alive(pids.grandchild), "the detached fake and its grandchild outlive the controller");
  fixture({ overlay: { users: [], default_user: "TESTHOST\\me" } });
  const r1 = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  assert.equal(r1.quarantined, true, JSON.stringify(r1));
  assert.ok(r1.found.includes(`tagged:${pids.pid}:node.exe`), r1.found.join(","));
  assert.ok(r1.found.includes(`descendant:${pids.grandchild}:node.exe`), r1.found.join(","));
  assert.ok(!r1.found.some((f) => f.startsWith("sandbox-user")));
  assert.ok(!r1.found.includes("lister-not-run") && !r1.found.includes("tree-not-checked"));
  // the grandchild alone, once its command line carries a sandbox-user mark: condition (a)
  fixture({ overlay: { users: [{ cmd: tag, user: SBX }], default_user: "TESTHOST\\me" } });
  const r2 = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  assert.equal(r2.quarantined, true);
  assert.ok(r2.found.includes(`sandbox-user:${pids.grandchild}:node.exe`), r2.found.join(","));
  assert.ok(r2.found.includes(`tagged:${pids.pid}:node.exe`));
});

test("case 2: the tagged parent exits, an untagged sandboxed grandchild survives: found only by (a)", { timeout: 180000 }, async () => {
  const variant = async (users, extra = []) => {
    const dir = mkdir();
    const tag = "cdx-gc-" + rand();
    const pidFile = path.join(env.root, `pids-${rand()}.json`);
    const c = await startController("exec-detached", dir, { sc: BASE({ sleepMs: 0, grandchildTag: tag, pidFile }), extra });
    const pids = await readPidFile(pidFile);
    assert.equal(await waitGone(pids.pid), true, "the fake exits at once");
    assert.ok(alive(pids.grandchild));
    await killOwner(c);
    rmrf(P.SLOT_LOCKS); // the next controller must find slot-1 clear (a stale one would cost a real 30 s listing)
    fixture({ overlay: { users: users(tag), default_user: "TESTHOST\\me" } });
    const r = await L.acquireWorktree(dir, { bin, treeState: treeOk });
    if (r.server) hold(r.server);
    return { r, pids, dir };
  };
  const a = await variant((tag) => [{ cmd: tag, user: SBX }]);
  assert.deepEqual(a.r, { quarantined: true, found: [`sandbox-user:${a.pids.grandchild}:node.exe`] });
  // without the user mark nothing but (a) can see it: auto-clear
  const b = await variant(() => []);
  assert.equal(b.r.cleared, "auto", JSON.stringify(b.r));
  assert.equal(readJson(wtRecord(b.dir)).cleared_by, "auto");
  // with the fake's pid recorded, the grandchild is a descendant of a recorded pid (rule 5)
  const c = await variant(() => [], ["--add-child"]);
  assert.deepEqual(c.r, { quarantined: true, found: [`descendant:${c.pids.grandchild}:node.exe`] });
});

test("case 3: host check started, controller killed: quarantined by (c) until cleared with a confirmation", { timeout: 180000 }, async () => {
  const dir = mkdir();
  const c = await startController("host", dir);
  // find the PING (a grandchild of the controller, child of the recorded cmd.exe) before killing the controller
  fixture({ overlay: { users: [], default_user: "TESTHOST\\me" } });
  let ping = null;
  assert.equal(await waitFor(() => {
    ping = PR.listProcs({ scope: "full" }).rows.find((r) => r.ppid === c.out.cmdPid && /^ping\.exe$/i.test(r.name));
    return !!ping;
  }, 20000, 200), true, "PING under the recorded cmd.exe");
  track(ping.pid);
  await killOwner(c);
  assert.equal(await waitGone(c.out.cmdPid), true, "cmd.exe dies with the controller (libuv job)");
  assert.ok(alive(ping.pid), "PING is a grandchild outside the job and survives");

  const log = path.join(env.root, `log-${rand()}`);
  fixture({ log, overlay: { users: [], default_user: "TESTHOST\\me" } });
  const r = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  assert.equal(r.quarantined, true);
  assert.deepEqual(r.found, ["host-check-started"]);
  assert.deepEqual(lists(log), [], "the static stage skipped the listing");

  const confirmFile = path.join(P.WT_LOCKS, sha1(P.canonPath(dir)) + ".clear-listing.json");
  const early = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk }); // no confirmation file yet
  assert.equal(early.reason, "confirm");
  assert.equal(early.cleared, false);
  assert.deepEqual(early.killed, []);
  assert.ok(alive(ping.pid));
  const first = await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  assert.equal(first.reason, "confirm");
  assert.equal(first.cleared, false);
  assert.equal(first.run, c.out.runId);
  assert.equal(first.clear_quarantine, P.canonPath(dir));
  const line = first.listed.find((l) => l.startsWith(`${ping.pid} `));
  assert.ok(line, first.listed.join("\n"));
  assert.match(line, new RegExp(`^${ping.pid} PING\\.EXE descendant user=TESTHOST\\\\me start=\\S+ cmd=C:\\\\Windows\\\\System32\\\\PING\\.EXE\\s+-n 60`));
  assert.ok(!line.endsWith(" ?"));
  assert.ok(first.notes.some((n) => n.startsWith("note: host-check-started (")), first.notes.join("|"));
  const cf = readJson(confirmFile);
  assert.equal(cf.run_id, c.out.runId);
  assert.ok(cf.candidates.some((x) => x.pid === ping.pid && x.why === "descendant" && x.name.toLowerCase() === "ping.exe"));
  assert.ok(alive(ping.pid));

  const done = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(done.cleared, true, JSON.stringify(done));
  assert.equal(done.reason, null);
  assert.ok(done.killed.some((k) => k.pid === ping.pid && k.ok === true), JSON.stringify(done.killed));
  assert.equal(await waitGone(ping.pid, 5000), true);
  assert.equal(fs.existsSync(confirmFile), false);
  const rec = readJson(wtRecord(dir));
  assert.deepEqual([rec.state, rec.cleared_by], ["clean", "user"]);
  assert.equal(readJson(slotRecord(1)).state, "clean", "the crashed run's slot record is cleared with it");
  const next = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  hold(next.server);
  assert.ok(next.server);
  assert.equal(next.cleared, undefined);
});

test("case 5: stale active record, no survivors: auto-cleared; every variant is quarantined with the named finding", { timeout: 240000 }, async () => {
  const dir = mkdir();
  const c = await startController("active-exit", dir);
  await waitGone(c.out.ownerPid);
  const rp = wtRecord(dir);
  const original = fs.readFileSync(rp, "utf8");
  const rec0 = JSON.parse(original);
  assert.equal(rec0.state, "active");
  const unrelated = mk(777777, { name: "notepad.exe", cmd: "notepad" });
  const attempt = async (fx, tree = treeOk) => {
    const log = path.join(env.root, `log-${rand()}`);
    fixture({ log, ...fx });
    const r = await L.acquireWorktree(dir, { bin, treeState: tree });
    if (r.server) hold(r.server);
    return { r, log };
  };
  const quarantined = async (name, fx, found, tree) => {
    const before = fs.readFileSync(rp, "utf8");
    const { r } = await attempt(fx, tree);
    assert.deepEqual(r, { quarantined: true, found }, name);
    assert.equal(fs.readFileSync(rp, "utf8"), before, `${name}: the record is untouched`);
  };
  const full = (rows) => ({ full: { ok: true, rows } });

  await quarantined("blind", { full: { ok: false, error: "x" } }, ["lister-blind:x"]);
  await quarantined("head", full([unrelated]), ["head-moved"], () => ({ head: "d".repeat(40), hash: X }));
  await quarantined("hash", full([unrelated]), ["tree-changed"], () => ({ head: H, hash: Y }));
  await quarantined("sandbox", full([mk(555, { name: "x.exe", user: "TESTHOST\\CodexSandboxOnline" })]), ["sandbox-user:555:x.exe"]);
  await quarantined("tagged", full([mk(556, { cmd: `C:\\runs\\${rec0.run_id.toUpperCase()}\\x` })]), ["tagged:556:x.exe"]);
  await quarantined("owner", full([mk(rec0.owner_pid, { name: "node.exe", start: rec0.owner_start_time })]), [`owner-alive:${rec0.owner_pid}:node.exe`]);

  fs.rmSync(PR.LISTER_PROBE);
  const un = await attempt(full([unrelated]));
  assert.deepEqual(un.r, { quarantined: true, found: ["lister-blind:lister-unverified"] });
  assert.deepEqual(lists(un.log), [], "no listing without a verified lister");
  probeOk();

  const half = path.join(P.WT_LOCKS, `.${path.basename(rp)}.1.0123abcd.tmp`);
  fs.writeFileSync(half, "x");
  const h = await attempt(full([unrelated]));
  assert.deepEqual(h.r, { quarantined: true, found: ["record-half-written"] });
  assert.deepEqual(lists(h.log), []);
  fs.rmSync(half);

  fs.writeFileSync(rp, "{");
  const ij = await attempt(full([unrelated]));
  assert.deepEqual(ij.r, { quarantined: true, found: ["record-invalid-json"] });
  const noStart = { ...rec0 };
  delete noStart.owner_start_time;
  fs.writeFileSync(rp, JSON.stringify(noStart));
  const is = await attempt(full([unrelated]));
  assert.deepEqual(is.r, { quarantined: true, found: ["record-invalid-schema:owner_start_time"] });
  fs.writeFileSync(rp, original);

  // the final hash written by markTreeFinal also matches
  L.markTreeFinal(rp, Y);
  const afterFinal = fs.readFileSync(rp, "utf8");
  await quarantined("hash-other", full([unrelated]), ["tree-changed"], () => ({ head: H, hash: "e".repeat(64) }));
  assert.equal(fs.readFileSync(rp, "utf8"), afterFinal);
  fs.writeFileSync(rp, original);

  // a `.x.tmp` file next to the record does not count; no survivors: auto-clear, exactly one full listing
  fs.writeFileSync(path.join(P.WT_LOCKS, `.${path.basename(rp)}.x.tmp`), "x");
  const ok = await attempt(full([unrelated]));
  assert.equal(ok.r.cleared, "auto", JSON.stringify(ok.r));
  assert.deepEqual(lists(ok.log), ["list:full"]);
  const rec = readJson(rp);
  assert.deepEqual([rec.state, rec.cleared_by], ["clean", "auto"]);
  await release(ok.r);

  // stub hash = the recorded final hash: clear
  rmrf(P.SLOT_LOCKS);
  const dir2 = mkdir();
  const c2 = await startController("active-exit", dir2);
  await waitGone(c2.out.ownerPid);
  L.markTreeFinal(wtRecord(dir2), Y);
  const fin = await attempt2(dir2, { full: { ok: true, rows: [unrelated] } }, () => ({ head: H, hash: Y }));
  assert.equal(fin.cleared, "auto");
  async function attempt2(d, fx, tree) {
    fixture(fx);
    const r = await L.acquireWorktree(d, { bin, treeState: tree });
    hold(r.server);
    return r;
  }
});

test("case 6: a clean record is clear without any search", async () => {
  const dir = mkdir();
  const a = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  const rp = a.recordPath;
  L.writeActive(rp, { cwd: dir, run_id: RID, run_dir: "d", owner_pid: process.pid, owner_start_time: T0, baseline: H, tree_hash_pre: X });
  L.writeClean(rp, RID);
  await release(a);
  const log = path.join(env.root, `log-${rand()}`);
  fixture({ log }); // any listing would answer "fixture: no full"
  const b = await L.acquireWorktree(dir, { bin, treeState: () => assert.fail("no tree check for a clean record") });
  hold(b.server);
  assert.ok(b.server);
  assert.equal(b.cleared, undefined);
  assert.equal(b.prev.state, "clean");
  assert.deepEqual(logLines(log), []);
  fs.rmSync(PR.LISTER_PROBE, { force: true }); // and no lister verification either
  await release(b);
  const c = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  hold(c.server);
  assert.ok(c.server);
});

// =============================================================================== clearQuarantine (static fixtures)

const R1 = "2026-10-06T10:05:00.0000000Z";
const R2 = "2026-10-06T10:06:00.0000000Z";
const R0 = "2026-10-06T10:04:00.0000000Z";

/** A fresh folder with a hand-written active worktree record. Returns {dir, rp, rec}. */
function setupQ(recOver = {}) {
  const dir = mkdir("q");
  const rp = wtRecord(dir);
  const rec = validRec("worktree", { cwd: P.canonPath(dir), key: sha1(P.canonPath(dir)), ...recOver });
  writeJson(rp, rec);
  return { dir, rp, rec };
}
const confirmPath = (dir) => path.join(P.WT_LOCKS, sha1(P.canonPath(dir)) + ".clear-listing.json");
const FREE = { ok: true, rows: [] };

test("clearQuarantine: cwd-missing, except-needs-yes, busy, not-quarantined, lister-blind", { timeout: 60000 }, async () => {
  const missing = await L.clearQuarantine(path.join(env.root, "gone-" + rand()), { yes: false, bin, treeState: treeOk });
  assert.equal(missing.reason, "cwd-missing");
  assert.equal(missing.cleared, false);
  const { dir, rp, rec } = setupQ();
  const log = path.join(env.root, `log-${rand()}`);
  fixture({ log, full: FREE });
  const nope = await L.clearQuarantine(dir, { yes: false, except: [5], bin, treeState: treeOk });
  assert.equal(nope.reason, "except-needs-yes");
  assert.deepEqual(logLines(log), []);
  assert.equal(fs.existsSync(confirmPath(dir)), false);
  // busy: a live run holds the pipe
  const pipeHolder = runChild(["pipe", "wt-" + sha1(P.canonPath(dir))]);
  assert.deepEqual(await pipeHolder.result, { server: true });
  const busy = await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  assert.equal(busy.reason, "busy");
  assert.equal(busy.cleared, false);
  assert.deepEqual(logLines(log), []);
  process.kill(pipeHolder.child.pid);
  await waitGone(pipeHolder.child.pid);
  await new Promise((r) => setTimeout(r, 500)); // the OS closes the dead process's handles a moment later
  // lister blind
  fixture({ log, full: { ok: false, error: "x" } });
  const blind = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(blind.reason, "lister-blind:x");
  assert.equal(blind.cleared, false);
  assert.deepEqual(readJson(rp), rec);
  // not quarantined
  L.writeClean(rp, rec.run_id);
  const clean = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(clean.reason, "not-quarantined");
  fs.rmSync(rp);
  assert.equal((await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk })).reason, "not-quarantined");
});

test("clearQuarantine: confirmation file, kill order, --except, new candidates, notes, final clean record", { timeout: 60000 }, async () => {
  const { dir, rp, rec } = setupQ({ host_started: true, child_pids: [] });
  fs.rmSync(PR.LISTER_PROBE); // a note: lister-unverified
  const mkrows = () => [
    mk(999999, { name: "codex.exe", cmd: `"C:\\x\\codex.exe" -o C:\\runs\\${RID}\\last.json`, start: R1 }),
    mk(999997, { name: "node.exe", ppid: 999999, start: R2 }),
    mk(999995, { name: "weird.exe", user: SBX, start: R2 }),
    mk(999993, { name: "PING.EXE", cmd: `ping ${RID}`, start: R0 }),
  ];
  const e = mk(999991, { name: "node.exe", cmd: `node ${RID}`, start: R2 });
  const startTimes = { 999999: R1, 999997: R2, 999995: R2, 999993: R0, 999991: R2 };
  const log = path.join(env.root, `log-${rand()}`);
  fixture({ log, startTimes, full: [
    { ok: true, rows: mkrows() }, // call 1
    { ok: true, rows: mkrows() }, // the unknown --except call (it lists before it validates)
    { ok: true, rows: [...mkrows(), e] }, // the clearing call: fresh candidates, one new
    { ok: true, rows: [mkrows()[3]] }, // its re-listing: only the excepted one is left
  ] });
  const tree = () => ({ head: H, hash: Y }); // tree-changed note
  const first = await L.clearQuarantine(dir, { yes: false, bin, treeState: tree });
  assert.equal(first.reason, "confirm");
  assert.equal(first.cleared, false);
  assert.deepEqual(first.killed, []);
  assert.equal(first.listed.length, 4);
  // unknown names get a " ?" suffix: codex.exe and PING.EXE are known, node.exe and weird.exe are not
  assert.deepEqual(first.listed.filter((l) => l.endsWith(" ?")).map((l) => l.split(" ")[1]), ["node.exe", "weird.exe"]);
  assert.ok(first.listed.some((l) => l.startsWith("999993 PING.EXE tagged user=TESTHOST\\me start=" + R0 + " cmd=ping ")));
  assert.ok(first.notes.some((n) => n.startsWith("note: host-check-started (")));
  assert.ok(first.notes.some((n) => n.startsWith("note: tree-changed (inspect git status and git diff")));
  assert.ok(first.notes.some((n) => n.startsWith("note: lister-unverified")));
  assert.deepEqual(readJson(confirmPath(dir)).candidates.map((x) => x.pid).sort(), [999993, 999995, 999997, 999999]);
  assert.deepEqual(readJson(rp), rec, "the record is untouched until the clear");

  const bad = await L.clearQuarantine(dir, { yes: true, except: [12345], bin, treeState: tree });
  assert.equal(bad.reason, "except-unknown:12345");
  assert.deepEqual(bad.killed, []);
  assert.equal(bad.cleared, false);
  assert.equal(lists(log).length, 2, "an unknown --except stops after the fresh listing, before any kill");

  const done = await L.clearQuarantine(dir, { yes: true, except: [999993], bin, treeState: tree });
  assert.equal(done.cleared, true, JSON.stringify(done));
  assert.equal(done.reason, null);
  // (i) tagged/owner/child by start, oldest first (the oldest, 999993, is excepted), (ii) descendants, (iii) sandbox users
  assert.deepEqual(done.killed.map((k) => k.pid), [999999, 999997, 999995]);
  assert.ok(done.killed.every((k) => k.ok === true));
  assert.equal(done.excepted.length, 1);
  assert.ok(done.excepted[0].includes("999993"));
  assert.ok(done.new_candidates.length === 1 && done.new_candidates[0].includes("999991"));
  assert.deepEqual(done.survivors, []);
  assert.equal(readJson(rp).state, "clean");
  assert.equal(readJson(rp).cleared_by, "user");
  assert.equal(fs.existsSync(confirmPath(dir)), false);
});

test("clearQuarantine: survivors keep the record active and the confirmation file", { timeout: 60000 }, async () => {
  const { dir, rp, rec } = setupQ();
  const row = mk(999995, { name: "node.exe", cmd: `node ${RID}`, start: R1 });
  fixture({ startTimes: { 999995: R1 }, full: { ok: true, rows: [row] } });
  await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  const r = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(r.cleared, false);
  assert.equal(r.reason, "survivors");
  assert.deepEqual(r.survivors, ["tagged:999995:node.exe"]);
  assert.deepEqual(r.killed.map((k) => k.pid), [999995]);
  assert.deepEqual(readJson(rp), rec);
  assert.equal(fs.existsSync(confirmPath(dir)), true);
  // a blind re-listing is also survivors
  fixture({ startTimes: { 999995: R1 }, full: [{ ok: true, rows: [row] }, { ok: false, error: "late" }] });
  const b = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(b.reason, "survivors");
  assert.equal(b.cleared, false);
  assert.ok(b.survivors.some((s) => s.includes("lister-blind:late")));
});

test("clearQuarantine: an expired confirmation (31 min) or one for another run asks again; a real kill happens only on a match", { timeout: 90000 }, async () => {
  const { dir, rp } = setupQ();
  const victim = spawn(process.execPath, ["-e", "setTimeout(()=>{},90000)", RID], { stdio: "ignore", windowsHide: true });
  victim.on("error", () => {});
  track(victim.pid);
  const row = mk(victim.pid, { name: "node.exe", cmd: `node -e x ${RID}`, start: R1 });
  const fx = (st) => fixture({ startTimes: { [victim.pid]: st }, full: { ok: true, rows: [row] } });
  fx(R1);
  await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  const cf = readJson(confirmPath(dir));
  writeJson(confirmPath(dir), { ...cf, at: new Date(Date.now() - 31 * 60000).toISOString() });
  const stale = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(stale.reason, "confirm");
  assert.deepEqual(stale.killed, []);
  assert.ok(Date.now() - Date.parse(readJson(confirmPath(dir)).at) < 60000, "a fresh file was written");
  writeJson(confirmPath(dir), { ...readJson(confirmPath(dir)), run_id: "20250101T000000Z-zzzzzz" });
  const other = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(other.reason, "confirm");
  assert.ok(alive(victim.pid));
  // the pid's start time changed since the listing: a reused pid is not killed
  fx(R2);
  const reuse = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.ok(alive(victim.pid), "a pid whose start time differs from the confirmed row is not killed");
  assert.ok(reuse.killed.every((k) => k.pid !== victim.pid || /skipped/.test(k.out)), JSON.stringify(reuse.killed));
  // matching start time: really killed (our own process)
  fx(R1);
  await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  const done = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(await waitGone(victim.pid, 5000), true);
  assert.ok(done.killed.some((k) => k.pid === victim.pid && k.ok === true));
  assert.equal(done.cleared === true || done.reason === "survivors", true); // the static fixture still lists it
  assert.ok(rp);
});

test("clearQuarantine: a vanished descendant is skipped as gone (real processes, overlay listing)", { timeout: 90000 }, async () => {
  const parent = spawn(process.execPath, ["-e",
    `const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>{},90000)"],{stdio:"ignore",windowsHide:true});console.log(c.pid);setTimeout(()=>{},90000)`],
  { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  track(parent.pid);
  const child = await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  track(child);
  const t = new Date().toISOString();
  const { dir } = setupQ({ owner_pid: 999999, owner_start_time: new Date(Date.now() - 600000).toISOString().replace("Z", "0000Z"),
    child_pids: [{ pid: parent.pid, at: t }] });
  fixture({ overlay: { users: [], default_user: "TESTHOST\\me" } });
  const first = await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  assert.ok(first.listed.some((l) => l.startsWith(`${parent.pid} node.exe child-alive`)), JSON.stringify(first));
  assert.ok(first.listed.some((l) => l.startsWith(`${child} node.exe descendant`)), first.listed.join("\n"));
  const done = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(done.cleared, true, JSON.stringify(done));
  // the parent first (taskkill /T takes its whole tree: the child and the conhost.exe rows), then each descendant is gone
  assert.equal(done.killed[0].pid, parent.pid, JSON.stringify(done));
  assert.equal(done.killed[0].ok, true);
  assert.ok(done.killed.length >= 2 && done.killed.slice(1).every((k) => k.ok && k.out === "gone"), JSON.stringify(done.killed));
  assert.ok(done.killed.some((k) => k.pid === child), JSON.stringify(done.killed));
  assert.equal(await waitGone(parent.pid, 5000), true);
  assert.equal(await waitGone(child, 5000), true);
});

test("clearQuarantine: slot targets clear the slot record; a worktree target also clears its run's slot record and TMP", { timeout: 60000 }, async () => {
  fixture({ full: FREE });
  writeJson(slotRecord(2), validRec("slot", { host_started: true }));
  const s = await L.clearQuarantine("slot-2", { yes: false, bin });
  assert.equal(s.clear_quarantine, "slot-2");
  assert.equal(s.reason, "confirm");
  assert.ok(s.notes.some((n) => n.startsWith("note: host-check-started")));
  assert.equal(fs.existsSync(path.join(P.SLOT_LOCKS, "2.clear-listing.json")), true);
  const sd = await L.clearQuarantine("slot-2", { yes: true, bin });
  assert.equal(sd.cleared, true, JSON.stringify(sd));
  assert.deepEqual([readJson(slotRecord(2)).state, readJson(slotRecord(2)).cleared_by], ["clean", "user"]);
  assert.equal((await L.clearQuarantine("slot-2", { yes: true, bin })).reason, "not-quarantined");

  const { dir } = setupQ();
  const tmp = path.join(dir, ".codex-tmp", RID);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "x"), "x");
  writeJson(slotRecord(1), validRec("slot", { run_id: "20261006T100001Z-bbbbbb" })); // another run: stays
  writeJson(slotRecord(3), validRec("slot")); // the same run: cleared with the worktree
  await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  const w = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(w.cleared, true, JSON.stringify(w));
  assert.equal(fs.existsSync(path.join(dir, ".codex-tmp")), false);
  assert.equal(readJson(slotRecord(1)).state, "active");
  assert.equal(readJson(slotRecord(3)).state, "clean");
  const n = await L.acquireWorktree(dir, { bin, treeState: treeOk });
  hold(n.server);
  assert.ok(n.server);
});

test("clearQuarantine: an unreadable record is listed by rule 1 only, noted, and cleared with a null run", { timeout: 60000 }, async () => {
  const dir = mkdir("q");
  fs.mkdirSync(P.WT_LOCKS, { recursive: true });
  fs.writeFileSync(wtRecord(dir), "{");
  fixture({ full: { ok: true, rows: [mk(999995, { user: SBX, start: R1, name: "PING.EXE" }), mk(999993, { cmd: "x " + RID })] },
    startTimes: { "*": R1 } });
  const first = await L.clearQuarantine(dir, { yes: false, bin, treeState: treeOk });
  assert.equal(first.run, null);
  assert.deepEqual(first.listed.map((l) => l.split(" ")[0]), ["999995"]);
  assert.ok(first.notes.includes("note: record-invalid-json"));
  assert.equal(readJson(confirmPath(dir)).run_id, null);
  fixture({ full: [{ ok: true, rows: [mk(999995, { user: SBX, start: R1, name: "PING.EXE" })] }, FREE], startTimes: { "*": R1 } });
  const done = await L.clearQuarantine(dir, { yes: true, bin, treeState: treeOk });
  assert.equal(done.cleared, true, JSON.stringify(done));
  const rec = readJson(wtRecord(dir));
  assert.deepEqual([rec.state, rec.run_id, rec.cleared_by], ["clean", null, "user"]);
});
