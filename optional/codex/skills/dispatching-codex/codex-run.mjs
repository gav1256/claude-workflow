#!/usr/bin/env node
// codex-run: hand one bounded task to a sandboxed `codex exec`, decide the status itself, print one JSON line.
//
//   node codex-run.mjs --brief <file> --cwd <worktree> --mode write|review|diagnose|research
//                      [--model luna|sol|astra] [--effort low|medium|high|xhigh]
//                      [--review-of <run-id> | --base <ref>] [--continue <run-id>]
//                      [--check "<cmd>"]... [--check-host "<cmd>"]... [--network]
//                      [--fix-rounds 0..3] [--timeout-min 30] [--task <id>]
//   node codex-run.mjs --verdict <run-id> approve|rework|reject "<one line>"
//   node codex-run.mjs --status
//   node codex-run.mjs --setup
//   node codex-run.mjs --clear-quarantine <worktree|slot-N> [--yes [--except <pid>[,<pid>]...]]
//
// The run sequence, the held-resources x failure-step matrix and the cleanup paths are fixed by
// docs/plans/2026-10-06-codex-dual-addendum.md (sections 6, 7 and 10), on top of spec Part 2 steps 1-7:
//   P0  nothing held: print `blocked`.
//   P1  pipes held, records untouched: release SP, WTP; print `blocked`; no ledger line.
//   P2  any guard failure after both records are `active`: ledger `blocked`, then the end routine E, print.
//   P3  normal end and every failure after the `codex exec` spawn: usage, ledger, E, print.
// E: kill and await own children, list processes (only if something was spawned), and only without orphans delete
// TMP and write both records clean; then release SP and WTP. Orphans leave both records `active` for the next run's
// quarantine path. Every run exits 0 with exactly one JSON line on stdout (notes go to stderr).
// Environment: CODEX_RUN_TIMEOUT_MS (the Codex timeout in ms, beats --timeout-min), CODEX_RUN_CHECK_TIMEOUT_MS (the
// per-check timeout in ms, default 600000) and CODEX_RUN_ID (a fixed run id) exist for the tests; the rest is in lib/.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, STATE, TESTED_VERSION, runDir, newRunId, canonPath, atomicWriteJson } from "./lib/paths.mjs";
import { MODEL_SLUGS, DEFAULT_MODEL, DEFAULT_EFFORT, execArgs } from "./lib/argv.mjs";
import { resolveCodex, codexVersion, versionAtLeast } from "./lib/binary.mjs";
import { secretScan, parseBrief, finalizeBrief, checkFeedback } from "./lib/brief.mjs";
import {
  acquireWorktree, acquireSlot, releasePipe, busySlots, writeActive, addChild, markHostStarted, markTreeFinal,
  writeClean, clearQuarantine,
} from "./lib/locks.mjs";
import { listProcs, procFindings, killTree, startTime, listerProbe, LISTER_PROBE } from "./lib/procs.mjs";
import { runReadCheck, sandboxGroupCheck, denyAclCheck, versionGate, aclScan, aclScanDue, setupLines, setupUndoLines } from "./lib/readcheck.mjs";
import { baseline, diffHash, changes, scopeCheck, fileStats, linkedPaths } from "./lib/scope.mjs";
import { sandboxCheck, hostCheck } from "./lib/checks.mjs";
import { findRollout, lastRateLimits, mapWindows, recordUsage, latestReading, quotaDecision, codexTokens } from "./lib/usage.mjs";
import { appendRun } from "./lib/ledger.mjs";
import { buildResult } from "./lib/result.mjs";
import { isLinkedWorktree, laneCheck, continueCheck } from "./lib/guards.mjs";
import { reviewInput } from "./lib/review-input.mjs";
import { statusLine } from "./lib/status.mjs";
import { verdictCmd } from "./lib/verdict.mjs";

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODES = ["write", "review", "diagnose", "research"];
const EFFORTS = ["low", "medium", "high", "xhigh"];
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const note = (s) => process.stderr.write(`codex-run: ${s}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const msg = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 160);
const iso = () => new Date().toISOString();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// a write that an antivirus scan or an open handle can fail for a moment (the record writes in locks.mjs retry the same way)
function retried(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(100);
    }
  }
}
// I1: what the sandbox (codex exec, the read check, sandbox checks, the lister probe and the version gate) may inherit.
// The host's own environment holds API keys and passwords: only these names (case-insensitive, as on Windows) pass.
// `--check-host` is the explicit opt-in to run outside the sandbox and keeps the full environment.
const ENV_NAMES = new Set([
  "systemroot", "windir", "systemdrive", "comspec", "path", "pathext", "userprofile", "homedrive", "homepath", "username",
  "userdomain", "appdata", "localappdata", "programdata", "number_of_processors", "os", "temp", "tmp", "codex_home",
]);
// No `codex_` prefix (I3): CODEX_API_KEY must not reach sandboxed checks. CODEX_HOME is listed by name above; the key goes
// into the `codex exec` spawn alone (execEnv).
const ENV_PREFIXES = ["programfiles", "commonprogramfiles", "processor_", "fake_codex_"];
// the env of the `codex exec` spawn: the allowlist plus CODEX_API_KEY when the host has it (any case, as on Windows)
function execEnv() {
  const out = childEnv();
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toLowerCase() === "codex_api_key") out[k] = v;
  return out;
}
function childEnv(base = process.env) {
  const extra = String(process.env.CODEX_RUN_ENV_ALLOW ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    const n = k.toLowerCase();
    if (v !== undefined && (ENV_NAMES.has(n) || ENV_PREFIXES.some((p) => n.startsWith(p)) || extra.includes(n))) out[k] = v;
  }
  return out;
}
const goodId = (s) => typeof s === "string" && RUN_ID_RE.test(s) && !s.includes("..");

// ------------------------------------------------------------------------------------------ command line

const OPTIONS = {
  brief: { type: "string" }, cwd: { type: "string" }, mode: { type: "string" }, model: { type: "string" },
  effort: { type: "string" }, "review-of": { type: "string" }, base: { type: "string" }, continue: { type: "string" },
  check: { type: "string", multiple: true }, "check-host": { type: "string", multiple: true }, network: { type: "boolean" },
  "fix-rounds": { type: "string" },
  "timeout-min": { type: "string" }, task: { type: "string" }, verdict: { type: "string" }, status: { type: "boolean" },
  setup: { type: "boolean" }, "clear-quarantine": { type: "string" }, yes: { type: "boolean" }, except: { type: "string" },
};

/** `{ok:true, a}` for a run, `{ok:false, reason}` otherwise. `a` carries the validated options. */
function validate(values, positionals) {
  const bad = (why) => ({ ok: false, reason: `args-invalid: ${why}` });
  if (positionals.length) return bad(`unexpected argument ${JSON.stringify(positionals[0])}`);
  if (values.yes || values.except !== undefined) return bad("--yes and --except belong to --clear-quarantine");
  for (const k of ["brief", "cwd", "mode"]) if (typeof values[k] !== "string" || values[k] === "") return bad(`--${k} is required`);
  const mode = values.mode;
  if (!MODES.includes(mode)) return bad(`--mode must be one of ${MODES.join("|")}`);
  const modelAlias = values.model ?? DEFAULT_MODEL[mode];
  if (!Object.hasOwn(MODEL_SLUGS, modelAlias)) return bad(`--model must be one of ${Object.keys(MODEL_SLUGS).join("|")}`);
  const effort = values.effort ?? DEFAULT_EFFORT[mode];
  if (!EFFORTS.includes(effort)) return bad(`--effort must be one of ${EFFORTS.join("|")}`);
  const reviewOf = values["review-of"];
  const base = values.base;
  if (mode === "review") {
    if ((reviewOf === undefined) === (base === undefined)) return bad("review needs exactly one of --review-of and --base");
  } else if (reviewOf !== undefined || base !== undefined) {
    return bad("--review-of and --base belong to review mode");
  }
  if (reviewOf !== undefined && !goodId(reviewOf)) return bad("--review-of needs a run id");
  if (base !== undefined && (base === "" || base.startsWith("-"))) return bad("--base needs a git ref");
  const continueId = values.continue;
  if (continueId !== undefined) {
    if (mode !== "write") return bad("--continue belongs to write mode");
    if (!goodId(continueId)) return bad("--continue needs a run id");
  }
  const checks = values.check ?? [];
  const hostChecks = values["check-host"] ?? [];
  if (mode !== "write" && (checks.length || hostChecks.length)) return bad("--check and --check-host belong to write mode");
  if (values["fix-rounds"] !== undefined) {
    if (!/^[0-3]$/.test(values["fix-rounds"])) return bad("--fix-rounds must be an integer 0-3");
    if (mode !== "write") return bad("--fix-rounds belongs to write mode");
  }
  let timeoutMs;
  const envMs = Number(process.env.CODEX_RUN_TIMEOUT_MS);
  if (Number.isFinite(envMs) && envMs > 0) timeoutMs = envMs;
  else {
    const min = values["timeout-min"] === undefined ? 30 : Number(values["timeout-min"]);
    if (!Number.isFinite(min) || min <= 0) return bad("--timeout-min must be a positive number");
    timeoutMs = min * 60000;
  }
  const envCheck = Number(process.env.CODEX_RUN_CHECK_TIMEOUT_MS);
  return {
    ok: true,
    a: {
      briefPath: values.brief, cwd: path.resolve(values.cwd), mode, modelAlias, effort, reviewOf, base, continueId,
      checks, hostChecks, network: !!values.network, timeoutMs, task: values.task ?? null,
      fixRounds: Number(values["fix-rounds"] ?? 0),
      checkTimeoutMs: Number.isFinite(envCheck) && envCheck > 0 ? envCheck : 600000,
    },
  };
}

// ------------------------------------------------------------------------------------------ run state and result

function makeState(runId, a) {
  return {
    runId, t0: Date.now(), a, alias: a?.modelAlias ?? null, effort: a?.effort ?? null, downgraded: false, notes: [],
    files: [], checks: [], hostChecks: false, codexNote: null, weekPct: null, orphans: [], extra: {}, threadId: null,
    eventsFile: null, spawned: 0, children: [], childList: [], status: "blocked", reason: null,
  };
}

function resultOf(S, status, reason) {
  return {
    run: S.runId, status, reason: reason ?? null, mode: S.a?.mode ?? null, model: S.alias ? MODEL_SLUGS[S.alias] : null,
    model_downgraded: S.downgraded, secs: Math.round((Date.now() - S.t0) / 1000), files: S.files, checks: S.checks,
    checks_passed: S.checks.length ? S.checks.every((c) => c.exit === 0 && !c.timeout) : null,
    host_checks: S.hostChecks, codex_note: S.codexNote, week_pct: S.weekPct, orphans: S.orphans,
    ...(S.notes.length ? { notes: S.notes } : {}), ...S.extra,
  };
}

function print(obj) {
  process.stdout.write(buildResult(obj) + "\n");
}

// ------------------------------------------------------------------------------------------ the end routine E (addendum 6)

async function killOwnChildren(S) {
  for (const c of S.children) {
    if (c.exitCode === null && c.signalCode === null) {
      killTree(c.pid);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        c.once("exit", () => { clearTimeout(t); resolve(); });
      });
    }
  }
}

async function endRoutine(C) {
  const { S } = C;
  await killOwnChildren(S);
  let orphans = [];
  if (S.spawned > 0) {
    const rec = { run_id: S.runId, owner_pid: process.pid, owner_start_time: C.ownerStart, child_pids: S.childList };
    // B3: sandbox helpers can still be exiting when the end listing is taken. One listing, then up to 3 re-lists 1.5 s apart.
    // The loop stops at the first listing with no orphans; the orphans are the findings of the LAST listing (no cross-listing
    // filter: an earlier listing that missed a process, e.g. a daemon spawned by an exiting orphan, must not hide it).
    let last = [];
    for (let i = 0; i < 4; i++) {
      const L = listProcs({ scope: "session" });
      if (!L.ok) { last = null; break; }
      last = procFindings({ rec, rows: L.rows, selfPid: process.pid, listerPid: L.listerPid, runId: S.runId, mode: "end" });
      if (last.length === 0) break;
      if (i < 3) await sleep(1500);
    }
    orphans = last === null ? ["lister-blind"] : last.map((f) => f.pid);
  }
  S.orphans = orphans;
  let clean = false;
  if (orphans.length === 0) {
    clean = true;
    try {
      fs.rmSync(C.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      note(`codex-tmp-left: ${msg(e)}`);
    }
    try { writeClean(C.slotRecord, S.runId); } catch (e) { clean = false; note(`record-clean-failed slot: ${msg(e)}`); }
    try { writeClean(C.wtRecord, S.runId); } catch (e) { clean = false; note(`record-clean-failed worktree: ${msg(e)}`); }
  } else {
    note(`orphans ${orphans.join(",")}`);
  }
  await releasePipe(C.sp);
  await releasePipe(C.wtp);
  return clean;
}

// steps 12 and 13, shared by P2 and P3
async function finish(C, out) {
  const { S, a } = C;
  if (S.threadId) {
    try {
      const file = findRollout(S.threadId, Date.now());
      const reading = file ? lastRateLimits(file) : null;
      if (reading) {
        S.weekPct = mapWindows(reading.rl).week_pct;
        recordUsage(S.runId, reading);
      } else {
        note("usage unavailable (no rollout with rate limits for this thread)");
      }
    } catch (e) {
      note(`usage-not-recorded: ${msg(e)}`);
    }
  }
  try {
    appendRun({
      ts: Date.now(), run_id: S.runId, task: a.task, mode: a.mode, model: S.alias, writer: `codex-${S.alias}`, effort: S.effort,
      status: out.status, checks_passed: S.checks.length ? S.checks.every((c) => c.exit === 0 && !c.timeout) : null, host_checks: S.hostChecks,
      secs: Math.round((Date.now() - S.t0) / 1000),
      codex_tokens: S.eventsFile && fs.existsSync(S.eventsFile) ? codexTokens(S.eventsFile) : null,
      files: S.files, week_pct: S.weekPct,
    });
  } catch (e) {
    note(`ledger-not-written: ${msg(e)}`);
  }
  let cleanEnd = false;
  try {
    cleanEnd = await endRoutine(C);
  } catch (e) {
    // the records stay as written (active); the process exit frees the pipes
    note(`end-routine-failed: ${msg(e)}`);
    await releasePipe(C.sp);
    await releasePipe(C.wtp);
  }
  // a fix round starts only after a clean end (no orphans, both records written clean)
  C.chain.shouldFix = !!S.shouldFix && cleanEnd;
  C.chain.modelAlias = S.alias;
  return resultOf(S, out.status, out.reason);
}

// ------------------------------------------------------------------------------------------ Codex

function adoptPid(C, pid) {
  const { S } = C;
  S.spawned++;
  S.childList.push({ pid, at: iso() });
  let failed = false;
  for (const f of [C.wtRecord, C.slotRecord]) {
    try { addChild(f, pid); } catch { failed = true; }
  }
  if (failed) note(`child-unrecorded:${pid}`);
}

function readThreadId(eventsFile) {
  let text;
  try { text = fs.readFileSync(eventsFile, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.includes("thread.started")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "thread.started" && typeof ev.thread_id === "string" && ev.thread_id) return ev.thread_id;
    } catch { /* not a JSON line */ }
  }
  return null;
}

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function lastJsonValid(mode, j) {
  if (!isObj(j)) return false;
  if (mode === "write") return ["done", "failed", "blocked"].includes(j.status) && typeof j.note === "string";
  // Codex's review verdict (schemas/review.json, the upstream layout) is approve|needs-attention. The controller's own
  // ledger verdict (`--verdict <run-id> approve|rework|reject`, lib/verdict.mjs) is a separate thing: keep them apart.
  if (mode === "review") return ["approve", "needs-attention"].includes(j.verdict) && Array.isArray(j.findings);
  if (mode === "diagnose") return Array.isArray(j.hypotheses);
  return typeof j.answer === "string" && Array.isArray(j.findings); // research
}

/** Spawns `codex exec`, feeds the brief, enforces the timeout. Resolves {spawnError} | {stateError} | {exit, timedOut}. */
function runCodex(C) {
  const { S, a } = C;
  return new Promise((resolve) => {
    let outFd;
    let errFd;
    try {
      outFd = fs.openSync(S.eventsFile, "w");
      errFd = fs.openSync(path.join(C.dir, "stderr.txt"), "w");
    } catch (e) {
      for (const fd of [outFd, errFd]) if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      return resolve({ stateError: msg(e) });
    }
    const args = [...(C.bin.args ?? []), ...execArgs({
      mode: a.mode, model: S.alias, effort: S.effort, cwd: a.cwd, runId: S.runId, runDirPath: C.dir, schemaPath: C.schemaPath, network: a.network,
    })];
    let child;
    try {
      child = spawn(C.bin.cmd, args, { cwd: a.cwd, env: execEnv(), windowsHide: true, stdio: ["pipe", outFd, errFd] });
    } catch (e) {
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* ignore */ }
      return resolve({ spawnError: e.code ?? msg(e) });
    }
    try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* the child has its own handles */ }
    let settled = false;
    let timedOut = false;
    let spawnErr = null;
    let timer;
    let grace;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(r);
    };
    child.on("error", (e) => { spawnErr = e.code ?? msg(e); if (child.pid === undefined) done({ spawnError: spawnErr }); });
    child.on("close", (code, signal) => {
      if (child.pid === undefined) return done({ spawnError: spawnErr ?? "spawn-failed" });
      done({ exit: code, signal, timedOut });
    });
    if (child.pid === undefined) return; // the 'error' / 'close' handlers resolve
    S.spawned++;
    S.children.push(child);
    S.childList.push({ pid: child.pid, at: iso() });
    let failed = false;
    for (const f of [C.wtRecord, C.slotRecord]) {
      try { addChild(f, child.pid); } catch { failed = true; }
    }
    if (failed) note(`child-unrecorded:${child.pid}`);
    child.stdin.on("error", () => {});
    child.stdin.end(C.briefFinal);
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      grace = setTimeout(() => done({ exit: null, signal: "timeout", timedOut: true }), 10000);
    }, a.timeoutMs);
  });
}

// ------------------------------------------------------------------------------------------ the guarded part (after 5d)

// The tree state the quarantine auto-clear compares. diffHash reads untracked files, so a link (junction, symlink,
// hard-linked file) among the changes means the host would read through it: no hash, an error, no auto-clear.
const treeState = (cwd, b) => {
  const lk = linkedPaths(cwd, changes(cwd));
  if (lk.length) return { error: "linked-path" };
  return { head: baseline(cwd), hash: diffHash(cwd, b) };
};

function readPrevMeta(runId) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(STATE, "runs", runId, "meta.json"), "utf8"));
    return isObj(m) ? m : null;
  } catch {
    return null;
  }
}

async function active(C) {
  const { S, a, bin } = C;
  const block = (reason) => ({ status: "blocked", reason });
  const cwd = a.cwd;

  // 5e
  try { writeActive(C.slotRecord, C.rec); } catch (e) { note(`slot record not written: ${msg(e)}`); return block("state-write-failed"); }

  // 6: write mode needs a clean tree, or exactly the earlier run's residue
  let owned = C.owned;
  if (a.mode === "write") {
    if (a.continueId) {
      const prev = readPrevMeta(a.continueId);
      const cc = continueCheck(prev, cwd);
      if (!cc.ok) return block(cc.reason);
      if (!Array.isArray(prev.owned) || prev.owned.length === 0 || !prev.owned.every((g) => typeof g === "string")) {
        return block("continue-mismatch: that run recorded no owned paths");
      }
      owned = prev.owned; // the baseline and the owned paths carry over; scope stays cumulative
    } else {
      let list;
      try { list = changes(cwd); } catch { return block("git-failed"); }
      if (list.length) {
        const shown = list.slice(0, 5).map((c) => c.path).join(", ");
        return block(`dirty: ${shown}${list.length > 5 ? ` (+${list.length - 5} more)` : ""}`);
      }
    }
  }

  // 7: quota (a block costs no version gate and no ACL scan)
  let reading = null;
  try { reading = latestReading(Date.now()); } catch { /* none */ }
  let busy = 0;
  try { busy = await busySlots(); } catch { /* count none */ }
  const qd = quotaDecision({ reading, now: Date.now(), busySlots: busy, mode: a.mode, model: S.alias });
  if (reading) S.weekPct = mapWindows(reading.rl).week_pct;
  for (const n of qd.notes) S.notes.push(n);
  if (qd.action === "block") return block(qd.reason);
  if (qd.action === "downgrade") { S.alias = "luna"; S.downgraded = true; }

  // 8: version, the lister probe and the new-version gate, the ACL scan when due
  let version;
  try { version = codexVersion(bin); } catch (e) { return block(`codex-version-unreadable: ${msg(e)}`); }
  if (!versionAtLeast(version)) return block(`codex-version-old: ${version}`);
  let tested = null;
  try { tested = fs.readFileSync(TESTED_VERSION, "utf8").trim(); } catch { /* never tested */ }
  // I3: the lister probe (8a) also runs when its own record is missing, not ok or for another version; A4b must never
  // run on an unverified lister. The version gate (8b) stays tied to TESTED_VERSION.
  let probed = false;
  try {
    const p = JSON.parse(fs.readFileSync(LISTER_PROBE, "utf8"));
    probed = isObj(p) && p.ok === true && p.version === version;
  } catch { /* no record */ }
  if (tested !== version || !probed) {
    const probe = await listerProbe({
      bin, cwd, runId: S.runId, env: childEnv(),
      onSpawn: (child) => {
        S.spawned++;
        S.children.push(child);
        S.childList.push({ pid: child.pid, at: iso() });
        let failed = false;
        for (const f of [C.wtRecord, C.slotRecord]) {
          try { addChild(f, child.pid); } catch { failed = true; }
        }
        if (failed) note(`child-unrecorded:${child.pid}`);
      },
    });
    if (!probe.ok) return block(`codex-version-untested: ${probe.reason}`);
    try {
      atomicWriteJson(LISTER_PROBE, { version, ok: true, at: iso() }); // retries inside
    } catch (e) {
      note(`lister-probe-not-recorded: ${msg(e)}`);
    }
  }
  if (tested !== version) {
    S.spawned++; // versionGate spawns without an onPid hook: counted here, never recorded (addendum F5)
    const gate = await versionGate({ bin, cwd, runId: S.runId, env: childEnv() });
    if (!gate.ok) return block(`codex-version-untested: ${gate.detail ?? gate.reason}`);
  }
  if (aclScanDue(Date.now())) {
    let scan;
    try { scan = await aclScan(); } catch (e) { return block(`acl-scan-failed: ${msg(e)}`); }
    if (!scan.ok) {
      if (scan.error) return block(`acl-scan-failed: ${scan.error}`);
      return block(`acl-missing: ${scan.missing.slice(0, 5).join(", ")}${scan.missing.length > 5 ? ` (+${scan.missing.length - 5} more)` : ""}`);
    }
  }

  // 9: the read boundary: the per-user deny ACLs on the host (Codex strips a group deny on every run), both sandbox users
  // in CodexSandboxUsers (I2: the read check itself runs as the offline user), then the check
  const dn = await denyAclCheck();
  if (!dn.ok) return block(dn.reason);
  const grp = await sandboxGroupCheck();
  if (!grp.ok) return block(grp.reason);
  S.spawned++; // runReadCheck has no onPid hook either
  const rc = await runReadCheck({ bin, cwd, runId: S.runId, env: childEnv() });
  if (!rc.ok) return block(rc.reason);

  // 10: review input, the brief, meta.json, then Codex
  if (a.mode === "research") {
    try { fs.mkdirSync(path.join(C.runTmp, "research"), { recursive: true }); } catch { return block("state-write-failed"); }
  }
  const meta = {
    run_id: S.runId, cwd: C.rec.cwd, mode: a.mode, baseline: C.rec.baseline, owned, task: a.task, model: S.alias, effort: S.effort,
    ...(a.continueId ? { continued_from: a.continueId } : {}),
  };
  if (a.mode === "review") {
    let ri;
    try {
      ri = await reviewInput({ cwd, runId: S.runId, reviewOf: a.reviewOf, base: a.base });
    } catch (e) {
      return block(`review-input-failed: ${msg(e)}`);
    }
    if (!ri || !ri.ok) return block(ri?.reason ?? "review-input-failed");
    S.extra.patch_sha256 = ri.sha256;
    meta.patch_sha256 = ri.sha256;
  }
  let agentsText = "";
  try { agentsText = fs.readFileSync(path.join(CFG, "AGENTS.md"), "utf8"); } catch { /* the fallback rules apply */ }
  const fb = finalizeBrief(C.briefText, agentsText);
  if (fb.workerRules === "fallback") S.notes.push("worker-rules: fallback");
  const hits = secretScan(fb.text);
  if (hits.length) return block(`secret-in-brief: ${hits.join(", ")}`);
  C.briefFinal = fb.text;
  try {
    retried(() => fs.writeFileSync(path.join(C.dir, "brief.md"), fb.text));
    atomicWriteJson(path.join(C.dir, "meta.json"), meta);
  } catch (e) {
    note(`brief.md / meta.json not written: ${msg(e)}`);
    return block("state-write-failed");
  }
  S.eventsFile = path.join(C.dir, "events.jsonl");
  const cx = await runCodex(C);
  if (cx.stateError) { note(`events file: ${cx.stateError}`); return block("state-write-failed"); }
  if (cx.spawnError) return { status: "failed", reason: `codex-spawn: ${cx.spawnError}` };

  // outcome: a blocked reason beats a failed one; the first of each kind wins
  const O = { blocked: null, failed: null };
  let guardFailed = false;
  const setBlocked = (r) => { if (!O.blocked) O.blocked = r; };
  const setFailed = (r, check = false) => { if (!check) guardFailed = true; if (!O.failed) O.failed = r; };
  S.threadId = readThreadId(S.eventsFile);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(C.dir, "last.json"), "utf8")); } catch { /* missing or invalid */ }
  const lastOk = lastJsonValid(a.mode, last);
  if (lastOk && typeof last.note === "string") S.codexNote = last.note;
  let codexOk = false;
  let codexOutcome = null;
  if (cx.timedOut) setBlocked("timeout");
  else if (cx.exit !== 0) setFailed(`codex-exit: ${cx.exit ?? cx.signal}`);
  else if (!S.threadId) setFailed("codex-no-thread");
  else if (!lastOk) setFailed("codex-last-json-invalid");
  else {
    codexOk = true; // a valid blocked/failed report still permits checks; transport/schema failures do not
    if (a.mode === "write") {
      S.extra.codex_status = last.status;
      if (last.status !== "done") codexOutcome = { status: last.status, reason: `codex-${last.status}: ${last.note.slice(0, 100)}` };
    }
  }
  if (lastOk && a.mode !== "write") {
    for (const k of ["verdict", "summary", "findings", "hypotheses", "answer"]) if (last[k] !== undefined) S.extra[k] = last[k];
  }

  // 11: write mode: scope, checks, cleanup, final scope, hash and stats
  if (a.mode === "write") {
    const showPaths = (out) => `${out.slice(0, 8).join(", ")}${out.length > 8 ? ` (+${out.length - 8} more)` : ""}`;
    // C1: before any check writes into .codex-tmp (host and sandbox checks both do), neither it nor the run folder may be a
    // junction or symlink (a missing one is fine: a check recreates it)
    const tmpLinked = [C.tmp, C.runTmp].some((p) => {
      try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return e.code !== "ENOENT"; }
    });
    if (tmpLinked) setBlocked("linked-path: .codex-tmp");
    let scopeOk = false;
    try {
      const list = changes(cwd);
      const lk = linkedPaths(cwd, list);
      if (lk.length) setBlocked(`linked-path: ${showPaths(lk)}`);
      const sc = scopeCheck(list, owned);
      scopeOk = sc.ok && !tmpLinked && lk.length === 0;
      if (!sc.ok) setBlocked(`out-of-scope: ${showPaths(sc.out)}`);
    } catch { setFailed("git-failed"); }
    if (scopeOk && codexOk) {
      let n = 0;
      const timeoutMs = a.checkTimeoutMs;
      for (const cmd of a.checks) {
        n++;
        let r;
        try {
          r = await sandboxCheck({ bin, cwd, runId: S.runId, n, cmd, timeoutMs, env: childEnv(), onPid: (pid) => adoptPid(C, pid) });
        } catch (e) { // I2: a link where the host writes the check file
          if (e.code !== "ELINKED") throw e;
          setBlocked("linked-path: .codex-tmp check file");
          break;
        }
        S.checks.push(r);
        if (r.timeout) setFailed(`check-timeout: ${cmd.slice(0, 60)}`, true);
        else if (r.exit !== 0) setFailed(`check-failed: ${cmd.slice(0, 60)}`, true);
      }
      if (a.hostChecks.length && !O.failed && !O.blocked) {
        let marked = true;
        try {
          markHostStarted(C.wtRecord); // BEFORE the first --check-host spawn
          markHostStarted(C.slotRecord);
        } catch (e) {
          marked = false;
          note(`host_started not recorded: ${msg(e)}`);
          setFailed("state-write-failed");
        }
        if (marked) {
          S.hostChecks = true;
          for (const cmd of a.hostChecks) {
            n++;
            let r;
            try {
              r = await hostCheck({ cwd, runId: S.runId, n, cmd, timeoutMs, onPid: (pid) => adoptPid(C, pid) });
            } catch (e) { // I2: a link or a pre-existing file where the host writes the check file (the host-only run folder)
              if (e.code !== "ELINKED") throw e;
              setBlocked("linked-path: host check file");
              break;
            }
            S.checks.push(r);
            if (r.timeout) setFailed(`check-timeout: ${cmd.slice(0, 60)}`, true);
            else if (r.exit !== 0) setFailed(`check-failed: ${cmd.slice(0, 60)}`, true);
          }
        }
      }
    }
    await killOwnChildren(S); // process cleanup before the final scan
    try {
      const list = changes(cwd);
      const sc = scopeCheck(list, owned);
      if (!sc.ok) setBlocked(`out-of-scope: ${showPaths(sc.out)}`);
      const lk = linkedPaths(cwd, list);
      if (lk.length) {
        // C1: never hash, count or record through a link: the host would read what the link points at
        setBlocked(`linked-path: ${showPaths(lk)}`);
        S.files = [];
      } else {
        const hash = diffHash(cwd, C.rec.baseline);
        for (const f of [C.wtRecord, C.slotRecord]) {
          try { markTreeFinal(f, hash); } catch (e) { note(`tree-final-unrecorded: ${msg(e)}`); }
        }
        try { S.files = fileStats(cwd, C.rec.baseline, list); } catch (e) { note(`file stats failed: ${msg(e)}`); }
        try { atomicWriteJson(path.join(C.dir, "meta.json"), { ...meta, diff_hash: hash, files: S.files }); } catch (e) { note(`meta.json not updated: ${msg(e)}`); }
      }
    } catch (e) {
      note(`final scan failed: ${msg(e)}`);
      setFailed("git-failed");
    }
  }
  // A check failure permits a continuation even when Codex reported blocked/failed; a guard failure ends the chain.
  S.shouldFix = !O.blocked && !guardFailed && S.checks.some((c) => c.timeout || c.exit !== 0);
  if (O.blocked) return block(O.blocked);
  if (guardFailed) return { status: "failed", reason: O.failed };
  if (codexOutcome) return codexOutcome;
  if (O.failed) return { status: "failed", reason: O.failed };
  return { status: "done", reason: null };
}

// ------------------------------------------------------------------------------------------ the run (steps 1-5, then active())

async function run(values, positionals, chain) {
  const pinned = process.env.CODEX_RUN_ID; // a test knob: a fixed run id
  const runId = chain.runId ?? (goodId(pinned) ? pinned : newRunId());
  chain.shouldFix = false;
  const v = validate(values, positionals);
  if (!v.ok) {
    return resultOf(makeState(runId, null), "blocked", v.reason);
  }
  const a = v.a;
  chain.fixRounds = a.fixRounds;
  const S = makeState(runId, a);
  const P0 = (reason) => resultOf(S, "blocked", reason);

  // 1: brief, secret scan, brief shape, schema, binary
  let briefText;
  try { briefText = chain.originalBrief ?? fs.readFileSync(a.briefPath, "utf8"); } catch { return P0("brief-invalid: unreadable"); }
  chain.originalBrief = briefText; // every continuation uses the original brief, never accumulated feedback
  const pb = parseBrief(briefText, a.mode); // the 80-line cap applies to the caller's brief, not generated output
  briefText += chain.feedback ?? "";
  const hits = secretScan(briefText);
  if (hits.length) return P0(`secret-in-brief: ${hits.join(", ")}`);
  if (!pb.ok) return P0(pb.reason);
  const schemaPath = path.join(SKILL_DIR, "schemas", `${a.mode}.json`);
  if (!fs.existsSync(schemaPath)) return P0(`schema-missing: ${a.mode}`);
  let bin;
  try { bin = resolveCodex(); } catch (e) { return P0(`codex-not-found: ${msg(e)}`); }

  // 2: a linked worktree, the lane rule (a missing --cwd is cwd-missing, before any pipe)
  let isDir = false;
  try { isDir = fs.statSync(a.cwd).isDirectory(); } catch { /* missing */ }
  if (!isDir) return P0("cwd-missing");
  if (!isLinkedWorktree(a.cwd)) return P0("not-a-linked-worktree");
  const lane = laneCheck(a.cwd);
  if (!lane.ok) return P0(lane.reason);
  if (lane.note) S.notes.push(lane.note);

  // 3: the worktree pipe first (quarantine is decided inside)
  const w = await acquireWorktree(a.cwd, { treeState, bin });
  if (w.blocked) return P0(w.blocked);
  if (w.busy) return P0("worktree-busy");
  if (w.quarantined) return P0(`worktree-quarantined: ${w.found.join(", ")}`);
  const wtp = w.server;
  let sp = null;
  let activated = false;
  let C;
  try {
    // 4: a slot pipe
    const s = await acquireSlot({ bin });
    if (!s.server) {
      await releasePipe(wtp);
      const q = s.quarantined?.length
        ? `: quarantined ${s.quarantined.map((x) => `slot-${x.n} (${x.found.join(",")})`).join(", ")}` : "";
      return P0(`codex-slots-full${q}`);
    }
    sp = s.server;
    const P1 = async (reason) => {
      await releasePipe(sp);
      await releasePipe(wtp);
      return P0(reason);
    };
    // 5: TMP, baseline and tree hash, owner start time, the first records
    const tmp = path.join(a.cwd, ".codex-tmp");
    const runTmp = path.join(tmp, runId);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { return await P1("codex-tmp-locked"); }
    try { fs.mkdirSync(runTmp, { recursive: true }); } catch { return await P1("codex-tmp-locked"); }
    let base;
    let pre;
    // C1: diffHash reads untracked files; a link among the changes (junction, symlink, hard link) would be read through
    let linked = [];
    try {
      base = baseline(a.cwd);
      linked = linkedPaths(a.cwd, changes(a.cwd));
      if (!linked.length) pre = diffHash(a.cwd, base);
    } catch { return await P1("git-failed"); }
    if (linked.length) return await P1(`linked-path: ${linked.slice(0, 8).join(", ")}${linked.length > 8 ? ` (+${linked.length - 8} more)` : ""}`);
    const ownerStart = startTime(process.pid);
    if (ownerStart === null) return await P1("procs-unavailable");
    let dir;
    let canon;
    try { dir = runDir(runId); canon = canonPath(a.cwd); } catch { return await P1("state-write-failed"); }
    const rec = {
      cwd: canon, run_id: runId, run_dir: dir, owner_pid: process.pid, owner_start_time: ownerStart, child_pids: [],
      host_started: false, baseline: base, tree_hash_pre: pre, tree_hash_final: null,
    };
    try { writeActive(w.recordPath, rec); } catch (e) { note(`worktree record not written: ${msg(e)}`); return await P1("state-write-failed"); }
    activated = true;
    C = {
      S, a, bin, schemaPath, tmp, runTmp, dir, rec, ownerStart, owned: pb.owned, briefText, briefFinal: null, chain,
      wtp, sp, wtRecord: w.recordPath, slotRecord: s.recordPath,
    };
  } catch (e) {
    if (!activated) {
      await releasePipe(sp);
      await releasePipe(wtp);
      return P0(`internal: ${msg(e)}`);
    }
    throw e;
  }
  // from here on: P2 (a guard failure) or P3 (after the spawn) both end in finish()
  let out;
  try {
    out = await active(C);
  } catch (e) {
    out = { status: "failed", reason: `internal: ${msg(e)}` };
  }
  return finish(C, out);
}

// Fix rounds release every resource and record usage/ledger before entering the normal --continue path again.
// Keep full check tails until feedback is built; buildResult caps only the final stdout line.
async function runChain(values, positionals) {
  const chain = {};
  const ids = [];
  let current = values;
  let result;
  for (let round = 0; ; round++) {
    try {
      if (round > 0) {
        chain.runId = `${result.run}-fix-${round}`; // identify the failed round even if ID generation throws
        chain.runId = newRunId(); // CODEX_RUN_ID pins only the first run, never a continuation
        chain.feedback = checkFeedback(result.checks);
        current = { ...values, continue: result.run, model: chain.modelAlias };
      }
      result = await run(current, positionals, chain);
    } catch (e) {
      if (!result) throw e; // round 0: main()'s handler prints the plain internal block
      result = { ...result, run: chain.runId, status: "failed", reason: `internal: ${msg(e)}`, checks: [], files: [] };
      ids.push(chain.runId);
      break;
    }
    ids.push(result.run);
    if (!chain.shouldFix || round >= chain.fixRounds) break;
  }
  print({ ...result, rounds: ids.length - 1, run_chain: ids });
}

// ------------------------------------------------------------------------------------------ other commands

const blankClear = (target, reason) => ({
  clear_quarantine: target, run: null, listed: [], notes: [], killed: [], new_candidates: [], excepted: [], survivors: [],
  cleared: false, reason,
});

async function clearCommand(values) {
  const target = values["clear-quarantine"];
  let except = [];
  if (values.except !== undefined) {
    const parts = values.except.split(",").map((s) => s.trim());
    if (parts.some((p) => !/^[1-9]\d*$/.test(p))) {
      process.stdout.write(JSON.stringify(blankClear(target, "args-invalid: --except takes process ids, comma separated")) + "\n");
      return;
    }
    except = parts.map(Number);
  }
  const res = await clearQuarantine(target, { yes: !!values.yes, except, treeState });
  process.stdout.write(JSON.stringify(res) + "\n");
}

async function setupCommand() {
  for (const line of setupLines()) process.stdout.write(line + "\n");
  // the undo, as REM lines: pasting the whole block must never remove the denies
  process.stdout.write("REM undo (removes the per-user denies again; run only on purpose):\n");
  for (const line of setupUndoLines()) process.stdout.write(`REM ${line}\n`);
  note("ACL scan of the protected folders (ACLs only; it can take minutes)");
  const scan = await aclScan();
  process.stdout.write(JSON.stringify({ acl_scan: { ok: scan.ok, missing: scan.missing, error: scan.error ?? null } }) + "\n");
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    const runId = newRunId();
    print(resultOf(makeState(runId, null), "blocked", `args-invalid: ${msg(e)}`));
    return;
  }
  const { values, positionals } = parsed;
  if (values.status) { process.stdout.write(statusLine() + "\n"); return; }
  if (values.setup) return setupCommand();
  if (values["clear-quarantine"] !== undefined) return clearCommand(values);
  if (values.verdict !== undefined) { process.stdout.write(JSON.stringify(verdictCmd(argv)) + "\n"); return; }
  return runChain(values, positionals);
}

main(process.argv.slice(2)).then(
  () => process.stdout.write("", () => process.exit(0)),
  (e) => {
    try {
      process.stdout.write(buildResult({ run: null, status: "blocked", reason: `internal: ${msg(e)}`, orphans: [] }) + "\n", () => process.exit(0));
    } catch {
      process.exit(1);
    }
  },
);
