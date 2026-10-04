// The stage-2 coordinator tick: scan the launcher registry, flag loops, run the ladder (stop request -> grace ->
// incident -> kill -> restart or block), raise alerts. Every decision comes from recover-lib.mjs; this file reads state
// and acts. It writes only: the target's registry lines, stop file and incident; looping.json; alerts/; and its own
// tick.json, tick.lock, last-tick.txt and restart logs. Never a done marker, merge.lock, another lane's files or another
// worktree. Liveness `unknown` is never acted on: no stop, kill, close, restart or block is decided from it.
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

// ---------- tick.lock: exclusive create; a dead or > 10 min old holder is reclaimed ----------
export function acquireTickLock() {
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
    const st = held?.start ? V.procStart(held.pid) : null, reused = st != null && st - Date.parse(held.start) > 10000;
    if (held && V.pidAlive(held.pid) && !reused && V.ago(held.at) < 10 * L.MIN) return false;
    // Move aside only the lock judged dead here; if another tick replaced it meanwhile, put that one back.
    const aside = `${f}.reclaimed-${process.pid}`;
    try { fs.renameSync(f, aside); } catch { continue; }
    if (JSON.stringify(V.readJson(aside, null)) === JSON.stringify(held)) fs.rmSync(aside, { force: true });
    else { try { fs.renameSync(aside, f); } catch {} return false; }
  }
  return false;
}
// Never throws (it runs in tick's finally): a lock it cannot remove names this process, which is dead once the tick
// exits, so the next tick reclaims it.
export const releaseTickLock = () => { const f = C("tick.lock"); try { if (V.readJson(f, {})?.pid === process.pid) fs.rmSync(f, { force: true }); } catch {} };
// A long tick (each restart may take 3 min) keeps its lock fresh, so it is never reclaimed as > 10 min old while it runs.
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

// ---------- incident, kill, restart, block ----------
function writeIncident(e, flag, obs, n, file, mode) {
  const subsAll = V.subagentFiles(e.session_id).map((s) => ({ ...s, entries: V.tail(s.file) }));
  const others = subsAll.filter((s) => s.meta?.requestShape === "background" && s.agentId !== flag.scope && !L.agentDone(s.entries))
    .map((s) => ({ id: s.agentId, type: s.meta?.agentType, description: s.meta?.description }));
  const calls = flag.rule === "d" ? obs.subs.find((s) => s.id === flag.scope)?.calls || [] : obs.calls;
  V.writeAtomic(file, L.incidentText({ lane: e.name, n, at: V.now(), name: e.name, id: e.id, sessionId: e.session_id, generation: e.generation,
    rule: flag.rule, signature: flag.signature, text: flag.text, tokens: obs.tokens, branch: e.branch, worktree: e.worktree, handoff: e.handoff,
    mode, calls: calls.map((c) => c.key), main: obs.file && fwd(obs.file), subs: subsAll.map((s) => ({ id: s.agentId, type: s.meta?.agentType, file: fwd(s.file) })), others }));
}
function incidentAndKill(e, flag, obs, { dryRun, cfg }) {
  const n = 1 + V.readRegistry().lines.filter((o) => o.incident && o.name === e.name).length, file = incidentPath(e, n);
  if (dryRun) return [`would write ${fwd(file)} and kill ${e.name}: ${flag.text}`];
  writeIncident(e, flag, obs, n, file, "auto");
  V.append({ incident: e.id, name: e.name, n, path: fwd(file), signature: flag.signature, rule: flag.rule, tokens: obs.tokens, mode: "auto", at: V.now() });
  return [`incident ${fwd(file)} for ${e.name} (${flag.text})`, ...killAndContinue(e, cfg)];
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
function afterKill(e, cfg) {
  const reg = V.readRegistry();
  // Only the newest generation of a lane is restarted: two sessions never share a worktree, and an old handoff never
  // restarts over a lane that moved on to a later stage. Any newer launch without a {closed} line supersedes this one.
  const newer = reg.entries.filter((x) => x.id !== e.id && x.repo === e.repo && x.branch === e.branch && (x.generation || 0) > (e.generation || 0) && !reg.closed.has(x.id));
  if (newer.length) {
    const n = newer.at(-1), lvs = newer.map((x) => ({ x, lv: V.liveness(x, reg) }));
    const run = lvs.find((s) => s.lv.state === "running");
    if (run) {
      V.append({ restart_skipped: e.id, name: e.name, why: `superseded by ${run.x.id}`, at: V.now() });
      return [`${e.name} killed, not restarted: superseded by ${run.x.id}`];
    }
    // Unknown (a failed probe, a window still starting) is never a decision: no skip that ends the ladder, no block.
    const unk = lvs.find((s) => s.lv.state === "unknown");
    if (unk) return [`restart of ${e.name} deferred: its newer launch ${unk.x.id} has liveness unknown (${unk.lv.why}) - the next tick retries`];
    // The newer launch is gone without a close: blocked + alert; launch.mjs resume relaunches from the newest line.
    const inc0 = [...reg.lines].reverse().find((o) => o.incident === e.id && o.mode === "auto");
    V.append({ lane_blocked: e.name, group: e.group || null, handoff: n.handoff, incident: inc0?.path ?? null, at: V.now() });
    const text = `${e.name} was killed for a loop, but its newer launch ${n.id} is gone without a close: not restarted from the old handoff. `
      + (e.group ? `Check it, then: node ${fwd(LAUNCH)} resume --group ${e.group} --lane ${e.name}` : `Check it, then relaunch from ${n.handoff} with launch.mjs.`);
    return [`${e.name} killed, not restarted: superseded by ${n.id}, which is gone - blocked, alert ${fwd(raiseAlert({ name: e.name, text, incident: inc0?.path ?? null }))}`];
  }
  const inc = [...reg.lines].reverse().find((o) => o.incident === e.id && o.mode === "auto");
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
function resumeOne(p, e, reg, { dryRun, cfg, prevRun, now }) {
  const inc = p.incident;
  // A session switched to report mode after its incident gets no kill and no restart; auto mode would resume it.
  if (L.recoveryMode(reg.lines, e) === "report") return [`pending ${e.name}: the recovery mode is report - no kill or restart (incident ${inc.path})`];
  if (p.closed || reg.closed.has(e.id)) return dryRun ? [`would restart or block ${e.name} (killed, no restart recorded)`] : afterKill(e, cfg);
  V.forgetLiveness(e.id);
  const lv = V.liveness(e, reg);
  if (lv.state === "unknown") return [`pending ${e.name}: liveness unknown (${lv.why}) - no action`];
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
    try { out.push(...resumeOne(p, e, reg, { dryRun, cfg, prevRun, now })); }
    catch (err) { out.push(`error ${e.name}: ${err?.message || err} - the next tick retries`); }
  }
  return out;
}

// ---------- scan ----------
function reportOnly(e, flags, obs, { dryRun, cfg, now, alerts, reg }) {
  const out = [];
  for (const f of flags) {
    const k = `${e.id}|${f.signature}`, had = reg.lines.find((o) => o.incident === e.id && o.signature === f.signature);
    if (had && !L.alertDue(alerts, k, now, cfg)) continue;
    if (dryRun) { out.push(`report-only ${e.name}: ${f.text} - would ${had ? "alert again" : "write an incident and alert"}`); continue; }
    let file = had?.path;
    if (!had) {
      const n = 1 + reg.lines.filter((o) => o.incident && o.name === e.name).length;
      file = fwd(incidentPath(e, n));
      writeIncident(e, f, obs, n, file, "report");
      V.append({ incident: e.id, name: e.name, n, path: file, signature: f.signature, rule: f.rule, tokens: obs.tokens, mode: "report", at: V.now() });
    }
    raiseAlert({ name: e.name, text: L.ALERT.report({ name: e.name, group: e.group, text: f.text, incident: file, launchMjs: fwd(LAUNCH) }), incident: file });
    alerts[k] = V.now();
    out.push(`report-only ${e.name}: ${f.text} - incident ${file}, alerted`);
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
    else if (a.do === "kill") out.push(...incidentAndKill(e, f, obs, { dryRun, cfg }));
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
      out.push(...(L.recoveryMode(reg.lines, e) === "report" ? reportOnly(e, det.flags, obs, { dryRun, cfg, now, alerts, reg }) : runLadder(e, det, obs, { dryRun, cfg, now, reg })));
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - skipped this tick`); }
  }
  if (!dryRun) { V.writeAtomic(C("looping.json"), JSON.stringify(nextLooping, null, 2)); V.writeAtomic(C("alerts", "index.json"), JSON.stringify(alerts, null, 2)); }
  return out;
}

// ---------- one tick ----------
// -> the lines it printed (also in last-tick.txt). A failure is one more line, never a throw past the lock release.
export function tick({ dryRun = false, repoKey = null } = {}) {
  const out = [];
  if (!dryRun && !acquireTickLock()) return ["tick: another tick holds tick.lock - skipped"];
  try {
    const { config: cfg, errors } = loadCfg();
    for (const e of errors) out.push(`config: ${e} (the default is used)`);
    const tj = V.readJson(C("tick.json"), {}) || {}, prevRun = Date.parse(tj.last_run) || 0, now = Date.now();
    if (!dryRun) V.writeAtomic(C("tick.json"), JSON.stringify({ ...tj, at: V.now(), last_run: V.now() }));
    out.push(...resumePending({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey }));
  } catch (err) { out.push(`tick failed: ${err?.stack || err}`); }
  finally { if (!dryRun) releaseTickLock(); }
  if (!out.length) out.push("tick: nothing to do");
  if (!dryRun) { try { V.writeAtomic(C("last-tick.txt"), `${V.now()}\n${out.join("\n")}\n`); } catch {} }
  return out;
}
