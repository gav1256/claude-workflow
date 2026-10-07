// Usage readings and pace.json on disk (batch B, Parts 1-2). The status-line recorder (hooks/coord.mjs statusline), the
// tick (recover.mjs) and `coord.mjs pace` call these; the decisions are pace-lib.mjs's. Files, all under <coord>:
//   usage/<session_id>.json   one Claude session's newest reading (its status line writes it)
//   usage/codex-<run-id>.json a Codex run's reading (the codex-dual adapter writes it; Codex keeps its newest 20)
//   pace.json                 {updated, <provider>: {...}} (writeAtomic: two writers at once leave one whole file)
//   pace-seen/<session_id>    the `since` of the pace state this session was last told about (the Agent gate)
import fs from "node:fs";
import path from "node:path";
import { COORD, readJson, writeAtomic } from "./live.mjs";
import { paceState, sameReading, PACE_DEFAULTS } from "./pace-lib.mjs";
import { readOffTimes } from "./offtimes-io.mjs";
export { readOffTimes, offTimesStatus } from "./offtimes-io.mjs";

export const USAGE_DIR = path.join(COORD, "usage");
export const PACE_FILE = path.join(COORD, "pace.json");
export const SEEN_DIR = path.join(COORD, "pace-seen");
export const KEEP_USAGE_MS = 8 * 24 * 3600e3; // Claude readings and pace-seen markers older than this are pruned
const plainId = (v) => typeof v === "string" && /^[\w-]+$/.test(v);

// Every reading in usage/ (an unreadable file, or one without a numeric ts, is skipped). -> [{...reading, file}]
export function readReadings(dir = USAGE_DIR) {
  let names = []; try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) { const r = readJson(path.join(dir, f), null); if (r && !Array.isArray(r) && Number.isFinite(r.ts)) out.push({ ...r, file: f }); }
  return out;
}
// Write one Claude session's reading, unless the file holds the same values and is under unchanged_s old.
// -> "written" | "unchanged" | "skipped" (the session id is not a plain id: it names a file)
export function recordReading(sid, reading, now, cfg = PACE_DEFAULTS) {
  if (!plainId(sid) || !reading) return "skipped";
  const f = path.join(USAGE_DIR, `${sid}.json`);
  if (sameReading(reading, readJson(f, null), now, cfg)) return "unchanged";
  writeAtomic(f, JSON.stringify(reading));
  return "written";
}
// pace.json recomputed from usage/ unless the current one is younger than minAgeMs (0: always). write false: compute
// only (a dry run, `coord.mjs pace`). -> {pace, prev, written}
export function recomputePace({ now = Date.now(), cfg = PACE_DEFAULTS, minAgeMs = 0, write = true, off = undefined } = {}) {
  const prev = readJson(PACE_FILE, null);
  const age = prev && Number.isFinite(prev.updated) ? now - prev.updated : Infinity;
  if (age >= 0 && age < minAgeMs) return { pace: prev, prev, written: false };
  const pace = { updated: now, ...paceState({ readings: readReadings(), prev, now, cfg, off: off ?? readOffTimes(now) }) };
  if (write) writeAtomic(PACE_FILE, JSON.stringify(pace, null, 2));
  return { pace, prev, written: write };
}
// Housekeeping (the tick's hourly prune): Claude readings (usage/<sid>.json, never codex-*) whose ts is older than 8
// days or more than 1 h in the future, or that are corrupt (unparsable); and pace-seen markers whose mtime is old. -> the paths
export function staleUsageFiles(now) {
  const old = (f) => { try { return now - fs.statSync(f).mtimeMs > KEEP_USAGE_MS; } catch { return false; } };
  const readings = readReadings().filter((r) => !r.file.startsWith("codex-") && (now - r.ts > KEEP_USAGE_MS || r.ts - now > 3600e3)).map((r) => path.join(USAGE_DIR, r.file));
  let names = []; try { names = fs.readdirSync(USAGE_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("codex-")); } catch {}
  // corrupt: a JSON parse error or a non-object value; a read error (EBUSY, EPERM: a file another process holds) is not corrupt
  const corrupt = names.filter((f) => { let t; try { t = fs.readFileSync(path.join(USAGE_DIR, f), "utf8"); } catch { return false; } try { const v = JSON.parse(t); return !v || typeof v !== "object" || Array.isArray(v); } catch { return true; } }).map((f) => path.join(USAGE_DIR, f));
  let seen = []; try { seen = fs.readdirSync(SEEN_DIR).map((f) => path.join(SEEN_DIR, f)).filter(old); } catch {}
  return [...readings, ...corrupt, ...seen];
}
