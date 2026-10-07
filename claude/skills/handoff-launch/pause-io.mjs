// The pause sources on disk (batch B, Part 4). One file per source, each with a single writer, each written atomically:
//   <coord>/pause/manual.json  {until, by, at}  coord.mjs pause writes it, coord.mjs resume deletes it
//   <coord>/pause/battery.json {at, since, pct, ac}    only the power refresh (B3) writes or deletes it
//   <coord>/pause/pace-off.json {at, by}       coord.mjs usage-pause writes/removes the usage pause switch
//   <coord>/pause/resume-request.json {at, enabled}  only coord.mjs resume writes it
//   pace                       not stored: derived from a fresh pace.json (Claude hold or exhausted)
//   <coord>/pause.json         the old {until} shape, still read as a manual source; coord.mjs resume deletes it
// Also: pause/seen/<session_id>.json (a hand-opened session the hooks saw while paused; that session writes its own),
// pause/tick-state.json (the tick's skip counts and probe; the tick writes it) and paused.json (the manifest; the tick
// is its only writer). The decisions are pause-lib.mjs's.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { COORD, COORD_MJS, readJson, writeAtomic, pidAlive, procInfo, selfStart, launcherEnv } from "./live.mjs";
import { loadConfig } from "./recover-lib.mjs";
import { paceFresh } from "./pace-lib.mjs";
import { activeSources, pauseFor as pauseForSources, BATTERY_FRESH_MS } from "./pause-lib.mjs";
import { probePower, lowBattery } from "./power.mjs";
import { SHABBOS, shabbosEnabled, readOffTimes } from "./offtimes-io.mjs";
export { SHABBOS, shabbosEnabled, OFFTIMES_FILE, readOffTimes, offTimesStatus } from "./offtimes-io.mjs";

export const PAUSE_DIR = path.join(COORD, "pause");
export const MANUAL = path.join(PAUSE_DIR, "manual.json");
export const BATTERY = path.join(PAUSE_DIR, "battery.json");
export const PACE_OFF = path.join(PAUSE_DIR, "pace-off.json");
export const RESUME_REQUEST = path.join(PAUSE_DIR, "resume-request.json");
export const usagePauseOff = () => fs.existsSync(PACE_OFF);
export const LEGACY = path.join(COORD, "pause.json");
export const SEEN_DIR = path.join(PAUSE_DIR, "seen");
export const TICK_STATE = path.join(PAUSE_DIR, "tick-state.json");
export const MANIFEST = path.join(COORD, "paused.json");
const plainId = (v) => typeof v === "string" && /^[\w-]+$/.test(v);
const coordCfg = () => { let t = null; try { t = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} return loadConfig(t).config; };
const paceCfg = () => coordCfg().pace;

// The active sources now (pause-lib activeSources over the files). -> [{source, reason, scope, since, windows}]
export function readSources(now = Date.now()) {
  return activeSources({ manual: readJson(MANUAL, null), legacy: readJson(LEGACY, null), battery: readJson(BATTERY, null),
    pace: paceFresh(readJson(path.join(COORD, "pace.json"), null), now, paceCfg()), paceOff: usagePauseOff(), off: readOffTimes(now) }, now);
}
// Any source active (the stage-2 meaning of pauseActive, now over every source).
export const pauseActive = (now = Date.now()) => readSources(now).length > 0;
// Is a session of this priority paused now (the files read now; pause-lib pauseFor decides)? -> {paused, reason, source,
// windows, since}
export const pauseForNow = (priority, now = Date.now()) => pauseForSources(priority, readSources(now));
// A rename or delete that a concurrent writer or a scanner holds open fails on Windows (EPERM/EACCES/EBUSY): retry up to
// 5 times with a short synchronous backoff (20-100 ms), then rethrow.
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
function retried(fn) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 5 || !BUSY.has(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * i);
    }
  }
}
// coord.mjs pause: the manual source (its one writer). -> the file
// A manual pause already running keeps its start (`at`, the pause's since): pausing again only changes until/by.
export function writeManual({ until, by }, now = Date.now()) {
  const prev = readJson(MANUAL, null), running = prev && typeof prev === "object" && (prev.until == null || Date.parse(prev.until) > now) && Number.isFinite(Date.parse(prev.at));
  const text = JSON.stringify({ until, by, at: running ? prev.at : new Date(now).toISOString() }, null, 2);
  retried(() => writeAtomic(MANUAL, text));
  return MANUAL;
}
// coord.mjs resume: the manual source and the legacy pause.json go. -> the paths removed
export function clearManual() {
  return [MANUAL, LEGACY].filter((f) => { if (!fs.existsSync(f)) return false; retried(() => fs.rmSync(f, { force: true })); return true; });
}
// coord.mjs resume, its one writer: epoch ms and the switch as it was when the user asked.
export function writeResumeRequest(now = Date.now()) {
  const req = { at: now, enabled: shabbosEnabled() };
  retried(() => writeAtomic(RESUME_REQUEST, JSON.stringify(req, null, 2)));
  return req;
}
export function readResumeRequest() {
  const req = readJson(RESUME_REQUEST, null);
  return Number.isFinite(req?.at) ? { at: req.at, enabled: req.enabled } : null;
}
// coord.mjs usage-pause: presence disables only the usage pause; readings remain unchanged.
export function writeUsagePause({ off, by }, now = Date.now()) {
  if (off) {
    if (usagePauseOff() && fs.statSync(PACE_OFF).isFile()) return;
    retried(() => writeAtomic(PACE_OFF, JSON.stringify({ at: new Date(now).toISOString(), by }, null, 2)));
  }
  else if (usagePauseOff()) retried(() => fs.rmSync(PACE_OFF, { force: true }));
}
// coord.mjs shabbos on|off, its one writer: a toggle rewrites, never deletes; the last write wins. -> the file
export function writeShabbos({ enabled, by }, now = Date.now()) {
  retried(() => writeAtomic(SHABBOS, JSON.stringify({ enabled: enabled === true, changed_at: now, by_session: by }, null, 2)));
  return SHABBOS;
}
// A hand-opened session seen paused by a hook: its own file, so writers never race. -> the file, or null
export function recordSeen({ session_id, cwd = null, reason }, now = Date.now()) {
  if (!plainId(session_id)) return null;
  const f = path.join(SEEN_DIR, `${session_id}.json`);
  if (fs.existsSync(f)) return f;
  writeAtomic(f, JSON.stringify({ session_id, cwd, reason, at: new Date(now).toISOString() }));
  return f;
}
// ---------- the watcher's lock and start (coord.mjs watch; the tick starts it) ----------
export const WATCH_LOCK = path.join(COORD, "watch.lock");
export const WATCH_START = path.join(COORD, "watch-start.json");
// The watcher holding watch.lock while it still runs: its pid is alive and, on Windows, a node process that started
// within 2 s of the lock's start (a reused pid is not it). A failed probe is no answer: the holder counts as running
// (never two watchers on a guess). -> the lock {pid, start, at}, or null
export function watchHolder() {
  const h = readJson(WATCH_LOCK, null);
  if (!h) { // unreadable: a watcher may be writing it this instant - a fresh file is held (as tick.lock), an old one is junk
    let age = Infinity; try { age = Date.now() - fs.statSync(WATCH_LOCK).mtimeMs; } catch {}
    return age < 10000 ? { pid: null, start: null, at: null, unreadable: true } : null;
  }
  if (!Number.isInteger(h.pid) || !pidAlive(h.pid)) return null;
  if (process.platform !== "win32" || !h.start) return h;
  const p = procInfo([h.pid])?.get(h.pid);
  if (!p) return h;
  if (p.name === "DEAD" || !/^node$/i.test(p.name)) return null;
  if (!p.start) return h; // a start time that cannot be read is no answer: held, never dead on a guess
  return Math.abs(Date.parse(p.start) - Date.parse(h.start)) <= 2000 ? h : null;
}
// Is <h> (a watchHolder answer) verifiably the watcher process? Only then may --stop kill it: the lock has a start time
// and, on Windows, the process is node with a start time within 2 s of it (never a kill on the pid alone).
export function watchVerified(h) {
  if (!h || !Number.isInteger(h.pid) || !h.start || !Number.isFinite(Date.parse(h.start))) return false;
  if (process.platform !== "win32") return true;
  const p = procInfo([h.pid])?.get(h.pid);
  return !!p && p.name !== "DEAD" && /^node$/i.test(p.name) && !!p.start && Math.abs(Date.parse(p.start) - Date.parse(h.start)) <= 2000;
}
// Exclusive create (wx, as tick.lock), so exactly one watcher wins. A lock whose holder is gone is moved aside and
// removed - only the one judged dead here: if another watcher replaced it meanwhile, it is put back. -> bool
export function takeWatchLock() {
  fs.mkdirSync(COORD, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(WATCH_LOCK, JSON.stringify({ pid: process.pid, start: selfStart(), at: new Date().toISOString() }), { flag: "wx" }); return true; }
    catch (e) { if (e.code !== "EEXIST") return false; }
    const held = readJson(WATCH_LOCK, null);
    if (watchHolder()) return false;
    const aside = `${WATCH_LOCK}.reclaimed-${process.pid}`;
    try { fs.renameSync(WATCH_LOCK, aside); } catch { continue; }
    if (JSON.stringify(readJson(aside, null)) === JSON.stringify(held)) fs.rmSync(aside, { force: true });
    else { try { fs.renameSync(aside, WATCH_LOCK); } catch {} return false; }
  }
  return false;
}
export const releaseWatchLock = () => { try { if (readJson(WATCH_LOCK, {})?.pid === process.pid) fs.rmSync(WATCH_LOCK, { force: true }); } catch {} };
// Needed while a source is active or off-time is near over an open lane, or while a lane can resume without a user
// request (nothing else wakes an idle machine: ticks come from hooks).
export const watchNeeded = ({ active, openLanes, pending, offSoon = false }) => ((active || offSoon) && openLanes > 0) || pending > 0;
// Start the hidden, detached watcher (`coord.mjs watch`) unless one runs, or one was started in the last minute (a
// watcher that dies at its start is not respawned more than once a minute). HL_NO_SPAWN records the start, spawns
// nothing. -> "running" | "recent" | "started" | "recorded" | "failed"
export function ensureWatcher(by, now = Date.now()) {
  if (watchHolder()) return "running";
  const last = Date.parse(readJson(WATCH_START, {})?.at);
  if (last <= now && now - last < 60000) return "recent";
  try {
    writeAtomic(WATCH_START, JSON.stringify({ at: new Date(now).toISOString(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return "recorded";
    spawn(process.execPath, [COORD_MJS, "watch"], { detached: true, stdio: "ignore", windowsHide: true, env: launcherEnv() }).on("error", () => {}).unref();
    return "started";
  } catch { return "failed"; }
}
// ---------- Part 7 (B3): the power refresh, the battery source's one writer ----------
export const POWER = path.join(COORD, "power.json");
export const POWER_CLAIM = path.join(COORD, "power-claim.json");
// power.json is stale after 60 s - an hour only after a successful no-battery reading.
export function powerStale(now = Date.now()) {
  const j = readJson(POWER, null), at = Date.parse(j?.at);
  return !(now - at < (!j?.failed && j?.battery === false ? 3600e3 : 60000) && at <= now);
}
// The probe (power.mjs), cached in power.json {at, battery, pct, ac}; a low battery (battery_pct, not on AC) writes the
// battery source {at, since, pct, ac} (since kept while the source is fresh); a successful non-low reading removes it.
// Failure is cached for 60 s and leaves battery.json untouched: it ages out after 10 min. Three callers run this one
// code path: the hooks' detached refresh, tick and watcher. Whole-file atomic renames never mix fields; a stored newer
// at less than 60 s ahead skips this reading's writes; further ahead is stale (this check does not serialize concurrent refreshes).
// -> {power, low, changed}: changed - the battery source appeared, went or began a new spell
export function refreshPower(now = Date.now()) {
  const p = probePower(), low = lowBattery(p, coordCfg().battery_pct), prev = readJson(BATTERY, null), at = new Date(now).toISOString();
  if ([readJson(POWER, null)?.at, prev?.at].some((at) => Date.parse(at) > now && Date.parse(at) - now < 60000)) return { power: p, low, changed: false };
  const had = !!prev && Date.parse(prev.at) - now < 60000 && now - Date.parse(prev.at) <= BATTERY_FRESH_MS;
  retried(() => writeAtomic(POWER, JSON.stringify({ at, ...p })));
  if (p.failed) return { power: p, low: false, changed: false };
  if (low) retried(() => writeAtomic(BATTERY, JSON.stringify({ at, since: had ? prev.since ?? prev.at : at, pct: p.pct, ac: p.ac })));
  else retried(() => fs.rmSync(BATTERY, { force: true }));
  return { power: p, low, changed: had !== low };
}
// The hooks only read the cache: when it is stale, claim the refresh in power-claim.json (about once a minute) and
// start `coord.mjs power --refresh` hidden and detached (the triggerTick pattern; HL_NO_SPAWN: the claim only). Never
// throws. -> true when a refresh was claimed
export function triggerPowerRefresh(by, now = Date.now()) {
  try {
    if (!powerStale(now)) return false;
    const last = Date.parse(readJson(POWER_CLAIM, {})?.at);
    if (last <= now && now - last < 60000) return false;
    writeAtomic(POWER_CLAIM, JSON.stringify({ at: new Date(now).toISOString(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return true;
    spawn(process.execPath, [COORD_MJS, "power", "--refresh"], { detached: true, stdio: "ignore", windowsHide: true, env: launcherEnv() }).on("error", () => {}).unref();
    return true;
  } catch { return false; }
}
export const powerText = (p) => (p.failed ? "probe failed (battery state unchanged)" : !p.battery ? "no battery (never pauses)" : `battery ${p.pct ?? "?"}% ${p.ac === true ? "on AC" : p.ac === false ? "on battery" : "AC unknown"}`);
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
export function readSeen() {
  let names = []; try { names = fs.readdirSync(SEEN_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  return names.map((f) => ({ ...readJson(path.join(SEEN_DIR, f), {}), file: path.join(SEEN_DIR, f) })).filter((s) => plainId(s.session_id));
}
