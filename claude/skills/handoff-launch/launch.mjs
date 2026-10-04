// Open a fresh, clean Claude Code session that picks up a handoff document.
// Usage:
//   node launch.mjs --repo <dir> --handoff <path> [--name <label>] --model <m> --effort <level> [--mode window|bg]
//                   [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>] [--force] [--no-close] [--stop-looping] [--dry-run]
//   node launch.mjs profile-args [--profile <names>] [--repo <work dir>]   (JSON {profile, args} for `claude --resume <id> <args>`)
//   node launch.mjs status --group <id> [--repo <dir>] [--no-merge] [--dry-run]   (rolling groups: merges first)
//   node launch.mjs group --group <id> --repo <dir> --integration <branch> --target <branch> [--test <cmd>]
//                   [--test-timeout-min <n>] [--mode window|bg] [--force]      (rolling-merge group config)
//   node launch.mjs merge --group <id> [--repo <dir>] [--lane <name>]          (merge finished lanes now)
//                   [--skip <lane> [--session <merge session>] --why <reason>] [--force] [--dry-run]
//   node launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]          (files finished lanes share with running ones)
//   node launch.mjs stop (--name <name> | --id <registry id>) [--why <text>]
//   node launch.mjs watchdog [--repo <dir>] [--stop-looping] [--dry-run]
//   window (default): a new Windows Terminal window running an interactive `claude` the user can watch and type into.
//   bg: a Claude Code background session (`claude --bg`), listed by `claude agents`, attach with `claude attach <id>`.
//   --worktree: run the session in <main repo>/.claude/worktrees/<slug> on <branch> (created from --base, default the
//     repo's HEAD, or reused). The main checkout is never checked out.
//   --group: tag parallel sessions (fan-out); `status --group` lists members and their done markers.
//   --profile a,b: lane profiles from profiles.json (union; lean implied; default lean; full = no profile flags): which
//     heavy plugins and MCP servers the session keeps. The session cap (<registry dir>/launch-config.json, defaults
//     max_sessions 6, min_free_gb 3) refuses a launch with exit 3 unless --force (ask the user first).
//   Every launch appends a line to sessions.jsonl (next to this file). After a window launch of generation N on a
//   repo+branch, windows of generations <= N-2 there are closed - only when their session is idle for >= 10 min;
//   a busy one gets a stop request instead and is retried by a later launch (--no-close disables all of it).
//   The watchdog (also run at every launch) flags looping sessions; --stop-looping requests a stop, and kills the
//   tree on a later run if the session is still looping 5+ min after the request.
// The new session never inherits this session's CLAUDE_* environment (that makes a child think it IS this session)
// and gets PATH fresh from the registry.
// Test hooks: HL_REGISTRY_DIR (registry, pid and stop files), HL_PROJECTS_DIR (transcript root, default
// ~/.claude/projects), HL_AGENTS_JSON (file standing in for `claude agents --json`), HL_FAKE_CLAUDE=1 (the window
// runs a sleeping powershell instead of claude), HL_NO_SPAWN=1 (record the launch - worktree, registry line - and
// start nothing; tests only), HL_PROFILES_JSON (profiles file), HL_CLAUDE_JSON (stands in for ~/.claude.json),
// HL_FREE_GB (free RAM in GB for the cap).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf } from "./merge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REG_DIR = path.resolve(process.env.HL_REGISTRY_DIR || HERE);
const REG = path.join(REG_DIR, "sessions.jsonl");
const PID_DIR = path.join(REG_DIR, "pids");
const STOP_DIR = path.join(REG_DIR, "stops");
const PROJECTS = path.resolve(process.env.HL_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects"));
const MIN = 60000;
const IDLE_CLOSE_MS = 10 * MIN, STUCK_MS = 30 * MIN, KILL_GRACE_MS = 5 * MIN, STOP_REPEAT_MS = 30 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const dry = flag("dry-run");
const now = () => new Date().toISOString();
const ago = (t) => Date.now() - Date.parse(t);
const mins = (ms) => `${Math.round(ms / MIN)} min`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The MAIN checkout root, also when <dir> is a linked worktree: registry key, worktree parent, done-marker home.
const mainRoot = (dir) => {
  const r = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return r.ok ? path.dirname(path.resolve(r.out)) : null;
};

// ---------- registry: launch lines + {closed} / {stop_requested} / {kill_intent} lines, append-only ----------
function readRegistry() {
  const entries = [], closed = new Set(), stops = new Map(), merges = [];
  if (fs.existsSync(REG)) for (const line of fs.readFileSync(REG, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.closed) closed.add(o.id || o.closed);
    else if (o.stop_requested) { if (!stops.has(o.stop_requested)) stops.set(o.stop_requested, []); stops.get(o.stop_requested).push(o); }
    else if (o.merged || o.merge_blocked) merges.push(o);
    else if (o.name && o.launched_at) entries.push(o);
  }
  return { entries, closed, stops, merges };
}
const append = (o) => { fs.mkdirSync(REG_DIR, { recursive: true }); fs.appendFileSync(REG, JSON.stringify(o) + "\n"); };
const reg = readRegistry();
const live = (e) => !reg.closed.has(e.id);
const mergeCtx = (root, group) => ({ readRegistry, append, launchMjs: fileURLToPath(import.meta.url), root, repoKey: key(root), group, sessionGone });
const rootArg = () => mainRoot(path.resolve(opt("repo", process.cwd())));

// ---------- processes ----------
function procInfo(pids) {
  if (!pids.length) return new Map();
  const script = `foreach($i in @(${pids.join(",")})){ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; `
    + `if(-not $p){ '{0}|DEAD|' -f $i } else { $s=''; try { $s=$p.StartTime.ToUniversalTime().ToString('o') } catch {}; '{0}|{1}|{2}' -f $i,$p.ProcessName,$s } }`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const m = new Map();
  for (const l of (r.stdout || "").split(/\r?\n/)) { const [p, n, s] = l.trim().split("|"); if (p) m.set(Number(p), { name: n, start: s || null }); }
  return m;
}
// True when a claude/node process runs anywhere under <pid>.
function hasClaudeBelow(pid) {
  const script = `$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; $q=@(${pid}); $hit=$false; `
    + `while($q.Count){ $c=@($all | Where-Object { $q -contains $_.ParentProcessId }); if($c | Where-Object { $_.Name -match '^(claude|node)(\\.exe)?$' }){ $hit=$true; break }; $q=@($c | ForEach-Object { $_.ProcessId }) }; $hit`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return /True/.test(r.stdout || "");
}
function readPidFile(e) {
  if (e.host_pid || !e.pid_file || !fs.existsSync(e.pid_file)) return e;
  const [p, s] = fs.readFileSync(e.pid_file, "utf8").trim().split(/\s+/);
  return { ...e, host_pid: Number(p) || null, host_start: s || null };
}
// PID-reuse guard: is e.host_pid still the window host we launched? {ok} or {ok:false, why, gone}.
function checkHost(e, info) {
  if (!e.host_pid) return { ok: false, why: "no pid recorded", gone: ago(e.launched_at) > 2 * MIN };
  const p = info.get(e.host_pid);
  if (!p || p.name === "DEAD") return { ok: false, why: "not running", gone: true };
  if (p.name.toLowerCase() !== "powershell") return { ok: false, why: `pid now belongs to ${p.name} (reused)`, gone: true };
  if (!p.start) return { ok: false, why: "start time unreadable", gone: false };
  const st = Date.parse(p.start);
  const bad = e.host_start ? Math.abs(st - Date.parse(e.host_start)) > 2000
    : (st > Date.parse(e.launched_at) + 5000 || st < Date.parse(e.launched_at) - MIN);
  return bad ? { ok: false, why: `process started ${p.start}, not the recorded window (reused)`, gone: true } : { ok: true };
}

// ---------- session state: `claude agents --json` + the transcript tail ----------
let agentsCache;
function agentsList() {
  if (agentsCache) return agentsCache;
  let txt = "[]";
  if (process.env.HL_AGENTS_JSON) txt = fs.readFileSync(process.env.HL_AGENTS_JSON, "utf8");
  else { const r = spawnSync("claude", ["agents", "--json"], { encoding: "utf8", shell: true, timeout: 30000 }); txt = r.stdout || "[]"; }
  try { agentsCache = JSON.parse(txt); } catch { agentsCache = []; }
  return agentsCache;
}
const liveAgent = (e) => agentsList().find((a) => (e.session_id && a.sessionId === e.session_id) || (e.bg_id && a.id === e.bg_id));
function transcriptOf(sid) {
  if (!sid || !fs.existsSync(PROJECTS)) return null;
  for (const d of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
function tail(file, bytes = 2_000_000) {
  const fd = fs.openSync(file, "r"); const size = fs.fstatSync(fd).size; const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
  const lines = buf.toString("utf8").split(/\r?\n/); if (n < size) lines.shift();
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const blocks = (x) => (Array.isArray(x?.message?.content) ? x.message.content : []);
// {found, idle, busy:[reasons], last, flags:[loop reasons], liveStatus}
function sessionState(e) {
  const a = liveAgent(e);
  const sid = e.session_id || a?.sessionId;
  const liveStatus = a ? String(a.status || a.state || "") : null;
  const file = transcriptOf(sid);
  if (!file) return { found: false, idle: false, busy: [], flags: [], liveStatus, last: null };
  const L = tail(file).filter((x) => !x.isSidechain);
  const last = [...L].reverse().find((x) => x.timestamp)?.timestamp || fs.statSync(file).mtime.toISOString();
  const used = new Map(), done = new Set();
  for (const x of L) for (const b of blocks(x)) {
    if (b.type === "tool_use") used.set(b.id, b); else if (b.type === "tool_result") done.add(b.tool_use_id);
  }
  const pending = [...used.keys()].filter((id) => !done.has(id));
  const conv = L.filter((x) => x.type === "assistant" || x.type === "user" || (x.type === "system" && x.subtype === "turn_duration"));
  const end = conv[conv.length - 1];
  const turnDone = end && (end.type === "system" || (end.type === "assistant" && end.message?.stop_reason === "end_turn"));
  const td = [...L].reverse().find((x) => x.type === "system" && x.subtype === "turn_duration");
  const bgAgents = td?.pendingBackgroundAgentCount || 0;
  const busy = [];
  if (pending.length) busy.push(`${pending.length} tool call(s) outstanding`);
  if (!turnDone) busy.push("turn not finished");
  if (bgAgents) busy.push(`${bgAgents} background agent(s) running`);
  if (liveStatus && /busy|running|working/i.test(liveStatus)) busy.push(`live status ${liveStatus}`);
  // Loop flags: (a) same tool call x4 in the last 20 entries, (b) stuck on an outstanding call >= 30 min,
  // (c) repeated goal-gate nudges.
  const flags = [], counts = new Map();
  for (const x of conv.slice(-20)) for (const b of blocks(x)) if (b.type === "tool_use") {
    const k = `${b.name} ${JSON.stringify(b.input)}`; counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const [k, c] of counts) if (c >= 4) flags.push(`same tool call x${c} in the last 20 entries: ${k.slice(0, 120)}`);
  if (pending.length && ago(last) >= STUCK_MS && !/block|wait|input|permission/i.test(liveStatus || ""))
    flags.push(`tool call outstanding with no transcript activity for ${mins(ago(last))}`);
  const nudges = conv.slice(-60).filter((x) => x.type === "user" && typeof x.message?.content === "string"
    && /^Stop hook feedback:/.test(x.message.content) && /Goal gate/.test(x.message.content)).length;
  // goal-gate allows MAX_BLOCKS=3 + 1 "report honestly" nudge per turn by design, so 3 is normal; flag only beyond that.
  if (nudges >= 5) flags.push(`goal-gate nudge x${nudges} in the last 60 entries`);
  return { found: true, idle: busy.length === 0, busy, flags, liveStatus, last };
}

// ---------- stop request (graceful) and kill (last resort, always after a written reason) ----------
const STOP_TEXT = (why) => `STOP REQUEST from handoff-launch (${why}): finish or cancel your in-flight tool call, `
  + "TaskStop every background agent you started, record your state in your ledger/handoff, then end your turn and start no new work.";
function requestStop(e, why, apply, force = false) {
  const prev = (reg.stops.get(e.id) || []).at(-1);
  if (!force && prev && ago(prev.at) < STOP_REPEAT_MS) return `stop already requested ${mins(ago(prev.at))} ago (${prev.why})`;
  if (!apply) return `would request stop: ${why}`;
  fs.mkdirSync(STOP_DIR, { recursive: true });
  const file = path.join(STOP_DIR, `${stem(e.id)}.stop.json`);
  fs.writeFileSync(file, JSON.stringify({ id: e.id, name: e.name, session_id: e.session_id, why, at: now(), text: STOP_TEXT(why) }, null, 2));
  append({ stop_requested: e.id, name: e.name, why, at: now(), file: fwd(file) });
  return `stop requested: ${why} -> deliver with SendMessage to '${e.name}': ${STOP_TEXT(why)}`;
}
function killSession(e, why) {
  append({ kill_intent: e.id, name: e.name, why, at: now() });
  if (e.mode === "bg") {
    const r = spawnSync("claude", ["stop", e.bg_id || ""], { encoding: "utf8", shell: true, timeout: 60000 });
    if (r.status === 0) { append({ closed: e.name, id: e.id, at: now(), why }); return "stopped (claude stop)"; }
    return `claude stop failed: ${(r.stderr || r.stdout || "").trim()}`;
  }
  const k = spawnSync("taskkill", ["/T", "/F", "/PID", String(e.host_pid)], { encoding: "utf8" });
  if (k.status === 0) { append({ closed: e.name, id: e.id, at: now(), why }); return "closed"; }
  return `taskkill failed: ${(k.stderr || k.stdout || "").trim()}`;
}

// ---------- auto-close: windows of generations <= N-2 on this repo+branch, idle sessions only ----------
function closeOld(repoKey, branch, n, apply) {
  const cands = reg.entries.filter((e) => e.repo === repoKey && e.branch === branch && e.mode === "window"
    && (e.generation || 0) <= n - 2 && live(e)).map(readPidFile);
  const info = procInfo(cands.filter((e) => e.host_pid).map((e) => e.host_pid));
  const out = [];
  for (const e of cands) {
    const tag = `${e.name} (gen ${e.generation}, pid ${e.host_pid ?? "?"})`;
    const h = checkHost(e, info);
    if (!h.ok) {
      if (h.gone && apply) append({ closed: e.name, id: e.id, at: now(), why: h.why });
      out.push(`skip ${tag}: ${h.why}${h.gone ? (apply ? " - marked closed" : " - would mark closed") : ""}`); continue;
    }
    const s = sessionState(e);
    let closable, why;
    if (!s.found) { closable = !hasClaudeBelow(e.host_pid); why = closable ? "no claude running in the window" : "no transcript found but claude is running"; }
    else if (!s.idle) { closable = false; why = `busy: ${s.busy.join(", ")}`; }
    else if (ago(s.last) < IDLE_CLOSE_MS) { out.push(`skip ${tag}: idle only ${mins(ago(s.last))} - a later launch retries`); continue; }
    else { closable = true; why = `idle ${mins(ago(s.last))}`; }
    if (!closable) { out.push(`skip ${tag}: ${why} - ${requestStop(e, `auto-close of gen ${e.generation}: ${why}`, apply)}`); continue; }
    out.push(apply ? `${killSession(e, `auto-close: ${why}`)} ${tag}: ${why}` : `would close ${tag}: ${why}`);
  }
  return out;
}

// ---------- watchdog: flag looping sessions; --stop-looping stops them, then kills after the grace period ----------
function watchdog(repoKey, stopLooping, apply) {
  const out = [];
  const cands = reg.entries.filter((e) => live(e) && (!repoKey || e.repo === repoKey)).map(readPidFile);
  const info = procInfo(cands.filter((e) => e.mode === "window" && e.host_pid).map((e) => e.host_pid));
  for (const e of cands) {
    const s = sessionState(e);
    if (!s.found || !s.flags.length) continue;
    const tag = `${e.name} (${e.branch}, gen ${e.generation})`;
    out.push(`LOOPING ${tag}: ${s.flags.join(" | ")}`);
    if (!stopLooping) continue;
    const prev = (reg.stops.get(e.id) || []).filter((x) => /^watchdog/.test(x.why)).at(-1);
    if (prev && ago(prev.at) >= KILL_GRACE_MS) {
      if (e.mode === "window") {
        const h = checkHost(e, info);
        if (!h.ok) { out.push(`  no kill: ${h.why}`); if (h.gone && apply) append({ closed: e.name, id: e.id, at: now(), why: h.why }); continue; }
      }
      out.push(apply ? `  ${killSession(e, `watchdog: still looping ${mins(ago(prev.at))} after the stop request: ${s.flags[0]}`)}`
        : `  would kill: still looping ${mins(ago(prev.at))} after the stop request`);
    } else out.push(`  ${requestStop(e, `watchdog: ${s.flags[0]}`, apply)}`);
  }
  return out.length ? out : ["no looping sessions"];
}

// Is the latest launch of session <name> demonstrably still running? A text naming its host ("host pid N" / "bg session
// <id>"), or null when it is closed, gone, or unprovable (no pid recorded, e.g. an HL_NO_SPAWN test launch).
function sessionRunning(name) {
  const e = [...reg.entries].reverse().find((x) => x.name === name);
  if (!e || !live(e)) return null;
  if (e.mode === "bg") { const a = liveAgent(e); return a ? `bg session ${e.bg_id || a.id}` : null; }
  const w = readPidFile(e);
  if (!w.host_pid) return null;
  return checkHost(w, procInfo([w.host_pid])).ok ? `host pid ${w.host_pid}` : null;
}
// True when the session <name> (a merge session holding merge.lock) has demonstrably ended: its latest registry entry
// is closed, a bg entry no longer listed by `claude agents`, or a window entry whose host checkHost calls gone (dead or
// reused pid; no pid recorded only after 2 min). Unknown is not gone. Reads the registry fresh (it changes mid-run).
function sessionGone(name) {
  const r = readRegistry();
  const e = [...r.entries].reverse().find((x) => x.name === name);
  if (!e) return false;
  if (r.closed.has(e.id)) return true;
  if (e.mode === "bg") return !liveAgent(e);
  const w = readPidFile(e);
  return !!checkHost(w, w.host_pid ? procInfo([w.host_pid]) : new Map()).gone;
}

// ---------- lane profiles (profiles.json): the heavy plugins and MCP servers a session keeps ----------
// list: "a,b" (lean implied; undefined = the file's default; "full" anywhere = no profile flags). workDirs: the dir(s)
// whose .mcp.json names project servers (first hit wins, after ~/.claude.json mcpServers). -> {profile, args}: the
// canonical sorted name list (or "full") and the claude args. The args must be followed by another option, never
// directly by the prompt: --mcp-config is variadic and would take the prompt as a second config file.
// Both files are content-addressed under <REG_DIR>/profiles (they can hold MCP env values: never in a repo).
// Stage 2 folds its session hooks in by passing them as baseSettings and dropping its own --settings flag: two
// --settings flags do not merge, the last one wins entirely. With baseSettings, "full" also gets a --settings file.
function profileArgs(list, workDirs, baseSettings = {}) {
  const fail = (m) => { console.error(m); process.exit(2); };
  const file = path.resolve(process.env.HL_PROFILES_JSON || path.join(HERE, "profiles.json"));
  let cfg; try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(`profiles file ${fwd(file)} is missing or not valid JSON: ${e.message}`); }
  const P = cfg?.profiles;
  const shapeOk = P && typeof P === "object" && !Array.isArray(P) && Array.isArray(cfg.heavy_plugins) && Object.hasOwn(P, cfg.default)
    && Object.values(P).every((p) => p === null || (Array.isArray(p?.plugins) && Array.isArray(p?.mcp)));
  if (!shapeOk) fail(`profiles file ${fwd(file)} is invalid: needs "default" (a profile name), "heavy_plugins" [..] and "profiles" {name: {plugins: [..], mcp: [..]} | null}`);
  if (flag("profile") && (!list || list.startsWith("--"))) fail(`--profile needs a comma list of names: ${Object.keys(P).join(", ")}`);
  const names = [...new Set(String(list ?? cfg.default).split(",").map((s) => s.trim()).filter(Boolean))];
  const unknown = names.filter((n) => !Object.hasOwn(P, n));
  if (unknown.length || !names.length) fail(`unknown profile ${unknown.join(", ") || "(empty)"} - valid: ${Object.keys(P).join(", ")}`);
  const dir = path.join(REG_DIR, "profiles");
  const write = (stemName, kind, obj) => {
    const txt = JSON.stringify(obj, null, 2) + "\n";
    const f = path.join(dir, `${stemName}-${crypto.createHash("sha256").update(txt).digest("hex").slice(0, 8)}.${kind}.json`);
    if (!fs.existsSync(f)) {
      fs.mkdirSync(dir, { recursive: true }); const t = `${f}.${process.pid}.tmp`;
      // A parallel launch may win the rename (Windows refuses to replace an open file): same name = same content.
      try { fs.writeFileSync(t, txt); fs.renameSync(t, f); } catch (e) {
        fs.rmSync(t, { force: true });
        if (!fs.existsSync(f)) throw new Error(`cannot write the profile file ${fwd(f)}: ${e.message}`);
      }
    }
    return fwd(f);
  };
  if (names.some((n) => P[n] === null)) return { profile: "full", args: Object.keys(baseSettings).length ? ["--settings", write("full", "settings", baseSettings)] : [] };
  const picked = names.filter((n) => n !== "lean"), profile = picked.length ? picked.sort().join(",") : "lean";
  const keep = (k) => new Set([...(P.lean?.[k] || []), ...picked.flatMap((n) => P[n][k])]);
  const plugins = keep("plugins"), mcp = keep("mcp");
  const settings = { ...baseSettings, enabledPlugins: { ...baseSettings.enabledPlugins, ...Object.fromEntries(cfg.heavy_plugins.filter((p) => !plugins.has(p)).map((p) => [p, false])) } };
  const servers = {};
  if (mcp.size) {
    const readServers = (f) => {
      if (!fs.existsSync(f)) return {};
      let s; try { s = JSON.parse(fs.readFileSync(f, "utf8"))?.mcpServers; } catch (e) { fail(`${fwd(f)} is not valid JSON (needed for the MCP servers of profile ${profile}): ${e.message}`); }
      return s && typeof s === "object" ? s : {};
    };
    const sources = [process.env.HL_CLAUDE_JSON || path.join(os.homedir(), ".claude.json"), ...[].concat(workDirs).map((d) => path.join(d, ".mcp.json"))].map(readServers);
    const missing = [];
    for (const n of mcp) { const hit = sources.find((s) => Object.hasOwn(s, n)); if (hit) servers[n] = hit[n]; else missing.push(n); }
    if (missing.length) fail(`profile ${profile}: MCP server ${missing.join(", ")} not found in ~/.claude.json mcpServers or ${[].concat(workDirs).map((d) => fwd(path.join(d, ".mcp.json"))).join(" / ")}`);
  }
  const stemName = profile.replace(/,/g, "+");
  return { profile, args: ["--settings", write(stemName, "settings", settings), "--strict-mcp-config", "--mcp-config", write(stemName, "mcp", { mcpServers: servers })] };
}

// ---------- session cap: refuse a launch while too many sessions run or free RAM is low ----------
// Config <REG_DIR>/launch-config.json {max_sessions, min_free_gb} (defaults 6 / 3). Counts the live sessions except the
// newest one on this repo+branch (the predecessor a relay replaces). Exits 3 on a breach unless --force; --dry-run only
// reports. -> {running, max, free_gb, min_free_gb, would_refuse}.
function sessionCap(repoKey, branch) {
  const file = path.join(REG_DIR, "launch-config.json");
  let max = 6, minFree = 3;
  if (fs.existsSync(file)) try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("not a JSON object");
    if (c.max_sessions !== undefined && !(Number.isInteger(c.max_sessions) && c.max_sessions >= 1)) throw new Error("max_sessions must be an integer >= 1");
    if (c.min_free_gb !== undefined && !(Number.isFinite(c.min_free_gb) && c.min_free_gb >= 0)) throw new Error("min_free_gb must be a number >= 0");
    max = c.max_sessions ?? max; minFree = c.min_free_gb ?? minFree;
  } catch (e) { console.error(`WARN ${fwd(file)}: ${e.message} - using the defaults max_sessions=6 min_free_gb=3`); }
  const latest = new Map();
  for (const e of reg.entries) if (!latest.has(e.id) || latest.get(e.id).launched_at <= e.launched_at) latest.set(e.id, e);
  const alive = [...latest.values()].filter(live);
  const pred = alive.filter((e) => e.repo === repoKey && e.branch === branch).reduce((a, e) => (!a || a.launched_at <= e.launched_at ? e : a), null);
  const cands = alive.filter((e) => e !== pred).map(readPidFile);
  const info = procInfo(cands.filter((e) => e.mode !== "bg" && e.host_pid).map((e) => e.host_pid));
  const counted = [];
  for (const e of cands) {
    const tag = `${e.name} (${e.branch})`;
    if (e.mode === "bg") {
      const a = liveAgent(e), st = a ? String(a.status || a.state || "").trim() : "";
      if (a && !/^(done|failed|completed|stopped|exited)$/i.test(st)) counted.push(`${tag}: running - bg session ${a.id || e.bg_id}${st ? ` status ${st}` : ""}`);
      continue;
    }
    const h = checkHost(e, info);
    if (h.ok) counted.push(`${tag}: running - host pid ${e.host_pid}`);
    else if (!h.gone) counted.push(`${tag}: doubtful, counted - ${h.why}`);
  }
  const free = process.env.HL_FREE_GB !== undefined ? Number(process.env.HL_FREE_GB) : os.freemem() / 2 ** 30;
  const why = [];
  if (counted.length >= max) why.push(`${counted.length} sessions running, max_sessions ${max}`);
  if (free < minFree) why.push(`${free.toFixed(1)} GB free RAM, min_free_gb ${minFree}`);
  const cap = { running: counted.length, max, free_gb: Math.round(free * 10) / 10, min_free_gb: minFree, would_refuse: why.length > 0 };
  if (!why.length || dry) return cap;
  // Merge sessions skip the cap, so here --force only overrides the cap (its merge-only meanings need <group>-merge).
  if (flag("force")) { console.error(`session cap overridden by --force: ${why.join("; ")}`); return cap; }
  console.error([`refused - session cap: ${why.join("; ")} (config ${fwd(file)})`, ...counted.map((l) => `  ${l}`),
    "close idle sessions first, or pass --force (ask the user first)"].join("\n"));
  process.exit(3);
}

// ---------- subcommands ----------
// One status line per lane in the legacy format; rolling groups append the merge state and overlap. known: the marker
// groupLanes already loaded (rolling groups - a non-object marker is {unreadable:true} there); legacy reads the file.
function memberLine(e, known) {
  let marker = null, done = false;
  if (known !== undefined) { marker = known && { ...known }; done = !!known && !known.unreadable; }
  else if (e.done_marker && fs.existsSync(e.done_marker)) {
    try { marker = JSON.parse(fs.readFileSync(e.done_marker, "utf8")); done = true; } catch { marker = { unreadable: true }; }
    // A literal null marker is broken, not done: it must never make all_done=true (false/0/"" keep their old output).
    if (marker === null) { marker = { unreadable: true }; done = false; }
  }
  if (marker && !marker.unreadable) {
    const tip = marker.head && e.branch ? git(e.repo || ".", "rev-parse", "--short", e.branch).out : "";
    if (tip && !String(marker.head).startsWith(tip) && !tip.startsWith(String(marker.head))) marker.warn = `branch tip ${tip} != marker head`;
  }
  const next = marker?.next_after_merge?.length ? ` next_after_merge=${JSON.stringify(marker.next_after_merge)}` : "";
  const m = marker?.unreadable ? "UNREADABLE marker (not counted as done)" : marker ? `${marker.warn ? `WARN ${marker.warn}  ` : ""}${String(marker.status || "done").toUpperCase()}  head=${marker.head ?? "?"} tests=${marker.tests ?? "?"}${next}` : "open (lane still running its stages)";
  return { done, text: `${e.name.padEnd(28)} ${String(e.branch).padEnd(30)} ${m}${live(e) ? "" : "  (window closed)"}` };
}
// Rolling group: drain first (unless --no-merge or --dry-run), then the lanes with their merge state and overlap, then
// the summary. --dry-run writes nothing: no merge, no launch, no overlap in the done markers.
function rollingStatus(group, root, c) {
  if (!c.ok) { for (const e of c.errors) console.log(`ERROR config: ${e}`); return 1; }
  const ctx = mergeCtx(root, group);
  if (!flag("no-merge") && !dry) for (const l of drain(ctx).lines) console.log(`merge: ${l}`);
  const { lanes } = lanesNow(ctx, c.config);
  refreshOverlap(root, c.config, lanes, { write: !dry });
  for (const l of lanes) {
    const tag = mergeTag(l), ov = l.marker?.overlap && Object.keys(l.marker.overlap).length ? `  overlap=${JSON.stringify(l.marker.overlap)}` : "";
    console.log(`${memberLine(l.entry, l.marker).text}${tag ? `  ${tag}` : ""}${ov}`);
  }
  const lock = readLock(groupDir(root, group));
  console.log(rollingSummary(lanes, lock, { state: lock ? lockStateOf(lock, c.config) : null, sessionClosed: lock?.holder === "session" && ctx.sessionGone(lock.session) }));
  return 0;
}
if (sub === "status") {
  const group = opt("group");
  if (!group) { console.error("status needs --group <id>"); process.exit(2); }
  const repoKey = opt("repo") ? key(mainRoot(path.resolve(opt("repo"))) || opt("repo")) : null;
  const latest = new Map();
  for (const e of reg.entries) {
    if (e.group !== slug(group) || (repoKey && e.repo !== repoKey)) continue;
    const prev = latest.get(e.name);
    if (!prev || prev.launched_at < e.launched_at) latest.set(e.name, e);
  }
  const mergeName = `${slug(group)}-merge`;
  // Legacy filter kept as it was (only <group>-merge is not a member); rolling lanes come from lanesNow, which also
  // drops the <group>-merge-<lane> sessions.
  const members = [...latest.values()].filter((e) => e.name !== mergeName);
  const gdir = members[0]?.done_marker ? path.dirname(members[0].done_marker) : null;
  const cfg = gdir ? readConfig(gdir) : null;
  if (cfg) process.exit(rollingStatus(slug(group), path.resolve(gdir, "..", "..", ".."), cfg));
  // No lane to locate the group by: a group configured in --repo (or the cwd's repo) is rolling even with 0 lanes.
  const root = gdir ? null : rootArg(), rootCfg = root ? readConfig(groupDir(root, slug(group))) : null;
  if (rootCfg) process.exit(rollingStatus(slug(group), root, rootCfg));
  let done = 0;
  for (const e of members) { const m = memberLine(e); if (m.done) done++; console.log(m.text); }
  const lockFile = gdir ? path.join(gdir, "merge.lock") : null;
  const lock = !!lockFile && fs.existsSync(lockFile);
  console.log(`members=${members.length} done=${done} all_done=${members.length > 0 && done === members.length} merge_launched=${latest.has(mergeName)} merge_lock=${lock}${lock && !latest.has(mergeName) ? " (STALE lock: no merge entry - relaunch the merge with --force)" : ""}`);
  process.exit(0);
}
if (sub === "stop") {
  const id = opt("id"), nm = opt("name");
  const e = [...reg.entries].reverse().find((x) => (id && x.id === id) || (nm && x.name === nm));
  if (!e) { console.error("no registry entry for that --name/--id"); process.exit(2); }
  console.log(requestStop(e, opt("why", "requested"), !dry, true));
  process.exit(0);
}
if (sub === "watchdog") {
  const repoKey = opt("repo") ? key(mainRoot(path.resolve(opt("repo"))) || opt("repo")) : null;
  for (const l of watchdog(repoKey, flag("stop-looping"), !dry)) console.log(l);
  process.exit(0);
}
if (sub === "group") {
  const group = opt("group") && slug(opt("group")), root = rootArg();
  if (!group || !root || !opt("integration") || !opt("target")) {
    console.error("group needs --group <id> --repo <git repo> --integration <branch> --target <branch> [--test <cmd>] [--test-timeout-min <n>] [--mode window|bg] [--force]");
    process.exit(2);
  }
  const allowed = ["--group", "--repo", "--integration", "--target", "--test", "--test-timeout-min", "--mode", "--force"];
  const valued = ["--group", "--repo", "--integration", "--target", "--test", "--test-timeout-min", "--mode"];
  const bad = [];
  for (let i = 1; i < args.length; i++) if (args[i].startsWith("--")) { if (!allowed.includes(args[i])) bad.push(args[i]); else if (valued.includes(args[i])) i++; }
  if (bad.length) { console.error(`group: unknown flag ${bad.join(", ")} (allowed: ${allowed.join(" ")})`); process.exit(2); }
  // A group that already launched lanes keeps the flow it started with: legacy groups have no config.json.
  if (!readConfig(groupDir(root, group)) && reg.entries.some((e) => e.group === group && e.repo === key(root)) && !flag("force")) {
    console.error(`group ${group} already launched sessions without a config.json - it stays a legacy (all_done) group. Pick a new group id.`);
    process.exit(3);
  }
  const t = opt("test-timeout-min");
  const r = writeConfig(root, group, { integration: opt("integration"), target: opt("target"), test: opt("test"), test_timeout_min: t === undefined ? undefined : Number(t), mode: opt("mode") }, flag("force"));
  if (!r.ok) { for (const e of r.errors) console.error(e); process.exit(2); }
  console.log(`wrote ${fwd(r.file)}: ${JSON.stringify(r.config)}`);
  if (r.warn) console.log(`WARN ${r.warn}`);
  process.exit(0);
}
if (sub === "merge") {
  const group = opt("group") && slug(opt("group")), root = rootArg();
  if (!group || !root) { console.error("merge needs --group <id> [--repo <main repo or one of its worktrees>] [--lane <name>] [--skip <lane> [--session <merge session>] --why <reason>] [--force] [--dry-run]"); process.exit(2); }
  const val = (k) => { const v = opt(k); return v === undefined || v.startsWith("--") ? null : v; };
  if (flag("skip") && !val("skip")) { console.error("--skip needs a lane name: merge --group <id> --skip <lane> --why <reason>"); process.exit(2); }
  if (flag("why") && !val("why")) { console.error("--why needs a reason"); process.exit(2); }
  if (flag("session") && !val("session")) { console.error("--session needs the merge session's name"); process.exit(2); }
  const ctx = mergeCtx(root, group), gd = groupDir(root, group), lane = val("lane") && slug(val("lane"));
  // Legacy groups (no config.json) keep their flow untouched: --force/--skip/--dry-run never touch their merge.lock.
  const c = readConfig(gd);
  if (!c) { console.log(legacyText(group)); process.exit(0); }
  if (!c.ok) { for (const e of c.errors) console.log(`ERROR config: ${e}`); process.exit(1); }
  // --dry-run runs before --force/--skip/drain: it never merges, launches or writes anything (no overlap either).
  if (dry) {
    console.log(`would merge, in order: [${mergeQueue(lanesNow(ctx, c.config).lanes, lane).map((l) => l.name).join(",")}]; merge.lock: ${describeLock(readLock(gd))}`);
    process.exit(0);
  }
  // --skip before --force: skip needs the session lock's head (for a lane whose marker has none).
  if (flag("skip")) {
    // A running merge session that holds this lane may be about to `git merge` in the merge worktree (no MERGE_HEAD
    // yet): only that session itself (its handoff's skip command passes --session <its name>) may give the lane up.
    const held = readLock(gd), skipName = slug(val("skip"));
    if (held?.holder === "session" && held.lane === skipName && val("session") !== held.session && sessionRunning(held.session)) {
      console.log(`not skipped: ${held.session} is still running and holds ${skipName} - let it finish, or stop it (launch.mjs stop --name ${held.session}) and re-run`);
      process.exit(1);
    }
    const s = skipLane(ctx, skipName, val("why") || "skipped by hand");
    console.log(s.line);
    if (!s.ok) process.exit(1);
  }
  if (flag("force")) {
    // A merge session that is still running owns its lock and the merge worktree: clearing the lock would let the drain
    // launch a second session into the same worktree. Refused only when it is demonstrably running.
    const held = readLock(gd), running = held?.holder === "session" ? sessionRunning(held.session) : null;
    if (running) { console.log(`not cleared: ${held.session} is still running (${running}) - launch.mjs stop --name ${held.session} or close its window, then re-run`); process.exit(1); }
    const f = forceUnlock(ctx);
    console.log(f.line);
    if (!f.ok) process.exit(1);
  }
  const r = drain(ctx, { prefer: lane });
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
if (sub === "overlap") {
  const group = opt("group") && slug(opt("group")), root = rootArg();
  if (!group || !root) { console.error("overlap needs --group <id> [--repo <dir>] [--dry-run]"); process.exit(2); }
  const c = readConfig(groupDir(root, group));
  if (!c) { console.error(`overlap needs a rolling-merge group (config.json with the target branch) - ${legacyText(group)}`); process.exit(2); }
  if (!c.ok) { for (const e of c.errors) console.error(`ERROR config: ${e}`); process.exit(1); }
  const pairs = refreshOverlap(root, c.config, lanesNow(mergeCtx(root, group), c.config).lanes, { write: !dry });
  for (const p of pairs) console.log(`${p.finished} (finished) <-> ${p.running} (running): ${p.files.join(", ")}`);
  if (!pairs.length) console.log("no overlap between finished and running lanes");
  process.exit(0);
}
if (sub === "profile-args") {
  console.log(JSON.stringify(profileArgs(opt("profile"), path.resolve(opt("repo", process.cwd())))));
  process.exit(0);
}
if (sub) { console.error(`unknown subcommand ${sub}`); process.exit(2); }

// ---------- launch ----------
const repo = path.resolve(opt("repo", process.cwd()));
const handoffArg = opt("handoff");
const mode = opt("mode", "window");
if (!/^(window|bg)$/.test(mode)) { console.error(`--mode must be window or bg, got ${mode}`); process.exit(2); }
if (mode === "window" && process.platform !== "win32" && process.env.HL_FAKE_CLAUDE !== "1") {
  console.error("--mode window opens Windows Terminal/PowerShell and only works on Windows - use --mode bg, or adapt the window launcher for this OS");
  process.exit(2);
}
const model = opt("model");
const effort = opt("effort"); // low|medium|high|xhigh|max - pick per task before launching
// Never inherit the global defaults: each session is sized for its task (SKILL.md "Sizing the session").
if (!model || !effort) { console.error("--model and --effort are required - size the session for its task (see SKILL.md 'Sizing the session')"); process.exit(2); }
if (!/^(low|medium|high|xhigh|max)$/.test(effort)) { console.error(`--effort must be low|medium|high|xhigh|max, got ${effort}`); process.exit(2); }
if (/haiku/i.test(model)) { console.error("never Haiku for a session"); process.exit(2); }
if (/sonnet/i.test(model)) { console.error("never sonnet as a session (sonnet is a mechanical subagent tier)"); process.exit(2); }
const noClose = flag("no-close");
const wtBranch = opt("worktree");
const group = opt("group") ? slug(opt("group")) : null;
if (!handoffArg) { console.error("missing --handoff <path>"); process.exit(2); }
const handoff = [path.resolve(repo, handoffArg), path.resolve(handoffArg)].find((p) => fs.existsSync(p)) || path.resolve(repo, handoffArg);
if (!fs.existsSync(handoff)) { console.error(`handoff not found: ${handoff}`); process.exit(2); }
const name = slug(opt("name") || path.basename(handoff, ".md"));
const root = mainRoot(repo);
if (wtBranch && !root) { console.error(`--worktree needs a git repo: ${repo}`); process.exit(2); }
// Session cap: before any side effect (merge.lock, --reopen marker rename, worktree, registry line). Same branch and
// repo key as the registry entry below gets. Merge sessions (merge.mjs drain launches them without --force) are exempt.
const cap = group && isMergeSession(group, name) ? { exempt: "merge session" }
  : sessionCap(key(root || repo), wtBranch || (root && git(repo, "branch", "--show-current").out) || (root ? "HEAD" : null));

// Group guards run before any worktree is created or touched.
const mergeName = group ? `${group}-merge` : null;
// Rolling-merge groups have a config.json (written by `launch.mjs group`); groups without one keep the legacy flow.
const groupCfg = group && root ? readConfig(groupDir(root, group)) : null;
if (groupCfg && !groupCfg.ok) { console.error(`group ${group} config.json is invalid: ${groupCfg.errors.join("; ")}`); process.exit(2); }
if (groupCfg && name === mergeName) {
  console.error(`${group} is a rolling-merge group: lanes merge via launch.mjs merge, and the final merge into ${groupCfg.config.target} is done by hand with the user - there is no ${mergeName} session.`);
  process.exit(3);
}
if (group && name === mergeName && reg.entries.some((e) => e.group === group && e.name === name) && !flag("force")) {
  console.error(`${name} was already launched (see status --group ${group}) - another child got there first. --force to relaunch.`);
  process.exit(3);
}
const doneMarker = group ? path.join(root || repo, ".superpowers", "sessions", group, `${name}.done`) : null;
// Two lanes finishing within the registry-append window must not both launch the merge: an exclusive lock file decides.
if (group && name === mergeName && !dry && !flag("force")) {
  const lock = path.join(path.dirname(doneMarker), "merge.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.closeSync(fs.openSync(lock, "wx")); } catch { console.error(`${name} is already being launched (${fwd(lock)} exists) - another lane got there first (if status shows no merge entry the lock is stale - relaunch with --force).`); process.exit(3); }
}
// A lane whose done marker exists is finished: relaunching it would read as DONE at once and its work would never be merged.
if (group && !isMergeSession(group, name) && doneMarker && fs.existsSync(doneMarker)) {
  let mergeStarted;
  if (groupCfg) { // rolling: refused once this lane's head is merged, or while merge.lock is held for this lane
    const me = classify(groupLanes({ entries: reg.entries, merges: reg.merges, group, repoKey: key(root), cfg: groupCfg.config, root })).find((l) => l.name === name);
    mergeStarted = me?.state === "merged" || readLock(path.dirname(doneMarker))?.lane === name;
  } else mergeStarted = fs.existsSync(path.join(path.dirname(doneMarker), "merge.lock")) || reg.entries.some((e) => e.group === group && e.name === mergeName);
  if (flag("reopen") && mergeStarted) {
    console.error(groupCfg ? `lane ${name} is already merged (or being merged) into ${groupCfg.config.integration} - start new work as a NEW lane or group (SKILL.md section 4).`
      : `merge for ${group} already launched - --reopen would start work nothing merges. Use a NEW group (SKILL.md section 4).`);
    process.exit(3);
  }
  if (!flag("reopen")) { console.error(`lane ${name} already wrote its done marker - start post-merge stages under a NEW group (see SKILL.md section 4), or pass --reopen to reopen this lane before the merge.`); process.exit(3); }
  if (!dry) fs.renameSync(doneMarker, `${doneMarker}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
}


// Worktree: reuse the branch's worktree, or create one under <main root>/.claude/worktrees/<slug>.
let workDir = repo, wtPlan = null;
if (wtBranch) {
  const list = worktrees(root);
  const hit = list.find((w) => w.branch === `refs/heads/${wtBranch}`);
  const dir = path.join(root, ".claude", "worktrees", slug(wtBranch));
  const branchExists = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${wtBranch}`).ok;
  if (hit && key(hit.worktree) === key(root)) {
    console.error(`branch ${wtBranch} is checked out in the main checkout ${root} - drop --worktree or pick another branch`);
    process.exit(2);
  } else if (hit && !hit.prunable) {
    wtPlan = { action: "reuse", dir: path.resolve(hit.worktree) };
  } else {
    const base = opt("base") || git(repo, "rev-parse", "HEAD").out;
    const cmd = branchExists ? ["worktree", "add", dir, wtBranch] : ["worktree", "add", dir, "-b", wtBranch, base];
    wtPlan = { action: hit ? "prune+create" : "create", dir, command: ["git", "-C", root, ...cmd] };
  }
  workDir = wtPlan.dir;
  if (!dry && wtPlan.action !== "reuse") {
    if (wtPlan.action === "prune+create") git(root, "worktree", "prune");
    const r = git(root, ...wtPlan.command.slice(3));
    if (!r.ok) { console.error(`git worktree add failed: ${r.err}`); process.exit(1); }
    // Keep the nested worktrees out of the main checkout's `git status` (local-only exclude, never committed).
    excludeWorktrees(root);
  }
  if (!dry) inheritLocalSettings(root, workDir);
}

// The main checkout's .claude/settings.local.json is gitignored, so a new worktree lacks its .mcp.json approvals and
// permission allowlist - the new session then stops on an "enable MCP servers?" prompt. Copy it in when missing;
// when present, union in the main checkout's approved servers and allow rules.
function inheritLocalSettings(mainDir, wtDir) {
  const src = path.join(mainDir, ".claude", "settings.local.json"), dst = path.join(wtDir, ".claude", "settings.local.json");
  if (!fs.existsSync(src) || key(mainDir) === key(wtDir)) return;
  let main; try { main = JSON.parse(fs.readFileSync(src, "utf8")); } catch { return; }
  let cur = {}; if (fs.existsSync(dst)) { try { cur = JSON.parse(fs.readFileSync(dst, "utf8")); } catch { return; } }
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  const out = { ...main, ...cur };
  out.enabledMcpjsonServers = union(main.enabledMcpjsonServers, cur.enabledMcpjsonServers);
  if (main.permissions || cur.permissions) out.permissions = { ...main.permissions, ...cur.permissions, allow: union(main.permissions?.allow, cur.permissions?.allow), deny: union(main.permissions?.deny, cur.permissions?.deny), ask: union(main.permissions?.ask, cur.permissions?.ask) };
  if (out.permissions) for (const k of ["deny", "ask"]) if (!out.permissions[k].length) delete out.permissions[k];
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");
}

const branch = (root && fs.existsSync(workDir) && git(workDir, "branch", "--show-current").out) || wtBranch || (root ? "HEAD" : null);
const repoKey = key(root || repo);
const generation = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === repoKey && e.branch === branch).map((e) => e.generation || 0));
// Lane profile: before anything is recorded or started (a dry run of a new worktree has no workDir yet).
const laneProfile = profileArgs(opt("profile"), [workDir, repo]);
// Short pointer prompt: the handoff file carries the real instructions. No double quotes or semicolons
// (Windows PowerShell 5.1 and wt.exe both mangle them). A worktree lacks the main checkout's untracked files,
// so outside the repo dir the handoff is named by its absolute path.
// A path with spaces stays one word for the session reading it. Single quotes: the prompt's " become ' anyway.
const qs = (p) => (/\s/.test(p) ? `'${p}'` : p);
const handoffRef = key(workDir) === key(repo) ? fwd(path.relative(repo, handoff)) : fwd(handoff);
const laneNote = !group || isMergeSession(group, name) ? ""
  : groupCfg ? ` Fan-out group ${group} (rolling merges): write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - then run node ${qs(fwd(fileURLToPath(import.meta.url)))} merge --group ${group} --repo ${qs(fwd(root))} --lane ${name} and report its output. Otherwise launch the lane next stage as the handoff says.`
  : ` Fan-out group ${group}: write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
const prompt = (`Continue from the handoff at ${qs(handoffRef)} - read it first, then follow its paste-ready prompt section exactly.` + laneNote)
  .replace(/"/g, "'").replace(/;/g, ",");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const id = `${name}@${stamp}`;
const pidFile = path.join(PID_DIR, `${stem(id)}.pid`);
const sessionId = mode === "window" ? crypto.randomUUID() : null;
const entry = {
  id, name, repo: repoKey, branch, worktree: fwd(workDir), generation, mode, group, title: name,
  handoff: fwd(handoff), done_marker: doneMarker && fwd(doneMarker), launched_at: now(), session_id: sessionId,
  host_pid: null, host_start: null, pid_file: mode === "window" ? fwd(pidFile) : null,
};
entry.profile = laneProfile.profile; // a restart reuses it: launch.mjs profile-args --profile <it>
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k) && k !== "AI_AGENT" && !/^HL_/.test(k)));
const stopLooping = flag("stop-looping");

if (mode === "bg") {
  const bgArgs = ["--bg", ...laneProfile.args, "-n", name, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), prompt];
  // bg on Windows runs through cmd.exe, which expands %VAR% even inside quoted args: refuse rather than mangle them.
  const pct = process.platform === "win32" && bgArgs.find((a) => String(a).includes("%"));
  if (pct) { console.error(`a bg argument contains % (cmd.exe would expand %VAR% in it) - move the handoff or the registry dir to a path without %: ${pct}`); process.exit(2); }
  console.log(JSON.stringify({ mode, worktree: wtPlan, registry_line: entry, prompt, command: ["claude", ...bgArgs], cap }, null, 2));
  console.log(["watchdog:", ...watchdog(repoKey, stopLooping, !dry)].join("\n  "));
  if (dry) process.exit(0);
  if (process.env.HL_NO_SPAWN === "1") { append(entry); console.log("HL_NO_SPAWN=1: recorded, not started"); process.exit(0); }
  // Windows needs a shell to resolve claude.cmd; pass one pre-quoted command string so the prompt stays ONE argument
  // (the prompt never contains double quotes - they are replaced above). Elsewhere spawn without a shell.
  const r = process.platform === "win32"
    ? spawnSync(["claude", ...bgArgs.map((a) => `"${a}"`)].join(" "), { cwd: workDir, env: cleanEnv, encoding: "utf8", shell: true, timeout: 120000 })
    : spawnSync("claude", bgArgs, { cwd: workDir, env: cleanEnv, encoding: "utf8", timeout: 120000 });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  // The bg CLI's output format is not pinned: keep it raw, plus a loose id guess (resolved to a session via `claude agents`).
  const m = /\b(?:session|id)\b[^\w]*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[\w-]{6,})/i.exec(r.stdout || "");
  append({ ...entry, bg_id: m ? m[1] : null, bg_output: (r.stdout || "").slice(0, 2000) });
  process.exit(r.status ?? 1);
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const claudeArgs = [...laneProfile.args.map(q), "-n", q(name), "--session-id", q(sessionId), ...(model ? ["--model", q(model)] : []), ...(effort ? ["--effort", q(effort)] : []), q(prompt)];
if (!dry && process.env.HL_NO_SPAWN === "1") { // tests: record the launch, start nothing
  console.log(JSON.stringify({ mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, spawned: false }, null, 2));
  append(entry);
  process.exit(0);
}
const ps1 = path.join(os.tmpdir(), `claude-handoff-${stamp}.ps1`);
// Housekeeping: drop launcher scripts from earlier launches older than 1 day.
if (!dry) try {
  for (const f of fs.readdirSync(os.tmpdir())) if (/^claude-handoff-.*\.ps1$/.test(f)) {
    const p = path.join(os.tmpdir(), f); if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.unlinkSync(p);
  }
} catch {}
if (!dry) fs.writeFileSync(ps1, [
  "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
  "Get-ChildItem env: | Where-Object { $_.Name -like 'CLAUDE*' -or $_.Name -eq 'AI_AGENT' -or $_.Name -like 'HL_*' } | ForEach-Object { Remove-Item -LiteralPath (\"env:\" + $_.Name) }",
  // This host is the window's process (parent of claude): record it so a later launch can close the window.
  `New-Item -ItemType Directory -Force -Path ${q(PID_DIR)} | Out-Null`,
  `Set-Content -LiteralPath ${q(pidFile)} -Encoding ascii -Value ($PID.ToString() + ' ' + (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'))`,
  `$Host.UI.RawUI.WindowTitle = ${q(name)}`,
  `Set-Location -LiteralPath ${q(workDir)}`,
  `Write-Host ${q(`Handoff: ${handoffRef}`)}`,
  process.env.HL_FAKE_CLAUDE === "1" ? "powershell -NoExit -Command Start-Sleep 600" : `claude ${claudeArgs.join(" ")}`,
].join("\r\n"), "utf8");

const hasWt = spawnSync("where.exe", ["wt"], { encoding: "utf8" }).status === 0;
const [exe, exeArgs] = hasWt
  // cmd /c ... & exit 0 wraps the host so the pane exits 0 when the host is killed - Windows Terminal (closeOnExit
  // default) keeps a pane open after a non-zero exit, so a bare killed host would leave a dead window behind.
  ? ["wt.exe", ["-w", "new", "--title", name, "-d", workDir, "cmd", "/c", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ps1, "&", "exit", "0"]]
  : ["cmd.exe", ["/c", "start", "", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ps1]];
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, launcher: ps1, command: [exe, ...exeArgs], claude_args: claudeArgs, cap };
if (dry) {
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(repoKey, branch, generation, false);
  report.watchdog = watchdog(repoKey, stopLooping, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
// A leftover pid file from an earlier launch must never be read as this window's.
fs.rmSync(pidFile, { force: true });
const t0 = Date.now();
spawn(exe, exeArgs, { cwd: workDir, env: cleanEnv, detached: true, stdio: "ignore" }).unref();
while (!fs.existsSync(pidFile) && Date.now() - t0 < 20000) sleep(100);
const latency = Date.now() - t0;
sleep(150);
const launched = readPidFile(entry);
append(launched);
if (!launched.host_pid) {
  console.log(`launched, but no pid file after 20 s (${fwd(pidFile)}) - auto-close skipped, check the window`);
} else {
  console.log(`launched: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${generation} of ${branch}`);
  for (const l of noClose ? ["auto-close disabled (--no-close)"] : closeOld(repoKey, branch, generation, true)) console.log(l);
}
console.log(["watchdog:", ...watchdog(repoKey, stopLooping, true)].join("\n  "));
