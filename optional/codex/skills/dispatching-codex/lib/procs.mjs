// Process listing and the process rules of the quarantine / end-of-run checks (addendum sections 2, 3, 8.1).
// The lister is one PowerShell spawn: CIM Win32_Process (pid, ppid, name, cmd, session, start) plus
// `tasklist /V` (the only source of the sandbox user's owner column without elevation).
// CODEX_RUN_PROCS (a JSON fixture, re-read on every call) replaces the lister in tests.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { STATE } from "./paths.mjs";
import { sandboxArgs, cmdFileText } from "./argv.mjs";
import { codexVersion } from "./binary.mjs";

/** {version, ok, at}: written once per Codex version after a passing lister probe. */
export const LISTER_PROBE = path.join(STATE, "lister-probe.json");

const SYSROOT = () => process.env.SystemRoot || "C:\\Windows";
const PS = () => path.join(SYSROOT(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const TASKKILL = () => path.join(SYSROOT(), "System32", "taskkill.exe");
const SANDBOX_USER_RE = /(^|\\)CodexSandbox[A-Za-z0-9_-]*$/i;
const FIXTURE_DEFAULT_START = "2026-01-01T00:00:00.0000000Z";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `Date.parse` of an ISO string; null and NaN are null. */
const ms = (x) => {
  if (x === null || x === undefined) return null;
  const n = Date.parse(x);
  return Number.isFinite(n) ? n : null;
};

// ------------------------------------------------------------------------------- the PowerShell lister

// mode: "session" (tasklist limited to the lister's session), "full" (all sessions) or "cim" (no tasklist:
// the overlay fixture). String.raw: a plain template literal would turn `\tasklist` into a tab.
function listerScript(mode) {
  return String.raw`$scope = '${mode}'
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$s = (Get-Process -Id $PID).SessionId
$cim = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,SessionId,CreationDate |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name;
    cmd = $_.CommandLine; session = $_.SessionId;
    start = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } })
$tl = @(); $code = 0
if ($scope -ne 'cim') {
  $tlArgs = @('/V','/FO','CSV','/NH')
  if ($scope -eq 'session') { $tlArgs += @('/FI', "SESSION eq $s") }
  $tl = & (Join-Path $env:SystemRoot 'System32\tasklist.exe') @tlArgs
  $code = $LASTEXITCODE
}
[pscustomobject]@{ session = $s; tlExit = $code; cim = $cim; tasklist = ($tl -join [char]10) } | ConvertTo-Json -Compress -Depth 4`;
}

function runPs(script, timeout) {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(PS(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024,
  });
}

function realListing(mode, scope) {
  const r = runPs(listerScript(mode), scope === "full" ? 120000 : 60000);
  if (r.error) return { ok: false, error: r.error.code === "ETIMEDOUT" ? "lister-timeout" : "lister-spawn" };
  return { ...parseListing(r.stdout ?? "", scope, mode === "cim" ? { listerPid: r.pid } : { selfPid: process.pid, listerPid: r.pid }), };
}

const normRow = (r) => ({
  pid: r.pid, ppid: r.ppid ?? null, name: r.name ?? "", user: r.user ?? null, cmd: r.cmd ?? null,
  session: r.session ?? null, start: r.start ?? null,
});

/**
 * Pure parse of the lister's JSON (section 2.3). `selfPid` given: positivity check (the row of this
 * process must carry an owner). Failure: `{ok:false, error}`.
 */
export function parseListing(stdout, scope, { selfPid, listerPid } = {}) {
  let j;
  try { j = JSON.parse(String(stdout).replace(/^\uFEFF/, "")); } catch { return { ok: false, error: "lister-output" }; }
  if (!j || typeof j !== "object") return { ok: false, error: "lister-output" };
  if (j.tlExit !== 0) return { ok: false, error: `tasklist-exit-${j.tlExit}` };
  const cim = Array.isArray(j.cim) ? j.cim : j.cim ? [j.cim] : [];
  const tl = new Map(); // pid -> {name, user, session}
  for (const raw of String(j.tasklist ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("INFO:")) continue;
    const f = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (f.length !== 9) return { ok: false, error: "tasklist-parse" };
    const pid = Number(f[1]);
    if (!Number.isInteger(pid)) return { ok: false, error: "tasklist-parse" };
    tl.set(pid, { name: f[0], user: f[6].includes("\\") ? f[6] : null, session: Number(f[3]) });
  }
  const rows = [];
  const seen = new Set();
  for (const c of cim) {
    const t = tl.get(c.pid);
    const user = t && String(t.name).toLowerCase() === String(c.name).toLowerCase() ? t.user : null;
    rows.push({
      pid: c.pid, ppid: c.ppid ?? null, name: String(c.name ?? ""), user, cmd: c.cmd ?? null,
      session: c.session ?? null, start: ms(c.start) === null ? null : c.start,
    });
    seen.add(c.pid);
  }
  for (const [pid, t] of tl) {
    if (!seen.has(pid)) rows.push({ pid, ppid: null, name: t.name, user: t.user, cmd: null, session: t.session, start: null });
  }
  if (selfPid !== undefined && selfPid !== null) {
    const self = rows.find((r) => r.pid === selfPid);
    if (!self || self.user === null) return { ok: false, error: "self-not-visible" };
  }
  return { ok: true, scope, session: j.session, rows, listerPid };
}

// ------------------------------------------------------------------------------- fixtures

function loadFixture() {
  const f = process.env.CODEX_RUN_PROCS;
  if (!f) return null;
  try {
    const fx = JSON.parse(fs.readFileSync(f, "utf8"));
    return fx && typeof fx === "object" ? { ...fx, __file: f } : { __file: f, __bad: true };
  } catch {
    return { __file: f, __bad: true };
  }
}
function fxLog(fx, line) {
  if (fx && typeof fx.log === "string") {
    try { fs.appendFileSync(fx.log, line + "\n"); } catch { /* the log is a test aid */ }
  }
}

let cache = null; // { scope, at, listing }
const counters = new Map();

/** Test hook: forget the module-level listing cache and the fixture array positions. */
export function resetListCache() {
  cache = null;
  counters.clear();
}

function staticListing(fx, scope) {
  if (fx.__bad) return { ok: false, scope, error: "fixture: unreadable" };
  let l = fx[scope];
  if (l === undefined) return { ok: false, scope, error: `fixture: no ${scope}` };
  if (Array.isArray(l)) {
    const key = `${fx.__file}|${scope}`;
    const i = counters.get(key) ?? 0;
    counters.set(key, i + 1);
    l = l[Math.min(i, l.length - 1)];
  }
  if (!l || l.ok !== true) return { ok: false, scope, error: String(l?.error ?? "fixture: bad listing") };
  const rows = (l.rows ?? []).map(normRow);
  const self = rows.find((r) => r.pid === process.pid);
  return { ok: true, scope, session: self?.session ?? 1, rows };
}

function overlayListing(fx, scope) {
  const base = realListing("cim", scope);
  if (!base.ok) return { ...base, scope };
  const users = Array.isArray(fx.overlay.users) ? fx.overlay.users : [];
  const def = fx.overlay.default_user ?? null;
  let rows = base.rows.map((r) => {
    const hit = users.find((u) =>
      (u.pid === undefined || u.pid === r.pid) &&
      (u.cmd === undefined || String(r.cmd ?? "").toLowerCase().includes(String(u.cmd).toLowerCase())) &&
      (u.name === undefined || String(u.name).toLowerCase() === r.name.toLowerCase()));
    return { ...r, user: hit ? hit.user : def };
  });
  if (scope === "session") rows = rows.filter((r) => r.session === base.session);
  return { ok: true, scope, session: base.session, rows, listerPid: base.listerPid };
}

/**
 * `{ok, scope, session, rows, listerPid?, error?}`. `maxAgeMs > 0` reuses a cached listing (ok or not) of the same
 * or the wider scope that is younger than that. Scope "session" is about 4 s, "full" about 30 s.
 */
export function listProcs({ scope = "session", maxAgeMs = 0 } = {}) {
  if (scope !== "session" && scope !== "full") throw new TypeError(`listProcs: unknown scope ${JSON.stringify(scope)}`);
  if (maxAgeMs > 0 && cache && (cache.scope === "full" || cache.scope === scope) && Date.now() - cache.at < maxAgeMs) {
    return cache.listing;
  }
  const fx = loadFixture();
  let listing;
  if (fx) {
    fxLog(fx, `list:${scope}`);
    listing = fx.overlay && !fx.__bad ? overlayListing(fx, scope) : staticListing(fx, scope);
  } else {
    listing = { ...realListing(scope, scope), scope };
  }
  cache = { scope, at: Date.now(), listing };
  return listing;
}

// ------------------------------------------------------------------------------- start time, kill

/** CIM CreationDate of a live pid ('o' UTC, 7 fraction digits) or null. `pid` must be a positive integer. */
export function startTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`startTime: pid must be a positive integer, got ${String(pid)}`);
  const fx = loadFixture();
  if (fx) {
    fxLog(fx, `start:${pid}`);
    if (!fx.overlay || fx.__bad) {
      const t = fx.startTimes ?? {};
      return t[pid] ?? t["*"] ?? FIXTURE_DEFAULT_START;
    }
  }
  const script = `$ProgressPreference='SilentlyContinue'; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -Property CreationDate; ` +
    "if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') }";
  const r = runPs(script, 30000);
  if (r.error || r.status !== 0) return null;
  const out = String(r.stdout ?? "").trim();
  return out === "" ? null : out;
}

/** `taskkill /T /F /PID`; "not found" (exit 128) counts as ok. */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`killTree: pid must be a positive integer, got ${String(pid)}`);
  const r = spawnSync(TASKKILL(), ["/T", "/F", "/PID", String(pid)], { windowsHide: true, encoding: "utf8", timeout: 30000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim();
  return { ok: !r.error && (r.status === 0 || r.status === 128), out };
}

// ------------------------------------------------------------------------------- rules

/** The owner is a Codex sandbox user, or (owner unknown) the row is the sandbox command runner. */
export function isSandboxed(row) {
  if (typeof row.user === "string" && SANDBOX_USER_RE.test(row.user)) return true;
  return row.user === null && /^codex-command-runner/i.test(String(row.name ?? ""));
}

/**
 * Processes that belong to a run (section 3.3). `rec` null (no usable record): rules 1 and 2 only.
 * `mode:"quarantine"` (a dead run's record) or `"end"` (this run, at its end).
 * Returns `[{pid, why, text}]`, one entry per pid, `text = "<why>:<pid>:<name>"`.
 */
export function procFindings({ rec, rows, selfPid, listerPid, runId, mode }) {
  const list = Array.isArray(rows) ? rows : [];
  const byPid = new Map(list.map((r) => [r.pid, r]));
  const excluded = new Set();
  // the self chain: this process and its ancestors (a parent that started later is a reused pid)
  const selfRow = byPid.get(selfPid);
  if (selfRow) {
    excluded.add(selfRow.pid);
    for (let cur = selfRow; ;) {
      const parent = cur.ppid === null || cur.ppid === undefined ? undefined : byPid.get(cur.ppid);
      if (!parent || excluded.has(parent.pid)) break;
      const cs = ms(cur.start);
      const ps = ms(parent.start);
      if (cs === null || ps === null || ps > cs) break;
      excluded.add(parent.pid);
      cur = parent;
    }
  }
  // the lister subtree
  if (listerPid !== undefined && listerPid !== null) {
    const subtree = new Set([listerPid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const r of list) {
        if (!subtree.has(r.pid) && r.ppid !== null && r.ppid !== undefined && subtree.has(r.ppid)) {
          subtree.add(r.pid);
          changed = true;
        }
      }
    }
    for (const p of subtree) excluded.add(p);
  }
  const cands = list.filter((r) => !excluded.has(r.pid));
  const O = rec ? ms(rec.owner_start_time) : null;
  const children = rec && Array.isArray(rec.child_pids) ? rec.child_pids : [];
  const runLower = typeof runId === "string" && runId !== "" ? runId.toLowerCase() : null;
  const counted = new Map(); // pid -> why
  for (const row of cands) {
    const rs = ms(row.start);
    let why = null;
    if (isSandboxed(row) && (mode !== "end" || rs === null || O === null || rs >= O)) why = "sandbox-user";
    else if (runLower && typeof row.cmd === "string" && row.cmd.toLowerCase().includes(runLower)) why = "tagged";
    else if (rec && mode === "quarantine" && row.pid === rec.owner_pid && row.start === rec.owner_start_time) why = "owner-alive";
    else if (rec && children.some((c) => {
      if (row.pid !== c.pid) return false;
      if (rs === null) return true;
      const at = ms(c.at);
      return (O === null || rs >= O) && (at === null || rs <= at + 5000);
    })) why = "child-alive";
    if (why) counted.set(row.pid, why);
  }
  if (rec) {
    const recorded = new Set(children.map((c) => c.pid));
    if (mode === "quarantine") recorded.add(rec.owner_pid);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of cands) {
        if (counted.has(row.pid) || row.ppid === null || row.ppid === undefined) continue;
        const rs = ms(row.start);
        let hit = recorded.has(row.ppid) && (rs === null || O === null || rs >= O);
        if (!hit && counted.has(row.ppid)) {
          const ps = ms(byPid.get(row.ppid)?.start);
          hit = rs === null || ps === null || rs >= ps;
        }
        if (hit) {
          counted.set(row.pid, "descendant");
          changed = true;
        }
      }
    }
  }
  return cands.filter((r) => counted.has(r.pid)).map((r) => ({
    pid: r.pid, why: counted.get(r.pid), text: `${counted.get(r.pid)}:${r.pid}:${r.name}`,
  }));
}

// ------------------------------------------------------------------------------- the lister probe

/** `{ok:true}` when the probe file says ok for this Codex version; else `{ok:false, why:"lister-unverified"}`. */
export function listerVerified(bin) {
  try {
    const p = JSON.parse(fs.readFileSync(LISTER_PROBE, "utf8"));
    if (p && p.ok === true && typeof p.version === "string" && p.version === codexVersion(bin)) return { ok: true };
  } catch { /* unreadable, invalid or a broken binary */ }
  return { ok: false, why: "lister-unverified" };
}

const userSandboxed = (r) => typeof r.user === "string" && SANDBOX_USER_RE.test(r.user);

// Is `row` a descendant of `rootPid`? Every step along the ppid chain needs known start times, child >= parent.
function underPid(row, rootPid, byPid) {
  let cur = row;
  for (let depth = 0; depth < 64; depth++) {
    const parent = cur.ppid === null || cur.ppid === undefined ? undefined : byPid.get(cur.ppid);
    if (!parent) return false;
    const cs = ms(cur.start);
    const ps = ms(parent.start);
    if (cs === null || ps === null || cs < ps) return false;
    if (parent.pid === rootPid) return true;
    cur = parent;
  }
  return false;
}

/**
 * Per Codex version: run a sandboxed PING, list the full scope and require a sandbox-user row under it, and no
 * sandbox-user row outside the lister's session (section 2.6). Kills what it started.
 * `onSpawn(child)` is called right after the spawn (the caller records the pid).
 */
export async function listerProbe({ bin, cwd, runId, onSpawn }) {
  let child;
  try {
    const dir = path.join(cwd, ".codex-tmp", runId);
    fs.mkdirSync(dir, { recursive: true });
    const cmdFile = path.join(dir, "lprobe.cmd");
    fs.writeFileSync(cmdFile, cmdFileText("C:\\Windows\\System32\\PING.EXE -n 60 127.0.0.1 >nul"));
    child = spawn(bin.cmd, [...(bin.args ?? []), ...sandboxArgs({ profile: ":read-only", cwd, cmdFile })], {
      windowsHide: true, stdio: "ignore",
    });
  } catch (e) {
    return { ok: false, reason: `lister-blind: probe spawn failed: ${e.code ?? e.message}` };
  }
  child.on("error", () => {});
  if (child.pid === undefined) return { ok: false, reason: "lister-blind: probe spawn failed" };
  try {
    if (onSpawn) onSpawn(child);
    await sleep(2000);
    const L = listProcs({ scope: "full" });
    if (!L.ok) return { ok: false, reason: `lister-blind: ${L.error}` };
    const sandboxed = L.rows.filter(userSandboxed);
    if (sandboxed.some((r) => r.session !== L.session)) {
      return { ok: false, reason: `lister-blind: sandbox rows outside session ${L.session}` };
    }
    const byPid = new Map(L.rows.map((r) => [r.pid, r]));
    if (sandboxed.some((r) => underPid(r, child.pid, byPid))) return { ok: true };
    return { ok: false, reason: "lister-blind: no sandbox-user row under the probe" };
  } finally {
    killTree(child.pid);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);
        child.once("exit", () => { clearTimeout(t); resolve(); });
      });
    }
  }
}
