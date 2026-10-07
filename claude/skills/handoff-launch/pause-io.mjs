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
import { COORD, readJson, writeAtomic } from "./live.mjs";
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
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
export function readSeen() {
  let names = []; try { names = fs.readdirSync(SEEN_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  return names.map((f) => ({ ...readJson(path.join(SEEN_DIR, f), {}), file: path.join(SEEN_DIR, f) })).filter((s) => plainId(s.session_id));
}
