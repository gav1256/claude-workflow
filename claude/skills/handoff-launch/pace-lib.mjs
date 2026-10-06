// Usage pacing (batch B, Parts 1-3): the pure pacer, the status line's text, the Agent gate's decision and the texts.
// No fs, no clock, no processes: callers pass the readings, the previous pace.json and `now` in (tests/pace-lib.test.mjs).
// Units: a reading's ts and pace.json's updated/since are epoch ms; resets_at/week_resets_at are epoch seconds.
export const MIN = 60000;
export const STATES = Object.freeze(["ok", "slow", "hold", "exhausted"]);
const RANK = { ok: 0, slow: 1, hold: 2, exhausted: 3 };
// The more severe of two states (an unknown word counts as ok).
export const worse = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);
// <coord>/config.json "pace": {...}; every key a positive number. Thresholds of the spec's band table, the pace lines,
// the freshness rules and the recorder's timers.
export const PACE_DEFAULTS = Object.freeze({
  pace_target: 95, pace_floor: 10, week_grace_min: 720,
  slow_enter: 10, slow_leave: 5, hold_enter: 20, hold_leave: 15, exhausted_pct: 95,
  week_slow_enter: 5, week_slow_leave: 2, week_slow_pct: 90, week_hold_enter: 10, week_hold_leave: 7, week_exhausted_pct: 97,
  fresh_min: 10, week_fresh_min: 360, stale_min: 15, recompute_s: 30, unchanged_s: 60,
});
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// config.json's "pace" value -> {pace, errors}: unknown keys and bad values are reported and ignored (loadConfig's rule).
export function paceConfig(v) {
  const pace = { ...PACE_DEFAULTS }, errors = [];
  if (v === undefined) return { pace, errors };
  if (!isObj(v)) return { pace, errors: ["pace must be a JSON object"] };
  for (const [k, x] of Object.entries(v)) {
    if (!(k in PACE_DEFAULTS)) errors.push(`unknown key pace.${k}`);
    else if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) errors.push(`pace.${k} must be a positive number`);
    else pace[k] = x;
  }
  // hysteresis: every *_leave must stay below its *_enter, else the pair is reported and reset to its defaults
  for (const [lo, hi] of [["slow_leave", "slow_enter"], ["hold_leave", "hold_enter"], ["week_slow_leave", "week_slow_enter"], ["week_hold_leave", "week_hold_enter"]]) {
    if (pace[lo] >= pace[hi]) { errors.push(`pace.${lo} must be below pace.${hi}`); pace[lo] = PACE_DEFAULTS[lo]; pace[hi] = PACE_DEFAULTS[hi]; }
  }
  return { pace, errors };
}

// ---------- readings ----------
// A reset time in any of the shapes a source may give -> epoch seconds, or null. A number above 1e12 is epoch ms; a
// numeric string is read as a number; any other string as a date.
export function toEpochS(v) {
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); if (Number.isFinite(n)) return toEpochS(n); const t = Date.parse(v); return Number.isFinite(t) ? Math.round(t / 1000) : null; }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
}
// A used percentage -> 0-100, or null.
export function pctOf(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(100, n) : null;
}
// One window of the status line's rate_limits -> [pct, resets_at], both null when either is missing.
const windowOf = (w) => { const p = pctOf(w?.used_percentage), t = toEpochS(w?.resets_at); return p === null || t === null ? [null, null] : [p, t]; };
// The status line's stdin (rate_limits.five_hour / seven_day {used_percentage, resets_at}) -> a usage reading, or null
// when there is none to record: no rate_limits (not Pro/Max, or before the first API response), or neither window usable.
export function readingFromStatus(input, now) {
  const rl = input?.rate_limits;
  if (!isObj(rl)) return null;
  const [pct, resets_at] = windowOf(rl.five_hour), [week_pct, week_resets_at] = windowOf(rl.seven_day);
  if (pct === null && week_pct === null) return null;
  return { ts: now, provider: "claude", pct, resets_at, week_pct, week_resets_at };
}
// The recorder skips a write when the file holds the same values and is under unchanged_s old.
export function sameReading(r, file, now, cfg = PACE_DEFAULTS) {
  if (!r || !isObj(file) || !Number.isFinite(file.ts) || !(now - file.ts < cfg.unchanged_s * 1000)) return false;
  return ["pct", "resets_at", "week_pct", "week_resets_at"].every((k) => (r[k] ?? null) === (file[k] ?? null));
}

// ---------- the pacer ----------
const round1 = (x) => Math.round(x * 10) / 10;
// The newest reading whose window (its reset, epoch s, under tk) is still in the future, or null. A reading stamped more
// than a minute in the future (the clock moved back since it was written) is skipped: it would shadow every newer one.
function newest(rs, pk, tk, now) {
  let best = null;
  for (const r of rs) if (Number.isFinite(r[pk]) && Number.isFinite(r[tk]) && r[tk] * 1000 > now && r.ts <= now + MIN && (!best || r.ts > best.ts)) best = r;
  return best;
}
// One window's next state from its previous one (hysteresis per window). Entering slow or hold needs a fresh reading;
// staying, leaving and exhausted read the newest reading of the window even when stale (pct never falls inside a window).
function band(prev, fresh, t) {
  if (prev === "exhausted" || t.exhaust) return "exhausted";
  if (fresh && t.enterHold) return "hold";
  if (prev === "hold" && t.keepHold) return "hold";
  if (fresh && t.enterSlow) return "slow";
  if ((prev === "hold" || prev === "slow") && t.keepSlow) return "slow";
  return "ok";
}
// A pace.json provider entry (an object with a state word); `updated` and anything else is not one.
export const isEntry = (v) => isObj(v) && typeof v.state === "string";
// The previous state of one window: the previous pace.json's windows.<k>.state (missing = ok); a window whose reset has
// passed ends its state (it restarts from ok).
function prevState(prev, k, resetS, now, newResetS = null) {
  const s = prev?.windows?.[k]?.state;
  if (Number.isFinite(resetS) && resetS * 1000 <= now) return "ok";
  // an early reset: the reading's reset time jumped away from the previous window's (more than 5 min) = a new window
  if (Number.isFinite(resetS) && Number.isFinite(newResetS) && Math.abs(newResetS - resetS) > 300) return "ok";
  return STATES.includes(s) ? s : "ok";
}
// The window's elapsed and total minutes at `now` (resetsS: epoch s; totalMin: the window's length). off: sorted
// [{start, end}] epoch-ms non-working intervals, each clipped to the window and subtracted from both (default none).
export function windowElapsed(resetsS, totalMin, now, off = []) {
  const end = resetsS * 1000, start = end - totalMin * MIN, cut = Math.min(now, end);
  let total = totalMin, elapsed = Math.min(totalMin, Math.max(0, totalMin - (end - now) / MIN));
  for (const o of off || []) {
    const a = Math.max(o.start, start), b = Math.min(o.end, end);
    if (b > a) { total -= (b - a) / MIN; const c = Math.min(b, cut) - a; if (c > 0) elapsed -= c / MIN; }
  }
  return { elapsed: Math.max(0, elapsed), total: Math.max(1, total) };
}
function providerState(rs, prev, now, c, off = []) {
  const r5 = newest(rs, "pct", "resets_at", now), rw = newest(rs, "week_pct", "week_resets_at", now);
  let five = { state: "ok", basis: "none" }, ahead = null;
  if (r5) {
    const fresh = now - r5.ts < c.fresh_min * MIN;
    const { elapsed, total } = windowElapsed(r5.resets_at, 300, now, off);
    const a = r5.pct - Math.max(c.pace_floor, (c.pace_target * elapsed) / total);
    five = { state: band(prevState(prev, "five_hour", prev?.resets_at, now, r5.resets_at), fresh, { exhaust: r5.pct >= c.exhausted_pct,
      enterHold: a > c.hold_enter, keepHold: a >= c.hold_leave, enterSlow: a > c.slow_enter, keepSlow: a >= c.slow_leave }), basis: fresh ? "fresh" : "stale" };
    ahead = round1(a);
  }
  let weekly = { state: "ok", basis: "none" }, weekAhead = null;
  if (rw) {
    const fresh = now - rw.ts < c.week_fresh_min * MIN;
    const { elapsed, total } = windowElapsed(rw.week_resets_at, 10080, now, off);
    const a = rw.week_pct - c.pace_target * Math.min(1, (elapsed + c.week_grace_min) / total), high = rw.week_pct >= c.week_slow_pct;
    weekly = { state: band(prevState(prev, "weekly", prev?.week_resets_at, now, rw.week_resets_at), fresh, { exhaust: rw.week_pct >= c.week_exhausted_pct,
      enterHold: a > c.week_hold_enter, keepHold: a >= c.week_hold_leave, enterSlow: a > c.week_slow_enter || high, keepSlow: a >= c.week_slow_leave || high }), basis: fresh ? "fresh" : "stale" };
    weekAhead = round1(a);
  }
  const state = worse(five.state, weekly.state);
  const since = prev && prev.state === state && Number.isFinite(prev.since) ? prev.since : now;
  return { state, pct: r5?.pct ?? null, ahead, resets_at: r5?.resets_at ?? null, week_pct: rw?.week_pct ?? null, week_ahead: weekAhead,
    week_resets_at: rw?.week_resets_at ?? null, since, windows: { five_hour: five, weekly } };
}
// readings: [{ts, provider?, pct, resets_at, week_pct, week_resets_at}] in any order (provider absent = "claude"; a
// reading without a numeric ts is skipped); prev: the previous pace.json or null; cfg: PACE_DEFAULTS' shape. -> {<provider>:
// {state, pct, ahead, resets_at, week_pct, week_ahead, week_resets_at, since, windows: {five_hour, weekly: {state, basis}}}}
// (basis: fresh | stale | none - none: no reading of a window that has not reset). The caller adds `updated`.
// A used percentage clamped into 0-100 (a negative reads as 0); a non-number stays as it is (the pacer ignores it).
const clampPct = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : v);
export function paceState({ readings, prev = null, now, cfg = PACE_DEFAULTS }) {
  const c = { ...PACE_DEFAULTS, ...cfg }, by = new Map();
  for (const r of readings || []) {
    if (!isObj(r) || !Number.isFinite(r.ts)) continue;
    const p = typeof r.provider === "string" && r.provider ? r.provider : "claude";
    if (["__proto__", "constructor", "prototype", "updated"].includes(p)) continue;
    if (!by.has(p)) by.set(p, []);
    by.get(p).push({ ...r, pct: clampPct(r.pct), week_pct: clampPct(r.week_pct) });
  }
  const out = {};
  for (const [p, rs] of by) out[p] = providerState(rs, isEntry(prev?.[p]) && Object.hasOwn(prev, p) ? prev[p] : null, now, c);
  return out;
}
// The provider entries of a pace.json: [[name, entry]] (`updated` and any other non-entry key skipped).
export const providersOf = (pace) => (isObj(pace) ? Object.entries(pace).filter(([, v]) => isEntry(v)) : []);
// pace.json when it is no older than stale_min (and not from the future), else null: readers treat it as absent.
export function paceFresh(pace, now, cfg = PACE_DEFAULTS) {
  if (!isObj(pace)) return null;
  const u = typeof pace.updated === "number" ? pace.updated : Date.parse(pace.updated);
  return Number.isFinite(u) && now - u <= cfg.stale_min * MIN && u - now <= MIN ? pace : null;
}

// ---------- texts ----------
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${Math.round(v)}` : "-");
const pctText = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "-");
export const aheadText = (e) => `5h ${signed(e?.ahead)} / week ${signed(e?.week_ahead)}`;
// ---------- the status line (Part 1, Part 8; the user's layout, 2026-10-06) ----------
// `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 0 agents`, from the
// status line's documented stdin fields (code.claude.com/docs/en/statusline). A field that is absent drops its segment,
// never an error: no plan or subscription field is documented, so that segment is never shown (never guessed).
const BAR = 10;
// The ctx bar: 10 segments, ▰ filled, ▱ empty; pct rounded to the nearest 10 % (5 % fills one).
export const ctxBar = (pct) => { const n = Math.max(0, Math.min(BAR, Math.round(pct / 10))); return "▰".repeat(n) + "▱".repeat(BAR - n); };
// A context window size: 1000000 -> "1M", 200000 -> "200k".
export const windowText = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const word = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
// The running subagents of an undocumented `tasks` array, if the real stdin has one (probe P2): entries whose status is
// running or pending (or that carry no status). Absent or not an array: null (the segment is dropped).
export function runningAgents(tasks) {
  if (!Array.isArray(tasks)) return null;
  return tasks.filter((t) => isObj(t) && (t.status == null || /^(running|pending|in_progress|active)$/i.test(String(t.status)))).length;
}
// input: the status line's stdin; reading: readingFromStatus's (or null); entry: a fresh pace.json's claude entry (or
// null); tokens: Part 8's context tokens (contextOfStatus, else the transcript's tail) or null; cfg: ctxConfig's;
// effort: the settings' effort when stdin has no effort.level (or null); max: the width cap - past it, the pace and then
// the wk segment go. -> the one line ("" when nothing is known)
export function statusLineText({ input, reading = null, entry = null, tokens = null, cfg = CTX_DEFAULTS, effort = null, max = 110 }) {
  const cw = isObj(input?.context_window) ? input.context_window : {}, size = num(cw.context_window_size);
  const model = word(input?.model?.display_name), eff = word(input?.effort?.level) ?? word(effort);
  const t = num(tokens) ?? (num(cw.used_percentage) !== null && size ? (cw.used_percentage * size) / 100 : null);
  const pct = num(cw.used_percentage) ?? (t !== null && size ? (100 * t) / size : null);
  const mark = t === null ? "" : t > cfg.hard_ctx ? " RELAY NOW" : t > cfg.relay_ctx ? " relay" : "";
  const head = [], tail = [];
  if (model) head.push(`◆ ${model}${size ? ` · ${windowText(size)}` : ""}`);
  if (eff) head.push(`effort ${eff}`);
  if (pct !== null) head.push(`ctx ${ctxBar(pct)} ${Math.round(pct)}%${mark}`);
  else if (t !== null) head.push(ctxText(t, cfg)); // a count but no window size: `ctx 263k relay`
  if (num(reading?.pct) !== null) head.push(`5h ${pctText(reading.pct)}`);
  const wk = num(reading?.week_pct) !== null ? `wk ${pctText(reading.week_pct)}` : null;
  let pace = null;
  if (entry && entry.state !== "ok") {
    const a = Math.max(-Infinity, ...[entry.ahead, entry.week_ahead].filter(Number.isFinite));
    pace = `pace ${entry.state}${(entry.state === "slow" || entry.state === "hold") && a > 0 ? ` +${Math.round(a)}` : ""}`;
  }
  const agents = runningAgents(input?.tasks);
  if (agents !== null) tail.push(`◇ ${agents} agents`);
  const line = (w, p) => [...head, ...(w ? [w] : []), ...(p ? [p] : []), ...tail].join(" │ ");
  for (const [w, p] of [[wk, pace], [wk, null], [null, null]]) { const l = line(w, p); if (l.length <= max) return l; }
  return line(null, null);
}
const ms = (s) => (Number.isFinite(s) ? s * 1000 : NaN);
const isoMin = (t) => (Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16)}Z` : "-");
// `coord.mjs pace`: one line per provider (times in UTC).
export function paceTable(pace) {
  const rows = providersOf(pace).map(([p, e]) => `${p}: ${e.state}  5h ${pctText(e.pct)} ahead ${signed(e.ahead)} resets ${isoMin(ms(e.resets_at))}`
    + `  week ${pctText(e.week_pct)} ahead ${signed(e.week_ahead)} resets ${isoMin(ms(e.week_resets_at))}  since ${isoMin(e.since)}`);
  return rows.length ? rows : ["no usage readings"];
}
// The status header of `launch.mjs status` and `sessions` (B2): `pace: claude 5h 42% wk 31% slow · codex wk 12% ok`.
export function paceHeader(pace) {
  const rows = providersOf(pace).map(([p, e]) => [p, ...(Number.isFinite(e.pct) ? [`5h ${pctText(e.pct)}`] : []), ...(Number.isFinite(e.week_pct) ? [`wk ${pctText(e.week_pct)}`] : []), e.state].join(" "));
  return rows.length ? `pace: ${rows.join(" · ")}` : null;
}
// ---------- Part 8: the controller's context discipline (never blocks: a status-line part and a nudge) ----------
export const CTX_DEFAULTS = Object.freeze({ relay_ctx: 250000, hard_ctx: 400000 });
// config.json's flat relay_ctx / hard_ctx (positive numbers; anything else: the default).
export function ctxConfig(o) {
  const c = { ...CTX_DEFAULTS };
  for (const k of Object.keys(CTX_DEFAULTS)) if (typeof o?.[k] === "number" && Number.isFinite(o[k]) && o[k] > 0) c[k] = o[k];
  return c;
}
// The current context of a main thread: its last assistant message's input + cache read + cache creation tokens (records
// of subagents, isSidechain, are skipped). entries: transcript records, oldest first. -> tokens, or null when none.
export function contextOfEntries(entries) {
  for (let i = (entries || []).length - 1; i >= 0; i--) {
    const x = entries[i], u = x?.type === "assistant" && !x.isSidechain ? x.message?.usage : null;
    if (u && typeof u === "object") return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return null;
}
// The status line's own context field when it has one (context_window.current_usage), else null (the caller reads the
// transcript tail).
export function contextOfStatus(input) {
  const u = input?.context_window?.current_usage;
  return isObj(u) ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
}
const kTok = (n) => `${Math.round(n / 1000)}k`;
// The status line's part: `ctx 263k`, past relay_ctx `ctx 263k relay`, past hard_ctx `ctx 402k RELAY NOW`; null without a count.
export function ctxText(tokens, cfg = CTX_DEFAULTS) {
  if (!Number.isFinite(tokens)) return null;
  return `ctx ${kTok(tokens)}${tokens > cfg.hard_ctx ? " RELAY NOW" : tokens > cfg.relay_ctx ? " relay" : ""}`;
}
export const CTX_RELAY_TEXT = (t, c) => `Context ${kTok(t)} is past the ${kTok(c.relay_ctx)} relay rule: this dispatch is your task boundary. Relay with handoff-launch after it (or finish before an idle gap; above ~200k an idle gap expires the cache).`;
export const CTX_HARD_TEXT = (t, c) => `Context ${kTok(t)} is past the ${kTok(c.hard_ctx)} hard cap: write the handoff and relay now.`;
// The Agent gate's nudge (main thread only - the caller skips a subagent's call). seen: the session's marker {relay,
// hard_at}. Past hard_ctx: one line, again at most every 10 min; past relay_ctx: one line, once. -> {kind: "relay" |
// "hard", text, ctx: the new marker} or null. The dispatch is always allowed.
export function ctxNudge({ tokens, seen = {}, now, cfg = CTX_DEFAULTS }) {
  if (!Number.isFinite(tokens)) return null;
  const s = isObj(seen) ? seen : {};
  if (tokens > cfg.hard_ctx) return Number.isFinite(s.hard_at) && s.hard_at <= now && now - s.hard_at < 10 * MIN ? null : { kind: "hard", text: CTX_HARD_TEXT(tokens, cfg), ctx: { ...s, relay: true, hard_at: now } };
  if (tokens > cfg.relay_ctx) return s.relay === true ? null : { kind: "relay", text: CTX_RELAY_TEXT(tokens, cfg), ctx: { ...s, relay: true } };
  return null;
}
export const SLOW_DENY_TEXT = (e) => `Usage is ahead of pace (${aheadText(e)}). Low-priority lanes start no new agents now. Do the step inline at lower effort, or save state and end your turn; dispatch resumes when the pace eases.`;
export const SLOW_NOTICE_TEXT = (e) => `Usage ahead of pace (${aheadText(e)}): step effort down (\`effort-medium\`/\`low\`) and keep work small.`;
export const PAUSE_TEXT = (reason) => `Paused (${reason}): start no new agents or tasks. Let running agents finish, save state (ledger/handoff), mark open GOAL items \`[!] paused — ${reason}\`, then end your turn. Work resumes automatically.`;
// The Agent gate (Part 3; Part 5 passes pause). pace: a fresh pace.json (paceFresh) or null; priority: the session's
// (high for a hand-opened one); pause: pauseFor's answer {paused, reason} or null (B1 has none: hold and exhausted then
// act as slow). -> {deny: text} | {notice: text, since} | null (allow, say nothing). The caller says a notice once per
// session per since.
export function gateDecision({ pace, priority, pause = null }) {
  if (pause?.paused) return { deny: PAUSE_TEXT(pause.reason) };
  const e = isEntry(pace?.claude) ? pace.claude : null;
  if (!e || !(RANK[e.state] > 0)) return null;
  if (priority === "low") return { deny: SLOW_DENY_TEXT(e) };
  return { notice: SLOW_NOTICE_TEXT(e), since: e.since };
}
