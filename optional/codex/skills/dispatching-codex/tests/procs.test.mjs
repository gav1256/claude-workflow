import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { tmpEnv, scenario, FAKE_CODEX, rmrf } from "./helpers.mjs";

// paths.mjs reads the environment at import: set it before the dynamic imports.
const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = env.CODEX_HOME;
process.env.CODEX_RUN_PIPE_PREFIX = env.CODEX_RUN_PIPE_PREFIX;
delete process.env.CODEX_RUN_PROCS;
const P = await import("../lib/paths.mjs");
const PR = await import("../lib/procs.mjs");
assert.equal(P.STATE.startsWith(env.root), true, "state dir must be inside the temp root");

// Every process a test starts is registered here and killed (by pid, never by name) at the end.
const own = new Set();
const track = (pid) => { if (Number.isInteger(pid)) own.add(pid); return pid; };
after(() => {
  for (const pid of own) PR.killTree(pid);
  env.cleanup();
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return !!(await fn());
}
const waitGone = (pid, ms) => waitFor(() => !alive(pid), ms);

/** A node sleeper (own process, hidden); `tag` ends up on its command line. */
function sleeper(tag, ms = 120000) {
  const c = spawn(process.execPath, ["-e", `setTimeout(()=>{},${ms})`, tag], { stdio: "ignore", windowsHide: true });
  c.on("error", () => {});
  track(c.pid);
  return c;
}

const SBX = "TESTHOST\\CodexSandboxOffline";
function fixture(obj) {
  const f = path.join(env.root, `fx-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  process.env.CODEX_RUN_PROCS = f;
  PR.resetListCache();
  return f;
}
const noFixture = () => { delete process.env.CODEX_RUN_PROCS; PR.resetListCache(); };

const T0 = "2026-10-06T10:00:00.0000000Z";
const mk = (pid, o = {}) => ({ pid, ppid: null, name: "x.exe", user: "TESTHOST\\me", cmd: null, session: 1, start: null, ...o });
const REC = {
  v: 1, kind: "worktree", key: "k", cwd: "c:\\x", run_id: "20261006T100000Z-aaaaaa", run_dir: "d", state: "active",
  owner_pid: 1000, owner_start_time: T0, child_pids: [], host_started: false,
};
const find = (o) => PR.procFindings({ rec: REC, selfPid: 1, listerPid: 2, runId: REC.run_id, mode: "quarantine", rows: [], ...o });
const whys = (r) => r.map((f) => f.text);

// ---------------------------------------------------------------------------- isSandboxed

test("isSandboxed: the user rule, the name rule only when the owner is unknown", () => {
  assert.equal(PR.isSandboxed(mk(1, { user: "HOST\\CodexSandboxOffline" })), true);
  assert.equal(PR.isSandboxed(mk(1, { user: "HOST\\CodexSandboxOnline" })), true);
  assert.equal(PR.isSandboxed(mk(1, { user: "CodexSandboxFuture_2" })), true);
  assert.equal(PR.isSandboxed(mk(1, { user: "HOST\\me" })), false);
  assert.equal(PR.isSandboxed(mk(1, { user: "HOST\\CodexSandboxUsers\\x" })), false);
  assert.equal(PR.isSandboxed(mk(1, { user: null, name: "codex-command-runner-0.160.0.exe" })), true);
  assert.equal(PR.isSandboxed(mk(1, { user: null, name: "PING.EXE" })), false);
  // a known owner switches the name rule off
  assert.equal(PR.isSandboxed(mk(1, { user: "HOST\\me", name: "codex-command-runner-0.160.0.exe" })), false);
});

// ---------------------------------------------------------------------------- parseListing

const SAMPLE_TL = [
  '"codex-command-runner-0.160.0.exe","24552","Console","1","10,644 K","Unknown","HOST\\CodexSandboxOffline","0:00:00","N/A"',
  '"PING.EXE","26648","Console","1","5,652 K","Unknown","HOST\\CodexSandboxOffline","0:00:00","N/A"',
  '"csrss.exe","2092","Console","1","10,052 K","Unknown","N/A","0:00:50","N/A"',
  '"node.exe","4242","Console","1","40,000 K","Unknown","HOST\\USER","0:00:01","N/A"',
].join("\n");
const SAMPLE_CIM = [
  { pid: 25652, ppid: 22252, name: "codex.exe", cmd: '"C:\\x\\codex.exe" sandbox -P :workspace', session: 1, start: "2026-10-06T20:16:48.9944180Z" },
  { pid: 24552, ppid: 25652, name: "codex-command-runner-0.160.0.exe", cmd: "C:\\Users\\USER\\.codex\\.sandbox-bin\\codex-command-runner-0.160.0.exe --pipe-in=1", session: 1, start: "2026-10-06T20:16:49.1000000Z" },
  { pid: 26648, ppid: 24552, name: "PING.EXE", cmd: "C:\\Windows\\System32\\PING.EXE -n 240 127.0.0.1", session: 1, start: null },
  { pid: 14852, ppid: 2156, name: "codex-windows-sandbox-service.exe", cmd: null, session: 0, start: null },
  { pid: 4242, ppid: 100, name: "node.exe", cmd: "node x", session: 1, start: "2026-10-06T20:00:00.0000000Z" },
];
const listingJson = (o = {}) => JSON.stringify({ session: 1, tlExit: 0, cim: SAMPLE_CIM, tasklist: SAMPLE_TL, ...o });
const parse = (o, extra = {}) => PR.parseListing(listingJson(o), "session", { selfPid: 4242, listerPid: 7, ...extra });

test("parseListing: the sanitized sample (owners, merge, tasklist-only rows)", () => {
  const r = parse();
  assert.equal(r.ok, true);
  assert.equal(r.scope, "session");
  assert.equal(r.session, 1);
  assert.equal(r.listerPid, 7);
  const by = new Map(r.rows.map((x) => [x.pid, x]));
  assert.equal(by.get(24552).user, "HOST\\CodexSandboxOffline");
  assert.equal(by.get(26648).user, "HOST\\CodexSandboxOffline");
  assert.equal(PR.isSandboxed(by.get(24552)), true);
  assert.equal(PR.isSandboxed(by.get(26648)), true);
  assert.equal(by.get(25652).user, null); // no tasklist row in the sample
  assert.equal(PR.isSandboxed(by.get(25652)), false);
  assert.equal(by.get(14852).user, null);
  assert.equal(PR.isSandboxed(by.get(14852)), false); // a service, not a runner
  assert.equal(by.get(4242).user, "HOST\\USER");
  assert.deepEqual(Object.keys(by.get(4242)), ["pid", "ppid", "name", "user", "cmd", "session", "start"]);
  // csrss only exists in tasklist: no CIM data, "N/A" owner is null
  assert.deepEqual(by.get(2092), { pid: 2092, ppid: null, name: "csrss.exe", user: null, cmd: null, session: 1, start: null });
});

test("parseListing: pid race (same pid, different name) gives user null", () => {
  const cim = SAMPLE_CIM.map((x) => (x.pid === 26648 ? { ...x, name: "other.exe" } : x));
  const r = parse({ cim });
  const row = r.rows.find((x) => x.pid === 26648);
  assert.equal(row.name, "other.exe");
  assert.equal(row.user, null);
  // the tasklist row is not added a second time
  assert.equal(r.rows.filter((x) => x.pid === 26648).length, 1);
});

test("parseListing: a tasklist-only row takes the session from field 3", () => {
  const tl = SAMPLE_TL + '\n"late.exe","555","Services","0","1 K","Unknown","HOST\\CodexSandboxOffline","0:00:00","N/A"';
  const r = parse({ tasklist: tl });
  assert.deepEqual(r.rows.find((x) => x.pid === 555),
    { pid: 555, ppid: null, name: "late.exe", user: "HOST\\CodexSandboxOffline", cmd: null, session: 0, start: null });
});

test("parseListing: CSV quotes, CRLF, blank lines and an INFO: line", () => {
  const tl = '"we ""x"".exe","4242","Console","1","1 K","Unknown","HOST\\USER","0:00:00","N/A"\r\n\r\n';
  const r = PR.parseListing(listingJson({ cim: [], tasklist: tl }), "session", { selfPid: 4242, listerPid: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].name, 'we "x".exe');
  const none = PR.parseListing(listingJson({ cim: [], tasklist: "INFO: No tasks are running." }), "session", {});
  assert.deepEqual(none.rows, []);
});

test("parseListing: failures are closed", () => {
  assert.deepEqual(PR.parseListing("not json", "session", {}), { ok: false, error: "lister-output" });
  assert.deepEqual(parse({ tlExit: 3 }), { ok: false, error: "tasklist-exit-3" });
  assert.deepEqual(parse({ tasklist: '"a.exe","1","Console","1","1 K","Unknown","N/A","0:00:00"' }),
    { ok: false, error: "tasklist-parse" });
  assert.deepEqual(parse({ tasklist: "garbage line" }), { ok: false, error: "tasklist-parse" });
});

test("parseListing: the positivity check needs the self row with a user", () => {
  assert.deepEqual(parse({}, { selfPid: 99999 }), { ok: false, error: "self-not-visible" });
  assert.deepEqual(parse({}, { selfPid: 25652 }), { ok: false, error: "self-not-visible" }); // user null
  assert.equal(parse({}, { selfPid: 4242 }).ok, true);
  // no selfPid (overlay mode): no positivity check
  assert.equal(PR.parseListing(listingJson(), "session", { listerPid: 7 }).ok, true);
});

// ---------------------------------------------------------------------------- procFindings

test("procFindings: sandbox-user, tagged (any case), reported once in rule order", () => {
  const rows = [
    mk(10, { user: SBX, cmd: "a" }),
    mk(11, { cmd: `C:\\x\\runs\\${REC.run_id.toUpperCase()}\\last.json` }),
    mk(12, { user: SBX, cmd: REC.run_id }), // both rules: sandbox-user wins
    mk(13, { cmd: "unrelated" }),
  ];
  assert.deepEqual(whys(find({ rows })), ["sandbox-user:10:x.exe", "tagged:11:x.exe", "sandbox-user:12:x.exe"]);
});

test("procFindings: owner-alive needs the same pid and the same start string", () => {
  const same = [mk(1000, { start: T0 })];
  assert.deepEqual(whys(find({ rows: same })), ["owner-alive:1000:x.exe"]);
  assert.deepEqual(find({ rows: [mk(1000, { start: "2026-10-06T11:00:00.0000000Z" })] }), []); // reused pid
  assert.deepEqual(find({ rows: same, mode: "end" }), []); // the owner is this script
});

test("procFindings: child-alive, the 5 s slack on `at`, and pid reuse", () => {
  const rec = { ...REC, child_pids: [{ pid: 2000, at: "2026-10-06T10:00:10.000Z" }] };
  const at = (start) => find({ rec, rows: [mk(2000, { start })] }).map((f) => f.why);
  assert.deepEqual(at("2026-10-06T10:00:09.5000000Z"), ["child-alive"]);
  assert.deepEqual(at("2026-10-06T10:00:15.0000000Z"), ["child-alive"]); // at + 5000 exactly
  assert.deepEqual(at("2026-10-06T10:00:15.5000000Z"), []); // started later: a reused pid
  assert.deepEqual(at("2026-10-06T09:59:59.0000000Z"), []); // older than the run
  assert.deepEqual(at(null), ["child-alive"]); // unknown start counts
});

test("procFindings: descendants of recorded pids and of counted rows (fixpoint, start order)", () => {
  const rec = { ...REC, child_pids: [{ pid: 2000, at: "2026-10-06T10:00:10.000Z" }] };
  const rows = [
    mk(30, { ppid: 31, start: "2026-10-06T10:02:00.0000000Z" }), // child of 31, listed first
    mk(31, { ppid: 1000, start: "2026-10-06T10:01:00.0000000Z" }), // child of the owner
    mk(32, { ppid: 2000, start: null }), // child of a recorded pid, unknown start
    mk(33, { ppid: 1000, start: "2026-10-06T09:00:00.0000000Z" }), // older than the run: pid reuse
    mk(34, { ppid: 31, start: "2026-10-06T10:00:30.0000000Z" }), // older than its parent: not a child
    mk(35, { ppid: 99, start: T0 }), // parent not counted
  ];
  assert.deepEqual(whys(find({ rec, rows })), ["descendant:30:x.exe", "descendant:31:x.exe", "descendant:32:x.exe"]);
  // end mode: the owner is this script, its own direct children (conhost...) do not count; recorded children's do
  assert.deepEqual(whys(find({ rec, rows, mode: "end" })), ["descendant:32:x.exe"]);
});

test("procFindings: the self chain (an ancestor mentioning the old run id) and the lister subtree are never counted", () => {
  const rows = [
    mk(1, { ppid: 50, cmd: "node codex-run.mjs --continue " + REC.run_id, start: "2026-10-06T12:00:01.0000000Z" }),
    mk(50, { ppid: 60, cmd: "pwsh codex-run.mjs --continue " + REC.run_id, start: "2026-10-06T12:00:00.0000000Z" }),
    mk(60, { ppid: 0, cmd: "explorer " + REC.run_id, start: "2026-10-06T11:00:00.0000000Z" }),
    mk(2, { ppid: 1, name: "powershell.exe", cmd: REC.run_id, start: "2026-10-06T12:00:02.0000000Z" }),
    mk(70, { ppid: 2, name: "tasklist.exe", cmd: REC.run_id, start: "2026-10-06T12:00:03.0000000Z" }),
    mk(71, { ppid: 70, name: "conhost.exe", user: SBX, start: "2026-10-06T12:00:04.0000000Z" }),
    mk(80, { cmd: REC.run_id }),
    mk(81, { ppid: 1, cmd: REC.run_id }), // a child of this process is not excluded (only its ancestors and the lister subtree are)
  ];
  assert.deepEqual(whys(find({ rows })), ["tagged:80:x.exe", "tagged:81:x.exe"]);
  // a parent that started AFTER the child is a reused pid: not part of the chain
  const reused = [mk(1, { ppid: 50, start: "2026-10-06T12:00:01.0000000Z" }),
    mk(50, { cmd: REC.run_id, start: "2026-10-06T12:30:00.0000000Z" })];
  assert.deepEqual(whys(find({ rows: reused })), ["tagged:50:x.exe"]);
});

test("procFindings: mode end counts sandbox rows from the owner's start, or with an unknown start", () => {
  const rows = [
    mk(10, { user: SBX, start: "2026-10-06T09:59:59.0000000Z" }), // older than this run
    mk(11, { user: SBX, start: T0 }),
    mk(12, { user: SBX, start: null }),
    mk(13, { user: SBX, start: "garbage" }), // NaN counts as null
    mk(14, { user: null, name: "codex-command-runner-0.160.0.exe", start: null }),
  ];
  assert.deepEqual(whys(find({ rows, mode: "end" })), [
    "sandbox-user:11:x.exe", "sandbox-user:12:x.exe", "sandbox-user:13:x.exe", "sandbox-user:14:codex-command-runner-0.160.0.exe"]);
  assert.equal(find({ rows }).length, 5); // quarantine mode: every sandbox row
});

test("procFindings: without a usable record only rules 1 and 2 run", () => {
  const rows = [mk(10, { user: SBX }), mk(11, { cmd: "x " + REC.run_id }), mk(1000, { start: T0 }), mk(12, { ppid: 1000 })];
  assert.deepEqual(whys(find({ rec: null, rows })), ["sandbox-user:10:x.exe", "tagged:11:x.exe"]);
  assert.deepEqual(whys(find({ rec: null, rows, runId: null })), ["sandbox-user:10:x.exe"]);
});

// ---------------------------------------------------------------------------- quarantine sees a partial listing

test("quarantine: a session-scope listing is lister-partial and never clears", async () => {
  const { quarantine } = await import("../lib/locks.mjs");
  const prev = { ...REC, baseline: "a".repeat(40), tree_hash_pre: "b".repeat(64), tree_hash_final: null };
  const q = quarantine({ kind: "slot", prev, procs: { ok: true, scope: "session", session: 1, rows: [] } });
  assert.equal(q.clear, false);
  assert.deepEqual(q.found, ["lister-partial"]);
});

// ---------------------------------------------------------------------------- fixtures

test("fixture (static): arrays are consumed once per call per scope, the last entry repeats; log lines", () => {
  const log = path.join(env.root, "fx.log");
  fixture({
    log,
    session: [{ ok: true, rows: [mk(1)] }, { ok: false, error: "boom" }],
    full: { ok: true, rows: [mk(2, { session: 0 }), mk(process.pid, { session: 3 })] },
  });
  const a = PR.listProcs({ scope: "session" });
  assert.equal(a.ok, true);
  assert.equal(a.scope, "session");
  assert.equal(a.session, 1); // no self row
  assert.deepEqual(a.rows, [mk(1)]);
  assert.deepEqual(PR.listProcs({ scope: "session" }), { ok: false, scope: "session", error: "boom" });
  assert.deepEqual(PR.listProcs({ scope: "session" }), { ok: false, scope: "session", error: "boom" }); // repeats
  const f = PR.listProcs({ scope: "full" });
  assert.equal(f.session, 3); // the self row's session
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["list:session", "list:session", "list:session", "list:full"]);
});

test("fixture (static): rows are normalized; a missing scope is an error; startTime from startTimes", () => {
  fixture({ full: { ok: true, rows: [{ pid: 5, name: "a.exe" }] }, startTimes: { 7: "2026-02-02T00:00:00.0000000Z", "*": "2026-03-03T00:00:00.0000000Z" } });
  assert.deepEqual(PR.listProcs({ scope: "full" }).rows, [{ pid: 5, ppid: null, name: "a.exe", user: null, cmd: null, session: null, start: null }]);
  assert.deepEqual(PR.listProcs({ scope: "session" }), { ok: false, scope: "session", error: "fixture: no session" });
  assert.equal(PR.startTime(7), "2026-02-02T00:00:00.0000000Z");
  assert.equal(PR.startTime(8), "2026-03-03T00:00:00.0000000Z");
  fixture({ log: path.join(env.root, "fx2.log") });
  assert.equal(PR.startTime(8), "2026-01-01T00:00:00.0000000Z");
  assert.equal(fs.readFileSync(path.join(env.root, "fx2.log"), "utf8"), "start:8\n");
});

test("fixture: the file is re-read on every call; maxAgeMs reuses a listing of the same or wider scope", () => {
  const log = path.join(env.root, "fx3.log");
  const f = fixture({ log, full: { ok: true, rows: [mk(1)] }, session: { ok: true, rows: [mk(2)] } });
  const a = PR.listProcs({ scope: "full", maxAgeMs: 120000 });
  fs.writeFileSync(f, JSON.stringify({ log, full: { ok: true, rows: [mk(3)] }, session: { ok: true, rows: [mk(2)] } }));
  assert.deepEqual(PR.listProcs({ scope: "full", maxAgeMs: 120000 }).rows, a.rows); // cached
  assert.deepEqual(PR.listProcs({ scope: "session", maxAgeMs: 120000 }).rows, a.rows); // wider scope reused
  assert.deepEqual(PR.listProcs({ scope: "full" }).rows, [mk(3)]); // maxAgeMs 0 re-reads
  PR.resetListCache();
  assert.deepEqual(PR.listProcs({ scope: "session", maxAgeMs: 120000 }).rows, [mk(2)]);
  assert.deepEqual(PR.listProcs({ scope: "full", maxAgeMs: 120000 }).rows, [mk(3)]); // narrower cache is not reused
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["list:full", "list:full", "list:session", "list:full"]);
});

test("fixture (overlay): a real CIM-only listing with users from the overlay, filtered to the session", { timeout: 60000 }, () => {
  const tag = "cdx-ov-" + crypto.randomBytes(4).toString("hex");
  const c = sleeper(tag);
  fixture({ overlay: { users: [{ cmd: tag.toUpperCase(), user: SBX }], default_user: "TESTHOST\\me" } });
  const s = PR.listProcs({ scope: "session" });
  assert.equal(s.ok, true);
  assert.equal(typeof s.listerPid, "number");
  assert.ok(s.rows.every((r) => r.session === s.session), "session scope keeps only the lister's session");
  const row = s.rows.find((r) => r.pid === c.pid);
  assert.equal(row.user, SBX);
  assert.equal(row.ppid, process.pid);
  assert.match(row.start, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/);
  assert.equal(row.start, PR.startTime(c.pid)); // same clock and format as startTime
  assert.equal(s.rows.find((r) => r.pid === process.pid).user, "TESTHOST\\me");
  const f = PR.listProcs({ scope: "full" });
  assert.ok(f.rows.some((r) => r.session !== f.session), "full scope keeps other sessions");
  // a pid + name key matches too
  fixture({ overlay: { users: [{ pid: c.pid, name: "NODE.EXE", user: SBX }], default_user: null } });
  assert.equal(PR.listProcs({ scope: "session" }).rows.find((r) => r.pid === c.pid).user, SBX);
  assert.equal(PR.listProcs({ scope: "session" }).rows.find((r) => r.pid === process.pid).user, null);
});

// ---------------------------------------------------------------------------- the real lister

test("listProcs (real): session scope sees this process and its child with owners", { timeout: 90000 }, () => {
  noFixture();
  const c = sleeper("cdx-real-lister");
  const L = PR.listProcs({ scope: "session" });
  assert.equal(L.ok, true, JSON.stringify(L).slice(0, 300));
  assert.equal(L.scope, "session");
  assert.equal(typeof L.session, "number");
  assert.equal(typeof L.listerPid, "number");
  const self = L.rows.find((r) => r.pid === process.pid);
  assert.match(self.user, /\\/);
  const child = L.rows.find((r) => r.pid === c.pid);
  assert.equal(child.ppid, process.pid);
  assert.match(child.user, /\\/);
  assert.ok(L.rows.some((r) => r.pid === L.listerPid), "the lister's own row is in the list (and excluded by procFindings)");
});

// ---------------------------------------------------------------------------- killTree, startTime

test("startTime: CIM format for a live pid, null for a dead one, positive integers only", () => {
  noFixture();
  assert.match(PR.startTime(process.pid), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/);
  assert.equal(PR.startTime(999999), null);
  for (const bad of [0, -4, 1.5, "12; calc", "12", null, undefined, NaN]) assert.throws(() => PR.startTime(bad), TypeError);
});

test("killTree: ends a process and its attached children; a missing pid is ok", async () => {
  noFixture();
  const parent = spawn(process.execPath, ["-e",
    `const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setTimeout(()=>{},120000)"],{stdio:"ignore",windowsHide:true});` +
    `console.log(c.pid);setTimeout(()=>{},120000)`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  track(parent.pid);
  const gc = await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  track(gc);
  assert.ok(alive(parent.pid) && alive(gc));
  const r = PR.killTree(parent.pid);
  assert.equal(r.ok, true, r.out);
  assert.equal(typeof r.out, "string");
  assert.equal(await waitGone(parent.pid, 5000), true);
  assert.equal(await waitGone(gc, 5000), true);
  const again = PR.killTree(parent.pid); // already gone: taskkill exit 128 is success
  assert.equal(again.ok, true, again.out);
  assert.equal(PR.killTree(999999).ok, true);
});

// ---------------------------------------------------------------------------- listerVerified

test("listerVerified: the probe file must say ok for this Codex version", () => {
  const bin = { cmd: process.execPath, args: [FAKE_CODEX] };
  fs.rmSync(PR.LISTER_PROBE, { force: true });
  assert.deepEqual(PR.listerVerified(bin), { ok: false, why: "lister-unverified" });
  const put = (o) => { fs.mkdirSync(path.dirname(PR.LISTER_PROBE), { recursive: true }); fs.writeFileSync(PR.LISTER_PROBE, typeof o === "string" ? o : JSON.stringify(o)); };
  put({ version: "0.160.0", ok: true, at: "x" });
  assert.deepEqual(PR.listerVerified(bin), { ok: true });
  put({ version: "0.159.9", ok: true, at: "x" });
  assert.equal(PR.listerVerified(bin).ok, false);
  put({ version: "0.160.0", ok: false, at: "x" });
  assert.equal(PR.listerVerified(bin).ok, false);
  put("{ not json");
  assert.equal(PR.listerVerified(bin).ok, false);
  put({ version: "0.160.0", ok: true, at: "x" });
  assert.equal(PR.listerVerified({ cmd: path.join(env.root, "no-such.exe"), args: [] }).why, "lister-unverified"); // broken binary
  assert.equal(PR.LISTER_PROBE, path.join(P.STATE, "lister-probe.json"));
  fs.rmSync(PR.LISTER_PROBE, { force: true });
});

// ---------------------------------------------------------------------------- listerProbe

const BIN = { cmd: process.execPath, args: [FAKE_CODEX] };
function probeDir() {
  const d = path.join(env.root, "probe-" + crypto.randomBytes(3).toString("hex"));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Runs listerProbe, recording the probe child and (via a listing taken 1.5 s in) its descendants. */
async function probe(opts = {}) {
  const cwd = probeDir();
  const seen = { child: null, desc: [] };
  const r = await PR.listerProbe({
    bin: BIN, cwd, runId: "probe-run-1", ...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
    onSpawn: (c) => {
      seen.child = c;
      track(c.pid);
      opts.onSpawn?.(c);
      if (opts.snapshot) {
        setTimeout(() => {
          const prev = process.env.CODEX_RUN_PROCS;
          fixture({ overlay: { users: [], default_user: "TESTHOST\\me" } });
          const L = PR.listProcs({ scope: "full" });
          if (prev) { process.env.CODEX_RUN_PROCS = prev; } else delete process.env.CODEX_RUN_PROCS;
          const kids = new Set([c.pid]);
          for (let changed = true; changed;) {
            changed = false;
            for (const row of L.rows) if (!kids.has(row.pid) && kids.has(row.ppid)) { kids.add(row.pid); changed = true; }
          }
          seen.desc = [...kids].filter((p) => p !== c.pid);
          seen.desc.forEach(track);
        }, 1500);
      }
    },
  });
  seen.cwd = cwd;
  return { r, seen };
}

test("listerProbe: writes lprobe.cmd, passes on a sandbox-user row under the probe, and kills everything it started", { timeout: 120000 }, async () => {
  fixture({ overlay: { users: [{ cmd: "lprobe.cmd", user: SBX }], default_user: "TESTHOST\\me" } });
  const { r, seen } = await probe({ snapshot: true, pollMs: 2000 }); // the descendant snapshot is taken at 1.5 s: the first listing must come after it
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.readFileSync(path.join(seen.cwd, ".codex-tmp", "probe-run-1", "lprobe.cmd"), "utf8"),
    "@echo off\r\nC:\\Windows\\System32\\PING.EXE -n 60 127.0.0.1 >nul\r\nexit /b %ERRORLEVEL%\r\n");
  assert.ok(seen.desc.length >= 1, "the probe has descendants (cmd.exe, PING) to clean up");
  assert.equal(await waitGone(seen.child.pid, 5000), true);
  for (const p of seen.desc) assert.equal(await waitGone(p, 5000), true, `descendant ${p} must be gone`);
});

test("listerProbe: no sandbox-user row under the probe is lister-blind", { timeout: 120000 }, async () => {
  fixture({ overlay: { users: [], default_user: "TESTHOST\\me" } });
  const { r, seen } = await probe();
  assert.deepEqual(r, { ok: false, reason: "lister-blind: no sandbox-user row under the probe" });
  assert.equal(await waitGone(seen.child.pid, 5000), true);
});

test("I2: listerProbe never writes through a symlink planted at lprobe.cmd; no probe is spawned", { timeout: 120000 }, async () => {
  fixture({ overlay: { users: [], default_user: "TESTHOST\\me" } });
  const cwd = probeDir();
  const victim = path.join(env.root, `victim-${crypto.randomBytes(3).toString("hex")}.txt`);
  fs.writeFileSync(victim, "keep\n");
  const link = path.join(cwd, ".codex-tmp", "probe-run-1", "lprobe.cmd");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(victim, link, "file");
  } catch (e) {
    if (e.code === "EPERM") { console.log("# skipped: no symlink privilege"); return; }
    throw e;
  }
  let spawned = false;
  const r = await PR.listerProbe({ bin: BIN, cwd, runId: "probe-run-1", onSpawn: () => { spawned = true; } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^lister-blind: probe spawn failed/);
  assert.equal(spawned, false);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
});

test("listerProbe (static listings): descendant rule with start order, outside-session rule, blind listing", { timeout: 180000 }, async () => {
  const sbxRow = (pid, ppid, o = {}) => mk(pid, { ppid, name: "codex-command-runner-0.160.0.exe", user: SBX, ...o });
  const run = async (rowsFor, full) => {
    const { r } = await probe({
      onSpawn: (c) => fixture({ full: full ?? { ok: true, rows: rowsFor(c.pid) } }),
    });
    return r;
  };
  const parentRow = (pid) => mk(pid, { name: "node.exe", start: "2026-10-06T10:00:00.0000000Z" });
  assert.deepEqual(await run((p) => [parentRow(p), sbxRow(910001, p, { start: "2026-10-06T10:00:01.0000000Z" })]), { ok: true });
  // two steps down the ppid chain
  assert.deepEqual(await run((p) => [parentRow(p), mk(910002, { ppid: p, start: "2026-10-06T10:00:01.0000000Z" }),
    sbxRow(910003, 910002, { start: "2026-10-06T10:00:02.0000000Z" })]), { ok: true });
  // a child that started before its parent is a reused ppid
  assert.deepEqual(await run((p) => [parentRow(p), sbxRow(910001, p, { start: "2026-10-06T09:00:00.0000000Z" })]),
    { ok: false, reason: "lister-blind: no sandbox-user row under the probe" });
  // sandbox row that is not under the probe
  assert.deepEqual(await run((p) => [parentRow(p), sbxRow(910001, 4)]),
    { ok: false, reason: "lister-blind: no sandbox-user row under the probe" });
  // a sandbox-user row outside the lister's session fails even when another one passes
  assert.deepEqual(await run((p) => [parentRow(p), sbxRow(910001, p, { start: "2026-10-06T10:00:01.0000000Z" }),
    sbxRow(910004, 4, { session: 0 })]), { ok: false, reason: "lister-blind: sandbox rows outside session 1" });
  // the name rule does not count for 4b or the pass condition: only the owner column
  assert.deepEqual(await run((p) => [parentRow(p), mk(910001, { ppid: p, user: null, name: "codex-command-runner-0.160.0.exe", start: "2026-10-06T10:00:01.0000000Z" })]),
    { ok: false, reason: "lister-blind: no sandbox-user row under the probe" });
  assert.deepEqual(await run(null, { ok: false, error: "x" }), { ok: false, reason: "lister-blind: x" });
});

// B-C: the probe polls the listing (first after pollMs, then every pollMs, until timeoutMs) instead of one fixed sleep.
test("listerProbe polls: first listing empty, third has the sandbox row -> ok; never seen -> lister-blind only after the timeout", { timeout: 120000 }, async () => {
  const sbxRow = (pid, ppid) => mk(pid, { ppid, name: "codex-command-runner-0.160.0.exe", user: SBX, start: "2026-10-06T10:00:01.0000000Z" });
  const parentRow = (pid) => mk(pid, { name: "node.exe", start: "2026-10-06T10:00:00.0000000Z" });
  const poll = async (rowsFor, o = {}) => {
    const cwd = probeDir();
    const times = [];
    let child;
    const list = () => { times.push(Date.now()); return rowsFor(times.length, child.pid); };
    const r = await PR.listerProbe({ bin: BIN, cwd, runId: "probe-run-1", onSpawn: (c) => { child = c; track(c.pid); }, list, pollMs: 100, timeoutMs: 1000, ...o });
    await waitGone(child.pid, 5000);
    await new Promise((resolve) => setTimeout(resolve, 500)); // the killed tree releases its handles on the temp folder
    return { r, times };
  };
  const ok = (rows) => ({ ok: true, session: 1, rows });
  const third = await poll((n, p) => ok(n < 3 ? [parentRow(p)] : [parentRow(p), sbxRow(910001, p)]));
  assert.deepEqual(third.r, { ok: true });
  assert.equal(third.times.length, 3, "stops polling once the row is seen");
  assert.ok(third.times[2] - third.times[0] >= 150, "the listings are spaced by pollMs");
  // a row on the very first listing is still ok after one wait
  assert.equal((await poll((n, p) => ok([parentRow(p), sbxRow(910001, p)]))).times.length, 1);
  // never seen: retried until the timeout, then the same lister-blind reason
  const never = await poll((n, p) => ok([parentRow(p)]));
  assert.deepEqual(never.r, { ok: false, reason: "lister-blind: no sandbox-user row under the probe" });
  assert.ok(never.times.length >= 3 && never.times.length <= 11, `polled ${never.times.length} times`);
  // a failed listing and a sandbox row outside the session still fail at once
  const err = await poll(() => ({ ok: false, error: "x" }));
  assert.deepEqual(err.r, { ok: false, reason: "lister-blind: x" });
  assert.equal(err.times.length, 1);
  const out = await poll((n, p) => ok([parentRow(p), mk(910004, { ppid: 4, name: "x.exe", user: SBX, session: 0 })]));
  assert.deepEqual(out.r, { ok: false, reason: "lister-blind: sandbox rows outside session 1" });
  assert.equal(out.times.length, 1);
});

// ---------------------------------------------------------------------------- the fake's detached grandchild

test("fake codex: a detached grandchild survives the fake's death, an attached one does not; the tag and ms are applied", { timeout: 60000 }, async () => {
  noFixture();
  const e = tmpEnv();
  try {
    const run = async (mode) => {
      const pidFile = path.join(e.root, `pids-${mode}.json`);
      const tag = "cdx-gc-" + crypto.randomBytes(4).toString("hex");
      scenario({ sleepMs: 60000, grandchild: mode, grandchildTag: tag, grandchildMs: 90000, pidFile }, e);
      const f = spawn(process.execPath, [FAKE_CODEX, "exec", "-C", e.root], { env: e, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      track(f.pid);
      f.stdin.end();
      assert.equal(await waitFor(() => fs.existsSync(pidFile), 15000), true);
      const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
      track(pids.grandchild);
      assert.equal(pids.pid, f.pid);
      assert.ok(alive(pids.grandchild));
      const row = (() => {
        fixture({ overlay: { users: [], default_user: null } });
        return PR.listProcs({ scope: "full" }).rows.find((r) => r.pid === pids.grandchild);
      })();
      assert.match(row.cmd, new RegExp(`setTimeout\\(\\(\\)=>\\{\\},90000\\).*${tag}`)); // ms and tag on the command line
      process.kill(f.pid);
      assert.equal(await waitGone(f.pid, 10000), true);
      return pids.grandchild;
    };
    const attached = await run("attached");
    assert.equal(await waitGone(attached, 10000), true, "attached grandchild dies with the fake (libuv job)");
    const attachedTrue = await run(true);
    assert.equal(await waitGone(attachedTrue, 10000), true);
    const detached = await run("detached");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(alive(detached), true, "detached grandchild outlives the fake");
    assert.equal(PR.killTree(detached).ok, true);
    assert.equal(await waitGone(detached, 10000), true);
  } finally { e.cleanup(); }
});
