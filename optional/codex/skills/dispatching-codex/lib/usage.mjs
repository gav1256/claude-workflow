// Codex usage reader: finds a run's rollout, extracts the last rate_limits event, maps the windows,
// writes the pacer's usage file and decides run/downgrade/block (spec Part 2 step 5, Part 5).
import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME, USAGE_DIR, LAST_USAGE, atomicWriteJson } from "./paths.mjs";

const DAY_MS = 86400000;
const KEEP = 20;
const TAIL_BYTES = 1024 * 1024;

const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now());

function dayDir(ms) {
  const d = new Date(ms).toISOString().slice(0, 10).split("-");
  return path.join(CODEX_HOME, "sessions", d[0], d[1], d[2]);
}

/** CODEX_HOME/sessions/YYYY/MM/DD (UTC today, then yesterday)/rollout-*-<threadId>.jsonl, or null. */
export function findRollout(threadId, now = Date.now()) {
  if (typeof threadId !== "string" || !threadId || /[\\/]/.test(threadId)) return null;
  const t = toMs(now);
  const suffix = `-${threadId}.jsonl`;
  for (const ms of [t, t - DAY_MS]) {
    const dir = dayDir(ms);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const hit = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

function scanLines(text, fallbackTs) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const p = ev && ev.type === "event_msg" ? ev.payload : null;
    if (!p || p.type !== "token_count" || !p.rate_limits || typeof p.rate_limits !== "object") continue;
    const parsed = Date.parse(ev.timestamp);
    return { ts: Number.isFinite(parsed) ? parsed : Math.round(fallbackTs), rl: p.rate_limits };
  }
  return null;
}

/** Tail-first: the newest token_count event carrying rate_limits. ts = epoch ms of that event. */
export function lastRateLimits(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    let r = scanLines(buf.toString("utf8"), st.mtimeMs);
    if (!r && st.size > len) {
      const all = Buffer.alloc(st.size);
      fs.readSync(fd, all, 0, st.size, 0);
      r = scanLines(all.toString("utf8"), st.mtimeMs);
    }
    return r;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** window_minutes 300 = 5 h, 10080 = week. A weekly-only provider has pct null. */
export function mapWindows(rl) {
  const out = { pct: null, resets_at: null, week_pct: null, week_resets_at: null };
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w || typeof w !== "object") continue;
    if (w.window_minutes === 300) { out.pct = num(w.used_percent); out.resets_at = num(w.resets_at); }
    else if (w.window_minutes === 10080) { out.week_pct = num(w.used_percent); out.week_resets_at = num(w.resets_at); }
  }
  return out;
}

/** USAGE_DIR/codex-<runId>.json for the pacer; keeps the newest 20 codex-* files; LAST_USAGE = last reading. */
export function recordUsage(runId, reading) {
  if (!reading || !reading.rl) return;
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  atomicWriteJson(path.join(USAGE_DIR, `codex-${runId}.json`), { ts: reading.ts, provider: "codex", ...mapWindows(reading.rl) });
  atomicWriteJson(LAST_USAGE, { ts: reading.ts, rate_limits: reading.rl });
  const files = fs.readdirSync(USAGE_DIR)
    .filter((n) => /^codex-.*\.json$/.test(n))
    .map((n) => ({ n, m: fs.statSync(path.join(USAGE_DIR, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m || (a.n < b.n ? 1 : -1));
  for (const f of files.slice(KEEP)) fs.rmSync(path.join(USAGE_DIR, f.n), { force: true });
}

function listRollouts(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listRollouts(p, out);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/** Newest valid rate_limits event across rollouts modified in the last 8 days; else LAST_USAGE; else null. */
export function latestReading(now = Date.now()) {
  const t = toMs(now);
  const files = [];
  listRollouts(path.join(CODEX_HOME, "sessions"), files);
  let best = null;
  for (const f of files) {
    let m;
    try { m = fs.statSync(f).mtimeMs; } catch { continue; }
    if (t - m > 8 * DAY_MS) continue;
    const r = lastRateLimits(f);
    if (r && (!best || r.ts > best.ts)) best = r;
  }
  if (best) return best;
  try {
    const l = JSON.parse(fs.readFileSync(LAST_USAGE, "utf8"));
    if (l && l.rate_limits && typeof l.ts === "number") return { ts: l.ts, rl: l.rate_limits };
  } catch { /* none */ }
  return null;
}

/**
 * Spec Part 5. block: reached-type with a future resets_at (the earliest future window, so the
 * controller rechecks soonest), or effective week >= 95. downgrade: effective >= 85, write mode on sol.
 * A window past its resets_at counts 0.
 */
export function quotaDecision({ reading, now = Date.now(), busySlots = 0, mode, model }) {
  const t = toMs(now);
  const notes = [];
  if (!reading || !reading.rl) return { action: "run", notes: ["codex-quota-unknown"] };
  const rl = reading.rl;
  const mw = mapWindows(rl);
  const iso = (s) => new Date(s * 1000).toISOString();
  const future = [mw.resets_at, mw.week_resets_at].filter((s) => s !== null && s * 1000 > t).sort((a, b) => a - b);
  if (rl.rate_limit_reached_type && future.length) {
    return { action: "block", reason: `codex-quota ${iso(future[0])}`, notes };
  }
  if (typeof reading.ts === "number" && t - reading.ts > 6 * 3600000) notes.push("codex-quota-stale");
  if (mw.week_resets_at === null) {
    notes.push("codex-quota-unknown");
    return { action: "run", notes };
  }
  const base = mw.week_resets_at * 1000 <= t ? 0 : (mw.week_pct ?? 0);
  const eff = base + 2 * busySlots;
  if (eff >= 95) return { action: "block", reason: `codex-quota ${iso(mw.week_resets_at)}`, notes };
  if (eff >= 85 && mode === "write" && model === "sol") {
    return { action: "downgrade", reason: `week-pct ${eff}`, notes };
  }
  return { action: "run", notes };
}

/** Sum of turn.completed.usage over a --json events file. */
export function codexTokens(eventsFile) {
  const sum = { in: 0, cached: 0, out: 0 };
  let text;
  try { text = fs.readFileSync(eventsFile, "utf8"); } catch { return sum; }
  for (const line of text.split("\n")) {
    if (!line.includes("turn.completed")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type !== "turn.completed" || !ev.usage) continue;
      sum.in += num(ev.usage.input_tokens) ?? 0;
      sum.cached += num(ev.usage.cached_input_tokens) ?? 0;
      sum.out += num(ev.usage.output_tokens) ?? 0;
    } catch { /* skip */ }
  }
  return sum;
}
