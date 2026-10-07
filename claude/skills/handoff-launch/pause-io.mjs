// The pause sources on disk (batch B, Part 4). One file per source, each with a single writer, each written atomically:
//   <coord>/pause/manual.json  {until, by, at}  coord.mjs pause writes it, coord.mjs resume deletes it
//   <coord>/pause/battery.json {at, pct, ac}    only the power refresh (B3) writes or deletes it
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
import { activeSources, pauseFor as pauseForSources } from "./pause-lib.mjs";

export const PAUSE_DIR = path.join(COORD, "pause");
export const MANUAL = path.join(PAUSE_DIR, "manual.json");
export const BATTERY = path.join(PAUSE_DIR, "battery.json");
export const LEGACY = path.join(COORD, "pause.json");
export const SEEN_DIR = path.join(PAUSE_DIR, "seen");
export const TICK_STATE = path.join(PAUSE_DIR, "tick-state.json");
export const MANIFEST = path.join(COORD, "paused.json");
const plainId = (v) => typeof v === "string" && /^[\w-]+$/.test(v);
const paceCfg = () => { let t = null; try { t = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} return loadConfig(t).config.pace; };

// The active sources now (pause-lib activeSources over the files). -> [{source, reason, scope, since, windows}]
export function readSources(now = Date.now()) {
  return activeSources({ manual: readJson(MANUAL, null), legacy: readJson(LEGACY, null), battery: readJson(BATTERY, null),
    pace: paceFresh(readJson(path.join(COORD, "pace.json"), null), now, paceCfg()) }, now);
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
// Needed while a source is active over an open lane, or while a lane waits for its pause resume (nothing else wakes an
// idle machine: ticks come from hooks).
export const watchNeeded = ({ active, openLanes, pending }) => (active && openLanes > 0) || pending > 0;
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
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
export function readSeen() {
  let names = []; try { names = fs.readdirSync(SEEN_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  return names.map((f) => ({ ...readJson(path.join(SEEN_DIR, f), {}), file: path.join(SEEN_DIR, f) })).filter((s) => plainId(s.session_id));
}
