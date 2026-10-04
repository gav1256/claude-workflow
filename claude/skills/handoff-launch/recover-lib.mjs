// Pure decisions of the stage-2 coordinator: transcript -> tool calls, the loop rules (a) repetition, (b) stuck call,
// (d) waiting on a looping subagent, the "never flagged" exemptions, the re-arming ladder, the restart kind and cap,
// superseded closes, the session hook's steps, untracked launches and orphaned processes, and every text. No fs, no
// clock, no processes: callers pass the registry lines, transcripts and `now` in (tests/recover-lib.test.mjs and
// tests/leaks.test.mjs cover each decision).
import crypto from "node:crypto";

export const MIN = 60000;
export const DEFAULTS = Object.freeze({ repeat_window: 20, repeat_count: 4, warn_streak: 3, stuck_min: 30, grace_min: 5,
  idle_close_min: 10, fresh_at_tokens: 400000, max_restarts: 2, tick_min: 5, alert_repeat_hours: 6 });
export const REARM_MS = 60 * MIN; // the same signature within this of a cancel resumes at the grace step
// Probe 4 (plan Task 1): RESUME_WORKS = false if `claude --resume` failed on a killed transcript. Background lanes
// always restart fresh (controller ruling), whatever `claude --bg --resume` did in the probe.
export const RESUME_WORKS = true;
export const STOP_EXPIRE_MS = 60 * MIN; // a stop request this old is stale: the hook marks it handled, never injects it

// config.json text (null = missing) -> {config, errors}. Unknown keys and bad values are reported and ignored.
export function loadConfig(text) {
  const config = { ...DEFAULTS }, errors = [];
  if (text == null) return { config, errors };
  let o; try { o = JSON.parse(text); } catch (e) { return { config, errors: [`config.json is not valid JSON: ${e.message}`] }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { config, errors: ["config.json must be a JSON object"] };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in DEFAULTS)) errors.push(`unknown key ${k}`);
    else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) errors.push(`${k} must be a positive number`);
    else config[k] = v;
  }
  return { config, errors };
}

// ---------- transcripts ----------
const blocksOf = (x) => (Array.isArray(x?.message?.content) ? x.message.content : []);
const textOf = (x) => (typeof x?.message?.content === "string" ? x.message.content
  : typeof x?.content === "string" ? x.content : blocksOf(x).filter((b) => b.type === "text").map((b) => b.text || "").join("\n"));
export const callKey = (name, input) => `${name} ${JSON.stringify(input ?? {})}`;
export const shortHash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
export const display = (s, n = 160) => { const t = String(s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n)}...` : t; };
// Tool calls in order, from tool_use blocks (deduplicated by id) and their tool_result. Calls before sinceMs (the
// launch line's time) are not this run's: a resumed session keeps its old transcript.
export function toolCalls(entries, sinceMs = 0) {
  const calls = [], byId = new Map();
  for (const x of entries) {
    const at = Date.parse(x?.timestamp) || 0;
    for (const b of blocksOf(x)) {
      if (b.type === "tool_use" && b.id && !byId.has(b.id)) {
        const c = { id: b.id, name: b.name, input: b.input, key: callKey(b.name, b.input), at, done: false, doneAt: null };
        byId.set(b.id, c);
        if (at >= sinceMs) calls.push(c);
      } else if (b.type === "tool_result" && byId.has(b.tool_use_id)) { const c = byId.get(b.tool_use_id); c.done = true; c.doneAt = at; }
    }
  }
  return calls;
}
// input + cache read + cache creation of the last assistant usage (drops after a compaction, as it should).
export function contextTokens(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const u = entries[i]?.type === "assistant" && entries[i].message?.usage;
    if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return null;
}
// The tail shows "limit · resets" with no tool call after it: the session waits for a usage-limit reset.
export function usageLimited(entries) {
  for (let i = entries.length - 1; i >= Math.max(0, entries.length - 12); i--) {
    if (blocksOf(entries[i]).some((b) => b.type === "tool_use")) return false;
    if (/limit\s*·\s*resets/i.test(textOf(entries[i]))) return true;
  }
  return false;
}
// A subagent transcript that ended: its last message ends the turn, or its last call is a finished SubagentHandback.
export function agentDone(entries) {
  const conv = entries.filter((x) => x.type === "assistant" || x.type === "user");
  const last = conv.at(-1);
  if (!last) return false;
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn") return true;
  const c = toolCalls(entries), h = c.at(-1);
  return !!h && h.name === "SubagentHandback" && h.done;
}
// The main turn has ended: its last message ends the turn, or the turn_duration line follows it.
export function turnEnded(entries) {
  const conv = entries.filter((x) => x.type === "assistant" || x.type === "user" || (x.type === "system" && x.subtype === "turn_duration"));
  const end = conv.at(-1);
  return !!end && (end.type === "system" || (end.type === "assistant" && end.message?.stop_reason === "end_turn"));
}

// ---------- loop rules: each flag = {rule, scope, key, signature, text} ----------
// (a) The same call >= repeat_count times in the last repeat_window calls. Monitor is waiting by design: never counted.
export function ruleA(calls, cfg, scope = "main") {
  const win = calls.filter((c) => c.name !== "Monitor").slice(-cfg.repeat_window), counts = new Map();
  for (const c of win) counts.set(c.key, (counts.get(c.key) || 0) + 1);
  return [...counts].filter(([, n]) => n >= cfg.repeat_count).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ rule: "a", scope, key, count: n, signature: `a:${scope}:${shortHash(key)}`, text: `same call x${n} in the last ${win.length} tool calls: ${display(key)}` }));
}
// (b) The oldest outstanding main call with no activity for stuck_min. Activity: a newer main entry, or growth of a
// subagent transcript that is not itself looping (the caller passes subGrowthAt without those). Monitor is waiting
// by design and never stuck.
export function ruleB({ calls, lastEntryAt, subGrowthAt, now }, cfg) {
  const c = calls.find((x) => !x.done && x.name !== "Monitor");
  if (!c) return [];
  const idle = now - Math.max(lastEntryAt || 0, subGrowthAt || 0, c.at || 0);
  if (idle < cfg.stuck_min * MIN) return [];
  return [{ rule: "b", scope: "main", key: c.key, signature: `b:${c.name}`, text: `${c.name} call outstanding with no activity for ${Math.round(idle / MIN)} min` }];
}
// (d) A subagent in looping.json (flagged this tick) that has not finished, while its parent made no progress for
// stuck_min: measured from max(the notice's delivery, the parent's last main entry); a session without the hook has
// no notice and measures from its last entry alone. A hooked session waits for the notice (notices: hook state
// agent_notices, ISO). Its distinct calls pause the grace timer; leaving looping.json cancels.
export function ruleD({ looping, notices, done, hooked, lastEntryAt, now }, cfg) {
  return Object.entries(looping || {}).filter(([id]) => {
    if (done?.[id]) return false;
    const notice = Date.parse(notices?.[id]);
    if (hooked && !Number.isFinite(notice)) return false;
    return now - Math.max(hooked ? notice : 0, lastEntryAt || 0) >= cfg.stuck_min * MIN;
  }).map(([id, a]) => ({ rule: "d", scope: id, key: a.key, signature: `d:${id}`, text: `waiting on looping subagent ${a.type || "agent"} ${id} (${a.text})` }));
}
export function exemption({ entries = [], calls = [], waitingSince, paused, pauseActive, liveState }) {
  if (liveState === "unknown") return "liveness unknown";
  if (paused) return "paused ({paused} registry line)";
  if (pauseActive) return "the pause file is active";
  if (usageLimited(entries)) return "waiting on a usage limit";
  if (calls.some((c) => !c.done && c.name === "AskUserQuestion")) return "waiting for the user (AskUserQuestion)";
  if (waitingSince && !calls.some((c) => c.at > Date.parse(waitingSince))) return "waiting for the user (permission prompt)";
  return null;
}
// One session's flags. subFlags (looping.json for this session) are computed even when the session is exempt.
// obs.hooked: the session runs the hook, i.e. its launch line has coord === 1 (see graceFromRequest); the tick derives it.
export function detect(obs, cfg) {
  const subFlags = {};
  for (const s of obs.subs || []) {
    if (s.done) continue;
    const f = ruleA(s.calls, cfg, s.id)[0];
    if (f) subFlags[s.id] = { key: f.key, count: f.count, text: f.text, type: s.type || null, transcript: s.file, signature: f.signature };
  }
  const exempt = exemption(obs);
  if (exempt) return { exempt, flags: [], subFlags };
  const growth = Math.max(0, ...(obs.subs || []).filter((s) => !subFlags[s.id]).map((s) => s.grewAt || 0));
  const done = Object.fromEntries((obs.subs || []).map((s) => [s.id, !!s.done]));
  // (a) leaves a finished main turn with nothing outstanding alone (an idle session repeats nothing now); (d) does not:
  // idle parents of looping agents are its point.
  const idleTurn = turnEnded(obs.entries || []) && !obs.calls.some((c) => !c.done);
  const flags = [...(idleTurn ? [] : ruleA(obs.calls, cfg)), ...ruleB({ calls: obs.calls, lastEntryAt: obs.lastEntryAt, subGrowthAt: growth, now: obs.now }, cfg),
    ...ruleD({ looping: subFlags, notices: obs.hook?.agent_notices, done, hooked: obs.hooked, lastEntryAt: obs.lastEntryAt, now: obs.now }, cfg)];
  return { exempt: null, flags, subFlags };
}

// ---------- the ladder ----------
// Grace used since start: the clock runs while the session repeats calls it made before the stop request (or makes
// none), pauses from a distinct call until the next repeated one, and never runs while the session waited on a
// permission prompt (waits: [[from, to|null]] from the hook state).
export function graceElapsed({ start, calls, preKeys, now, waits = [] }) {
  const span = (a, b) => Math.max(0, b - a) - waits.reduce((s, [f, u]) => s + Math.max(0, Math.min(b, u ?? Infinity) - Math.max(a, f)), 0);
  let t = start, counting = true, acc = 0;
  for (const c of calls) {
    if (!(c.at > start) || c.at > now) continue;
    if (counting) acc += span(t, c.at);
    t = c.at;
    counting = !preKeys || preKeys.has(c.key);
  }
  return acc + (counting ? span(t, now) : 0);
}
export const preKeysOf = (calls, beforeMs, cfg) => new Set(calls.filter((c) => c.at < beforeMs).slice(-cfg.repeat_window).map((c) => c.key));
export function ladderOf(lines, id, signature) {
  let stop = null, delivered = null, cancelAt = 0, cancelWhy = null, rearmAt = 0, incident = null;
  for (const o of lines) {
    const at = Date.parse(o.at) || 0;
    if (o.stop_requested === id && o.reason_class === "ladder" && o.signature === signature) { stop = { at, token: o.token }; delivered = null; }
    else if (o.stop_delivered === id && stop && o.token === stop.token && delivered === null) delivered = at;
    else if (o.ladder_cancelled === id && o.signature === signature) { cancelAt = at; cancelWhy = o.why || null; incident = null; } // a cancelled ladder can re-arm
    else if (o.ladder_rearmed === id && o.signature === signature) rearmAt = at;
    else if (o.incident === id && o.signature === signature) incident = { at, n: o.n, path: o.path };
  }
  return { stop, delivered, cancelAt, cancelWhy, rearmAt, open: Math.max(stop?.at || 0, rearmAt) > cancelAt, incident };
}
// Grace counts from the stop request (not its delivery) for rules (b)/(d) and for a session without the hook.
// entry.coord === 1 (a stage-2 launch, which always passes the session hooks with --settings) is what "hooked" means
// here and in detect's obs.hooked: the tick derives obs.hooked from it.
const graceFromRequest = (rule, entry) => rule !== "a" || entry.coord !== 1;
// The tick's next step for one auto-mode session. One ladder per session at a time; an incident's ladder belongs to
// the kill path (pendingLadders).
export function ladderActions({ lines, entry, flags, callsFor, now, cfg, waits = [] }) {
  const acts = [], firing = new Map(flags.map((f) => [f.signature, f]));
  const sigs = [...new Set(lines.filter((o) => (o.stop_requested === entry.id && o.reason_class === "ladder") || o.ladder_rearmed === entry.id).map((o) => o.signature))];
  let open = null;
  for (const s of sigs) {
    const L = ladderOf(lines, entry.id, s);
    if (!L.open || L.incident) continue;
    if (!firing.has(s)) acts.push({ do: "cancel", signature: s });
    else if (!open) open = { s, L };
  }
  if (open) {
    const f = firing.get(open.s), L = open.L;
    const start = L.rearmAt > L.cancelAt ? L.rearmAt : (L.delivered ?? (graceFromRequest(f.rule, entry) ? L.stop.at : null));
    if (start == null) {
      // The hook found this stop stale and never injected it: cancel, so the next firing sends a fresh stop (no re-arm).
      acts.push(now - L.stop.at > STOP_EXPIRE_MS ? { do: "cancel", signature: open.s, why: "stop expired" } : { do: "wait", signature: open.s, why: "stop request not delivered yet" });
      return acts;
    }
    const c = callsFor(f) || [];
    const used = graceElapsed({ start, calls: c, preKeys: f.rule === "b" ? null : preKeysOf(c, L.stop?.at ?? start, cfg), now, waits });
    acts.push(used >= cfg.grace_min * MIN ? { do: "kill", signature: open.s, flag: f }
      : { do: "wait", signature: open.s, why: `grace ${Math.round(used / 1000)} s of ${cfg.grace_min} min` });
    return acts;
  }
  const f = flags.find((x) => !ladderOf(lines, entry.id, x.signature).incident);
  if (!f) return acts;
  const L = ladderOf(lines, entry.id, f.signature);
  // A re-fire resumes at grace only if the cancelled ladder had a grace start: a stop never delivered to a hooked
  // session's (a) ladder had none, so the re-fire gets a fresh stop request (a new token).
  const hadGrace = L.delivered != null || graceFromRequest(f.rule, entry);
  const rearm = L.stop && hadGrace && L.cancelAt && L.cancelWhy !== "stop expired" && now - L.cancelAt <= REARM_MS;
  acts.push(rearm ? { do: "rearm", signature: f.signature, flag: f } : { do: "stop", signature: f.signature, flag: f });
  return acts;
}
// Ladders to resume at tick start: an auto incident with no later restart, restart_skipped, restart_failed, lane_blocked
// or cancel of its signature.
export function pendingLadders(lines) {
  const out = new Map();
  lines.forEach((inc, i) => {
    if (!inc.incident || inc.mode !== "auto") return;
    const id = inc.incident, after = lines.slice(i + 1);
    if (after.some((o) => (o.restart && o.from === id) || o.restart_skipped === id || (o.restart_failed && o.from === id)
      || (o.lane_blocked && o.incident === inc.path) || (o.ladder_cancelled === id && o.signature === inc.signature))) { out.delete(id); return; }
    out.set(id, { id, incident: inc, intent: after.filter((o) => o.kill_intent === id && o.kind === "ladder").at(-1) || null, closed: after.some((o) => o.closed && o.id === id) });
  });
  return [...out.values()];
}

// ---------- restarts ----------
// {restart} lines of this lane for this handoff since its last {lane_resumed} (a new handoff starts at zero).
export function restartsSince(lines, name, handoff) {
  let n = 0;
  for (const o of lines) { if (o.lane_resumed === name && (!o.handoff || o.handoff === handoff)) n = 0; else if (o.restart === name && o.handoff === handoff) n++; }
  return n;
}
export function restartKind({ restarts, tokens, cfg, isBg, hasSession = true, resumeWorks = RESUME_WORKS }) {
  const big = (tokens ?? 0) >= cfg.fresh_at_tokens;
  if (restarts >= (big ? 1 : cfg.max_restarts)) return "blocked";
  // Resume needs a window session with a known session id; background lanes always restart fresh.
  if (big || restarts > 0 || !resumeWorks || isBg || !hasSession) return "fresh";
  return "resume";
}
const RUNGS = [["opus", "medium"], ["opus", "high"], ["opus", "xhigh"], ["fable", "high"], ["fable", "xhigh"]];
const EFFORTS = ["low", "medium", "high", "xhigh"];
// One rung up the sizing-dispatches ladder; never to max (max only after xhigh already failed, by a person).
export function rungUp(model, effort) {
  const i = RUNGS.findIndex(([m, e]) => m === model && e === effort);
  if (i >= 0) { const [m, e] = RUNGS[Math.min(i + 1, RUNGS.length - 1)]; return { model: m, effort: e }; }
  const j = EFFORTS.indexOf(effort);
  return { model, effort: EFFORTS[Math.min((j < 0 ? 2 : j) + 1, EFFORTS.length - 1)] };
}
export function afterKillPlan({ lines, entry, incident, cfg, doneMarkerExists, pauseActive, prevCauseFilled = true }) {
  if (doneMarkerExists) return { do: "skip", why: "its done marker exists - its work belongs to the merge drain (a relaunch would need --reopen)" };
  const restarts = restartsSince(lines, entry.name, entry.handoff);
  const kind = restartKind({ restarts, tokens: incident?.tokens, cfg, isBg: entry.mode === "bg", hasSession: !!entry.session_id });
  if (kind === "blocked") return { do: "block", restarts };
  if (pauseActive) return { do: "defer", why: "the pause file is active - the restart waits until it lifts" };
  let model = entry.model || "opus", effort = entry.effort || "high"; // lines from before stage 2 restart as opus/high
  if (restarts === 1 && !prevCauseFilled) ({ model, effort } = rungUp(model, effort));
  return { do: "restart", kind, model, effort, restarts };
}
export const CAUSE_PLACEHOLDER = "_(left for the restarted session: the root cause, and the fix)_";
export function causeFilled(text) {
  const m = /^## Cause[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(String(text || ""));
  return !!m && m[1].replace(CAUSE_PLACEHOLDER, "").trim().length > 0;
}
// The launch.mjs arguments of a fresh restart (the ladder's and `launch.mjs resume`'s). The entry's lane profile is kept;
// an entry from before profiles has none and ran with every plugin and server, so it restarts with full (as --resume
// does) - a restart must not lose tools mid-task. Never --force for a lane: the session cap must be able to refuse a
// restart (the tick defers it); only a legacy <group>-merge session (cap-exempt) gets it, for its merge.lock.
export function freshLaunchArgs(e, { model, effort, recovery }) {
  const a = ["--repo", e.worktree, "--handoff", e.handoff, "--name", e.name];
  if (e.group) a.push("--group", e.group);
  if (e.worktree && e.repo && e.worktree.toLowerCase() !== e.repo) a.push("--worktree", e.branch);
  a.push("--profile", typeof e.profile === "string" && e.profile ? e.profile : "full");
  a.push("--model", model, "--effort", effort, "--mode", e.mode || "window", "--no-close", "--recovery", recovery);
  if (e.session_id) a.push("--goal-from", e.session_id);
  if (e.prompt_file) a.push("--prompt-file", e.prompt_file);
  if (e.group && e.name === `${e.group}-merge`) a.push("--force"); // a legacy merge session: its merge.lock exists
  return a;
}

// ---------- closes, modes, blocked lanes, alerts ----------
// noClaude: true when no claude (or node) process runs below the window host, false when one does, null when the probe
// failed. A close needs positive answers: background agents unknown (state.bgKnown not true) keeps the window.
export function closeDecision({ state, waitingSince, noClaude, now, cfg, reason }) {
  if (!state.found) return noClaude === true ? { close: true, why: `${reason}: no claude running in the window` }
    : { close: false, why: noClaude === null ? "no transcript and the process probe failed" : "no transcript, but claude is running" };
  if (!state.idle) return { close: false, why: `busy: ${state.busy.join(", ")}` };
  if (state.bgKnown !== true) return { close: false, why: "pending background agents unknown (the turn ended without a turn_duration record)" };
  if (waitingSince) return { close: false, why: "waiting for the user (permission prompt)" };
  const idle = now - Date.parse(state.last);
  if (!(idle >= cfg.idle_close_min * MIN)) return { close: false, why: `idle only ${Math.round(idle / MIN)} min` };
  return { close: true, why: `${reason}: idle ${Math.round(idle / MIN)} min` };
}
// auto when the group's (or the lone session's) EARLIEST launch line has coord: 1; the latest {recovery_mode} wins.
export function recoveryMode(lines, entry) {
  const target = entry.group || entry.name;
  let mode = null;
  for (const o of lines) if (o.recovery_mode === target && (o.mode === "auto" || o.mode === "report")) mode = o.mode;
  if (mode) return mode;
  if (!entry.group) return entry.coord === 1 ? "auto" : "report"; // a lone session: its own launch line decides
  const first = lines.find((o) => o.name && o.launched_at && o.group === entry.group && (!entry.repo || o.repo === entry.repo));
  return first?.coord === 1 ? "auto" : "report";
}
export function blockedLanes(lines, group) {
  const m = new Map();
  for (const o of lines) {
    if (o.lane_blocked && (o.group ?? null) === (group ?? null)) m.set(o.lane_blocked, { name: o.lane_blocked, handoff: o.handoff, incident: o.incident, at: o.at });
    else if (o.lane_resumed && (o.group ?? null) === (group ?? null)) m.delete(o.lane_resumed);
  }
  return [...m.values()];
}
export const alertDue = (index, key, now, cfg) => { const last = Date.parse(index?.[key]); return !Number.isFinite(last) || now - last >= cfg.alert_repeat_hours * 3600e3; };

// ---------- leaks: untracked launches, orphaned processes ----------
// {starting} lines older than minAgeMs with no later launch line (name + launched_at) of the same name - and the same
// session id when the {starting} line has one (window and --resume launches know it; a bg launch does not). In order.
export function startsWithoutLaunch(lines, now, minAgeMs) {
  const names = new Set(), sids = new Set(), out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = lines[i];
    if (o.name && o.launched_at) { names.add(o.name); if (o.session_id) sids.add(`${o.name}|${o.session_id}`); continue; }
    if (!("starting" in o) || !o.name) continue;
    if (o.starting ? sids.has(`${o.name}|${o.starting}`) : names.has(o.name)) continue;
    if (now - Date.parse(o.at) > minAgeMs) out.push(o);
  }
  return out.reverse();
}
export const untrackedLine = (u) => `UNTRACKED ${u.name}: launcher died before registering it - pid ${u.pid ?? "?"} ${u.state}`;
const ORPHAN_NAMES = new Set(["python", "pythonw", "node", "pytest", "chrome"]);
// procs: [{pid, ppid, name, mb, created}] (created: epoch ms). -> the big python/node/pytest/chrome processes whose parent
// is not in the list, or was created after them (its pid was reused), biggest first. Report-only: they may belong to
// anything, hand-opened sessions included.
export function orphans(procs, { minMb = 300 } = {}) {
  const list = Array.isArray(procs) ? procs.filter((p) => p && Number.isFinite(p.pid)) : [];
  const byPid = new Map(list.map((p) => [p.pid, p]));
  return list.filter((p) => {
    if (!ORPHAN_NAMES.has(String(p.name || "").toLowerCase().replace(/\.exe$/, "")) || !(p.mb >= minMb)) return false;
    const parent = byPid.get(p.ppid);
    return !parent || (Number.isFinite(parent.created) && Number.isFinite(p.created) && parent.created > p.created);
  }).sort((a, b) => b.mb - a.mb);
}
export const orphanLine = (o) => `ORPHAN ${o.name} pid ${o.pid} ${o.mb} MB (parent ${o.ppid} gone) since ${Number.isFinite(o.created) ? new Date(o.created).toISOString() : "?"}`;

// ---------- the session hook (PostToolUse steps 1-4; step 5, the tick trigger, is the caller's) ----------
// At most one line of context per call; the first step that speaks wins. State: {streaks, warned, agent_notices,
// parent_notices, delivered, waiting_since, waits}. ctx.stops: this session's stop files, ladder first.
export function postToolSteps(state, ev, ctx) {
  const s = { streaks: {}, warned: {}, agent_notices: {}, parent_notices: {}, delivered: {}, ...(state && typeof state === "object" ? state : {}) };
  for (const k of ["streaks", "warned", "agent_notices", "parent_notices", "delivered"]) s[k] = s[k] && typeof s[k] === "object" ? { ...s[k] } : {};
  // A tool call followed any permission prompt: keep that wait (the last 10), so grace never counts it.
  s.waits = (Array.isArray(s.waits) ? s.waits : []).slice(-9);
  if (s.waiting_since && Number.isFinite(Date.parse(s.waiting_since))) s.waits.push([Date.parse(s.waiting_since), ctx.now]);
  s.waiting_since = null;
  // A streak keeps a short hash of the call (the equality check) and its bounded display, never the raw tool input:
  // the hook rewrites this file at every tool call.
  const who = ev.agentId || "main", at = new Date(ctx.now).toISOString(), prev = s.streaks[who], hash = shortHash(ev.key);
  s.streaks[who] = { hash, call: display(ev.key, 120), n: prev && prev.hash === hash && Number.isFinite(prev.n) ? prev.n + 1 : 1 };
  const say = (context, delivered = null) => ({ state: s, context, delivered });
  if (!ev.agentId) for (const st of ctx.stops || []) {
    if (!st?.token || s.delivered[st.token]) continue;
    // Stale, or without a valid `at` (it could never expire): marked handled, never injected.
    const sat = Date.parse(st.at);
    if (!Number.isFinite(sat) || ctx.now - sat > STOP_EXPIRE_MS) { s.delivered[st.token] = `expired ${at}`; continue; }
    s.delivered[st.token] = at;
    return say(st.text, st.token);
  }
  const looping = ctx.looping || {};
  if (ev.agentId && looping[ev.agentId] && !s.agent_notices[ev.agentId]) { s.agent_notices[ev.agentId] = at; return say(SUBAGENT_TEXT(display(looping[ev.agentId].key, 120))); }
  if (!ev.agentId) {
    const id = Object.keys(looping).find((k) => !s.parent_notices[k]);
    if (id) { s.parent_notices[id] = at; const a = looping[id]; return say(PARENT_TEXT({ type: a.type || "agent", id, reason: a.text, transcript: a.transcript })); }
  }
  const n = s.streaks[who].n, sig = `${who}:${hash}`;
  if (n >= ctx.cfg.warn_streak && !s.warned[sig] && !ev.key.startsWith("Monitor ")) { s.warned[sig] = at; return say(WARN_TEXT(s.streaks[who].call, n)); }
  return say(null);
}

// ---------- texts ----------
export const STOP_TEXT_LADDER = (sig) => `The coordinator flagged a loop (${sig}). Finish or cancel the current call. Save your state (ledger or handoff, GOAL \`[!] loop-stopped\`). End your turn. If the repetition is intentional waiting, switch to Monitor or ScheduleWakeup instead. The loop is cleared when the repeated call stops, not by one different call.`;
export const SUBAGENT_TEXT = (call) => `You are repeating \`${call}\`. Stop, return what you have and the suspected cause.`;
export const PARENT_TEXT = ({ type, id, reason, transcript }) => `Agent \`${type}\` \`${id}\` is looping (${reason}). TaskStop it, diagnose the cause from \`${transcript}\`, fix the brief or the code, then re-dispatch per sizing-dispatches.`;
export const WARN_TEXT = (call, n) => `You have repeated \`${call}\` ${n} times. Stop, find the cause, change approach. If this is intentional waiting, use Monitor or ScheduleWakeup instead of polling.`;
// The first line of launch.mjs's session-cap refusal (exit 3) starts with this marker.
export const CAP_REFUSED = "refused - session cap:";
// A launcher run the session cap refused: exit 3 AND a line starting with CAP_REFUSED (exit 3 alone is also a group
// guard's refusal). -> the cap's reason ("1.0 GB free RAM, min_free_gb 3"), or null for any other result.
export function capRefusal(status, text) {
  if (status !== 3) return null;
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.startsWith(CAP_REFUSED));
  return line == null ? null : line.slice(CAP_REFUSED.length).replace(/ \(config .*\)$/, "").trim() || "no reason given";
}
// No double quotes or semicolons: it becomes part of a launch prompt (launch.mjs replaces them anyway).
export const RECOVERY_LINE = (incidentRef) => `RECOVERY: you were stopped for a loop. Read ${incidentRef}. Find and fix the cause (systematic-debugging), record it in the incident's Cause section and the lane ledger, then continue.`;
const RULES = { a: "the same tool call repeated", b: "a tool call stuck with no activity", d: "waiting on a looping subagent" };
const callList = (calls, pad = "") => (calls?.length ? calls.slice(-20).map((k, i) => `${pad}${i + 1}. \`${display(k, 200).replace(/`/g, "'")}\``) : [`${pad}(none)`]);
// p.looping (optional): the subagents flagged this tick, [{id, type, text, calls}], whatever rule escalated - a
// foreground Agent call over a looping subagent escalates as (b), and the restarted session must see the real cause.
export function incidentText(p) {
  return [
    `# Incident ${p.lane}-${p.n}: loop stopped by the coordinator`, "",
    `- At: ${p.at}`,
    `- Session: ${p.name} (registry id ${p.id}, session ${p.sessionId ?? "?"}, generation ${p.generation ?? "?"})`,
    `- Rule: (${p.rule}) ${RULES[p.rule] || p.rule}`,
    `- Signature: \`${p.signature}\` - ${p.text}`,
    `- Context tokens: ${p.tokens ?? "unknown"}`,
    `- Lane: ${p.lane}, branch ${p.branch ?? "?"}, worktree ${p.worktree ?? "?"}, handoff ${p.handoff ?? "?"}`,
    `- Recovery mode: ${p.mode}`, "",
    "## Last 20 tool calls", ...callList(p.calls), "",
    ...(p.looping?.length ? ["## Looping subagents", ...p.looping.flatMap((a) => [`- ${a.id} (${a.type || "agent"}): ${a.text}`, ...callList(a.calls, "  ")]), ""] : []),
    "## Transcripts", `- main: ${p.main ?? "(not found)"}`, ...(p.subs || []).map((s) => `- subagent ${s.id} (${s.type || "agent"}): ${s.file}`), "",
    "## Other background agents (re-dispatch)", ...(p.others?.length ? p.others.map((o) => `- ${o.id} (${o.type || "agent"}): ${o.description || ""}`) : ["(none)"]), "",
    "## Cause", CAUSE_PLACEHOLDER, "",
  ].join("\n");
}
export const ALERT = {
  blocked: ({ name, group, restarts, incident, launchMjs, handoff }) => `${name}${group ? ` (group ${group})` : ""} looped again after ${restarts} restart(s) and is blocked. Incident: ${incident}. `
    + (group ? `Resume it: node ${launchMjs} resume --group ${group} --lane ${name}` : `Relaunch it from ${handoff} with launch.mjs once the cause is fixed.`),
  mergeCap: ({ name, group, lane, incident, launchMjs }) => `Merge session ${name} looped at its restart cap and still holds merge.lock. Incident: ${incident}. `
    + `Next: git merge --abort in .claude/worktrees/_merge-${group}, then node ${launchMjs} merge --group ${group} --force`
    + (lane ? ` (or --skip ${lane} --why ...).` : "."),
  capDeferred: ({ name, group, why, log, incident }) => `Restart of ${name}${group ? ` (group ${group})` : ""} after a loop is deferred: the session cap refused it (${why}). Log: ${log}. Incident: ${incident}. `
    + "The coordinator retries it at every tick and restarts it on its own once the cap allows: close idle sessions or free RAM.",
  restartFailed: ({ name, group, why, log, incident, launchMjs, handoff }) => `Restart of ${name}${group ? ` (group ${group})` : ""} after a loop failed: ${why}. Log: ${log}. Incident: ${incident}. `
    + (group ? `Fix it, then: node ${launchMjs} resume --group ${group} --lane ${name}` : `Fix it, then relaunch from ${handoff} with launch.mjs.`),
  report: ({ name, group, text, incident, launchMjs }) => `Loop in ${name} (report-only${group ? `, group ${group}` : ""}): ${text}. Incident: ${incident}. Nothing was stopped. `
    + `Opt in: node ${launchMjs} recover ${group ? `--group ${group}` : `--name ${name}`} --mode auto`,
  orphans: (list, total) => `Orphaned processes hold ${total} MB: ${list.map((o) => `${o.name} ${o.pid} ${o.mb} MB`).join(", ")}`,
};
