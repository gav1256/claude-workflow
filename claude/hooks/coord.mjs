// Coordinator hook entry (stage 2 of handoff-launch). Subcommands:
//   post-tool   PostToolUse hook of launcher sessions (launch.mjs passes it with --settings): stop delivery, notices
//               for looping subagents, the early warning, the claude-in-chrome tab set, the checklist lines (missing or
//               stale GOAL.md) and the tick trigger. Prints at most one additionalContext.
//   notify      Notification hook: records waiting_since, for permission prompts only.
//   fence       PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit): denies a write into another lane's worktree or the main
//               checkout with a one-line hint to queue it (batch A, Part 4).
//   lane-note   UserPromptSubmit hook: the live lanes of this repo, on the first prompt and when that set changes (Part 5).
//   stop        Stop hook: once per turn that used claude-in-chrome and left this session's tabs open (Part 8); a paused launcher lane: told to save state first, its {paused} line on the continuation Stop (Part 4).
//   tick [--dry-run]  one coordinator tick (recover.mjs); --dry-run prints what it would do and writes nothing.
//   relay        Stop-hook helper: on a fresh Stop of a non-launcher session, claim one alert and ask the session to push it
//   alert-sent <file> | alert-release <file>   mark a claimed alert sent, or put it back
//   statusline   the GLOBAL statusLine command (batch B, Part 1): records this session's usage reading, refreshes pace.json
//                when older than 30 s, prints `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% │ 5h 6% │ wk 31%`
//   pace [--json]  the pacer's table (pace-lib.mjs), computed from the usage files now; writes nothing
//   agent-gate   the GLOBAL PreToolUse hook on Agent|Task (batch B, Part 3): denies a low-priority lane's dispatch while
//                the pace is slow or worse, and tells the others once per state entry to step effort down; denies every
//                session a pause source covers (Part 5)
//   pause [30m | 2h | until HH:MM] | resume   the manual pause source (batch B, Part 4; /broadcast runs them)
//   shabbos [on|off|status]  Shabbat mode (one global switch, default on): <coord>/shabbos.json
//   power [--refresh]   the power probe (batch B, Part 7); --refresh writes power.json and the battery pause source
//   watch [--once] [--started <ms>] | watch --stop   the hidden single-instance watcher (Part 4): a step every 60 s while
//                anything is paused; the tick starts it, it stops itself
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any hook error: exit 0
// and no output - a broken hook must never block a tool call. A failed tick exits 1 (its trigger never waits on it, so
// only a hand or scheduled run sees the code): an import failure is shown on stderr, a failure inside the tick is its
// "tick failed:" line; the tick itself records its lines in <coord>/last-tick.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// <config>/hooks/coord.mjs -> <config>/skills/handoff-launch (the repo has the same layout). HL_SKILL_DIR: tests.
const SKILL = path.resolve(process.env.HL_SKILL_DIR || path.join(HERE, "..", "skills", "handoff-launch"));
export const OFFTIMES = path.resolve(process.env.HL_OFFTIMES_FILE || path.join(SKILL, "offtimes.json"));
export const OFF_LEAD_MS = 60 * 60000; // pause-lib SHABBAT_LEAD_MIN, pinned by tests/shabbat-source.test.mjs
const mod = (f) => import(pathToFileURL(path.join(SKILL, f)).href);
// live.mjs CFG and COORD, computed the same way here so the fence's quick path need not import live.mjs (~17 ms);
// tests/lane-hooks.test.mjs pins them equal to live.mjs's.
export const CFG = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
export const COORD = path.join(CFG, "state", "coord");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const readJson = (f, d) => { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return isObj(v) ? v : d; } catch { return d; } };
const str = (v) => typeof v === "string" && v !== "";
// A session id names this session's state file: a plain id only, never a path.
const plainId = (v) => str(v) && /^[\w-]+$/.test(v);

async function context() {
  const [V, L] = await Promise.all([mod("live.mjs"), mod("recover-lib.mjs")]);
  let text = null; try { text = fs.readFileSync(path.join(V.COORD, "config.json"), "utf8"); } catch {}
  return { V, L, cfg: L.loadConfig(text).config };
}

// Steps 1-5 of the spec's "Prevention: the session hook". Writes only this session's state file and, for a delivered
// stop, this session's {stop_delivered} line.
export async function postTool(input, env = process.env) {
  const regId = env.HL_SESSION_ID, sid = input?.session_id;
  if (!regId || !plainId(sid) || !input.tool_name) return null;
  const { V, L, cfg } = await context();
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`);
  // Corrupt shapes are skipped: a stop without a token and a text, or a looping entry without a key, is never acted on.
  const stops = ["ladder", "close", "manual"].map((c) => readJson(path.join(V.STOP_DIR, `${V.stem(regId)}.${c}.stop.json`), null))
    .filter((s) => s?.id === regId && str(s.token) && str(s.text));
  const mine = readJson(path.join(V.COORD, "looping.json"), {})[sid];
  const looping = isObj(mine) ? Object.fromEntries(Object.entries(mine).filter(([, a]) => isObj(a) && str(a.key))) : {};
  const now = Date.now();
  const r = L.postToolSteps(readJson(stateFile, {}), { agentId: input.agent_id || null, key: L.callKey(input.tool_name, input.tool_input) },
    { stops, looping, cfg, now });
  let state = r.state, said = r.context;
  // Batch A: the session's claude-in-chrome tab set (Part 8), then the checklist counters (Part 9), which speak only when
  // steps 1-4 did not. The GOAL.md path is derived once from a main-thread call's transcript_path (as goal-gate does) and
  // cached; a subagent's call (agent_id) may carry its own transcript's path, so it leaves the path for the next main call.
  if (L.isChromeTool(input.tool_name)) state = { ...state, chrome_turn: true, chrome_tabs: L.chromeTabs(state.chrome_tabs, { tool: input.tool_name, input: input.tool_input, response: input.tool_response }) };
  if (!str(state.goal_path) && !input.agent_id) state = { ...state, goal_path: goalPathOf(input, V) };
  const goal = goalInfo(state, [state.goal_path, path.join(V.CFG, "goals", `${sid}.md`)].filter(str), L);
  const g = L.goalSteps(state, { agentId: input.agent_id || null, tool: input.tool_name }, { goal, goalPath: state.goal_path, now, cfg });
  state = g.state;
  // A checklist line due on a call where steps 1-4 spoke waits for the next call: its once-flag is not kept set.
  if (g.context && said) state = { ...state, [goal ? "goal_stale_said" : "goal_missing_said"]: false };
  said ??= g.context;
  // The {stop_delivered} line goes first: if the state write then fails, the next call delivers the stop again (once
  // more), whereas a state written first and a failed append would mark it delivered with nothing injected or recorded.
  if (r.delivered) V.append({ stop_delivered: regId, token: r.delivered, at: V.now() });
  V.writeAtomic(stateFile, JSON.stringify(state));
  V.triggerTick("post-tool", cfg.tick_min);
  await maybePowerRefresh("post-tool");
  return said;
}
// live.mjs goalPathFor (goal-gate's rule: the scratchpad GOAL.md of the transcript's project folder); without a
// transcript_path, goal-gate's fallback <config>/goals/<sid>.md. Main-thread calls only (postTool).
const goalPathOf = (input, V) => V.goalPathFor(input.transcript_path, input.session_id) ?? path.join(V.CFG, "goals", `${input.session_id}.md`);
// The first GOAL.md that exists: {mtimeMs, open}; its open count is re-read only when its mtime changed. null: none.
function goalInfo(state, files, L) {
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (state.goal_mtime === st.mtimeMs && Number.isFinite(state.goal_open)) return { mtimeMs: st.mtimeMs, open: state.goal_open };
    let open = 0; try { open = L.parseGoal(fs.readFileSync(f, "utf8")).open; } catch {}
    state.goal_open = open;
    return { mtimeMs: st.mtimeMs, open };
  }
  return null;
}

// ---------- batch A: the write fence, the lane note, the Stop check (launcher sessions only; all fail open) ----------
const MIN = 60000;
const fileOf = (ti) => (isObj(ti) ? (str(ti.file_path) ? ti.file_path : str(ti.notebook_path) ? ti.notebook_path : null) : null);
const shown = (p, cwd) => { const a = String(path.isAbsolute(p) || !str(cwd) ? p : path.resolve(cwd, p)); return (a.startsWith("\\\\?\\") ? a.slice(4) : a).replace(/\\/g, "/"); };
// Part 4. The session's own entry is found once in the registry and cached in its hook state (fence: {id, name, branch,
// group, repo, own}); a write under its own root, the config dir, the temp dir or <main>/.superpowers is decided from
// that alone, with lane-lib.mjs only (live.mjs, the registry reader, is imported on a cache miss or outside that set).
// Anything else reads the registry's open entries of the repo. Without its own entry (or one without a repo) the hook
// allows before any decision: with no own root, fenceDecision would deny the main checkout. A cache that cannot be
// written never stops the decision: the next call reads the registry again. -> the denial reason, or null (allow).
export async function fence(input, env = process.env) {
  const regId = env.HL_SESSION_ID, sid = input?.session_id, p = fileOf(input?.tool_input);
  if (!regId || !plainId(sid) || !p) return null;
  const G = await mod("lane-lib.mjs");
  let V = null;
  const registry = async () => (V ??= await mod("live.mjs")).readRegistry();
  const stateFile = path.join(COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
  let f = isObj(state.fence) && state.fence.id === regId && str(state.fence.own) && str(state.fence.repo) ? state.fence : null, reg = null;
  if (!f) {
    reg = await registry();
    const me = [...reg.entries].reverse().find((e) => e.id === regId);
    if (!me || !str(me.repo)) return null;
    f = { id: regId, name: me.name, branch: me.branch, group: me.group ?? null, repo: me.repo, own: G.ownRoot(me) };
    if (!str(f.own)) return null;
    try { V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), fence: f })); } catch {}
  }
  const P = G.normPath(p, input.cwd), main = G.normPath(f.repo), base = { cwd: input.cwd, own: f.own, main: f.repo, config: CFG, tmp: os.tmpdir() };
  // The quick allow: under the own root but in no .claude/worktrees below it (a lane there is judged by the registry).
  const rest = G.isUnder(P, f.own) ? P.slice(f.own.length) : null;
  const ownQuick = rest !== null && !rest.includes("/.claude/worktrees/") && (f.own !== main || !G.isUnder(P, `${main}/.claude/worktrees`));
  if (ownQuick || [CFG, os.tmpdir(), `${main}/.superpowers`].some((r) => G.isUnder(P, G.normPath(r)))) return null;
  reg ??= await registry();
  // Only OPEN entries of the same repo own a worktree (a closed lane's worktree is an unowned one).
  const others = reg.entries.filter((e) => e.repo === f.repo && e.id !== regId && !reg.closed.has(e.id));
  const d = G.fenceDecision(p, { ...base, others });
  if (d.allow) return null;
  return G.fenceText({ p: shown(p, input.cwd), own: f.own, owner: d.owner, mainCheckout: d.mainCheckout, launchMjs: path.join(SKILL, "launch.mjs").split(path.sep).join("/"), ownName: f.name, ownGroup: f.group ?? null });
}
// Part 5. The live lanes of this repo from lanes.json (the tick's), or, when it is missing or older than 30 min, the
// registry's open entries (newest per lane, no liveness filter). Speaks on the first prompt and whenever the text changes
// (its hash in the hook state). -> the note, or null.
export async function laneNote(input, env = process.env) {
  const regId = env.HL_SESSION_ID, sid = input?.session_id;
  if (!regId || !plainId(sid)) return null;
  const [V, G] = await Promise.all([mod("live.mjs"), mod("lane-lib.mjs")]);
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
  let me = isObj(state.lane) && state.lane.id === regId ? state.lane : null, reg = null;
  if (!me) {
    reg = V.readRegistry();
    const e = [...reg.entries].reverse().find((x) => x.id === regId);
    if (!e) return null;
    me = { id: e.id, name: e.name, branch: e.branch, repo: e.repo, worktree: e.worktree, own: G.ownRoot(e), priority: G.effectivePriority(reg.lines, e) };
  }
  const lj = readJson(path.join(V.COORD, "lanes.json"), null);
  let lanes;
  if (lj && isObj(lj.repos) && Date.now() - Date.parse(lj.at) <= 30 * MIN) lanes = Array.isArray(lj.repos[me.repo]) ? lj.repos[me.repo] : [];
  else {
    reg ??= V.readRegistry();
    lanes = G.openLanes(reg.entries, reg.closed, me.repo).map((e) => ({ id: e.id, name: e.name, branch: e.branch, worktree: e.worktree, scope: e.scope ?? null, priority: G.effectivePriority(reg.lines, e) }));
  }
  const priority = lanes.find((l) => l?.id === regId)?.priority ?? me.priority;
  const text = G.laneNoteText({ name: me.name, branch: me.branch, own: me.own, priority }, G.otherLanes(lanes, me));
  const h = G.textHash(text);
  if (state.lane_hash === h && isObj(state.lane)) return null;
  V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), lane: me, lane_hash: h }));
  return state.lane_hash === h ? null : text;
}
// Part 8. Once per turn that used claude-in-chrome (post-tool sets chrome_turn): block when this session's tabs are still
// open. Never on a continuation Stop (plan amendment 4: this hook has no continuation cap, so a block there could loop
// while tabs stay open): a continuation skips chrome_turn, so the flag is kept and the next fresh Stop
// reminds once, then clears it. Batch B, Part 4: a launcher lane that ends its turn while paused is told to save state
// first: a fresh Stop re-prompts with PAUSE_TEXT on every stale/due line and writes no line. A continuation-first Stop
// (another hook blocked) prompts at most once per [id, source, since]: remember delivery BEFORE blocking; the next
// continuation writes its {paused} line (markPaused) and allows. Keep the marker even when the line becomes stale.
// With no source start stamp (legacy without at, pace without finite since), no stable per-pause key exists: keep the old
// fresh-prompt/continuation-write behaviour. A failed marker write does the same, never a continuation block loop.
// The line comes AFTER the save turn: records written after it count as resumed by hand (workedAfterPause). -> reason/null.
export async function stopCheck(input, env = process.env) {
  const sid = input?.session_id;
  if (!env.HL_SESSION_ID || !plainId(sid)) return null;
  const fresh = !input.stop_hook_active;
  if (fresh) {
    const { V, L } = await context(); // a fresh Stop only
    const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
    if (state.chrome_turn === true) {
      // Re-read before the write (as fence and laneNote do): a background subagent's post-tool may have written meanwhile.
      V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), chrome_turn: false }));
      const tabs = Array.isArray(state.chrome_tabs) ? state.chrome_tabs.filter(Number.isInteger) : [];
      if (tabs.length) return L.CHROME_TABS_TEXT(tabs.length); // the turn goes on: not the paused end of it
    }
  }
  try {
    const due = await dueLine(env.HL_SESSION_ID);
    if (!due) return null;
    const stateFile = path.join(due.V.COORD, "sessions", `${sid}.json`);
    const key = due.p.since == null ? null : JSON.stringify([env.HL_SESSION_ID, due.p.source, due.p.since]);
    if (!fresh && (!key || readJson(stateFile, {}).pause_save === key)) { await markPaused(env.HL_SESSION_ID); return null; }
    // Re-read before write, as chrome_turn does: keep a background post-tool's fields alongside the delivery marker.
    if (key) {
      try { due.V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), pause_save: key })); }
      catch { if (!fresh) { await markPaused(env.HL_SESSION_ID); return null; } }
    }
    return due.p.text || (await mod("pause-lib.mjs")).PAUSE_TEXT(due.p.reason, due.p.ends !== false); // the Agent gate's text and `ends`
  } catch {}
  return null;
}
// Part 4, step 2: the {paused} line a launcher lane would write now, or null: a pause source covers its priority and it
// has no line for this launch, its newest one predates the source that pauses it now, or it is more than 1 min old
// (pause-lib pausedLineDue, given now; pausedLineOf counts only B2 lines, with a source). Nothing paused: no module
// loads and no registry read. -> {e, p: pauseFor's answer, line} | null
async function dueLine(regId) {
  if (!(await pauseStatePossible())) return null;
  const [PI, Q] = await Promise.all([mod("pause-io.mjs"), mod("pause-lib.mjs")]);
  const now = Date.now(), sources = PI.readSources(now);
  if (!sources.length) return null;
  const [V, G] = await Promise.all([mod("live.mjs"), mod("lane-lib.mjs")]);
  const reg = V.readRegistry(), e = [...reg.entries].reverse().find((x) => x.id === regId);
  if (!e) return null;
  const p = Q.pauseFor(G.effectivePriority(reg.lines, e), sources);
  if (!p.paused || !Q.pausedLineDue(Q.pausedLineOf(reg.lines, e), p, now)) return null;
  return { e, p, line: { paused: e.id, name: e.name, group: e.group ?? null, at: V.now(), reason: p.reason, source: p.source, windows: p.windows, ...(Number.isFinite(p.end) ? { end: p.end } : {}) }, V };
}
// Appends that line (once per pause: a goal-gate continuation runs Stop twice). recover.mjs and pause-lib pausedLineOf read
// it. -> the line, or null
export async function markPaused(regId) {
  const due = await dueLine(regId);
  if (!due) return null;
  due.V.append(due.line);
  return due.line;
}
// A cheap table pre-filter only; readSources validates the table and switch.
export const offNear = (now = Date.now()) => { const t = readJson(OFFTIMES, null); return Array.isArray(t?.intervals) &&
  t.intervals.some((o) => o && o.start - OFF_LEAD_MS <= now && now < o.end); };
// A source file, a nearby off interval, or a fresh pace state can pause a session.
async function pauseStatePossible() {
  if (["pause/manual.json", "pause/battery.json", "pause.json"].some((f) => fs.existsSync(path.join(COORD, f))) || offNear()) return true;
  if (!fs.existsSync(path.join(COORD, "pace.json"))) return false;
  const P = await mod("pace-lib.mjs"), pace = P.paceFresh(readJson(path.join(COORD, "pace.json"), null), Date.now(), paceCfg(P));
  return !!pace && P.isEntry(pace.claude) && pace.claude.state !== "ok";
}
// Part 4, for goal-gate (every session's Stop): is this session paused? A launcher lane by its effective priority, any
// other session as high. A paused hand-opened session is recorded (pause/seen/<sid>.json) for the manifest; a failed
// record never un-pauses it. Never throws. -> {paused, reason}
export async function pauseNow(input, env = process.env) {
  try {
    // Cheap first (every Stop of every session): no pause source file and no fresh pace hold reads nothing more.
    if (!(await pauseStatePossible())) return { paused: false, reason: null };
    const [PI, Q] = await Promise.all([mod("pause-io.mjs"), mod("pause-lib.mjs")]);
    const now = Date.now(), sources = PI.readSources(now);
    if (!sources.length) return { paused: false, reason: null };
    const p = Q.pauseFor(await priorityOf(env), sources);
    if (p.paused && !str(env.HL_SESSION_ID) && env.CLAUDE_CODE_ENTRYPOINT !== "sdk-cli") { try { PI.recordSeen({ session_id: input?.session_id, cwd: input?.cwd ?? null, reason: p.reason }, now); } catch {} }
    return p;
  } catch { return { paused: false, reason: null }; }
}
// ---------- Part 4: the manual pause source (/broadcast runs these) ----------
// `pause [30m | 2h | until HH:MM]` (nothing: no end): pause/manual.json, its one writer; then a tick at once (it starts
// the watcher). -> {code, text}: the pause text for the broadcast.
export async function pauseCmd(args, env = process.env) {
  const [Q, PI, { V }] = await Promise.all([mod("pause-lib.mjs"), mod("pause-io.mjs"), context()]);
  const u = Q.parseUntil(args, Date.now());
  if (u.error) return { code: 2, text: u.error };
  const by = str(env.HL_SESSION_ID) ? env.HL_SESSION_ID : str(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : "user";
  const now = Date.now();
  PI.writeManual({ until: u.until, by }, now);
  const started = V.triggerTick("pause", 0);
  // the reason from the value just written, not a re-read of the file (a concurrent pause may have replaced it); the
  // end is printed in local time, as typed (the stored `until` stays UTC)
  const active = Q.activeSources({ manual: { until: u.until, by, at: new Date(now).toISOString() } }, now)[0];
  const reason = active?.reason ?? "manual pause";
  return { code: 0, text: `paused: ${reason}\nBroadcast: ${Q.PAUSE_TEXT(reason, Boolean(u.until))}${started ? "" : "\nTick not started now; the next tick applies it."}` };
}
// `resume`: deletes pause/manual.json and the legacy pause.json, then a tick at once: it relaunches the closed lanes whose
// pause no longer applies (the manifest is archived once they are all back). -> {code, text}
export async function resumeCmd() {
  const [PI, { V }] = await Promise.all([mod("pause-io.mjs"), context()]);
  const gone = PI.clearManual();
  const started = V.triggerTick("resume", 0);
  const left = PI.readSources();
  return { code: 0, text: [gone.length ? `resumed: removed ${gone.map((f) => path.basename(f)).join(", ")}` : "resumed: no manual pause was set",
    ...(left.length ? [`still paused by: ${left.map((s) => s.reason).join("; ")}`] : []),
    started ? "The coordinator relaunches the closed lanes (this tick, or the watcher within a few minutes)." : "Tick not started now; the next tick relaunches the closed lanes.", ...(left.length ? [] : ["Broadcast: resume your saved work."])].join("\n") };
}
// `usage-pause [off|on] [--by <who>]`: off requests a resume tick; no broadcast; no argument reports the current switch.
export async function usagePauseCmd(args, env = process.env) {
  const PI = await mod("pause-io.mjs");
  if (args.length) {
    if (!["off", "on"].includes(args[0]) || (args.length !== 1 && !(args.length === 3 && args[1] === "--by" && str(args[2])))) return { code: 1, text: "usage: usage-pause [off|on [--by <who>]]" };
    const by = args[2] ?? (str(env.HL_SESSION_ID) ? env.HL_SESSION_ID : str(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : "user");
    PI.writeUsagePause({ off: args[0] === "off", by });
    if (args[0] === "off") { const { V } = await context(); V.triggerTick("usage-pause", 0); }
  }
  return { code: 0, text: PI.usagePauseOff() ? "usage pause: off (pace readings no longer pause lanes)" : "usage pause: on" };
}
// The global Shabbat switch: status writes nothing; toggling does not trigger a tick.
export async function shabbosCmd(args, env = process.env) {
  if (args.length > 1 || (args.length && !["on", "off", "status"].includes(args[0]))) return { code: 2, text: "usage: shabbos [on|off|status]" };
  const PI = await mod("pause-io.mjs");
  if (args[0] === "on" || args[0] === "off") {
    const by = str(env.HL_SESSION_ID) ? env.HL_SESSION_ID : str(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : "user";
    PI.writeShabbos({ enabled: args[0] === "on", by });
  }
  return { code: 0, text: PI.shabbosEnabled() ? "shabbos: on (Shabbat/Yom Tov pause and working-time weekly pacing)" : "shabbos: off (plain 7-day pacing, no Shabbat/Yom Tov pause)" };
}
// Probe 2 recorded the type field: a permission prompt, not an idle prompt, makes the session "waiting for the user".
export const isPermission = (i) => (i?.notification_type ? i.notification_type === "permission_prompt" : /permission/i.test(String(i?.message || "")));
export async function notify(input, env = process.env) {
  if (!env.HL_SESSION_ID || !plainId(input?.session_id) || !isPermission(input)) return;
  const { V } = await context();
  const f = path.join(V.COORD, "sessions", `${input.session_id}.json`);
  V.writeAtomic(f, JSON.stringify({ ...readJson(f, {}), waiting_since: V.now() }));
}

// ---------- alerts: the phone push goes out through a live non-launcher session (goal-gate calls these) ----------
// A queued alert is <coord>/alerts/<stamp>-<name>.json (recover.mjs raiseAlert). A claim renames it to
// claimed-<sid>-<ms>-<orig>; sent renames that to sent-<orig> (the only alert files the hourly prune deletes), release
// back to <orig>, with the releasing session added to its released_by; the tick releases a claim older than 15 min
// (recover.mjs releaseStaleClaims). Both use live.mjs CLAIMED.
// Bounds (a session that cannot push must never loop on an alert): one claim per user turn (relay: never on a
// continuation Stop), and a session never claims an alert it released (released_by); another session still may.
const ME = () => fileURLToPath(import.meta.url).split(path.sep).join("/");
// Claim one queued alert for session <sid>. The rename is atomic, so two sessions never claim the same alert.
// -> the block reason that asks the session to push it, or null (nothing queued, or sid not a plain id)
export async function claimAlert(sid) {
  if (!plainId(sid)) return null; // the id goes into a file name
  const { V } = await context();
  const dir = path.join(V.COORD, "alerts");
  let names = []; try { names = fs.readdirSync(dir).filter((f) => /^\d.*\.json$/.test(f)).sort(); } catch { return null; }
  for (const f of names) {
    const by = readJson(path.join(dir, f), {}).released_by;
    if (Array.isArray(by) && by.includes(sid)) continue; // this session released it: it could not push it
    const claimed = path.join(dir, `claimed-${sid}-${Date.now()}-${f}`);
    try { fs.renameSync(path.join(dir, f), claimed); } catch { continue; } // another session took it first
    const a = readJson(claimed, {}), c = claimed.split(path.sep).join("/");
    // An unreadable alert is still relayed: its file names the lane, and the session can read it.
    const text = str(a.text) ? a.text : `an alert whose file could not be read: ${c}`;
    return `Coordinator alert. Send this with PushNotification: ${text}\nThen run: node "${ME()}" alert-sent "${c}". If you can't, run: node "${ME()}" alert-release "${c}".`;
  }
  return null;
}
// <file> only when it is a claimed alert in this coordinator's alerts dir (never another path the caller names).
function claimedFile(V, file) {
  const dir = path.resolve(V.COORD, "alerts"), f = path.resolve(String(file || ""));
  return path.dirname(f).toLowerCase() === dir.toLowerCase() && V.CLAIMED.test(path.basename(f)) && fs.existsSync(f) ? f : null;
}
// to(orig) -> the new name; before(V, f, sid) runs on the claimed file first. A failure (the tick released the claim
// meanwhile) is said, never thrown.
async function moveClaim(file, to, done, before = null) {
  const { V } = await context(), f = claimedFile(V, file);
  if (!f) return `not a claimed alert: ${file}`;
  const [, sid, , orig] = V.CLAIMED.exec(path.basename(f));
  try { before?.(V, f, sid); fs.renameSync(f, path.join(path.dirname(f), to(orig))); } catch (e) { return `not moved: ${file} (${e?.code || e?.message || e})`; }
  return done;
}
// The releasing session goes into released_by (written atomically, before the rename), so its next Stop skips the
// alert. An unreadable file keeps its raw text beside the list.
const markReleased = (V, f, sid) => {
  let raw = ""; try { raw = fs.readFileSync(f, "utf8"); } catch {}
  const a = readJson(f, null) ?? { unreadable: raw }, by = Array.isArray(a.released_by) ? a.released_by : [];
  V.writeAtomic(f, JSON.stringify({ ...a, released_by: by.includes(sid) ? by : [...by, sid] }, null, 2));
};
export const alertSent = (file) => moveClaim(file, (orig) => `sent-${orig}`, "alert marked sent");
export const alertRelease = (file) => moveClaim(file, (orig) => orig, "alert released", markReleased);
// The Stop-hook relay, for goal-gate and the CLI: only in a session the launcher did not start, only on a fresh Stop
// (stop_hook_active false: at most one relay per user turn), and never when the turn ends with a question to the user
// or with background tasks running (the goal gate never blocks those either; the claim waits for the next Stop).
// -> claimAlert's reason or null
export async function relay(input, env = process.env) {
  if (env.HL_SESSION_ID || !isObj(input) || input.stop_hook_active) return null;
  if (String(input.last_assistant_message ?? "").trim().endsWith("?")) return null;
  if (Array.isArray(input.background_tasks) && input.background_tasks.length > 0) return null;
  return claimAlert(input.session_id);
}
// Start a tick if tick_min has passed since the last one (live.mjs triggerTick: detached, fails closed). -> bool
export async function startTick(by) { const { V, cfg } = await context(); return V.triggerTick(by, cfg.tick_min); }

// ---------- batch B, Parts 1-3: the status-line recorder, `pace`, the Agent gate ----------
// The pacer's thresholds: config.json "pace" (pace-lib paceConfig; missing or bad = the defaults).
const paceCfg = (P) => P.paceConfig(readJson(path.join(COORD, "config.json"), {})?.pace).pace;
// A status line the user had before the install (<coord>/statusline-chain.json {command}, written by the install) runs
// first with the same stdin; its output is printed first. 5 s at most; a failure prints nothing of it.
function chainOutput(raw) {
  const c = readJson(path.join(COORD, "statusline-chain.json"), null);
  if (!str(c?.command)) return "";
  // A chain that is itself `coord.mjs statusline` would spawn itself forever: never run it, and a child of a chain run
  // (HL_STATUSLINE_CHAINED) runs no chain of its own.
  if (process.env.HL_STATUSLINE_CHAINED || /coord\.mjs["']?\s+statusline\b/i.test(c.command)) return "";
  const opt = { input: raw, encoding: "utf8", timeout: 5000, windowsHide: true, env: { ...process.env, HL_STATUSLINE_CHAINED: "1" } };
  let r = null;
  // Claude Code runs status lines through Git Bash on Windows, so a chain written for it runs there too (bash -c);
  // the shell (cmd.exe) only when bash cannot be spawned.
  if (process.platform === "win32") {
    const git = "C:/Program Files/Git/bin/bash.exe"; // Git Bash before a WSL bash on PATH
    const exe = process.env.CLAUDE_CODE_GIT_BASH_PATH || (fs.existsSync(git) ? git : "bash");
    const b = spawnSync(exe, ["-c", c.command], opt);
    if (b.error?.code !== "ENOENT") r = b; // a timeout or other error: no second run under cmd.exe
  }
  if (!r) r = spawnSync(c.command, { ...opt, shell: true });
  return String(r.stdout || "").replace(/\s+$/, "");
}
// The effort the settings give this model when the status line's stdin has no effort.level: <config>/settings.json
// modelSettings[<model id>].effortLevel, else effortLevel. -> a word or null
function settingsEffort(input) {
  const s = readJson(path.join(CFG, "settings.json"), {}), id = input?.model?.id;
  const m = str(id) && isObj(s.modelSettings?.[id]) ? s.modelSettings[id].effortLevel : null;
  return str(m) ? m : str(s.effortLevel) ? s.effortLevel : null;
}
// Part 1. input: the status line's stdin (raw: its text, for the chained command). With rate_limits: this session's
// reading (usage/<session_id>.json, skipped when unchanged and under 60 s old), then pace.json when it is older than
// recompute_s (two sessions at once: the last atomic rename wins, harmless). Without: nothing is written. -> the text to
// print: the chained output, then pace-lib statusLineText's line (`◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26%
// relay │ 5h 6% │ wk 31% │ pace slow +12`; a missing field drops its segment). Never throws.
export async function statusline(input, raw = "") {
  const out = [];
  try { const c = chainOutput(raw); if (c) out.push(c); } catch {}
  try {
    const [P, IO] = await Promise.all([mod("pace-lib.mjs"), mod("pace-io.mjs")]);
    const cfg = paceCfg(P), now = Date.now(), reading = P.readingFromStatus(input, now);
    let pace = readJson(IO.PACE_FILE, null);
    if (reading) { // an IO failure (EPERM, EBUSY, pace.json a directory) must not blank the line
      try { IO.recordReading(input?.session_id, reading, now, cfg); } catch {}
      try { pace = IO.recomputePace({ now, cfg, minAgeMs: cfg.recompute_s * 1000 }).pace; } catch {}
    }
    // Part 8: the context of this session (the status line's own field, else its transcript's tail)
    const tokens = P.contextOfStatus(input) ?? contextOf(input?.transcript_path, P);
    const line = P.statusLineText({ input, reading, entry: P.paceFresh(pace, now, cfg)?.claude ?? null, tokens,
      cfg: P.ctxConfig(readJson(path.join(COORD, "config.json"), {})), effort: settingsEffort(input) });
    if (line) out.push(line);
  } catch {}
  return out.join("\n");
}
// `coord.mjs pace [--json]`: computed from the usage files now, written nowhere.
export async function paceReport(json) {
  const [P, IO] = await Promise.all([mod("pace-lib.mjs"), mod("pace-io.mjs")]);
  const { pace } = IO.recomputePace({ cfg: paceCfg(P), write: false });
  return json ? JSON.stringify(pace, null, 2) : P.paceTable(pace).join("\n");
}
// The session's priority for the gate: a launcher lane's effective priority (its registry entry, by HL_SESSION_ID); any
// other session - or a lane whose entry is not found - is high: the user is at it.
async function priorityOf(env) {
  if (!str(env.HL_SESSION_ID)) return "high";
  const [V, G] = await Promise.all([mod("live.mjs"), mod("lane-lib.mjs")]);
  const reg = V.readRegistry(), e = [...reg.entries].reverse().find((x) => x.id === env.HL_SESSION_ID);
  return e ? G.effectivePriority(reg.lines, e) : "high";
}
// Part 8: the last ~64 KB of a transcript -> its main thread's current context (pace-lib contextOfEntries), or null.
function contextOf(file, P) {
  if (!str(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, n = Math.min(size, 65536), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (n < size) lines.shift(); // a cut first line
    return P.contextOfEntries(lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
// A once-claim (exclusive create): of two gates of one session deciding the same notice at once, only the one that
// creates <marker>.<key> speaks. Claims are pruned with the markers (pace-seen/, 8 days by mtime). -> true for the winner
function claim(seenFile, key) {
  if (!seenFile) return false;
  try { fs.mkdirSync(path.dirname(seenFile), { recursive: true }); fs.writeFileSync(`${seenFile}.${key}`, "", { flag: "wx" }); return true; } catch { return false; }
}
// Part 3. Every session runs it (no early return without HL_SESSION_ID). A missing, stale (stale_min) or ok pace.json
// with no pause source file reads nothing more. Part 5: a pause source that covers the session's priority (pause-io
// pauseForNow) denies with the pause text. slow and above: a low-priority session is denied; any other gets one notice per
// state entry. Part 8: a main-thread call (a subagent's carries agent_id) past relay_ctx gets the context nudge
// (pace-lib ctxNudge) - never a denial. Both once-markers live in pace-seen/<session_id> ({since, ctx}); without a plain
// session id nothing is said. -> {deny} | {context} | null (allow, no output)
export async function agentGate(input, env = process.env) {
  if (!/^(Agent|Task)$/.test(String(input?.tool_name ?? ""))) return null; // the matcher's rule again: never TaskUpdate, TaskCreate, ...
  await maybePowerRefresh("agent-gate"); // B3: the battery source stays current while sessions work
  const P = await mod("pace-lib.mjs"), now = Date.now(), cfg = paceCfg(P);
  const sid = plainId(input?.session_id) ? input.session_id : null, notes = [];
  const seenFile = sid ? path.join(COORD, "pace-seen", sid) : null, seen = seenFile ? readJson(seenFile, {}) : {}, next = { ...seen };
  const pace = P.paceFresh(readJson(path.join(COORD, "pace.json"), null), now, cfg);
  const paceOn = !!pace && P.isEntry(pace.claude) && pace.claude.state !== "ok";
  // Part 5: cheap pre-filters; pause-io decides which sources apply.
  const files = ["pause/manual.json", "pause/battery.json", "pause.json"].some((f) => fs.existsSync(path.join(COORD, f))) || offNear(now);
  if (paceOn || files) {
    const priority = await priorityOf(env), PI = await mod("pause-io.mjs"), pause = PI.pauseForNow(priority, now);
    // A hand-opened session told it is paused is listed in the manifest (it is never closed: the user resumes it).
    if (pause.paused && !str(env.HL_SESSION_ID) && env.CLAUDE_CODE_ENTRYPOINT !== "sdk-cli") { try { PI.recordSeen({ session_id: input?.session_id, cwd: input?.cwd ?? null, reason: pause.reason }, now); } catch {} }
    // Off lifts pace pauses while keeping B1 pacing at the real priority (hold/exhausted act as slow).
    const gatePace = paceOn && PI.usagePauseOff() && ["hold", "exhausted"].includes(pace.claude.state)
      ? { ...pace, claude: { ...pace.claude, state: "slow" } } : pace;
    const d = P.gateDecision({ pace: paceOn ? gatePace : null, priority, pause });
    if (d?.deny) return { deny: d.deny };
    if (d?.notice && seen.since !== d.since && claim(seenFile, `p${d.since}`)) { notes.push(d.notice); next.since = d.since; }
  }
  try { // Part 8, main thread only; any error says nothing
    if (!input?.agent_id) {
      const n = P.ctxNudge({ tokens: contextOf(input?.transcript_path, P), seen: seen.ctx, now, cfg: P.ctxConfig(readJson(path.join(COORD, "config.json"), {})) });
      if (n && claim(seenFile, n.kind === "hard" ? `hard-${seen.ctx?.hard_at ?? 0}` : "relay")) { notes.push(n.text); next.ctx = n.ctx; }
    }
  } catch {}
  if (!notes.length || !seenFile) return null;
  // A marker that cannot be written must not lose the notice already decided. The once-claim (claim) already exists, so a
  // persistently failing marker write does not repeat the notice: it silences later nudges of the same key.
  try {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    (await mod("live.mjs")).writeAtomic(seenFile, JSON.stringify(next));
  } catch {}
  return { context: notes.join("\n") };
}

// ---------- Part 7 (B3): power ----------
// The hooks' cheap check: power.json read here (no import) and, when stale (60 s; an hour after successful NONE), the
// detached refresh triggered through pause-io (about once a minute). Never throws.
async function maybePowerRefresh(by) {
  try {
    const j = readJson(path.join(COORD, "power.json"), null), age = Date.now() - Date.parse(j?.at);
    if (age >= 0 && age < (!j?.failed && j?.battery === false ? 3600e3 : 60000)) return;
    (await mod("pause-io.mjs")).triggerPowerRefresh(by);
  } catch {}
}
// `coord.mjs power [--refresh]`: the probe now; --refresh also writes power.json and the battery source (pause-io
// refreshPower, their one writer). -> its line
export async function powerCmd(refresh) {
  const [PI, W] = await Promise.all([mod("pause-io.mjs"), mod("power.mjs")]);
  if (!refresh) return `power: ${PI.powerText(W.probePower())}`;
  const r = PI.refreshPower();
  return `power: ${PI.powerText(r.power)}${r.low ? " - low: every lane pauses" : ""}`;
}

// ---------- Part 4: the watcher (who wakes an idle machine) ----------
const WEEK_MS = 8 * 24 * 3600e3;
// One step: pace.json from the usage files, the sources, the open lanes that wrote {paused} and the lanes waiting for
// their resume - leaving out the ones the tick gave up on (alerted: a close skipped twice; failed: a relaunch failed
// twice), which nothing can act on until the user does. Every step starts from fresh liveness: the watcher lives for
// days and live.mjs memoizes liveness and the agents list per process. Stops when no source is active and nothing is
// paused or waiting, or 8 days after its start (a weekly window; the next tick restarts it if still needed). Runs a tick
// only when it can act - a paused lane is open (to close it), or a waiting lane's pause no longer applies (to relaunch
// it) - and, after a tick that closed and relaunched nothing, at most every 5 min. last: the previous tick {at, acted}.
// -> {stop: why} | {lines, ticked, last}
export async function watchStep({ now, started, last = null }) {
  if (now - started >= WEEK_MS) return { stop: "8 days since its start - the next tick restarts it if it is still needed" }; // before any work that can throw
  const [{ V, cfg }, IO, PI, Q, G] = await Promise.all([context(), mod("pace-io.mjs"), mod("pause-io.mjs"), mod("pause-lib.mjs"), mod("lane-lib.mjs")]);
  V.forgetLiveness(); // every id, and the agents list
  IO.recomputePace({ now, cfg: cfg.pace });
  try { if (readJson(PI.POWER, null)?.battery !== false || PI.powerStale(now)) PI.refreshPower(now); } catch {} // B3: battery every step; successful NONE for an hour
  const sources = PI.readSources(now), reg = V.readRegistry(), ts = readJson(PI.TICK_STATE, {});
  const alerted = new Set(Array.isArray(ts.alerted) ? ts.alerted : []), failed = isObj(ts.failed) ? ts.failed : {};
  // The paused-line check (and workedAfterPause: resumed by hand, not paused any more) comes BEFORE the liveness probe, so
  // only a paused open lane costs a probe per step.
  const openPaused = reg.entries.filter((e) => !reg.closed.has(e.id) && !alerted.has(e.id)
    && (() => { const line = Q.pausedLineOf(reg.lines, e); return !!line && !V.workedAfterPause(e, line); })()
    && V.liveness(e, reg).state !== "gone");
  const pending = Q.pausedLanes({ entries: reg.entries, lines: reg.lines, closed: reg.closed, gone: (e) => V.liveness(e, reg).state === "gone", now,
    activeAfter: (e, line) => V.workedAfterPause(e, line) }) // the tick's one pending rule (resumeScan)
    .filter(({ e }) => !((failed[e.id] || 0) >= 2));
  if (!sources.length && !openPaused.length && !pending.length) return { stop: "nothing is paused or waiting to resume" };
  const canResume = pending.some(({ e }) => !Q.pauseFor(G.effectivePriority(reg.lines, e), sources).paused);
  if (!openPaused.length && !canResume) return { lines: [], ticked: false, last };
  if (last && !last.acted && now - last.at < 5 * 60000) return { lines: [], ticked: false, last }; // backing off
  const lines = (await mod("recover.mjs")).tick();
  return { lines, ticked: true, last: { at: now, acted: lines.some((l) => /^(closed|relaunched) /.test(l)) } };
}
// `coord.mjs watch [--once] [--started <epoch ms>]`: the single-instance loop (watch.lock), a step every 60 s; its last
// step's lines in <coord>/watch-last.txt. --once (tests) runs one step; --started (tests) stands in for its start. -> lines
export async function watch({ once = false, started = Date.now(), intervalMs = 60000 } = {}) {
  const PI = await mod("pause-io.mjs");
  if (!PI.takeWatchLock()) return ["watch: another watcher runs"];
  const out = [];
  let last = null;
  try {
    for (;;) {
      let s; try { s = await watchStep({ now: Date.now(), started, last }); } catch (err) { s = { lines: [`watch: step failed (${err?.message || err})`], last }; }
      if (s.stop) { out.push(`watch: stopped - ${s.stop}`); break; }
      last = s.last ?? last;
      if (once) { out.push(...s.lines, s.ticked ? "watch: one step done (a tick ran)" : "watch: one step done"); break; }
      if (s.lines.length) { try { fs.writeFileSync(path.join(COORD, "watch-last.txt"), `${new Date().toISOString()}\n${s.lines.join("\n")}\n`); } catch {} }
      await new Promise((done) => setTimeout(done, intervalMs));
    }
  } finally { PI.releaseWatchLock(); }
  return out;
}
// `coord.mjs watch --stop`: the running watcher's tree is killed (only the process the lock names: watchHolder's check).
export async function watchStop() {
  const [PI, V] = await Promise.all([mod("pause-io.mjs"), mod("live.mjs")]);
  const h = PI.watchHolder();
  if (!h) { try { fs.rmSync(PI.WATCH_LOCK, { force: true }); } catch {} return "watch: no watcher running"; }
  if (!PI.watchVerified(h)) return `watch: ${h.pid ?? "the lock holder"} not stopped (not verified as the watcher: no matching start time)`;
  const k = V.killPidTree(h.pid);
  if (k.ok) { try { fs.rmSync(PI.WATCH_LOCK, { force: true }); } catch {} }
  return k.ok ? `watch: stopped ${h.pid}` : `watch: ${h.pid} not stopped (${k.why})`;
}

const stdinRaw = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
const stdin = () => { try { return JSON.parse(stdinRaw() || "{}"); } catch { return {}; } };
// Wait for the write before process.exit (a pipe may flush asynchronously); a closed pipe is ignored, not thrown.
const write = (text) => new Promise((done) => { process.stdout.on("error", done); process.stdout.write(text, done); });
async function main(argv) {
  const sub = argv[0];
  if (sub === "post-tool") {
    const c = await postTool(stdin());
    if (c) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: c } }));
  } else if (sub === "notify") await notify(stdin());
  else if (sub === "fence") {
    const reason = await fence(stdin());
    if (reason) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  } else if (sub === "lane-note") {
    const c = await laneNote(stdin());
    if (c) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: c } }));
  } else if (sub === "stop") {
    const reason = await stopCheck(stdin());
    if (reason) await write(JSON.stringify({ decision: "block", reason }));
  }
  else if (sub === "tick") {
    const R = await mod("recover.mjs"), lines = R.tick({ dryRun: argv.includes("--dry-run") });
    await write(`${lines.join("\n")}\n`);
    // tick() turns its own failure into a "tick failed:" line (after releasing tick.lock): still a failed tick.
    if (lines.some((l) => l.startsWith("tick failed:"))) return 1;
  } else if (sub === "relay") {
    const msg = await relay(stdin());
    if (msg) await write(JSON.stringify({ decision: "block", reason: msg }));
  } else if (sub === "alert-sent") await write(`${await alertSent(argv[1])}\n`);
  else if (sub === "alert-release") await write(`${await alertRelease(argv[1])}\n`);
  else if (sub === "statusline") {
    const raw = stdinRaw(); let input = {}; try { input = JSON.parse(raw || "{}"); } catch {}
    const line = await statusline(input, raw);
    if (line) await write(`${line}\n`);
  } else if (sub === "pace") await write(`${await paceReport(argv.includes("--json"))}\n`);
  else if (sub === "agent-gate") {
    const r = await agentGate(stdin());
    if (r?.deny) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.deny } }));
    else if (r?.context) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: r.context } }));
  } else if (sub === "power") await write(`${await powerCmd(argv.includes("--refresh"))}\n`);
  else if (sub === "watch") {
    if (argv.includes("--stop")) await write(`${await watchStop()}\n`);
    else {
      const i = argv.indexOf("--started"), started = i > 0 ? Number(argv[i + 1]) : Date.now();
      await write(`${(await watch({ once: argv.includes("--once"), started: Number.isFinite(started) ? started : Date.now() })).join("\n")}\n`);
    }
  } else if (sub === "shabbos") {
    const r = await shabbosCmd(argv.slice(1));
    await write(`${r.text}\n`);
    return r.code;
  } else if (sub === "pause" || sub === "resume" || sub === "usage-pause") {
    const r = sub === "pause" ? await pauseCmd(argv.slice(1)) : sub === "usage-pause" ? await usagePauseCmd(argv.slice(1)) : await resumeCmd();
    await write(`${r.text}
`);
    return r.code;
  }
  return 0;
}
const self = (p) => path.resolve(p || "").toLowerCase();
if (self(process.argv[1]) === self(fileURLToPath(import.meta.url))) {
  let code = 0;
  try { code = await main(process.argv.slice(2)); }
  catch (e) { // a hook's error is never shown; the commands a person runs say what failed
    const c = process.argv[2];
    if (c === "tick") { console.error(`tick failed: ${e?.stack || e}`); code = 1; }
    else if (c === "pause" || c === "resume" || c === "usage-pause" || c === "shabbos") { console.error(`${c} failed: ${e?.code || e?.message || e}`); code = 1; }
  }
  process.exit(code);
}
