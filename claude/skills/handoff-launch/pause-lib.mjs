// The one pause protocol (batch B, Parts 4-5): pause sources, the scope by priority, the pause close, the resume plan
// (cap, min_pause_min, probe resume) and the paused-session manifest. Pure: no fs, no clock, no processes; pause-io.mjs
// reads the files, recover.mjs and launch.mjs act (tests/pause-lib.test.mjs).
import { PAUSE_TEXT, aheadText, isEntry } from "./pace-lib.mjs";
import { byPriority } from "./lane-lib.mjs";

export { PAUSE_TEXT };
export const MIN = 60000;
export const BATTERY_FRESH_MS = 10 * MIN; // a battery source the power refresh has not rewritten for this long is off
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const localMin = (t) => new Date(t).toTimeString().slice(0, 5); // local HH:MM, as the pause was typed
// An `until` (ISO, or null = no end) still in the future.
const running = (o, now) => o.until == null || Date.parse(o.until) > now;

// ---------- sources ----------
// files: {manual: pause/manual.json, legacy: the old pause.json {until}, battery: pause/battery.json, pace: a FRESH
// pace.json (pace-lib paceFresh) or null}, each the parsed object or null. -> the active sources, [{source, reason,
// scope, since, windows}]; scope "all" pauses every lane, "normal-low" all but high. A manual or legacy file with an
// until in the past is inactive; a battery file older than 10 min is off (the refresh rewrites it while the battery is
// low); pace hold pauses normal and low lanes, exhausted every lane, unless paceOff is true.
export function activeSources({ manual = null, legacy = null, battery = null, pace = null, paceOff = false }, now) {
  const out = [];
  if (isObj(manual) && running(manual, now)) out.push({ source: "manual", reason: manual.until ? `manual pause until ${localMin(Date.parse(manual.until))}` : "manual pause", scope: "all", since: manual.at ?? null, windows: [], ends: Boolean(manual.until) });
  else if (isObj(legacy) && running(legacy, now)) out.push({ source: "manual", reason: legacy.until ? `manual pause until ${localMin(Date.parse(legacy.until))}` : "manual pause", scope: "all", since: legacy.at ?? null, windows: [], ends: Boolean(legacy.until) });
  if (isObj(battery) && Date.parse(battery.at) - now <= MIN && now - Date.parse(battery.at) <= BATTERY_FRESH_MS) out.push({ source: "battery", reason: `battery ${battery.pct ?? "?"}%`, scope: "all", since: battery.since ?? battery.at, windows: [] });
  const e = isEntry(pace?.claude) ? pace.claude : null;
  if (!paceOff && e && (e.state === "hold" || e.state === "exhausted")) {
    const windows = ["five_hour", "weekly"].filter((k) => ["hold", "exhausted"].includes(e.windows?.[k]?.state));
    out.push({ source: "pace", reason: `pace ${e.state} (${aheadText(e)})`, scope: e.state === "exhausted" ? "all" : "normal-low", since: Number.isFinite(e.since) ? new Date(e.since).toISOString() : null, windows });
  }
  return out;
}
// The one answer every hook uses: is a session of this priority paused now? A hand-opened session is "high".
// -> {paused, reason, source, windows, since} (since: when that source began, ISO or null)
export function pauseFor(priority, sources) {
  const s = (sources || []).find((x) => x.scope === "all" || (x.scope === "normal-low" && priority !== "high"));
  return s ? { paused: true, reason: s.reason, source: s.source, windows: s.windows, since: s.since ?? null, ends: s.ends !== false } : { paused: false, reason: null, source: null, windows: [], since: null };
}
// A lane writes a new {paused} line when it has none for this launch, or when its newest one predates the source that
// pauses it now (a second pause after a lifted one, the lane never closed meanwhile). prev: pausedLineOf's line or null.
// A line more than 1 min old is also stale when now (ms, optional) is given: a lane woken after it writes a fresh one.
export const pausedLineDue = (prev, pause, now) => !prev || (!!pause?.since && Date.parse(prev.at) < Date.parse(pause.since)) || (Number.isFinite(now) && now - Date.parse(prev.at) > MIN);

// ---------- {paused} lines, the pause close ----------
// The newest {paused} line of launch e, at or after its launch. B2's writer (coord.mjs markPaused) always writes `paused:
// <id>` and a string `source`: only such a line counts, by default. Before B2 {paused} lines were written by hand (no
// `source`, matched by NAME): they keep their stage-2 meaning, the loop-check exemption, for the one caller that passes
// { legacy: true } (recover.mjs pausedLine); no B2 path (pause close, resume, watcher, status) sees them.
export function pausedLineOf(lines, e, { legacy = false } = {}) {
  const t = Date.parse(e?.launched_at) || 0;
  let found = null;
  for (const o of lines || []) {
    if (!o || !o.paused || (Date.parse(o.at) || 0) < t) continue;
    if (legacy ? (o.paused === e.id || o.paused === e.name) : (o.paused === e.id && typeof o.source === "string")) found = o;
  }
  return found;
}
// Close a lane that wrote {paused} at pausedAt (ms)? pause: pauseFor's answer for its priority now; lastAt: its
// transcript's last record (ms; NaN: none). The {paused} line must be 1 min old. While its pause is active: close. Once
// it lifted: close (to relaunch it) only when the lane did nothing after its {paused} line (a minute's slack) - one the
// user typed into is left alone. -> {close, why}
export function pauseCloseDue({ pausedAt, pause, lastAt, now }) {
  if (!(now - pausedAt >= MIN)) return { close: false, why: "its {paused} line is under 1 min old" };
  if (pause?.paused) {
    // the lane must have done nothing after its line (a line of an earlier pause still closes an idle lane: hold -> exhausted)
    if (Number.isFinite(lastAt) && lastAt > pausedAt + MIN) return { close: false, why: "worked after its paused line" };
    return { close: true, why: `paused (${pause.reason})` };
  }
  if (!Number.isFinite(lastAt) || lastAt <= pausedAt + MIN) return { close: true, why: "paused, and its pause lifted: closed to relaunch" };
  return { close: false, why: "it worked after its {paused} line (resumed by hand)" };
}

// ---------- resuming ----------
const laneKey = (e) => `${e.repo}|${e.group ?? ""}|${e.name}`;
// The lanes waiting for a pause resume: per lane (repo, group, name) its newest launch entry, when that entry has a
// {paused} line and is closed, or gone (gone(e): liveness, asked only for such open entries). A lane with a launch in
// flight - a {starting} line of its name and group newer than that entry, under 5 min old (now: epoch ms) - is left
// out: a second relaunch would put two sessions in one worktree. closedAt: its {closed} line's time, else the {paused}
// line's.
// A {closed} record makes a lane pending only when it is a pause close (pause === true on that line); a lane closed
// for another reason is not. A lane gone without any {closed} line stays pending (reboot while paused). A lane whose
// session did anything after its {paused} line (activeAfter(e, line), the tick's check) is not pending either.
// -> [{e, line, closedAt}] in registry order
export const lanePauseKey = laneKey;
export function pausedLanes({ entries, lines, closed, gone = () => false, now, activeAfter = () => false }) {
  const newest = new Map();
  for (const e of entries || []) { const k = laneKey(e), cur = newest.get(k); if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(k, e); }
  const out = [];
  for (const e of newest.values()) {
    const line = pausedLineOf(lines, e);
    if (!line || activeAfter(e, line)) continue;
    const c = [...(lines || [])].reverse().find((o) => o.closed && o.id === e.id);
    if (closed.has(e.id) ? c?.pause !== true : !gone(e)) continue;
    const t = Date.parse(e.launched_at) || 0;
    if ((lines || []).some((o) => o && "starting" in o && o.name === e.name && (o.group ?? null) === (e.group ?? null) && Date.parse(o.at) > t && now - Date.parse(o.at) < 5 * MIN)) continue;
    out.push({ e, line, closedAt: Date.parse(c?.at) || Date.parse(line.at) || 0 });
  }
  return out;
}
// Probe resume (Part 4): a pace pause that ended on a stale 5-hour reading resumes one lane at a time until a fresh
// reading confirms. entry: pace.json's claude entry (or null); causes: the windows the pace pauses were for. A fresh
// 5-hour reading confirms; a 5-hour window that reset (no current reading) ends a pause caused by it alone.
export function needsProbe(entry, causes) {
  if (!entry) return true; // unknown pace is not a reset
  const basis = entry.windows?.five_hour?.basis ?? "none";
  if (basis === "fresh") return false;
  return !(basis === "none" && causes.length > 0 && causes.every((c) => c === "five_hour"));
}
// Back-off for a lane the pace keeps pausing: prior = the tick state's {n, at} of its last pace relaunch (or null).
// A {paused} line after that relaunch and within 6 h of it is a consecutive re-pause: n + 1; otherwise 1. The wait is
// min_pause_min x min(4, 2^(n-1)). -> n
export function repauseCount(prior, pausedAt) {
  const at = Number(prior?.at), n = Number(prior?.n);
  return Number.isFinite(at) && Number.isFinite(n) && pausedAt > at && pausedAt - at <= 6 * 60 * MIN ? n + 1 : 1;
}
export const minPauseFor = (n, cfg) => cfg.min_pause_min * Math.min(4, 2 ** (Math.max(1, n) - 1));
// The tick's resume step. pending: [{e, priority, source, windows, pausedAt, closedAt, minPause?}] (pausedLanes plus the
// lane's priority, its {paused} line's source and windows, and for a pace close its minutes of minimum pause, minPauseFor);
// pauseOf(priority): pauseFor now; pace: pace.json's claude entry or null; probe: the last probe {id, at} or null. cfg:
// max_resumes_per_tick, min_pause_min, probe_wait_min. Order: high -> normal -> low, then the oldest pause first.
// -> {relaunch: [item], wait: [{item, why}], probe, mode}
export function resumePlan({ pending, pauseOf, pace, now, cfg, probe = null }) {
  const wait = [], ready = [];
  for (const p of pending || []) {
    const q = pauseOf(p.priority), min = p.minPause ?? cfg.min_pause_min;
    if (q.paused) wait.push({ item: p, why: `its pause still applies (${q.reason})` });
    else if (p.source === "pace" && now - p.closedAt < min * MIN) wait.push({ item: p, why: `closed for pace ${Math.round((now - p.closedAt) / MIN)} min ago (minimum pause ${min} min)` });
    else ready.push(p);
  }
  const order = byPriority(ready, (p) => p.priority, (a, b) => a.pausedAt - b.pausedAt);
  const causes = [...new Set(order.filter((p) => p.source === "pace").flatMap((p) => p.windows || []))];
  if (!order.some((p) => p.source === "pace") || !needsProbe(pace, causes)) {
    const n = Math.max(0, Math.floor(cfg.max_resumes_per_tick));
    return { relaunch: order.slice(0, n), wait: [...wait, ...order.slice(n).map((item) => ({ item, why: `max_resumes_per_tick ${n}: next tick` }))], probe: null, mode: order.length ? "full" : "none" };
  }
  if (probe && now - probe.at < cfg.probe_wait_min * MIN) return { relaunch: [], wait: [...wait, ...order.map((item) => ({ item, why: `probe resume: waiting for a fresh reading after ${probe.id}` }))], probe, mode: "probe" };
  // One lane: the highest-priority window-mode lane (a bg session writes no status-line reading), else the first.
  const first = order.find((p) => p.e.mode !== "bg") ?? order[0];
  return { relaunch: [first], wait: [...wait, ...order.filter((p) => p !== first).map((item) => ({ item, why: "probe resume: one lane until a fresh reading confirms" }))], probe: { id: first.e.id, at: now }, mode: "probe" };
}

// ---------- the paused-session manifest (<coord>/paused.json; the tick is its only writer) ----------
export const HOW_TO_RESUME = (launchMjs) => `Automatic: the coordinator relaunches closed lanes when their pause ends. By hand: node ${launchMjs} resume --paused. Hand-opened sessions: claude --resume <session_id>.`;
// A lane's row (closed by the pause) or a hand-opened session's row (seen by the hooks while paused).
export const laneRow = (e, { priority, reason }) => ({ key: `lane:${laneKey(e)}`, name: e.name, repo: e.repo ?? null, group: e.group ?? null, generation: e.generation ?? null,
  session_id: e.session_id ?? null, cwd: e.worktree ?? null, branch: e.branch ?? null, handoff: e.handoff ?? null, priority, reason, closed: true });
export const handRow = (s) => ({ key: `hand:${s.session_id}`, name: `hand-opened ${String(s.session_id).slice(0, 8)}`, repo: null, group: null, generation: null,
  session_id: s.session_id, cwd: s.cwd ?? null, branch: null, handoff: null, priority: "high", reason: s.reason ?? null, closed: false });
// Upsert rows by key; a lane keeps only its newest generation (two sessions never share a worktree). manifest null: a
// new one, paused_at = now. -> the new manifest (the input is not changed)
export function upsertRows(manifest, rows, now, howToResume) {
  const m = isObj(manifest) && Array.isArray(manifest.sessions) ? { ...manifest, sessions: [...manifest.sessions] } : { paused_at: new Date(now).toISOString(), how_to_resume: howToResume, sessions: [] };
  for (const r of rows) {
    const i = m.sessions.findIndex((x) => x.key === r.key);
    if (i < 0) m.sessions.push(r);
    else if ((r.generation ?? 0) >= (m.sessions[i].generation ?? 0)) m.sessions[i] = { ...r, ...(m.sessions[i].generation === r.generation && m.sessions[i].resumed_at ? { resumed_at: m.sessions[i].resumed_at } : {}) };
  }
  return m;
}
// A closed lane row is resumed once its lane has a launch entry newer than the row's generation (the tick's relaunch,
// or one by hand). newestOf(row) -> that lane's newest entry or null. -> the new manifest
export function markResumed(manifest, newestOf) {
  if (!isObj(manifest) || !Array.isArray(manifest.sessions)) return manifest;
  return { ...manifest, sessions: manifest.sessions.map((r) => {
    if (!r.closed || r.resumed_at) return r;
    const n = newestOf(r);
    return n && (n.generation ?? 0) > (r.generation ?? 0) ? { ...r, resumed_at: n.launched_at } : r;
  }) };
}
// Archived when no source is active and every closed row has resumed_at (hand-opened rows go with it: their alert went out).
// done(row): a closed row without resumed_at that is finished anyway (resumed by hand, or given up on) - the tick's check.
export const archiveDue = (manifest, active, done = () => false) => isObj(manifest) && !active && (manifest.sessions || []).filter((r) => r.closed).every((r) => r.resumed_at || done(r));
// paused-<paused_at date>-<HHMM>.json (UTC)
export const archiveName = (manifest) => { const t = new Date(Date.parse(manifest?.paused_at) || 0).toISOString(); return `paused-${t.slice(0, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}.json`; };
// The phone alert for hand-opened sessions once the pause ends: they are never closed, so the user resumes them.
export const HAND_RESUME_TEXT = (rows) => `The pause ended. Hand-opened sessions to resume yourself: ${rows.map((r) => `claude --resume ${r.session_id}${r.cwd ? ` (in ${r.cwd})` : ""}`).join("; ")}`;
// The skip alert: a paused lane whose close was skipped for a reason other than "busy" on two ticks.
export const CLOSE_SKIPPED_TEXT = ({ name, why }) => `Paused lane ${name} could not be closed for two ticks: ${why}. Close it by hand once it has saved its state, or resume the pause.`;

// ---------- `coord.mjs pause` ----------
// [] -> null (no end); ["30m"] / ["2h"] -> now + that; ["until", "HH:MM"] -> the next local HH:MM (today, else tomorrow).
// -> {until: ISO|null} or {error}
export function parseUntil(args, now) {
  const a = (args || []).filter(Boolean);
  if (!a.length) return { until: null };
  const d = /^(\d+)(m|h)$/.exec(a[0]);
  if (d && a.length === 1 && Number(d[1]) > 0) { const u = new Date(now + Number(d[1]) * (d[2] === "h" ? 60 : 1) * MIN); if (Number.isFinite(u.getTime())) return { until: u.toISOString() }; }
  const t = a[0] === "until" && a.length === 2 ? /^(\d{1,2}):(\d{2})$/.exec(a[1]) : null;
  if (t && Number(t[1]) < 24 && Number(t[2]) < 60) {
    const x = new Date(now); x.setHours(Number(t[1]), Number(t[2]), 0, 0);
    if (x.getTime() <= now) x.setDate(x.getDate() + 1);
    return { until: x.toISOString() };
  }
  return { error: "pause takes nothing (no end), <n>m, <n>h, or until HH:MM" };
}
