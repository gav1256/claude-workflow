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
// A paused lane's turn end: the fresh Stop (blocked with the pause text, no line yet), then the continuation Stop the block
// causes (writes the line, allows). -> the fresh Stop's result.
const endTurn = (sb, env, o = {}) => { const r = stop(sb, env, o); stop(sb, env, { ...o, stop_hook_active: true }); return r; };
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

test("lane Stop while paused: the fresh Stop blocks with the pause text and writes no line; the continuation Stop writes it once; not paused: none", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    coordRun(sb, ["pause"]);
    const r = stop(sb, { HL_SESSION_ID: "N@1" }); // fresh: told to save state first (no end: the pause lasts until /broadcast resume)
    assert.deepEqual(JSON.parse(r.out), { decision: "block", reason: PAUSE_TEXT("manual pause", false) });
    assert.equal(sb.registry().filter((o) => o.paused).length, 0, "the line is written AFTER the save turn");
    const t0 = Date.now();
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true }).out, ""); // the continuation: line, allow
    const t1 = Date.now();
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, "", "a fresh line (< 1 min, same pause): no second block");
    stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true }); // no second line either
    const p = sb.registry().filter((o) => o.paused);
    assert.equal(p.length, 1);
    assert.ok(Date.parse(p[0].at) >= t0 - 1000 && Date.parse(p[0].at) <= t1 + 1000, "the line is the continuation Stop's");
    assert.deepEqual([p[0].paused, p[0].name, p[0].group, p[0].reason, p[0].source, p[0].windows], ["N@1", "N", null, "manual pause", "manual", []]);
    paceHold(sb); coordRun(sb, ["resume"]); // hold only: a high lane is not paused
    stop(sb, { HL_SESSION_ID: "H@1" }, { session_id: "h-s1" });
    assert.equal(sb.registry().filter((o) => o.paused === "H@1").length, 0);
  } finally { sb.cleanup(); }
});

test("lane Stop: the first paused Stop is a continuation: save prompt once, then the next continuation writes the line and allows", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    coordRun(sb, ["pause"]);
    const env = { HL_SESSION_ID: "N@1" }, continuation = { stop_hook_active: true };
    const stateFile = path.join(sb.coord, "sessions", `${SID}.json`);
    put(stateFile, { chrome_turn: true, chrome_tabs: [7], lane_hash: "keep" });
    const first = stop(sb, env, continuation);
    assert.notEqual(first.out, "", "the first continuation must deliver the save prompt");
    assert.deepEqual(JSON.parse(first.out), { decision: "block", reason: PAUSE_TEXT("manual pause", false) });
    assert.equal(sb.registry().filter((o) => o.paused).length, 0, "no line before the save turn, even after another hook blocked");
    const t0 = Date.now();
    assert.equal(stop(sb, env, continuation).out, "");
    const t1 = Date.now(), p = sb.registry().filter((o) => o.paused);
    assert.equal(p.length, 1);
    assert.ok(Date.parse(p[0].at) >= t0 && Date.parse(p[0].at) <= t1, "the line comes after the save turn");
    assert.deepEqual([p[0].paused, p[0].name, p[0].group, p[0].reason, p[0].source, p[0].windows], ["N@1", "N", null, "manual pause", "manual", []]);
    assert.equal(stop(sb, env, continuation).out, "", "no continuation block loop");
    assert.equal(sb.registry().filter((o) => o.paused).length, 1);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual([state.chrome_turn, state.chrome_tabs, state.lane_hash], [true, [7], "keep"], "the continuation preserves the other state fields");
    assert.deepEqual(JSON.parse(stop(sb, { HL_SESSION_ID: "L@1" }, { ...continuation, session_id: "l-s1" }).out), { decision: "block", reason: PAUSE_TEXT("manual pause", false) }, "each lane saves once");
    coordRun(sb, ["resume"]);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date().toISOString() });
    assert.deepEqual(JSON.parse(stop(sb, env, continuation).out), { decision: "block", reason: PAUSE_TEXT("manual pause", false) }, "a later pause needs its own save prompt");
    assert.equal(sb.registry().filter((o) => o.paused).length, 1);
    assert.equal(stop(sb, env, continuation).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 2);
    assert.equal(stop(sb, env, continuation).out, "", "the later pause also allows its next continuation");
  } finally { sb.cleanup(); }
});

test("lane Stop: a continuation never repeats the save block for the same pause when its line becomes stale", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() - 60 * 60000).toISOString() });
    const env = { HL_SESSION_ID: "N@1" }, continuation = { stop_hook_active: true };
    assert.deepEqual(JSON.parse(stop(sb, env, continuation).out), { decision: "block", reason: PAUSE_TEXT("manual pause", false) });
    assert.equal(stop(sb, env, continuation).out, "");
    const p = sb.registry().find((o) => o.paused);
    fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ ...p, at: new Date(Date.now() - 5 * 60000).toISOString() }) + "\n");
    assert.equal(stop(sb, env, continuation).out, "", "a stale line cannot cause a second continuation save block");
    assert.equal(sb.registry().filter((o) => o.paused).length, 3, "the due line is refreshed after the earlier save prompt");
    assert.equal(stop(sb, env, continuation).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 3);
  } finally { sb.cleanup(); }
});

test("lane Stop: a failed save marker write keeps the fresh save prompt and lets a continuation write the line without looping", () => {
  for (const fresh of [true, false]) {
    const sb = sandbox();
    try {
      lanes(sb);
      coordRun(sb, ["pause"]);
      const stateFile = path.join(sb.coord, "sessions", `${SID}.json`);
      fs.mkdirSync(stateFile, { recursive: true }); // writeAtomic's rename to this directory throws
      const env = { HL_SESSION_ID: "N@1" }, continuation = { stop_hook_active: true };
      const first = stop(sb, env, { stop_hook_active: !fresh });
      assert.equal(first.code, 0, first.err);
      if (fresh) {
        assert.notEqual(first.out, "", "a failed marker must not swallow the fresh save prompt");
        assert.deepEqual(JSON.parse(first.out), { decision: "block", reason: PAUSE_TEXT("manual pause", false) });
        assert.equal(sb.registry().filter((o) => o.paused).length, 0, "the fresh Stop still writes no line before saving");
      } else {
        assert.equal(first.out, "", "without a durable marker a continuation keeps the old allow behaviour");
        assert.equal(sb.registry().filter((o) => o.paused).length, 1, "a failed marker must not drop the line");
      }
      assert.equal(stop(sb, env, continuation).out, "");
      assert.equal(stop(sb, env, continuation).out, "", "a failed marker cannot cause a block loop");
      assert.equal(sb.registry().filter((o) => o.paused).length, 1);
      assert.ok(fs.statSync(stateFile).isDirectory());
    } finally { sb.cleanup(); }
  }
});

test("lane Stop: without a source start stamp, legacy and pace pauses keep fresh-prompt/continuation-write behaviour across pauses", () => {
  for (const source of ["manual", "pace"]) {
    const sb = sandbox();
    try {
      lanes(sb);
      const pauseFile = path.join(sb.coord, source === "manual" ? "pause.json" : "pace.json");
      const pause = () => put(pauseFile, source === "manual" ? { until: null } : { updated: Date.now(), claude: { state: "hold", ahead: 22, windows: { five_hour: { state: "hold" } } } });
      const stateFile = path.join(sb.coord, "sessions", `${SID}.json`);
      put(stateFile, { lane_hash: "keep" });
      const env = { HL_SESSION_ID: "N@1" }, continuation = { stop_hook_active: true };
      for (let i = 0; i < 2; i++) {
        const prev = sb.registry().filter((o) => o.paused).at(-1);
        if (prev) fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ ...prev, at: new Date(Date.now() - 5 * 60000).toISOString() }) + "\n");
        const before = sb.registry().filter((o) => o.paused).length;
        pause();
        assert.equal(stop(sb, env, continuation).out, "", "no stable per-pause stamp: a continuation allows as before");
        const p = sb.registry().filter((o) => o.paused);
        assert.equal(p.length, before + 1, "the continuation writes its due line");
        assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { lane_hash: "keep" }, "no shared null marker across pauses");
        fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ ...p.at(-1), at: new Date(Date.now() - 5 * 60000).toISOString() }) + "\n");
        const r = stop(sb, env);
        assert.notEqual(r.out, "", "a fresh Stop still prompts for a stale line");
        assert.equal(JSON.parse(r.out).decision, "block");
        assert.equal(sb.registry().filter((o) => o.paused).length, before + 2, "no line before the fresh save turn");
        assert.equal(stop(sb, env, continuation).out, "");
        assert.equal(stop(sb, env, continuation).out, "", "no continuation block loop");
        assert.equal(sb.registry().filter((o) => o.paused).length, before + 3);
        fs.rmSync(pauseFile);
        assert.equal(stop(sb, env, continuation).out, "");
      }
    } finally { sb.cleanup(); }
  }
});

test("lane Stop: a new pause after a lifted one writes a new {paused} line (the newest predates the source's since)", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() - 60 * 60000).toISOString() });
    endTurn(sb, { HL_SESSION_ID: "N@1" });
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 1);
    endTurn(sb, { HL_SESSION_ID: "N@1" }); // the same pause: still one
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 1);
    coordRun(sb, ["resume"]);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() + 1000).toISOString() }); // a later pause
    endTurn(sb, { HL_SESSION_ID: "N@1" });
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
    assert.match(JSON.parse(stop(sb, { HL_SESSION_ID: "N@1" }).out).reason, /^Paused \(manual pause\)/); // the next Stop: the pause text
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true });
    assert.equal(sb.registry().filter((o) => o.paused).length, 1);
  } finally { sb.cleanup(); }
});

test("lane Stop: a pause that ends by itself says so in the block text; a fresh Stop with no source covering the lane is not blocked and writes nothing", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    put(path.join(sb.coord, "pause", "manual.json"), { until: new Date(Date.now() + 60 * 60000).toISOString(), by: "t", at: new Date().toISOString() });
    const reason = JSON.parse(stop(sb, { HL_SESSION_ID: "N@1" }).out).reason;
    assert.match(reason, /Work resumes automatically/);
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    coordRun(sb, ["resume"]);
    paceHold(sb); // hold: a high lane is not covered
    assert.equal(stop(sb, { HL_SESSION_ID: "H@1" }, { session_id: "h-s1" }).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
  } finally { sb.cleanup(); }
});

test("lane Stop: a legacy {paused} line (no source, by name) is not a line for the B2 writer: the lane writes its own after the save turn", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    coordRun(sb, ["pause"]);
    fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ paused: "N", at: new Date().toISOString() }) + "\n");
    assert.match(JSON.parse(stop(sb, { HL_SESSION_ID: "N@1" }).out).reason, /^Paused \(manual pause\)/);
    stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true });
    assert.equal(sb.registry().filter((o) => o.paused === "N@1" && o.source === "manual").length, 1);
  } finally { sb.cleanup(); }
});

test("lane Stop: with no pause source file nothing is read or loaded (markPaused returns null at once)", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    assert.equal(fs.existsSync(path.join(sb.coord, "pause")), false);
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, "");
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true }).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
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
    assert.match(JSON.parse(stop(sb, { HL_SESSION_ID: "N@1" }).out).reason, /^Paused \(manual pause\)/, "stale: told to save state again");
    stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true });
    const p = sb.registry().filter((o) => o.paused === "N@1");
    assert.equal(p.length, 2, "the 5 min old line is stale: a fresh one is written");
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, "", "the fresh one is not due");
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 2);
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
