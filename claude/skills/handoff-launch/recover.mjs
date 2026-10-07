// The stage-2 coordinator tick: scan the launcher registry, flag loops, run the ladder (stop request -> grace ->
// incident -> kill -> restart or block), close idle superseded (a successor runs: batch A's chain relation, all groups)
// and paused windows (auto mode) through the guarded close, close windows whose claude is gone (batch A, Part 3), write
// lanes.json, raise alerts, and once an hour reap Playwright orphans. Every decision comes from recover-lib.mjs; this file reads state
// and acts. It writes only: the target's registry lines, stop file and incident; looping.json; lanes.json; alerts/; and
// its own tick.json, tick.lock, last-tick.txt, restart logs, housekeeping.json and orphans.json. Once an hour it prunes its
// own old files (prune below) and removes stale Playwright profile dirs from the temp dir (reapPlaywright). Never a done
// marker, merge.lock, another lane's files or another worktree. Liveness `unknown` is never acted on: no stop, kill,
// close, restart or block is decided from it. Sessions a dead launcher left untracked and orphaned processes are only
// reported - except Playwright's own orphans (its signature, never ancestor names), which the reaper kills.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as L from "./recover-lib.mjs";
import * as V from "./live.mjs";
import * as G from "./lane-lib.mjs";
import { fwd, stem, isMergeSession } from "./merge-lib.mjs";
import * as P from "./pace-lib.mjs";
import * as IO from "./pace-io.mjs";
import * as Q from "./pause-lib.mjs";
import * as PI from "./pause-io.mjs";

// HL_LAUNCH_MJS: tests stand a fake launcher in for launch.mjs.
const LAUNCH = process.env.HL_LAUNCH_MJS || path.join(V.HERE, "launch.mjs");
const C = (...p) => path.join(V.COORD, ...p);
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const plainId = (v) => typeof v === "string" && /^[\w-]+$/.test(v);
export const loadCfg = () => { let t = null; try { t = fs.readFileSync(C("config.json"), "utf8"); } catch {} return L.loadConfig(t); };
// Any pause source active (batch B, Part 4: manual, battery, pace, or the old pause.json): every session is exempt from
// loop flags and every restart waits, as with the stage-2 pause file.
export const pauseActive = (now = Date.now()) => PI.pauseActive(now);
// The loop exemption: the one caller that also counts a legacy (hand-written, name-matched) {paused} line, and only while
// the lane did not work after it (resumed by hand: loop-checked again).
const pausedLine = (lines, e) => { const line = Q.pausedLineOf(lines, e, { legacy: true }); return !!line && !V.workedAfterPause(e, line); };
// Does a pause apply to THIS session now (its priority against the active sources: a pace hold spares high lanes)? The
// loop exemption and the restart deferral use it, never the any-source pauseActive.
export const pausedFor = (reg, e, now = Date.now()) => Q.pauseFor(G.effectivePriority(reg.lines, e), PI.readSources(now)).paused;
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
    // The holder is still the process that took the lock only while its pid runs node and the OS start time is not more
    // than 1 s after the recorded one (selfStart is the OS start time within well under a second). The probe answering
    // DEAD, another image, or a start more than 1 s after the recorded one: the pid was reused, the holder is dead
    // (batch B carried fix: the old 10 s tolerance let a pid reused within seconds - a full test-suite run - read as a
    // live tick). A failed probe or an unreadable start is no answer: the lock stays held, never reclaimed on a guess.
    const p = held?.start && process.platform === "win32" ? V.procInfo([held.pid])?.get(held.pid) : null; // procStart, plus the name
    const st = p?.start ? Date.parse(p.start) : null;
    const reused = !!p && (p.name === "DEAD" || !/^node$/i.test(p.name) || (st != null && st - Date.parse(held.start) > 1000));
    const alive = !!held && V.pidAlive(held.pid);
    if (alive && !reused && V.ago(held.at) < 10 * L.MIN) return false;
    // Older than 10 min (touchTickLock keeps a working tick's lock fresh) and still the process that took it - a node
    // process whose start time was read and is not more than 1 s after the lock's (the rule above; the kill below also
    // requires it within 2 s either way): a hung tick (~50-80 MB), killed before the reclaim. Every condition is named
    // here: a lock whose age does not parse, an unknown (failed probe) or a different start time only reclaims - never
    // a kill on a guess.
    const hung = alive && !reused && V.ago(held.at) >= 10 * L.MIN && st != null && Math.abs(st - Date.parse(held.start)) <= 2000 && held.pid !== process.pid;
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
export function touchTickLock() {
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

// ---------- alerts: alerts/<stamp>-<name>.json, a desktop notification, and the phone relay (coord.mjs, goal-gate) ----------
// The relay renames a queued alert to claimed-<sid>-<ms>-<orig>, then to sent-<orig> (the hourly prune deletes only
// sent-* files) or back to <orig>.
// Desktop notification, best effort; the result is logged in the alert file. Windows: a NotifyIcon balloon from built-in
// PowerShell 5.1 (the WinRT toast API needs a registered AppUserModelID and fails silently without one). macOS:
// osascript. Linux: notify-send, if present. Every branch is detached + unref'd and ends by itself (the PowerShell one
// disposes its icon after the balloon), so a notification never holds this process or outlives its 16 s.
export function desktopNotify(title, text) {
  if (process.env.HL_NO_SPAWN === "1") return "skipped (HL_NO_SPAWN)";
  const opts = { detached: true, stdio: "ignore", windowsHide: true };
  try {
    let p;
    if (process.platform === "win32") {
      const ps = ["Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing",
        "$n = New-Object System.Windows.Forms.NotifyIcon", "$n.Icon = [System.Drawing.SystemIcons]::Warning",
        `$n.BalloonTipTitle = ${V.psq(title)}`, `$n.BalloonTipText = ${V.psq(String(text).slice(0, 250))}`, // the balloon's limit: 255
        "$n.Visible = $true", "$n.ShowBalloonTip(15000)", "Start-Sleep -Seconds 16", "$n.Dispose()"].join("; ");
      p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], opts);
    } else if (process.platform === "darwin") p = spawn("osascript", ["-e", `display notification ${JSON.stringify(String(text))} with title ${JSON.stringify(title)}`], opts);
    else p = spawn("notify-send", [title, String(text)], opts);
    p.on("error", () => {}); // a missing notify-send: the file says "spawned"; the phone relay still carries the alert
    p.unref();
    return "spawned";
  } catch (e) { return `failed: ${e.message}`; }
}
export function raiseAlert({ name, text, incident }) {
  const base = `${V.now().replace(/[:.]/g, "-")}-${stem(name)}`;
  let f = C("alerts", `${base}.json`);
  for (let i = 2; fs.existsSync(f); i++) f = C("alerts", `${base}-${i}.json`); // two alerts in one millisecond: both kept
  V.writeAtomic(f, JSON.stringify({ text, incident, created: V.now(), desktop: desktopNotify("Claude coordinator", text) }, null, 2));
  return f;
}
// A claimed alert (V.CLAIMED) not marked sent within 15 min goes back to the queue, so an alert never dies silently. A
// rename keeps the file as it is, released_by included. dryRun: the lines only. -> one line per released alert
export function releaseStaleClaims(now = Date.now(), { dryRun = false } = {}) {
  const dir = C("alerts"), out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    const m = V.CLAIMED.exec(f);
    if (!m || now - Number(m[2]) < 15 * L.MIN) continue;
    if (dryRun) { out.push(`would release the unsent alert ${m[3]}`); continue; }
    try { fs.renameSync(path.join(dir, f), path.join(dir, m[3])); out.push(`released the unsent alert ${m[3]}`); } catch {} // sent or released meanwhile
  }
  return out;
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
  V.append({ incident: e.id, name: e.name, group: e.group ?? null, n, path: file, signature: flag.signature, rule: flag.rule, tokens: obs.tokens, mode, at: V.now() });
  return file;
}
// Lane e's incident number n (names are unique per group): an {incident} line with a group key counts only in e's group;
// one written before batch A carries none and still matches, as restartOf reads {restart} lines. -> the newest, or undefined
const incidentOf = (lines, e, n) => [...lines].reverse().find((o) => o.incident && o.name === e.name && o.n === n && (!Object.hasOwn(o, "group") || (o.group ?? null) === (e.group ?? null)));
function incidentAndKill(e, flag, obs, { dryRun, cfg, subFlags, ts, now }) {
  if (dryRun) return [`would write ${nextIncident(e).file} and kill ${e.name}: ${flag.text}`];
  const file = recordIncident(e, flag, obs, "auto", subFlags);
  return [`incident ${file} for ${e.name} (${flag.text})`, ...killAndContinue(e, cfg, ts, now)];
}
function killAndContinue(e, cfg, ts, now) {
  const k = V.killTree(e, "loop ladder: still looping after the grace period", "ladder");
  if (!k.closed) return [`kill of ${e.name}: ${k.line} - the next tick retries`];
  return [`killed ${e.name}: ${k.line}`, ...afterKill(e, cfg, ts, now)];
}
// The restart runs to its end (3 min at most): the launcher records the new session, starts its window or background
// session detached, and exits. Its output goes to CFG/state/coord/restarts/<name>-<stamp>.log; when that log cannot be
// written, `log` says so ("not written (<code>)") instead of naming a missing file. cap: the session cap's reason when
// the launcher refused the restart for it (exit 3 + the CAP_REFUSED line), else null. timedOut: ETIMEDOUT only.
// HL_LAUNCH_TIMEOUT_MS shortens the wait in tests; unset or invalid keeps 3 min. -> {ok, why, log, logFile, started, cap, timedOut}
function spawnLaunch(name, argv) {
  const log = C("restarts", `${stem(name)}-${V.now().replace(/[:.]/g, "-")}.log`), started = V.now();
  touchTickLock();
  // The scrubbed env: the restart must not look launched by the session whose hook started this tick (batch A, Part 1).
  const ms = Number(process.env.HL_LAUNCH_TIMEOUT_MS), timeout = Number.isSafeInteger(ms) && ms > 0 ? ms : 3 * L.MIN;
  const r = spawnSync(process.execPath, [LAUNCH, ...argv], { encoding: "utf8", timeout, windowsHide: true, env: V.launcherEnv() });
  let logRef = fwd(log), logFile = log;
  try { V.writeAtomic(log, `node launch.mjs ${argv.join(" ")}\nexit ${r.status ?? r.error?.code ?? r.signal}\n${r.stdout || ""}${r.stderr || ""}`); }
  catch (err) { logRef = `not written (${err?.code || err?.message || err})`; logFile = null; }
  const last = `${r.stderr || ""}${r.stdout || ""}`.trim().split(/\r?\n/).at(-1) || "";
  const duration = timeout % L.MIN === 0 ? `${timeout / L.MIN} min` : `${timeout} ms`;
  const why = r.status === 0 ? null : r.error?.code === "ETIMEDOUT" ? `the launcher did not finish in ${duration}` : `the launcher exited ${r.status ?? r.signal ?? r.error?.code}: ${last}`;
  return { ok: r.status === 0, why, log: logRef, logFile, started, timedOut: r.error?.code === "ETIMEDOUT", cap: L.capRefusal(r.status, `${r.stderr || ""}\n${r.stdout || ""}`) };
}
const launchRegistered = (e, r) => V.readRegistry().entries.some((x) => x.name === e.name && (x.group ?? null) === (e.group ?? null) && x.launched_at >= r.started);
// Only the real tick calls this: no failure count, {restart_failed} or {lane_blocked} for an unregistered timeout.
// One alert per timeout (not repeated while waiting); an expired hold permits a new timeout and a new alert on its key.
function deferTimeout(e, r, ts, now, incident = null) {
  // `at` is the real time the timeout was seen; every hold decision still uses the tick's `now`.
  const t = ts.timedOut[e.id] = { at: Date.now(), name: e.name, group: e.group ?? null }, k = `timeout|${e.id}`;
  const alerts = V.readJson(C("alerts", "index.json"), {}) || {};
  const text = `${L.launchTimeoutLine(t)} (${r.why}). Check for an open window before launching it by hand. Log: ${r.log}.`;
  const f = raiseAlert({ name: e.name, text, incident });
  alerts[k] = new Date(t.at).toISOString();
  return [`${L.launchTimeoutLine(t)} - alert ${fwd(f)}`, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json")];
}
// A restart the session cap refused (too many sessions or too little free RAM) waits: nothing terminal is written (no
// {restart_failed}, no {lane_blocked}), so the ladder stays pending and the next tick tries again; the tick never passes
// --force. One alert the first time (alerts/index.json key cap|<registry id>, again after alert_repeat_hours); a retry
// that does not alert removes its restart log, so a long wait leaves one log per alert, not one per tick.
function deferCap(e, inc, r, cfg) {
  const line = `restart of ${e.name} deferred: session cap (${r.cap})`;
  const alerts = V.readJson(C("alerts", "index.json"), {}) || {}, k = `cap|${e.id}`;
  if (!L.alertDue(alerts, k, Date.now(), cfg)) {
    if (r.logFile) { try { fs.rmSync(r.logFile, { force: true }); } catch {} }
    return [line];
  }
  const f = raiseAlert({ name: e.name, text: L.ALERT.capDeferred({ name: e.name, group: e.group, why: r.cap, log: r.log, incident: inc.path }), incident: inc.path });
  alerts[k] = V.now();
  return [`${line} - retried at every tick, alert ${fwd(f)}`, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json")];
}
// How e's session ended, for supersede's blocked-lane alert: its last kill_intent's kind (a line without one is read as a close, as everywhere).
function endedHow(lines, e) {
  const k = [...lines].reverse().find((o) => o.kill_intent === e.id);
  return !k ? "ended without a recorded kill" : k.kind === "ladder" ? "was killed for a loop" : `was closed${k.why ? ` (${k.why})` : ""}`;
}
// Gap 17, for every end of a killed lane's ladder (afterKill, and reportBlock under report mode): only the newest
// generation of a lane is restarted or blocked - two sessions never share a worktree, and an old handoff never restarts
// over a lane that moved on to a later stage. The restart guard is the union (batch A, Part 1): any open entry newer on
// the same repo + branch, or with e in its chain (a relay on a switched branch). -> null when there is none; else the
// lines of the decision: a successor running -> {restart_skipped}; only a co-tenant running (a --force'd launch on e's
// checkout) -> {restart_skipped} + an alert, the user decides; unknown -> nothing written, the next tick retries; gone
// without a close -> {lane_blocked} + an alert. done/defer: how the caller's lines begin.
function supersede(e, reg, inc, { done, defer }) {
  const newer = G.restartBlockers(e, reg.entries, reg.closed);
  if (!newer.length) return null;
  // Probed now, not from the memo: an earlier step of this tick (a 3-min restart) can leave it minutes old.
  for (const x of newer) V.forgetLiveness(x.id, { agents: V.usesAgents(x) }); // a bg one: its agents list too
  const n = newer.at(-1), lvs = newer.map((x) => ({ x, lv: V.liveness(x, reg) }));
  const runs = lvs.filter((s) => s.lv.state === "running");
  const run = runs.find((s) => G.isSuccessor(s.x, e, reg.entries));
  if (run) {
    V.append({ restart_skipped: e.id, name: e.name, why: `superseded by ${run.x.id}`, at: V.now() });
    return [`${done}: superseded by ${run.x.id}`];
  }
  if (runs.length) {
    const co = runs[0].x, why = `an open newer launch ${co.name} shares its checkout`;
    V.append({ restart_skipped: e.id, name: e.name, why, at: V.now() });
    const text = `${e.name} ${endedHow(reg.lines, e)} and was not restarted: ${why} (${co.id}), launched without replacing it. Decide which session keeps the checkout.`;
    return [`${done}: ${why} - alert ${fwd(raiseAlert({ name: e.name, text, incident: inc?.path ?? null }))}`];
  }
  // Unknown (a failed probe, a window still starting) is never a decision: no skip that ends the ladder, no block.
  const unk = lvs.find((s) => s.lv.state === "unknown");
  if (unk) return [`${defer}: its newer launch ${unk.x.id} has liveness unknown (${unk.lv.why}) - the next tick retries`];
  // The newer launch is gone without a close: blocked + alert; launch.mjs resume relaunches from the newest line.
  V.append({ lane_blocked: e.name, group: e.group || null, handoff: n.handoff, incident: inc?.path ?? null, at: V.now() });
  const text = `${e.name} ${endedHow(reg.lines, e)}, but its newer launch ${n.id} is gone without a close: not restarted from the old handoff. `
    + (e.group ? `Check it, then: node ${fwd(LAUNCH)} resume --group ${e.group} --lane ${e.name}` : `Check it, then relaunch from ${n.handoff} with launch.mjs.`);
  return [`${done}: superseded by ${n.id}, which is gone - blocked, alert ${fwd(raiseAlert({ name: e.name, text, incident: inc?.path ?? null }))}`];
}
function afterKill(e, cfg, ts, now) {
  const reg = V.readRegistry(), inc = [...reg.lines].reverse().find((o) => o.incident === e.id && o.mode === "auto");
  if (L.launchTimeoutPending(ts.timedOut[e.id], reg.lines, now, e.id)) return [L.launchTimeoutLine(ts.timedOut[e.id])];
  const sup = supersede(e, reg, inc, { done: `${e.name} killed, not restarted`, defer: `restart of ${e.name} deferred` });
  if (sup) return sup;
  if (!inc) return [`${e.name}: killed without an incident - not restarted`];
  const lastRestart = [...reg.lines].reverse().find((o) => o.restart === e.name && o.handoff === e.handoff);
  const prevInc = lastRestart && incidentOf(reg.lines, e, lastRestart.n);
  const plan = L.afterKillPlan({ lines: reg.lines, entry: e, incident: inc, cfg, doneMarkerExists: !!e.done_marker && fs.existsSync(e.done_marker),
    pauseActive: pausedFor(reg, e), prevCauseFilled: prevInc ? L.causeFilled(readText(prevInc.path)) : true });
  if (plan.do === "defer") return [`restart of ${e.name} deferred: ${plan.why}`];
  if (plan.do === "skip") { V.append({ restart_skipped: e.id, name: e.name, why: plan.why, at: V.now() }); return [`${e.name} killed, not restarted: ${plan.why}`]; }
  if (plan.do === "block") return block(e, inc, plan.restarts);
  // A restart is not a relay: it keeps the lane's effective priority (a hand-set one survives); a fresh one names the
  // killed entry as the one it replaces.
  const priority = G.effectivePriority(reg.lines, e);
  const argv = plan.kind === "resume" ? ["--resume", e.session_id, "--recovery", inc.path, "--model", plan.model, "--effort", plan.effort, "--priority", priority]
    : L.freshLaunchArgs(e, { model: plan.model, effort: plan.effort, recovery: inc.path, priority, supersedes: e.id });
  const r = spawnLaunch(e.name, argv);
  // The cap refuses before any side effect, so this launcher registered nothing: deferred, never blocked for RAM.
  if (r.cap) return deferCap(e, inc, r, cfg);
  if (!r.ok && launchRegistered(e, r)) {
    // The launcher registered the session before it failed or timed out (merge.mjs makes the same check): that session
    // owns the worktree now, so this is a restart, never a block. It may not be running (a bg session whose id was never
    // captured stays unknown), so the user is told.
    V.append({ restart: e.name, group: e.group ?? null, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, model: plan.model, effort: plan.effort, launcher_exit: r.why, at: V.now() });
    const text = `Restart of ${e.name} was registered but its launcher ${r.why.replace(/^the launcher /, "")} (log ${r.log}). `
      + `Check ${e.group ? `status --group ${e.group}` : "claude agents"}; if it is not running, stop/judge it and relaunch by hand.`;
    const f = raiseAlert({ name: e.name, text, incident: inc.path });
    return [`restarted ${e.name}: ${plan.kind} (${plan.model}/${plan.effort}) - the launcher then failed (${r.why}, log ${r.log}), but it registered the session - alert ${fwd(f)}`];
  }
  if (r.timedOut) return deferTimeout(e, r, ts, now, inc.path);
  if (!r.ok) { // never a silent loss: the lane is blocked (status shows it, launch.mjs resume relaunches it) and alerted
    V.append({ restart_failed: e.name, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, why: r.why, log: r.log, at: V.now() });
    V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc.path, at: V.now() });
    const f = raiseAlert({ name: e.name, text: L.ALERT.restartFailed({ name: e.name, group: e.group, why: r.why, log: r.log, incident: inc.path, launchMjs: fwd(LAUNCH), handoff: e.handoff }), incident: inc.path });
    return [`restart of ${e.name} failed: ${r.why} (log ${r.log}) - blocked, alert ${fwd(f)}`];
  }
  // group (plan amendment 7): names are unique per group, so restartOf matches a {restart} line only in its own group.
  V.append({ restart: e.name, group: e.group ?? null, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, model: plan.model, effort: plan.effort, at: V.now() });
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
  const det = L.detect({ ...obs, paused: pausedLine(reg.lines, e), pauseActive: pausedFor(reg, e, now), liveState: lv.state }, cfg);
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
function resumeOne(p, e, reg, { dryRun, cfg, prevRun, now, ts }) {
  if (L.launchTimeoutPending(ts.timedOut[e.id], reg.lines, now, e.id)) return []; // timeoutScan already printed why
  const inc = p.incident, report = L.recoveryMode(reg.lines, e) === "report", closed = p.closed || reg.closed.has(e.id);
  if (closed) return report ? reportBlock(e, inc, "closed", reg, dryRun) : dryRun ? [`would restart or block ${e.name} (killed, no restart recorded)`] : afterKill(e, cfg, ts, now);
  V.forgetLiveness(e.id, { agents: V.usesAgents(e) });
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
    return afterKill(e, cfg, ts, now);
  }
  const why = whyNotFiring(e, inc, { reg, cfg, prevRun, now, lv });
  if (why) return [dryRun ? `would cancel the ladder ${inc.signature} of ${e.name}: ${why} before the kill` : cancelBeforeKill(e, inc, why)];
  if (dryRun) return [`would kill ${e.name}, then restart or block it (${inc.path})`];
  return killAndContinue(e, cfg, ts, now); // running: (re)try the kill; gone with no kill_intent: recorded closed, then restarted
}
function resumePending({ dryRun, cfg, prevRun, now, repoKey, ts }) {
  const out = [], first = V.readRegistry();
  // High priority first (Part 7), so a cap slot freed this tick goes to the highest-priority lane; then registry order.
  const prio = (p) => { const e = first.entries.find((x) => x.id === p.id); return e ? G.effectivePriority(first.lines, e) : "normal"; };
  for (const p of G.byPriority(L.pendingLadders(first.lines), prio)) {
    const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === p.id);
    if (!e || (repoKey && e.repo !== repoKey)) continue;
    // One session's failure (a transcript read, a write) never stops the other sessions' ladders; the registry state
    // lets the next tick pick this one up where it stopped.
    touchTickLock(); // per session: the 10-min hung-tick threshold measures idleness, not this tick's total work
    try { out.push(...resumeOne(p, e, reg, { dryRun, cfg, prevRun, now, ts })); }
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
function runLadder(e, det, obs, { dryRun, cfg, now, reg, ts }) {
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
    else if (a.do === "kill") out.push(...incidentAndKill(e, f, obs, { dryRun, cfg, subFlags: det.subFlags, ts, now }));
  }
  return out;
}
function scan({ dryRun, cfg, prevRun, now, repoKey, ts }) {
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
      if (L.launchTimeoutPending(ts.timedOut[e.id], reg.lines, now, e.id)) continue;
      const lv = V.liveness(e, reg);
      if (lv.state === "unknown") { out.push(`unknown ${e.name}: liveness unknown (${lv.why}) - no action`); continue; }
      if (lv.state === "gone") { if (e.session_id) delete nextLooping[e.session_id]; continue; }
      const obs = observe(e, { prevRun, looping: loopingAll[e.session_id], now });
      const det = L.detect({ ...obs, paused: pausedLine(reg.lines, e), pauseActive: pausedFor(reg, e, now), liveState: lv.state }, cfg);
      if (e.session_id) { if (Object.keys(det.subFlags).length) nextLooping[e.session_id] = det.subFlags; else delete nextLooping[e.session_id]; }
      if (det.exempt) continue; // never flagged, and no ladder moves while it waits
      out.push(...(L.recoveryMode(reg.lines, e) === "report" ? reportOnly(e, det, obs, { dryRun, cfg, now, alerts, reg }) : runLadder(e, det, obs, { dryRun, cfg, now, reg, ts })));
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
// Batch B: Claude usage readings and pace-seen markers older than 8 days (pace-io.mjs), the sessions-pane mod's
// <coord>/pane/*.json files older than 1 day, and goal-gate's once-markers <config>/goals/.nudged-<sid> older than 14 days
// (a carried batch-A item). Their own summary line, so the stage-2 line keeps its shape.
const paceFiles = (now) => [...IO.staleUsageFiles(now), ...filesIn(C("pane")).filter((f) => f.endsWith(".json") && ageMs(f, now) > 24 * HOUR),
  ...filesIn(path.join(V.CFG, "goals")).filter((f) => path.basename(f).startsWith(".nudged-") && ageMs(f, now) > KEEP_MS)];
// One summary line when anything went; --dry-run removes nothing and lists what would go.
function prune({ dryRun, cfg, now }) {
  const p = prunable(now, cfg), extra = paceFiles(now);
  if (dryRun) return [...Object.values(p.files).flat().map((f) => `would prune ${fwd(f)}`), ...p.loops.map((sid) => `would prune looping.json entry ${sid} (its session is closed)`),
    ...p.alertKeys.map((k) => `would prune alerts/index.json entry ${k} (older than alert_repeat_hours)`), ...extra.map((f) => `would prune ${fwd(f)}`)];
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
  let extraFailed = 0;
  const gone = extra.filter((f) => { try { fs.rmSync(f, { force: true }); return true; } catch { extraFailed++; return false; } }).length;
  if (gone || extraFailed) out.push(`prune: removed ${gone} old usage reading(s), pace-seen marker(s), pane file(s) and nudge marker(s)`
    + `${extraFailed ? `, ${extraFailed} could not be removed` : ""}`);
  return out;
}
// Report-only, never a kill: they may belong to anything, hand-opened sessions included. An unknown probe (failed,
// empty, not Windows) reports nothing and leaves the last orphans.json. One alert per set of orphans (orphans|<sorted
// pids>) when they hold > 1 GB, again after alert_repeat_hours.
function orphanScan({ dryRun, cfg, now }) {
  const procs = V.processList();
  if (!procs) return [];
  const reaped = reapPlaywright(procs, { dryRun, now }), gone = new Set(reaped.pids);
  const list = L.orphans(procs.filter((p) => !gone.has(p.pid))), total = list.reduce((s, o) => s + o.mb, 0), out = [...reaped.lines, ...list.map(L.orphanLine)];
  if (dryRun) return total > 1024 ? [...out, `would alert: orphaned processes hold ${total} MB`] : out;
  // The coordinator's own report; command lines (batch A's process list) stay out of it: they can carry secrets.
  out.push(...writeState(C("orphans.json"), { at: V.now(), orphans: list.map(({ cmd, ...o }) => o) }, "orphans.json"));
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
// The Playwright orphan reaper (batch A, Part 8): Playwright's own processes whose parent is gone (L.playwrightOrphans),
// killed with their tree and logged; never by ancestor names. Then the temp dir's playwright_*dev_profile-* dirs that
// --isolated leaves behind (probe 7), older than 24 h and named by no running process. HL_FAKE_PROCS (tests) kills
// nothing: its pids are not real processes. Before a real kill, the PID-reuse guard (killPidTree's contract): a
// procInfo probe of that pid right before each kill (an earlier kill's tree may have ended it, and the pid may be
// reused since), and a pid is killed only while it is still the snapshot's process (L.sameProc: name and start time) -
// a recycled pid may be another session's window or claude, and taskkill /T takes its whole tree. A failed probe kills
// nothing. Exported for the release dry run, which calls it with dryRun: true (read-only: it lists what it would kill
// and remove). -> {pids, lines}
export function reapPlaywright(procs, { dryRun, now }) {
  const pw = L.playwrightOrphans(procs), lines = [], fake = !!process.env.HL_FAKE_PROCS;
  for (const p of pw) {
    const what = `Playwright orphan ${p.name} ${p.pid} (parent ${p.ppid} gone)`;
    if (dryRun) { lines.push(`would kill ${what}`); continue; }
    const info = fake ? null : V.procInfo([p.pid]);
    const k = fake ? { ok: true } : !info ? { ok: false, why: `the process probe failed (${V.probeWhy() || "no result"})` }
      : !L.sameProc(p, info.get(p.pid)) ? { ok: false, why: "no longer that process" } : V.killPidTree(p.pid);
    lines.push(k.ok ? `killed ${what}${fake ? " (HL_FAKE_PROCS: nothing really killed)" : ""}` : `${what} not killed: ${k.why}`);
  }
  let dirs = [];
  try { dirs = fs.readdirSync(os.tmpdir(), { withFileTypes: true }).filter((d) => d.isDirectory() && /^playwright_\w*dev_profile-/.test(d.name)).map((d) => { const f = path.join(os.tmpdir(), d.name); return { path: f, mtimeMs: fs.statSync(f).mtimeMs }; }); } catch {}
  const stale = L.staleProfileDirs(dirs, procs, now);
  if (stale.length) {
    if (dryRun) lines.push(...stale.map((d) => `would remove the stale Playwright profile ${fwd(d.path)}`));
    else { const n = stale.filter((d) => { try { fs.rmSync(d.path, { recursive: true, force: true, maxRetries: 2 }); return true; } catch { return false; } }).length; lines.push(`removed ${n} stale Playwright profile dir(s) from the temp dir`); }
  }
  return { pids: pw.map((p) => p.pid), lines };
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

// ---------- guarded closes: superseded (older generation) and paused windows ----------
// The guarded close (the hand-run guardclose script's logic): the host is still the recorded powershell with a start
// time within 2 s, and the transcript turn is done (re-read now); then kill_intent (kind close) -> taskkill /T /F ->
// {closed}, a process gone afterwards counting as closed (killTree, which probes once more). Both forms look below the
// host first (spec Part 3): a window whose claude exited and where the user now runs a job (python, git, an editor)
// keeps it even when its transcript reads idle, and a failed probe below it is no close. noClaude (batch A, Part 3): the
// no-claude form - the turn state is not required (no claude is left to finish a turn); the host must be EMPTY,
// re-checked right before the kill. -> {line, closed, busy, skipped}: busy - its turn is not done (re-checked next tick);
// skipped - any other reason it was not closed (batch B's pause close counts those). extra: fields every {closed} line
// of this close carries (the pause close passes {pause: true}).
export function guardedCloseResult(e, why, { dryRun, noClaude = false, extra = {} }) {
  const w = V.readPidFile(e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
  const skip = (line, busy = false) => ({ line, closed: false, busy, skipped: !busy });
  if (!w.host_pid || !w.host_start) return skip(`skip close of ${tag}: no recorded host pid and start time`);
  // checkHost is the same check once the pid file recorded the start time (required above): the name powershell and the
  // start within 2 s, a failed probe or an unreadable start unknown. Probed directly, never from the liveness memo.
  const h = V.checkHost(w, V.procInfo([w.host_pid]));
  if (h.state === "unknown") return skip(`skip close of ${tag}: liveness unknown (${h.why})`);
  if (h.state !== "running") return skip(`skip close of ${tag}: host pid ${w.host_pid} is not the recorded window (${h.why})`);
  // Its own fresh probe (not the gone scan's shared one). hostBelow of a value that is not a pid is null without a probe
  // (no probeWhy): named here.
  const b = V.hostBelow(w.host_pid);
  if (!b) return skip(`skip close of ${tag}: the process probe below its window failed (${V.probeWhy() || `host pid ${w.host_pid} is not a pid`})`);
  if (noClaude) {
    if (!b.empty) return skip(`skip close of ${tag}: its window is not empty (${b.names.join(", ")})`);
  } else {
    if (!b.empty && !b.claude) return skip(`skip close of ${tag}: its window runs ${b.names.join(", ")}, no claude`);
    const s = V.sessionState(e);
    if (s.found && (!s.idle || !s.bgKnown)) return skip(`skip close of ${tag}: its turn is not done (${s.busy.join(", ") || "pending background agents unknown"})`, true);
  }
  if (dryRun) return { line: `would close ${tag}: ${why}`, closed: false, busy: false, skipped: false };
  const k = V.killTree(e, why, "close", extra);
  return { line: `${k.closed ? "closed" : "not closed"} ${tag}: ${why}${k.line === "closed" ? "" : ` - ${k.line}`}`, closed: k.closed, busy: false, skipped: !k.closed };
}
export const guardedClose = (e, why, o) => guardedCloseResult(e, why, o).line;
// Why window e may be closed, from the registry alone (liveness is judged after): -> {succ} or null. succ: the open
// entries that supersede e (batch A, Part 1: launched after e with e in their chain - a new line follows its supersedes
// links, a legacy line keeps the generation rule), so an unrelated session that landed on the same checkout never closes
// it. The superseded close applies to every group (approved for all groups: an older generation handed its stage on, so
// its state is saved by construction). A window with an incident and a successor is superseded, so the superseded close
// covers it in every mode. A paused window is the pause close's (batch B, pauseScan), in both recovery modes.
function closeCase(reg, e) {
  if (e.mode !== "window" || reg.closed.has(e.id)) return null;
  const succ = G.supersedersOf(e, reg.entries, reg.closed);
  return succ.length ? { succ } : null;
}
const AGENTS_FRESH_MS = L.MIN; // a `claude agents --json` list younger than this is fresh enough for a close decision
export function supersededScan({ dryRun, cfg, now, repoKey }) {
  const out = [], first = V.readRegistry();
  const cands = first.entries.filter((e) => !repoKey || e.repo === repoKey).map((e) => [e, closeCase(first, e)]).filter(([, k]) => k);
  if (!cands.length) return out; // no probe at all in the common case
  // Probed now, not from the scan's memo: a 3-min restart earlier in this tick can leave it minutes old, and a successor
  // judged running then may be gone now. One window probe for the candidates and their lanes' newest launches; the
  // agents list is kept when it is under a minute old (one list per tick, not one per candidate or close).
  for (const [e, k] of cands) { V.forgetLiveness(e.id, { agents: false }); for (const n of k.succ) V.forgetLiveness(n.id, { agents: AGENTS_FRESH_MS }); }
  V.primeLiveness(cands.flatMap(([e, k]) => [e, ...k.succ]));
  for (const [c] of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === c.id), k = e && closeCase(reg, e); // fresh, as in scan
      if (!k) continue;
      const tag = `${e.name} (gen ${e.generation ?? "?"})`;
      const by = [...k.succ].reverse().find((n) => V.liveness(n, reg).state === "running"); // the newest running successor
      if (!by) continue; // a pending loop ladder with a running successor ends as superseded: no ladder check here
      const lv = V.liveness(e, reg);
      if (lv.state !== "running") { if (lv.state === "unknown") out.push(`skip close of ${tag}: liveness unknown (${lv.why})`); continue; }
      // A missing hook state reads "not waiting" (a pre-stage-2 session has no hook); one that exists but does not parse is
      // a failed read, never taken for "not waiting".
      const hf = plainId(e.session_id) ? C("sessions", `${e.session_id}.json`) : null, hook = hf ? V.readJson(hf, null) : {};
      if (!hook && fs.existsSync(hf)) { out.push(`skip close of ${tag}: hook state unreadable`); continue; }
      const st = V.sessionState(e);
      // Without a transcript only an EMPTY host closes (batch A): a job the user runs in the window keeps it (null: unknown).
      const below = st.found ? null : V.hostBelow(V.readPidFile(e).host_pid), emptyHost = st.found ? null : below ? below.empty : null;
      const reason = `superseded by generation ${by.generation}`;
      const d = L.closeDecision({ state: st, waitingSince: hook?.waiting_since || null, emptyHost, now, cfg, reason, launchedAt: e.launched_at });
      // A kept window prints nothing: every tick would repeat it. Without a transcript the close rests on an empty host, so
      // the no-claude form re-checks it right before the kill (spec Part 3).
      if (d.close) out.push(guardedClose(e, d.why, { dryRun, noClaude: !st.found }));
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
  }
  return out;
}

// ---------- batch B, Part 4: the pause close ----------
// The tick's own state (pause/tick-state.json): {skips: {<id>: n}, alerted: [<id>], probe: {id, at} | null,
// failed: {<id>: n}, repause: {<lane key>: {n, at}}, manifest_rows: [<lane row>], timedOut: {<id>: {at, name, group}}}.
// Pause fields belong only to an unrestricted tick; a --repo tick may update only its lanes' timeout holds.
export const readTickState = () => {
  const t = V.readJson(PI.TICK_STATE, {}) || {};
  return { skips: t.skips || {}, alerted: Array.isArray(t.alerted) ? t.alerted : [], probe: t.probe ?? null, failed: t.failed || {}, repause: t.repause || {}, manifest_rows: Array.isArray(t.manifest_rows) ? t.manifest_rows : [], timedOut: t.timedOut && Object.getPrototypeOf(t.timedOut) === Object.prototype ? t.timedOut : {},
    offtimes_alerted: t.offtimes_alerted ?? null, offtimes_bad_at: Number.isFinite(t.offtimes_bad_at) ? t.offtimes_bad_at : null };
};
// Print the hold even while a fresh {starting} keeps its lane out of the resume list. Expiry or a late registration
// drops the record only on a real tick; dry runs use the same decision without changing state.
function timeoutScan({ dryRun, now, repoKey, ts }) {
  const reg = V.readRegistry(), out = [];
  for (const [id, t] of Object.entries(ts.timedOut)) {
    if (repoKey && !reg.entries.some((e) => e.id === id && e.repo === repoKey)) continue;
    if (L.launchTimeoutPending(t, reg.lines, now, id)) out.push(L.launchTimeoutLine(t, dryRun));
    else if (!dryRun) delete ts.timedOut[id];
  }
  return out;
}
// Every {closed} line the pause close writes carries this: only a pause close makes a lane pending for the resume.
const PAUSE_CLOSE = { pause: true };
// One more skipped close of a paused lane; at the second, one alert naming it (CLOSE_SKIPPED_TEXT). -> lines
// skippedNow: the lanes skipped in the running pauseScan - a lane not in it has its count reset (consecutive ticks only).
const skippedNow = new Set();
function countSkip(e, why, { dryRun, ts }) {
  if (dryRun) return [];
  skippedNow.add(e.id);
  const n = (ts.skips[e.id] || 0) + 1;
  ts.skips[e.id] = n;
  if (n < 2 || ts.alerted.includes(e.id)) return [];
  ts.alerted.push(e.id);
  return [`paused lane ${e.name} not closed for ${n} ticks - alert ${fwd(raiseAlert({ name: e.name, text: Q.CLOSE_SKIPPED_TEXT({ name: e.name, why }), incident: null }))}`];
}
// At sunset the tick supplies the lane's {paused} line even when its turn is busy or its liveness is unknown.
function shabbatMark({ dryRun, sh }) {
  const reg = V.readRegistry(), open = reg.entries.filter((e) => !reg.closed.has(e.id)), out = [];
  V.primeLiveness(open);
  for (const e of open) {
    if (V.liveness(e, reg).state === "gone" || !Q.shabbatLineDue(Q.pausedLineOf(reg.lines, e), sh)) continue;
    const tag = `${e.name} (gen ${e.generation ?? "?"})`;
    if (dryRun) out.push(`would write the Shabbat {paused} line of ${tag}`);
    else { V.append(Q.shabbatLine(e, sh, V.now())); out.push(`Shabbat/Yom Tov: {paused} written for ${tag}`); }
  }
  return out;
}
// Past the grace, a fresh line keeps the resume from reading the last minutes as work after its pause.
// killTree re-probes and kills only a running session.
function shabbatForce(e, sh, { dryRun, now, tag }) {
  const why = `Shabbat/Yom Tov began ${Math.round((now - sh.start) / L.MIN)} min ago: closed by force after the ${Q.SHABBAT_GRACE_MIN}-min grace`;
  if (e.mode === "bg" && !e.bg_id) return { line: `skip close of ${tag}: a background lane without a recorded bg_id cannot be stopped`, closed: false, skipped: true };
  if (dryRun) return { line: `would force-close ${tag}: ${why}`, closed: false, skipped: false };
  V.append(Q.shabbatLine(e, sh, V.now(), { forced: true }));
  const k = V.killTree(e, why, "close", PAUSE_CLOSE);
  return { line: `${k.closed ? "closed" : "not closed"} ${tag}: ${why}${k.line === "closed" ? "" : ` - ${k.line}`}`, closed: k.closed, skipped: !k.closed };
}
// Every open lane with a {paused} line after its launch, window or bg, in both recovery modes (batch B: the stage-2
// paused close was auto mode only): closed while its pause applies, or once it lifted when the lane did nothing since
// (pause-lib pauseCloseDue; the line must be 1 min old, except the tick's sunset line). At sunset every open lane is
// marked first; past the 10-min grace a lane still open goes through the force close. Otherwise a window uses idle_close_min
// waived (the lane saved its state before writing {paused}); the pid-reuse, host and idle-now checks stay. A bg lane is
// stopped by its bg_id (killTree); one without a bg_id cannot be stopped. A busy lane (or one waiting on a permission
// prompt) is re-checked next tick; any other skip is counted, and alerted once at the second tick (countSkip). Hand-opened
// sessions have no registry entry: never closed. An unrestricted tick only (like the resume and the manifest: the tick
// state is machine-wide). Every {closed} line carries pause: true. -> {lines, closed: [{e, priority, reason, source}]}
function pauseScan({ dryRun, cfg, now, ts }) {
  const out = [], closed = [], sources = PI.readSources(now), sh = sources.find((s) => s.source === "shabbat");
  if (sh && now >= sh.start) {
    out.push(...shabbatMark({ dryRun, sh }));
    now = Math.max(now, Date.now()); // The new lines may be a few ms newer than the scan's original now.
  }
  const first = V.readRegistry();
  skippedNow.clear();
  const cands = first.entries.filter((e) => !first.closed.has(e.id) && Q.pausedLineOf(first.lines, e));
  // Closed, gone or relaunched since: their skip counts and alert marks go.
  for (const id of Object.keys(ts.skips)) if (!cands.some((e) => e.id === id)) delete ts.skips[id];
  ts.alerted = ts.alerted.filter((id) => cands.some((e) => e.id === id));
  if (!cands.length) return { lines: out, closed };
  for (const e of cands) V.forgetLiveness(e.id, { agents: V.usesAgents(e) ? AGENTS_FRESH_MS : false });
  V.primeLiveness(cands);
  for (const c of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === c.id);
      if (!e || reg.closed.has(e.id)) continue;
      const line = Q.pausedLineOf(reg.lines, e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
      const priority = G.effectivePriority(reg.lines, e), pause = Q.pauseFor(priority, sources);
      const lv = V.liveness(e, reg);
      if (lv.state === "gone") continue; // the resume side takes a gone paused lane
      // Due first: a lane not due is neither counted nor alerted for an unknown liveness.
      const st = V.sessionState(e);
      // The tick's own line waits no minute; the guarded close below judges the lane itself.
      const pausedAt = (Date.parse(line.at) || 0) - (line.by === "tick" ? L.MIN : 0);
      const due = Q.pauseCloseDue({ pausedAt, pause, lastAt: Date.parse(st.lastReal), now }), force = Q.shabbatForceDue(sh, now);
      if (!due.close && !force) continue;
      if (lv.state === "unknown") { out.push(`skip close of ${tag}: liveness unknown (${lv.why})`, ...countSkip(e, `liveness unknown (${lv.why})`, { dryRun, ts })); continue; }
      if (L.pendingLadders(reg.lines).some((p) => p.id === e.id)) { out.push(`skip close of ${tag}: its loop ladder is pending - the ladder ends first`); if (force) out.push(...countSkip(e, "its loop ladder is pending", { dryRun, ts })); continue; }
      if (force) {
        const r = shabbatForce(e, sh, { dryRun, now, tag });
        out.push(r.line);
        if (r.skipped) out.push(...countSkip(e, r.line.replace(/^(?:skip close of |not closed )[^:]+: /, ""), { dryRun, ts }));
        if (r.closed) closed.push({ e, priority, reason: sh.reason, source: "shabbat" });
        continue;
      }
      let r;
      if (e.mode === "bg") {
        if (!e.bg_id) { const why = "a background lane without a recorded bg_id cannot be stopped"; out.push(`skip close of ${tag}: ${why}`, ...countSkip(e, why, { dryRun, ts })); continue; }
        // No transcript, or an idle turn whose background agents are unknown (no turn_duration record): not closed, counted
        // (the window path's rule). A busy lane is re-checked next tick.
        if (!st.found) { out.push(...countSkip(e, "its transcript was not found", { dryRun, ts })); continue; }
        if (!st.idle) continue;
        if (st.bgKnown !== true) { out.push(...countSkip(e, "pending background agents unknown", { dryRun, ts })); continue; }
        if (dryRun) r = { line: `would close ${tag}: ${due.why}`, closed: false, skipped: false };
        else { const k = V.killTree(e, due.why, "close", PAUSE_CLOSE); r = { line: `${k.closed ? "closed" : "not closed"} ${tag}: ${due.why}${k.line === "closed" ? "" : ` - ${k.line}`}`, closed: k.closed, skipped: !k.closed }; }
      } else {
        const hf = plainId(e.session_id) ? C("sessions", `${e.session_id}.json`) : null, hook = hf ? V.readJson(hf, null) : {};
        if (!hook && fs.existsSync(hf)) { out.push(`skip close of ${tag}: hook state unreadable`, ...countSkip(e, "hook state unreadable", { dryRun, ts })); continue; }
        const below = st.found ? null : V.hostBelow(V.readPidFile(e).host_pid), emptyHost = st.found ? null : below ? below.empty : null;
        const d = L.closeDecision({ state: st, waitingSince: hook?.waiting_since || null, emptyHost, now, cfg: { ...cfg, idle_close_min: 0 }, reason: due.why, launchedAt: e.launched_at });
        if (!d.close) { if (!st.found || (st.idle && st.bgKnown !== true)) out.push(...countSkip(e, d.why, { dryRun, ts })); continue; } // busy or waiting: next tick
        r = guardedCloseResult(e, d.why, { dryRun, noClaude: !st.found, extra: PAUSE_CLOSE });
      }
      out.push(r.line);
      if (r.skipped) out.push(...countSkip(e, r.line.replace(/^(?:skip close of |not closed )[^:]+: /, ""), { dryRun, ts }));
      if (r.closed) closed.push({ e, priority, reason: line.reason ?? due.why, source: line.source });
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
  }
  // Consecutive skips only: a lane not skipped on this tick starts again from zero (and may be alerted again later).
  if (!dryRun) for (const id of Object.keys(ts.skips)) if (!skippedNow.has(id)) { delete ts.skips[id]; ts.alerted = ts.alerted.filter((x) => x !== id); }
  return { lines: out, closed };
}

// ---------- batch B, Part 4: resuming, and the paused-session manifest ----------
// The lanes a pause closed (pause-lib pausedLanes: a lane's newest entry with a {paused} line, closed or gone, no launch
// in flight, and not worked after its {paused} line - live.mjs workedAfterPause, the one activity rule launch.mjs resume
// --paused shares) whose pause no longer applies are relaunched fresh from their handoff - the arguments `launch.mjs
// resume --paused` uses (freshLaunchArgs with the pause's reason as --resume-note), spawned under this tick's tick.lock,
// which `resume --paused` by hand also takes, so the two never relaunch one lane twice. In pause-lib resumePlan's order
// and number: high first, max_resumes_per_tick, a pace close not before its minimum pause (min_pause_min, doubled per
// consecutive pace re-pause of the lane, 4x at most: tick state `repause`), one window lane at a time while a probe
// resume waits for a fresh reading (the probe is recorded only when that lane's relaunch worked; no fresh pace.json is
// unknown pace, which probes too). A cap refusal ends this tick's relaunches (the next tick retries); a lane whose
// relaunch failed twice is alerted once and left to `launch.mjs resume --paused` by hand. An unrestricted tick only. -> lines
// Pause-resume decisions use the tick's start `now` (slightly conservative after long restarts; accepted 2026-10-07).
function resumeScan({ dryRun, cfg, now, ts }) {
  const out = [], reg = V.readRegistry(), sources = PI.readSources(now);
  const lanes = Q.pausedLanes({ entries: reg.entries, lines: reg.lines, closed: reg.closed, gone: (e) => V.liveness(e, reg).state === "gone", now,
    activeAfter: (e, line) => V.workedAfterPause(e, line) });
  // A failed count goes once its lane is resumed, replaced or gone since - not when only an in-flight {starting} line (a
  // window spawn that failed after the launcher wrote it, under 5 min old) leaves the lane out of `lanes`.
  const waiting = (e) => {
    const t = Date.parse(e.launched_at) || 0, line = Q.pausedLineOf(reg.lines, e);
    if (!reg.entries.some((x) => x.id === e.id) || reg.entries.some((x) => Q.lanePauseKey(x) === Q.lanePauseKey(e) && (Date.parse(x.launched_at) || 0) > t) || !line || V.workedAfterPause(e, line)) return false;
    return reg.closed.has(e.id) ? [...reg.lines].reverse().find((o) => o.closed && o.id === e.id)?.pause === true : V.liveness(e, reg).state === "gone";
  };
  for (const id of Object.keys(ts.failed)) if (!lanes.some(({ e }) => e.id === id) && !waiting(reg.entries.find((x) => x.id === id) ?? { id })) delete ts.failed[id];
  for (const [k, v] of Object.entries(ts.repause)) if (!(now - v?.at <= 6 * 60 * L.MIN)) delete ts.repause[k]; // a series ends after 6 h
  const pending = lanes.filter(({ e }) => (ts.failed[e.id] || 0) < 2 && !L.launchTimeoutPending(ts.timedOut[e.id], reg.lines, now, e.id)).map(({ e, line, closedAt }) => {
    const source = line.source ?? "manual", pausedAt = Date.parse(line.at) || 0, key = Q.lanePauseKey(e);
    const n = source === "pace" ? Q.repauseCount(ts.repause[key], pausedAt) : 1;
    return { e, key, n, priority: G.effectivePriority(reg.lines, e), source, windows: Array.isArray(line.windows) ? line.windows : [], reason: line.reason ?? "paused", pausedAt, closedAt, ...(source === "pace" ? { minPause: Q.minPauseFor(n, cfg) } : {}) };
  });
  if (!pending.length) { if (!dryRun) ts.probe = null; return out; }
  const pace = P.paceFresh(V.readJson(IO.PACE_FILE, null), now, cfg.pace)?.claude ?? null;
  const plan = Q.resumePlan({ pending, pauseOf: (p) => Q.pauseFor(p, sources), pace, now, cfg, probe: ts.probe });
  const ok = new Set();
  for (const p of plan.relaunch) {
    const e = p.e, again = e.mode === "bg" ? " - the next tick checks the lane again" : " - the next tick retries"; // a bg launcher may have recorded its entry before failing
    try {
    const what = `${e.name} after its pause (${p.reason})${plan.mode === "probe" ? " - a probe resume" : ""}`;
    if (dryRun) { out.push(`would relaunch ${what}`); continue; }
    touchTickLock();
    const r = spawnLaunch(e.name, L.freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", resumeNote: p.reason, priority: p.priority, supersedes: e.id }));
    if (r.cap) { out.push(`relaunch of ${e.name} after its pause deferred: session cap (${r.cap})${again}`); break; }
    if (r.timedOut && !launchRegistered(e, r)) { out.push(...deferTimeout(e, r, ts, now)); continue; }
    if (r.ok) {
      ok.add(e.id);
      if (p.source === "pace") ts.repause[p.key] = { n: p.n, at: now };
      out.push(`relaunched ${what}`);
      continue;
    }
    const n = (ts.failed[e.id] || 0) + 1;
    ts.failed[e.id] = n;
    out.push(`relaunch of ${e.name} after its pause failed: ${r.why} (log ${r.log})${n < 2 ? again : ""}`);
    if (n >= 2) out.push(`gave up relaunching ${e.name} - alert ${fwd(raiseAlert({ name: e.name, text: `Relaunch of ${e.name} after its pause failed twice: ${r.why} (log ${r.log}). Fix it, then: node ${fwd(LAUNCH)} resume --paused --id ${e.id}`, incident: null }))}`);
    } catch (err) { out.push(`error ${e.name}: ${err?.message || err} - no relaunch of it this tick`); }
  }
  if (!dryRun) {
    if (plan.mode !== "probe") ts.probe = null;
    else if (!plan.relaunch.length || ok.has(plan.probe?.id)) ts.probe = plan.probe; // waiting, or this probe started
  }
  return out;
}
// The manifest, <coord>/paused.json (the tick is its only writer, through writeState: a write that fails is one "error:"
// line): a row per lane the pause close took this tick (the newest generation of a lane only) and per hand-opened session
// the hooks recorded while paused (pause/seen); a closed row gets resumed_at once its lane has a newer launch. A seen
// record older than the current pause's start (the earliest `since` of the active sources) belongs to an earlier, lifted
// pause: it is removed, never listed. When no source is active: one phone alert listing the hand-opened sessions' `claude
// --resume <id>` commands, and the archive (paused-<date>-<HHMM>.json, which also clears pause/seen) once every closed
// row is resumed. An unrestricted tick only (the manifest is machine-wide). -> lines
function manifestTick({ dryRun, now, closed, ts }) {
  if (dryRun) return [];
  const sources = PI.readSources(now), active = sources.length > 0, reg = V.readRegistry();
  // The current pause's start: none when any active source has no parsable start (then no seen record is judged old).
  const starts = sources.map((x) => Date.parse(x.since)), since = starts.length && starts.every(Number.isFinite) ? Math.min(...starts) : NaN;
  const newestOf = (r) => [...reg.entries].reverse().find((x) => x.repo === r.repo && x.name === r.name && (x.group ?? null) === (r.group ?? null)) ?? null;
  // A closed row whose lane is no longer waiting for a relaunch is done too: it worked after its {paused} line (resumed by
  // hand), or its relaunch failed twice (alerted, left to the user). A newer launch is markResumed's.
  const done = (r) => {
    const e = newestOf(r), line = e && Q.pausedLineOf(reg.lines, e);
    return !e || !line || (e.generation ?? 0) > (r.generation ?? 0) || (ts?.failed?.[e.id] || 0) >= 2 || V.workedAfterPause(e, line);
  };
  let m = V.readJson(PI.MANIFEST, null);
  const out = [];
  // C4: rows waiting for the old archive survive ticks until their own manifest write succeeds.
  const rows = Q.upsertRows({ sessions: ts.manifest_rows }, closed.map(({ e, priority, reason, source }) => Q.laneRow(e, { priority, reason, source })), now).sessions;
  // The manifest of a pause that ended (a tick saw no active source and stamped ended_at) is archived before a new pause's
  // rows go in: one pause's rows never carry into the next. `since` moves inside one pause, so it never decides this.
  if ((active || ts.manifest_rows.length) && m && Array.isArray(m.sessions) && m.ended_at) {
    const a = archiveManifest(Q.markResumed(m, newestOf), { clearSeen: false });
    out.push(...a.lines);
    // A failed archive leaves the old manifest in place: the new pause's rows must not fold into it - nothing more this
    // tick, the next one retries, even if the new pause lifted meanwhile.
    if (!a.ok) { ts.manifest_rows = rows; return out; }
    // The seen records of the pause that ended (older than its ended_at) went with it; the new pause's stay.
    const ended = Date.parse(m.ended_at);
    if (Number.isFinite(ended)) for (const x of PI.readSeen()) if (Date.parse(x.at) < ended) { try { fs.rmSync(x.file, { force: true }); } catch {} }
    m = null;
  }
  if (active || rows.length) {
    const seen = PI.readSeen().filter((s) => {
      if (Number.isFinite(since) && !(Date.parse(s.at) >= since)) { try { fs.rmSync(s.file, { force: true }); } catch {} return false; } // an earlier pause's
      return true;
    });
    rows.push(...seen.map((s) => Q.handRow(s)));
  }
  if (!m && !rows.length) return out;
  const before = JSON.stringify(m);
  if (rows.length) m = Q.upsertRows(m, rows, now, Q.HOW_TO_RESUME(fwd(LAUNCH)));
  m = Q.markResumed(m, newestOf);
  if (!active && !m.ended_at) m = { ...m, ended_at: V.now() }; // the pause is over: a later pause starts a new manifest
  const hands = m.sessions.filter((r) => !r.closed);
  if (!active && hands.length && !m.hand_alerted) {
    m = { ...m, hand_alerted: V.now() };
    out.push(`the pause ended: ${hands.length} hand-opened session(s) to resume by hand - alert ${fwd(raiseAlert({ name: "paused", text: Q.HAND_RESUME_TEXT(hands), incident: null }))}`);
  }
  if (Q.archiveDue(m, active, done)) {
    const a = archiveManifest(m, { clearSeen: true });
    out.push(...a.lines);
    if (a.ok) { ts.manifest_rows = []; return out; }
    // the archive could not be written: the manifest stays (hand_alerted kept, so no alert every tick) and the next tick retries
  }
  const errors = JSON.stringify(m) !== before ? writeState(PI.MANIFEST, m, "paused.json") : [];
  out.push(...errors);
  if (!errors.length) ts.manifest_rows = [];
  else if (ts.manifest_rows.length) ts.manifest_rows = rows.filter((r) => r.closed);
  return out;
}
// Write the manifest's archive (paused-<date>-<HHMM>.json), then remove paused.json and, when clearSeen, pause/seen.
// -> {ok: the archive was written, lines}
function archiveManifest(m, { clearSeen }) {
  const to = C(Q.archiveName(m)), w = writeState(to, m, path.basename(to));
  if (w.length) return { ok: false, lines: w };
  const lines = [];
  try { fs.rmSync(PI.MANIFEST, { force: true }); lines.push(`pause manifest archived: ${fwd(to)}`); }
  catch (err) { return { ok: true, lines: [`pause manifest archived: ${fwd(to)}`, `error: paused.json not removed after its archive (${err?.code || err?.message || err})`] }; }
  if (clearSeen) { try { for (const x of PI.readSeen()) fs.rmSync(x.file, { force: true }); } catch (err) { lines.push(`error: pause/seen not cleared after the archive (${err?.code || err?.message || err})`); } }
  return { ok: true, lines };
}

// ---------- batch A, Part 3: windows whose claude is gone (dead start, exited) ----------
// Window entries only, every group. Registry and file-time tests first (launch age, a quiet or missing transcript), then
// liveness (one window probe, fresh), so few windows reach the host probe: ONE process scan for all of them (plan
// amendment 3, V.hostsBelow); a failed scan, or a host missing from it, is no action. The host must be EMPTY. Exited (the
// transcript has assistant records): closed at once, no alert. Dead start: one {dead_start} line and one alert (key
// deadstart|<id>, again after alert_repeat_hours), a coordinator restart also {restart_failed} + {lane_blocked}, and the
// window is closed dead_close_min after the alert. Every close is guardedClose's no-claude form, which re-probes its own
// window right before the kill. A pending ladder owns its session: skipped.
// A window the user exited (or that crashed) while its lane was paused (a {paused} line it did not work after) is a pause
// close: the {closed} line carries pause: true, so the resume relaunches it once the pause ends. No other closer changes.
const exitedPauseExtra = (e, reg) => { const p = Q.pausedLineOf(reg.lines, e); return p && !V.workedAfterPause(e, p) ? PAUSE_CLOSE : {}; };
function goneScan({ dryRun, cfg, now, repoKey }) {
  const out = [], first = V.readRegistry(), pend = new Set(L.pendingLadders(first.lines).map((p) => p.id));
  const pre = [];
  for (const e of first.entries) {
    if (e.mode !== "window" || first.closed.has(e.id) || pend.has(e.id) || (repoKey && e.repo !== repoKey)) continue;
    const file = V.transcriptOf(e.session_id);
    let lastAt = NaN; if (file) { try { lastAt = fs.statSync(file).mtimeMs; } catch {} } // ms, as goneCandidate takes it
    if (L.goneCandidate({ launchedAt: e.launched_at, lastAt, hasTranscript: !!file, now, cfg })) pre.push({ e, file });
  }
  if (!pre.length) return out; // no probe at all in the common case
  // Probed now, not from the scan's memo: a restart earlier in this tick can leave it minutes old.
  for (const { e } of pre) V.forgetLiveness(e.id, { agents: false });
  V.primeLiveness(pre.map((c) => c.e));
  const cands = pre.filter((c) => V.liveness(c.e, first).state === "running");
  if (!cands.length) return out;
  const below = V.hostsBelow(cands.map((c) => V.readPidFile(c.e).host_pid)); // a Map keyed by Number pid, or null
  if (!below) return [`skip the gone scan of ${cands.length} window(s): the process probe below their hosts failed (${V.probeWhy() || "no result"}) - no action`];
  for (const { e, file } of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry();
      if (reg.closed.has(e.id) || V.liveness(e, reg).state !== "running") continue;
      const b = below.get(Number(V.readPidFile(e).host_pid));
      if (!b || !b.empty) continue;
      if (L.goneKind(file ? V.tail(file) : null, Date.parse(e.launched_at)) === "exited") { out.push(guardedClose(e, "claude exited", { dryRun, noClaude: true, extra: exitedPauseExtra(e, reg) })); continue; }
      out.push(...deadStart(e, reg, { dryRun, cfg, now }));
    } catch (err) { out.push(`error ${e.name}: ${err?.message || err} - no action this tick`); }
  }
  return out;
}
function deadStart(e, reg, { dryRun, cfg, now }) {
  const tag = `${e.name} (gen ${e.generation ?? "?"})`, seen = reg.lines.find((o) => o.dead_start === e.id);
  const alerts = V.readJson(C("alerts", "index.json"), {}) || {}, k = `deadstart|${e.id}`;
  const since = seen ? Date.parse(seen.at) : now, closeAt = since + cfg.dead_close_min * L.MIN;
  if (seen && now >= closeAt) return [guardedClose(e, `dead start: no claude in the window since ${seen.at}`, { dryRun, noClaude: true })];
  if (seen && !L.alertDue(alerts, k, now, cfg)) return [];
  // A coordinator restart that died at once is a restart that failed to launch: blocked, and alerted as one (its
  // incident and the relaunch hint), the repeated alert too.
  const rs = L.restartOf(reg.lines, e), inc = rs ? incidentOf(reg.lines, e, rs.n) : null;
  if (dryRun) return [`would alert DEAD START ${tag}${seen ? " again" : ""} and close its window at ${new Date(closeAt).toISOString()}`
    + (rs && !seen ? ` - a coordinator restart: would write {restart_failed} and {lane_blocked}` : "")];
  const out = [];
  if (!seen) {
    V.append({ dead_start: e.id, name: e.name, group: e.group || null, at: new Date(now).toISOString() });
    if (rs) {
      V.append({ restart_failed: e.name, n: rs.n, kind: rs.kind, from: rs.from, handoff: e.handoff, why: "dead start: claude exited right after the launch", log: null, at: V.now() });
      V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc?.path ?? null, at: V.now() });
      out.push(`restart of ${e.name} failed: its window is a dead start - blocked`);
    }
  }
  const p = { name: e.name, branch: e.branch, launchedAt: e.launched_at, closeAt };
  const text = rs ? L.DEAD_RESTART_TEXT({ ...p, group: e.group ?? null, incident: inc?.path ?? "(not found)", launchMjs: fwd(LAUNCH), handoff: e.handoff }) : L.DEAD_START_TEXT(p);
  const f = raiseAlert({ name: e.name, text, incident: inc?.path ?? null });
  alerts[k] = V.now();
  out.unshift(`DEAD START ${tag}: claude exited right after the launch - alert ${fwd(f)}`);
  return [...out, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json")];
}

// ---------- batch A, Part 5: lanes.json, the live lanes the hooks read ----------
// Per repo: the newest open entry of each lane (repo + branch) whose liveness is running or unknown, with its registry
// id, name, branch, worktree, group, scope, effective priority and checklist note. Liveness is judged before the newest
// is picked (batch B carried fix): a gone, unclosed newest entry never hides an older one that still runs. repoKey: the
// key() form launch lines store (a --repo tick). A --repo tick rewrites only its key.
export function laneTable(reg, repoKey = null, now = Date.now()) {
  const open = reg.entries.filter((e) => !reg.closed.has(e.id) && (!repoKey || e.repo === repoKey));
  V.primeLiveness(open); // one window probe for all of them
  const newest = new Map(), lvs = new Map();
  for (const e of open) {
    const lv = V.liveness(e, reg);
    if (lv.state === "gone") continue;
    lvs.set(e.id, lv);
    const key = `${e.repo}|${e.branch}`, cur = newest.get(key);
    if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(key, e);
  }
  const repos = {};
  for (const e of newest.values()) {
    const lv = lvs.get(e.id);
    const gp = e.session_id ? V.goalOf(e.session_id) : null;
    let goal = "no GOAL.md";
    if (gp) { try { goal = L.goalNote(L.parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, now); } catch {} }
    (repos[e.repo] ??= []).push({ id: e.id, name: e.name, branch: e.branch, worktree: e.worktree, group: e.group ?? null, scope: e.scope ?? null,
      priority: G.effectivePriority(reg.lines, e), liveness: lv.state, goal });
  }
  return repos;
}
function writeLanes({ dryRun, repoKey, now }) {
  if (dryRun) return [];
  const f = C("lanes.json"), table = laneTable(V.readRegistry(), repoKey, now);
  const prev = (V.readJson(f, {}) || {}).repos;
  const repos = repoKey ? { ...(prev && typeof prev === "object" ? prev : {}), [repoKey]: table[repoKey] || [] } : table;
  return writeState(f, { at: V.now(), repos }, "lanes.json");
}

// ---------- batch B, Part 2: pace.json from the usage files, at every unrestricted tick ----------
// Keeps pace.json's `updated` fresh while no status line runs (readers treat one older than 15 min as absent). One line
// per provider whose state changed (a new provider at ok says nothing); a dry run writes nothing. A failure: one line.
function paceTick({ dryRun, cfg, now }) {
  try {
    const { pace, prev } = IO.recomputePace({ now, cfg: cfg.pace, write: !dryRun });
    return P.providersOf(pace).filter(([p, e]) => (P.isEntry(prev?.[p]) ? prev[p].state : "ok") !== e.state)
      .map(([p, e]) => `${dryRun ? "would set " : ""}pace: ${p} ${P.isEntry(prev?.[p]) ? prev[p].state : "ok"} -> ${e.state} (${P.aheadText(e)})`);
  } catch (err) { return [`error: pace.json not written (${err?.code || err?.message || err})`]; }
}

// A bad table alerts daily while the mode is on; a valid one under 60 days left alerts once per until. -> lines
function offTimesTick({ dryRun, now, ts }) {
  const s = PI.offTimesStatus(now);
  if (!s) return [];
  let text, line;
  if (s.state !== "ok") {
    if (ts.offtimes_bad_at !== null && now - ts.offtimes_bad_at < 864e5) return [];
    text = P.OFFTIMES_BAD_TEXT(s.state);
    line = `offtimes.json is ${s.state}`;
  } else {
    if (!(s.daysLeft < 60) || ts.offtimes_alerted === s.until) return [];
    text = P.OFFTIMES_EXPIRY_TEXT(s);
    line = `offtimes.json has ${s.daysLeft} days left`;
  }
  if (dryRun) return [`would alert: ${text}`];
  const f = raiseAlert({ name: "offtimes", text });
  if (s.state === "ok") ts.offtimes_alerted = s.until;
  else ts.offtimes_bad_at = now;
  return [`${line} - alert ${fwd(f)}`];
}

// ---------- batch B, Part 7: the power refresh at a tick ----------
// When power.json is stale (pause-io powerStale), the probe runs here (the tick is detached already). One line when the
// battery source appears or goes. A dry run never probes. -> lines
function powerTick({ dryRun, now }) {
  if (dryRun || !PI.powerStale(now)) return [];
  try {
    const r = PI.refreshPower(now);
    return r.changed ? [`power: ${PI.powerText(r.power)} - ${r.low ? "low battery: every lane pauses" : "the battery pause ended"}`] : [];
  } catch (err) { return [`error: power not refreshed (${err?.message || err})`]; }
}

// ---------- batch B, Part 4: the watcher wakes an idle machine ----------
// Ticks come only from hooks, so a fully paused machine gets none: start the watcher while a source is active over an
// open lane, or while a lane waits for its pause resume (pause-io watchNeeded). An unrestricted tick only. -> lines
function watcherTick({ dryRun, now }) {
  const reg = V.readRegistry(), active = PI.readSources(now).length > 0;
  // Cheap first: no source and no {paused} line anywhere means nothing is open-paused or waiting - no liveness probes.
  if (!active && !reg.lines.some((o) => o && "paused" in o)) return [];
  const openLanes = active ? reg.entries.filter((e) => !reg.closed.has(e.id) && V.liveness(e, reg).state !== "gone").length : 0;
  const failed = readTickState().failed; // the tick gave up on these (a relaunch failed twice): nothing can act on them
  const pending = Q.pausedLanes({ entries: reg.entries, lines: reg.lines, closed: reg.closed, gone: (e) => V.liveness(e, reg).state === "gone", now,
    activeAfter: (e, line) => V.workedAfterPause(e, line) }).filter(({ e }) => !((failed[e.id] || 0) >= 2)).length;
  if (!PI.watchNeeded({ active, openLanes, pending })) return [];
  const why = active ? "a pause is active" : "lanes wait for their pause resume";
  if (dryRun) { const last = Date.parse(V.readJson(PI.WATCH_START, {})?.at); return PI.watchHolder() || (last <= now && now - last < 60000) ? [] : [`would start the watcher (${why})`]; }
  const r = PI.ensureWatcher("tick", now);
  return r === "started" || r === "recorded" ? [`watcher started (${why})`] : r === "failed" ? ["error: the watcher could not be started"] : [];
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
    const ts = readTickState(), tsBefore = JSON.stringify(ts);
    if (!dryRun) V.writeAtomic(C("tick.json"), JSON.stringify({ ...tj, at: V.now(), last_run: V.now() }));
    out.push(...releaseStaleClaims(now, { dryRun }));
    // batch B: power first, then pace.json (machine-wide: an unrestricted tick only), before pause and resume decisions
    const offNow = !repoKey && PI.readOffTimes(now).some((o) => o.start <= now && now < o.end);
    if (!repoKey && !offNow) out.push(...powerTick({ dryRun, now }), ...paceTick({ dryRun, cfg, now }));
    if (!repoKey) out.push(...offTimesTick({ dryRun, now, ts }));
    out.push(...timeoutScan({ dryRun, now, repoKey, ts }));
    out.push(...resumePending({ dryRun, cfg, prevRun, now, repoKey, ts }));
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey, ts }));
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
    // batch B, Part 4: the pause close, the resume and the manifest are machine-wide, like their state in
    // pause/tick-state.json (written only when it changed): a --repo tick preserves every pause field and updates
    // only timeout holds. A state file that cannot be written is one "error:" line (writeState).
    const pz = !repoKey ? pauseScan({ dryRun, cfg, now: Date.now(), ts }) : { lines: [], closed: [] };
    out.push(...pz.lines);
    out.push(...goneScan({ dryRun, cfg, now: Date.now(), repoKey }));
    if (!repoKey) out.push(...resumeScan({ dryRun, cfg, now, ts }), ...manifestTick({ dryRun, now: Date.now(), closed: pz.closed, ts }));
    if (!dryRun && JSON.stringify(ts) !== tsBefore) out.push(...writeState(PI.TICK_STATE, repoKey ? { ...(V.readJson(PI.TICK_STATE, {}) || {}), timedOut: ts.timedOut } : ts, "pause/tick-state.json"));
    out.push(...writeLanes({ dryRun, repoKey, now: Date.now() }));
    if (!repoKey) out.push(...watcherTick({ dryRun, now: Date.now() }));
    // Machine-wide, so only in an unrestricted tick ({starting} lines carry no repo; files and processes are global).
    if (!repoKey) {
      const reg = V.readRegistry();
      // timeoutScan (or this tick's deferTimeout) printed the hold: never call its still-starting window dead.
      const held = (u) => Object.entries(ts.timedOut).some(([id, t]) => t.name === u.name && (t.group ?? null) === (u.group ?? null) && L.launchTimeoutPending(t, reg.lines, now, id));
      out.push(...V.untracked(reg, now).filter((u) => !held(u)).map(L.untrackedLine), ...housekeeping({ dryRun, cfg, now: Date.now() }));
    }
  } catch (err) { out.push(`tick failed: ${err?.stack || err}`); }
  finally { if (!dryRun) releaseTickLock(); }
  if (!out.length) out.push("tick: nothing to do");
  if (!dryRun) writeLastTick(out);
  return out;
}
