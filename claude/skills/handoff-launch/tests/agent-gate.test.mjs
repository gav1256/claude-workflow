// Batch B, Part 3: the global Agent gate (`coord.mjs agent-gate`) and its settings entries.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { sandbox, coordRun, sessionLine, appendLine, tx, COORD_MJS } from "./helpers.mjs";
import { SLOW_DENY_TEXT, SLOW_NOTICE_TEXT, CTX_RELAY_TEXT, CTX_HARD_TEXT, CTX_DEFAULTS } from "../pace-lib.mjs";

const MIN = 60000, SID = "11111111-2222-3333-4444-555555555555";
const FRAGMENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "settings.fragment.json");
const ev = (o = {}) => ({ session_id: SID, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "x", prompt: "y" }, ...o });
const gate = (sb, env = {}, input = ev()) => coordRun(sb, ["agent-gate"], { input, env });
const out = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput : null);
const entry = (state, o = {}) => ({ state, pct: 60, ahead: 12.4, resets_at: 1, week_pct: 40, week_ahead: 6, week_resets_at: 2, since: 1000, ...o });
function setPace(sb, state, o = {}, updated = Date.now()) {
  fs.mkdirSync(sb.coord, { recursive: true });
  fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated, claude: entry(state, o) }));
}

test("agent gate: absent, stale or ok pace.json allows with no output, in any session", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null }); // a low-priority lane
    assert.deepEqual([gate(sb, { HL_SESSION_ID: "L@1" }).out, gate(sb).out], ["", ""]);
    setPace(sb, "slow", {}, Date.now() - 16 * MIN);
    assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }).out, "");
    setPace(sb, "ok");
    assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }).out, "");
  } finally { sb.cleanup(); }
});

test("agent gate at slow: a low-priority lane is denied every time; normal, high and hand-opened sessions get one notice per state entry", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null });          // derived low
    sessionLine(sb, { name: "N", id: "N@1", branch: "n", effort: "high", supersedes: null }); // normal
    setPace(sb, "slow");
    for (let i = 0; i < 2; i++) {
      const d = out(gate(sb, { HL_SESSION_ID: "L@1" }));
      assert.deepEqual(d, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SLOW_DENY_TEXT(entry("slow")) });
    }
    assert.deepEqual(out(gate(sb, { HL_SESSION_ID: "N@1" })), { hookEventName: "PreToolUse", additionalContext: SLOW_NOTICE_TEXT(entry("slow")) });
    assert.equal(gate(sb, { HL_SESSION_ID: "N@1" }).out, ""); // once per since
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace-seen", SID), "utf8")), { since: 1000 });
    const other = "22222222-3333-4444-5555-666666666666"; // a hand-opened session: high, its own marker
    assert.ok(out(gate(sb, {}, ev({ session_id: other }))).additionalContext);
    assert.equal(gate(sb, {}, ev({ session_id: other })).out, "");
    setPace(sb, "hold", { since: 2000 }); // a new state entry: told again
    assert.ok(out(gate(sb, {}, ev({ session_id: other }))).additionalContext);
    assert.equal(out(gate(sb, { HL_SESSION_ID: "L@1" })).permissionDecision, "deny"); // B1: hold acts as slow
  } finally { sb.cleanup(); }
});

test("agent gate: a hand-set priority wins over the derived one; an unknown HL_SESSION_ID counts as high", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null });
    appendLine(sb, { priority: "L", group: null, value: "normal", at: new Date().toISOString() });
    setPace(sb, "slow");
    assert.ok(out(gate(sb, { HL_SESSION_ID: "L@1" })).additionalContext); // normal now: a notice, no denial
    assert.ok(out(gate(sb, { HL_SESSION_ID: "nobody@1" }, ev({ session_id: "33333333-0000" }))).additionalContext);
  } finally { sb.cleanup(); }
});

test("agent gate fails open: garbage stdin, a corrupt pace.json, a non-plain session id, a missing skill folder", () => {
  const sb = sandbox();
  try {
    setPace(sb, "slow");
    for (const input of ["{oops", "", ev({ session_id: "../x" })]) {
      const r = gate(sb, {}, input);
      assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    }
    fs.writeFileSync(path.join(sb.coord, "pace.json"), "{not json");
    assert.equal(gate(sb).out, "");
    setPace(sb, "slow");
    const r = gate(sb, { HL_SKILL_DIR: path.join(sb.tmp, "missing") });
    assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
  } finally { sb.cleanup(); }
});

test("agent gate: only Agent and Task calls are judged - TaskUpdate, TaskCreate and the other Task* tools never (an unanchored matcher would fire on them)", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null });
    setPace(sb, "slow");
    for (const tool of ["TaskUpdate", "TaskCreate", "TaskStop", "TaskList", "Agentic"]) assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }, ev({ tool_name: tool })).out, "", tool);
    for (const tool of ["Agent", "Task"]) assert.equal(out(gate(sb, { HL_SESSION_ID: "L@1" }, ev({ tool_name: tool }))).permissionDecision, "deny", tool);
    assert.ok(new RegExp(JSON.parse(fs.readFileSync(FRAGMENT, "utf8")).hooks.PreToolUse[0].matcher).test("Task"));
    assert.ok(!new RegExp(JSON.parse(fs.readFileSync(FRAGMENT, "utf8")).hooks.PreToolUse[0].matcher).test("TaskUpdate")); // anchored
  } finally { sb.cleanup(); }
});

test("agent gate: two dispatches at once in one session say a notice once (the wx claim decides)", async () => {
  const sb = sandbox();
  try {
    setPace(sb, "slow");
    const one = () => new Promise((done) => {
      const p = spawn(process.execPath, [COORD_MJS, "agent-gate"], { env: sb.env, windowsHide: true });
      let o = ""; p.stdout.on("data", (x) => (o += x)); p.on("close", () => done(o));
      p.stdin.end(JSON.stringify(ev()));
    });
    const outs = await Promise.all(Array.from({ length: 6 }, one));
    assert.equal(outs.filter((o) => o.includes("additionalContext")).length, 1);
    assert.ok(fs.existsSync(path.join(sb.coord, "pace-seen", `${SID}.p1000`)));
  } finally { sb.cleanup(); }
});

test("settings.fragment.json: the global statusLine and the PreToolUse Agent gate point at coord.mjs; the Stop hook is kept", () => {
  const f = JSON.parse(fs.readFileSync(FRAGMENT, "utf8"));
  assert.deepEqual(f.statusLine, { type: "command", command: 'node "__HOME__/.claude/hooks/coord.mjs" statusline', padding: 0 });
  assert.deepEqual(f.hooks.PreToolUse, [{ matcher: "^(Agent|Task)$", hooks: [{ type: "command", command: 'node "__HOME__/.claude/hooks/coord.mjs" agent-gate', timeout: 10 }] }]);
  assert.match(f.hooks.Stop[0].hooks[0].command, /goal-gate\.mjs/);
  assert.equal(f.statusLine.refreshInterval, undefined); // no timer: every run follows a real event
});

// Part 8: a transcript whose last main-thread assistant message used `tokens` of context.
const transcript = (sb, tokens) => { const f = path.join(sb.tmp, `t-${tokens}.jsonl`); fs.writeFileSync(f, tx({ start: Date.now() - MIN }).tokens(tokens - 1000, 900, 100).user("go").call("Read", { file_path: "x" }).entries().map((x) => JSON.stringify(x)).join("\n") + "\n"); return f; };
const ctxGate = (sb, tokens, o = {}, env = {}) => gate(sb, env, ev({ transcript_path: transcript(sb, tokens), ...o }));
const marker = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "pace-seen", SID), "utf8"));

test("context nudge: past relay_ctx one line, once; past hard_ctx at most every 10 min; under it nothing; a subagent's call never; never a denial", () => {
  const sb = sandbox();
  try {
    assert.equal(ctxGate(sb, 200000).out, "");
    assert.deepEqual(out(ctxGate(sb, 263000)), { hookEventName: "PreToolUse", additionalContext: CTX_RELAY_TEXT(263000, CTX_DEFAULTS) });
    assert.match(CTX_RELAY_TEXT(263000, CTX_DEFAULTS), /^Context 263k is past the 250k relay rule: this dispatch is your task boundary\. Relay with handoff-launch after it/);
    assert.equal(ctxGate(sb, 270000).out, ""); // once
    assert.equal(ctxGate(sb, 402000, { agent_id: "ag1" }).out, ""); // a subagent's call: skipped
    assert.deepEqual(out(ctxGate(sb, 402000)), { hookEventName: "PreToolUse", additionalContext: CTX_HARD_TEXT(402000, CTX_DEFAULTS) });
    assert.equal(CTX_HARD_TEXT(402000, CTX_DEFAULTS), "Context 402k is past the 400k hard cap: write the handoff and relay now.");
    assert.equal(ctxGate(sb, 405000).out, ""); // within 10 min
    const m = marker(sb);
    fs.writeFileSync(path.join(sb.coord, "pace-seen", SID), JSON.stringify({ ...m, ctx: { ...m.ctx, hard_at: Date.now() - 11 * MIN } }));
    assert.equal(out(ctxGate(sb, 410000)).additionalContext, CTX_HARD_TEXT(410000, CTX_DEFAULTS)); // 10 min later: again
    for (const r of [ctxGate(sb, 263000), ctxGate(sb, 500000)]) assert.equal(r.out ? out(r).permissionDecision : undefined, undefined);
  } finally { sb.cleanup(); }
});

test("context nudge with the pace notice: both lines, both markers; a pace denial wins; thresholds from config.json; errors allow", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "N", id: "N@1", effort: "high", sid: SID, supersedes: null });
    sessionLine(sb, { name: "L", id: "L@1", branch: "l", effort: "medium", supersedes: null });
    setPace(sb, "slow");
    assert.equal(out(ctxGate(sb, 263000, {}, { HL_SESSION_ID: "N@1" })).additionalContext, `${SLOW_NOTICE_TEXT(entry("slow"))}\n${CTX_RELAY_TEXT(263000, CTX_DEFAULTS)}`);
    assert.deepEqual(marker(sb), { since: 1000, ctx: { relay: true } });
    assert.equal(out(ctxGate(sb, 263000, {}, { HL_SESSION_ID: "L@1" })).permissionDecision, "deny"); // low at slow
    fs.rmSync(path.join(sb.coord, "pace.json")); fs.rmSync(path.join(sb.coord, "pace-seen"), { recursive: true }); // the markers and their claims
    fs.writeFileSync(path.join(sb.coord, "config.json"), JSON.stringify({ relay_ctx: 100000, hard_ctx: "x" }));
    assert.equal(out(ctxGate(sb, 120000)).additionalContext, CTX_RELAY_TEXT(120000, { ...CTX_DEFAULTS, relay_ctx: 100000 }));
    for (const tp of [path.join(sb.tmp, "missing.jsonl"), sb.tmp]) {
      const r = gate(sb, {}, ev({ transcript_path: tp }));
      assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    }
    const junk = path.join(sb.tmp, "junk.jsonl"); fs.writeFileSync(junk, "{oops\nnot json\n");
    assert.equal(gate(sb, {}, ev({ transcript_path: junk })).out, "");
  } finally { sb.cleanup(); }
});

test("agent gate: a marker that cannot be written still returns the notice", () => {
  const sb = sandbox();
  try {
    setPace(sb, "slow");
    fs.mkdirSync(path.join(sb.coord, "pace-seen", SID), { recursive: true }); // the marker path is a directory: the write fails
    assert.deepEqual(out(gate(sb)), { hookEventName: "PreToolUse", additionalContext: SLOW_NOTICE_TEXT(entry("slow")) });
  } finally { sb.cleanup(); }
});
