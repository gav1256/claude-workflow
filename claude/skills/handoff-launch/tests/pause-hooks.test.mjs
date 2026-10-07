// Batch B, Parts 4-5 in the hooks: the Agent gate's pause denial, the lane Stop's {paused} line, goal-gate's paused stop.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun, sessionLine } from "./helpers.mjs";
import { PAUSE_TEXT } from "../pace-lib.mjs";

const SID = "11111111-2222-3333-4444-555555555555", HAND = "99999999-8888-7777-6666-555555555555";
const GOAL_GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "goal-gate.mjs");
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const gate = (sb, env, sid = SID) => coordRun(sb, ["agent-gate"], { input: { session_id: sid, cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {} }, env });
const out = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput : null);
const stop = (sb, env, o = {}) => coordRun(sb, ["stop"], { input: { session_id: SID, hook_event_name: "Stop", stop_hook_active: false, ...o }, env });
const paceHold = (sb, state = "hold") => put(path.join(sb.coord, "pace.json"), { updated: Date.now(), claude: { state, ahead: 22, week_ahead: 3, since: 5, windows: { five_hour: { state }, weekly: { state: "ok" } } } });
function lanes(sb) {
  sessionLine(sb, { name: "H", id: "H@1", branch: "h", effort: "xhigh", sid: "h-s1", supersedes: null }); // derived high
  sessionLine(sb, { name: "N", id: "N@1", branch: "n", effort: "high", sid: SID, supersedes: null });    // normal
  sessionLine(sb, { name: "L", id: "L@1", branch: "l", effort: "medium", sid: "l-s1", supersedes: null }); // low
}

test("agent gate under a manual pause: every lane and a hand-opened session are denied with the pause text; the hand-opened one is recorded", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    coordRun(sb, ["pause"]);
    for (const id of ["H@1", "N@1", "L@1"]) assert.deepEqual(out(gate(sb, { HL_SESSION_ID: id })), { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PAUSE_TEXT("manual pause", false) }, id);
    assert.equal(out(gate(sb, {}, HAND)).permissionDecision, "deny");
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause", "seen")), [`${HAND}.json`]); // lanes are never recorded there
    coordRun(sb, ["resume"]);
    assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }).out, "");
  } finally { sb.cleanup(); }
});

test("agent gate under pace hold: normal and low lanes paused; high lanes and hand-opened sessions get the notice; exhausted pauses everyone", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    paceHold(sb);
    assert.equal(out(gate(sb, { HL_SESSION_ID: "N@1" })).permissionDecisionReason, PAUSE_TEXT("pace hold (5h +22 / week +3)"));
    assert.equal(out(gate(sb, { HL_SESSION_ID: "L@1" })).permissionDecision, "deny");
    assert.match(out(gate(sb, { HL_SESSION_ID: "H@1" }, "h-s1")).additionalContext, /^Usage ahead of pace/);
    assert.match(out(gate(sb, {}, HAND)).additionalContext, /^Usage ahead of pace/);
    assert.equal(fs.existsSync(path.join(sb.coord, "pause", "seen")), false); // not paused: not recorded
    paceHold(sb, "exhausted");
    assert.equal(out(gate(sb, {}, "77777777-0000")).permissionDecision, "deny"); // the user's own session too, by design
  } finally { sb.cleanup(); }
});

test("lane Stop while paused appends one {paused} line per launch (a continuation Stop adds none); not paused: none", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    coordRun(sb, ["pause"]);
    const t0 = Date.now();
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, ""); // the stop itself is never blocked for a pause
    const t1 = Date.now();
    stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true }); // the goal gate's continuation: no second line
    const p = sb.registry().filter((o) => o.paused);
    assert.equal(p.length, 1);
    assert.ok(Date.parse(p[0].at) >= t0 - 1000 && Date.parse(p[0].at) <= t1, "the line is the first Stop's");
    assert.deepEqual([p[0].paused, p[0].name, p[0].group, p[0].reason, p[0].source, p[0].windows], ["N@1", "N", null, "manual pause", "manual", []]);
    paceHold(sb); coordRun(sb, ["resume"]); // hold only: a high lane is not paused
    stop(sb, { HL_SESSION_ID: "H@1" }, { session_id: "h-s1" });
    assert.equal(sb.registry().filter((o) => o.paused === "H@1").length, 0);
  } finally { sb.cleanup(); }
});

test("lane Stop: a new pause after a lifted one writes a new {paused} line (the newest predates the source's since)", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() - 60 * 60000).toISOString() });
    stop(sb, { HL_SESSION_ID: "N@1" });
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 1);
    stop(sb, { HL_SESSION_ID: "N@1" }); // the same pause: still one
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 1);
    coordRun(sb, ["resume"]);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() + 1000).toISOString() }); // a later pause
    stop(sb, { HL_SESSION_ID: "N@1" });
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 2);
  } finally { sb.cleanup(); }
});

test("lane Stop: a claude-in-chrome block goes first and writes no {paused} line on that Stop", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    coordRun(sb, ["pause"]);
    put(path.join(sb.coord, "sessions", `${SID}.json`), { chrome_turn: true, chrome_tabs: [7] });
    assert.match(JSON.parse(stop(sb, { HL_SESSION_ID: "N@1" }).out).reason, /claude-in-chrome tab/);
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, ""); // the next Stop ends the turn
    assert.equal(sb.registry().filter((o) => o.paused).length, 1);
  } finally { sb.cleanup(); }
});

test("goal-gate: a paused session with open GOAL items stops at once with `paused: <reason>`; unpaused it is blocked as before", () => {
  const sb = sandbox();
  try {
    const tp = path.join(sb.cfg, "projects", "proj", `${HAND}.jsonl`);
    const goal = path.join(sb.temp, "claude", "proj", HAND, "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(goal), { recursive: true }); fs.writeFileSync(goal, "# g\n- [ ] open item\n");
    const run = () => spawnSync(process.execPath, [GOAL_GATE], { env: sb.env, input: JSON.stringify({ session_id: HAND, transcript_path: tp, cwd: "/p", stop_hook_active: false, last_assistant_message: "done." }), encoding: "utf8" });
    assert.equal(JSON.parse(run().stdout).decision, "block");
    coordRun(sb, ["pause"]);
    const r = run();
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: "paused: manual pause" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "seen", `${HAND}.json`), "utf8")).cwd, "/p");
  } finally { sb.cleanup(); }
});

test("lane Stop: a newest {paused} line more than 1 min old is due again while the pause lasts (markPaused passes now)", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() - 60 * 60000).toISOString() });
    const old = { paused: "N@1", name: "N", group: null, at: new Date(Date.now() - 5 * 60000).toISOString(), reason: "manual pause", source: "manual", windows: [] };
    fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify(old) + "\n");
    stop(sb, { HL_SESSION_ID: "N@1" });
    const p = sb.registry().filter((o) => o.paused === "N@1");
    assert.equal(p.length, 2, "the 5 min old line is stale: a fresh one is written");
    stop(sb, { HL_SESSION_ID: "N@1" });
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 2, "the fresh one is not due");
  } finally { sb.cleanup(); }
});

test("a failed seen write never fails a hook: the gate still denies, goal-gate still stops paused", () => {
  const sb = sandbox();
  try {
    coordRun(sb, ["pause"]);
    fs.writeFileSync(path.join(sb.coord, "pause", "seen"), "not a directory"); // recordSeen cannot write below it
    assert.equal(out(gate(sb, {}, HAND)).permissionDecision, "deny");
    const tp = path.join(sb.cfg, "projects", "proj", `${HAND}.jsonl`);
    const r = spawnSync(process.execPath, [GOAL_GATE], { env: sb.env, input: JSON.stringify({ session_id: HAND, transcript_path: tp, cwd: "/p", stop_hook_active: false, last_assistant_message: "done." }), encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: "paused: manual pause" });
  } finally { sb.cleanup(); }
});
