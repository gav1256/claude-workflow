// Batch A's session hooks with fake stdin: the write fence (Part 4), the lane note (Part 5), the claude-in-chrome Stop
// check (Part 8), the checklist lines of post-tool and goal-gate (Part 9). Every hook fails open.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun, sessionLine, writeTranscript, tx, appendLine } from "./helpers.mjs";
import { GOAL_MISSING_TEXT, GOAL_STALE_TEXT, CHROME_TABS_TEXT } from "../recover-lib.mjs";
import { key, stem } from "../merge-lib.mjs";
import { sessionHooks } from "../live.mjs";

const SID = "11111111-2222-3333-4444-555555555555";
const GOAL_GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "goal-gate.mjs");
const fwd = (p) => p.split(path.sep).join("/");
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "sessions", `${SID}.json`), "utf8"));
// Three lanes of one repo: A (this session, lane-a), B (lane-b), M on the main checkout.
function lanes(sb) {
  const wt = (b) => fwd(path.join(sb.repo, ".claude", "worktrees", b));
  const a = sessionLine(sb, { name: "A", id: "A@1", branch: "lane-a", worktree: wt("lane-a"), sid: SID, supersedes: null, scope: "Stage A" });
  sessionLine(sb, { name: "B", id: "B@1", branch: "lane-b", worktree: wt("lane-b"), sid: "b-s1", supersedes: null, scope: "Stage B" });
  sessionLine(sb, { name: "M", id: "M@1", branch: "main", worktree: fwd(sb.repo), sid: "m-s1", supersedes: null });
  return { a, wt };
}
const fence = (sb, filePath, o = {}) => coordRun(sb, ["fence"], { input: { session_id: SID, cwd: o.cwd, hook_event_name: "PreToolUse", tool_name: o.tool || "Write", tool_input: o.input || { file_path: filePath, content: "x" } }, env: o.env ?? { HL_SESSION_ID: "A@1" } });
const denial = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput : null);

test("the write fence allows the own worktree, config, temp, .superpowers, an agent worktree and other repos; denies other lanes and the main checkout", () => {
  const sb = sandbox();
  try {
    const { wt } = lanes(sb), cwd = wt("lane-a");
    for (const p of [path.join(wt("lane-a"), "src", "a.js"), "rel/b.js", path.join(sb.cfg, "experiments", "ledger.md"), path.join(sb.temp, "claude", "x", "GOAL.md"),
      path.join(sb.repo, ".superpowers", "sessions", "g", "A.done"), path.join(sb.repo, ".claude", "worktrees", "agent-77", "f.js"), path.join(sb.tmp, "other-repo", "f.js")]) {
      const r = fence(sb, p, { cwd });
      assert.equal(r.code, 0, r.err); assert.equal(r.out, "", p);
    }
    let r = fence(sb, path.join(wt("lane-b"), "src", "b.js"), { cwd });
    const d = denial(r);
    assert.deepEqual([d.hookEventName, d.permissionDecision], ["PreToolUse", "deny"]);
    assert.match(d.permissionDecisionReason, /^Write fence: .*\/\.claude\/worktrees\/lane-b\/src\/b\.js belongs to lane B \(lane-b\), not to this lane \(.*\/\.claude\/worktrees\/lane-a\)\. Do not edit it from here\. Queue the change: node .*launch\.mjs queue --to B --text "<what to change>" \[--after-merge\], or tell the user\.$/);
    r = fence(sb, null, { cwd, tool: "NotebookEdit", input: { notebook_path: path.join(sb.repo, "nb.ipynb") } });
    assert.match(denial(r).permissionDecisionReason, /belongs to the main checkout \(lane M, main\), not to this lane/);
    assert.equal(state(sb).fence.own, key(wt("lane-a"))); // cached: later calls under the own root read no registry
  } finally { sb.cleanup(); }
});

test("the write fence fails open: no HL_SESSION_ID, an unknown entry, garbage stdin, a missing skill folder", () => {
  const sb = sandbox();
  try {
    const { wt } = lanes(sb), p = path.join(wt("lane-b"), "b.js");
    for (const r of [fence(sb, p, { env: {} }), fence(sb, p, { env: { HL_SESSION_ID: "nobody@1" } }),
      coordRun(sb, ["fence"], { input: "{garbage", env: { HL_SESSION_ID: "A@1" } }),
      fence(sb, p, { env: { HL_SESSION_ID: "A@1", HL_SKILL_DIR: path.join(sb.tmp, "missing") } })]) {
      assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    }
  } finally { sb.cleanup(); }
});

test("the write fence: its own entry unknown allows before any decision; only OPEN entries of the SAME repo own a worktree (Task 2 carry)", () => {
  const sb = sandbox();
  try {
    const { wt } = lanes(sb), cwd = wt("lane-a"), main = path.join(sb.repo, "shared.txt");
    assert.match(denial(fence(sb, main, { cwd })).permissionDecisionReason, /belongs to the main checkout/); // the control
    // With no own entry there is no own root: fenceDecision would deny the main checkout, so the hook allows first.
    let r = fence(sb, main, { cwd, env: { HL_SESSION_ID: "nobody@1" } });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    // A lane of another repo whose worktree sits in this repo's worktrees dir owns nothing here.
    sessionLine(sb, { name: "X", id: "X@1", repo: path.join(sb.tmp, "other-repo"), branch: "lane-x", worktree: wt("lane-x"), sid: "x-s1", supersedes: null });
    assert.equal(fence(sb, path.join(wt("lane-x"), "f.js"), { cwd }).out, "");
    // A closed lane's worktree is no longer fenced (an unowned <main>/.claude/worktrees/<x>).
    assert.match(denial(fence(sb, path.join(wt("lane-b"), "f.js"), { cwd })).permissionDecisionReason, /belongs to lane B/);
    appendLine(sb, { closed: "B", id: "B@1", at: new Date().toISOString(), why: "test" });
    r = fence(sb, path.join(wt("lane-b"), "f.js"), { cwd });
    assert.equal(r.code, 0); assert.equal(r.out, "");
  } finally { sb.cleanup(); }
});

test("the lane note: on the first prompt, again only when the live-lane set changes; lanes.json first, the registry when it is missing or stale", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    const note = () => { const r = coordRun(sb, ["lane-note"], { input: { session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "go" }, env: { HL_SESSION_ID: "A@1" } }); assert.equal(r.code, 0, r.err); return r.out ? JSON.parse(r.out).hookSpecificOutput : null; };
    let n = note();
    assert.equal(n.hookEventName, "UserPromptSubmit");
    assert.match(n.additionalContext, /^Lane note: you are lane A \(branch lane-a, .*lane-a, priority normal\)\. Other live lanes in this repo: (B \(lane-b, Stage B\)|M \(main\)); (B \(lane-b, Stage B\)|M \(main\))\. A request meant for another lane/);
    assert.equal(note(), null); // unchanged: nothing
    const lj = path.join(sb.coord, "lanes.json"), rk = key(sb.repo);
    fs.writeFileSync(lj, JSON.stringify({ at: new Date().toISOString(), repos: { [rk]: [{ id: "A@1", name: "A", branch: "lane-a", worktree: "x", priority: "high" }, { id: "C@1", name: "C", branch: "lane-c", scope: null }] } }));
    n = note();
    assert.equal(n.additionalContext, `Lane note: you are lane A (branch lane-a, ${key(path.join(sb.repo, ".claude", "worktrees", "lane-a"))}, priority high). Other live lanes in this repo: C (lane-c). `
      + "A request meant for another lane: say it belongs to that lane and offer launch.mjs queue --to <lane>. Work on files another live lane is changing: queue it with --after-merge.");
    fs.writeFileSync(lj, JSON.stringify({ at: new Date(Date.now() - 31 * 60000).toISOString(), repos: { [rk]: [] } })); // stale: the registry again
    assert.match(note().additionalContext, /Other live lanes in this repo: .*B \(lane-b, Stage B\)/);
    assert.equal(coordRun(sb, ["lane-note"], { input: { session_id: SID }, env: {} }).out, "");
  } finally { sb.cleanup(); }
});

test("the lane note shows the DERIVED priority of a lane named high: a lane's name is never read as its priority (Task 2 carry)", () => {
  const sb = sandbox();
  try {
    const wt = (b) => fwd(path.join(sb.repo, ".claude", "worktrees", b));
    // effort medium derives low; no {priority} line. Lane Z's launch line carries priority "high" (a launch field, not a
    // {priority: "high"} event line for the lane named high).
    sessionLine(sb, { name: "high", id: "high@1", branch: "lane-high", worktree: wt("lane-high"), sid: SID, supersedes: null, effort: "medium" });
    sessionLine(sb, { name: "Z", id: "Z@1", branch: "lane-z", worktree: wt("lane-z"), sid: "z-s1", supersedes: null, priority: "high" });
    const r = coordRun(sb, ["lane-note"], { input: { session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "go" }, env: { HL_SESSION_ID: "high@1" } });
    assert.equal(r.code, 0, r.err);
    assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /^Lane note: you are lane high \(branch lane-high, .*lane-high, priority low\)\. Other live lanes in this repo: Z \(lane-z\)\./);
  } finally { sb.cleanup(); }
});

test("claude-in-chrome: post-tool tracks this session's tabs; Stop blocks once per turn that left them open", () => {
  const sb = sandbox();
  try {
    const post = (tool, input, response) => coordRun(sb, ["post-tool"], { input: { session_id: SID, transcript_path: "/t/x.jsonl", tool_name: tool, tool_input: input, tool_response: response }, env: { HL_SESSION_ID: "A@1" } });
    const stop = (o = {}) => coordRun(sb, ["stop"], { input: { session_id: SID, hook_event_name: "Stop", stop_hook_active: false, ...o }, env: { HL_SESSION_ID: "A@1" } });
    post("mcp__claude-in-chrome__tabs_context_mcp", { createIfEmpty: true }, [{ type: "text", text: JSON.stringify({ availableTabs: [{ tabId: 11, title: "New Tab" }, { tabId: 12, title: "x" }], tabGroupId: 3 }) }]);
    assert.deepEqual(state(sb).chrome_tabs, [11, 12]);
    let r = stop();
    assert.deepEqual(JSON.parse(r.out), { decision: "block", reason: CHROME_TABS_TEXT(2) });
    assert.equal(stop().out, ""); // once per turn
    post("mcp__claude-in-chrome__tabs_close_mcp", { tabId: 11 }, "closed");
    assert.equal(stop({ stop_hook_active: true }).out, ""); // never on a continuation
    post("mcp__claude-in-chrome__tabs_close_mcp", { tabId: 12 }, "closed");
    assert.equal(stop().out, ""); // all closed
    assert.equal(coordRun(sb, ["stop"], { input: "{x", env: { HL_SESSION_ID: "A@1" } }).out, "");
  } finally { sb.cleanup(); }
});

test("claude-in-chrome: a continuation Stop never blocks and keeps the turn's flag; the next fresh Stop reminds once and clears it (plan amendment 4)", () => {
  const sb = sandbox();
  try {
    const post = (tool, input, response) => coordRun(sb, ["post-tool"], { input: { session_id: SID, transcript_path: "/t/x.jsonl", tool_name: tool, tool_input: input, tool_response: response }, env: { HL_SESSION_ID: "A@1" } });
    const stop = (o = {}) => coordRun(sb, ["stop"], { input: { session_id: SID, hook_event_name: "Stop", stop_hook_active: false, ...o }, env: { HL_SESSION_ID: "A@1" } });
    post("mcp__claude-in-chrome__tabs_create_mcp", { url: "about:blank" }, [{ type: "text", text: JSON.stringify({ tabId: 21, url: "about:blank" }) }]);
    assert.deepEqual([state(sb).chrome_tabs, state(sb).chrome_turn], [[21], true]);
    for (let i = 0; i < 3; i++) { const r = stop({ stop_hook_active: true }); assert.equal(r.code, 0); assert.equal(r.out, ""); } // tabs open, a continuation: never
    assert.equal(state(sb).chrome_turn, true); // the flag is kept
    assert.deepEqual(JSON.parse(stop().out), { decision: "block", reason: CHROME_TABS_TEXT(1) });
    assert.equal(state(sb).chrome_turn, false); // cleared
    assert.equal(stop().out, "");
    assert.equal(stop({ stop_hook_active: true }).out, "");
    // Outside a launcher session the Stop hook does nothing.
    post("mcp__claude-in-chrome__tabs_create_mcp", {}, [{ type: "text", text: JSON.stringify({ tabId: 22 }) }]);
    assert.equal(coordRun(sb, ["stop"], { input: { session_id: SID, stop_hook_active: false }, env: {} }).out, "");
  } finally { sb.cleanup(); }
});

test("post-tool checklist lines: the missing line once after goal_missing_calls main calls; the stale line once per window", () => {
  const sb = sandbox();
  try {
    const tp = path.join(sb.tmp, "projects", "C--proj", `${SID}.jsonl`);
    const call = (o = {}) => { const r = coordRun(sb, ["post-tool"], { input: { session_id: SID, transcript_path: tp, tool_name: "Read", tool_input: { file_path: `f${Math.random()}` }, ...o }, env: { HL_SESSION_ID: "A@1" } }); return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : null; };
    const gp = path.join(sb.temp, "claude", "C--proj", SID, "scratchpad", "GOAL.md");
    const outs = Array.from({ length: 10 }, () => call());
    assert.deepEqual(outs.slice(0, 9), Array(9).fill(null));
    assert.equal(outs[9], GOAL_MISSING_TEXT(gp));
    assert.equal(call(), null);
    fs.mkdirSync(path.dirname(gp), { recursive: true }); fs.writeFileSync(gp, "# g\n- [x] a\n- [ ] b\n");
    const t = new Date(Date.now() - 50 * 60000); fs.utimesSync(gp, t, t);
    const work = Array.from({ length: 5 }, (_, i) => call({ tool_name: "Edit", tool_input: { file_path: `e${i}` } }));
    assert.deepEqual(work.slice(0, 4), [null, null, null, null]);
    assert.equal(work[4], GOAL_STALE_TEXT(50));
    assert.equal(call({ tool_name: "Edit", tool_input: { file_path: "e9" } }), null);
  } finally { sb.cleanup(); }
});

test("post-tool: a checklist line due on a call where steps 1-4 speak waits for the next call, never lost", () => {
  const sb = sandbox();
  try {
    const tp = path.join(sb.tmp, "projects", "C--proj", `${SID}.jsonl`);
    const call = (o = {}) => { const r = coordRun(sb, ["post-tool"], { input: { session_id: SID, transcript_path: tp, tool_name: "Read", tool_input: { file_path: `f${Math.random()}` }, ...o }, env: { HL_SESSION_ID: "A@1" } }); return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : null; };
    const gp = path.join(sb.temp, "claude", "C--proj", SID, "scratchpad", "GOAL.md");
    assert.deepEqual(Array.from({ length: 9 }, () => call()), Array(9).fill(null));
    const d = path.join(sb.reg, "stops"); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${stem("A@1")}.manual.stop.json`), JSON.stringify({ id: "A@1", token: "t1", text: "STOP NOW", at: new Date().toISOString() }));
    assert.equal(call(), "STOP NOW"); // the 10th main call: the stop wins
    assert.equal(call(), GOAL_MISSING_TEXT(gp)); // the missing line follows
    assert.equal(call(), null);
  } finally { sb.cleanup(); }
});

test("goal-gate: a hand-opened session with 10+ tool calls and no GOAL.md is nudged once; never in print mode, a one-shot run, a launcher session or a continuation", () => {
  const sb = sandbox();
  try {
    const gate = (input, env = {}) => { const r = spawnSync(process.execPath, [GOAL_GATE], { env: { ...sb.env, ...env }, input: JSON.stringify(input), encoding: "utf8" }); return { code: r.status, out: r.stdout }; };
    let t = tx({ start: Date.now() - 30 * 60000 }).user("first");
    for (let i = 0; i < 6; i++) t = t.call("Read", { file_path: `a${i}` });
    t = t.say("ok").user("second");
    for (let i = 0; i < 6; i++) t = t.call("Bash", { command: `b${i}` });
    const tp = writeTranscript(sb, path.join(sb.tmp, "hand"), "h-s1", t.say("done").entries());
    const want = path.join(sb.temp, "claude", path.basename(path.dirname(tp)), "h-s1", "scratchpad", "GOAL.md");
    const input = { session_id: "h-s1", transcript_path: tp, stop_hook_active: false, last_assistant_message: "done", background_tasks: [] };
    for (const [i, env] of [[{ ...input, stop_hook_active: true }, {}], [{ ...input, last_assistant_message: "ok?" }, {}], [{ ...input, background_tasks: [{ id: "b1" }] }, {}],
      [input, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }], [input, { HL_SESSION_ID: "X@1" }]]) assert.equal(gate(i, env).out, "");
    const r = gate(input);
    assert.deepEqual(JSON.parse(r.out), { decision: "block", reason: GOAL_MISSING_TEXT(want) });
    assert.ok(fs.existsSync(path.join(sb.cfg, "goals", ".nudged-h-s1")));
    assert.equal(gate(input).out, ""); // once per session
    // A one-shot run (a single user prompt) is never nudged.
    let one = tx({ start: Date.now() - 30 * 60000 }).user("only");
    for (let i = 0; i < 12; i++) one = one.call("Read", { file_path: `o${i}` });
    const tp1 = writeTranscript(sb, path.join(sb.tmp, "hand"), "h-s2", one.say("done").entries());
    assert.equal(gate({ ...input, session_id: "h-s2", transcript_path: tp1 }).out, "");
  } finally { sb.cleanup(); }
});

test("goal-gate: the nudge counts as the turn's first continuation when the scratchpad exists; fewer calls than goal_missing_calls are never nudged", () => {
  const sb = sandbox();
  try {
    const gate = (input, env = {}) => { const r = spawnSync(process.execPath, [GOAL_GATE], { env: { ...sb.env, ...env }, input: JSON.stringify(input), encoding: "utf8" }); return { code: r.status, out: r.stdout }; };
    const mk = (sid, calls) => { let t = tx({ start: Date.now() - 30 * 60000 }).user("first").say("ok").user("second"); for (let i = 0; i < calls; i++) t = t.call("Read", { file_path: `a${i}` }); return writeTranscript(sb, path.join(sb.tmp, "hand"), sid, t.say("done").entries()); };
    const base = { stop_hook_active: false, last_assistant_message: "done", background_tasks: [] };
    const short = mk("h-s3", 9);
    assert.equal(gate({ ...base, session_id: "h-s3", transcript_path: short }).out, "");
    assert.equal(fs.existsSync(path.join(sb.cfg, "goals", ".nudged-h-s3")), false);
    const tp = mk("h-s4", 10), pad = path.join(sb.temp, "claude", path.basename(path.dirname(tp)), "h-s4", "scratchpad");
    fs.mkdirSync(pad, { recursive: true });
    assert.equal(JSON.parse(gate({ ...base, session_id: "h-s4", transcript_path: tp }).out).decision, "block");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pad, ".goal-gate-h-s4.json"), "utf8")), { blocks: 1, lastHash: null, finalAsked: false });
    // The session writes GOAL.md with open items: the continuation is the gate's 2nd of 3.
    fs.writeFileSync(path.join(pad, "GOAL.md"), "# g\n- [ ] a\n");
    assert.match(JSON.parse(gate({ ...base, stop_hook_active: true, session_id: "h-s4", transcript_path: tp }).out).reason, /^Goal gate \(continuation 2\/3\)/);
  } finally { sb.cleanup(); }
});

test("every launcher session gets the batch-A hooks in its one --settings file: fence, lane-note, stop", () => {
  const h = sessionHooks().hooks;
  assert.equal(h.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
  assert.match(h.PreToolUse[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" fence$/);
  assert.match(h.UserPromptSubmit[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" lane-note$/);
  assert.match(h.Stop[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" stop$/);
  assert.match(h.PostToolUse[0].hooks[0].command, / post-tool$/);
});
