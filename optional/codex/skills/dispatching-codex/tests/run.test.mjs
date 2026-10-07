// Task 9: the orchestrator, end to end through the CLI, with the fake codex only. The held-resources x failure-step
// matrix of the addendum (section 7) is walked row by row; each test names its row.
// Hermetic: temp CFG / CODEX_HOME / TEMP / USERPROFILE, CODEX_RUN_PROCS fixtures (never the 30 s lister unless an
// overlay fixture asks for the real CIM listing), the fake codex as CODEX_RUN_BIN. Every process a test starts is
// killed by pid, and a final sweep asserts that nothing mentioning a test folder is left running.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpEnv, makeRepo, addWorktree, scenario, rmrf, mkJunction, rmJunction, SKILL_DIR, TESTS_DIR } from "./helpers.mjs";

// paths.mjs / locks.mjs read the environment at import: set it before the dynamic imports.
const env = tmpEnv();
const HOME = path.join(env.root, "home");
fs.mkdirSync(HOME, { recursive: true });
env.USERPROFILE = HOME; // os.homedir(): the read check and the ACL scan never look at the real profile
env.APPDATA = path.join(HOME, "AppData", "Roaming"); // the AppData credential folders (GitHub CLI, Claude) likewise
// Every codex-run the tests start gets icacls.exe replaced by tests/fake-icacls.mjs (a preload on spawn): the per-run deny
// check lists the test profile's folders, which carry no real per-user denies. FAKE_ICACLS_MODE=group-only (extraEnv) makes
// the fake report only the old group deny, which no longer counts.
const ICACLS_PRELOAD = path.join(env.root, "fake-icacls-preload.mjs");
fs.writeFileSync(ICACLS_PRELOAD, 'import cp from "node:child_process";\nimport { syncBuiltinESMExports } from "node:module";\n' +
  "const orig = cp.spawn;\n" +
  `cp.spawn = (f, a, o) => (/icacls\\.exe$/i.test(String(f)) ? orig(process.execPath, [${JSON.stringify(path.join(TESTS_DIR, "fake-icacls.mjs"))}, ...a], o) : orig(f, a, o));\n` +
  "syncBuiltinESMExports();\n");
env.NODE_OPTIONS = `--import ${pathToFileURL(ICACLS_PRELOAD).href}`;
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME, CODEX_RUN_PIPE_PREFIX: env.CODEX_RUN_PIPE_PREFIX,
  CODEX_RUN_BIN: env.CODEX_RUN_BIN, CODEX_RUN_BIN_ARGS: env.CODEX_RUN_BIN_ARGS, CODEX_RUN_TEMP: env.CODEX_RUN_TEMP,
});
delete process.env.CODEX_RUN_PROCS;
const P = await import("../lib/paths.mjs");
const L = await import("../lib/locks.mjs");
const PR = await import("../lib/procs.mjs");
const SC = await import("../lib/scope.mjs");
assert.equal(P.STATE.startsWith(env.root), true, "state folder must be inside the temp root");

const CODEX_RUN = path.join(SKILL_DIR, "codex-run.mjs");
const SBX = "TESTHOST\\CodexSandboxOffline";
const REPO_ROOT = path.resolve(SKILL_DIR, "..", "..", "..", "..");

// ------------------------------------------------------------------------------------------ bookkeeping

const dirs = [];
const killPids = new Set();
const gcTags = [];
const track = (pid) => { if (Number.isInteger(pid)) killPids.add(pid); return pid; };
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
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeText = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();

after(async () => {
  for (const pid of killPids) PR.killTree(pid);
  // sweep: nothing that mentions a test folder or a grandchild tag may still run
  const needles = [env.root, ...dirs, ...gcTags].map((s) => s.toLowerCase());
  const script = `$ErrorActionPreference='Stop'; $n = ConvertFrom-Json '${JSON.stringify(needles).replace(/'/g, "''")}'; ` +
    "Get-CimInstance Win32_Process | Where-Object { $c = $_.CommandLine; $c -and ($n | Where-Object { $c.ToLower().Contains($_) }) -and $_.ProcessId -ne $PID } | " +
    "ForEach-Object { $_.ProcessId }";
  const sweep = () => {
    const r = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: 60000 });
    return String(r.stdout ?? "").split(/\s+/).filter(Boolean).map(Number);
  };
  let stray = sweep();
  const everSeen = new Set(stray);
  for (let i = 0; i < 4 && stray.length; i++) { // a process that is just exiting is not a leak: kill, wait, look again
    for (const pid of stray) PR.killTree(pid);
    await new Promise((r) => setTimeout(r, 1000));
    stray = sweep();
  }
  for (const d of dirs) rmrf(d);
  env.cleanup();
  assert.deepEqual(stray, [], `stray test processes were left running: ${stray.join(",")} (first seen: ${[...everSeen].join(",")})`);
});

// ------------------------------------------------------------------------------------------ state, fixtures, runner

const STATE = P.STATE;
const ledgerFile = P.LEDGER;
const ledger = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const wtRecordPath = (cwd) => path.join(P.WT_LOCKS, sha1(P.canonPath(cwd)) + ".json");
const slotRecordPath = (n) => path.join(P.SLOT_LOCKS, `${n}.json`);
const rec = (f) => (fs.existsSync(f) ? readJson(f) : null);
const runDirOf = (runId) => path.join(STATE, "runs", runId);

function resetState() {
  rmrf(STATE);
  rmrf(P.USAGE_DIR);
  rmrf(path.join(P.CODEX_HOME, "sessions"));
  fs.mkdirSync(STATE, { recursive: true });
  writeText(P.TESTED_VERSION, "0.160.0\n");
  writeText(P.ACL_STATE, JSON.stringify({ last_complete: new Date().toISOString() }));
  writeText(PR.LISTER_PROBE, JSON.stringify({ version: "0.160.0", ok: true, at: new Date().toISOString() }));
  rmrf(path.join(env.CLAUDE_CONFIG_DIR, "AGENTS.md"));
  delete env.CODEX_RUN_ID;
  delete env.CODEX_RUN_TIMEOUT_MS;
  delete env.CODEX_RUN_CHECK_TIMEOUT_MS;
  scenario({}, env);
  fixture();
}
beforeEach(resetState);

let seq = 0;
function worktree(name = `t${++seq}`) {
  const repo = makeRepo();
  dirs.push(path.dirname(repo));
  return { repo, wt: addWorktree(repo, name) };
}

const goodLast = { status: "done", note: "did it", checks_run: [] };
// A scenario for a normal write run (writes src/a.txt, valid last.json), with the recording knobs.
function scn(extra = {}) {
  const id = ++seq;
  const f = {
    pidFile: path.join(env.root, `fake-${id}.pid`), argvFile: path.join(env.root, `fake-${id}.argv.json`),
    stdinFile: path.join(env.root, `fake-${id}.stdin.txt`),
    writes: [{ path: "src/a.txt", content: "hello\n" }], lastJson: goodLast, ...extra,
  };
  scenario(f, env);
  return f;
}
// Default fixture: both listings empty. `extra` merges over it (an `overlay` makes it a real CIM listing).
function fixture(extra = {}) {
  const log = path.join(env.root, `procs-${++seq}.log`);
  const fx = { log, session: { ok: true, rows: [] }, full: { ok: true, rows: [] }, ...extra };
  const file = path.join(env.root, `fx-${seq}.json`);
  writeText(file, JSON.stringify(fx));
  env.CODEX_RUN_PROCS = file;
  return { file, log, lines: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}
const briefText = (owned = "src/**") =>
  `# Task T1: demo\nGoal: do the thing.\nFiles you own: ${owned}.\nDo not create or edit anything else.\nDone when: echo ok\nWorker rules: {{WORKER_RULES}}\n`;
function briefFile(text = briefText()) {
  const f = path.join(env.root, `brief-${++seq}.md`);
  writeText(f, text);
  return f;
}

// Windows env names are case-insensitive: an override replaces any spelling already in the base env (SYSTEMROOT).
function mergeEnv(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    for (const have of Object.keys(out)) if (have.toLowerCase() === k.toLowerCase()) delete out[have];
    out[k] = v;
  }
  return out;
}
function runCli(args, { extraEnv = {}, timeout = 240000 } = {}) {
  const r = spawnSync(process.execPath, [CODEX_RUN, ...args], {
    env: mergeEnv(env, extraEnv), encoding: "utf8", windowsHide: true, timeout,
  });
  const lines = String(r.stdout ?? "").split("\n").filter(Boolean);
  let json = null;
  try { json = JSON.parse(lines[lines.length - 1]); } catch { /* not a JSON line */ }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", lines, json, signal: r.signal };
}
// pids the fake wrote (and its grandchild) are killed at the end of the test
function reapFake(t, f) {
  t.after(() => {
    try {
      const j = readJson(f.pidFile);
      PR.killTree(j.pid);
      if (j.grandchild) PR.killTree(j.grandchild);
    } catch { /* never started */ }
  });
}
const baseArgs = (wt, extra = []) => ["--brief", briefFile(), "--cwd", wt, "--mode", "write", "--task", "T1", ...extra];
function ok1(r) { // exactly one JSON line on stdout, at most 2000 characters, exit 0
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.equal(r.lines.length, 1, `stdout is not one line: ${r.stdout}`);
  assert.ok(r.lines[0].length <= 2000);
  assert.ok(r.json, "stdout line is not JSON");
  return r.json;
}
function blockedWith(r, re) {
  const j = ok1(r);
  assert.equal(j.status, "blocked", JSON.stringify(j));
  assert.match(j.reason, re, JSON.stringify(j));
  return j;
}
const setReadOnly = (f, on) => fs.chmodSync(f, on ? 0o444 : 0o666);
function cleanRecord(f, runId = "20260101T000000Z-aaaaaa") {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  L.writeClean(f, runId);
}
function staleActive(kind, f, cwd, o = {}) {
  const base = cwd ? git(cwd, "rev-parse", "HEAD") : "a".repeat(40);
  const pre = cwd ? SC.diffHash(cwd, base) : "b".repeat(64);
  L.writeActive(f, {
    cwd: cwd ? P.canonPath(cwd) : null, run_id: "20260101T000000Z-bbbbbb", run_dir: path.join(STATE, "runs", "20260101T000000Z-bbbbbb"),
    owner_pid: 999991, owner_start_time: "2026-01-01T00:00:00.0000000Z", child_pids: [], host_started: false,
    baseline: base, tree_hash_pre: pre, tree_hash_final: null, ...o,
  });
}
const OTHER_ACTIVE = (kind) => JSON.stringify({
  v: 1, kind, key: "k", cwd: "x", run_id: "20260101T000000Z-cccccc", run_dir: "d", state: "active", owner_pid: 1000,
  owner_start_time: "2026-01-01T00:00:00.0000000Z", child_pids: [], host_started: false, baseline: "a".repeat(40),
  tree_hash_pre: "b".repeat(64), tree_hash_final: null,
});
const marker = (name) => path.join(env.root, `${name}-${++seq}.marker`);
const exists = (f) => fs.existsSync(f);

// ------------------------------------------------------------------------------------------ the happy path

test("a normal write run: done, one JSON line, ledger, usage, both records clean, TMP gone, brief and argv as designed", (t) => {
  const { wt } = worktree();
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeText(path.join(env.CLAUDE_CONFIG_DIR, "AGENTS.md"), "# Rules\n\n## Worker rules\n\nWRQUOTE-1 stay in the owned files.\n\n## Controller rules\n\nnot for workers\n");
  const f = scn();
  reapFake(t, f);
  fixture();
  const marker1 = marker("chk");
  const r = runCli(baseArgs(wt, ["--check", `echo ran> "${marker1}"`]));
  const j = ok1(r);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(j.reason, null);
  assert.equal(j.mode, "write");
  assert.equal(j.model, "gpt-6.1-sol");
  assert.equal(j.model_downgraded, false);
  assert.deepEqual(j.files, ["src/a.txt (+1 -0)"]);
  assert.equal(j.checks.length, 1);
  assert.equal(j.checks[0].exit, 0);
  assert.equal(j.host_checks, false);
  assert.equal(j.codex_note, "did it");
  assert.deepEqual(j.orphans, []);
  assert.ok(exists(marker1), "the check really ran");
  // records, TMP
  assert.equal(rec(wtRecordPath(wt)).state, "clean");
  assert.equal(rec(slotRecordPath(1)).state, "clean");
  assert.equal(rec(wtRecordPath(wt)).run_id, j.run);
  assert.equal(exists(path.join(wt, ".codex-tmp")), false);
  assert.equal(exists(path.join(wt, "src", "a.txt")), true, "Codex's edit stays (the controller reviews and commits)");
  // ledger
  const l = ledger();
  assert.equal(l.length, 1);
  assert.equal(l[0].run_id, j.run);
  assert.equal(l[0].status, "done");
  assert.equal(l[0].mode, "write");
  assert.equal(l[0].model, "sol");
  assert.equal(l[0].writer, "codex-sol");
  assert.equal(l[0].task, "T1");
  assert.equal(l[0].checks_passed, true);
  assert.equal(l[0].host_checks, false);
  assert.deepEqual(l[0].codex_tokens, { in: 1000, cached: 800, out: 50 });
  assert.deepEqual(l[0].files, ["src/a.txt (+1 -0)"]);
  // usage (pacer file and last-usage)
  const usage = fs.readdirSync(P.USAGE_DIR).filter((n) => /^codex-/.test(n));
  assert.deepEqual(usage, [`codex-${j.run}.json`]);
  assert.equal(readJson(path.join(P.USAGE_DIR, usage[0])).provider, "codex");
  assert.ok(exists(P.LAST_USAGE));
  assert.equal(j.week_pct, 1);
  // run dir: brief.md with the AGENTS.md section, meta.json with the final hash
  const dir = runDirOf(j.run);
  const brief = fs.readFileSync(path.join(dir, "brief.md"), "utf8");
  assert.match(brief, /WRQUOTE-1 stay in the owned files\./);
  assert.doesNotMatch(brief, /not for workers/);
  assert.equal(fs.readFileSync(f.stdinFile, "utf8"), brief, "the brief goes to Codex on stdin");
  assert.equal((j.notes ?? []).includes("worker-rules: fallback"), false);
  const meta = readJson(path.join(dir, "meta.json"));
  assert.equal(meta.run_id, j.run);
  assert.equal(meta.mode, "write");
  assert.deepEqual(meta.owned, ["src/**"]);
  assert.equal(meta.baseline, git(wt, "rev-parse", "HEAD"));
  assert.equal(meta.diff_hash, SC.diffHash(wt, meta.baseline), "meta.json holds the final diff hash");
  assert.equal(rec(wtRecordPath(wt)).tree_hash_final, meta.diff_hash);
  // the exact codex exec line
  const argv = readJson(f.argvFile);
  assert.deepEqual(argv.slice(0, 5), ["-a", "never", "exec", "-m", "gpt-6.1-sol"]);
  assert.equal(argv[argv.indexOf("-C") + 1], path.resolve(wt));
  assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
  assert.equal(argv[argv.indexOf("-o") + 1], path.join(dir, "last.json"));
  assert.equal(argv[argv.indexOf("--output-schema") + 1], path.join(SKILL_DIR, "schemas", "write.json"));
  assert.equal(argv.at(-1), "-");
});

test("without an AGENTS.md the brief carries the fallback rules and the result notes worker-rules: fallback", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const j = ok1(runCli(baseArgs(wt)));
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.ok(j.notes.includes("worker-rules: fallback"), JSON.stringify(j.notes));
  assert.match(fs.readFileSync(path.join(runDirOf(j.run), "brief.md"), "utf8"), /Stay inside the files you own/);
});

// ------------------------------------------------------------------------------------------ row 1: args, brief, secret (P0)

function untouched(wt, runIdHint) {
  assert.equal(ledger().length, 0, "no ledger line");
  assert.equal(exists(wtRecordPath(wt)), false, "WTR untouched");
  assert.equal(exists(slotRecordPath(1)), false, "SR untouched");
  if (runIdHint) assert.equal(exists(runDirOf(runIdHint)), false);
}

test("row 1: bad arguments -> blocked args-invalid, P0 (no state touched)", () => {
  const { wt } = worktree();
  const b = briefFile();
  for (const args of [
    ["--brief", b, "--cwd", wt, "--mode", "write", "--bogus"],
    ["--brief", b, "--cwd", wt, "--mode", "nope"],
    ["--brief", b, "--cwd", wt],
    ["--cwd", wt, "--mode", "write"],
    ["--brief", b, "--mode", "write"],
    ["--brief", b, "--cwd", wt, "--mode", "write", "--model", "gpt"],
    ["--brief", b, "--cwd", wt, "--mode", "write", "--effort", "extreme"],
    ["--brief", b, "--cwd", wt, "--mode", "write", "--timeout-min", "0"],
    ["--brief", b, "--cwd", wt, "--mode", "write", "--continue", "../x"],
    ["--brief", b, "--cwd", wt, "--mode", "write", "--base", "main"],
    ["--brief", b, "--cwd", wt, "--mode", "review", "--check", "echo x"],
    ["--brief", b, "--cwd", wt, "--mode", "review"],
    ["--brief", b, "--cwd", wt, "--mode", "review", "--base", "main", "--review-of", "r1"],
  ]) {
    blockedWith(runCli(args), /^args-invalid: /);
  }
  untouched(wt);
});

test("row 1: brief too long / no owned files / unreadable -> blocked brief-invalid, no Codex, no state", () => {
  const { wt } = worktree();
  const f = scn();
  fixture();
  const long = briefText() + Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n") + "\n";
  blockedWith(runCli(["--brief", briefFile(long), "--cwd", wt, "--mode", "write"]), /^brief-invalid: too long/);
  blockedWith(runCli(["--brief", briefFile("# Task\nGoal: x\n"), "--cwd", wt, "--mode", "write"]), /^brief-invalid: no owned files/);
  blockedWith(runCli(["--brief", path.join(env.root, "missing.md"), "--cwd", wt, "--mode", "write"]), /^brief-invalid: /);
  assert.equal(exists(f.argvFile), false);
  untouched(wt);
});

test("row 1: a secret in the brief -> blocked secret-in-brief naming the pattern, never the secret; no Codex spawn", () => {
  const { wt } = worktree();
  const f = scn();
  fixture();
  const secret = "sk-" + "ant-" + "x".repeat(12);
  const r = runCli(["--brief", briefFile(briefText() + `Constraints: use ${secret}\n`), "--cwd", wt, "--mode", "write"]);
  const j = blockedWith(r, /^secret-in-brief: sk/);
  assert.equal(r.stdout.includes(secret), false);
  assert.equal(r.stderr.includes(secret), false);
  assert.equal(exists(f.argvFile), false, "Codex never spawned");
  untouched(wt);
  assert.ok(j.run);
});

// ------------------------------------------------------------------------------------------ row 2: linked worktree, lane (P0)

test("row 2: the main checkout -> blocked not-a-linked-worktree; a plain folder too", () => {
  const { repo } = worktree();
  fixture();
  blockedWith(runCli(baseArgs(repo)), /^not-a-linked-worktree/);
  const plain = path.join(env.root, "plain-dir");
  fs.mkdirSync(plain, { recursive: true });
  blockedWith(runCli(baseArgs(plain)), /^not-a-linked-worktree/);
  assert.equal(ledger().length, 0);
});

function hlRegistry(entries, { running = [], closed = [] } = {}) {
  const reg = path.join(env.root, "registry");
  fs.mkdirSync(reg, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  for (const id of closed) lines.push(JSON.stringify({ closed: id }));
  fs.writeFileSync(path.join(reg, "sessions.jsonl"), lines.join("\n") + "\n");
  const agents = path.join(env.root, "agents.json");
  fs.writeFileSync(agents, JSON.stringify(running.map((id) => ({ id: `bg-${id}`, status: "running" }))));
  return { HL_SKILL_DIR: path.join(REPO_ROOT, "claude", "skills", "handoff-launch"), HL_REGISTRY_DIR: reg, HL_AGENTS_JSON: agents };
}
const laneEntry = (o) => ({ repo: "r", branch: o.name, launched_at: new Date().toISOString(), generation: 1, mode: "bg", bg_id: `bg-${o.id}`, ...o });

test("row 2: another live lane's worktree -> blocked lane-busy (HL_SESSION_ID unset and set; unknown liveness blocks)", () => {
  const { wt } = worktree();
  fixture();
  const hl = hlRegistry([laneEntry({ id: "L1", name: "lane-a", worktree: wt })], { running: ["L1"] });
  blockedWith(runCli(baseArgs(wt), { extraEnv: hl }), /^lane-busy: /);
  blockedWith(runCli(baseArgs(wt), { extraEnv: { ...hl, HL_SESSION_ID: "ME" } }), /^lane-unknown: /);
  // unknown liveness (a fresh window launch with no pid file): blocks
  const hl2 = hlRegistry([laneEntry({ id: "L2", name: "lane-b", worktree: wt, mode: "window", bg_id: undefined })]);
  blockedWith(runCli(baseArgs(wt), { extraEnv: hl2 }), /^lane-busy: .*unknown/);
  untouched(wt);
});

test("row 2: a worktree whose lane is gone passes the lane check", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const hl = hlRegistry([laneEntry({ id: "L1", name: "lane-a", worktree: wt })], { closed: ["L1"] });
  const j = ok1(runCli(baseArgs(wt), { extraEnv: hl }));
  assert.equal(j.status, "done", JSON.stringify(j));
});

// ------------------------------------------------------------------------------------------ row 3: acquire (P0)

test("row 3: a missing --cwd -> blocked cwd-missing, no pipe taken, nothing written", () => {
  fixture();
  const j = blockedWith(runCli(baseArgs(path.join(env.root, "no such worktree"))), /^cwd-missing$/);
  assert.ok(j.run);
  assert.equal(ledger().length, 0);
  assert.equal(exists(P.WT_LOCKS) && fs.readdirSync(P.WT_LOCKS).length > 0, false);
  assert.equal(exists(P.SLOT_LOCKS) && fs.readdirSync(P.SLOT_LOCKS).length > 0, false);
});

test("row 3: worktree busy -> blocked worktree-busy (a held pipe), then free again after release", async (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const srv = await L.acquirePipe(`wt-${sha1(P.canonPath(wt))}`);
  assert.ok(srv);
  try {
    blockedWith(runCli(baseArgs(wt)), /^worktree-busy$/);
    untouched(wt);
  } finally {
    await L.releasePipe(srv);
  }
  assert.equal(ok1(runCli(baseArgs(wt))).status, "done");
});

test("row 3: a second run on the same worktree while one sleeps -> worktree-busy (spelled differently); the first finishes", async (t) => {
  const { wt } = worktree();
  const f = scn({ sleepMs: 12000 });
  reapFake(t, f);
  fixture();
  const first = spawn(process.execPath, [CODEX_RUN, ...baseArgs(wt)], { env: { ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  track(first.pid);
  let out = "";
  first.stdout.on("data", (d) => { out += d; });
  first.stderr.on("data", () => {});
  assert.equal(await waitFor(() => exists(f.pidFile), 60000), true, "the first run reached Codex");
  const spelled = wt.toUpperCase().replace(/\\/g, "/") + "/";
  blockedWith(runCli(baseArgs(spelled)), /^worktree-busy$/);
  await new Promise((resolve) => first.on("close", resolve));
  const j = JSON.parse(out.trim().split("\n").pop());
  assert.equal(j.status, "done", out);
});

test("row 3: quarantined (a stale active record that used a host check) -> blocked worktree-quarantined; the record is untouched", () => {
  const { wt } = worktree();
  fixture();
  staleActive("worktree", wtRecordPath(wt), wt, { host_started: true });
  const before = fs.readFileSync(wtRecordPath(wt), "utf8");
  const j = blockedWith(runCli(baseArgs(wt)), /^worktree-quarantined: .*host-check-started/);
  assert.equal(ledger().length, 0);
  assert.equal(fs.readFileSync(wtRecordPath(wt), "utf8"), before);
  assert.equal(exists(slotRecordPath(1)), false);
  assert.ok(j.run);
});

test("row 3: a stale active record with no survivors and a matching tree is auto-cleared, and the run goes on", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  const fx = fixture();
  staleActive("worktree", wtRecordPath(wt), wt);
  const r = runCli(baseArgs(wt));
  assert.equal(ok1(r).status, "done");
  assert.match(r.stderr, /auto-cleared quarantine of run 20260101T000000Z-bbbbbb/);
  assert.equal(fx.lines().filter((l) => l === "list:full").length, 1);
});

// An untracked junction inside the worktree pointing at a folder with a file in it: git lists the target's files as
// untracked, so a host that hashes untracked files would read through the link.
function junctionIn(t, wt, rel) {
  const outside = path.join(env.root, `outside-${++seq}`);
  writeText(path.join(outside, "secret.txt"), "TOP SECRET\n");
  const link = path.join(wt, ...rel.split("/"));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  mkJunction(link, outside);
  t.after(() => rmJunction(link));
  return link;
}

test("row 3 (links): an auto-clear never hashes through a junction: the record stays quarantined with tree-unknown:linked-path", (t) => {
  const { wt } = worktree();
  const f = scn();
  fixture();
  junctionIn(t, wt, "src/leak");
  staleActive("worktree", wtRecordPath(wt), wt); // pre hash taken with the link in place: the tree "matches"
  const before = fs.readFileSync(wtRecordPath(wt), "utf8");
  blockedWith(runCli(baseArgs(wt)), /^worktree-quarantined: .*tree-unknown:linked-path/);
  assert.equal(fs.readFileSync(wtRecordPath(wt), "utf8"), before, "no auto-clear: the record is untouched");
  assert.equal(exists(f.argvFile), false);
});

test("row 5 (links): an untracked junction in the worktree -> blocked linked-path before the baseline hash reads through it (P1)", (t) => {
  const { wt } = worktree();
  const f = scn();
  fixture();
  junctionIn(t, wt, "src/leak");
  const j = blockedWith(runCli(baseArgs(wt)), /^linked-path: src\/leak/);
  assert.ok(j.run);
  assert.equal(exists(slotRecordPath(1)), false, "no slot record: nothing became active");
  assert.equal(ledger().length, 0);
  assert.equal(exists(f.argvFile), false);
});

test("rows 3/4: writeClean throws inside the worktree auto-clear -> blocked worktree-quarantined: record-write-failed (P0)", () => {
  const { wt } = worktree();
  fixture();
  staleActive("worktree", wtRecordPath(wt), wt);
  setReadOnly(wtRecordPath(wt), true);
  try {
    blockedWith(runCli(baseArgs(wt)), /^worktree-quarantined: record-write-failed/);
    assert.equal(rec(wtRecordPath(wt)).state, "active");
    assert.equal(ledger().length, 0);
  } finally {
    setReadOnly(wtRecordPath(wt), false);
  }
});

// ------------------------------------------------------------------------------------------ row 4: slots (P1)

test("row 4: all three slots busy -> blocked codex-slots-full; the worktree pipe and record are untouched (P1)", async () => {
  const { wt } = worktree();
  fixture();
  const held = [];
  for (const n of [1, 2, 3]) held.push(await L.acquirePipe(`slot-${n}`));
  try {
    blockedWith(runCli(baseArgs(wt)), /^codex-slots-full$/);
    untouched(wt);
    assert.equal(await L.busySlots(), 0, "this process holds them, so it counts none as other");
  } finally {
    for (const s of held) await L.releasePipe(s);
  }
});

test("row 4: three quarantined slots (auto-clear cannot write) -> codex-slots-full names them; the worktree record stays untouched", () => {
  const { wt } = worktree();
  fixture();
  for (const n of [1, 2, 3]) {
    staleActive("slot", slotRecordPath(n), null);
    setReadOnly(slotRecordPath(n), true);
  }
  try {
    const j = blockedWith(runCli(baseArgs(wt)), /^codex-slots-full: quarantined slot-1 \(record-write-failed\), slot-2 \(record-write-failed\), slot-3 \(record-write-failed\)$/);
    assert.ok(j.run);
    assert.equal(ledger().length, 0);
    assert.equal(exists(wtRecordPath(wt)), false);
  } finally {
    for (const n of [1, 2, 3]) setReadOnly(slotRecordPath(n), false);
  }
});

test("row 4: one quarantined slot is skipped, the next is taken", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  staleActive("slot", slotRecordPath(1), null, { host_started: true });
  const j = ok1(runCli(baseArgs(wt)));
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(rec(slotRecordPath(1)).state, "active", "slot-1 stays quarantined");
  assert.equal(rec(slotRecordPath(2)).state, "clean");
  assert.equal(rec(slotRecordPath(2)).run_id, j.run);
});

// ------------------------------------------------------------------------------------------ row 5: TMP, git, startTime, records (P1 / P2)

test("row 5a: TMP removal fails (a process sits inside it) -> blocked codex-tmp-locked (P1); no ledger, records untouched", async (t) => {
  const { wt } = worktree();
  fixture();
  const inner = path.join(wt, ".codex-tmp", "leftover");
  fs.mkdirSync(inner, { recursive: true });
  const up = marker("holder-up");
  const holder = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1],'up');setTimeout(()=>{},60000)", up], { cwd: inner, stdio: "ignore", windowsHide: true });
  track(holder.pid);
  t.after(() => PR.killTree(holder.pid));
  assert.equal(await waitFor(() => exists(up), 60000), true, "the process holding the folder is up");
  blockedWith(runCli(baseArgs(wt)), /^codex-tmp-locked$/);
  untouched(wt);
  assert.equal(exists(inner), true, "TMP as it was");
});

test("row 5a: a leftover .codex-tmp from a crashed run is removed first", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  writeText(path.join(wt, ".codex-tmp", "old-run", "check-1.cmd"), "@echo off\r\n");
  const j = ok1(runCli(baseArgs(wt)));
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(exists(path.join(wt, ".codex-tmp")), false);
});

test("row 5b: git fails (a worktree with no commit) -> blocked git-failed (P1); no ledger, records untouched", () => {
  const { repo } = worktree();
  fixture();
  const orphan = path.join(path.dirname(repo), "orphan wt");
  git(repo, "worktree", "add", "-q", "--orphan", "-b", "orph", orphan);
  blockedWith(runCli(baseArgs(orphan)), /^git-failed$/);
  untouched(orphan);
});

test("row 5c: startTime null (the lister cannot run) -> blocked procs-unavailable (P1)", () => {
  const { wt } = worktree();
  fixture({ overlay: { users: [] } });
  // a preload that makes every PowerShell spawn fail (the overlay fixture keeps startTime real, so it is the lister path)
  const pre = path.join(env.root, "no-powershell.mjs");
  writeText(pre, 'import cp from "node:child_process";\nimport { syncBuiltinESMExports } from "node:module";\n' +
    "const orig = cp.spawnSync;\n" +
    'cp.spawnSync = (f, ...a) => (/powershell/i.test(String(f)) ? { error: Object.assign(new Error("blocked"), { code: "ENOENT" }), status: null, stdout: "", stderr: "", pid: 0 } : orig(f, ...a));\n' +
    "syncBuiltinESMExports();\n");
  const j = blockedWith(runCli(baseArgs(wt), { extraEnv: { NODE_OPTIONS: `--import ${pathToFileURL(pre).href}` } }), /^procs-unavailable$/);
  assert.ok(j.run);
  untouched(wt);
});

test("row 5d: writeActive(WTR) throws -> blocked state-write-failed (P1); WTR unchanged, no ledger", () => {
  const { wt } = worktree();
  fixture();
  cleanRecord(wtRecordPath(wt));
  const before = fs.readFileSync(wtRecordPath(wt), "utf8");
  setReadOnly(wtRecordPath(wt), true);
  try {
    blockedWith(runCli(baseArgs(wt)), /^state-write-failed$/);
    assert.equal(fs.readFileSync(wtRecordPath(wt), "utf8"), before);
    assert.equal(ledger().length, 0);
    assert.equal(exists(slotRecordPath(1)), false);
  } finally {
    setReadOnly(wtRecordPath(wt), false);
  }
});

test("row 5e: writeActive(SR) throws -> blocked state-write-failed (P2, no listing); ledger blocked, WTR clean, TMP deleted", () => {
  const { wt } = worktree();
  const f = scn();
  const fx = fixture();
  cleanRecord(slotRecordPath(1));
  setReadOnly(slotRecordPath(1), true);
  try {
    const r = runCli(baseArgs(wt));
    const j = blockedWith(r, /^state-write-failed$/);
    assert.equal(rec(wtRecordPath(wt)).state, "clean");
    assert.equal(rec(slotRecordPath(1)).state, "clean");
    assert.equal(rec(slotRecordPath(1)).run_id, "20260101T000000Z-aaaaaa", "SR as it was");
    assert.equal(exists(path.join(wt, ".codex-tmp")), false);
    assert.equal(ledger().length, 1);
    assert.equal(ledger()[0].status, "blocked");
    assert.equal(ledger()[0].run_id, j.run);
    assert.equal(fx.lines().some((l) => l.startsWith("list:")), false, "nothing was spawned: no listing");
    assert.equal(exists(f.argvFile), false);
  } finally {
    setReadOnly(slotRecordPath(1), false);
  }
});

// ------------------------------------------------------------------------------------------ rows 6-9: guards after the records are active (P2)

function blockedP2(r, re, wt, { listing = false, fx } = {}) {
  const j = blockedWith(r, re);
  assert.equal(rec(wtRecordPath(wt)).state, "clean", "WTR clean");
  assert.equal(rec(slotRecordPath(1)).state, "clean", "SR clean");
  assert.equal(exists(path.join(wt, ".codex-tmp")), false, "TMP deleted");
  const l = ledger();
  assert.equal(l.length, 1, "one ledger line");
  assert.equal(l[0].status, "blocked");
  assert.equal(l[0].run_id, j.run);
  if (fx) assert.equal(fx.lines().some((x) => x.startsWith("list:")), listing, listing ? "a listing ran" : "no listing (spawned === 0)");
  return j;
}

test("row 6: a dirty tracked file, and an untracked file -> blocked dirty (P2, no listing)", () => {
  const { wt } = worktree();
  const f = scn();
  const fx = fixture();
  fs.appendFileSync(path.join(wt, "README.md"), "dirty\n");
  blockedP2(runCli(baseArgs(wt)), /^dirty: README\.md/, wt, { fx });
  resetState();
  git(wt, "checkout", "--", "README.md");
  writeText(path.join(wt, "stray.txt"), "x\n");
  blockedP2(runCli(baseArgs(wt)), /^dirty: stray\.txt/, wt, { fx });
  assert.equal(exists(f.argvFile), false);
});

test("row 6: --continue with the run's residue runs; with an extra edit -> blocked continue-mismatch (P2)", (t) => {
  const { wt } = worktree();
  const f1 = scn({ writes: [{ path: "src/a.txt", content: "hello\n" }] });
  reapFake(t, f1);
  fixture();
  // run 1: a check fails -> failed, residue stays, meta.json records the final hash
  const j1 = ok1(runCli(baseArgs(wt, ["--check", "exit /b 3"])));
  assert.equal(j1.status, "failed", JSON.stringify(j1));
  assert.match(j1.reason, /^check-failed/);
  assert.equal(j1.checks[0].exit, 3);
  assert.equal(readJson(path.join(runDirOf(j1.run), "meta.json")).diff_hash.length, 64);
  // a fresh (non-continue) run on the dirty tree is blocked
  resetStateKeepRuns();
  blockedWith(runCli(baseArgs(wt)), /^dirty: /);
  resetStateKeepRuns();
  // run 2: --continue, the new brief lists other globs, the original owned list carries over
  const f2 = scn({ writes: [{ path: "src/b.txt", content: "more\n" }] });
  reapFake(t, f2);
  const j2 = ok1(runCli(["--brief", briefFile(briefText("docs/**")), "--cwd", wt, "--mode", "write", "--continue", j1.run, "--task", "T1"]));
  assert.equal(j2.status, "done", JSON.stringify(j2));
  assert.deepEqual(readJson(path.join(runDirOf(j2.run), "meta.json")).owned, ["src/**"], "owned paths carry over");
  assert.equal(readJson(path.join(runDirOf(j2.run), "meta.json")).baseline, readJson(path.join(runDirOf(j1.run), "meta.json")).baseline);
  assert.deepEqual(j2.files.map((x) => x.split(" ")[0]).sort(), ["src/a.txt", "src/b.txt"], "scope and files stay cumulative against the original baseline");
  // an extra edit after run 2: --continue run 2 is blocked
  writeText(path.join(wt, "src", "extra.txt"), "x\n");
  resetStateKeepRuns();
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt, ["--continue", j2.run])), /^continue-mismatch: /, wt, { fx });
});

// `--continue` tests need the previous run's meta.json: keep STATE/runs but clear the records and the ledger.
function resetStateKeepRuns() {
  rmrf(P.WT_LOCKS);
  rmrf(P.SLOT_LOCKS);
  rmrf(ledgerFile);
}

test("row 6: --continue of an unknown run id -> blocked continue-mismatch (P2)", () => {
  const { wt } = worktree();
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt, ["--continue", "20250101T000000Z-nothere"])), /^continue-mismatch: /, wt, { fx });
});

test("row 7: the quota block -> blocked codex-quota <ISO> (P2); no listing, no version gate, no ACL scan", () => {
  const { wt } = worktree();
  const f = scn();
  const fx = fixture();
  fs.rmSync(P.ACL_STATE); // an ACL scan would be due: a quota block must come first
  fs.rmSync(P.TESTED_VERSION);
  const resets = Math.floor(Date.now() / 1000) + 3 * 86400;
  writeText(P.LAST_USAGE, JSON.stringify({ ts: Date.now(), rate_limits: { primary: null, secondary: { used_percent: 96, window_minutes: 10080, resets_at: resets }, rate_limit_reached_type: null } }));
  const j = blockedP2(runCli(baseArgs(wt)), new RegExp(`^codex-quota ${new Date(resets * 1000).toISOString()}$`), wt, { fx });
  assert.equal(j.week_pct, 96);
  assert.equal(exists(f.argvFile), false);
});

test("row 7: week_pct >= 85 downgrades a Sol write to Luna (model_downgraded:true, the luna slug is passed)", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const resets = Math.floor(Date.now() / 1000) + 3 * 86400;
  writeText(P.LAST_USAGE, JSON.stringify({ ts: Date.now(), rate_limits: { primary: null, secondary: { used_percent: 90, window_minutes: 10080, resets_at: resets }, rate_limit_reached_type: null } }));
  const j = ok1(runCli(baseArgs(wt)));
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(j.model_downgraded, true);
  assert.equal(j.model, "gpt-6-luna");
  assert.equal(readJson(f.argvFile)[4], "gpt-6-luna");
  assert.equal(ledger()[0].model, "luna");
  assert.equal(ledger()[0].writer, "codex-luna");
});

test("row 8: Codex older than 0.159.1 -> blocked codex-version-old (P2, no listing)", () => {
  const { wt } = worktree();
  const f = scn({ version: "0.150.0" });
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt)), /^codex-version-old: 0\.150\.0$/, wt, { fx });
  assert.equal(exists(f.argvFile), false);
});

test("row 8a: a new version and a blind lister -> blocked codex-version-untested: lister-blind (P2, listing); records clean, TMP gone", () => {
  const { wt } = worktree();
  scn();
  fs.rmSync(P.TESTED_VERSION);
  fs.rmSync(PR.LISTER_PROBE);
  const fx = fixture({ overlay: { users: [] } });
  const j = blockedP2(runCli(baseArgs(wt)), /^codex-version-untested: lister-blind/, wt, { listing: true, fx });
  assert.equal(exists(PR.LISTER_PROBE), false, "no lister-probe record for a blind lister");
  assert.deepEqual(j.orphans, []);
});

test("row 8a/8b: the lister probe passes -> LISTER_PROBE written; then the gate fails (gateOpen) -> blocked codex-version-untested (P2, listing)", () => {
  const { wt } = worktree();
  scn({ gateOpen: true });
  fs.rmSync(P.TESTED_VERSION);
  fs.rmSync(PR.LISTER_PROBE);
  const fx = fixture({ overlay: { users: [{ cmd: "lprobe.cmd", user: SBX }] } });
  const j = blockedP2(runCli(baseArgs(wt)), /^codex-version-untested: /, wt, { listing: true, fx });
  assert.doesNotMatch(j.reason, /lister-blind/);
  const lp = readJson(PR.LISTER_PROBE);
  assert.equal(lp.ok, true);
  assert.equal(lp.version, "0.160.0");
  assert.ok(Number.isFinite(Date.parse(lp.at)));
  assert.equal(exists(P.TESTED_VERSION), false, "the gate failed: the version is not recorded as tested");
  assert.deepEqual(j.orphans, []);
});

test("I3: TESTED_VERSION matches but the lister-probe record is missing -> the probe runs (a blind lister blocks, nothing recorded)", () => {
  const { wt } = worktree();
  scn();
  fs.rmSync(PR.LISTER_PROBE); // resetState wrote TESTED_VERSION = 0.160.0 = the fake's version
  const fx = fixture({ overlay: { users: [] } });
  const j = blockedP2(runCli(baseArgs(wt)), /^codex-version-untested: lister-blind/, wt, { listing: true, fx });
  assert.equal(exists(PR.LISTER_PROBE), false);
  assert.deepEqual(j.orphans, []);
});

test("I3: a lister-probe record that is not ok, or is for another version, does not count -> the probe runs", () => {
  for (const rec0 of [{ version: "0.160.0", ok: false }, { version: "0.100.0", ok: true }, { version: "0.160.0" }, "not json"]) {
    resetState();
    const { wt } = worktree();
    scn();
    writeText(PR.LISTER_PROBE, typeof rec0 === "string" ? rec0 : JSON.stringify(rec0));
    const fx = fixture({ overlay: { users: [] } });
    blockedP2(runCli(baseArgs(wt)), /^codex-version-untested: lister-blind/, wt, { listing: true, fx });
  }
});

test("I3: tested version + missing probe record + a working lister -> probe recorded for this version, the version gate is not repeated (gateOpen would block it)", (t) => {
  const { wt } = worktree();
  const f = scn({ gateOpen: true });
  reapFake(t, f);
  fs.rmSync(PR.LISTER_PROBE);
  fixture({ overlay: { users: [{ cmd: "lprobe.cmd", user: SBX }] } });
  const j = ok1(runCli(baseArgs(wt)));
  assert.equal(j.status, "done", JSON.stringify(j));
  const lp = readJson(PR.LISTER_PROBE);
  assert.equal(lp.ok, true);
  assert.equal(lp.version, "0.160.0");
});

test("I4: aclScan throws (a clean scan whose record cannot be written) -> blocked acl-scan-failed (P2), not failed internal", () => {
  const { wt } = worktree();
  const f = scn();
  const fx = fixture();
  // the ACL scan sees a deny on every folder (fake icacls via a preload), then cannot write its record: a folder sits at that path
  fs.rmSync(P.ACL_STATE);
  fs.mkdirSync(P.ACL_STATE);
  const pre = path.join(env.root, "fake-icacls-preload.mjs");
  writeText(pre, 'import cp from "node:child_process";\nimport { syncBuiltinESMExports } from "node:module";\n' +
    "const orig = cp.spawn;\n" +
    `cp.spawn = (f, a, o) => (/icacls\\.exe$/i.test(String(f)) ? orig(process.execPath, [${JSON.stringify(path.join(TESTS_DIR, "fake-icacls.mjs"))}, ...a], o) : orig(f, a, o));\n` +
    "syncBuiltinESMExports();\n");
  const r = runCli(baseArgs(wt), { extraEnv: { NODE_OPTIONS: `--import ${pathToFileURL(pre).href}` } });
  blockedP2(r, /^acl-scan-failed: /, wt, { fx });
  assert.equal(exists(f.argvFile), false, "Codex never ran");
});

test("row 8b: the ACL scan is due and a protected folder lacks the deny -> blocked acl-missing (P2, no listing)", () => {
  const { wt } = worktree();
  const f = scn();
  const fx = fixture();
  fs.rmSync(P.ACL_STATE);
  // the fake icacls lists the old group deny only: a group deny alone no longer counts
  blockedP2(runCli(baseArgs(wt), { extraEnv: { FAKE_ICACLS_MODE: "group-only" } }), /^acl-missing: /, wt, { fx });
  assert.equal(exists(f.argvFile), false);
});

// The per-run host-side deny assertion (step 9, before the group check and the sandboxed read check).
test("step 9: a protected folder lacking a per-user deny -> blocked read-boundary-open: <folder> lacks <user> deny (P2, no listing); group and read check never ran", () => {
  const { wt } = worktree();
  const sbxEnv = path.join(env.root, `sbx-env-${++seq}.jsonl`);
  const f = scn({ sandboxEnvFile: sbxEnv });
  const fx = fixture();
  // the ACL scan is not due (resetState); only the group deny is listed, and the group check would also fail: the deny reason comes first
  const r = runCli(baseArgs(wt), { extraEnv: { FAKE_ICACLS_MODE: "group-only", ...netFixture(["CodexSandboxOffline"]) } });
  blockedP2(r, /^read-boundary-open: .*lacks CodexSandboxOffline deny$/, wt, { listing: false, fx });
  assert.equal(exists(sbxEnv), false, "the read check never ran");
  assert.equal(exists(f.argvFile), false, "Codex never ran");
});

test("step 9: the per-user denies are listed (default fake icacls) -> the run goes on to done", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  assert.equal(ok1(runCli(baseArgs(wt))).status, "done");
});

test("row 9: the read check finds an open target -> blocked read-boundary-open (P2, listing); ledger blocked, records clean", () => {
  const { wt } = worktree();
  const f = scn({ readOpen: [0] });
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt)), /^read-boundary-open: /, wt, { listing: true, fx });
  assert.equal(exists(f.argvFile), false, "Codex never ran");
  // a second run on the same worktree is not busy and not quarantined
  scenario({}, env);
  assert.notEqual(ok1(runCli(baseArgs(wt))).reason, "worktree-busy");
});

test("row 9: a garbled read-check answer -> blocked read-check-failed (P2)", () => {
  const { wt } = worktree();
  scn({ readGarbage: true });
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt)), /^read-check-failed$/, wt, { listing: true, fx });
});

test("row 9: no positive control -> blocked read-check-failed (a check that proves nothing never passes)", () => {
  const { wt } = worktree();
  scn({ noControl: true });
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt)), /^read-check-failed$/, wt, { listing: true, fx });
});

// I2: the read check covers only the offline sandbox user; both sandbox users must be in CodexSandboxUsers.
// CODEX_RUN_NET_FIXTURE (a JSON file {code, stdout}) stands in for `net.exe localgroup CodexSandboxUsers`.
// The I2 tests must run under `node --test`: the fixture is honoured only when NODE_TEST_CONTEXT is set (M2), and
// tmpEnv/mergeEnv pass it on to the spawned CLI. A plain `node tests/run.test.mjs` has no NODE_TEST_CONTEXT, so the
// real net.exe runner would be used and these tests would not pass.
function netFixture(members, code = 0) {
  const f = path.join(env.root, `net-${++seq}.json`);
  writeText(f, JSON.stringify({ code, stdout: ["Alias name     CodexSandboxUsers", "", "Members", "", "-----", ...members, "The command completed successfully.", ""].join("\r\n") }));
  return { CODEX_RUN_NET_FIXTURE: f };
}

test("I2: CodexSandboxOnline not in CodexSandboxUsers -> blocked read-boundary-open (P2, no listing); no read check, Codex never ran", () => {
  const { wt } = worktree();
  const sbxEnv = path.join(env.root, `sbx-env-${++seq}.jsonl`);
  const f = scn({ sandboxEnvFile: sbxEnv });
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt), { extraEnv: netFixture(["CodexSandboxOffline"]) }),
    /^read-boundary-open: CodexSandboxOnline not in CodexSandboxUsers$/, wt, { listing: false, fx });
  assert.equal(exists(sbxEnv), false, "the read check never ran");
  assert.equal(exists(f.argvFile), false, "Codex never ran");
});

test("I2: both sandbox users present (fixture) -> the run goes on to done", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const j = ok1(runCli(baseArgs(wt), { extraEnv: netFixture(["HOST\\CodexSandboxOffline", "HOST\\CodexSandboxOnline"]) }));
  assert.equal(j.status, "done", JSON.stringify(j));
});

test("I2: net.exe failing or unreadable -> blocked read-check-failed: ... (fails closed)", () => {
  const { wt } = worktree();
  const f = scn();
  const fx = fixture();
  blockedP2(runCli(baseArgs(wt), { extraEnv: netFixture(["CodexSandboxOffline", "CodexSandboxOnline"], 2) }), /^read-check-failed: /, wt, { listing: false, fx });
  assert.equal(exists(f.argvFile), false);
});

// ------------------------------------------------------------------------------------------ row 10: brief.md / meta.json, spawn

test("row 10: brief.md or meta.json cannot be written -> blocked state-write-failed (P2, listing: the read check ran)", () => {
  for (const victim of ["meta.json", "brief.md"]) {
    resetState();
    const { wt } = worktree();
    const f = scn();
    const fx = fixture();
    const id = `20261007T000000Z-${rand().slice(0, 6)}`;
    fs.mkdirSync(path.join(runDirOf(id), victim), { recursive: true }); // a folder where the file must go
    const r = runCli(baseArgs(wt), { extraEnv: { CODEX_RUN_ID: id } });
    const j = blockedP2(r, /^state-write-failed$/, wt, { listing: true, fx });
    assert.equal(j.run, id);
    assert.equal(exists(f.argvFile), false, "Codex never ran");
  }
});

test("row 10: a non-write mode without its schema file -> blocked schema-missing (P0)", () => {
  const { wt } = worktree();
  fixture();
  const b = briefFile("# Task T1: look\nGoal: x\n");
  // the real schemas exist now (Tasks 12/13): prove the check on a copy of the skill folder without them
  const bare = skillCopy(null, { noSchemas: true });
  for (const mode of ["diagnose", "research"]) {
    blockedWith(runCopy(bare, ["--brief", b, "--cwd", wt, "--mode", mode]), /^schema-missing: /);
  }
  blockedWith(runCopy(bare, ["--brief", b, "--cwd", wt, "--mode", "review", "--review-of", "r1"]), /^schema-missing: /);
  assert.equal(ledger().length, 0);
});

// A copy of the skill folder with a schema and a (stub or working) review-input: proves the wiring of Tasks 12/13.
function skillCopy(reviewInputSource, { noSchemas = false } = {}) {
  const copy = path.join(env.root, `skill-${++seq}`);
  fs.mkdirSync(copy, { recursive: true });
  for (const d of ["lib", "schemas", "templates"]) fs.cpSync(path.join(SKILL_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(CODEX_RUN, path.join(copy, "codex-run.mjs"));
  if (noSchemas) for (const f of ["review", "diagnose", "research"]) fs.rmSync(path.join(copy, "schemas", `${f}.json`));
  if (reviewInputSource) fs.writeFileSync(path.join(copy, "lib", "review-input.mjs"), reviewInputSource);
  return path.join(copy, "codex-run.mjs");
}
function runCopy(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...env }, encoding: "utf8", windowsHide: true, timeout: 240000 });
  const lines = String(r.stdout ?? "").split("\n").filter(Boolean);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr, lines, json: JSON.parse(lines[lines.length - 1]) };
}

test("row 10 (review): the stub review-input -> blocked review-input-not-built (P2); a working one -> done with verdict, findings, patch_sha256", (t) => {
  const { wt } = worktree();
  const f = scn({ lastJson: { verdict: "needs-attention", summary: "s", findings: [{ severity: "low", title: "t", body: "b", file: "a.js", line_start: 3, line_end: 4, confidence: 0.5, recommendation: "r" }], next_steps: ["n"] }, writes: [] });
  reapFake(t, f);
  fixture();
  const b = briefFile("# Task T1: review\nGoal: review it\n");
  const args = ["--brief", b, "--cwd", wt, "--mode", "review", "--review-of", "20250101T000000Z-aaaaaa", "--task", "R1"];
  const stub = runCopy(skillCopy(`export async function reviewInput() { return { ok: false, reason: "review-input-not-built" }; }
`), args);
  assert.equal(stub.json.status, "blocked");
  assert.equal(stub.json.reason, "review-input-not-built");
  assert.equal(ledger().at(-1).status, "blocked");
  assert.equal(exists(f.argvFile), false);
  resetState();
  scenario(f, env);
  const sha = "f".repeat(64);
  const working = skillCopy(`export async function reviewInput(o) { return { ok: true, patchPath: "p", sha256: ${JSON.stringify(sha)} }; }\n`);
  const r = runCopy(working, args);
  assert.equal(r.json.status, "done", JSON.stringify(r.json));
  assert.equal(r.json.verdict, "needs-attention");
  assert.equal(r.json.summary, "s");
  assert.deepEqual(r.json.findings, [{ severity: "low", title: "t", file: "a.js", line_start: 3, line_end: 4 }]);
  assert.equal(r.json.patch_sha256, sha);
  assert.equal(r.json.mode, "review");
  assert.equal(readJson(f.argvFile)[readJson(f.argvFile).indexOf("-s") + 1], "read-only");
  assert.equal(rec(wtRecordPath(wt)).state, "clean");
});

// ------------------------------------------------------------------------------------------ rows 10-11: Codex outcomes (P3)

function p3(r, wt, { status, reason, fx } = {}) {
  const j = ok1(r);
  assert.equal(j.status, status, JSON.stringify(j));
  if (reason) assert.match(j.reason, reason, JSON.stringify(j));
  assert.equal(rec(wtRecordPath(wt)).state, "clean", "WTR clean");
  assert.equal(rec(slotRecordPath(1)).state, "clean", "SR clean");
  assert.equal(exists(path.join(wt, ".codex-tmp")), false, "TMP deleted");
  const l = ledger();
  assert.equal(l.length, 1);
  assert.equal(l[0].status, status);
  assert.equal(l[0].run_id, j.run);
  return j;
}

test("row 10 / Review Focus 5: Codex exits 1 -> failed codex-exit; ledger written, records clean", (t) => {
  const { wt } = worktree();
  const f = scn({ exit: 1 });
  reapFake(t, f);
  fixture();
  p3(runCli(baseArgs(wt)), wt, { status: "failed", reason: /^codex-exit: 1$/ });
});

test("row 10 / Review Focus 5: an invalid last.json -> failed codex-last-json-invalid; ledger written, records clean", (t) => {
  for (const lastJson of ["{not json", JSON.stringify({ status: "maybe", note: "x", checks_run: [] }), JSON.stringify([1])]) {
    resetState();
    const { wt } = worktree();
    const f = scn({ lastJson });
    reapFake(t, f);
    fixture();
    p3(runCli(baseArgs(wt)), wt, { status: "failed", reason: /^codex-last-json-invalid$/ });
  }
});

test("row 10 / Review Focus 5: no thread.started event -> failed codex-no-thread; ledger written, records clean", (t) => {
  const { wt } = worktree();
  const f = scn({ noThread: true });
  reapFake(t, f);
  fixture();
  p3(runCli(baseArgs(wt)), wt, { status: "failed", reason: /^codex-no-thread$/ });
});

test("row 10: the codex exec spawn itself fails -> failed codex-spawn: <code> (P3); ledger failed, records clean", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  // a copy of the skill whose execArgs hands spawn() an argument it refuses (a NUL byte): the real spawn error path
  const copy = path.join(env.root, `skill-${++seq}`);
  fs.mkdirSync(copy, { recursive: true });
  for (const d of ["lib", "schemas", "templates"]) fs.cpSync(path.join(SKILL_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(CODEX_RUN, path.join(copy, "codex-run.mjs"));
  const argvFile = path.join(copy, "lib", "argv.mjs");
  const src = fs.readFileSync(argvFile, "utf8");
  assert.ok(src.includes("export function execArgs(opts) {"));
  fs.writeFileSync(argvFile, src.replace("export function execArgs(opts) {", "function execArgsReal(opts) {") +
    '\nexport function execArgs(opts) { return [...execArgsReal(opts), "bad\\u0000arg"]; }\n');
  const r = runCopy(path.join(copy, "codex-run.mjs"), baseArgs(wt));
  p3(r, wt, { status: "failed", reason: /^codex-spawn: ERR_INVALID_ARG_VALUE$/ });
  assert.equal(exists(f.argvFile), false);
});

test("rows 8a-11: addChild throws after a spawn -> stderr child-unrecorded:<pid>, the run goes on; the unwritable record stays active", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const sr = slotRecordPath(1);
  t.after(() => { if (exists(sr)) setReadOnly(sr, false); });
  // check 1 makes the slot record read-only, so recording check 2's pid (and the final writes) fail
  const r = runCli(baseArgs(wt, ["--check", `attrib +R "${sr}"`, "--check", "echo two"]));
  const j = ok1(r);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.deepEqual(j.checks.map((c) => c.exit), [0, 0]);
  assert.match(r.stderr, /child-unrecorded:\d+/);
  assert.match(r.stderr, /record-clean-failed slot/);
  assert.equal(rec(sr).state, "active", "left active: the next run takes the quarantine path");
  assert.equal(rec(wtRecordPath(wt)).state, "clean");
  setReadOnly(sr, false);
});

test("row 10: Codex says blocked / failed in last.json -> the status follows (blocked / failed), with its note", (t) => {
  for (const [st, want] of [["blocked", /^codex-blocked: need docker/], ["failed", /^codex-failed: broke/]]) {
    resetState();
    const { wt } = worktree();
    const f = scn({ lastJson: { status: st, note: st === "blocked" ? "need docker" : "broke", checks_run: [] } });
    reapFake(t, f);
    fixture();
    p3(runCli(baseArgs(wt)), wt, { status: st, reason: want });
  }
});

test("row 10: Codex timeout with a detached grandchild -> blocked timeout, both pids gone, orphans [] (P3)", async (t) => {
  const { wt } = worktree();
  const tag = `cdx-gc-${rand()}`;
  gcTags.push(tag);
  const f = scn({ sleepMs: 60000, grandchild: "detached", grandchildTag: tag, grandchildMs: 90000 });
  reapFake(t, f);
  fixture({ overlay: { users: [] } });
  const r = runCli(baseArgs(wt), { extraEnv: { CODEX_RUN_TIMEOUT_MS: "9000" } });
  const j = p3(r, wt, { status: "blocked", reason: /^timeout$/ });
  assert.deepEqual(j.orphans, []);
  const pids = readJson(f.pidFile);
  assert.equal(await waitGone(pids.pid), true, "the fake is gone");
  assert.equal(await waitGone(pids.grandchild), true, "its detached grandchild is gone");
});

test("rows 8a-11: every spawned codex pid is recorded in both records while the run is active (child_pids)", async (t) => {
  const { wt } = worktree();
  const f = scn({ sleepMs: 8000 });
  reapFake(t, f);
  fixture();
  const first = spawn(process.execPath, [CODEX_RUN, ...baseArgs(wt)], { env: { ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  track(first.pid);
  first.stdout.on("data", () => {});
  first.stderr.on("data", () => {});
  assert.equal(await waitFor(() => exists(f.pidFile), 60000), true);
  const w = rec(wtRecordPath(wt));
  const s = rec(slotRecordPath(1));
  const pid = readJson(f.pidFile).pid;
  for (const r of [w, s]) {
    assert.equal(r.state, "active");
    assert.equal(r.owner_pid, first.pid);
    assert.ok(r.child_pids.some((c) => c.pid === pid), "codex pid recorded");
    assert.ok(Date.parse(r.owner_start_time) > 0);
    assert.equal(r.baseline, git(wt, "rev-parse", "HEAD"));
    assert.match(r.tree_hash_pre, /^[0-9a-f]{64}$/);
    assert.equal(r.host_started, false);
  }
  await new Promise((resolve) => first.on("close", resolve));
});

// ------------------------------------------------------------------------------------------ row 11: scope, checks

test("row 11: an untracked out-of-scope file -> blocked out-of-scope, no check ran (P3)", (t) => {
  const { wt } = worktree();
  const f = scn({ writes: [{ path: "other/b.txt", content: "y\n" }] });
  reapFake(t, f);
  fixture();
  const m = marker("chk");
  const j = p3(runCli(baseArgs(wt, ["--check", `echo ran> "${m}"`])), wt, { status: "blocked", reason: /^out-of-scope: other\/b\.txt/ });
  assert.equal(exists(m), false, "no check may run on an out-of-scope tree");
  assert.deepEqual(j.checks, []);
});

test("row 11: a check that writes an out-of-scope file -> the final scope blocks (P3)", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const j = p3(runCli(baseArgs(wt, ["--check", "echo y> sneaky.txt"])), wt, { status: "blocked", reason: /^out-of-scope: sneaky\.txt/ });
  assert.equal(j.checks.length, 1);
  assert.equal(j.checks[0].exit, 0);
});

// C1: a link Codex makes under an owned glob must never be read by the host (hash, line counts).
function leakTarget(name) {
  const dir = path.join(env.root, `${name}-${++seq}`);
  writeText(path.join(dir, "secret.txt"), "TOP SECRET\n");
  return dir;
}

test("C1: Codex makes a junction under an owned glob -> blocked linked-path, files [], no diff_hash, no check ran, target untouched", (t) => {
  const { wt } = worktree();
  const target = leakTarget("leak");
  const f = scn({ links: [{ kind: "junction", path: "src/leak", target }] });
  reapFake(t, f);
  t.after(() => rmJunction(path.join(wt, "src", "leak")));
  fixture();
  const m = marker("chk");
  const j = p3(runCli(baseArgs(wt, ["--check", `echo ran> "${m}"`])), wt, { status: "blocked", reason: /^linked-path: src\/leak/ });
  assert.deepEqual(j.files, []);
  assert.deepEqual(j.checks, []);
  assert.equal(exists(m), false, "no check may run on a tree with a link");
  const meta = readJson(path.join(runDirOf(j.run), "meta.json"));
  assert.equal(meta.diff_hash, undefined, "the host did not hash through the junction");
  assert.equal(meta.files, undefined);
  assert.equal(rec(wtRecordPath(wt)).tree_hash_final, null);
  assert.deepEqual(ledger()[0].files, []);
  assert.equal(fs.readFileSync(path.join(target, "secret.txt"), "utf8"), "TOP SECRET\n");
});

test("C1: Codex hard-links a file under an owned glob -> blocked linked-path, files [], no diff_hash", (t) => {
  const { wt } = worktree();
  const target = leakTarget("hl");
  const f = scn({ links: [{ kind: "hardlink", path: "src/hl.txt", target: path.join(target, "secret.txt") }] });
  reapFake(t, f);
  fixture();
  const m = marker("chk");
  const j = p3(runCli(baseArgs(wt, ["--check", `echo ran> "${m}"`])), wt, { status: "blocked", reason: /^linked-path: src\/hl\.txt/ });
  assert.deepEqual(j.files, []);
  assert.equal(exists(m), false);
  assert.equal(readJson(path.join(runDirOf(j.run), "meta.json")).diff_hash, undefined);
  assert.equal(rec(wtRecordPath(wt)).tree_hash_final, null);
});

test("C1: .codex-tmp itself replaced by a junction -> blocked linked-path before any check; nothing written through it; target kept", (t) => {
  const { wt } = worktree();
  const target = path.join(env.root, `tmpj-${++seq}`);
  writeText(path.join(target, "keep.txt"), "keep\n");
  const f = scn({ tmpJunction: target });
  reapFake(t, f);
  t.after(() => rmJunction(path.join(wt, ".codex-tmp")));
  fixture();
  const m = marker("chk");
  const j = p3(runCli(baseArgs(wt, ["--check", `echo ran> "${m}"`, "--check-host", `echo ran> "${m}"`])), wt,
    { status: "blocked", reason: /^linked-path: \.codex-tmp/ });
  assert.deepEqual(j.checks, []);
  assert.equal(exists(m), false, "no check (sandbox or host) may run");
  assert.deepEqual(fs.readdirSync(target), ["keep.txt"], "no check file was written through the junction, and the end routine did not clear the target");
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep\n");
});

// I1: the sandbox gets an allowlisted environment, never the host's secrets.
const lowerKeys = (names) => new Set(names.map((k) => k.toLowerCase()));
const SECRET_ENV = { MY_DB_PASSWORD: "hunter2-secret", MY_ALLOWED_VAR: "visible", CODEX_RUN_ENV_ALLOW: "MY_ALLOWED_VAR" };

test("I1: codex exec, the read check and sandbox checks get an allowlisted env (no MY_DB_PASSWORD, PATH kept); a host check keeps the full env", (t) => {
  const { wt } = worktree();
  const execEnv = path.join(env.root, `exec-env-${++seq}.json`);
  const sbxEnv = path.join(env.root, `sbx-env-${++seq}.jsonl`);
  const f = scn({ envFile: execEnv, sandboxEnvFile: sbxEnv });
  reapFake(t, f);
  fixture();
  const hostOut = path.join(env.root, `host-env-${++seq}.txt`);
  const r = runCli(baseArgs(wt, ["--check", "echo sandboxed", "--check-host", `echo %MY_DB_PASSWORD%> "${hostOut}"`]), { extraEnv: SECRET_ENV });
  const j = ok1(r);
  assert.equal(j.status, "done", JSON.stringify(j));
  const ex = lowerKeys(readJson(execEnv));
  assert.equal(ex.has("my_db_password"), false, "the secret reached codex exec");
  assert.equal(ex.has("path"), true);
  for (const k of ["systemroot", "comspec", "userprofile", "temp", "codex_home", "fake_codex_scenario", "my_allowed_var"]) assert.equal(ex.has(k), true, `${k} must reach codex exec`);
  const calls = fs.readFileSync(sbxEnv, "utf8").split("\n").filter(Boolean).map((l) => lowerKeys(JSON.parse(l)));
  assert.ok(calls.length >= 2, "the read check and the sandbox check both ran");
  for (const c of calls) {
    assert.equal(c.has("my_db_password"), false, "the secret reached a sandbox call");
    assert.equal(c.has("path"), true);
  }
  assert.equal(fs.readFileSync(hostOut, "utf8").trim(), SECRET_ENV.MY_DB_PASSWORD, "--check-host keeps the full environment");
});

test("I1: the lister probe, the version gate and its probes get the allowlisted env too (no MY_DB_PASSWORD in any sandbox call)", () => {
  const { wt } = worktree();
  const sbxEnv = path.join(env.root, `sbx-env-${++seq}.jsonl`);
  scn({ gateOpen: true, sandboxEnvFile: sbxEnv });
  fs.rmSync(P.TESTED_VERSION);
  fs.rmSync(PR.LISTER_PROBE);
  const fx = fixture({ overlay: { users: [{ cmd: "lprobe.cmd", user: SBX }] } });
  const rr = runCli(baseArgs(wt), { extraEnv: SECRET_ENV });
  blockedP2(rr, /^codex-version-untested: /, wt, { listing: true, fx });
  const calls = fs.readFileSync(sbxEnv, "utf8").split("\n").filter(Boolean).map((l) => lowerKeys(JSON.parse(l)));
  assert.ok(calls.length >= 3, `the lister probe and the gate probes ran sandbox calls (${calls.length})`);
  for (const c of calls) {
    assert.equal(c.has("my_db_password"), false, "the secret reached a sandbox call");
    assert.equal(c.has("path"), true);
  }
});

// I3: CODEX_API_KEY reaches `codex exec` only. Other CODEX_* names no longer pass by prefix; CODEX_HOME still does.
const API_ENV = { CODEX_API_KEY: "sk-test-not-a-real-key", CODEX_OTHER_TOKEN: "other-secret" };

test("I3: CODEX_API_KEY is in the codex exec env only: absent from the read check and the sandbox check; other CODEX_* names do not pass; CODEX_HOME does", (t) => {
  const { wt } = worktree();
  const execEnv = path.join(env.root, `exec-env-${++seq}.json`);
  const sbxEnv = path.join(env.root, `sbx-env-${++seq}.jsonl`);
  const f = scn({ envFile: execEnv, sandboxEnvFile: sbxEnv });
  reapFake(t, f);
  fixture();
  const j = ok1(runCli(baseArgs(wt, ["--check", "echo sandboxed"]), { extraEnv: API_ENV }));
  assert.equal(j.status, "done", JSON.stringify(j));
  const ex = lowerKeys(readJson(execEnv));
  assert.equal(ex.has("codex_api_key"), true, "codex exec needs the key");
  assert.equal(ex.has("codex_other_token"), false, "an arbitrary CODEX_* name must not pass");
  assert.equal(ex.has("codex_home"), true);
  const calls = fs.readFileSync(sbxEnv, "utf8").split("\n").filter(Boolean).map((l) => lowerKeys(JSON.parse(l)));
  assert.ok(calls.length >= 2, "the read check and the sandbox check both ran");
  for (const c of calls) {
    assert.equal(c.has("codex_api_key"), false, "CODEX_API_KEY reached a sandbox call");
    assert.equal(c.has("codex_other_token"), false);
    assert.equal(c.has("codex_home"), true);
  }
});

test("I3: CODEX_API_KEY is absent from the lister probe and the version gate sandbox calls", () => {
  const { wt } = worktree();
  const sbxEnv = path.join(env.root, `sbx-env-${++seq}.jsonl`);
  scn({ gateOpen: true, sandboxEnvFile: sbxEnv });
  fs.rmSync(P.TESTED_VERSION);
  fs.rmSync(PR.LISTER_PROBE);
  const fx = fixture({ overlay: { users: [{ cmd: "lprobe.cmd", user: SBX }] } });
  const rr = runCli(baseArgs(wt), { extraEnv: API_ENV });
  blockedP2(rr, /^codex-version-untested: /, wt, { listing: true, fx });
  const calls = fs.readFileSync(sbxEnv, "utf8").split("\n").filter(Boolean).map((l) => lowerKeys(JSON.parse(l)));
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.equal(c.has("codex_api_key"), false, "CODEX_API_KEY reached a sandbox call");
});

// I2: a file symlink planted at the check path (Codex can write into .codex-tmp) makes the run block; nothing is written through it.
test("I2: a symlink pre-planted at the check file path -> blocked linked-path, the check never runs, the link target is unchanged", (t) => {
  const { wt } = worktree();
  const id = `i2run${++seq}`;
  const victim = path.join(env.root, `victim-${seq}.txt`);
  writeText(victim, "keep\n");
  try { // symlink privilege probe (Developer Mode or admin)
    const probeLink = path.join(env.root, `probe-link-${seq}`);
    fs.symlinkSync(victim, probeLink, "file");
    fs.rmSync(probeLink);
  } catch (e) {
    if (e.code === "EPERM") { t.diagnostic("skipped: no symlink privilege"); return; }
    throw e;
  }
  const f = scn({ fileSymlinks: [{ path: `.codex-tmp/${id}/check-1.cmd`, target: victim }] });
  reapFake(t, f);
  fixture();
  const m = marker("chk");
  const j = p3(runCli(baseArgs(wt, ["--check", `echo ran> "${m}"`]), { extraEnv: { CODEX_RUN_ID: id } }), wt,
    { status: "blocked", reason: /^linked-path: / });
  assert.equal(exists(m), false, "the check must not run");
  assert.equal(fs.readFileSync(victim, "utf8"), "keep\n", "nothing was written through the link");
});

test("row 11: Codex done but a check fails -> failed (spec: Codex's done is not proof); every check still reported", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const j = p3(runCli(baseArgs(wt, ["--check", "echo one", "--check", "exit /b 4", "--check", "echo three"])), wt, { status: "failed", reason: /^check-failed: exit \/b 4/ });
  assert.deepEqual(j.checks.map((c) => c.exit), [0, 4, 0]);
  assert.equal(ledger()[0].checks_passed, false);
});

test("row 11: a check with quotes and & survives, and its own exit code is reported", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const j = p3(runCli(baseArgs(wt, ["--check", 'echo "a b" & exit /b 5'])), wt, { status: "failed", reason: /^check-failed/ });
  assert.equal(j.checks[0].exit, 5);
  assert.match(j.checks[0].tail, /a b/);
});

test("row 11: a check that times out -> failed check-timeout; its process tree is gone (P3)", async (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const pidf = path.join(env.root, `sleeper-${++seq}.pid`);
  const sleeper = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},60000)" "${pidf}"`;
  const j = p3(runCli(baseArgs(wt, ["--check", sleeper]), { extraEnv: { CODEX_RUN_CHECK_TIMEOUT_MS: "10000" } }), wt, { status: "failed", reason: /^check-timeout: / });
  assert.equal(j.checks[0].exit, null);
  assert.equal(j.checks[0].timeout, true);
  const pid = Number(fs.readFileSync(pidf, "utf8"));
  track(pid);
  assert.equal(await waitGone(pid), true, "the check's process is gone");
  assert.deepEqual(j.orphans, []);
});

test("row 11: a host check runs after the scope check, marks host_started, and is reported with host_checks:true", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  const m = marker("host");
  // the host check copies the worktree record while it runs: host_started must already be true (written ahead)
  const j = ok1(runCli(baseArgs(wt, ["--check", "echo sandbox", "--check-host", `type "${wtRecordPath(wt)}"> "${m}"`])));
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(j.host_checks, true);
  assert.equal(exists(m), true);
  const during = readJson(m);
  assert.equal(during.state, "active");
  assert.equal(during.host_started, true, "markHostStarted comes BEFORE the first --check-host spawn");
  assert.ok(during.child_pids.length >= 2, "the codex pid and the sandbox check pid were recorded before the host check ran");
  assert.equal(j.checks.length, 2);
  assert.equal(rec(wtRecordPath(wt)).host_started, true, "host_started stays in the record (a clean record keeps the last state)");
  assert.equal(ledger()[0].host_checks, true);
});

test("row 11: no host check runs when the scope check failed, or when a sandbox check failed", (t) => {
  const { wt } = worktree();
  const f = scn({ writes: [{ path: "other/b.txt", content: "y\n" }] });
  reapFake(t, f);
  fixture();
  const m = marker("host");
  const j = ok1(runCli(baseArgs(wt, ["--check-host", `echo hostran> "${m}"`])));
  assert.equal(j.status, "blocked");
  assert.equal(exists(m), false);
  assert.equal(j.host_checks, false);
  resetState();
  const { wt: wt2 } = worktree();
  const f2 = scn();
  reapFake(t, f2);
  fixture();
  const j2 = ok1(runCli(baseArgs(wt2, ["--check", "exit /b 1", "--check-host", `echo hostran> "${m}"`])));
  assert.equal(j2.status, "failed");
  assert.equal(exists(m), false, "host checks only after the sandbox checks all passed");
});

test("row 11: markHostStarted throws -> no --check-host spawns, failed state-write-failed (P3)", (t) => {
  const { wt } = worktree();
  // Codex (the fake) overwrites the worktree record while it runs: the record is no longer active
  const f = scn();
  f.writes.push({ path: wtRecordPath(wt), content: JSON.stringify({ v: 1, state: "clean" }) });
  scenario(f, env);
  reapFake(t, f);
  fixture();
  const m = marker("host");
  const j = p3(runCli(baseArgs(wt, ["--check-host", `echo hostran> "${m}"`])), wt, { status: "failed", reason: /^state-write-failed$/ });
  assert.equal(exists(m), false, "the host check never spawned");
  assert.equal(j.host_checks, false);
});

test("row 11: markTreeFinal throws -> a stderr note, the status is unchanged (done)", (t) => {
  const { wt } = worktree();
  const f = scn();
  f.writes.push({ path: wtRecordPath(wt), content: JSON.stringify({ v: 1, state: "clean" }) });
  scenario(f, env);
  reapFake(t, f);
  fixture();
  const r = runCli(baseArgs(wt));
  const j = ok1(r);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.match(r.stderr, /tree-final-unrecorded/);
  assert.equal(rec(wtRecordPath(wt)).state, "clean");
});

// ------------------------------------------------------------------------------------------ rows 12-13

test("row 12: recordUsage and appendRun throw -> stderr notes, the run continues to the end routine, result unchanged", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture();
  writeText(P.USAGE_DIR, "a file where the usage folder should be");
  fs.mkdirSync(ledgerFile, { recursive: true }); // a folder where the ledger file should be
  const r = runCli(baseArgs(wt));
  const j = ok1(r);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.match(r.stderr, /usage-not-recorded/);
  assert.match(r.stderr, /ledger-not-written/);
  assert.equal(rec(wtRecordPath(wt)).state, "clean");
  assert.equal(rec(slotRecordPath(1)).state, "clean");
  assert.equal(exists(path.join(wt, ".codex-tmp")), false);
  rmrf(ledgerFile);
});

test("row 12: a missing rollout -> usage null with one stderr line, the status is unaffected", (t) => {
  const { wt } = worktree();
  const f = scn({ noRollout: true });
  reapFake(t, f);
  fixture();
  const r = runCli(baseArgs(wt));
  const j = ok1(r);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(j.week_pct, null);
  assert.match(r.stderr, /usage unavailable/);
});

test("row 13 (A4b): a sandbox-user process started after the run began is an orphan; one older than the run is not; records stay active, TMP kept", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  const row = (pid, start) => ({ pid, ppid: 4, name: "PING.EXE", user: SBX, cmd: null, session: 1, start });
  fixture({ session: { ok: true, rows: [row(999999, "2099-01-01T00:00:00.0000000Z"), row(999998, "2000-01-01T00:00:00.0000000Z")] } });
  const r = runCli(baseArgs(wt), { timeout: 280000 });
  const j = ok1(r);
  assert.equal(j.status, "done", "the orphans do not change the status");
  assert.deepEqual(j.orphans, [999999]);
  assert.match(r.stderr, /codex-run: orphans 999999/);
  assert.equal(rec(wtRecordPath(wt)).state, "active");
  assert.equal(rec(slotRecordPath(1)).state, "active");
  assert.equal(exists(path.join(wt, ".codex-tmp")), true, "TMP kept as evidence");
  assert.equal(ledger()[0].status, "done");
  // the next run on this worktree is quarantined (the quarantine path lists the processes again)
  resetStateKeepRecords();
  const fx = fixture({ full: { ok: true, rows: [row(999999, "2099-01-01T00:00:00.0000000Z")] } });
  blockedWith(runCli(baseArgs(wt)), /^worktree-quarantined: .*sandbox-user:999999:PING\.EXE/);
  assert.equal(fx.lines().filter((l) => l === "list:full").length, 1);
});
// B3: transient sandbox helpers still exiting at the end are not orphans. The end listing re-lists after 1.5 s, up to 3 more
// times, stopping at the first clean listing; the orphans are whatever the LAST listing shows.
const ROW_A = (pid, start = "2099-01-01T00:00:00.0000000Z") => ({ pid, ppid: 4, name: "PING.EXE", user: SBX, cmd: null, session: 1, start });
const SES = (rows) => ({ ok: true, rows });

test("B3: helpers gone by the 4th end listing (first listing and two re-lists still show them) -> orphans [], records clean, TMP removed", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  const fx = fixture({ session: [SES([ROW_A(999999), ROW_A(999998)]), SES([ROW_A(999999)]), SES([ROW_A(999999)]), SES([])] });
  const j = ok1(runCli(baseArgs(wt), { timeout: 280000 }));
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.deepEqual(j.orphans, []);
  assert.equal(rec(wtRecordPath(wt)).state, "clean");
  assert.equal(rec(slotRecordPath(1)).state, "clean");
  assert.equal(exists(path.join(wt, ".codex-tmp")), false);
  assert.equal(fx.lines().filter((l) => l === "list:session").length, 4, "one listing plus three re-lists");
});

test("B3: the last listing decides: a pid whose start time changed between listings is still counted (never hide a real orphan)", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  const fx = fixture({ session: [
    SES([ROW_A(999999, "2099-01-01T00:00:00.0000000Z"), ROW_A(999998, "2099-01-01T00:00:00.0000000Z")]),
    SES([ROW_A(999999, "2099-06-01T00:00:00.0000000Z"), ROW_A(999998, "2099-01-01T00:00:00.0000000Z")]),
  ] });
  const r = runCli(baseArgs(wt), { timeout: 280000 });
  const j = ok1(r);
  assert.deepEqual([...j.orphans].sort((x, y) => x - y), [999998, 999999], "both are in the last listing: both are orphans");
  assert.equal(rec(wtRecordPath(wt)).state, "active");
  assert.equal(fx.lines().filter((l) => l === "list:session").length, 4, "the survivors are re-listed to the end");
});

test("B3: an orphan A that spawned a daemon B and exited: B first seen in listing 3 is still an orphan", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  const fx = fixture({ session: [SES([ROW_A(999999)]), SES([ROW_A(999999)]), SES([ROW_A(999998)])] });
  const j = ok1(runCli(baseArgs(wt), { timeout: 280000 }));
  assert.deepEqual(j.orphans, [999998], "A is gone, B (new in listing 3) is what the last listing shows");
  assert.equal(rec(wtRecordPath(wt)).state, "active");
  assert.equal(fx.lines().filter((l) => l === "list:session").length, 4, "re-listed to the end");
});

function resetStateKeepRecords() {
  rmrf(ledgerFile);
  writeText(P.TESTED_VERSION, "0.160.0\n");
  writeText(PR.LISTER_PROBE, JSON.stringify({ version: "0.160.0", ok: true, at: new Date().toISOString() }));
}

test("row 13: a blind end listing -> orphans [lister-blind], both records stay active, TMP kept", (t) => {
  const { wt } = worktree();
  const f = scn();
  reapFake(t, f);
  fixture({ session: { ok: false, error: "x" } });
  const j = ok1(runCli(baseArgs(wt)));
  assert.equal(j.status, "done");
  assert.deepEqual(j.orphans, ["lister-blind"]);
  assert.equal(rec(wtRecordPath(wt)).state, "active");
  assert.equal(rec(slotRecordPath(1)).state, "active");
  assert.equal(exists(path.join(wt, ".codex-tmp")), true);
});

test("row 13: a quota block spawns nothing -> no end listing at all (spawned === 0)", () => {
  const { wt } = worktree();
  scn();
  const fx = fixture();
  const resets = Math.floor(Date.now() / 1000) + 86400;
  writeText(P.LAST_USAGE, JSON.stringify({ ts: Date.now(), rate_limits: { primary: null, secondary: { used_percent: 99, window_minutes: 10080, resets_at: resets }, rate_limit_reached_type: null } }));
  blockedWith(runCli(baseArgs(wt)), /^codex-quota /);
  assert.deepEqual(fx.lines().filter((l) => l.startsWith("list:")), []);
});

test("row 13: writeClean throws at the end (the record was replaced) -> stderr note, pipes released, that record stays active; TMP deleted", (t) => {
  const { wt } = worktree();
  const f = scn();
  f.writes.push({ path: wtRecordPath(wt), content: OTHER_ACTIVE("worktree") });
  scenario(f, env);
  reapFake(t, f);
  fixture();
  const r = runCli(baseArgs(wt));
  const j = ok1(r);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.match(r.stderr, /record-clean-failed worktree/);
  assert.equal(rec(wtRecordPath(wt)).state, "active", "left active: the next run takes the quarantine path");
  assert.equal(rec(slotRecordPath(1)).state, "clean");
  assert.equal(exists(path.join(wt, ".codex-tmp")), false);
});

test("row 13: TMP cannot be deleted at the end (a process sits in it) -> stderr note codex-tmp-left, records still go clean", async (t) => {
  const { wt } = worktree();
  const pidf = path.join(env.root, `cwd-holder-${++seq}.pid`);
  const f = scn();
  reapFake(t, f);
  fixture();
  // the check starts a detached process whose cwd is inside TMP (so TMP stays locked after the run)
  const code = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},40000)'],{cwd:process.argv[2],detached:true,stdio:'ignore',windowsHide:true});` +
    `require('fs').writeFileSync(process.argv[1],String(c.pid));c.unref();`;
  const holderCmd = `"${process.execPath}" -e "${code.replace(/"/g, '\\"')}" "${pidf}" "${path.join(wt, ".codex-tmp")}"`;
  const r = runCli(baseArgs(wt, ["--check", holderCmd]), { timeout: 280000 });
  const j = ok1(r);
  if (exists(pidf)) track(Number(fs.readFileSync(pidf, "utf8")));
  t.after(() => { if (exists(pidf)) PR.killTree(Number(fs.readFileSync(pidf, "utf8"))); });
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.match(r.stderr, /codex-tmp-left/);
  assert.equal(rec(wtRecordPath(wt)).state, "clean", "a stuck TMP does not change the status or keep the record active");
  assert.equal(rec(slotRecordPath(1)).state, "clean");
  assert.equal(exists(path.join(wt, ".codex-tmp")), true);
});

// ------------------------------------------------------------------------------------------ other commands

test("--status prints the real status line; --verdict on an unknown run is blocked unknown-run", () => {
  const s = runCli(["--status"]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /^codex/);
  const v = runCli(["--verdict", "20260101T000000Z-aaaaaa", "approve", "fine"]);
  assert.equal(v.status, 0);
  assert.deepEqual(v.json, { ok: false, status: "blocked", reason: "unknown-run" });
});

test("--clear-quarantine: a clean record -> not-quarantined; --except without --yes touches nothing; a missing path -> cwd-missing", () => {
  const { wt } = worktree();
  fixture();
  cleanRecord(wtRecordPath(wt));
  let r = runCli(["--clear-quarantine", wt]);
  assert.equal(r.status, 0);
  assert.equal(r.json.reason, "not-quarantined");
  assert.equal(r.json.cleared, false);
  r = runCli(["--clear-quarantine", wt, "--except", "12,13"]);
  assert.equal(r.json.reason, "except-needs-yes");
  r = runCli(["--clear-quarantine", path.join(env.root, "gone dir")]);
  assert.equal(r.json.reason, "cwd-missing");
  r = runCli(["--clear-quarantine", wt, "--yes", "--except", "x"]);
  assert.match(r.json.reason, /^args-invalid: /);
});

test("--clear-quarantine on a quarantined worktree: the first call lists (confirm), a call with --yes and nothing to kill clears", () => {
  const { wt } = worktree();
  fixture({ full: { ok: true, rows: [] } });
  staleActive("worktree", wtRecordPath(wt), wt, { host_started: true });
  let r = runCli(["--clear-quarantine", wt]);
  assert.equal(r.json.reason, "confirm");
  assert.ok(r.json.notes.some((n) => /host-check-started/.test(n)));
  r = runCli(["--clear-quarantine", wt, "--yes"]);
  assert.equal(r.json.cleared, true, JSON.stringify(r.json));
  assert.equal(rec(wtRecordPath(wt)).state, "clean");
  assert.equal(rec(wtRecordPath(wt)).cleared_by, "user");
});

test("--setup prints the deny lines for the present targets and the ACL scan result, creating nothing else", () => {
  fixture();
  const r = runCli(["--setup"], { extraEnv: { USERPROFILE: HOME }, timeout: 280000 });
  assert.equal(r.status, 0, r.stderr);
  // per-user denies (Codex re-grants the group on every run); %TEMP%\claude (created by --setup) also denies write and delete
  assert.match(r.stdout, /icacls ".*" \/deny "CodexSandboxOffline:\(OI\)\(CI\)\(R\)" "CodexSandboxOnline:\(OI\)\(CI\)\(R\)"/);
  assert.match(r.stdout, /icacls ".*claude" \/deny "CodexSandboxOffline:\(OI\)\(CI\)\(R,W,D\)" "CodexSandboxOnline:\(OI\)\(CI\)\(R,W,D\)"/);
  assert.ok(!r.stdout.includes('"CodexSandboxUsers:'), "no group deny line");
  // the undo, as REM lines so a pasted block never removes the denies by accident
  assert.match(r.stdout, /^REM undo/m);
  assert.match(r.stdout, /^REM icacls ".*" \/remove:d CodexSandboxOffline CodexSandboxOnline$/m);
  assert.ok(r.stdout.includes(env.CLAUDE_CONFIG_DIR));
  assert.ok(r.stdout.includes(env.CODEX_HOME));
  const last = JSON.parse(r.lines.at(-1));
  assert.equal(typeof last.acl_scan.ok, "boolean");
  assert.equal(exists(path.join(HOME, ".ssh")), false);
});
