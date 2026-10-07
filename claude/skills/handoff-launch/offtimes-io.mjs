// Shabbat mode and the off table on disk. Kept small for the status line's hot path: it imports only
// live.mjs and the pure pace-lib.mjs. Files:
//   <coord>/shabbos.json  {enabled, changed_at, by_session}  coord.mjs shabbos writes it; missing or malformed = on
//   <skill>/offtimes.json  the generated table (HL_OFFTIMES_FILE: tests)
import fs from "node:fs";
import path from "node:path";
import { COORD, HERE, readJson } from "./live.mjs";
import { offStatus, offIntervals } from "./pace-lib.mjs";
export const SHABBOS = path.join(COORD, "shabbos.json");
export const OFFTIMES_FILE = path.resolve(process.env.HL_OFFTIMES_FILE || path.join(HERE, "offtimes.json"));
// The one reader of the switch (fail safe ON): off only when shabbos.json is an object whose enabled is exactly false.
export function shabbosEnabled() {
  let v; try { v = JSON.parse(fs.readFileSync(SHABBOS, "utf8")); } catch { return true; }
  return !(v && typeof v === "object" && !Array.isArray(v) && v.enabled === false);
}
// The off intervals now ([] for a missing, invalid or expired table, and while Shabbat mode is off).
export const readOffTimes = (now = Date.now()) => (shabbosEnabled() ? offIntervals(readJson(OFFTIMES_FILE, null), now) : []);
// The table's state for the tick's alerts; null while Shabbat mode is off.
export const offTimesStatus = (now = Date.now()) => (shabbosEnabled() ? offStatus(readJson(OFFTIMES_FILE, null), now) : null);
