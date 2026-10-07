// `codex-run --status`: one line, never throws. Codex usage from LAST_USAGE (mapWindows), Claude usage from the
// pacer's PACE file (contract: {updated (epoch s), claude:{state,pct,ahead,resets_at,week_pct,week_resets_at}}),
// ignored when older than 15 minutes; plus any quarantined slots (plan A7).
import fs from "node:fs";
import path from "node:path";
import { LAST_USAGE, PACE, SLOT_LOCKS } from "./paths.mjs";
import { mapWindows } from "./usage.mjs";
import { readRecord, quarantine } from "./locks.mjs";

const PACE_MAX_AGE_S = 15 * 60;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** A window past its resets_at counts 0; null stays null. */
const eff = (pct, resetsAt, nowS) => (!isNum(pct) ? null : isNum(resetsAt) && resetsAt <= nowS ? 0 : pct);
const p2 = (n) => String(n).padStart(2, "0");
const resetText = (s) => {
  const d = new Date(s * 1000);
  return `${DAYS[d.getDay()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

function codexPart(nowS) {
  const u = readJson(LAST_USAGE);
  if (!u || typeof u !== "object" || !u.rate_limits) return "codex: no reading";
  const w = mapWindows(u.rate_limits);
  const week = eff(w.week_pct, w.week_resets_at, nowS);
  if (week !== null) {
    return `codex week ${week}%` + (isNum(w.week_resets_at) ? ` (resets ${resetText(w.week_resets_at)})` : "");
  }
  const h5 = eff(w.pct, w.resets_at, nowS);
  if (h5 !== null) return `codex 5h ${h5}%` + (isNum(w.resets_at) ? ` (resets ${resetText(w.resets_at)})` : "");
  return "codex: no reading";
}

function claudePart(nowS) {
  const p = readJson(PACE);
  if (!p || typeof p !== "object" || !isNum(p.updated) || nowS - p.updated > PACE_MAX_AGE_S) return "claude: no reading";
  const c = p.claude;
  if (!c || typeof c !== "object") return "claude: no reading";
  const h5 = eff(c.pct, c.resets_at, nowS);
  const week = eff(c.week_pct, c.week_resets_at, nowS);
  const parts = [];
  if (h5 !== null) parts.push(`5h ${h5}%`);
  if (week !== null) parts.push(`week ${week}%`);
  return parts.length ? `claude ${parts.join(" ")}` : "claude: no reading";
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** Slot records that need `--clear-quarantine` (or will on the next acquire): not clean, and no live owner. */
function quarantinedSlots() {
  const out = [];
  for (const n of [1, 2, 3]) {
    try {
      const r = readRecord(path.join(SLOT_LOCKS, `${n}.json`));
      const q = quarantine({ kind: "slot", ...r });
      if (q.verdict === "no-record" || q.verdict === "clean") continue;
      if (!r.prevError && !r.halfWritten && r.prev && Number.isInteger(r.prev.owner_pid) && alive(r.prev.owner_pid)) continue;
      out.push(`slot ${n} (${typeof r.prev?.run_id === "string" ? r.prev.run_id : "?"})`);
    } catch { /* an unreadable record is not worth a crash */ }
  }
  return out;
}

export function statusLine() {
  const nowS = Date.now() / 1000;
  const parts = [];
  for (const f of [codexPart, claudePart]) {
    try { parts.push(f(nowS)); } catch { parts.push(f === codexPart ? "codex: no reading" : "claude: no reading"); }
  }
  const q = quarantinedSlots();
  if (q.length) parts.push(`quarantined: ${q.join(", ")}`);
  return parts.join(" · ");
}
