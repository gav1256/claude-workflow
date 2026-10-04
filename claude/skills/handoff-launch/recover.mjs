// The stage-2 coordinator tick: scan the launcher registry, flag loops, run the ladder (stop request -> grace ->
// incident -> kill -> restart or block), close idle superseded N-1 windows (all groups) and paused or incident windows
// (auto mode) through the guarded close, raise alerts. Every decision comes from recover-lib.mjs; this file reads state
// and acts. It writes only: the target's registry lines, stop file and incident; looping.json; alerts/; and its own
// tick.json, tick.lock, last-tick.txt, restart logs, housekeeping.json and orphans.json. Once an hour it prunes its own
// old files (prune below). Never a done marker, merge.lock, another lane's files or another worktree. Liveness
// `unknown` is never acted on: no stop, kill, close, restart or block is decided from it. Sessions a dead launcher left
// untracked and orphaned processes are only reported.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as L from "./recover-lib.mjs";
import * as V from "./live.mjs";
import { fwd, stem, isMergeSession } from "./merge-lib.mjs";

// HL_LAUNCH_MJS: tests stand a fake launcher in for launch.mjs.
const LAUNCH = process.env.HL_LAUNCH_MJS || path.join(V.HERE, "launch.mjs");
const C = (...p) => path.join(V.COORD, ...p);
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const plainId = (v) => typeof v === "string" && /^[\w-]+$/.test(v);
export const loadCfg = () => { let t = null; try { t = fs.readFileSync(C("config.json"), "utf8"); } catch {} return L.loadConfig(t); };
export const pauseActive = (now = Date.now()) => { const p = V.readJson(C("pause.json"), null); return !!p && (p.until == null || Date.parse(p.until) > now); };
const pausedLine = (lines, e) => lines.some((o) => o.paused && (o.paused === e.name || o.paused === e.id) && (Date.parse(o.at) || 0) >= (Date.parse(e.launched_at) || 0));
const isMergeName = (e) => !!e.group && isMergeSession(e.group, e.name);
const incidentPath = (e, n) => (e.done_marker ? path.join(path.dirname(e.done_marker), "incidents", `${stem(e.name)}-${n}.md`) : C("incidents", `${stem(e.name)}-${n}.md`));

// ---------- tick.lock: exclusive create; a dead or > 10 min old holder is reclaimed, a hung one killed first ----------
// out: the tick's output lines (a killed hung holder is reported there, never in the registry: it is not a session).
export function acquireTickLock(out = []) {
  fs.mkdirSync(V.COORD, { recursive: true });
  const f = C("tick.lock");
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: V.selfStart(), at: V.now() }), { flag: "wx" }); return true; }
    catch (e) { if (e.code !== "EEXIST") return false; }
    const held = V.readJson(f, null);
    if (!held) { // unreadable: a tick may be writing it this instant - a fresh file is held, an old one is junk
      let age = Infinity; try { age = Date.now() - fs.statSync(f).mtimeMs; } catch {}
      if (age < 10000) return false;
    }
    // A live pid whose process started well after the lock was taken is another process (PID reuse): the holder is dead.
    const p = held?.start && process.platform === "win32" ? V.procInfo([held.pid])?.get(held.pid) : null; // procStart, plus the name
    const st = p?.start ? Date.parse(p.start) : null, reused = st != null && st - Date.parse(held.start) > 10000;
    const alive = !!held && V.pidAlive(held.pid);
    if (alive && !reused && V.ago(held.at) < 10 * L.MIN) return false;
    // Older than 10 min (touchTickLock keeps a working tick's lock fresh) and still the process that took it - a node
    // process whose start time matches the lock's within 2 s (selfStart is the OS start time within well under a
    // second; the 10 s reclaim tolerance above is looser on purpose): a hung tick (~50-80 MB), killed before the
    // reclaim. Every condition is named here: a lock whose age does not parse, an unknown (failed probe) or a different
    // start time only reclaims - never a kill on a guess.
    const hung = alive && V.ago(held.at) >= 10 * L.MIN && st != null && Math.abs(st - Date.parse(held.start)) <= 2000 && /^node$/i.test(p.name) && held.pid !== process.pid;
    // Move aside only the lock judged dead here; if another tick replaced it meanwhile, put that one back.
    const aside = `${f}.reclaimed-${process.pid}`;
    try { fs.renameSync(f, aside); } catch { continue; }
    if (JSON.stringify(V.readJson(aside, null)) === JSON.stringify(held)) {
      fs.rmSync(aside, { force: true });
      if (hung) { // after winning the reclaim, so two ticks never both kill it
        const k = V.killPidTree(held.pid);
        out.push(k.ok ? `tick: killed hung tick ${held.pid} (lock held since ${held.at})` : `tick: hung tick ${held.pid} not killed: ${k.why} (lock held since ${held.at}) - lock reclaimed`);
      }
    } else { try { fs.renameSync(aside, f); } catch {} return false; }
  }
  return false;
}
// Never throws (it runs in tick's finally): a lock it cannot remove names this process, which is dead once the tick
// exits, so the next tick reclaims it.
export const releaseTickLock = () => { const f = C("tick.lock"); try { if (V.readJson(f, {})?.pid === process.pid) fs.rmSync(f, { force: true }); } catch {} };
// A long tick keeps its lock fresh - before each restart (up to 3 min), each resumed ladder, each scan and close
// candidate - so the 10-min hung-tick threshold measures idleness, not total work, and a working tick is never reclaimed
// or killed. A no-op without the lock (a dry run).
function touchTickLock() {
  const f = C("tick.lock"), l = V.readJson(f, null);
  if (l?.pid === process.pid) { try { V.writeAtomic(f, JSON.stringify({ ...l, at: V.now() })); } catch {} }
}

// ---------- what the tick reads per live session ----------
export function observe(e, { prevRun, looping, now }) {
  const sid = e.session_id || null, since = Date.parse(e.launched_at) || 0;
  const file = V.transcriptOf(sid);
  const entries = file ? V.tail(file).filter((x) => !x.isSidechain) : [];
  const calls = L.toolCalls(entries, since);
  // From the main transcript and the launch line only: rule (d) measures the parent's own idleness, so a looping
  // subagent's growth must never refresh it (rule (b) gets subagent growth separately, from subs[].grewAt).
  const lastEntryAt = entries.reduce((m, x) => Math.max(m, Date.parse(x.timestamp) || 0), since);
  const all = V.subagentFiles(sid).filter((s) => s.mtimeMs >= since);
  // Read only subagent transcripts that grew since the previous tick or are still flagged; the rest count as activity.
  const subs = all.map((s) => {
    if (!(s.mtimeMs > prevRun) && !looping?.[s.agentId]) return { id: s.agentId, type: s.meta?.agentType || null, file: fwd(s.file), calls: [], grewAt: s.mtimeMs, done: false };
    const se = V.tail(s.file);
    return { id: s.agentId, type: s.meta?.agentType || null, file: fwd(s.file), calls: L.toolCalls(se, since), grewAt: s.mtimeMs, done: L.agentDone(se) };
  });
  const hook = (plainId(sid) && V.readJson(C("sessions", `${sid}.json`), {})) || {};
  return { sid, file, entries, calls, lastEntryAt, subs, hook, hooked: e.coord === 1, now, tokens: L.contextTokens(entries), waitingSince: hook.waiting_since || null };
}

// ---------- alerts (Task 9 adds the desktop notification) ----------
export function raiseAlert({ name, text, incident }) {
  const base = `${V.now().replace(/[:.]/g, "-")}-${stem(name)}`;
  let f = C("alerts", `${base}.json`);
  for (let i = 2; fs.existsSync(f); i++) f = C("alerts", `${base}-${i}.json`); // two alerts in one millisecond: both kept
  V.writeAtomic(f, JSON.stringify({ text, incident, created: V.now() }, null, 2));
  return f;
}
// A tick state file (looping.json, alerts/index.json) that cannot be written costs one "error:" line, never the scan's
// other lines: they are the record of what this tick already did. -> [] or [that line]
function writeState(file, value, label) {
  try { V.writeAtomic(file, JSON.stringify(value, null, 2)); return []; }
  catch (err) { return [`error: ${label} not written (${err?.code || err?.message || err})`]; }
}

// ---------- incident, kill, restart, block ----------
// subFlags: this tick's looping subagents (detect's subFlags). Whatever rule escalated, they are listed with their own
// calls: under a foreground Agent call rule (b) wins, and its parent-side calls alone would hide the real cause.
function writeIncident(e, flag, obs, n, file, mode, subFlags = {}) {
  const subsAll = V.subagentFiles(e.session_id).map((s) => ({ ...s, entries: V.tail(s.file) }));
  const others = subsAll.filter((s) => s.meta?.requestShape === "background" && s.agentId !== flag.scope && !L.agentDone(s.entries))
    .map((s) => ({ id: s.agentId, type: s.meta?.agentType, description: s.meta?.description }));
  const subCalls = (id) => obs.subs.find((s) => s.id === id)?.calls || [];
  const calls = flag.rule === "d" ? subCalls(flag.scope) : obs.calls;
  const looping = Object.entries(subFlags || {}).map(([id, a]) => ({ id, type: a.type, text: a.text, calls: subCalls(id).map((c) => c.key) }));
  V.writeAtomic(file, L.incidentText({ lane: e.name, n, at: V.now(), name: e.name, id: e.id, sessionId: e.session_id, generation: e.generation,
    rule: flag.rule, signature: flag.signature, text: flag.text, tokens: obs.tokens, branch: e.branch, worktree: e.worktree, handoff: e.handoff,
    mode, calls: calls.map((c) => c.key), looping, main: obs.file && fwd(obs.file), subs: subsAll.map((s) => ({ id: s.agentId, type: s.meta?.agentType, file: fwd(s.file) })), others }));
}
// The lane's next incident number and file, from a fresh registry read: two incidents in one tick (two signatures of
// one session, or two generations of a lane) never share a number or a file.
const nextIncident = (e) => { const n = 1 + V.readRegistry().lines.filter((o) => o.incident && o.name === e.name).length; return { n, file: fwd(incidentPath(e, n)) }; };
// Write one incident and its {incident} line (report and auto mode alike). -> its path
function recordIncident(e, flag, obs, mode, subFlags) {
  const { n, file } = nextIncident(e);
  writeIncident(e, flag, obs, n, file, mode, subFlags);
  V.append({ incident: e.id, name: e.name, n, path: file, signature: flag.signature, rule: flag.rule, tokens: obs.tokens, mode, at: V.now() });
  return file;
}
function incidentAndKill(e, flag, obs, { dryRun, cfg, subFlags }) {
  if (dryRun) return [`would write ${nextIncident(e).file} and kill ${e.name}: ${flag.text}`];
  const file = recordIncident(e, flag, obs, "auto", subFlags);
  return [`incident ${file} for ${e.name} (${flag.text})`, ...killAndContinue(e, cfg)];
}
function killAndContinue(e, cfg) {
  const k = V.killTree(e, "loop ladder: still looping after the grace period", "ladder");
  if (!k.closed) return [`kill of ${e.name}: ${k.line} - the next tick retries`];
  return [`killed ${e.name}: ${k.line}`, ...afterKill(e, cfg)];
}
// The restart runs to its end (3 min at most): the launcher records the new session, starts its window or background
// session detached, and exits. Its output goes to CFG/state/coord/restarts/<name>-<stamp>.log; when that log cannot be
// written, `log` says so ("not written (<code>)") instead of naming a missing file. -> {ok, why, log, started}
function spawnLaunch(name, argv) {
  const log = C("restarts", `${stem(name)}-${V.now().replace(/[:.]/g, "-")}.log`), started = V.now();
  touchTickLock();
  const r = spawnSync(process.execPath, [LAUNCH, ...argv], { encoding: "utf8", timeout: 3 * L.MIN, windowsHide: true });
  let logRef = fwd(log);
  try { V.writeAtomic(log, `node launch.mjs ${argv.join(" ")}\nexit ${r.status ?? r.error?.code ?? r.signal}\n${r.stdout || ""}${r.stderr || ""}`); }
  catch (err) { logRef = `not written (${err?.code || err?.message || err})`; }
  const last = `${r.stderr || ""}${r.stdout || ""}`.trim().split(/\r?\n/).at(-1) || "";
  const why = r.status === 0 ? null : r.error?.code === "ETIMEDOUT" ? "the launcher did not finish in 3 min" : `the launcher exited ${r.status ?? r.signal ?? r.error?.code}: ${last}`;
  return { ok: r.status === 0, why, log: logRef, started };
}
// Gap 17, for every end of a killed lane's ladder (afterKill, and reportBlock under report mode): only the newest
// generation of a lane is restarted or blocked - two sessions never share a worktree, and an old handoff never restarts
// over a lane that moved on to a later stage. Any newer launch without a {closed} line supersedes e. -> null when there
// is none; else the lines of the decision: running -> {restart_skipped}; unknown -> nothing written, the next tick
// retries; gone without a close -> {lane_blocked} + an alert. done/defer: how the caller's lines begin.
function supersede(e, reg, inc, { done, defer }) {
  const newer = reg.entries.filter((x) => x.id !== e.id && x.repo === e.repo && x.branch === e.branch && (x.generation || 0) > (e.generation || 0) && !reg.closed.has(x.id));
  if (!newer.length) return null;
  // Probed now, not from the memo: an earlier step of this tick (a 3-min restart) can leave it minutes old.
  for (const x of newer) V.forgetLiveness(x.id);
  const n = newer.at(-1), lvs = newer.map((x) => ({ x, lv: V.liveness(x, reg) }));
  const run = lvs.find((s) => s.lv.state === "running");
  if (run) {
    V.append({ restart_skipped: e.id, name: e.name, why: `superseded by ${run.x.id}`, at: V.now() });
    return [`${done}: superseded by ${run.x.id}`];
  }
  // Unknown (a failed probe, a window still starting) is never a decision: no skip that ends the ladder, no block.
  const unk = lvs.find((s) => s.lv.state === "unknown");
  if (unk) return [`${defer}: its newer launch ${unk.x.id} has liveness unknown (${unk.lv.why}) - the next tick retries`];
  // The newer launch is gone without a close: blocked + alert; launch.mjs resume relaunches from the newest line.
  V.append({ lane_blocked: e.name, group: e.group || null, handoff: n.handoff, incident: inc?.path ?? null, at: V.now() });
  const text = `${e.name} was killed for a loop, but its newer launch ${n.id} is gone without a close: not restarted from the old handoff. `
    + (e.group ? `Check it, then: node ${fwd(LAUNCH)} resume --group ${e.group} --lane ${e.name}` : `Check it, then relaunch from ${n.handoff} with launch.mjs.`);
  return [`${done}: superseded by ${n.id}, which is gone - blocked, alert ${fwd(raiseAlert({ name: e.name, text, incident: inc?.path ?? null }))}`];
}
function afterKill(e, cfg) {
  const reg = V.readRegistry(), inc = [...reg.lines].reverse().find((o) => o.incident === e.id && o.mode === "auto");
  const sup = supersede(e, reg, inc, { done: `${e.name} killed, not restarted`, defer: `restart of ${e.name} deferred` });
  if (sup) return sup;
  if (!inc) return [`${e.name}: killed without an incident - not restarted`];
  const lastRestart = [...reg.lines].reverse().find((o) => o.restart === e.name && o.handoff === e.handoff);
  const prevInc = lastRestart && [...reg.lines].reverse().find((o) => o.incident && o.name === e.name && o.n === lastRestart.n);
  const plan = L.afterKillPlan({ lines: reg.lines, entry: e, incident: inc, cfg, doneMarkerExists: !!e.done_marker && fs.existsSync(e.done_marker),
    pauseActive: pauseActive(), prevCauseFilled: prevInc ? L.causeFilled(readText(prevInc.path)) : true });
  if (plan.do === "defer") return [`restart of ${e.name} deferred: ${plan.why}`];
  if (plan.do === "skip") { V.append({ restart_skipped: e.id, name: e.name, why: plan.why, at: V.now() }); return [`${e.name} killed, not restarted: ${plan.why}`]; }
  if (plan.do === "block") return block(e, inc, plan.restarts);
  const argv = plan.kind === "resume" ? ["--resume", e.session_id, "--recovery", inc.path, "--model", plan.model, "--effort", plan.effort]
    : L.freshLaunchArgs(e, { model: plan.model, effort: plan.effort, recovery: inc.path });
  const r = spawnLaunch(e.name, argv);
  if (!r.ok && V.readRegistry().entries.some((x) => x.name === e.name && x.launched_at >= r.started)) {
    // The launcher registered the session before it failed or timed out (merge.mjs makes the same check): that session
    // owns the worktree now, so this is a restart, never a block. It may not be running (a bg session whose id was never
    // captured stays unknown), so the user is told.
    V.append({ restart: e.name, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, model: plan.model, effort: plan.effort, launcher_exit: r.why, at: V.now() });
    const text = `Restart of ${e.name} was registered but its launcher ${r.why.replace(/^the launcher /, "")} (log ${r.log}). `
      + `Check ${e.group ? `status --group ${e.group}` : "claude agents"}; if it is not running, stop/judge it and relaunch by hand.`;
    const f = raiseAlert({ name: e.name, text, incident: inc.path });
    return [`restarted ${e.name}: ${plan.kind} (${plan.model}/${plan.effort}) - the launcher then failed (${r.why}, log ${r.log}), but it registered the session - alert ${fwd(f)}`];
  }
  if (!r.ok) { // never a silent loss: the lane is blocked (status shows it, launch.mjs resume relaunches it) and alerted
    V.append({ restart_failed: e.name, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, why: r.why, log: r.log, at: V.now() });
    V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc.path, at: V.now() });
    const f = raiseAlert({ name: e.name, text: L.ALERT.restartFailed({ name: e.name, group: e.group, why: r.why, log: r.log, incident: inc.path, launchMjs: fwd(LAUNCH), handoff: e.handoff }), incident: inc.path });
    return [`restart of ${e.name} failed: ${r.why} (log ${r.log}) - blocked, alert ${fwd(f)}`];
  }
  V.append({ restart: e.name, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, model: plan.model, effort: plan.effort, at: V.now() });
  return [`restarted ${e.name}: ${plan.kind} (${plan.model}/${plan.effort})`];
}
function block(e, inc, restarts) {
  V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc.path, at: V.now() });
  const lane = e.group && e.name.startsWith(`${e.group}-merge-`) ? e.name.slice(`${e.group}-merge-`.length) : null;
  const text = isMergeName(e) ? L.ALERT.mergeCap({ name: e.name, group: e.group, lane, incident: inc.path, launchMjs: fwd(LAUNCH) })
    : L.ALERT.blocked({ name: e.name, group: e.group, restarts, incident: inc.path, launchMjs: fwd(LAUNCH), handoff: e.handoff });
  return [`BLOCKED ${e.name} after ${restarts} restart(s): incident ${inc.path} - alert ${fwd(raiseAlert({ name: e.name, text, incident: inc.path }))}`];
}

// ---------- the ladder resumes from registry state (the tick can die between kill and restart) ----------
// Before a kill that has not started, or a retry, detection runs again on the current transcript: the session may have
// stopped repeating, saved its state, or opened AskUserQuestion since the incident. -> why the kill is off, or null.
function whyNotFiring(e, inc, { reg, cfg, prevRun, now, lv }) {
  const obs = observe(e, { prevRun, looping: (V.readJson(C("looping.json"), {}) || {})[e.session_id], now });
  const det = L.detect({ ...obs, paused: pausedLine(reg.lines, e), pauseActive: pauseActive(now), liveState: lv.state }, cfg);
  if (det.exempt) return det.exempt;
  return det.flags.some((f) => f.signature === inc.signature) ? null : "the rule stopped firing";
}
function cancelBeforeKill(e, inc, why) {
  V.append({ ladder_cancelled: e.id, name: e.name, signature: inc.signature, incident: inc.path, at: V.now() });
  dropStop(e, inc.signature);
  return `cancelled the ladder ${inc.signature} of ${e.name}: ${why} before the kill (incident ${inc.path} kept)`;
}
// A pending ladder of a session switched to report mode after its auto incident gets no kill and no restart. Once the
// session is closed or gone, the ladder ends as afterKill's would, minus the restart: superseded by a newer launch
// (relaunched by hand) or held while that one is unknown; otherwise the lane is dead, and {lane_blocked} + one alert
// say so (status shows it, launch.mjs resume relaunches it) - never a silent loss nor a "pending" line every tick.
function reportBlock(e, inc, state, reg, dryRun) {
  const why = `the recovery mode is report and the session is ${state}`;
  if (dryRun) return [`would end the ladder of ${e.name}: ${why} - superseded if a newer launch runs, else blocked (incident ${inc.path})`];
  const sup = supersede(e, reg, inc, { done: `pending ${e.name}: ${why}, not restarted`, defer: `block of ${e.name} deferred` });
  if (sup) return sup;
  V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc.path, at: V.now() });
  const text = `${e.name} has an auto-mode loop incident (${inc.path}) and its session is ${state}, but its recovery mode is now report: it is not restarted. `
    + (e.group ? `Resume it: node ${fwd(LAUNCH)} resume --group ${e.group} --lane ${e.name}` : `Relaunch it from ${e.handoff} with launch.mjs.`);
  return [`pending ${e.name}: ${why} - blocked, alert ${fwd(raiseAlert({ name: e.name, text, incident: inc.path }))}`];
}
function resumeOne(p, e, reg, { dryRun, cfg, prevRun, now }) {
  const inc = p.incident, report = L.recoveryMode(reg.lines, e) === "report", closed = p.closed || reg.closed.has(e.id);
  if (closed) return report ? reportBlock(e, inc, "closed", reg, dryRun) : dryRun ? [`would restart or block ${e.name} (killed, no restart recorded)`] : afterKill(e, cfg);
  V.forgetLiveness(e.id);
  const lv = V.liveness(e, reg);
  if (lv.state === "unknown") return [`pending ${e.name}: liveness unknown (${lv.why}) - no action`];
  if (report) {
    if (lv.state !== "gone") return [`pending ${e.name}: the recovery mode is report - no kill or restart (incident ${inc.path})`]; // held; auto mode would resume it
    // The kill went through and the tick died before recording it: the close goes first, as on the auto path, so the
    // launch line is never probed again at every tick.
    if (p.intent && !dryRun) V.append({ closed: e.name, id: e.id, at: V.now(), why: "gone after the ladder kill" });
    return reportBlock(e, inc, `gone (${lv.why})`, reg, dryRun);
  }
  if (lv.state === "gone" && p.intent) { // the kill went through and the tick died before recording it
    if (dryRun) return [`would record the close of ${e.name}, then restart or block it (${inc.path})`];
    V.append({ closed: e.name, id: e.id, at: V.now(), why: "gone after the ladder kill" });
    return afterKill(e, cfg);
  }
  const why = whyNotFiring(e, inc, { reg, cfg, prevRun, now, lv });
  if (why) return [dryRun ? `would cancel the ladder ${inc.signature} of ${e.name}: ${why} before the kill` : cancelBeforeKill(e, inc, why)];
  if (dryRun) return [`would kill ${e.name}, then restart or block it (${inc.path})`];
  return killAndContinue(e, cfg); // running: (re)try the kill; gone with no kill_intent: recorded closed, then restarted
}
function resumePending({ dryRun, cfg, prevRun, now, repoKey }) {
  const out = [];
  for (const p of L.pendingLadders(V.readRegistry().lines)) {
    const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === p.id);
    if (!e || (repoKey && e.repo !== repoKey)) continue;
    // One session's failure (a transcript read, a write) never stops the other sessions' ladders; the registry state
    // lets the next tick pick this one up where it stopped.
    touchTickLock(); // per session: the 10-min hung-tick threshold measures idleness, not this tick's total work
    try { out.push(...resumeOne(p, e, reg, { dryRun, cfg, prevRun, now })); }
    catch (err) { out.push(`error ${e.name}: ${err?.message || err} - the next tick retries`); }
  }
  return out;
}

// ---------- scan ----------
function reportOnly(e, det, obs, { dryRun, cfg, now, alerts, reg }) {
  const out = [];
  for (const f of det.flags) {
    const k = `${e.id}|${f.signature}`, had = reg.lines.find((o) => o.incident === e.id && o.signature === f.signature);
    if (had && !L.alertDue(alerts, k, now, cfg)) continue;
    if (dryRun) { out.push(`report-only ${e.name}: ${f.text} - would ${had ? "alert again" : "write an incident and alert"}`); continue; }
    const file = had?.path ?? recordIncident(e, f, obs, "report", det.subFlags);
    raiseAlert({ name: e.name, text: L.ALERT.report({ name: e.name, group: e.group, text: f.text, incident: file, launchMjs: fwd(LAUNCH) }), incident: file });
    // Recorded with the alert, not at scan end: a tick that dies later in the scan never alerts this signature again.
    alerts[k] = V.now();
    out.push(`report-only ${e.name}: ${f.text} - incident ${file}, alerted`, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json"));
  }
  return out;
}
// Remove a ladder's stop file while it is still pending (same token), so a cancelled request is never delivered later.
function dropStop(e, signature) {
  const s = [...V.readRegistry().lines].reverse().find((o) => o.stop_requested === e.id && o.reason_class === "ladder" && o.signature === signature);
  const f = path.join(V.STOP_DIR, `${stem(e.id)}.ladder.stop.json`);
  if (s && V.readJson(f, null)?.token === s.token) fs.rmSync(f, { force: true });
}
function runLadder(e, det, obs, { dryRun, cfg, now, reg }) {
  const out = [], tag = `${e.name} (gen ${e.generation ?? "?"})`;
  const callsFor = (f) => (f.rule === "d" ? obs.subs.find((s) => s.id === f.scope)?.calls || [] : obs.calls);
  // Permission waits (kept by the hook) never count toward the grace period.
  const waits = [...(Array.isArray(obs.hook.waits) ? obs.hook.waits : []), ...(obs.waitingSince ? [[Date.parse(obs.waitingSince), null]] : [])];
  for (const a of L.ladderActions({ lines: reg.lines, entry: e, flags: det.flags, callsFor, now, cfg, waits })) {
    const f = a.flag;
    if (a.do === "cancel") {
      out.push(`${dryRun ? "would cancel" : "cancelled"} the ladder ${a.signature} of ${tag}: ${a.why === "stop expired" ? "its stop request expired undelivered" : "the rule stopped firing"}`);
      if (!dryRun) { V.append({ ladder_cancelled: e.id, name: e.name, signature: a.signature, ...(a.why ? { why: a.why } : {}), at: V.now() }); dropStop(e, a.signature); }
    }
    else if (a.do === "rearm") { out.push(`LOOPING ${tag}: ${f.text} - fired again within 60 min of its cancel: ${dryRun ? "would resume" : "resumed"} at the grace step`); if (!dryRun) V.append({ ladder_rearmed: e.id, name: e.name, signature: a.signature, at: V.now() }); }
    else if (a.do === "stop") out.push(`LOOPING ${tag}: ${f.text} - ${V.requestStop(e, `loop: ${f.text}`, { apply: !dryRun, reasonClass: "ladder", signature: a.signature, text: L.STOP_TEXT_LADDER(a.signature), force: true })}`);
    else if (a.do === "wait") out.push(`LOOPING ${tag}: ${a.signature} - ${a.why}`);
    else if (a.do === "kill") out.push(...incidentAndKill(e, f, obs, { dryRun, cfg, subFlags: det.subFlags }));
  }
  return out;
}
function scan({ dryRun, cfg, prevRun, now, repoKey }) {
  const out = [], first = V.readRegistry();
  const loopingAll = V.readJson(C("looping.json"), {}) || {}, nextLooping = { ...loopingAll };
  const alerts = V.readJson(C("alerts", "index.json"), {}) || {};
  const cands = first.entries.filter((e) => !first.closed.has(e.id) && (!repoKey || e.repo === repoKey));
  V.primeLiveness(cands);
  for (const c of cands) {
    touchTickLock(); // per candidate, as in resumePending
    try {
      const reg = V.readRegistry(); // fresh read before each decision, never a start-of-run snapshot
      const e = reg.entries.find((x) => x.id === c.id);
      if (!e || reg.closed.has(e.id)) continue;
      const lv = V.liveness(e, reg);
      if (lv.state === "unknown") { out.push(`unknown ${e.name}: liveness unknown (${lv.why}) - no action`); continue; }
      if (lv.state === "gone") { if (e.session_id) delete nextLooping[e.session_id]; continue; }
      const obs = observe(e, { prevRun, looping: loopingAll[e.session_id], now });
      const det = L.detect({ ...obs, paused: pausedLine(reg.lines, e), pauseActive: pauseActive(now), liveState: lv.state }, cfg);
      if (e.session_id) { if (Object.keys(det.subFlags).length) nextLooping[e.session_id] = det.subFlags; else delete nextLooping[e.session_id]; }
      if (det.exempt) continue; // never flagged, and no ladder moves while it waits
      out.push(...(L.recoveryMode(reg.lines, e) === "report" ? reportOnly(e, det, obs, { dryRun, cfg, now, alerts, reg }) : runLadder(e, det, obs, { dryRun, cfg, now, reg })));
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - skipped this tick`); }
  }
  if (!dryRun) out.push(...writeState(C("looping.json"), nextLooping, "looping.json")); // alerts/index.json: with each alert
  return out;
}

// ---------- housekeeping: the prune and the orphan scan, each at most once an hour ----------
// Their stamps live in housekeeping.json, not tick.json: every trigger (other sessions' hooks) rewrites tick.json, and a
// read-modify-write race there would lose a stamp.
const HOUR = 60 * L.MIN, KEEP_MS = 14 * 24 * HOUR;
// The plain files in dir (deep: below it too); a missing dir has none.
function filesIn(dir, deep = false) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.flatMap((d) => { const p = path.join(dir, d.name); return d.isDirectory() ? (deep ? filesIn(p, true) : []) : d.isFile() ? [p] : []; });
}
const ageMs = (f, now) => { try { return now - fs.statSync(f).mtimeMs; } catch { return -Infinity; } };
// What goes (mtime older than 14 days unless said): restart logs; sent alerts only (an unclaimed or claimed alert never
// dies silently); a session's hook state once its newest launch line is closed or gone (never unknown, never one with
// no launch line to judge it by); writeAtomic's own temp files (V.ATOMIC_TMP, never another tool's .tmp: in production
// the registry dir is the skill folder) older than 1 h below the coordinator dir and in the registry and stop dirs;
// looping.json entries of closed sessions; alerts/index.json entries older than alert_repeat_hours (alertDue: they can
// no longer suppress an alert). Incidents never: the restart cap bounds them and launch.mjs resume reads the last one.
// -> {files: {kind: [path]}, loops: [sid], loopsAll, alertKeys: [key], alertsAll}
function prunable(now, cfg) {
  const tmp = [...filesIn(V.COORD, true), ...filesIn(V.REG_DIR), ...filesIn(V.STOP_DIR)].filter((f) => V.ATOMIC_TMP.test(f) && ageMs(f, now) > HOUR);
  const isTmp = new Set(tmp), old = (f) => !isTmp.has(f) && ageMs(f, now) > KEEP_MS;
  const reg = V.readRegistry(), newest = new Map();
  for (const e of reg.entries) if (e.session_id) newest.set(e.session_id, e);
  const states = filesIn(C("sessions")).filter((f) => f.endsWith(".json") && old(f)).map((f) => ({ f, e: newest.get(path.basename(f, ".json")) })).filter((s) => s.e);
  V.primeLiveness(states.map((s) => s.e).filter((e) => !reg.closed.has(e.id))); // one window probe for all of them
  const loopsAll = V.readJson(C("looping.json"), {}) || {}, alertsAll = V.readJson(C("alerts", "index.json"), {}) || {};
  return {
    files: {
      "restart logs": filesIn(C("restarts")).filter(old),
      "sent alerts": filesIn(C("alerts")).filter((f) => path.basename(f).startsWith("sent-") && old(f)),
      "session states": states.filter((s) => reg.closed.has(s.e.id) || V.liveness(s.e, reg).state === "gone").map((s) => s.f),
      "tmp files": tmp,
    },
    loops: Object.keys(loopsAll).filter((sid) => newest.has(sid) && reg.closed.has(newest.get(sid).id)),
    loopsAll,
    alertKeys: Object.keys(alertsAll).filter((k) => L.alertDue(alertsAll, k, now, cfg)),
    alertsAll,
  };
}
const entryWord = (n) => `entr${n === 1 ? "y" : "ies"}`;
// One summary line when anything went; --dry-run removes nothing and lists what would go.
function prune({ dryRun, cfg, now }) {
  const p = prunable(now, cfg);
  if (dryRun) return [...Object.values(p.files).flat().map((f) => `would prune ${fwd(f)}`), ...p.loops.map((sid) => `would prune looping.json entry ${sid} (its session is closed)`),
    ...p.alertKeys.map((k) => `would prune alerts/index.json entry ${k} (older than alert_repeat_hours)`)];
  const out = [], counts = {};
  let failed = 0;
  for (const [kind, files] of Object.entries(p.files)) counts[kind] = files.filter((f) => { try { fs.rmSync(f, { force: true }); return true; } catch { failed++; return false; } }).length;
  // Each state file is rewritten without its dropped keys; a failed write is one error line and drops nothing.
  const drop = (keys, all, file, label) => {
    if (!keys.length) return 0;
    const next = { ...all }; for (const k of keys) delete next[k];
    const err = writeState(file, next, label);
    out.push(...err);
    return err.length ? 0 : keys.length;
  };
  const dropped = drop(p.loops, p.loopsAll, C("looping.json"), "looping.json"), droppedAlerts = drop(p.alertKeys, p.alertsAll, C("alerts", "index.json"), "alerts/index.json");
  const removed = Object.values(counts).reduce((s, n) => s + n, 0);
  if (removed || dropped || droppedAlerts || failed) out.unshift(`prune: removed ${removed} file(s) (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}), `
    + `dropped ${dropped} looping.json ${entryWord(dropped)} and ${droppedAlerts} alerts/index.json ${entryWord(droppedAlerts)}${failed ? `, ${failed} file(s) could not be removed` : ""}`);
  return out;
}
// Report-only, never a kill: they may belong to anything, hand-opened sessions included. An unknown probe (failed,
// empty, not Windows) reports nothing and leaves the last orphans.json. One alert per set of orphans (orphans|<sorted
// pids>) when they hold > 1 GB, again after alert_repeat_hours.
function orphanScan({ dryRun, cfg, now }) {
  const procs = V.processList();
  if (!procs) return [];
  const list = L.orphans(procs), total = list.reduce((s, o) => s + o.mb, 0), out = list.map(L.orphanLine);
  if (dryRun) return total > 1024 ? [...out, `would alert: orphaned processes hold ${total} MB`] : out;
  out.push(...writeState(C("orphans.json"), { at: V.now(), orphans: list }, "orphans.json")); // the coordinator's own report
  if (total > 1024) {
    const alerts = V.readJson(C("alerts", "index.json"), {}) || {}, k = `orphans|${list.map((o) => o.pid).sort((a, b) => a - b).join(",")}`;
    if (L.alertDue(alerts, k, now, cfg)) {
      const f = raiseAlert({ name: "orphans", text: L.ALERT.orphans(list, total), incident: null });
      alerts[k] = V.now();
      out.push(`orphaned processes hold ${total} MB - alert ${fwd(f)}`, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json"));
    }
  }
  return out;
}
function housekeeping({ dryRun, cfg, now }) {
  const f = C("housekeeping.json"), hk = V.readJson(f, {}) || {};
  const due = (k) => { const t = Date.parse(hk[k]); return !(t <= now && t > now - HOUR); }; // a future stamp is stale
  const jobs = [["prune_at", "prune", () => prune({ dryRun, cfg, now })], ["orphans_at", "orphan scan", () => orphanScan({ dryRun, cfg, now })]].filter(([k]) => due(k));
  const out = [];
  if (!jobs.length) return out;
  // Claimed before the work, as triggerTick claims a tick: a job that fails is tried again next hour, not every tick.
  if (!dryRun) out.push(...writeState(f, { ...hk, ...Object.fromEntries(jobs.map(([k]) => [k, V.now()])) }, "housekeeping.json"));
  for (const [, label, run] of jobs) { try { out.push(...run()); } catch (err) { out.push(`error: ${label} failed (${err?.message || err})`); } }
  return out;
}

// ---------- guarded closes: superseded N-1, paused and incident windows ----------
// The guarded close (the hand-run guardclose script's logic): the host is still the recorded powershell with a start
// time within 2 s, and the transcript turn is done (re-read now); then kill_intent (kind close) -> taskkill /T /F ->
// {closed}, a process gone afterwards counting as closed (killTree, which probes once more). -> its one line
export function guardedClose(e, why, { dryRun }) {
  const w = V.readPidFile(e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
  if (!w.host_pid || !w.host_start) return `skip close of ${tag}: no recorded host pid and start time`;
  // checkHost is the same check once the pid file recorded the start time (required above): the name powershell and the
  // start within 2 s, a failed probe or an unreadable start unknown. Probed directly, never from the liveness memo.
  const h = V.checkHost(w, V.procInfo([w.host_pid]));
  if (h.state === "unknown") return `skip close of ${tag}: liveness unknown (${h.why})`;
  if (h.state !== "running") return `skip close of ${tag}: host pid ${w.host_pid} is not the recorded window (${h.why})`;
  const s = V.sessionState(e);
  if (s.found && (!s.idle || !s.bgKnown)) return `skip close of ${tag}: its turn is not done (${s.busy.join(", ") || "pending background agents unknown"})`;
  if (dryRun) return `would close ${tag}: ${why}`;
  const k = V.killTree(e, why, "close");
  return `${k.closed ? "closed" : "not closed"} ${tag}: ${why}${k.line === "closed" ? "" : ` - ${k.line}`}`;
}
// Why window e may be closed, from the registry alone (liveness is judged after): -> {newest, n1, paused, incident} or
// null. newest: the lane's (repo + branch) newest open launch. Report-only groups get only the superseded N-1 close
// (approved for all groups: N-1 handed its stage to N, so its state is saved by construction); paused windows and
// windows with an incident and a newer launch close in auto mode only.
function closeCase(reg, e) {
  if (e.mode !== "window" || reg.closed.has(e.id)) return null;
  const newest = reg.entries.filter((x) => x.repo === e.repo && x.branch === e.branch && !reg.closed.has(x.id))
    .reduce((a, b) => ((b.generation || 0) > (a.generation || 0) ? b : a), e);
  const later = newest.id !== e.id, n1 = later && (e.generation || 0) === (newest.generation || 0) - 1;
  const auto = L.recoveryMode(reg.lines, e) === "auto";
  const paused = auto && pausedLine(reg.lines, e), incident = auto && later && reg.lines.some((o) => o.incident === e.id);
  return n1 || paused || incident ? { newest, n1, paused, incident } : null;
}
export function supersededScan({ dryRun, cfg, now, repoKey }) {
  const out = [], first = V.readRegistry();
  const cands = first.entries.filter((e) => !repoKey || e.repo === repoKey).map((e) => [e, closeCase(first, e)]).filter(([, k]) => k);
  if (!cands.length) return out; // no probe at all in the common case
  // Probed now, not from the scan's memo: a 3-min restart earlier in this tick can leave it minutes old, and a successor
  // judged running then may be gone now. One window probe for the candidates and their lanes' newest launches.
  for (const [e, k] of cands) { V.forgetLiveness(e.id); V.forgetLiveness(k.newest.id); }
  V.primeLiveness(cands.flatMap(([e, k]) => [e, k.newest]));
  for (const [c] of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === c.id), k = e && closeCase(reg, e); // fresh, as in scan
      if (!k) continue;
      const tag = `${e.name} (gen ${e.generation ?? "?"})`;
      const succ = k.newest.id !== e.id && V.liveness(k.newest, reg).state === "running";
      const isN1 = k.n1 && succ;
      if (!isN1 && !k.paused && !(k.incident && succ)) continue;
      // A pending loop ladder owns its session: it kills, cancels or ends it (resumePending runs first in the tick). A close
      // here with no running successor would let the next tick restart the closed session (afterKill); with one, the
      // ladder ends as superseded.
      if (!succ && L.pendingLadders(reg.lines).some((p) => p.id === e.id)) { out.push(`skip close of ${tag}: its loop ladder is pending - the ladder ends first`); continue; }
      const lv = V.liveness(e, reg);
      if (lv.state !== "running") { if (lv.state === "unknown") out.push(`skip close of ${tag}: liveness unknown (${lv.why})`); continue; }
      const st = V.sessionState(e), hook = (plainId(e.session_id) && V.readJson(C("sessions", `${e.session_id}.json`), {})) || {};
      // hasClaudeBelow answers whether claude runs in the window; closeDecision's noClaude is the opposite (null: unknown).
      const below = st.found ? null : V.hasClaudeBelow(V.readPidFile(e).host_pid), noClaude = below === null ? null : !below;
      const reason = isN1 ? `superseded by generation ${k.newest.generation}` : k.paused ? "paused" : "incident, successor running";
      const d = L.closeDecision({ state: st, waitingSince: hook.waiting_since || null, noClaude, now, cfg, reason });
      if (d.close) out.push(guardedClose(e, d.why, { dryRun })); // a kept window prints nothing: every tick would repeat it
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
  }
  return out;
}

// ---------- one tick ----------
// -> the lines it printed (also in last-tick.txt). A failure is one more line, never a throw past the lock release.
const writeLastTick = (out) => { try { V.writeAtomic(C("last-tick.txt"), `${V.now()}\n${out.join("\n")}\n`); } catch {} };
export function tick({ dryRun = false, repoKey = null } = {}) {
  const out = [];
  if (!dryRun && !acquireTickLock(out)) {
    // A plain skip leaves last-tick.txt to the holder; a hung holder this tick killed (another tick then took the lock
    // first) is recorded, since a detached tick has no console.
    const skipped = [...out, "tick: another tick holds tick.lock - skipped"];
    if (out.length) writeLastTick(skipped);
    return skipped;
  }
  try {
    const { config: cfg, errors } = loadCfg();
    for (const e of errors) out.push(`config: ${e} (the default is used)`);
    const tj = V.readJson(C("tick.json"), {}) || {}, prevRun = Date.parse(tj.last_run) || 0, now = Date.now();
    if (!dryRun) V.writeAtomic(C("tick.json"), JSON.stringify({ ...tj, at: V.now(), last_run: V.now() }));
    out.push(...resumePending({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
    // Machine-wide, so only in an unrestricted tick ({starting} lines carry no repo; files and processes are global).
    if (!repoKey) out.push(...V.untracked().map(L.untrackedLine), ...housekeeping({ dryRun, cfg, now: Date.now() })); // now: a restart may have taken minutes
  } catch (err) { out.push(`tick failed: ${err?.stack || err}`); }
  finally { if (!dryRun) releaseTickLock(); }
  if (!out.length) out.push("tick: nothing to do");
  if (!dryRun) writeLastTick(out);
  return out;
}
