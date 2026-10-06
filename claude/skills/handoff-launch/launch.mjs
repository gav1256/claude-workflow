// Open a fresh, clean Claude Code session that picks up a handoff document.
// Usage:
//   node launch.mjs --repo <dir> --handoff <path> [--name <label>] --model <m> --effort <level> [--mode window|bg]
//                   [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>] [--force] [--no-close] [--dry-run]
//                   [--recovery <incident>] [--prompt-file <file>] [--goal-from <session id>]
//                   [--supersedes <registry id>] [--priority high|normal|low] [--scope "<text>"]
//   node launch.mjs --resume <session id> [--recovery <incident>] [--model m --effort e] [--profile <names>] [--priority <p>]
//                   (the coordinator's first restart; the entry's profile unless --profile, full for an entry without one)
//   node launch.mjs queue --to <lane> [--group <id>] [--repo <main repo>] (--text "<text>" | --text-file <file>)
//                   [--after-merge] [--from <name>]                      (an item for another lane's next fresh launch)
//   node launch.mjs priority --name <lane> [--group <id>] --set high|normal|low
//   node launch.mjs sessions [--repo <dir>]          (every open launcher session and its checklist; hand-opened GOAL.md files)
//   node launch.mjs recover (--group <id> | --name <session>) --mode auto|report
//   node launch.mjs resume --group <id> [--lane <name>]                     (relaunch blocked lanes fresh)
//   node launch.mjs profile-args [--profile <names>] [--repo <work dir>]   (JSON {profile, args} for `claude --resume <id> <args>`)
//   node launch.mjs status --group <id> [--repo <dir>] [--no-merge] [--dry-run]   (rolling groups: merges first)
//   node launch.mjs group --group <id> --repo <dir> --integration <branch> --target <branch> [--test <cmd>]
//                   [--test-timeout-min <n>] [--mode window|bg] [--force]      (rolling-merge group config)
//   node launch.mjs merge --group <id> [--repo <dir>] [--lane <name>]          (merge finished lanes now)
//                   [--skip <lane> [--session <merge session>] --why <reason>] [--force] [--dry-run]
//   node launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]          (files finished lanes share with running ones)
//   node launch.mjs stop (--name <name> | --id <registry id>) [--why <text>]
//   node launch.mjs watchdog [--repo <dir>] [--stop-looping]   (what the coordinator tick would do now, writing nothing;
//                   --stop-looping runs the tick; --repo: only that repo's sessions)
//   window (default): a new Windows Terminal window running an interactive `claude` the user can watch and type into.
//   bg: a Claude Code background session (`claude --bg`), listed by `claude agents`, attach with `claude attach <id>`.
//   --worktree: run the session in <main repo>/.claude/worktrees/<slug> on <branch> (created from --base, default the
//     repo's HEAD, or reused). The main checkout is never checked out.
//   --group: tag parallel sessions (fan-out); `status --group` lists members and their done markers.
//   --profile a,b: lane profiles from profiles.json (union; lean implied; default lean; full = no plugin or MCP flags): which
//     heavy plugins and MCP servers the session keeps. The session cap (<registry dir>/launch-config.json, defaults
//     max_sessions 6, min_free_gb 3) refuses a launch or --resume with exit 3 unless --force (ask the user first); the
//     coordinator tick defers a restart it refuses (never --force).
//   status also prints, for any group, UNTRACKED sessions (a launcher died between its {starting} line and its launch
//   line) and ORPHAN processes (the tick's orphans.json, < 2 h old).
//   Every launch appends a {starting} line, then its launch line, to sessions.jsonl (next to this file). The launch line
//   records launched_by (CLAUDE_CODE_SESSION_ID of the session that ran this, else null), supersedes (the registry id it
//   replaces: --resume's entry, --supersedes <id>, the launching session's own entry when it relays in its own checkout,
//   a merge session's predecessor in the merge worktree, else null), scope (the handoff's first # heading, or --scope)
//   and priority (--priority, else derived from the sizing). A launch with supersedes null onto a checkout whose session
//   really runs is refused (exit 3) unless --force; windows there whose claude is gone are closed first. After a window
//   launch, the windows in its supersedes chain beyond its direct predecessor are closed - only when their session is idle
//   for >= 10 min; a busy one gets a stop request instead and is retried by a later launch (--no-close disables this chain
//   close; the closes of windows whose claude is gone still run). A legacy launch line (no supersedes key) keeps the
//   generation rule (<= N-2 of its repo+branch).
//   A fresh launch named <lane> takes its inbox (queue) and names it in the prompt; an unknown --flag only warns, on any
//   path (`group` refuses one).
//   Every launch line records model, effort, coord: 1 and prompt_file (the base prompt - never a --recovery line -
//   next to the pid file).
//   Every launched session gets the coordinator hooks (session-hooks.json next to the registry -> hooks/coord.mjs)
//   folded into its ONE --settings file, the profile's (two --settings flags do not merge: the last one wins), and every
//   recorded launch wakes the coordinator tick (at most one per tick_min).
// The new session never inherits this session's CLAUDE_* environment (that makes a child think it IS this session)
// except CLAUDE_CONFIG_DIR, gets HL_SESSION_ID=<registry id>, and gets PATH fresh from the registry.
// Test hooks: HL_REGISTRY_DIR (registry, pid and stop files), HL_PROJECTS_DIR (transcript root, default
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects), HL_AGENTS_JSON (file standing in for `claude agents --json`),
// HL_FAKE_PROBE=fail|timeout (every process probe fails or times out: liveness is unknown) or fail:<label> (only the
// probes with that label fail, e.g. fail:below for the host-below probes; live.mjs), HL_FAKE_CLAUDE=1 (the
// window runs a sleeping powershell instead of claude), HL_NO_SPAWN=1 (record the launch - worktree, registry line -
// and start nothing; tests only), HL_PROFILES_JSON (profiles file), HL_CLAUDE_JSON (stands in for ~/.claude.json),
// HL_FREE_GB (free RAM in GB for the cap), HL_AGENTS_LOG (one line per `claude agents --json` list; live.mjs),
// HL_FAKE_PROCS (the orphan scan's process list; live.mjs), HL_FAKE_GIT_TIMEOUT=<text> (a git call whose arguments
// contain <text> times out at once; merge.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf, inboxPathOf } from "./merge.mjs";
import { HERE, REG_DIR, PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hostBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooks, sessionHooksFile, triggerTick, COORD, CFG, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness,
  agentsList, listedAgent, launcherEnv, forgetLiveness, goalOf, projectKey, probeWhy } from "./live.mjs";
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine, parseGoal, goalNote } from "./recover-lib.mjs";
import * as G from "./lane-lib.mjs";
import { guardedClose } from "./recover.mjs";
import { hostsBelow } from "./live.mjs";

const IDLE_CLOSE_MS = 10 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
// Every --flag the code reads: each opt("...")/flag("...")/val("...") literal (tests/provenance.test.mjs checks that this set
// and the code agree). Every path - a launch, --resume and each subcommand - warns on any other --flag (stderr only) and
// ignores it; it never refuses: other projects' lanes call the live launcher with whatever their handoffs say. `group`
// refuses an unknown flag itself (its own check below), so it gets no warning. A word with whitespace is a value (a
// queue --text), never a flag.
const KNOWN_FLAGS = new Set(["after-merge", "base", "dry-run", "effort", "force", "from", "goal-from", "group", "handoff",
  "integration", "lane", "mode", "model", "name", "no-close", "no-merge", "priority", "profile", "prompt-file", "recovery", "reopen", "repo",
  "resume", "scope", "session", "set", "skip", "stop-looping", "supersedes", "target", "test", "test-timeout-min", "text", "text-file", "to",
  "why", "worktree", "id"]);
if (sub !== "group") for (const a of args) if (a.startsWith("--") && !/\s/.test(a) && !KNOWN_FLAGS.has(a.slice(2))) console.error(`warning: unknown flag ${a} (ignored)`);
const dry = flag("dry-run");
// The MAIN checkout root, also when <dir> is a linked worktree: registry key, worktree parent, done-marker home.
// A timeout is no answer, never "not a git repo" (a rolling lane would launch as a legacy one); any other failure is
// git's own "not a repository" (its text is localized, so it is not parsed).
const mainRoot = (dir) => {
  const r = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (r.timedOut) { console.error(`${r.err} (in ${dir}) - nothing done; retry`); process.exit(2); }
  return r.ok ? path.dirname(path.resolve(r.out)) : null;
};
const reg = readRegistry();
const live = (e) => !reg.closed.has(e.id);
// sessionLiveness (live.mjs): the latest launch line of a session and its liveness, read fresh (the registry changes mid-run).
const mergeCtx = (root, group) => ({ readRegistry, append, launchMjs: fileURLToPath(import.meta.url), root, repoKey: key(root), group, sessionLiveness });
const rootArg = () => mainRoot(path.resolve(opt("repo", process.cwd())));
// A path with spaces stays one word for the session reading it. Single quotes: the prompt's " become ' anyway.
const qs = (p) => (/\s/.test(p) ? `'${p}'` : p);
// The main root a group lane's files live under, spelled as its done marker has it (<root>/.superpowers/sessions/<group>/
// <name>.done; the registry's repo key is lowercased); null without a marker.
const markerRoot = (e) => (e.done_marker ? path.resolve(path.dirname(e.done_marker), "..", "..", "..") : null);

// ---------- auto-close: the new launch's supersedes chain beyond its first link, idle sessions only, tri-state ----------
// The direct predecessor is busy launching this one (the tick closes it once idle). A legacy entry (no supersedes key)
// keeps the stage-2 rule: generations <= N-2 of its repo + branch.
function closeOld(entry, apply) {
  const r = readRegistry();
  const all = r.entries.some((x) => x.id === entry.id) ? r.entries : [...r.entries, entry];
  const set = G.hasSupersedesKey(entry) ? G.chainOf(entry, all).slice(1)
    : all.filter((e) => e.repo === entry.repo && e.branch === entry.branch && (e.generation || 0) <= (entry.generation || 0) - 2);
  const cands = set.filter((e) => e.mode === "window" && !r.closed.has(e.id));
  primeLiveness(cands);
  const out = [];
  for (const e of cands.map(readPidFile)) {
    const tag = `${e.name} (gen ${e.generation}, pid ${e.host_pid ?? "?"})`;
    const lv = liveness(e, r);
    if (lv.state === "unknown") { out.push(`skip ${tag}: liveness unknown (${lv.why}) - nothing done`); continue; }
    if (lv.state === "gone") { if (apply) append({ closed: e.name, id: e.id, at: now(), why: lv.why }); out.push(`skip ${tag}: ${lv.why}${apply ? " - marked closed" : " - would mark closed"}`); continue; }
    const s = sessionState(e);
    let closable, why;
    if (!s.found) { // only an EMPTY host closes: a job the user runs in the window after claude exited keeps it
      const below = hostBelow(e.host_pid);
      if (below === null) { out.push(`skip ${tag}: no transcript and the process probe failed - nothing done`); continue; }
      closable = below.empty; why = closable ? "no claude running in the window" : `no transcript found but its window is not empty (${below.names.join(", ")})`;
    } else if (!s.idle) { closable = false; why = `busy: ${s.busy.join(", ")}`; }
    // Only a turn_duration record at the turn's end says whether background agents are pending (as closeDecision): unknown keeps the window.
    else if (!s.bgKnown) { out.push(`skip ${tag}: pending background agents unknown (the turn ended without a turn_duration record) - nothing done`); continue; }
    else if (ago(s.last) < IDLE_CLOSE_MS) { out.push(`skip ${tag}: idle only ${mins(ago(s.last))} - a later launch retries`); continue; }
    else {
      // An idle transcript does not prove claude still runs there (as guardedClose): a window whose claude exited and
      // where the user now runs a job keeps it, and a failed probe below it is no close. Probed in a dry run too, so it
      // says what the real run does.
      const below = hostBelow(e.host_pid);
      if (below === null) { out.push(`skip ${tag}: the process probe below its window failed (${probeWhy() || `host pid ${e.host_pid} is not a pid`}) - nothing done`); continue; }
      if (!below.empty && !below.claude) { out.push(`skip ${tag}: its window runs ${below.names.join(", ")}, no claude - nothing done`); continue; }
      closable = true; why = `idle ${mins(ago(s.last))}`;
    }
    if (!closable) { out.push(`skip ${tag}: ${why} - ${requestStop(e, `auto-close of gen ${e.generation}: ${why}`, { apply, reasonClass: "close" })}`); continue; }
    out.push(apply ? `${killTree(e, `auto-close: ${why}`, "close").line} ${tag}: ${why}` : `would close ${tag}: ${why}`);
  }
  return out;
}

// A window whose claude is gone (batch A, Part 3: an empty host, launched >= 2 min ago) is closed first by any launch onto
// its checkout, a --resume and `launch.mjs resume`: the guarded no-claude close (recover.mjs: the recorded host, an empty
// host re-checked right before the kill). apply false: guardedClose's dry run, so a dry run says what the real run does (a
// window it would skip - say no recorded start time - is skipped there too). -> null when e is not such a window, else
// {line, closes}: closes = it was closed (apply) or would be (dry run).
function closeGone(e, apply) {
  if (e.mode !== "window" || ago(e.launched_at) < 2 * MIN) return null;
  const w = readPidFile(e);
  if (!w.host_pid) return null;
  const b = hostBelow(w.host_pid);
  if (!b?.empty) return null;
  const line = guardedClose(e, "claude exited (closed before this launch)", { dryRun: !apply, noClaude: true });
  if (apply) forgetLiveness(e.id, { agents: false });
  return { line, closes: line.startsWith(apply ? "closed " : "would close ") };
}

// ---------- lane profiles (profiles.json): the heavy plugins and MCP servers a session keeps ----------
// list: "a,b" (lean implied; undefined = the file's default; "full" anywhere = no plugin or MCP flags). workDirs: the
// dir(s) whose .mcp.json names project servers (first hit wins, after ~/.claude.json mcpServers; the file's "servers" come
// last). --strict-mcp-config drops plugin MCP servers, so a kept plugin must not be an MCP one: its server goes in
// "servers" + a profile's mcp instead (checked at load: no kept plugin <name>@.. may be a "servers" key). -> {profile, args}: the
// canonical sorted name list (or "full") and the claude args. The args must be followed by another option, never
// directly by the prompt: --mcp-config is variadic and would take the prompt as a second config file.
// Both files are content-addressed under <REG_DIR>/profiles (they can hold MCP env values: never in a repo).
// baseSettings: the coordinator's session hooks (sessionHooks()) at every launch site - two --settings flags do not
// merge, the last one wins entirely, so the hooks ride in this ONE file. With baseSettings, "full" also gets a
// --settings file (the hooks alone).
// A built-in server of profiles.json "servers" as the --mcp-config file gets it: {config} in its args is the config dir
// (batch A: the pinned Playwright install under <config>/mcp-servers, run by node directly); when its first argument is a
// file that does not exist (the install is missing), its "fallback" is used. The fallback key never reaches the file.
function builtinServer(def) {
  if (!def || typeof def !== "object") return def;
  // A function replacement: a config dir holding `$&` or `$'` is inserted as written, never as a replacement pattern.
  const fill = (d) => { const { fallback, ...rest } = d; return Array.isArray(rest.args) ? { ...rest, args: rest.args.map((a) => (typeof a === "string" ? a.replaceAll("{config}", () => fwd(CFG)) : a)) } : rest; };
  const main = fill(def), first = main.args?.[0];
  return def.fallback && typeof def.fallback === "object" && typeof first === "string" && /[\\/]/.test(first) && !fs.existsSync(first) ? fill(def.fallback) : main;
}
function profileArgs(list, workDirs, baseSettings = {}) {
  const fail = (m) => { console.error(m); process.exit(2); };
  const file = path.resolve(process.env.HL_PROFILES_JSON || path.join(HERE, "profiles.json"));
  let cfg; try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(`profiles file ${fwd(file)} is missing or not valid JSON: ${e.message}`); }
  const P = cfg?.profiles;
  const shapeOk = P && typeof P === "object" && !Array.isArray(P) && Array.isArray(cfg.heavy_plugins) && Object.hasOwn(P, cfg.default)
    && Object.values(P).every((p) => p === null || (Array.isArray(p?.plugins) && Array.isArray(p?.mcp)));
  const builtin = cfg?.servers ?? {};
  if (!shapeOk || !builtin || typeof builtin !== "object" || Array.isArray(builtin)) fail(`profiles file ${fwd(file)} is invalid: needs "default" (a profile name), "heavy_plugins" [..], "profiles" {name: {plugins: [..], mcp: [..]} | null} and optional "servers" {name: {..}}`);
  const mcpPlugins = Object.entries(P).flatMap(([n, p]) => (p?.plugins || []).filter((pl) => Object.hasOwn(builtin, String(pl).split("@")[0])).map((pl) => `${n}: ${pl}`));
  if (mcpPlugins.length) fail(`profiles file ${fwd(file)} keeps MCP plugin(s) (${mcpPlugins.join(", ")}): --strict-mcp-config drops plugin MCP servers - list the server in the profile's "mcp" instead of the plugin in "plugins"`);
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
    const sources = [...[process.env.HL_CLAUDE_JSON || path.join(os.homedir(), ".claude.json"), ...[].concat(workDirs).map((d) => path.join(d, ".mcp.json"))].map(readServers), builtin];
    const missing = [];
    for (const n of mcp) { const hit = sources.find((s) => Object.hasOwn(s, n)); if (hit) servers[n] = hit === builtin ? builtinServer(hit[n]) : hit[n]; else missing.push(n); }
    if (missing.length) fail(`profile ${profile}: MCP server ${missing.join(", ")} not found in ~/.claude.json mcpServers or ${[].concat(workDirs).map((d) => fwd(path.join(d, ".mcp.json"))).join(" / ")} or ${fwd(file)} servers`);
  }
  const stemName = profile.replace(/,/g, "+");
  return { profile, args: ["--settings", write(stemName, "settings", settings), "--strict-mcp-config", "--mcp-config", write(stemName, "mcp", { mcpServers: servers })] };
}

// ---------- session cap: refuse a launch while too many sessions run or free RAM is low ----------
// Config <REG_DIR>/launch-config.json {max_sessions, min_free_gb} (defaults 6 / 3). Counts the open sessions (tri-state
// liveness: running, and unknown as doubtful) except the entry this launch replaces (its supersedes; batch A - none when
// supersedes is null). One unknown is never counted (as on main): a bg entry with neither bg_id nor session id - what a bg launch
// records when claude agents showed no new session (the spawn failed, or no match) - is unknown forever and nothing ever
// closes it, so counting it would cost every later launch and restart a slot. Exits 3 on a breach unless --force;
// --dry-run only reports. The refusal's first line starts with CAP_REFUSED: the coordinator tick recognises it there and
// defers the restart instead of blocking the lane. -> {running, max, free_gb, min_free_gb, would_refuse}.
function sessionCap(supersedesId) {
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
  const cands = [...latest.values()].filter(live);
  primeLiveness(cands); // one window probe for all of them
  const running = [], notCounted = [];
  for (const e of cands) {
    const tag = `${e.name} (${e.branch})`, lv = liveness(e, reg);
    if (lv.state === "gone") continue;
    if (lv.state === "unknown" && e.mode === "bg" && !e.bg_id && !e.session_id) { notCounted.push(`${tag}: not counted - no background session id recorded`); continue; }
    if (lv.state === "unknown") { running.push({ e, line: `${tag}: doubtful, counted - ${lv.why}` }); continue; }
    if (e.mode === "bg") { // running: listed by claude agents (the list liveness just read, memoized)
      const a = listedAgent(e, agentsList()), st = a ? String(a.status || a.state || "").trim() : "";
      running.push({ e, line: `${tag}: running - bg session ${a?.id || e.bg_id || e.session_id}${st ? ` status ${st}` : ""}` });
    } else running.push({ e, line: `${tag}: running - host pid ${readPidFile(e).host_pid}` });
  }
  // Only the entry this launch replaces, and only when it counts.
  const pred = supersedesId ? running.find((r) => r.e.id === supersedesId) ?? null : null;
  const counted = running.filter((r) => r !== pred).map((r) => r.line);
  const free = process.env.HL_FREE_GB !== undefined ? Number(process.env.HL_FREE_GB) : os.freemem() / 2 ** 30;
  const why = [];
  if (counted.length >= max) why.push(`${counted.length} sessions running, max_sessions ${max}`);
  if (free < minFree) why.push(`${free.toFixed(1)} GB free RAM, min_free_gb ${minFree}`);
  const cap = { running: counted.length, max, free_gb: Math.round(free * 10) / 10, min_free_gb: minFree, would_refuse: why.length > 0 };
  if (!why.length || dry) return cap;
  // Merge sessions skip the cap, so here --force only overrides the cap (its merge-only meanings need <group>-merge).
  if (flag("force")) { console.error(`session cap overridden by --force: ${why.join("; ")}`); return cap; }
  console.error([`${CAP_REFUSED} ${why.join("; ")} (config ${fwd(file)})`, ...counted.map((l) => `  ${l}`), ...notCounted.map((l) => `  ${l}`),
    "close idle sessions first, or pass --force (ask the user first)"].join("\n"));
  process.exit(3);
}

// ---------- subcommands ----------
// Incident lines of lane e: those of any of its launch lines (same name, group and repo) - never another group's lane
// of the same name.
function laneIncidents(e) {
  const ids = new Set(reg.entries.filter((x) => x.name === e.name && (x.group ?? null) === (e.group ?? null) && x.repo === e.repo).map((x) => x.id));
  return reg.lines.filter((o) => o.incident && ids.has(o.incident));
}
// Recovery notes for a lane line - incidents, a loop-blocked legacy lane, liveness unknown. Empty when there is
// nothing to say, so the output of a group without any stays byte-identical.
function recoveryNotes(e, { legacy }) {
  const incs = laneIncidents(e);
  const b = legacy && e.group ? blockedLanes(reg.lines, e.group).find((x) => x.name === e.name) : null;
  const lv = live(e) ? liveness(e, reg) : null;
  return [b ? `LOOP-BLOCKED (incident ${b.incident} - resume: launch.mjs resume --group ${e.group} --lane ${e.name})` : "",
    incs.length ? `incidents=${incs.length} (latest ${incs.at(-1).path})` : "",
    lv?.state === "unknown" ? `liveness=unknown (${lv.why})` : ""].filter(Boolean).map((s) => `  ${s}`).join("");
}
// Batch A notes for a lane line, empty when there is nothing to say (a group without any stays byte-identical):
// DEAD-START (Part 3), inbox=<n> (Part 6), goal=... when the session has a GOAL.md (Part 9).
function laneNotes(e) {
  const ds = live(e) ? reg.lines.find((o) => o.dead_start === e.id) : null;
  const ib = inboxPathOf(markerRoot(e) ?? e.repo, e.group ?? null, e.name);
  let n = 0; try { n = G.inboxItems(fs.readFileSync(ib, "utf8")); } catch {}
  const gp = e.session_id ? goalOf(e.session_id) : null;
  let goal = ""; if (gp) { try { goal = `goal=${goalNote(parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, Date.now()).replace(/^goal /, "")}`; } catch {} }
  return [ds ? `DEAD-START (since ${ds.at})` : "", n ? `inbox=${n}` : "", goal].filter(Boolean).map((x) => `  ${x}`).join("");
}
const reportOnlyLine = (group) => `recovery: report-only (group launched before stage 2: loops are reported, never stopped - opt in: launch.mjs recover --group ${group} --mode auto)`;
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
// Rolling group: drain first (unless --no-merge or --dry-run), then the lanes with their merge state, overlap and
// recovery notes, then the summary, then a report-only group's recovery line. --dry-run writes nothing: no merge, no
// launch, no overlap sidecar.
function rollingStatus(group, root, c) {
  if (!c.ok) { for (const e of c.errors) console.log(`ERROR config: ${e}`); return 1; }
  const ctx = mergeCtx(root, group);
  if (!flag("no-merge") && !dry) for (const l of drain(ctx).lines) console.log(`merge: ${l}`);
  const { lanes } = lanesNow(ctx, c.config);
  primeLiveness(lanes.map((l) => l.entry)); // one window probe for every lane's liveness note
  const ovr = refreshOverlap(root, c.config, lanes, { write: !dry });
  if (ovr.error) console.log(`WARN overlap not refreshed: ${ovr.error}`);
  for (const l of G.byPriority(lanes, (x) => x.priority)) { // high -> normal -> low, then launch order (Part 7)
    const tag = mergeTag(l), ov = l.overlap && Object.keys(l.overlap).length ? `  overlap=${JSON.stringify(l.overlap)}` : "";
    console.log(`${memberLine(l.entry, l.marker).text}${tag ? `  ${tag}` : ""}${ov}${recoveryNotes(l.entry, { legacy: false })}${laneNotes(l.entry)}`);
  }
  const lock = readLock(groupDir(root, group));
  const lv = lock?.holder === "session" ? ctx.sessionLiveness(lock.session) : null;
  console.log(rollingSummary(lanes, lock, { state: lock ? lockStateOf(lock, c.config) : null, sessionClosed: lv?.state === "gone", sessionUnknown: lv?.state === "unknown" ? lv.why : null }));
  if (lanes[0] && recoveryMode(reg.lines, lanes[0].entry) === "report") console.log(reportOnlyLine(group));
  return 0;
}
// After any group's status, machine-wide: sessions a launcher died before registering (UNTRACKED, tri-state) and the
// tick's last orphan report while it is < 2 h old (ORPHAN). Report-only.
function watchLines() {
  const out = untracked(readRegistry()).map(untrackedLine), o = readJson(path.join(COORD, "orphans.json"), null);
  if (Array.isArray(o?.orphans) && Date.now() - Date.parse(o.at) < 120 * MIN) out.push(...o.orphans.map(orphanLine));
  return out;
}
const statusExit = (code) => { for (const l of watchLines()) console.log(l); process.exit(code); };
// A running session of lane <n> that a dead launcher never registered (UNTRACKED): one stderr warning each, never a
// refusal (a refusal would block the tick's restarts). untracked() probes only when such {starting} lines exist.
let untrackedMemo = null;
function warnUntracked(n) {
  untrackedMemo ??= untracked(reg);
  for (const u of untrackedMemo) if (u.name === n && u.state === "running") console.error(`warning: an untracked session of ${n} is still running (pid ${u.pid}) - two sessions must not share a worktree; close it first`);
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
  if (cfg) statusExit(rollingStatus(slug(group), path.resolve(gdir, "..", "..", ".."), cfg));
  // No lane to locate the group by: a group configured in --repo (or the cwd's repo) is rolling even with 0 lanes.
  const root = gdir ? null : rootArg(), rootCfg = root ? readConfig(groupDir(root, slug(group))) : null;
  if (rootCfg) statusExit(rollingStatus(slug(group), root, rootCfg));
  let done = 0;
  primeLiveness(members);
  for (const e of G.byPriority(members, (x) => G.effectivePriority(reg.lines, x))) { const m = memberLine(e); if (m.done) done++; console.log(m.text + recoveryNotes(e, { legacy: true }) + laneNotes(e)); }
  const lockFile = gdir ? path.join(gdir, "merge.lock") : null;
  const lock = !!lockFile && fs.existsSync(lockFile);
  console.log(`members=${members.length} done=${done} all_done=${members.length > 0 && done === members.length} merge_launched=${latest.has(mergeName)} merge_lock=${lock}${lock && !latest.has(mergeName) ? " (STALE lock: no merge entry - relaunch the merge with --force)" : ""}`);
  // Only a group with something to report gets the recovery line: a legacy group's output otherwise stays byte-identical.
  const noted = members.some((e) => laneIncidents(e).length || reg.lines.some((o) => o.lane_blocked === e.name && o.group === e.group));
  if (members[0] && noted && recoveryMode(reg.lines, members[0]) === "report") console.log(reportOnlyLine(slug(group)));
  statusExit(0);
}
if (sub === "stop") {
  const id = opt("id"), nm = opt("name");
  const e = [...reg.entries].reverse().find((x) => (id && x.id === id) || (nm && x.name === nm));
  if (!e) { console.error("no registry entry for that --name/--id"); process.exit(2); }
  console.log(requestStop(e, opt("why", "requested"), { apply: !dry, reasonClass: "manual", force: true, text: STOP_TEXT(opt("why", "requested")) }));
  process.exit(0);
}
if (sub === "watchdog") {
  // What the coordinator tick would do now (dry run). --stop-looping (kept as an alias) runs the tick for real.
  const repoKey = opt("repo") ? key(mainRoot(path.resolve(opt("repo"))) || opt("repo")) : null;
  const { tick } = await import("./recover.mjs");
  for (const l of tick({ dryRun: dry || !flag("stop-looping"), repoKey })) console.log(l);
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
    if (held?.holder === "session" && held.lane === skipName && val("session") !== held.session) {
      const b = sessionBlocker(held.session, held);
      if (b?.kind === "running") { console.log(`not skipped: ${held.session} is still running and holds ${skipName} - let it finish, or stop it (launch.mjs stop --name ${held.session}) and re-run`); process.exit(1); }
      if (b) { console.log(`not skipped: ${held.session} holds ${skipName} and its liveness is ${b.kind} (${b.text}) - re-run once its window or claude agents answers`); process.exit(1); }
    }
    const s = skipLane(ctx, skipName, val("why") || "skipped by hand");
    console.log(s.line);
    if (!s.ok) process.exit(1);
  }
  if (flag("force")) {
    // A merge session that is still running owns its lock and the merge worktree: clearing the lock would let the drain
    // launch a second session into the same worktree. Refused only when it is demonstrably running.
    const held = readLock(gd), b = held?.holder === "session" ? sessionBlocker(held.session, held) : null;
    if (b?.kind === "running") { console.log(`not cleared: ${held.session} is still running (${b.text}) - launch.mjs stop --name ${held.session} or close its window, then re-run`); process.exit(1); }
    if (b) { console.log(`not cleared: ${held.session}'s liveness is ${b.kind} (${b.text}) - nothing cleared; re-run once its window or claude agents answers`); process.exit(1); }
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
  if (pairs.error) console.error(`WARN overlap not refreshed: ${pairs.error}`);
  for (const p of pairs) console.log(`${p.finished} (finished) <-> ${p.running} (running): ${p.files.join(", ")}`);
  if (!pairs.length) console.log("no overlap between finished and running lanes");
  process.exit(0);
}
if (sub === "recover") {
  const g = opt("group") && slug(opt("group")), n = opt("name") && slug(opt("name")), m = opt("mode");
  if (!!g === !!n || !/^(auto|report)$/.test(m || "")) { console.error("recover needs --group <id> or --name <session>, and --mode auto|report"); process.exit(2); }
  if (!reg.entries.some((e) => (g ? e.group === g : e.name === n))) { console.error(`no launch line for ${g ? `group ${g}` : `session ${n}`}`); process.exit(2); }
  // A lane's mode is its group's (recoveryMode reads the group): a --name line for it would never be read.
  const named = n ? reg.entries.filter((e) => e.name === n) : [];
  if (named.length && named.every((e) => e.group)) { const gg = named.at(-1).group; console.error(`${n} belongs to group ${gg} - use --group ${gg}`); process.exit(2); }
  if (!dry) append({ recovery_mode: g || n, mode: m, at: now() });
  console.log(`${dry ? "would set" : "set"} recovery mode of ${g ? "group" : "session"} ${g || n} to ${m}`);
  if (m === "auto") { // sessions launched before stage 2 have no session hook: a stop request cannot reach them
    const latest = new Map();
    for (const e of reg.entries) if ((g ? e.group === g : e.name === n) && !reg.closed.has(e.id)) latest.set(e.name, e);
    const old = [...latest.values()].filter((e) => e.coord !== 1).map((e) => e.name);
    if (old.length) console.log(`WARN no session hook in ${old.join(", ")} (launched before stage 2): stop requests cannot reach ${old.length === 1 ? "it" : "them"}, so a loop there is killed grace_min (default 5 min) after the request. Restarted sessions get the hook.`);
  }
  process.exit(0);
}
if (sub === "resume") {
  const g = opt("group") && slug(opt("group")), lane = opt("lane") && slug(opt("lane"));
  if (!g) { console.error("resume needs --group <id> [--lane <name>]"); process.exit(2); }
  // High priority first (Part 7): when the cap frees one slot, the highest-priority lane gets it.
  const newestOf = (n) => [...reg.entries].reverse().find((x) => x.name === n && x.group === g);
  const blocked = G.byPriority(blockedLanes(reg.lines, g).filter((b) => !lane || b.name === lane),
    (b) => { const e = newestOf(b.name); return e ? G.effectivePriority(reg.lines, e) : "normal"; });
  if (!blocked.length) { console.log(`no blocked lanes in group ${g}${lane ? ` named ${lane}` : ""}`); process.exit(0); }
  let code = 0;
  for (const b of blocked) {
    const e = [...reg.entries].reverse().find((x) => x.name === b.name && x.group === g);
    if (!e) { console.log(`not relaunched: no launch line for ${b.name} in group ${g}`); code = 1; continue; }
    if (!b.incident) { console.log(`not relaunched: the lane_blocked line of ${b.name} names no incident - relaunch it by hand with --recovery <incident>`); code = 1; continue; }
    // A lane whose newest launch still runs (or cannot be judged) is never relaunched: one worktree, one session. A dead
    // start (its window open, claude gone) is closed first (batch A, Part 3).
    let lv = liveness(e, reg);
    if (lv.state === "running") { const c = closeGone(e, !dry); if (c) { console.log(c.line); lv = !dry ? liveness(e, readRegistry()) : c.closes ? { state: "gone", why: "would be closed" } : lv; } }
    if (lv.state !== "gone") { console.log(`not relaunched: ${e.id} is ${lv.state} (${lv.why}) - stop it or wait for it, then re-run`); code = 1; continue; }
    warnUntracked(b.name);
    if (dry) { console.log(`would relaunch ${b.name} fresh from ${e.handoff} (incident ${b.incident})`); continue; }
    // A relaunch keeps the lane's effective priority and replaces its newest entry; the scrubbed env keeps this session
    // (if one runs this command) out of its provenance.
    const fa = freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", recovery: b.incident, priority: G.effectivePriority(reg.lines, e), supersedes: e.id });
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...fa], { encoding: "utf8", timeout: 3 * MIN, env: launcherEnv() });
    // {lane_resumed} only after a launch that worked: a failed one leaves the lane blocked, so a re-run tries again.
    const capWhy = capRefusal(r.status, `${r.stderr || ""}\n${r.stdout || ""}`);
    if (r.status === 0) { append({ lane_resumed: b.name, group: g, handoff: e.handoff, at: now() }); console.log(`relaunched ${b.name} fresh (incident ${b.incident}); restart budget reset`); }
    else if (capWhy) { code = 1; console.log(`not relaunched: ${b.name} - session cap (${capWhy}): close idle sessions or free RAM, then re-run (still blocked)`); }
    else { code = 1; console.log(`ERROR relaunching ${b.name}: ${`${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-5).join(" | ") || `the launcher exited ${r.status ?? r.signal ?? r.error?.code}`}`); }
  }
  process.exit(code);
}
// The newest launch line named <name> (in group g when given; undefined = any group).
const newestNamed = (name, g) => [...reg.entries].reverse().find((x) => x.name === name && (g === undefined || (x.group ?? null) === g)) ?? null;
if (sub === "queue") {
  // batch A, Part 6: an item for another lane, delivered at its next fresh launch (never mid-task).
  const to = opt("to") && slug(opt("to")), tf = opt("text-file"), g = opt("group") ? slug(opt("group")) : undefined;
  let text = opt("text");
  if (!to || (text === undefined) === (tf === undefined)) { console.error('queue needs --to <lane> and one of --text "<text>" / --text-file <file> [--group <id>] [--repo <main repo>] [--after-merge] [--from <name>]'); process.exit(2); }
  if (tf !== undefined) { try { text = fs.readFileSync(tf, "utf8"); } catch (err) { console.error(`--text-file ${tf} unreadable (${err.code || err.message})`); process.exit(2); } }
  // --text followed by another flag took that flag as its value (a --text-file's contents are never refused for this).
  if (tf === undefined && /^--[a-z][\w-]*$/i.test(text)) { console.error('--text needs a text: --text "<text>"'); process.exit(2); }
  if (!String(text ?? "").trim()) { console.error("queue: the text is empty"); process.exit(2); }
  // A line of the text that looks like an item heading would count as an item of its own: escape it (\##, Markdown's
  // literal #). After the trim, as inboxBlock trims too: an escape made before it could be trimmed away.
  text = String(text).trim().replace(/^(## \d{4}-\d\d-\d\dT\S+ from )/gm, "\\$1");
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null;
  const e = [...reg.entries].reverse().find((x) => x.name === to && (g === undefined || (x.group ?? null) === g) && (!repoKey || x.repo === repoKey));
  if (!e) { console.error(`unknown lane ${to}${g ? ` in group ${g}` : ""}: no launch line has that name`); process.exit(2); }
  const grp = e.group ?? null;
  if (flag("after-merge") && !grp) { console.error(`--after-merge needs a lane in a group: ${to} has none`); process.exit(2); }
  const file = inboxPathOf(grp ? markerRoot(e) ?? (opt("repo") ? rootArg() : e.repo) : null, grp, flag("after-merge") ? "_after-merge" : to);
  const me = process.env.HL_SESSION_ID ? [...reg.entries].reverse().find((x) => x.id === process.env.HL_SESSION_ID) : null;
  const from = opt("from") || me?.name || "user";
  if (dry) { console.log(`would queue for ${to}: ${fwd(file)}`); process.exit(0); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, G.inboxBlock(now(), from, text)); // one append per item: concurrent queuers never interleave inside it
  console.log(`queued for ${to}: ${fwd(file)} (${G.inboxItems(fs.readFileSync(file, "utf8"))} items)`);
  process.exit(0);
}
if (sub === "priority") {
  // batch A, Part 7: a {priority: <name>, group, value, at} line; the lane's effective priority is the latest.
  const nm = opt("name") && slug(opt("name")), v = opt("set"), g = opt("group") ? slug(opt("group")) : undefined;
  if (!nm || !G.PRIORITIES.includes(v)) { console.error("priority needs --name <lane> [--group <id>] --set high|normal|low"); process.exit(2); }
  const e = newestNamed(nm, g);
  if (!e) { console.error(`unknown lane ${nm}${g ? ` in group ${g}` : ""}: no launch line has that name`); process.exit(2); }
  if (!dry) append({ priority: nm, group: e.group ?? null, value: v, at: now() });
  console.log(`${dry ? "would set" : "set"} priority of ${nm}${e.group ? ` (group ${e.group})` : ""} to ${v}`);
  process.exit(0);
}
if (sub === "sessions") {
  // batch A, Part 9: every open launcher session (all groups and lone sessions) and its checklist, then hand-opened
  // sessions with a GOAL.md modified in the last 24 hours. Read-only.
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null, nowMs = Date.now();
  // Liveness before the newest pick (batch B carried fix): a gone, unclosed newest entry never hides an older running one.
  const open = reg.entries.filter((e) => !reg.closed.has(e.id) && (!repoKey || e.repo === repoKey));
  primeLiveness(open); // one window probe for all of them
  const newest = new Map();
  for (const e of open) {
    if (liveness(e, reg).state === "gone") continue;
    const k = `${e.repo}|${e.name}`, cur = newest.get(k);
    if (!cur || cur.launched_at <= e.launched_at) newest.set(k, e);
  }
  const list = G.byPriority([...newest.values()], (e) => G.effectivePriority(reg.lines, e));
  const goalText = (gp) => { try { return goalNote(parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, nowMs); } catch { return "GOAL.md unreadable"; } };
  for (const e of list) {
    const lv = liveness(e, reg);
    let turn = "-";
    if (lv.state !== "gone") {
      const st = sessionState(e), hook = (/^[\w-]+$/.test(e.session_id || "") && readJson(path.join(COORD, "sessions", `${e.session_id}.json`), {})) || {};
      turn = !st.found ? "no transcript" : hook.waiting_since ? "waiting" : st.idle ? "idle" : "busy";
    }
    const gp = e.session_id ? goalOf(e.session_id) : null;
    console.log(`${e.name}  ${e.repo}@${e.branch}  group=${e.group ?? "-"}  gen ${e.generation ?? "?"}  ${lv.state}  ${turn}  priority=${G.effectivePriority(reg.lines, e)}  ${gp ? goalText(gp) : "no GOAL.md"}`);
  }
  if (!list.length) console.log("no open launcher sessions");
  const known = new Set(reg.entries.map((e) => e.session_id).filter(Boolean)), base = path.join(os.tmpdir(), "claude");
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name); } catch { return []; } };
  const prefix = repoKey ? projectKey(rootArg() || opt("repo")) : null;
  for (const proj of dirs(base)) {
    // The repo and its worktrees (<repo>/.claude/worktrees/<x>), never a sibling project <repo>2 or <repo>-x.
    if (prefix && proj !== prefix && !proj.startsWith(`${prefix}--claude-worktrees-`)) continue;
    for (const sid of dirs(path.join(base, proj))) {
      if (known.has(sid)) continue;
      const gp = path.join(base, proj, sid, "scratchpad", "GOAL.md");
      let m; try { m = fs.statSync(gp).mtimeMs; } catch { continue; }
      if (nowMs - m <= 24 * 60 * MIN) console.log(`hand-opened ${proj} ${sid.slice(0, 8)}  ${goalText(gp)}`);
    }
  }
  process.exit(0);
}
if (sub === "profile-args") {
  // The same files a launch passes: the coordinator hooks ride in the profile's settings file (full: the hooks alone).
  console.log(JSON.stringify(profileArgs(opt("profile"), path.resolve(opt("repo", process.cwd())), sessionHooks())));
  process.exit(0);
}
if (sub) { console.error(`unknown subcommand ${sub}`); process.exit(2); }
const prioArg = opt("priority");
if (flag("priority") && !G.PRIORITIES.includes(prioArg)) { console.error(`--priority must be high, normal or low, got ${prioArg}`); process.exit(2); }
// --scope takes a text: a missing or empty one, or a --flag in its place, is refused (as --supersedes), never taken as the scope.
if (flag("scope") && (!opt("scope") || opt("scope").startsWith("--"))) { console.error('--scope needs a text: --scope "<text>"'); process.exit(2); }

// Never inherit the global defaults: each session is sized for its task (SKILL.md "Sizing the session"). -> the refusal
// text, null when the sizing is allowed. Both launch paths (--resume too) check it.
function sizeError(model, effort) {
  if (!model || !effort) return "--model and --effort are required - size the session for its task (see SKILL.md 'Sizing the session')";
  if (!/^(low|medium|high|xhigh|max)$/.test(effort)) return `--effort must be low|medium|high|xhigh|max, got ${effort}`;
  if (/haiku/i.test(model)) return "never Haiku for a session";
  if (/sonnet/i.test(model)) return "never sonnet as a session (sonnet is a mechanical subagent tier)";
  return null;
}

// ---------- --resume <session id>: the ladder's first restart - the same conversation, a new registry line ----------
function resumeLaunch(sid) {
  if (process.platform !== "win32" && process.env.HL_FAKE_CLAUDE !== "1") { console.error("--resume opens a window and only works on Windows"); return 2; }
  const prev = [...reg.entries].reverse().find((e) => e.session_id === sid);
  if (!prev) { console.error(`--resume: no launch line has session id ${sid}`); return 2; }
  const newest = [...reg.entries].reverse().find((e) => e.name === prev.name && e.repo === prev.repo);
  if (newest.id !== prev.id) { console.error(`--resume: ${prev.name} has a newer launch (${newest.id}) - only the newest generation is resumed, so two sessions never share a worktree`); return 3; }
  // The restart guard is the union (batch A): also an open entry newer on its repo + branch, or with it in its chain.
  const blockers = G.restartBlockers(prev, reg.entries, reg.closed);
  if (blockers.length) { console.error(`--resume: an open newer launch shares the checkout of ${prev.name} (${blockers.map((b) => b.id).join(", ")}) - two sessions never share a worktree`); return 3; }
  if (prev.mode === "bg") { console.error(`--resume: ${prev.name} is a background session - background lanes restart fresh`); return 2; }
  // A restart only after the old process is confirmed gone: running or unknown would put two sessions in one worktree.
  // A window whose claude is gone (an empty host) is closed first (batch A, Part 3).
  let lv = liveness(prev, reg);
  if (lv.state === "running") { const c = closeGone(prev, !dry); if (c) { console.error(c.line); lv = !dry ? liveness(prev, readRegistry()) : c.closes ? { state: "gone", why: "would be closed" } : lv; } }
  if (lv.state !== "gone") { console.error(`--resume: ${prev.id} is ${lv.state} (${lv.why}) - stop it or wait, then re-run`); return 1; }
  if (!prev.worktree || !fs.existsSync(prev.worktree)) { console.error(`--resume: the worktree of ${prev.name} (${prev.worktree}) no longer exists - restart it fresh`); return 2; }
  const m = opt("model") || prev.model || "opus", ef = opt("effort") || prev.effort || "high";
  const se = sizeError(m, ef);
  if (se) { console.error(`--resume: ${se}`); return 2; }
  // The session cap, before any side effect (as a launch's): a resume starts a session too. A refusal exits 3 with the
  // CAP_REFUSED line, which the tick reads as "deferred". Merge sessions are exempt.
  const cap = prev.group && isMergeSession(prev.group, prev.name) ? { exempt: "merge session" } : sessionCap(prev.id);
  warnUntracked(prev.name);
  // The same conversation keeps its profile; an entry from before profiles ran with every plugin and server: full.
  // MCP servers from the real dirs, as a fresh launch reads them: the worktree, then the main checkout (never the
  // registry key - a lowercased path).
  const wd = path.resolve(prev.worktree), wdRoot = mainRoot(wd);
  // --profile picks a new profile for the resumed session (recorded on the new entry); else the entry's, full without one.
  const prof = profileArgs(opt("profile") || prev.profile || "full", [...new Map([wd, wdRoot].filter(Boolean).map((d) => [key(d), d])).values()], sessionHooks());
  const st = new Date().toISOString().replace(/[:.]/g, "-"), rid = `${prev.name}@${st}`, pf = path.join(PID_DIR, `${stem(rid)}.pid`);
  const gen = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === prev.repo && e.branch === prev.branch).map((e) => e.generation || 0));
  const text = (opt("recovery") ? RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))
    : "Resumed by the launcher: continue from your saved state and ledger resume point - re-check the repo state first, then carry on with your next step.").replace(/"/g, "'").replace(/;/g, ",");
  // Provenance and priority are set explicitly, never inherited through ...prev (batch A): the resumed entry is what this
  // launch replaces; a resume keeps the lane's effective priority unless --priority.
  const e = { ...prev, id: rid, generation: gen, launched_at: now(), host_pid: null, host_start: null, pid_file: fwd(pf), model: m, effort: ef, coord: 1, resumed_from: prev.id, profile: prof.profile,
    launched_by: process.env.CLAUDE_CODE_SESSION_ID || null, supersedes: prev.id, scope: prev.scope ?? null, priority: opt("priority") || G.effectivePriority(reg.lines, prev) };
  delete e.no_spawn; delete e.bg_output;
  sessionHooksFile({ write: !dry }); // the inspectable copy of the hooks; the session gets them in the profile's file
  // One --settings file (the profile's, carrying the hooks). The profile args go before -n and the prompt: --mcp-config
  // is variadic, and the prompt stays last, after single-valued flags only.
  const cargs = ["--resume", psq(sid), ...prof.args.map(psq), "-n", psq(prev.name), "--model", psq(m), "--effort", psq(ef), psq(text)];
  const report = { mode: "window", resume: sid, registry_line: e, prompt: text, claude_args: cargs, cap };
  if (dry) { console.log(JSON.stringify(report, null, 2)); return 0; }
  fs.rmSync(path.join(COORD, "sessions", `${sid}.json`), { force: true }); // its hook state starts over: warnings fire again
  const lp = path.join(COORD, "looping.json"), loops = readJson(lp, {}) || {};
  if (loops[sid]) { delete loops[sid]; writeAtomic(lp, JSON.stringify(loops, null, 2)); } // and its old subagents' flags go
  if (process.env.HL_NO_SPAWN === "1") { console.log(JSON.stringify({ ...report, spawned: false }, null, 2)); append(startingLine(e)); append({ ...e, no_spawn: true }); triggerTick("launch"); return 0; }
  const ps1 = path.join(os.tmpdir(), `claude-handoff-${st}.ps1`);
  const script = windowScript({ pidFile: pf, name: prev.name, workDir: wd, banner: `Resume: ${prev.name} (${sid})`, regId: rid,
    claudeLine: process.env.HL_FAKE_CLAUDE === "1" ? "powershell -NoExit -Command Start-Sleep 600" : `claude ${cargs.join(" ")}` });
  const [exe, exeArgs] = windowCommand(prev.name, wd, ps1);
  console.log(JSON.stringify({ ...report, command: [exe, ...exeArgs] }, null, 2));
  append(startingLine(e)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
  const { launched, latency } = spawnWindow({ entry: e, ps1, script, exe, exeArgs, workDir: wd });
  append(launched);
  triggerTick("launch");
  console.log(launched.host_pid ? `resumed: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${gen}` : `resumed, but no pid file after 20 s (${fwd(pf)}) - check the window`);
  return 0;
}

// ---------- launch ----------
if (opt("resume")) process.exit(resumeLaunch(opt("resume")));
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
const sizeErr = sizeError(model, effort);
if (sizeErr) { console.error(sizeErr); process.exit(2); }
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
// repo key as the registry entry below gets (a failed branch read is no answer: nothing launched, as below). Merge
// sessions (merge.mjs drain launches them without --force) are exempt.
const capBranch = () => {
  if (wtBranch) return wtBranch;
  if (!root) return null;
  const b = branchRead(git(repo, "branch", "--show-current"));
  if (b.error) { console.error(`git branch --show-current failed in ${repo} (${b.error}) - nothing launched; retry`); process.exit(2); }
  return b.branch || "HEAD";
};
// ---------- provenance (batch A, Part 1): supersedes, and the occupancy check, before any side effect ----------
// The checkout this launch runs in: --worktree's existing worktree for the branch, or the one it creates; else --repo.
// The worktree section's refusals (a failed worktree list, a branch checked out in the main checkout) come first, with
// the same text and exit code: the occupancy pass never judges, refuses or closes on a checkout the launch rejects anyway.
// wl: that worktree list, which the worktree section below reuses (one `git worktree list` per launch).
const { dir: targetDir, wl } = (() => {
  if (!wtBranch) return { dir: repo, wl: null };
  const wl = worktrees(root);
  if (!wl.ok) { console.error(`git worktree list failed: ${wl.err}`); process.exit(1); }
  const any = wl.list.find((w) => w.branch === `refs/heads/${wtBranch}`);
  if (any && key(any.worktree) === key(root)) { console.error(`branch ${wtBranch} is checked out in the main checkout ${root} - drop --worktree or pick another branch`); process.exit(2); }
  const hit = wl.list.find((w) => w.branch === `refs/heads/${wtBranch}` && !w.prunable);
  return { dir: hit ? path.resolve(hit.worktree) : path.join(root, ".claude", "worktrees", slug(wtBranch)), wl };
})();
const target = { repo: key(root || repo), branch: capBranch(), worktree: fwd(targetDir) };
const explicitSup = opt("supersedes");
if (flag("supersedes") && (!explicitSup || explicitSup.startsWith("--"))) { console.error("--supersedes needs the registry id of the session this launch replaces"); process.exit(2); }
if (explicitSup && !reg.entries.some((e) => e.id === explicitSup)) { console.error(`--supersedes: no launch line has id ${explicitSup}`); process.exit(2); }
const prov = G.pickSupersedes({ entries: reg.entries, closed: reg.closed, explicit: explicitSup, hlSessionId: process.env.HL_SESSION_ID || null,
  launchedBy: process.env.CLAUDE_CODE_SESSION_ID || null, target, name, isMerge: !!group && isMergeSession(group, name) });
if (prov.note) console.error(prov.note);
// Two sessions must never share a worktree. Every fresh launch closes the target's windows whose claude is gone (an empty
// host); a launch that replaces nothing (rule 5) is refused while the target's session really runs (exit 3) unless
// --force (ask the user first); unknown liveness only warns; --dry-run reports and refuses or closes nothing.
const occupancy = { refused: null, closes: [], warnings: [] };
{
  // The open entries on the target checkout (one per id: the latest line wins).
  const occ = [...new Map(reg.entries.filter((e) => !reg.closed.has(e.id) && G.sameCheckout(e, target)).map((e) => [e.id, e])).values()];
  primeLiveness(occ);
  // Two passes (plan amendment 3): liveness for every occupant first, then ONE process scan below the running windows'
  // hosts. hostsBelow's Map is keyed by number pids; a missing pid or a failed probe (null) gives below = null.
  const judged = occ.map((e) => ({ e, lv: liveness(e, reg), pid: e.mode !== "bg" ? readPidFile(e).host_pid : null }));
  const pids = judged.filter((j) => j.lv.state === "running" && j.pid).map((j) => j.pid);
  const belowAll = pids.length ? hostsBelow(pids) : null;
  for (const { e, lv, pid } of judged) {
    const below = lv.state === "running" && e.mode !== "bg" && pid ? (belowAll?.get(Number(pid)) ?? null) : null;
    const a = G.occupantAct({ e, lv, below, ageMs: ago(e.launched_at) });
    if (a.act === "warn") occupancy.warnings.push(G.OCCUPANT_UNKNOWN({ repo: fwd(root || repo), branch: target.branch, e, why: a.why }));
    else if (a.act === "close") occupancy.closes.push(e);
    else if (a.act === "refuse" && prov.rule === "none" && !occupancy.refused) occupancy.refused = e;
  }
  for (const w of occupancy.warnings) console.error(w);
  if (occupancy.refused) {
    const text = G.OCCUPIED({ repo: fwd(root || repo), branch: target.branch, e: occupancy.refused });
    if (dry) console.error(`would be ${text}`);
    else if (flag("force")) console.error(`occupancy overridden by --force: ${text}`);
    else { console.error(text); process.exit(3); }
  }
  // closes keeps the windows that were (or, in a dry run, would be) closed: the dry-run report's would_close.
  occupancy.closes = occupancy.closes.filter((e) => { const c = closeGone(e, !dry); if (c) console.error(c.line); return !!c?.closes; });
}
const cap = group && isMergeSession(group, name) ? { exempt: "merge session" } : sessionCap(prov.supersedes);

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
  let mergeStarted, mergeUnknown = null;
  if (groupCfg) { // rolling: refused once this lane's head is merged, or while merge.lock is held for this lane
    const me = classify(groupLanes({ entries: reg.entries, merges: reg.merges, lines: reg.lines, group, repoKey: key(root), cfg: groupCfg.config, root })).find((l) => l.name === name);
    mergeStarted = me?.state === "merged" || readLock(path.dirname(doneMarker))?.lane === name;
    mergeUnknown = me?.mergeUnknown ?? null;
  } else mergeStarted = fs.existsSync(path.join(path.dirname(doneMarker), "merge.lock")) || reg.entries.some((e) => e.group === group && e.name === mergeName);
  if (flag("reopen") && mergeStarted) {
    console.error(groupCfg ? `lane ${name} is already merged (or being merged) into ${groupCfg.config.integration} - start new work as a NEW lane or group (SKILL.md section 4).`
      : `merge for ${group} already launched - --reopen would start work nothing merges. Use a NEW group (SKILL.md section 4).`);
    process.exit(3);
  }
  // An ancestry check git could not answer is never "not merged": the reopen would start work nothing merges.
  if (flag("reopen") && mergeUnknown) {
    console.error(`lane ${name}: could not tell whether its head is merged into ${groupCfg.config.integration} (${mergeUnknown}) - nothing reopened; retry --reopen once git answers`);
    process.exit(2);
  }
  if (!flag("reopen")) { console.error(`lane ${name} already wrote its done marker - start post-merge stages under a NEW group (see SKILL.md section 4), or pass --reopen to reopen this lane before the merge.`); process.exit(3); }
  if (!dry) fs.renameSync(doneMarker, `${doneMarker}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
}
warnUntracked(name); // after the group guards: a refused lane launch prints only its refusal


// Worktree: reuse the branch's worktree, or create one under <main root>/.claude/worktrees/<slug>. wl: targetDir's list
// (its refusals - a failed list, the branch checked out in the main checkout - already ran there).
let workDir = repo, wtPlan = null;
if (wtBranch) {
  const hit = wl.list.find((w) => w.branch === `refs/heads/${wtBranch}`);
  const dir = path.join(root, ".claude", "worktrees", slug(wtBranch));
  const be = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${wtBranch}`), branchExists = be.ok;
  // Exit 1 is "no such branch"; any other failure is no answer, never a reason to create it.
  if (!be.ok && be.code !== 1) { console.error(`could not check branch ${wtBranch} (${be.err || `git exited ${be.code}`}) - nothing created; retry`); process.exit(2); }
  if (hit && !hit.prunable) {
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

// A failed read is never "no current branch": the fallback would key generations and the N-2 close on the wrong branch.
// Only git < 2.22 (no --show-current, exit 129) keeps the old fallback.
const curBranch = root && fs.existsSync(workDir) ? branchRead(git(workDir, "branch", "--show-current")) : null;
if (curBranch?.error) { console.error(`git branch --show-current failed in ${workDir} (${curBranch.error}) - nothing launched; retry`); process.exit(2); }
const branch = curBranch?.branch || wtBranch || (root ? "HEAD" : null);
const repoKey = key(root || repo);
const generation = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === repoKey && e.branch === branch).map((e) => e.generation || 0));
// Lane profile + the coordinator's session hooks in ONE --settings file: before anything is recorded or started (a dry
// run of a new worktree has no workDir yet). The main checkout is a source of .mcp.json servers too, so a fresh restart
// (--repo <its worktree>) resolves the servers its first launch did.
const laneProfile = profileArgs(opt("profile"), [...new Map([workDir, repo, root].filter(Boolean).map((d) => [key(d), d])).values()], sessionHooks());
// Short pointer prompt: the handoff file carries the real instructions. No double quotes or semicolons
// (Windows PowerShell 5.1 and wt.exe both mangle them). A worktree lacks the main checkout's untracked files,
// so outside the repo dir the handoff is named by its absolute path.
const handoffRef = key(workDir) === key(repo) ? fwd(path.relative(repo, handoff)) : fwd(handoff);
const doneMarkerNote = !group || isMergeSession(group, name) ? ""
  : groupCfg ? ` Fan-out group ${group} (rolling merges): write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - then run node ${qs(fwd(fileURLToPath(import.meta.url)))} merge --group ${group} --repo ${qs(fwd(root))} --lane ${name} and report its output. Otherwise launch the lane next stage as the handoff says.`
  : ` Fan-out group ${group}: write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
// Part 9: every session keeps a checklist ("re-read" covers a resumed session and a fresh restart with --goal-from).
const GOAL_SENTENCE = " Write or re-read GOAL.md in your session scratchpad first (one goal line, then checkable items) and tick each item the moment it is done.";
const pointer = `Continue from the handoff at ${qs(handoffRef)} - read it first, then follow its paste-ready prompt section exactly.` + GOAL_SENTENCE + doneMarkerNote;
// --prompt-file: a fresh restart reuses the exact pointer prompt of the launch it replaces.
let basePrompt = pointer;
if (opt("prompt-file")) {
  try { basePrompt = fs.readFileSync(opt("prompt-file"), "utf8").trim() || pointer; }
  catch (err) { console.error(`warning: --prompt-file ${opt("prompt-file")} unreadable (${err.code || err.message}) - using the computed pointer prompt`); }
}
const clean = (s) => s.replace(/"/g, "'").replace(/;/g, ",");
// --recovery: the RECOVERY line goes in front of the prompt only; the prompt file keeps the base, so prefixes never stack.
const recovery = opt("recovery") ? `${RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))} ` : "";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// The inbox (batch A, Part 6): a fresh launch named <lane> takes it - renamed to <lane>.<stamp>.taken.md - and the prompt
// (never prompt_file: a fresh restart reuses that file) names it. A rename that fails takes nothing (the next fresh launch
// tries again); a spawn that fails renames it back; --dry-run never takes. Merge sessions have no inbox of their own.
const inboxFile = group && isMergeSession(group, name) ? null : inboxPathOf(root || repo, group, name);
let taken = null;
if (!dry && inboxFile && fs.existsSync(inboxFile)) {
  const dst = path.join(path.dirname(inboxFile), G.takenName(name, stamp));
  try { fs.renameSync(inboxFile, dst); taken = dst; } catch (err) { console.error(`warning: inbox ${fwd(inboxFile)} not taken (${err.code || err.message}) - the next fresh launch tries again`); }
}
// Give a taken inbox back. A queue may have written a new <lane>.md since the take: then the file becomes the taken items
// (older) followed by the new ones, written atomically, and the taken file goes. Otherwise a hard link puts it back
// (it never replaces a <lane>.md that appears meanwhile: EEXIST falls through to the merge); a filesystem without hard
// links gets a plain rename. A failure only warns.
function giveBackInbox(src, file) {
  try {
    if (!fs.existsSync(file)) {
      let linked = false;
      try { fs.linkSync(src, file); linked = true; } catch (err) { if (err.code !== "EEXIST") { fs.renameSync(src, file); return; } }
      if (linked) { try { fs.unlinkSync(src); } catch {} return; }
    }
    writeAtomic(file, fs.readFileSync(src, "utf8") + fs.readFileSync(file, "utf8"));
    try { fs.unlinkSync(src); } catch {} // given back already: a leftover taken file is only a record
  } catch (err) { console.error(`warning: inbox ${fwd(src)} not given back (${err.code || err.message}) - re-queue it by hand`); }
}
const giveBack = () => { if (taken) { const t = taken; taken = null; giveBackInbox(t, inboxFile); } };
// The take stands once the session is recorded (keepTake); anything that ends the launcher before that gives it back.
const keepTake = () => { taken = null; };
if (taken) process.on("exit", giveBack);
const prompt = clean(recovery + basePrompt + (taken ? G.INBOX_SENTENCE(qs(fwd(taken))) : ""));
// The profile args go before -n and the prompt: --mcp-config is variadic and would swallow the prompt.
const bgArgs = ["--bg", ...laneProfile.args, "-n", name, "--model", model, "--effort", effort, prompt];
// bg on Windows without a claude.exe runs through cmd.exe, which expands %VAR% even inside quoted args (the prompt, the
// registry dir's profile files): refuse rather than mangle them (for the .exe too: one rule, decided before the CLI is
// resolved), before anything is recorded.
const pct = mode === "bg" && process.platform === "win32" && bgArgs.find((a) => String(a).includes("%"));
if (pct) {
  giveBack();
  console.error(`a bg argument contains % (cmd.exe would expand %VAR% in it) - move the handoff or the registry dir to a path without %: ${pct}`);
  process.exit(2);
}

const id = `${name}@${stamp}`;
const pidFile = path.join(PID_DIR, `${stem(id)}.pid`);
const promptFile = path.join(PID_DIR, `${stem(id)}.prompt.txt`);
const sessionId = mode === "window" ? crypto.randomUUID() : null;
const entry = {
  id, name, repo: repoKey, branch, worktree: fwd(workDir), generation, mode, group, title: name,
  handoff: fwd(handoff), done_marker: doneMarker && fwd(doneMarker), launched_at: now(), session_id: sessionId,
  host_pid: null, host_start: null, pid_file: mode === "window" ? fwd(pidFile) : null,
  model, effort, coord: 1, prompt_file: fwd(promptFile),
  profile: laneProfile.profile, // a restart reuses it: --resume (this entry's), the tick's fresh restart (--profile <it>)
  // batch A: provenance (Part 1), the lane note's scope (Part 5), priority (Part 7)
  launched_by: process.env.CLAUDE_CODE_SESSION_ID || null, supersedes: prov.supersedes,
  scope: opt("scope") ?? (() => { try { return G.scopeOf(fs.readFileSync(handoff, "utf8")); } catch { return null; } })(),
  priority: prioArg || G.derivePriority({ model, effort }),
};
const noSpawn = process.env.HL_NO_SPAWN === "1";
// --goal-from: a convenience - a failed copy never fails the launch (in bg mode the session already runs by then).
const goalCopy = (dir, sid) => { try { copyGoal(opt("goal-from"), dir, sid); } catch (err) { console.error(`warning: GOAL.md not copied (${err.code || err.message})`); } };
if (!dry && opt("goal-from") && sessionId) goalCopy(workDir, sessionId); // window: the id is known now
if (!dry) { fs.mkdirSync(PID_DIR, { recursive: true }); fs.writeFileSync(promptFile, clean(basePrompt)); }

// Every launched session gets the coordinator's hooks (coord.mjs) on top of the user's own: the profile's --settings file
// carries them (laneProfile). session-hooks.json stays as their inspectable copy.
sessionHooksFile({ write: !dry });
if (mode === "bg") {
  console.log(JSON.stringify({ mode, worktree: wtPlan, registry_line: entry, prompt, command: ["claude", ...bgArgs], cap }, null, 2));
  if (dry) process.exit(0);
  if (noSpawn) { append(startingLine(entry)); append({ ...entry, no_spawn: true }); keepTake(); triggerTick("launch"); console.log("HL_NO_SPAWN=1: recorded, not started"); process.exit(0); }
  const before = refreshAgents();
  const env = cleanEnv({ HL_SESSION_ID: id });
  // claude.exe without a shell, so the timeout kills the real CLI and the prompt stays ONE argument. Without an .exe (an
  // npm .cmd install) claudeSpawn falls back to one pre-quoted command string through the shell (the prompt never
  // contains double quotes - they are replaced above); that path can still orphan the CLI on a timeout.
  const [file, argv, sh] = claudeSpawn(bgArgs);
  append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
  const r = spawnSync(file, argv, { cwd: workDir, env, encoding: "utf8", timeout: 120000, ...sh });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  // A launcher that failed and left no new background session: the inbox goes back for the next fresh launch.
  // The bg id comes from a before/after diff of `claude agents --json`, matched by name: a guess from the CLI output is
  // not reliable, and a session with no id is never stopped by the coordinator.
  let hit = null;
  for (let i = 0; i < 10 && before && !hit; i++) { const after = refreshAgents(); hit = after && matchNewAgent(before, after, name); if (!hit) sleep(500); }
  if (!hit && (r.error || r.status !== 0)) giveBack();
  // A new session runs with the take in its prompt: the take stands from here, even if the append below throws (the exit
  // handler would otherwise give a running session's inbox back).
  if (hit) keepTake();
  append({ ...entry, bg_id: hit?.id ?? null, session_id: hit?.sessionId ?? null, bg_output: (r.stdout || "").slice(0, 2000) });
  keepTake(); // recorded: a session that may run has the take (a failure without a new session gave it back above)
  if (opt("goal-from") && hit?.sessionId) goalCopy(null, hit.sessionId);
  triggerTick("launch");
  if (!hit) console.log(`WARN no new entry named ${name} in claude agents --json - recorded with bg_id null (the coordinator never stops it; its liveness is unknown)`);
  process.exit(r.status ?? 1);
}

const claudeArgs = [...laneProfile.args.map(psq), "-n", psq(name), "--session-id", psq(sessionId), "--model", psq(model), "--effort", psq(effort), psq(prompt)];
if (!dry && noSpawn) { // tests: record the launch, start nothing
  console.log(JSON.stringify({ mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, cap, spawned: false }, null, 2));
  append(startingLine(entry)); append({ ...entry, no_spawn: true }); keepTake();
  triggerTick("launch");
  process.exit(0);
}
const ps1 = path.join(os.tmpdir(), `claude-handoff-${stamp}.ps1`);
const script = windowScript({ pidFile, name, workDir, banner: `Handoff: ${handoffRef}`, regId: id,
  claudeLine: process.env.HL_FAKE_CLAUDE === "1" ? "powershell -NoExit -Command Start-Sleep 600" : `claude ${claudeArgs.join(" ")}` });
const [exe, exeArgs] = windowCommand(name, workDir, ps1);
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, launcher: ps1, command: [exe, ...exeArgs], cap };
if (dry) {
  report.occupancy = { refused: occupancy.refused?.id ?? null, would_close: occupancy.closes.map((e) => e.id), inbox: inboxFile && fs.existsSync(inboxFile) ? fwd(inboxFile) : null };
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(entry, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
let spawned;
try { spawned = spawnWindow({ entry, ps1, script, exe, exeArgs, workDir }); }
catch (err) { giveBack(); console.error(`the window did not start: ${err.code || err.message}`); process.exit(1); }
keepTake(); // the window started
const { launched, latency } = spawned;
append(launched);
// The tick judges loops, not the launch (the launch-time watchdog is gone): a launch only wakes it.
triggerTick("launch");
if (!launched.host_pid) {
  console.log(`launched, but no pid file after 20 s (${fwd(pidFile)}) - auto-close skipped, check the window`);
} else {
  console.log(`launched: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${generation} of ${branch}`);
  for (const l of noClose ? ["auto-close disabled (--no-close)"] : closeOld(launched, true)) console.log(l);
}
