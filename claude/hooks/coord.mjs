// Coordinator hook entry (stage 2 of handoff-launch). Subcommands:
//   post-tool   PostToolUse hook of launcher sessions (launch.mjs passes it with --settings): stop delivery, notices
//               for looping subagents, the early warning, the claude-in-chrome tab set, the checklist lines (missing or
//               stale GOAL.md) and the tick trigger. Prints at most one additionalContext.
//   notify      Notification hook: records waiting_since, for permission prompts only.
//   fence       PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit): denies a write into another lane's worktree or the main
//               checkout with a one-line hint to queue it (batch A, Part 4).
//   lane-note   UserPromptSubmit hook: the live lanes of this repo, on the first prompt and when that set changes (Part 5).
//   stop        Stop hook: once per turn that used claude-in-chrome and left this session's tabs open (Part 8).
//   tick [--dry-run]  one coordinator tick (recover.mjs); --dry-run prints what it would do and writes nothing.
//   relay        Stop-hook helper: on a fresh Stop of a non-launcher session, claim one alert and ask the session to push it
//   alert-sent <file> | alert-release <file>   mark a claimed alert sent, or put it back
//   statusline   the GLOBAL statusLine command (batch B, Part 1): records this session's usage reading, refreshes pace.json
//                when older than 30 s, prints `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% │ 5h 6% │ wk 31%`
//   pace [--json]  the pacer's table (pace-lib.mjs), computed from the usage files now; writes nothing
//   agent-gate   the GLOBAL PreToolUse hook on Agent|Task (batch B, Part 3): denies a low-priority lane's dispatch while
//                the pace is slow or worse, and tells the others once per state entry to step effort down
//   pause [30m | 2h | until HH:MM] | resume   the manual pause source (batch B, Part 4; /broadcast runs them)
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
// while tabs stay open): a continuation returns before chrome_turn is read, so the flag is kept and the next fresh Stop
// reminds once, then clears it. -> the block reason, or null.
export async function stopCheck(input, env = process.env) {
  const sid = input?.session_id;
  if (!env.HL_SESSION_ID || !plainId(sid) || input.stop_hook_active) return null;
  const { V, L } = await context();
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
  if (state.chrome_turn !== true) return null;
  // Re-read before the write (as fence and laneNote do): a background subagent's post-tool may have written meanwhile.
  V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), chrome_turn: false }));
  const tabs = Array.isArray(state.chrome_tabs) ? state.chrome_tabs.filter(Number.isInteger) : [];
  return tabs.length ? L.CHROME_TABS_TEXT(tabs.length) : null;
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
  // the reason from the value just written, not a re-read of the file (a concurrent pause may have replaced it)
  const reason = Q.activeSources({ manual: { until: u.until, by, at: new Date(now).toISOString() } }, now)[0]?.reason ?? "manual pause";
  return { code: 0, text: `paused: ${reason}\nBroadcast: ${Q.PAUSE_TEXT(reason)}${started ? "" : "\nTick not started now; the next tick applies it."}` };
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
    started ? "The coordinator relaunches the closed lanes (this tick, or the watcher within a minute)." : "Tick not started now; the next tick relaunches the closed lanes.", "Broadcast: resume your saved work."].join("\n") };
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
// says nothing. slow and above (B1: hold and exhausted act as slow): a low-priority session is denied; any other gets one
// notice per state entry. Part 8: a main-thread call (a subagent's carries agent_id) past relay_ctx gets the context
// nudge (pace-lib ctxNudge) - never a denial. Both once-markers live in pace-seen/<session_id> ({since, ctx}); without a
// plain session id nothing is said. -> {deny} | {context} | null (allow, no output)
export async function agentGate(input, env = process.env) {
  if (!/^(Agent|Task)$/.test(String(input?.tool_name ?? ""))) return null; // the matcher's rule again: never TaskUpdate, TaskCreate, ...
  const P = await mod("pace-lib.mjs"), now = Date.now(), cfg = paceCfg(P);
  const sid = plainId(input?.session_id) ? input.session_id : null, notes = [];
  const seenFile = sid ? path.join(COORD, "pace-seen", sid) : null, seen = seenFile ? readJson(seenFile, {}) : {}, next = { ...seen };
  const pace = P.paceFresh(readJson(path.join(COORD, "pace.json"), null), now, cfg);
  if (pace && P.isEntry(pace.claude) && pace.claude.state !== "ok") {
    const d = P.gateDecision({ pace, priority: await priorityOf(env) });
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
  try { // a marker that cannot be written must not lose the notice already decided (it may repeat once)
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    (await mod("live.mjs")).writeAtomic(seenFile, JSON.stringify(next));
  } catch {}
  return { context: notes.join("\n") };
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
  } else if (sub === "pause" || sub === "resume") {
    const r = sub === "pause" ? await pauseCmd(argv.slice(1)) : await resumeCmd();
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
    else if (c === "pause" || c === "resume") { console.error(`${c} failed: ${e?.code || e?.message || e}`); code = 1; }
  }
  process.exit(code);
}
