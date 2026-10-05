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
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any hook error: exit 0
// and no output - a broken hook must never block a tool call. A failed tick exits 1 (its trigger never waits on it, so
// only a hand or scheduled run sees the code): an import failure is shown on stderr, a failure inside the tick is its
// "tick failed:" line; the tick itself records its lines in <coord>/last-tick.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const stdin = () => { try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; } };
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
  return 0;
}
const self = (p) => path.resolve(p || "").toLowerCase();
if (self(process.argv[1]) === self(fileURLToPath(import.meta.url))) {
  let code = 0;
  try { code = await main(process.argv.slice(2)); }
  catch (e) { if (process.argv[2] === "tick") { console.error(`tick failed: ${e?.stack || e}`); code = 1; } } // a hook's error is never shown
  process.exit(code);
}
