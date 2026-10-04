// Open a fresh, clean Claude Code session that picks up a handoff document.
// Usage:
//   node launch.mjs --repo <dir> --handoff <path> [--name <label>] --model <m> --effort <level> [--mode window|bg]
//                   [--worktree <branch> [--base <ref>]] [--group <id>] [--no-close] [--dry-run]
//                   [--recovery <incident>] [--prompt-file <file>] [--goal-from <session id>]
//   node launch.mjs --resume <session id> [--recovery <incident>] [--model m --effort e]   (the coordinator's first restart)
//   node launch.mjs recover (--group <id> | --name <session>) --mode auto|report
//   node launch.mjs resume --group <id> [--lane <name>]                     (relaunch blocked lanes fresh)
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
//   status also prints, for any group, UNTRACKED sessions (a launcher died between its {starting} line and its launch
//   line) and ORPHAN processes (the tick's orphans.json, < 2 h old).
//   Every launch appends a {starting} line, then its launch line, to sessions.jsonl (next to this file). After a
//   window launch of generation N on a repo+branch, windows of generations <= N-2 there are closed - only when their
//   session is idle for >= 10 min;
//   a busy one gets a stop request instead and is retried by a later launch (--no-close disables all of it).
//   Every launch line records model, effort, coord: 1 and prompt_file (the base prompt - never a --recovery line -
//   next to the pid file).
//   Every launched session gets the coordinator hooks (session-hooks.json next to the registry -> hooks/coord.mjs) with
//   --settings, and every recorded launch wakes the coordinator tick (at most one per tick_min).
// The new session never inherits this session's CLAUDE_* environment (that makes a child think it IS this session)
// except CLAUDE_CONFIG_DIR, gets HL_SESSION_ID=<registry id>, and gets PATH fresh from the registry.
// Test hooks: HL_REGISTRY_DIR (registry, pid and stop files), HL_PROJECTS_DIR (transcript root, default
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects), HL_AGENTS_JSON (file standing in for `claude agents --json`),
// HL_FAKE_PROBE=fail|timeout (every process probe fails or times out: liveness is unknown), HL_FAKE_CLAUDE=1 (the
// window runs a sleeping powershell instead of claude), HL_NO_SPAWN=1 (record the launch - worktree, registry line -
// and start nothing; tests only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf } from "./merge.mjs";
import { PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hasClaudeBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooksFile, triggerTick, COORD, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness } from "./live.mjs";
import { RECOVERY_LINE, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine } from "./recover-lib.mjs";

const IDLE_CLOSE_MS = 10 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
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

// ---------- auto-close: windows of generations <= N-2 on this repo+branch, idle sessions only, tri-state ----------
function closeOld(repoKey, branch, n, apply) {
  const r = readRegistry();
  const cands = r.entries.filter((e) => e.repo === repoKey && e.branch === branch && e.mode === "window" && (e.generation || 0) <= n - 2 && !r.closed.has(e.id));
  primeLiveness(cands);
  const out = [];
  for (const e of cands.map(readPidFile)) {
    const tag = `${e.name} (gen ${e.generation}, pid ${e.host_pid ?? "?"})`;
    const lv = liveness(e, r);
    if (lv.state === "unknown") { out.push(`skip ${tag}: liveness unknown (${lv.why}) - nothing done`); continue; }
    if (lv.state === "gone") { if (apply) append({ closed: e.name, id: e.id, at: now(), why: lv.why }); out.push(`skip ${tag}: ${lv.why}${apply ? " - marked closed" : " - would mark closed"}`); continue; }
    const s = sessionState(e);
    let closable, why;
    if (!s.found) {
      const below = hasClaudeBelow(e.host_pid);
      if (below === null) { out.push(`skip ${tag}: no transcript and the process probe failed - nothing done`); continue; }
      closable = !below; why = closable ? "no claude running in the window" : "no transcript found but claude is running";
    } else if (!s.idle) { closable = false; why = `busy: ${s.busy.join(", ")}`; }
    // Only a turn_duration record at the turn's end says whether background agents are pending (as closeDecision): unknown keeps the window.
    else if (!s.bgKnown) { out.push(`skip ${tag}: pending background agents unknown (the turn ended without a turn_duration record) - nothing done`); continue; }
    else if (ago(s.last) < IDLE_CLOSE_MS) { out.push(`skip ${tag}: idle only ${mins(ago(s.last))} - a later launch retries`); continue; }
    else { closable = true; why = `idle ${mins(ago(s.last))}`; }
    if (!closable) { out.push(`skip ${tag}: ${why} - ${requestStop(e, `auto-close of gen ${e.generation}: ${why}`, { apply, reasonClass: "close" })}`); continue; }
    out.push(apply ? `${killTree(e, `auto-close: ${why}`, "close").line} ${tag}: ${why}` : `would close ${tag}: ${why}`);
  }
  return out;
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
  for (const l of lanes) {
    const tag = mergeTag(l), ov = l.overlap && Object.keys(l.overlap).length ? `  overlap=${JSON.stringify(l.overlap)}` : "";
    console.log(`${memberLine(l.entry, l.marker).text}${tag ? `  ${tag}` : ""}${ov}${recoveryNotes(l.entry, { legacy: false })}`);
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
  for (const e of members) { const m = memberLine(e); if (m.done) done++; console.log(m.text + recoveryNotes(e, { legacy: true })); }
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
  const blocked = blockedLanes(reg.lines, g).filter((b) => !lane || b.name === lane);
  if (!blocked.length) { console.log(`no blocked lanes in group ${g}${lane ? ` named ${lane}` : ""}`); process.exit(0); }
  let code = 0;
  for (const b of blocked) {
    const e = [...reg.entries].reverse().find((x) => x.name === b.name && x.group === g);
    if (!e) { console.log(`not relaunched: no launch line for ${b.name} in group ${g}`); code = 1; continue; }
    if (!b.incident) { console.log(`not relaunched: the lane_blocked line of ${b.name} names no incident - relaunch it by hand with --recovery <incident>`); code = 1; continue; }
    // A lane whose newest launch still runs (or cannot be judged) is never relaunched: one worktree, one session.
    const lv = liveness(e, reg);
    if (lv.state !== "gone") { console.log(`not relaunched: ${e.id} is ${lv.state} (${lv.why}) - stop it or wait for it, then re-run`); code = 1; continue; }
    warnUntracked(b.name);
    if (dry) { console.log(`would relaunch ${b.name} fresh from ${e.handoff} (incident ${b.incident})`); continue; }
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", recovery: b.incident })], { encoding: "utf8", timeout: 3 * MIN });
    // {lane_resumed} only after a launch that worked: a failed one leaves the lane blocked, so a re-run tries again.
    if (r.status === 0) { append({ lane_resumed: b.name, group: g, handoff: e.handoff, at: now() }); console.log(`relaunched ${b.name} fresh (incident ${b.incident}); restart budget reset`); }
    else { code = 1; console.log(`ERROR relaunching ${b.name}: ${`${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-5).join(" | ") || `the launcher exited ${r.status ?? r.signal ?? r.error?.code}`}`); }
  }
  process.exit(code);
}
if (sub) { console.error(`unknown subcommand ${sub}`); process.exit(2); }

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
  if (prev.mode === "bg") { console.error(`--resume: ${prev.name} is a background session - background lanes restart fresh`); return 2; }
  // A restart only after the old process is confirmed gone: running or unknown would put two sessions in one worktree.
  const lv = liveness(prev, reg);
  if (lv.state !== "gone") { console.error(`--resume: ${prev.id} is ${lv.state} (${lv.why}) - stop it or wait, then re-run`); return 1; }
  if (!prev.worktree || !fs.existsSync(prev.worktree)) { console.error(`--resume: the worktree of ${prev.name} (${prev.worktree}) no longer exists - restart it fresh`); return 2; }
  const m = opt("model") || prev.model || "opus", ef = opt("effort") || prev.effort || "high";
  const se = sizeError(m, ef);
  if (se) { console.error(`--resume: ${se}`); return 2; }
  warnUntracked(prev.name);
  const st = new Date().toISOString().replace(/[:.]/g, "-"), rid = `${prev.name}@${st}`, pf = path.join(PID_DIR, `${stem(rid)}.pid`);
  const gen = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === prev.repo && e.branch === prev.branch).map((e) => e.generation || 0));
  const text = (opt("recovery") ? RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))
    : "Resumed by the launcher: continue from your saved state and ledger resume point - re-check the repo state first, then carry on with your next step.").replace(/"/g, "'").replace(/;/g, ",");
  const e = { ...prev, id: rid, generation: gen, launched_at: now(), host_pid: null, host_start: null, pid_file: fwd(pf), model: m, effort: ef, coord: 1, resumed_from: prev.id };
  delete e.no_spawn; delete e.bg_output;
  const hooks = fwd(sessionHooksFile({ write: !dry }));
  // The prompt stays last, after single-valued flags only: a variadic flag would swallow it.
  const cargs = ["--resume", psq(sid), "-n", psq(prev.name), "--settings", psq(hooks), "--model", psq(m), "--effort", psq(ef), psq(text)];
  const report = { mode: "window", resume: sid, registry_line: e, prompt: text, claude_args: cargs };
  if (dry) { console.log(JSON.stringify(report, null, 2)); return 0; }
  fs.rmSync(path.join(COORD, "sessions", `${sid}.json`), { force: true }); // its hook state starts over: warnings fire again
  const lp = path.join(COORD, "looping.json"), loops = readJson(lp, {}) || {};
  if (loops[sid]) { delete loops[sid]; writeAtomic(lp, JSON.stringify(loops, null, 2)); } // and its old subagents' flags go
  if (process.env.HL_NO_SPAWN === "1") { console.log(JSON.stringify({ ...report, spawned: false }, null, 2)); append(startingLine(e)); append({ ...e, no_spawn: true }); triggerTick("launch"); return 0; }
  const wd = path.resolve(prev.worktree), ps1 = path.join(os.tmpdir(), `claude-handoff-${st}.ps1`);
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


// Worktree: reuse the branch's worktree, or create one under <main root>/.claude/worktrees/<slug>.
let workDir = repo, wtPlan = null;
if (wtBranch) {
  const wl = worktrees(root);
  if (!wl.ok) { console.error(`git worktree list failed: ${wl.err}`); process.exit(1); }
  const hit = wl.list.find((w) => w.branch === `refs/heads/${wtBranch}`);
  const dir = path.join(root, ".claude", "worktrees", slug(wtBranch));
  const be = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${wtBranch}`), branchExists = be.ok;
  // Exit 1 is "no such branch"; any other failure is no answer, never a reason to create it.
  if (!be.ok && be.code !== 1) { console.error(`could not check branch ${wtBranch} (${be.err || `git exited ${be.code}`}) - nothing created; retry`); process.exit(2); }
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

// A failed read is never "no current branch": the fallback would key generations and the N-2 close on the wrong branch.
// Only git < 2.22 (no --show-current, exit 129) keeps the old fallback.
const curBranch = root && fs.existsSync(workDir) ? branchRead(git(workDir, "branch", "--show-current")) : null;
if (curBranch?.error) { console.error(`git branch --show-current failed in ${workDir} (${curBranch.error}) - nothing launched; retry`); process.exit(2); }
const branch = curBranch?.branch || wtBranch || (root ? "HEAD" : null);
const repoKey = key(root || repo);
const generation = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === repoKey && e.branch === branch).map((e) => e.generation || 0));
// Short pointer prompt: the handoff file carries the real instructions. No double quotes or semicolons
// (Windows PowerShell 5.1 and wt.exe both mangle them). A worktree lacks the main checkout's untracked files,
// so outside the repo dir the handoff is named by its absolute path.
const handoffRef = key(workDir) === key(repo) ? fwd(path.relative(repo, handoff)) : fwd(handoff);
const laneNote = !group || isMergeSession(group, name) ? ""
  : groupCfg ? ` Fan-out group ${group} (rolling merges): write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - then run node ${qs(fwd(fileURLToPath(import.meta.url)))} merge --group ${group} --repo ${qs(fwd(root))} --lane ${name} and report its output. Otherwise launch the lane next stage as the handoff says.`
  : ` Fan-out group ${group}: write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
const pointer = `Continue from the handoff at ${qs(handoffRef)} - read it first, then follow its paste-ready prompt section exactly.` + laneNote;
// --prompt-file: a fresh restart reuses the exact pointer prompt of the launch it replaces.
let basePrompt = pointer;
if (opt("prompt-file")) {
  try { basePrompt = fs.readFileSync(opt("prompt-file"), "utf8").trim() || pointer; }
  catch (err) { console.error(`warning: --prompt-file ${opt("prompt-file")} unreadable (${err.code || err.message}) - using the computed pointer prompt`); }
}
const clean = (s) => s.replace(/"/g, "'").replace(/;/g, ",");
// --recovery: the RECOVERY line goes in front of the prompt only; the prompt file keeps the base, so prefixes never stack.
const recovery = opt("recovery") ? `${RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))} ` : "";
const prompt = clean(recovery + basePrompt);
// bg on Windows without a claude.exe runs through cmd.exe, which expands %VAR% even inside the quoted prompt: refuse
// rather than mangle it (for the .exe too: one rule, decided before the CLI is resolved).
if (mode === "bg" && process.platform === "win32" && prompt.includes("%")) {
  console.error(`the prompt contains % (cmd.exe would expand %VAR% in it) - move the handoff to a path without %: ${prompt}`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const id = `${name}@${stamp}`;
const pidFile = path.join(PID_DIR, `${stem(id)}.pid`);
const promptFile = path.join(PID_DIR, `${stem(id)}.prompt.txt`);
const sessionId = mode === "window" ? crypto.randomUUID() : null;
const entry = {
  id, name, repo: repoKey, branch, worktree: fwd(workDir), generation, mode, group, title: name,
  handoff: fwd(handoff), done_marker: doneMarker && fwd(doneMarker), launched_at: now(), session_id: sessionId,
  host_pid: null, host_start: null, pid_file: mode === "window" ? fwd(pidFile) : null,
  model, effort, coord: 1, prompt_file: fwd(promptFile),
};
const noSpawn = process.env.HL_NO_SPAWN === "1";
// --goal-from: a convenience - a failed copy never fails the launch (in bg mode the session already runs by then).
const goalCopy = (dir, sid) => { try { copyGoal(opt("goal-from"), dir, sid); } catch (err) { console.error(`warning: GOAL.md not copied (${err.code || err.message})`); } };
if (!dry && opt("goal-from") && sessionId) goalCopy(workDir, sessionId); // window: the id is known now
if (!dry) { fs.mkdirSync(PID_DIR, { recursive: true }); fs.writeFileSync(promptFile, clean(basePrompt)); }

// Every launched session gets the coordinator's hooks (coord.mjs) on top of the user's own: --settings layers them.
const hooksFile = fwd(sessionHooksFile({ write: !dry }));
if (mode === "bg") {
  const bgArgs = ["--bg", "-n", name, "--settings", hooksFile, "--model", model, "--effort", effort, prompt];
  console.log(JSON.stringify({ mode, worktree: wtPlan, registry_line: entry, prompt, command: ["claude", ...bgArgs] }, null, 2));
  if (dry) process.exit(0);
  if (noSpawn) { append(startingLine(entry)); append({ ...entry, no_spawn: true }); triggerTick("launch"); console.log("HL_NO_SPAWN=1: recorded, not started"); process.exit(0); }
  const before = refreshAgents();
  const env = cleanEnv({ HL_SESSION_ID: id });
  // claude.exe without a shell, so the timeout kills the real CLI and the prompt stays ONE argument. Without an .exe (an
  // npm .cmd install) claudeSpawn falls back to one pre-quoted command string through the shell (the prompt never
  // contains double quotes - they are replaced above); that path can still orphan the CLI on a timeout.
  const [file, argv, sh] = claudeSpawn(bgArgs);
  append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
  const r = spawnSync(file, argv, { cwd: workDir, env, encoding: "utf8", timeout: 120000, ...sh });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  // The bg id comes from a before/after diff of `claude agents --json`, matched by name: a guess from the CLI output is
  // not reliable, and a session with no id is never stopped by the coordinator.
  let hit = null;
  for (let i = 0; i < 10 && before && !hit; i++) { const after = refreshAgents(); hit = after && matchNewAgent(before, after, name); if (!hit) sleep(500); }
  append({ ...entry, bg_id: hit?.id ?? null, session_id: hit?.sessionId ?? null, bg_output: (r.stdout || "").slice(0, 2000) });
  if (opt("goal-from") && hit?.sessionId) goalCopy(null, hit.sessionId);
  triggerTick("launch");
  if (!hit) console.log(`WARN no new entry named ${name} in claude agents --json - recorded with bg_id null (the coordinator never stops it; its liveness is unknown)`);
  process.exit(r.status ?? 1);
}

const claudeArgs = ["-n", psq(name), "--session-id", psq(sessionId), "--settings", psq(hooksFile), "--model", psq(model), "--effort", psq(effort), psq(prompt)];
if (!dry && noSpawn) { // tests: record the launch, start nothing
  console.log(JSON.stringify({ mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, spawned: false }, null, 2));
  append(startingLine(entry)); append({ ...entry, no_spawn: true });
  triggerTick("launch");
  process.exit(0);
}
const ps1 = path.join(os.tmpdir(), `claude-handoff-${stamp}.ps1`);
const script = windowScript({ pidFile, name, workDir, banner: `Handoff: ${handoffRef}`, regId: id,
  claudeLine: process.env.HL_FAKE_CLAUDE === "1" ? "powershell -NoExit -Command Start-Sleep 600" : `claude ${claudeArgs.join(" ")}` });
const [exe, exeArgs] = windowCommand(name, workDir, ps1);
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, launcher: ps1, command: [exe, ...exeArgs] };
if (dry) {
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(repoKey, branch, generation, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
const { launched, latency } = spawnWindow({ entry, ps1, script, exe, exeArgs, workDir });
append(launched);
// The tick judges loops, not the launch (the launch-time watchdog is gone): a launch only wakes it.
triggerTick("launch");
if (!launched.host_pid) {
  console.log(`launched, but no pid file after 20 s (${fwd(pidFile)}) - auto-close skipped, check the window`);
} else {
  console.log(`launched: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${generation} of ${branch}`);
  for (const l of noClose ? ["auto-close disabled (--no-close)"] : closeOld(repoKey, branch, generation, true)) console.log(l);
}
