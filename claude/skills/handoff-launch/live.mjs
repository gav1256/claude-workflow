// Shared primitives of handoff-launch: the registry, process probes, liveness, transcripts, GOAL.md copies, stop
// requests, kills and the window launcher. Used by launch.mjs (the CLI), merge.mjs, recover.mjs (the coordinator tick) and
// hooks/coord.mjs. Liveness is tri-state - running / gone / unknown: a failed, timed-out or empty probe is unknown,
// and unknown never writes {closed}, never reports STALE and never kills.
// Test hooks: HL_REGISTRY_DIR, HL_PROJECTS_DIR, HL_AGENTS_JSON (file standing in for `claude agents --json`),
// HL_FAKE_PROBE=fail|timeout (every process probe fails, or really times out after 0.3 s) or fail:<label> (only the
// probes with that label fail - the host-below probes are "below" - and the rest run for real), HL_FAKE_CLAUDE=1 (with
// HL_AGENTS_JSON, `claude stop <id>` removes that agent from the file), HL_FAKE_PROCS (JSON file standing in for the
// process list of the orphan scan), HL_AGENTS_LOG (a file that gets one line per `claude agents --json` list, memo hits
// excluded), CLAUDE_CONFIG_DIR (tests: a temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { fwd, stem } from "./merge-lib.mjs";
import { loadConfig, startsWithoutLaunch, openBgTasks } from "./recover-lib.mjs";

export { stem };
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CFG = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
export const REG_DIR = path.resolve(process.env.HL_REGISTRY_DIR || HERE);
export const REG = path.join(REG_DIR, "sessions.jsonl");
export const PID_DIR = path.join(REG_DIR, "pids");
export const STOP_DIR = path.join(REG_DIR, "stops");
export const PROJECTS = path.resolve(process.env.HL_PROJECTS_DIR || path.join(CFG, "projects"));
export const COORD = path.join(CFG, "state", "coord");
export const MIN = 60000;
export const now = () => new Date().toISOString();
export const ago = (t) => Date.now() - Date.parse(t);
export const mins = (ms) => `${Math.round(ms / MIN)} min`;
export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const readJson = (f, d = null) => { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return v && typeof v === "object" ? v : d; } catch { return d; } };
// <coord>/config.json through loadConfig (missing or invalid = the defaults), read once per process.
let cfgMemo;
export function coordConfig() {
  if (!cfgMemo) { let t = null; try { t = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} cfgMemo = loadConfig(t).config; }
  return cfgMemo;
}
// A claimed alert, alerts/claimed-<sid>-<ms>-<orig> (coord.mjs claims, sends and releases; the tick returns stale ones):
// -> [, sid, ms, orig]. The sid is a plain id ([\w-]); the lazy match takes the first 13-digit stamp after it, so digits
// in a lane name inside <orig> never split it wrong.
export const CLAIMED = /^claimed-([\w-]+?)-(\d{13})-(\d.*\.json)$/;
// writeAtomic's temp names, <file>.<pid>.<8 hex>.tmp: the tick's prune removes only these, never another tool's .tmp.
export const ATOMIC_TMP = /\.\d+\.[0-9a-f]{8}\.tmp$/;
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, text);
  // A failed rename (the target is a directory, or locked) must not leave its .tmp behind: one per failed write grows.
  try { fs.renameSync(tmp, file); } catch (err) { try { fs.unlinkSync(tmp); } catch {} throw err; }
}
// Claude Code's folder name for a working directory: <config>/projects/<key>/ and <tmp>/claude/<key>/.
export const projectKey = (dir) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");

// ---------- registry: launch lines + event lines, append-only ----------
export function readRegistry() {
  const lines = [], entries = [], closed = new Set(), stops = new Map(), merges = [];
  let text = ""; try { text = fs.readFileSync(REG, "utf8"); } catch {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    lines.push(o);
    if (o.closed) closed.add(o.id || o.closed);
    else if (o.stop_requested) { if (!stops.has(o.stop_requested)) stops.set(o.stop_requested, []); stops.get(o.stop_requested).push(o); }
    else if (o.merged || o.merge_blocked) merges.push(o);
    else if (o.name && o.launched_at) entries.push(o);
  }
  return { lines, entries, closed, stops, merges };
}
export const append = (o) => { fs.mkdirSync(REG_DIR, { recursive: true }); fs.appendFileSync(REG, JSON.stringify(o) + "\n"); };
// The provisional line a launcher appends right before it starts a window or a bg session; its launch line follows.
// No launched_at and no id: no reader takes it for a launch line. A {starting} line with no launch line after it is a
// session nothing tracks (the launcher died in between): status and the tick report it (untracked below).
export const startingLine = (e) => ({ starting: e.session_id ?? null, name: e.name, ...(e.group ? { group: e.group } : {}), pid_file: e.pid_file ?? null, at: now() });

// ---------- process probes: a failure is remembered (probeWhy) and the caller reports unknown ----------
let lastWhy = null;
export const probeWhy = () => lastWhy;
// Every child of a probe is a spawnSync with a timeout. label: the name in the failure reason (default: cmd), and what
// HL_FAKE_PROBE=fail:<label> matches.
function probe(cmd, argv, timeout, { label = cmd, ...opts } = {}) {
  const fake = process.env.HL_FAKE_PROBE;
  if (fake === "fail" || fake === `fail:${label}`) { lastWhy = `process probe failed (HL_FAKE_PROBE=${fake})`; return { ok: false, why: lastWhy }; }
  const r = fake === "timeout"
    ? spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 300 })
    : spawnSync(cmd, argv, { encoding: "utf8", timeout, windowsHide: true, ...opts });
  if (r.error?.code === "ETIMEDOUT") lastWhy = `${label} timed out`;
  else if (r.error) lastWhy = `${label} failed: ${r.error.code || r.error.message}`;
  else if (r.status === null && r.signal) lastWhy = `${label} ended by signal ${r.signal}`;
  else if (r.status !== 0) lastWhy = `${label} exited ${r.status}: ${String(r.stderr || "").trim().slice(0, 200)}`;
  else { lastWhy = null; return { ok: true, out: String(r.stdout || "") }; } // a success clears an older failure's reason
  return { ok: false, why: lastWhy };
}
// ---------- the claude CLI: claude.exe directly, never through a shell when it can be helped ----------
// A spawnSync timeout kills the process it started: through a shell that is cmd.exe, and a 100-200 MB claude.exe below
// it is orphaned. So every claude spawn (agents list, stop, the bg launch) runs the resolved .exe with shell: false.
// `where.exe claude` output -> the first line ending in .exe (case-insensitive), or null.
export function exeFromWhere(text) {
  for (const l of String(text ?? "").split(/\r?\n/)) { const t = l.trim(); if (/\.exe$/i.test(t)) return t; }
  return null;
}
let cliMemo;
// Resolved once per process. -> {exe}: the path to spawn without a shell (elsewhere than Windows: plain `claude`), or
// {exe: null} when Windows has no claude.exe on PATH (an npm .cmd install).
export function claudeCli() {
  if (cliMemo) return cliMemo;
  if (process.platform !== "win32") return (cliMemo = { exe: "claude" });
  const r = spawnSync("where.exe", ["claude"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  return (cliMemo = { exe: r.status === 0 ? exeFromWhere(r.stdout) : null });
}
// -> [file, args, {shell}] for spawn/spawnSync. The .cmd fallback goes through a shell with ONE pre-quoted command
// string and no args array (an args array with shell: true prints DEP0190); arguments never contain double quotes
// (launch.mjs replaces them). Residual: on that path a timeout still kills only cmd.exe and can orphan the CLI - the
// user's machine has the .exe.
export function claudeSpawn(argv, cli = claudeCli()) {
  if (cli.exe) return [cli.exe, argv, { shell: false }];
  return [["claude", ...argv.map((a) => `"${a}"`)].join(" "), [], { shell: true }];
}
const claudeProbe = (argv, timeout) => { const [f, a, o] = claudeSpawn(argv); return probe(f, a, timeout, { ...o, label: "claude" }); };
// A PowerShell probe that fails loudly: any error (a CIM/WMI failure included) exits 1 instead of printing a confident
// answer, so the caller reports unknown, never "absent". A cmdlet's own -ErrorAction SilentlyContinue still applies.
const psGuard = (body) => `$ErrorActionPreference='Stop'; try { ${body} } catch { [Console]::Error.WriteLine('probe error: ' + $_.Exception.Message); 'ERR'; exit 1 }`;
// pid -> {name, start}; DEAD for a pid with no process. null when the probe failed, timed out or answered short.
export function procInfo(pids) {
  if (!pids.length) return new Map();
  const script = psGuard(`foreach($i in @(${pids.join(",")})){ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; `
    + `if(-not $p){ '{0}|DEAD|' -f $i } else { $s=''; try { $s=$p.StartTime.ToUniversalTime().ToString('o') } catch {}; '{0}|{1}|{2}' -f $i,$p.ProcessName,$s } }`);
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 10000);
  if (!r.ok) return null;
  const m = new Map();
  for (const l of r.out.split(/\r?\n/)) { const [p, n, s] = l.trim().split("|"); if (p && n) m.set(Number(p), { name: n, start: s || null }); }
  if (!pids.every((p) => m.has(Number(p)))) { lastWhy = "process probe answered for only some pids"; return null; }
  return m;
}
// The PowerShell script behind hasClaudeBelow: prints True or False; a CIM error or an empty process list exits 1 (ERR).
export const claudeBelowScript = (pid) => psGuard(`$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; `
  + `if(-not $all){ throw 'Get-CimInstance Win32_Process returned nothing' }; $q=@(${pid}); $hit=$false; `
  + `while($q.Count){ $c=@($all | Where-Object { $q -contains $_.ParentProcessId }); if($c | Where-Object { $_.Name -match '^(claude|node)(\\.exe)?$' }){ $hit=$true; break }; $q=@($c | ForEach-Object { $_.ProcessId }) }; $hit`);
// true / false when a claude or node process runs under <pid>; null when the probe failed.
export function hasClaudeBelow(pid) {
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", claudeBelowScript(pid)], 10000);
  if (!r.ok) return null;
  const t = r.out.trim();
  return t === "True" ? true : t === "False" ? false : (lastWhy = `unexpected probe output: ${t.slice(0, 80)}`, null);
}
// Host pids as the scripts take them: positive integers, each once (anything else never reaches a PowerShell script).
const hostIds = (pids) => [...new Set((Array.isArray(pids) ? pids : []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
// The PowerShell script behind hostsBelow: OK, then one <host pid>|<name> line per process below each host (any depth).
// ONE CIM query of the process table answers for every host (plan amendment 3); a parent -> children index keeps the walk
// linear. A CIM error or an empty process list exits 1 (ERR). $seen, seeded with the host, guards against a cycle of
// reused pids.
export const hostsBelowScript = (pids) => psGuard(`$all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name); `
  + `if(-not $all.Count){ throw 'Get-CimInstance Win32_Process returned nothing' }; $kids=@{}; `
  + `foreach($p in $all){ $k=[int64]$p.ParentProcessId; if(-not $kids.ContainsKey($k)){ $kids[$k]=New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }; 'OK'; `
  + `foreach($h in @(${hostIds(pids).join(",")})){ $seen=@{}; $seen[[int64]$h]=1; $q=@([int64]$h); `
  + `while($q.Count){ $n=@(); foreach($i in $q){ if($kids.ContainsKey($i)){ foreach($x in $kids[$i]){ $j=[int64]$x.ProcessId; `
  + `if(-not $seen.ContainsKey($j)){ $seen[$j]=1; '{0}|{1}' -f $h,$x.Name; $n+=$j } } } }; $q=$n } }`);
const isClaude = (n) => /^(claude|node)(\.exe)?$/i.test(n);
// What runs below each window host, from ONE probe for all of them (plan amendment 3: the tick's gone scan and the
// launcher's occupancy pass share it): a Map host pid -> {names, claude, empty} - names: every descendant except
// conhost; claude: a claude or node process among them; empty: nothing at all (a dead start or a plain exit leaves an
// empty host; probe 5: under Windows Terminal not even conhost). A gone host has nothing below it either: callers judge
// liveness first. null for the whole call when the probe failed: never "empty". A pid that is not a positive integer
// is left out (a caller reads a missing pid as unknown, like null); no pid at all: an empty Map and no probe.
export function hostsBelow(pids) {
  const ids = hostIds(pids);
  if (!ids.length) return new Map();
  // 20 s: a whole-table CIM query is slower than procInfo's Get-Process; a timeout is null (no action), never "empty".
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", hostsBelowScript(ids)], 20000, { label: "below" });
  if (!r.ok) return null;
  const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "OK") { lastWhy = `unexpected probe output: ${lines.join(" ").slice(0, 80)}`; return null; }
  const below = new Map(ids.map((p) => [p, []]));
  for (const l of lines.slice(1)) {
    const i = l.indexOf("|"), names = i > 0 ? below.get(Number(l.slice(0, i))) : undefined;
    if (!names) { lastWhy = `unexpected probe output: ${l.slice(0, 80)}`; return null; }
    if (!/^conhost(\.exe)?$/i.test(l.slice(i + 1))) names.push(l.slice(i + 1));
  }
  return new Map([...below].map(([p, names]) => [p, { names, claude: names.some(isClaude), empty: names.length === 0 }]));
}
// What runs below one window host: hostsBelow's {names, claude, empty} for <pid>; null when the probe failed (or <pid>
// is not a pid): never "empty".
export const hostBelow = (pid) => hostsBelow([pid])?.get(Number(pid)) ?? null;
// Every process, for the tick's orphan scan and the Playwright reaper: [{pid, ppid, name, mb, created, cmd}] (mb: private
// bytes in MB; created: epoch ms or null; cmd: the command line, "" when unreadable). null = unknown: the probe failed, answered nothing, or this is not Windows. HL_FAKE_PROCS=<json file>
// stands in for the probe on any OS (tests); an unreadable or empty one is unknown too.
export function processList() {
  if (process.env.HL_FAKE_PROCS) { const v = readJson(process.env.HL_FAKE_PROCS, null); return Array.isArray(v) && v.length ? v : null; }
  if (process.platform !== "win32") return null;
  const script = psGuard(`$all=@(Get-CimInstance Win32_Process); if(-not $all.Count){ throw 'Get-CimInstance Win32_Process returned nothing' }; `
    + `foreach($p in $all){ $c=''; if($p.CreationDate){ $c=$p.CreationDate.ToUniversalTime().ToString('o') }; $l=([string]$p.CommandLine) -replace '[\\r\\n]+',' '; '{0}|{1}|{2}|{3}|{4}|{5}' -f $p.ProcessId,$p.ParentProcessId,$p.Name,$p.PrivatePageCount,$c,$l }`);
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 10000);
  if (!r.ok) return null;
  const list = [];
  for (const l of r.out.split(/\r?\n/)) {
    const [pid, ppid, name, bytes, c, ...cmd] = l.trim().split("|"); // the command line is last: it may hold a |
    if (pid && name) list.push({ pid: Number(pid), ppid: Number(ppid), name, mb: Math.round(Number(bytes) / 1048576) || 0, created: Date.parse(c) || null, cmd: cmd.join("|") });
  }
  return list.length ? list : null;
}
// Kill <pid> and its children (taskkill /T /F on Windows). Callers check first that <pid> is the process they mean.
export const killPidTree = (pid) => {
  if (process.platform === "win32") return probe("taskkill", ["/T", "/F", "/PID", String(pid)], 30000);
  try { process.kill(pid, "SIGKILL"); return { ok: true }; } catch (e) { return { ok: false, why: `kill failed: ${e.code || e.message}` }; }
};
export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
export const selfStart = () => new Date(Date.now() - process.uptime() * 1000).toISOString();
// The OS start time (ms) of <pid>; null off Windows, when the probe fails, or when there is no such process.
// Kept for merge.mjs: Task 8 records the merge drain lock's start time with it.
export function procStart(pid) {
  if (process.platform !== "win32") return null;
  const s = procInfo([pid])?.get(pid)?.start;
  return s ? Date.parse(s) : null;
}

// ---------- background sessions: `claude agents --json`, memoized per run ----------
// Statuses of an ended session that `claude agents --json` still lists (probe 3 records the real words).
const BG_ENDED = /^(stopped|exited|completed|failed|done|killed)$/i;
let agentsMemo, agentsWhy = null, agentsAt = 0;
// Whether e's liveness or state reads `claude agents --json` (a background session); a window's never does.
export const usesAgents = (e) => e.mode === "bg" || !!e.bg_id;
export function agentsList() {
  // A memoized failure restores its own reason: a later successful probe has cleared lastWhy.
  if (agentsMemo !== undefined) { if (agentsMemo === null) lastWhy = agentsWhy; return agentsMemo; }
  let txt = null;
  if (process.env.HL_AGENTS_LOG) { try { fs.appendFileSync(process.env.HL_AGENTS_LOG, `${now()}\n`); } catch {} } // tests count the lists
  // The fake fails or times out before any spawn of claude; fail:<label> fails only that label's probes, so the list
  // falls through to HL_AGENTS_JSON.
  if (process.env.HL_FAKE_PROBE === "fail" || process.env.HL_FAKE_PROBE === "timeout") probe("claude", ["agents", "--json"], 30000);
  else if (process.env.HL_AGENTS_JSON) { try { txt = fs.readFileSync(process.env.HL_AGENTS_JSON, "utf8"); } catch (e) { lastWhy = `cannot read HL_AGENTS_JSON: ${e.code}`; } }
  else { const r = claudeProbe(["agents", "--json"], 30000); txt = r.ok ? r.out : null; }
  let v = null;
  if (txt != null && txt.trim()) { try { const j = JSON.parse(txt); if (Array.isArray(j)) v = j; else lastWhy = "claude agents --json is not a list"; } catch { lastWhy = "claude agents --json is not JSON"; } }
  else if (txt != null) lastWhy = "claude agents --json printed nothing";
  agentsMemo = v; agentsWhy = v ? null : lastWhy; agentsAt = Date.now();
  return v;
}
export function refreshAgents() { agentsMemo = undefined; return agentsList(); }
// list: agentsList()'s result. Not a list (null: the probe failed; anything else a caller passes) finds nothing, and a
// non-object element is skipped: `claude agents --json` output never throws here.
export const listedAgent = (e, list) => (Array.isArray(list) ? list.find((a) => a && typeof a === "object" && ((e.session_id && a.sessionId === e.session_id) || (e.bg_id && a.id === e.bg_id))) ?? null : null);
// The one entry that appeared in `claude agents --json` since `before` and carries the launch name; null otherwise
// (also when either list is not a list).
export function matchNewAgent(before, after, name) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const seen = new Set(before.map((a) => a?.id));
  const fresh = after.filter((a) => a && a.id && !seen.has(a.id) && [a.name, a.title, a.label].includes(name));
  return fresh.length === 1 ? fresh[0] : null;
}
function stopBg(id) {
  if (process.env.HL_FAKE_CLAUDE === "1" && process.env.HL_AGENTS_JSON) { // tests: the agent leaves the list
    const f = process.env.HL_AGENTS_JSON, list = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Array.isArray(list)) fs.writeFileSync(f, JSON.stringify(list.filter((a) => a?.id !== id)));
    agentsMemo = undefined;
    return { ok: true };
  }
  return claudeProbe(["stop", id], 60000);
}

// ---------- liveness ----------
export function readPidFile(e) {
  if (e.host_pid || !e.pid_file) return e;
  try {
    // A pid file older than this launch belongs to another launch (N4): ignore it.
    if (fs.statSync(e.pid_file).mtimeMs < Date.parse(e.launched_at) - 2000) return e;
    const [p, s] = fs.readFileSync(e.pid_file, "utf8").trim().split(/\s+/);
    return { ...e, host_pid: Number(p) || null, host_start: s || null };
  } catch { return e; }
}
// Is e.host_pid still the window host we launched (PID-reuse guard)? info: procInfo's result (null = probe failed).
export function checkHost(e, info) {
  if (!e.host_pid) return ago(e.launched_at) > 2 * MIN ? { state: "gone", why: "no pid recorded" } : { state: "unknown", why: "starting (no pid file yet)" };
  if (!info) return { state: "unknown", why: probeWhy() || "process probe failed" };
  const p = info.get(e.host_pid);
  if (!p || p.name === "DEAD") return { state: "gone", why: "not running" };
  if (p.name.toLowerCase() !== "powershell") return { state: "gone", why: `pid now belongs to ${p.name} (reused)` };
  if (!p.start) return { state: "unknown", why: "start time unreadable" };
  const st = Date.parse(p.start);
  const bad = e.host_start ? Math.abs(st - Date.parse(e.host_start)) > 2000
    : (st > Date.parse(e.launched_at) + 5000 || st < Date.parse(e.launched_at) - MIN);
  return bad ? { state: "gone", why: `process started ${p.start}, not the recorded window (reused)` } : { state: "running", why: `host pid ${e.host_pid}` };
}
const liveMemo = new Map();
// Drop the liveness memo of <id> (every id when none). agents: whether the `claude agents --json` memo goes too - true
// (the default) where a bg session's state may have changed (a stop, a kill); false where only a window's liveness must
// be fresh; a number of ms keeps a list younger than that (one list per tick unless a restart left it old).
export function forgetLiveness(id, { agents = true } = {}) {
  if (id) liveMemo.delete(id); else liveMemo.clear();
  if (agents === true || (typeof agents === "number" && !(Date.now() - agentsAt < agents))) agentsMemo = undefined;
}
// One PowerShell probe for every window entry of this run (status and the tick call this first).
export function primeLiveness(entries) {
  const w = entries.filter((e) => e.mode !== "bg" && !liveMemo.has(e.id)).map(readPidFile).filter((e) => e.host_pid);
  if (!w.length) return;
  const info = procInfo([...new Set(w.map((e) => e.host_pid))]);
  for (const e of w) liveMemo.set(e.id, checkHost(e, info));
}
export function liveness(e, reg = readRegistry()) {
  if (reg.closed.has(e.id)) return { state: "gone", why: "closed in the registry" };
  // A test launch (HL_NO_SPAWN) that never got a process identity: nothing runs. A copy given a pid or bg id is judged.
  if (e.no_spawn && !e.host_pid && !e.bg_id) return { state: "gone", why: "recorded without a process (HL_NO_SPAWN)" };
  if (liveMemo.has(e.id)) return liveMemo.get(e.id);
  let v;
  if (e.mode === "bg") {
    if (!e.bg_id && !e.session_id) v = { state: "unknown", why: "no background session id recorded" };
    else {
      const list = agentsList(), a = list && listedAgent(e, list);
      v = !list ? { state: "unknown", why: probeWhy() || "claude agents failed" }
        : a && !BG_ENDED.test(String(a.status || "")) ? { state: "running", why: `bg session ${e.bg_id || e.session_id}` }
        : { state: "gone", why: a ? `claude agents lists it as ${a.status}` : "not listed by claude agents" };
    }
  } else {
    const w = readPidFile(e);
    v = checkHost(w, w.host_pid ? procInfo([w.host_pid]) : new Map());
  }
  liveMemo.set(e.id, v);
  return v;
}
// Sessions a launcher started but died before registering ({starting} lines older than 3 min with no launch line
// after them, recover-lib's startsWithoutLaunch). Report-only: the caller prints them, nothing acts on them. One
// probe for all their window pids; a window's pid file is read as its launch line's would be (checkHost: tri-state,
// PID-reuse guarded); a bg launch has no pid to probe (unknown). A gone or pid-less one is dropped 24 h after its
// start. -> [{name, group, pid, state, why, at}]
export function untracked(reg = readRegistry(), nowMs = Date.now()) {
  const starts = startsWithoutLaunch(reg.lines, nowMs, 3 * MIN);
  if (!starts.length) return [];
  const ws = starts.map((s) => (s.pid_file ? readPidFile({ pid_file: s.pid_file, launched_at: s.at }) : null));
  const pids = [...new Set(ws.filter((w) => w?.host_pid).map((w) => w.host_pid))];
  const info = pids.length ? procInfo(pids) : new Map();
  return starts.map((s, i) => {
    const lv = ws[i] ? checkHost(ws[i], info) : { state: "unknown", why: "a background launch: no pid file" };
    return { name: s.name, group: s.group ?? null, pid: ws[i]?.host_pid ?? null, state: lv.state, why: lv.why, at: s.at };
  }).filter((u) => !(nowMs - Date.parse(u.at) > 24 * 60 * MIN && (u.state === "gone" || u.pid == null)));
}

// ---------- transcripts ----------
const blocks = (x) => (Array.isArray(x?.message?.content) ? x.message.content : []);
export function transcriptOf(sid) {
  if (!sid || !fs.existsSync(PROJECTS)) return null;
  for (const d of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
export function tail(file, bytes = 2_000_000) {
  const fd = fs.openSync(file, "r");
  let buf, n, size;
  try { size = fs.fstatSync(fd).size; n = Math.min(size, bytes); buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); }
  finally { fs.closeSync(fd); } // a failed read never leaks the fd (the tick reads many transcripts per run)
  const lines = buf.toString("utf8").split(/\r?\n/); if (n < size) lines.shift();
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
// <projects>/<key>/<sid>/subagents/agent-<agent id>.jsonl (+ .meta.json: agentType, description, requestShape).
export function subagentFiles(sid) {
  const t = transcriptOf(sid); if (!t) return [];
  const dir = path.join(path.dirname(t), sid, "subagents");
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((f) => /^agent-.+\.jsonl$/.test(f)).map((f) => {
    const file = path.join(dir, f), st = fs.statSync(file);
    return { agentId: f.slice(6, -6), file, mtimeMs: st.mtimeMs, size: st.size, meta: readJson(file.replace(/\.jsonl$/, ".meta.json"), null) };
  });
}
// {found, idle, busy:[reasons], last, pending, turnDone, bgAgents, bgKnown, bgTasks, liveStatus, file} - no loop judgement here.
export function sessionState(e) {
  // `claude agents --json` (a 100-200 MB CLI process) only for a background session: a window's state is its transcript.
  const list = usesAgents(e) ? agentsList() : null, a = list ? listedAgent(e, list) : null;
  const sid = e.session_id || a?.sessionId;
  const liveStatus = a ? String(a.status || a.state || "") : null;
  const file = transcriptOf(sid);
  if (!file) return { found: false, idle: false, busy: [], last: null, pending: 0, turnDone: false, bgAgents: 0, bgKnown: false, bgTasks: [], liveStatus, file: null };
  const L = tail(file).filter((x) => !x.isSidechain);
  const last = [...L].reverse().find((x) => x.timestamp)?.timestamp || fs.statSync(file).mtime.toISOString();
  const used = new Map(), done = new Set();
  for (const x of L) for (const b of blocks(x)) { if (b.type === "tool_use") used.set(b.id, b); else if (b.type === "tool_result") done.add(b.tool_use_id); }
  const pending = [...used.keys()].filter((id) => !done.has(id));
  const conv = L.filter((x) => x.type === "assistant" || x.type === "user" || (x.type === "system" && x.subtype === "turn_duration"));
  const end = conv[conv.length - 1];
  const turnDone = !!end && (end.type === "system" || (end.type === "assistant" && end.message?.stop_reason === "end_turn"));
  const td = [...L].reverse().find((x) => x.type === "system" && x.subtype === "turn_duration");
  const bgAgents = td?.pendingBackgroundAgentCount || 0;
  // Only the CLI's turn_duration record at the turn's end tells the pending background agents: it carries
  // pendingBackgroundAgentCount when there are any (real transcripts never record a 0, so absent = none). A turn ended by
  // an assistant entry alone - or an older turn's record - says nothing: bgKnown false, and a close keeps the window.
  const bgKnown = end?.type === "system";
  const busy = [];
  if (pending.length) busy.push(`${pending.length} tool call(s) outstanding`);
  if (!turnDone) busy.push("turn not finished");
  if (bgAgents) busy.push(`${bgAgents} background agent(s) running`);
  if (liveStatus && /busy|running|working/i.test(liveStatus)) busy.push(`live status ${liveStatus}`);
  // Background shell and Monitor tasks (batch A, Part 2): turn_duration says nothing about them. Scanned only when the
  // session would otherwise be idle, so a busy session pays nothing: the main tail plus the subagent files modified
  // within bg_task_max_min; tasks from before this launch line belonged to an earlier process.
  let bgTasks = [];
  if (!busy.length) {
    const cfg = coordConfig(), nowMs = Date.now();
    const subs = subagentFiles(sid).filter((s) => nowMs - s.mtimeMs <= cfg.bg_task_max_min * MIN).map((s) => tail(s.file));
    bgTasks = openBgTasks([L, ...subs], { sinceMs: Date.parse(e.launched_at) || 0, nowMs, cfg }).map((t) => t.id);
    if (bgTasks.length) busy.push(`${bgTasks.length} background task(s) running`);
  }
  return { found: true, idle: busy.length === 0, busy, last, pending: pending.length, turnDone, bgAgents, bgKnown, bgTasks, liveStatus, file };
}

// ---------- GOAL.md across a fresh restart ----------
// A session's scratchpad GOAL.md: <tmp>/claude/<project folder>/<sid>/scratchpad/GOAL.md, the project folder being the
// main transcript's (a subagent's transcript lies deeper: never pass one). null without a transcript path. The one rule
// of goalOf and coord.mjs; goal-gate.mjs keeps a standalone copy (tests/lane-hooks.test.mjs pins it equal).
export const goalPathFor = (transcriptPath, sid) => (typeof transcriptPath === "string" && transcriptPath
  ? path.join(os.tmpdir(), "claude", path.basename(path.dirname(transcriptPath)), sid, "scratchpad", "GOAL.md") : null);
// goal-gate looks in the scratchpad GOAL.md (goalPathFor), then <config>/goals/<sid>.md.
export function goalOf(sid) {
  return [goalPathFor(transcriptOf(sid), sid), path.join(CFG, "goals", `${sid}.md`)].filter(Boolean).find((p) => fs.existsSync(p)) || null;
}
// Copy the old session's GOAL.md to where goal-gate looks for the new one. A restart runs in the same worktree, so its
// transcript lands in the old one's project folder: that folder's name (not one recomputed from the path, which Claude
// Code may spell differently) keys the new scratchpad. Window mode knows the new id in advance; both modes also get
// <config>/goals/<sid>.md, goal-gate's fallback. -> the paths written.
export function copyGoal(fromSid, toDir, toSid) {
  const src = fromSid && goalOf(fromSid);
  if (!src || !toSid) return [];
  const t = transcriptOf(fromSid), dsts = [path.join(CFG, "goals", `${toSid}.md`)];
  if (toDir) dsts.unshift(path.join(os.tmpdir(), "claude", t ? path.basename(path.dirname(t)) : projectKey(toDir), toSid, "scratchpad", "GOAL.md"));
  for (const d of dsts) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(src, d); }
  return dsts;
}

// ---------- stop request (graceful) and kill (last resort, always after a written kill_intent) ----------
export const STOP_TEXT = (why) => `STOP REQUEST from handoff-launch (${why}): finish or cancel your in-flight tool call, `
  + "TaskStop every background agent you started, record your state in your ledger/handoff, then end your turn and start no new work.";
// Reason class of a stop line; lines from before stage 2 have none and are classed by their text.
export const classOf = (s) => s.reason_class || (/^auto-close/.test(s.why || "") ? "close" : /^watchdog/.test(s.why || "") ? "ladder" : "manual");
// A stop file the session hook delivers at the session's next tool call, plus a {stop_requested} line. Dedupe per
// (session, reason class), so a close request never suppresses a ladder request.
export function requestStop(e, why, { apply, reasonClass, signature = null, text = STOP_TEXT(why), force = false, repeatMs = 30 * MIN }) {
  const prev = (readRegistry().stops.get(e.id) || []).filter((x) => classOf(x) === reasonClass).at(-1);
  if (!force && prev && ago(prev.at) < repeatMs) return `stop already requested ${mins(ago(prev.at))} ago (${prev.why})`;
  if (!apply) return `would request stop: ${why}`;
  // One stop file per reason class: a close or manual request never overwrites a pending ladder token (or the reverse).
  const at = now(), token = crypto.randomUUID(), file = path.join(STOP_DIR, `${stem(e.id)}.${reasonClass}.stop.json`);
  writeAtomic(file, JSON.stringify({ id: e.id, name: e.name, session_id: e.session_id, why, at, token, reason_class: reasonClass, signature, text }, null, 2));
  append({ stop_requested: e.id, name: e.name, why, at, file: fwd(file), token, reason_class: reasonClass, signature });
  return e.coord ? `stop requested: ${why} - the session hook delivers it at the session's next tool call`
    : `stop requested: ${why} -> deliver with SendMessage to '${e.name}': ${text}`;
}
// Kill one session's own process tree: only when liveness is running (window: recorded host pid + start time; bg:
// claude stop <bg_id>). kill_intent first; a process gone afterwards counts as closed. A session already gone gets
// kill_intent + {closed} and no kill. kind: "ladder" (the tick resumes it into a restart) or "close".
export function killTree(e, why, kind) {
  forgetLiveness(e.id, { agents: usesAgents(e) }); // a window kill never changes a bg session's state
  const lv = liveness(e);
  if (lv.state === "unknown") return { closed: false, line: `no kill: liveness unknown (${lv.why})` };
  if (lv.state === "running" && e.mode === "bg" && !e.bg_id) return { closed: false, line: "no kill: no background id recorded (never stopped)" };
  append({ kill_intent: e.id, name: e.name, kind, why, at: now() });
  if (lv.state === "gone") { append({ closed: e.name, id: e.id, at: now(), why: `${why} (already gone: ${lv.why})` }); return { closed: true, line: `already gone (${lv.why})` }; }
  const w = readPidFile(e);
  const r = e.mode === "bg" ? stopBg(e.bg_id) : probe("taskkill", ["/T", "/F", "/PID", String(w.host_pid)], 30000);
  forgetLiveness(e.id, { agents: usesAgents(e) });
  const after = liveness(e);
  if (r.ok || after.state === "gone") { append({ closed: e.name, id: e.id, at: now(), why }); return { closed: true, line: r.ok ? "closed" : "closed (process gone after the kill)" }; }
  return { closed: false, line: `kill failed: ${r.why}; liveness now ${after.state}` };
}
// The newest launch line of session <name> (entries hold launch lines only, never {starting} lines); null when none.
export const latestLaunch = (reg, name) => [...reg.entries].reverse().find((x) => x.name === name) ?? null;
// That launch line's liveness, read fresh (the registry changes mid-run); null when the session has no launch line.
export function sessionLiveness(name, reg = readRegistry()) { const e = latestLaunch(reg, name); return e ? liveness(e, reg) : null; }
// Why a merge session's lock must not be cleared or skipped now: it runs, its liveness is unknown, or it is still
// starting. null = demonstrably not running.
export function sessionBlocker(name, lock) {
  const reg = readRegistry();
  const e = latestLaunch(reg, name);
  // T4e: launchMergeSession writes the session lock before its session's launch line exists.
  if (lock?.at && ago(lock.at) < 3 * MIN && (!e || e.launched_at < lock.at)) return { kind: "starting", text: `merge.lock taken ${Math.round(ago(lock.at) / 1000)} s ago, no launch line yet` };
  // Past that window: a launcher that died between its {starting} line (after the lock) and its launch line may have
  // left the session's window running in the merge worktree. Its host is judged like a registered session's: running
  // blocks, and a failed probe is unknown, which blocks too (never "not running"). A start with no pid to probe (a bg
  // launch has no pid file; a window that never wrote one) does not block: nothing can ever answer for it, and it
  // would block --force for a day. One probe for all the starts' pids, as in untracked().
  if (lock?.at && (!e || e.launched_at < lock.at)) {
    const ws = startsWithoutLaunch(reg.lines, Date.now(), -Infinity).filter((s) => s.name === name && s.at >= lock.at && s.pid_file)
      .map((s) => readPidFile({ pid_file: s.pid_file, launched_at: s.at })).filter((w) => w.host_pid);
    const info = ws.length ? procInfo([...new Set(ws.map((w) => w.host_pid))]) : null;
    let unk = null;
    for (const w of ws) {
      const st = checkHost(w, info);
      if (st.state === "running") return { kind: "running", text: `untracked: its launcher died before registering it, host pid ${w.host_pid}` };
      if (st.state === "unknown") unk ??= { kind: "unknown", text: `untracked start of ${name}, host pid ${w.host_pid}: ${st.why}` };
    }
    if (unk) return unk;
  }
  if (!e) return null;
  const lv = liveness(e, reg);
  return lv.state === "gone" ? null : { kind: lv.state, text: lv.why };
}

// ---------- the coordinator: session hooks file and the tick trigger ----------
// <config>/skills/handoff-launch -> <config>/hooks/coord.mjs (the repo has the same layout: claude/skills, claude/hooks).
export const COORD_MJS = path.resolve(HERE, "..", "..", "hooks", "coord.mjs");
// The hooks every launched session gets -> coord.mjs: PostToolUse (all tools), Notification, and (batch A) PreToolUse on
// file writes (the write fence), UserPromptSubmit (the lane note) and Stop (the claude-in-chrome tab check). launch.mjs
// folds them into the profile's ONE --settings file (two --settings flags do not merge: the last one wins entirely).
export function sessionHooks() {
  const cmd = (sub) => ({ type: "command", command: `node "${fwd(COORD_MJS)}" ${sub}`, timeout: 10 });
  return { hooks: {
    PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [cmd("fence")] }],
    PostToolUse: [{ matcher: "*", hooks: [cmd("post-tool")] }],
    Notification: [{ hooks: [cmd("notify")] }],
    UserPromptSubmit: [{ hooks: [cmd("lane-note")] }],
    Stop: [{ hooks: [cmd("stop")] }],
  } };
}
// session-hooks.json next to the registry: the inspectable copy of sessionHooks() (written when it changed).
export function sessionHooksFile({ write = true } = {}) {
  const f = path.join(REG_DIR, "session-hooks.json");
  const text = JSON.stringify(sessionHooks(), null, 2) + "\n";
  let cur = null; try { cur = fs.readFileSync(f, "utf8"); } catch {}
  if (write && cur !== text) writeAtomic(f, text);
  return f;
}
// At most one tick per tickMin (default: tick_min of <coord>/config.json), from any trigger: claim it in tick.json, then
// start `coord.mjs tick` detached. A missing, corrupt or future tick.json does not block (the tick is due). If the
// claim cannot be written, no tick starts and the result is false: an unwritable tick.json must not start a tick at
// every tool call. Never throws; HL_NO_SPAWN records the claim and starts nothing.
export function triggerTick(by, tickMin) {
  try {
    if (tickMin === undefined) { let text = null; try { text = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} tickMin = loadConfig(text).config.tick_min; }
    const f = path.join(COORD, "tick.json"), tj = readJson(f, {}) || {}, last = Date.parse(tj.at), t = Date.now();
    if (last <= t && last > t - tickMin * MIN) return false; // a future `at` (clock moved back, hand edit) is stale
    writeAtomic(f, JSON.stringify({ ...tj, at: now(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return true;
    spawn(process.execPath, [COORD_MJS, "tick"], { detached: true, stdio: "ignore", windowsHide: true, env: launcherEnv() }).on("error", () => {}).unref();
    return true;
  } catch { return false; }
}

// A process the coordinator starts (launch.mjs, the tick) must not look like it was launched by whichever session's hook or
// command started the coordinator: no HL_SESSION_ID, no CLAUDE_CODE_SESSION_ID (batch A, Part 1's environment scrub).
export const launcherEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "HL_SESSION_ID" && k !== "CLAUDE_CODE_SESSION_ID")),
  ...extra,
});

// ---------- the window launcher ----------
// The child never inherits this session's CLAUDE_* env (it would think it IS this session), except CLAUDE_CONFIG_DIR.
export const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => (!/^CLAUDE/i.test(k) || k === "CLAUDE_CONFIG_DIR") && k !== "AI_AGENT" && !/^HL_/.test(k))),
  ...extra,
});
export const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
// configDir: the launcher's CLAUDE_CONFIG_DIR (resolved), null when unset.
export function windowScript({ pidFile, name, workDir, banner, regId, claudeLine, configDir = process.env.CLAUDE_CONFIG_DIR ? CFG : null }) {
  return [
    "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    "Get-ChildItem env: | Where-Object { ($_.Name -like 'CLAUDE*' -and $_.Name -ne 'CLAUDE_CONFIG_DIR') -or $_.Name -eq 'AI_AGENT' -or $_.Name -like 'HL_*' } | ForEach-Object { Remove-Item -LiteralPath (\"env:\" + $_.Name) }",
    `$env:HL_SESSION_ID = ${psq(regId)}`, // the session hooks find this session's stop file by it
    // Windows Terminal may give a new window its own environment, not the launcher's: set the config dir explicitly.
    ...(configDir ? [`$env:CLAUDE_CONFIG_DIR = ${psq(configDir)}`] : []),
    // This host is the window's process (parent of claude): record it so the coordinator can close the window.
    `New-Item -ItemType Directory -Force -Path ${psq(path.dirname(pidFile))} | Out-Null`,
    `Set-Content -LiteralPath ${psq(pidFile)} -Encoding ascii -Value ($PID.ToString() + ' ' + (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'))`,
    `$Host.UI.RawUI.WindowTitle = ${psq(name)}`,
    `Set-Location -LiteralPath ${psq(workDir)}`,
    `Write-Host ${psq(banner)}`,
    claudeLine,
  ].join("\r\n");
}
export function windowCommand(name, workDir, ps1) {
  const hasWt = spawnSync("where.exe", ["wt"], { encoding: "utf8", timeout: 10000, windowsHide: true }).status === 0;
  // cmd /c ... & exit 0 wraps the host so the pane exits 0 when the host is killed - Windows Terminal (closeOnExit
  // default) keeps a pane open after a non-zero exit, so a bare killed host would leave a dead window behind.
  return hasWt ? ["wt.exe", ["-w", "new", "--title", name, "-d", workDir, "cmd", "/c", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ps1, "&", "exit", "0"]]
    : ["cmd.exe", ["/c", "start", "", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ps1]];
}
// Write the launcher script, start the window, wait for THIS launch's pid file (mtime after the spawn).
export function spawnWindow({ entry, ps1, script, exe, exeArgs, workDir }) {
  try { // housekeeping: launcher scripts older than 1 day
    for (const f of fs.readdirSync(os.tmpdir())) if (/^claude-handoff-.*\.ps1$/.test(f)) { const p = path.join(os.tmpdir(), f); if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.unlinkSync(p); }
  } catch {}
  fs.writeFileSync(ps1, script, "utf8");
  fs.rmSync(entry.pid_file, { force: true }); // a leftover pid file is never read as this window's (M5, N4)
  const t0 = Date.now();
  spawn(exe, exeArgs, { cwd: workDir, env: cleanEnv(), detached: true, stdio: "ignore" }).unref();
  const fresh = () => { try { return fs.statSync(entry.pid_file).mtimeMs >= t0 - 1000; } catch { return false; } };
  while (!fresh() && Date.now() - t0 < 20000) sleep(100);
  const latency = Date.now() - t0;
  sleep(150);
  return { launched: readPidFile(entry), latency };
}
