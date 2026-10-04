// Shared primitives of handoff-launch: the registry, process probes, liveness, transcripts, stop requests, kills and
// the window launcher. Used by launch.mjs (the CLI), merge.mjs, recover.mjs (the coordinator tick) and
// hooks/coord.mjs. Liveness is tri-state - running / gone / unknown: a failed, timed-out or empty probe is unknown,
// and unknown never writes {closed}, never reports STALE and never kills.
// Test hooks: HL_REGISTRY_DIR, HL_PROJECTS_DIR, HL_AGENTS_JSON (file standing in for `claude agents --json`),
// HL_FAKE_PROBE=fail|timeout (every process probe fails, or really times out after 0.3 s), HL_FAKE_CLAUDE=1 (with
// HL_AGENTS_JSON, `claude stop <id>` removes that agent from the file), CLAUDE_CONFIG_DIR (tests: a temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { fwd, stem } from "./merge-lib.mjs";

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
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
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

// ---------- process probes: a failure is remembered (probeWhy) and the caller reports unknown ----------
let lastWhy = null;
export const probeWhy = () => lastWhy;
function probe(cmd, argv, timeout, opts = {}) {
  const fake = process.env.HL_FAKE_PROBE;
  if (fake === "fail") { lastWhy = "process probe failed (HL_FAKE_PROBE=fail)"; return { ok: false, why: lastWhy }; }
  const r = fake === "timeout"
    ? spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 300 })
    : spawnSync(cmd, argv, { encoding: "utf8", timeout, windowsHide: true, ...opts });
  if (r.error?.code === "ETIMEDOUT") lastWhy = `${cmd} timed out`;
  else if (r.error) lastWhy = `${cmd} failed: ${r.error.code || r.error.message}`;
  else if (r.status === null && r.signal) lastWhy = `${cmd} ended by signal ${r.signal}`;
  else if (r.status !== 0) lastWhy = `${cmd} exited ${r.status}: ${String(r.stderr || "").trim().slice(0, 200)}`;
  else { lastWhy = null; return { ok: true, out: String(r.stdout || "") }; } // a success clears an older failure's reason
  return { ok: false, why: lastWhy };
}
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
export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
export const selfStart = () => new Date(Date.now() - process.uptime() * 1000).toISOString();
// The OS start time (ms) of <pid>; null off Windows, when the probe fails, or when there is no such process.
export function procStart(pid) {
  if (process.platform !== "win32") return null;
  const s = procInfo([pid])?.get(pid)?.start;
  return s ? Date.parse(s) : null;
}

// ---------- background sessions: `claude agents --json`, memoized per run ----------
// Statuses of an ended session that `claude agents --json` still lists (probe 3 records the real words).
const BG_ENDED = /^(stopped|exited|completed|failed|done|killed)$/i;
let agentsMemo, agentsWhy = null;
export function agentsList() {
  // A memoized failure restores its own reason: a later successful probe has cleared lastWhy.
  if (agentsMemo !== undefined) { if (agentsMemo === null) lastWhy = agentsWhy; return agentsMemo; }
  let txt = null;
  if (process.env.HL_FAKE_PROBE) probe("claude", ["agents", "--json"], 30000, { shell: true });
  else if (process.env.HL_AGENTS_JSON) { try { txt = fs.readFileSync(process.env.HL_AGENTS_JSON, "utf8"); } catch (e) { lastWhy = `cannot read HL_AGENTS_JSON: ${e.code}`; } }
  else { const r = probe("claude", ["agents", "--json"], 30000, { shell: true }); txt = r.ok ? r.out : null; }
  let v = null;
  if (txt != null && txt.trim()) { try { const j = JSON.parse(txt); if (Array.isArray(j)) v = j; else lastWhy = "claude agents --json is not a list"; } catch { lastWhy = "claude agents --json is not JSON"; } }
  else if (txt != null) lastWhy = "claude agents --json printed nothing";
  agentsMemo = v; agentsWhy = v ? null : lastWhy;
  return v;
}
export function refreshAgents() { agentsMemo = undefined; return agentsList(); }
export const listedAgent = (e, list) => list.find((a) => (e.session_id && a.sessionId === e.session_id) || (e.bg_id && a.id === e.bg_id));
// The one entry that appeared in `claude agents --json` since `before` and carries the launch name; null otherwise.
export function matchNewAgent(before, after, name) {
  const seen = new Set(before.map((a) => a?.id));
  const fresh = after.filter((a) => a && a.id && !seen.has(a.id) && [a.name, a.title, a.label].includes(name));
  return fresh.length === 1 ? fresh[0] : null;
}
function stopBg(id) {
  if (process.env.HL_FAKE_CLAUDE === "1" && process.env.HL_AGENTS_JSON) { // tests: the agent leaves the list
    const f = process.env.HL_AGENTS_JSON, list = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify(list.filter((a) => a.id !== id)));
    agentsMemo = undefined;
    return { ok: true };
  }
  return probe("claude", ["stop", id], 60000, { shell: true });
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
export function forgetLiveness(id) { if (id) liveMemo.delete(id); else liveMemo.clear(); agentsMemo = undefined; }
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

// ---------- transcripts ----------
const blocks = (x) => (Array.isArray(x?.message?.content) ? x.message.content : []);
export function transcriptOf(sid) {
  if (!sid || !fs.existsSync(PROJECTS)) return null;
  for (const d of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
export function tail(file, bytes = 2_000_000) {
  const fd = fs.openSync(file, "r"); const size = fs.fstatSync(fd).size; const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
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
// {found, idle, busy:[reasons], last, pending, turnDone, bgAgents, liveStatus, file} - no loop judgement here.
export function sessionState(e) {
  const list = agentsList(), a = list ? listedAgent(e, list) : null;
  const sid = e.session_id || a?.sessionId;
  const liveStatus = a ? String(a.status || a.state || "") : null;
  const file = transcriptOf(sid);
  if (!file) return { found: false, idle: false, busy: [], last: null, pending: 0, turnDone: false, bgAgents: 0, liveStatus, file: null };
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
  const busy = [];
  if (pending.length) busy.push(`${pending.length} tool call(s) outstanding`);
  if (!turnDone) busy.push("turn not finished");
  if (bgAgents) busy.push(`${bgAgents} background agent(s) running`);
  if (liveStatus && /busy|running|working/i.test(liveStatus)) busy.push(`live status ${liveStatus}`);
  return { found: true, idle: busy.length === 0, busy, last, pending: pending.length, turnDone, bgAgents, liveStatus, file };
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
  forgetLiveness(e.id);
  const lv = liveness(e);
  if (lv.state === "unknown") return { closed: false, line: `no kill: liveness unknown (${lv.why})` };
  if (lv.state === "running" && e.mode === "bg" && !e.bg_id) return { closed: false, line: "no kill: no background id recorded (never stopped)" };
  append({ kill_intent: e.id, name: e.name, kind, why, at: now() });
  if (lv.state === "gone") { append({ closed: e.name, id: e.id, at: now(), why: `${why} (already gone: ${lv.why})` }); return { closed: true, line: `already gone (${lv.why})` }; }
  const w = readPidFile(e);
  const r = e.mode === "bg" ? stopBg(e.bg_id) : probe("taskkill", ["/T", "/F", "/PID", String(w.host_pid)], 30000);
  forgetLiveness(e.id);
  const after = liveness(e);
  if (r.ok || after.state === "gone") { append({ closed: e.name, id: e.id, at: now(), why }); return { closed: true, line: r.ok ? "closed" : "closed (process gone after the kill)" }; }
  return { closed: false, line: `kill failed: ${r.why}; liveness now ${after.state}` };
}
// Why a merge session's lock must not be cleared or skipped now: it runs, its liveness is unknown, or it is still
// starting. null = demonstrably not running.
export function sessionBlocker(name, lock) {
  const reg = readRegistry();
  const e = [...reg.entries].reverse().find((x) => x.name === name);
  if (!e) return null;
  const lv = liveness(e, reg);
  return lv.state === "gone" ? null : { kind: lv.state, text: lv.why };
}

// ---------- the coordinator: session hooks file and the tick trigger ----------
// <config>/skills/handoff-launch -> <config>/hooks/coord.mjs (the repo has the same layout: claude/skills, claude/hooks).
export const COORD_MJS = path.resolve(HERE, "..", "..", "hooks", "coord.mjs");
// The hooks every launched session gets with --settings: PostToolUse (all tools) and Notification -> coord.mjs.
export function sessionHooksFile({ write = true } = {}) {
  const f = path.join(REG_DIR, "session-hooks.json");
  const cmd = (sub) => ({ type: "command", command: `node "${fwd(COORD_MJS)}" ${sub}`, timeout: 10 });
  const body = { hooks: { PostToolUse: [{ matcher: "*", hooks: [cmd("post-tool")] }], Notification: [{ hooks: [cmd("notify")] }] } };
  const text = JSON.stringify(body, null, 2) + "\n";
  let cur = null; try { cur = fs.readFileSync(f, "utf8"); } catch {}
  if (write && cur !== text) writeAtomic(f, text);
  return f;
}
// At most one tick per tickMin, from any trigger: claim it in tick.json, then start `coord.mjs tick` detached. Fails
// closed to "no tick" on any error; HL_NO_SPAWN records the claim and starts nothing.
export function triggerTick(by, tickMin = 5) {
  try {
    const f = path.join(COORD, "tick.json"), tj = readJson(f, {}) || {};
    if (Date.parse(tj.at) > Date.now() - tickMin * MIN) return false;
    writeAtomic(f, JSON.stringify({ ...tj, at: now(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return true;
    spawn(process.execPath, [COORD_MJS, "tick"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch { return false; }
}

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
  const hasWt = spawnSync("where.exe", ["wt"], { encoding: "utf8" }).status === 0;
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
