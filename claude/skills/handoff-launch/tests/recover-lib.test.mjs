import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../recover-lib.mjs";
import { tx } from "./helpers.mjs";

const MIN = 60000, cfg = R.DEFAULTS, t0 = Date.parse("2026-01-01T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
// calls(["Bash x", "Read y"], start, step): done tool calls with keys as given
const calls = (keys, start, step = 1000) => keys.map((k, i) => ({ id: `t${start}-${i}`, name: k.split(" ")[0], input: {}, key: k, at: start + i * step, done: true, doneAt: start + i * step + 1 }));
const rep = (k, n) => Array(n).fill(k);

test("loadConfig: defaults, overrides, unknown keys and bad values are reported and ignored", () => {
  assert.deepEqual(R.loadConfig(null), { config: { ...R.DEFAULTS }, errors: [] });
  assert.equal(R.loadConfig('{"grace_min": 2}').config.grace_min, 2);
  const r = R.loadConfig('{"grace": 2, "stuck_min": -1}');
  assert.deepEqual(r.errors, ["unknown key grace", "stuck_min must be a positive number"]);
  assert.equal(r.config.stuck_min, 30);
  assert.match(R.loadConfig("{oops").errors[0], /not valid JSON/);
});

test("toolCalls, contextTokens, usageLimited and agentDone read Claude Code transcripts", () => {
  const e = tx({ start: t0 }).user("go").call("Bash", { command: "ls" }).tokens(5000, 300000, 2000).call("Read", { file_path: "a" }, { result: false }).entries();
  const c = R.toolCalls(e);
  assert.deepEqual(c.map((x) => [x.key, x.done]), [['Bash {"command":"ls"}', true], ['Read {"file_path":"a"}', false]]);
  assert.equal(R.toolCalls(e, c[1].at).length, 1); // calls before a launch line do not count
  assert.equal(R.contextTokens(e), 307000);
  assert.equal(R.usageLimited(tx().call("Bash", {}).limit().entries()), true);
  assert.equal(R.usageLimited(tx().limit().call("Bash", {}).entries()), false); // a call after the limit message: not waiting
  assert.equal(R.agentDone(tx().call("Bash", {}).say("done").entries()), true);
  assert.equal(R.agentDone(tx().call("Bash", {}).call("SubagentHandback", { message: "m" }).entries()), true);
  assert.equal(R.agentDone(tx().call("Bash", {}).entries()), false);
});

test("rule (a): the same call >= 4 times in the last 20 tool calls (calls, not entries)", () => {
  const four = calls([...rep("Bash x", 4), ...rep("Read y", 3)], t0);
  const [f] = R.ruleA(four, cfg);
  assert.equal(f.rule, "a"); assert.equal(f.count, 4); assert.equal(f.signature, `a:main:${R.shortHash("Bash x")}`);
  assert.deepEqual(R.ruleA(calls(rep("Bash x", 3), t0), cfg), []);
  assert.deepEqual(R.ruleA(calls(["Bash x", ...Array.from({ length: 19 }, (_, i) => `Read ${i}`), ...rep("Bash x", 3)], t0), cfg), []); // the first one left the window
  assert.equal(R.ruleA(calls(rep("Grep z", 5), t0), cfg, "ag1")[0].signature, `a:ag1:${R.shortHash("Grep z")}`);
});

test("legitimate polling that switches to Monitor: the rule stops firing and the grace timer pauses", () => {
  const poll = calls(rep("Bash gh run view", 4), t0, 60000);
  assert.equal(R.ruleA(poll, cfg).length, 1);
  const after = [...poll, ...calls(["Monitor ci", ...Array.from({ length: 17 }, (_, i) => `Read f${i}`)], t0 + 5 * MIN, 1000)]; // Monitor is not counted
  assert.deepEqual(R.ruleA(after, cfg), []);
  const pre = R.preKeysOf(poll, t0 + 4 * MIN, cfg);
  assert.equal(R.graceElapsed({ start: t0 + 4 * MIN, calls: after, preKeys: pre, now: t0 + 30 * MIN }), MIN); // counted only until Monitor
});

test("rule (b): an outstanding call with no activity for 30 min; a working subagent or Monitor is not stuck", () => {
  const c = [...calls(["Read a"], t0), { id: "p", name: "mcp__x__slow", key: "mcp__x__slow {}", at: t0 + MIN, done: false, doneAt: null }];
  const [f] = R.ruleB({ calls: c, lastEntryAt: t0 + MIN, subGrowthAt: 0, now: t0 + 32 * MIN }, cfg);
  assert.equal(f.signature, "b:mcp__x__slow"); assert.match(f.text, /no activity for 31 min/);
  assert.deepEqual(R.ruleB({ calls: c, lastEntryAt: t0 + MIN, subGrowthAt: t0 + 30 * MIN, now: t0 + 32 * MIN }, cfg), []);
  const mon = [{ id: "m", name: "Monitor", key: "Monitor {}", at: t0, done: false }];
  assert.deepEqual(R.ruleB({ calls: mon, lastEntryAt: t0, subGrowthAt: 0, now: t0 + 90 * MIN }, cfg), []);
});

test("detect: a looping foreground subagent makes the parent stuck (b) and waiting (d); its growth is not activity", () => {
  const now = t0 + 70 * MIN; // the notice (t0+36) is 34 min old, the parent's last entry (t0) 70 min
  const main = [{ id: "ag", name: "Agent", key: "Agent {}", at: t0, done: false }];
  const looping = { id: "ag1", type: "worker-high", file: "/p/agent-ag1.jsonl", calls: calls(rep("Bash x", 6), t0 + 30 * MIN), grewAt: now - 1000, done: false };
  const base = { entries: [], calls: main, lastEntryAt: t0, now, hooked: true, hook: { agent_notices: { ag1: iso(t0 + 36 * MIN) } } };
  let d = R.detect({ ...base, subs: [looping] }, cfg);
  assert.deepEqual(Object.keys(d.subFlags), ["ag1"]);
  assert.deepEqual(d.flags.map((f) => f.signature), ["b:Agent", "d:ag1"]);
  const working = { ...looping, id: "ag2", calls: calls(["Read a", "Edit b", "Bash c"], t0 + 30 * MIN) };
  d = R.detect({ ...base, subs: [working] }, cfg);
  assert.deepEqual(d.flags, []); // a long foreground Agent call whose subagent works is not stuck
  d = R.detect({ ...base, hook: {}, subs: [looping] }, cfg);
  assert.deepEqual(d.flags.map((f) => f.rule), ["b"]); // (d) waits for the notice to be delivered...
  d = R.detect({ ...base, hook: {}, hooked: false, subs: [looping] }, cfg);
  assert.deepEqual(d.flags.map((f) => f.rule), ["b", "d"]); // ...unless the session has no hook to deliver it
});

test("rule (d) waits until the parent has been idle stuck_min since the notice and since its own last entry", () => {
  const looping = { id: "ag1", type: "worker-high", file: "/f", calls: calls(rep("Bash y", 5), t0), grewAt: t0, done: false };
  const obs = (o) => ({ entries: [], calls: [], subs: [looping], lastEntryAt: t0, now: t0 + 40 * MIN, hooked: true, hook: { agent_notices: { ag1: iso(t0) } }, ...o });
  const sigs = (o) => R.detect(obs(o), cfg).flags.map((f) => f.signature);
  assert.deepEqual(sigs({ hook: { agent_notices: { ag1: iso(t0 + 36 * MIN) } } }), []); // the notice is only 4 min old
  assert.deepEqual(sigs({ lastEntryAt: t0 + 20 * MIN }), []); // the parent wrote an entry 20 min ago, after the notice
  assert.deepEqual(sigs({ lastEntryAt: t0 + 20 * MIN, now: t0 + 50 * MIN }), ["d:ag1"]); // both 30 min old now
  assert.deepEqual(sigs({ hook: {}, hooked: false, lastEntryAt: t0 + 20 * MIN }), []); // no hook: from the last entry alone
  assert.deepEqual(sigs({ hook: {}, hooked: false, lastEntryAt: t0 + 10 * MIN }), ["d:ag1"]);
  assert.deepEqual(sigs({ subs: [{ ...looping, done: true }] }), []); // a finished subagent is not waited on
});

test("never flagged: usage limit, AskUserQuestion, a permission prompt with no call after it, paused, pause file, unknown", () => {
  const loop = calls(rep("Bash x", 5), t0);
  const obs = (o) => ({ entries: [], calls: loop, subs: [], lastEntryAt: t0, now: t0 + MIN, hook: {}, hooked: true, ...o });
  assert.equal(R.detect(obs({}), cfg).flags.length, 1);
  assert.equal(R.detect(obs({ entries: tx().call("Bash", {}).limit().entries() }), cfg).exempt, "waiting on a usage limit");
  assert.equal(R.detect(obs({ calls: [...loop, { id: "q", name: "AskUserQuestion", key: "AskUserQuestion {}", at: t0 + 9000, done: false }] }), cfg).exempt, "waiting for the user (AskUserQuestion)");
  assert.equal(R.detect(obs({ waitingSince: iso(t0 + 10000) }), cfg).exempt, "waiting for the user (permission prompt)");
  assert.equal(R.detect(obs({ waitingSince: iso(t0 + 2000) }), cfg).exempt, null); // calls followed it: not waiting
  assert.match(R.detect(obs({ paused: true }), cfg).exempt, /paused/);
  assert.match(R.detect(obs({ pauseActive: true }), cfg).exempt, /pause file/);
  assert.equal(R.detect(obs({ liveState: "unknown" }), cfg).exempt, "liveness unknown");
});

test("graceElapsed: runs while the loop repeats, pauses on a distinct call, resumes on the next repeat", () => {
  const pre = new Set(["A", "B"]);
  assert.equal(R.graceElapsed({ start: t0, calls: [], preKeys: null, now: t0 + 6 * MIN }), 6 * MIN);
  const c = [{ key: "A", at: t0 + MIN }, { key: "C", at: t0 + 2 * MIN }, { key: "A", at: t0 + 4 * MIN }];
  assert.equal(R.graceElapsed({ start: t0, calls: c, preKeys: pre, now: t0 + 5 * MIN }), 3 * MIN);
  // a call that sat 60 min on a permission prompt: the wait does not count
  assert.equal(R.graceElapsed({ start: t0, calls: [{ key: "A", at: t0 + 61 * MIN }], preKeys: pre, now: t0 + 64 * MIN, waits: [[t0 + MIN, t0 + 61 * MIN]] }), 4 * MIN);
  assert.equal(R.graceElapsed({ start: t0, calls: [], preKeys: null, now: t0 + 10 * MIN, waits: [[t0 + 2 * MIN, null]] }), 2 * MIN);
});

test("the ladder: stop, wait for delivery, grace, kill; cancel when the rule stops firing", () => {
  const E = { id: "A@1", name: "A", coord: 1 }, sig = "a:main:abc";
  const flag = { rule: "a", scope: "main", key: "Bash x", signature: sig, text: "same call x5" };
  const loop = calls(rep("Bash x", 5), t0 - MIN);
  const run = (lines, now, c = loop, flags = [flag]) => R.ladderActions({ lines, entry: E, flags, callsFor: () => c, now, cfg });
  assert.deepEqual(run([], t0).map((a) => a.do), ["stop"]);
  const stop = { stop_requested: "A@1", reason_class: "ladder", signature: sig, token: "t1", at: iso(t0) };
  let a = run([stop], t0 + 10 * MIN);
  assert.equal(a[0].do, "wait"); assert.match(a[0].why, /not delivered/);
  const dl = { stop_delivered: "A@1", token: "t1", at: iso(t0 + MIN) };
  assert.equal(run([stop, dl], t0 + 4 * MIN)[0].do, "wait");
  assert.equal(run([stop, dl], t0 + 7 * MIN, [...loop, ...calls(["Bash x"], t0 + 2 * MIN)])[0].do, "kill");
  assert.equal(run([stop, dl], t0 + 7 * MIN, [...loop, ...calls(["Read y"], t0 + 2 * MIN)])[0].do, "wait"); // a distinct call paused it
  assert.deepEqual(run([stop, dl], t0 + 3 * MIN, loop, []), [{ do: "cancel", signature: sig }]);
  assert.deepEqual(run([stop], t0 + 61 * MIN), [{ do: "cancel", signature: sig, why: "stop expired" }]); // never delivered, stale
  const expired = { ladder_cancelled: "A@1", signature: sig, why: "stop expired", at: iso(t0 + 61 * MIN) };
  assert.deepEqual(run([stop, expired], t0 + 70 * MIN).map((a) => a.do), ["stop"]); // a fresh stop, not a re-arm
  assert.deepEqual(run([stop, dl, { incident: "A@1", signature: sig, n: 1, path: "i.md", at: iso(t0 + 7 * MIN) }], t0 + 8 * MIN), []); // the kill path owns it
});

test("re-arming: an A,B,A,B loop with a stray distinct call still escalates; an old cancel starts over", () => {
  const E = { id: "A@1", name: "A", coord: 1 }, sig = "a:main:abc";
  const flag = { rule: "a", scope: "main", key: "A", signature: sig, text: "same call x4" };
  const before = calls(["A", "B", "A", "B", "A", "B", "A", "B"], t0 - 8000);
  const stop = { stop_requested: "A@1", reason_class: "ladder", signature: sig, token: "t1", at: iso(t0) };
  const dl = { stop_delivered: "A@1", token: "t1", at: iso(t0 + MIN) };
  const cancel = { ladder_cancelled: "A@1", signature: sig, at: iso(t0 + 3 * MIN) };
  const run = (lines, now, c) => R.ladderActions({ lines, entry: E, flags: [flag], callsFor: () => c, now, cfg });
  assert.deepEqual(run([stop, dl, cancel], t0 + 20 * MIN, before).map((a) => a.do), ["rearm"]);
  const rearm = { ladder_rearmed: "A@1", signature: sig, at: iso(t0 + 20 * MIN) };
  const after = [...before, { key: "A", at: t0 + 21 * MIN }, { key: "B", at: t0 + 22 * MIN }, { key: "C", at: t0 + 22.5 * MIN }, { key: "A", at: t0 + 23 * MIN }, { key: "B", at: t0 + 24 * MIN }];
  assert.equal(run([stop, dl, cancel, rearm], t0 + 26 * MIN, after)[0].do, "kill"); // 5.5 min counted, C paused 0.5 min
  assert.deepEqual(run([stop, dl, cancel], t0 + 70 * MIN, before).map((a) => a.do), ["stop"]);
});

test("re-arming needs a grace start: a stop never delivered to a hooked session's (a) ladder gets a fresh stop", () => {
  const sig = "a:main:abc", flag = { rule: "a", scope: "main", key: "Bash x", signature: sig, text: "same call x5" };
  const stop = { stop_requested: "A@1", reason_class: "ladder", signature: sig, token: "t1", at: iso(t0) };
  const cancel = { ladder_cancelled: "A@1", signature: sig, at: iso(t0 + 5 * MIN) }; // the turn ended before the stop was delivered
  const loop = calls(rep("Bash x", 5), t0 + 62 * MIN);
  const run = (entry, f, now) => R.ladderActions({ lines: [stop, cancel].map((o) => ({ ...o, signature: f.signature })), entry, flags: [f], callsFor: () => loop, now, cfg }).map((a) => a.do);
  assert.deepEqual(run({ id: "A@1", coord: 1 }, flag, t0 + 63 * MIN), ["stop"]); // a new token, not a re-arm into a kill
  assert.deepEqual(run({ id: "A@1", coord: 1 }, flag, t0 + 10 * MIN), ["stop"]);
  // grace counts from the request for (b)/(d) and for a session without the hook: those still re-arm
  assert.deepEqual(run({ id: "A@1" }, flag, t0 + 63 * MIN), ["rearm"]);
  assert.deepEqual(run({ id: "A@1", coord: 1 }, { ...flag, rule: "b", signature: "b:mcp__x__slow" }, t0 + 63 * MIN), ["rearm"]);
});

test("grace starts at the request for rules (b)/(d) and for a session without the hook", () => {
  const sig = "b:mcp__x__slow", stop = { stop_requested: "A@1", reason_class: "ladder", signature: sig, token: "t", at: iso(t0) };
  const fb = { rule: "b", scope: "main", key: "k", signature: sig, text: "stuck" };
  assert.equal(R.ladderActions({ lines: [stop], entry: { id: "A@1", coord: 1 }, flags: [fb], callsFor: () => [], now: t0 + 6 * MIN, cfg })[0].do, "kill");
  const fa = { ...fb, rule: "a", signature: "a:main:x" }, stopA = { ...stop, signature: "a:main:x" };
  assert.equal(R.ladderActions({ lines: [stopA], entry: { id: "A@1" }, flags: [fa], callsFor: () => [], now: t0 + 6 * MIN, cfg })[0].do, "kill");
});

test("pendingLadders: an auto incident with a kill_intent and no restart is pending; old kill_intents never are", () => {
  const sig = "a:main:x", inc = { incident: "A@1", name: "A", n: 1, path: "i.md", signature: sig, mode: "auto", at: iso(t0) };
  const ki = { kill_intent: "A@1", kind: "ladder", at: iso(t0 + 1) };
  assert.deepEqual(R.pendingLadders([inc, ki]).map((p) => [p.id, !!p.intent, p.closed]), [["A@1", true, false]]);
  assert.deepEqual(R.pendingLadders([inc]).map((p) => p.intent), [null]);
  assert.deepEqual(R.pendingLadders([inc, ki, { closed: "A", id: "A@1" }, { restart: "A", from: "A@1", handoff: "h" }]), []);
  assert.deepEqual(R.pendingLadders([inc, ki, { restart_skipped: "A@1" }]), []);
  assert.deepEqual(R.pendingLadders([{ ...inc, mode: "report" }]), []);
  assert.deepEqual(R.pendingLadders([{ kill_intent: "B@1", why: "watchdog: old", at: iso(t0) }]), []);
  const cancel = { ladder_cancelled: "A@1", signature: sig, at: iso(t0 + 2) };
  assert.deepEqual(R.pendingLadders([inc, cancel]), []);
  assert.deepEqual(R.pendingLadders([inc, ki, { restart_failed: "A", from: "A@1" }]), []);
  assert.equal(R.ladderOf([inc, cancel], "A@1", sig).incident, null); // the same signature can re-arm
});

test("restart kind and cap, including a 400k crossing; a new handoff or a manual resume resets the count", () => {
  const k = (restarts, tokens, o = {}) => R.restartKind({ restarts, tokens, cfg, isBg: false, ...o });
  assert.deepEqual([k(0, 100), k(1, 100), k(2, 100)], ["resume", "fresh", "blocked"]);
  assert.deepEqual([k(0, 400000), k(1, 450000)], ["fresh", "blocked"]);
  assert.equal(k(1, 400000), "blocked"); // resumed, grew past the threshold, looped again: the >= row
  assert.equal(k(0, 100, { isBg: true }), "fresh");
  assert.equal(k(0, 100, { hasSession: false }), "fresh");
  assert.equal(k(0, 100, { resumeWorks: false }), "fresh");
  const lines = [{ restart: "A", handoff: "h1" }, { restart: "A", handoff: "h1" }, { restart: "B", handoff: "h1" }];
  assert.equal(R.restartsSince(lines, "A", "h1"), 2);
  assert.equal(R.restartsSince(lines, "A", "h2"), 0);
  assert.equal(R.restartsSince([...lines, { lane_resumed: "A", handoff: "h1" }, { restart: "A", handoff: "h1" }], "A", "h1"), 1);
});

test("afterKillPlan: a done lane is killed but not restarted; pause defers; the cap blocks; one rung up only after an empty Cause", () => {
  const entry = { id: "A@1", name: "A", handoff: "h", mode: "window", session_id: "s", model: "opus", effort: "high" };
  const p = (o) => R.afterKillPlan({ lines: [], entry, incident: { tokens: 1000 }, cfg, doneMarkerExists: false, pauseActive: false, prevCauseFilled: true, ...o });
  assert.equal(p({ doneMarkerExists: true }).do, "skip");
  assert.equal(p({ pauseActive: true }).do, "defer");
  assert.deepEqual(p({}), { do: "restart", kind: "resume", model: "opus", effort: "high", restarts: 0 });
  const one = [{ restart: "A", handoff: "h" }];
  assert.deepEqual(p({ lines: one }), { do: "restart", kind: "fresh", model: "opus", effort: "high", restarts: 1 });
  assert.deepEqual(p({ lines: one, prevCauseFilled: false }), { do: "restart", kind: "fresh", model: "opus", effort: "xhigh", restarts: 1 });
  assert.equal(p({ lines: [...one, ...one] }).do, "block");
  assert.deepEqual(R.afterKillPlan({ lines: [], entry: { ...entry, model: undefined, effort: undefined }, incident: {}, cfg, doneMarkerExists: false, pauseActive: false }).model, "opus");
});

test("rungUp, causeFilled, incidentText", () => {
  assert.deepEqual(R.rungUp("opus", "high"), { model: "opus", effort: "xhigh" });
  assert.deepEqual(R.rungUp("opus", "xhigh"), { model: "fable", effort: "high" });
  assert.deepEqual(R.rungUp("fable", "xhigh"), { model: "fable", effort: "xhigh" });
  assert.deepEqual(R.rungUp("opus", "low"), { model: "opus", effort: "medium" });
  const md = R.incidentText({ lane: "A", n: 2, at: "2026-01-01T00:00:00Z", name: "A", id: "A@1", sessionId: "s", generation: 3, rule: "a",
    signature: "a:main:abc", text: "same call x5", tokens: 1234, branch: "lane-A", worktree: "/w", handoff: "/h.md", mode: "auto",
    calls: ['Bash {"command":"x"}'], main: "/p/s.jsonl", subs: [{ id: "ag1", type: "worker-high", file: "/p/s/subagents/agent-ag1.jsonl" }],
    others: [{ id: "ag2", type: "explorer", description: "map the code" }] });
  assert.match(md, /^# Incident A-2: loop stopped by the coordinator\n/);
  assert.match(md, /- Rule: \(a\) the same tool call repeated/);
  assert.match(md, /## Last 20 tool calls\n1\. `Bash \{"command":"x"\}`/);
  assert.match(md, /## Other background agents \(re-dispatch\)\n- ag2 \(explorer\): map the code/);
  assert.equal(R.causeFilled(md), false);
  assert.equal(R.causeFilled(md.replace(R.CAUSE_PLACEHOLDER, "The brief named the wrong file.")), true);
});

test("closeDecision: idle long enough and not waiting closes; busy, waiting or young does not", () => {
  const st = (o) => ({ found: true, idle: true, busy: [], last: iso(t0), ...o });
  const d = (o) => R.closeDecision({ state: st({}), waitingSince: null, noClaude: null, now: t0 + 20 * MIN, cfg, reason: "superseded by generation 2", ...o });
  assert.deepEqual(d({}), { close: true, why: "superseded by generation 2: idle 20 min" });
  assert.equal(d({ state: st({ idle: false, busy: ["1 tool call(s) outstanding"] }) }).close, false);
  assert.equal(d({ waitingSince: iso(t0) }).close, false);
  assert.equal(d({ now: t0 + 5 * MIN }).close, false);
  assert.equal(d({ state: { found: false }, noClaude: true }).close, true);
  assert.equal(d({ state: { found: false }, noClaude: null }).close, false);
});

test("recoveryMode, blockedLanes, alertDue, freshLaunchArgs", () => {
  const old = { name: "A", group: "g", repo: "r", launched_at: iso(t0) }, neu = { name: "B", group: "h", repo: "r", launched_at: iso(t0), coord: 1 };
  assert.equal(R.recoveryMode([old, { ...old, coord: 1 }], { ...old, coord: 1 }), "report"); // the group's EARLIEST line decides
  assert.equal(R.recoveryMode([neu], neu), "auto");
  assert.equal(R.recoveryMode([old, { recovery_mode: "g", mode: "auto" }], old), "auto");
  assert.equal(R.recoveryMode([neu, { recovery_mode: "h", mode: "auto" }, { recovery_mode: "h", mode: "report" }], neu), "report");
  assert.equal(R.recoveryMode([], { name: "solo", group: null, coord: 1 }), "auto");
  assert.equal(R.recoveryMode([{ name: "solo", launched_at: iso(t0), coord: 1 }], { name: "solo", group: null }), "report"); // its own line decides
  const lines = [{ lane_blocked: "A", group: "g", handoff: "h", incident: "i1" }, { lane_blocked: "B", group: "g", handoff: "h", incident: "i2" }, { lane_resumed: "B", group: "g" }];
  assert.deepEqual(R.blockedLanes(lines, "g").map((b) => b.name), ["A"]);
  assert.equal(R.alertDue({}, "k", t0, cfg), true);
  assert.equal(R.alertDue({ k: iso(t0 - 5 * 3600e3) }, "k", t0, cfg), false);
  assert.equal(R.alertDue({ k: iso(t0 - 7 * 3600e3) }, "k", t0, cfg), true);
  const e = { name: "A", group: "g", repo: "c:/r", worktree: "C:/r/.claude/worktrees/lane-A", branch: "lane-A", handoff: "C:/h.md", mode: "window", session_id: "s1", prompt_file: "C:/p.txt" };
  assert.deepEqual(R.freshLaunchArgs(e, { model: "opus", effort: "high", recovery: "C:/i.md" }), ["--repo", e.worktree, "--handoff", "C:/h.md", "--name", "A", "--group", "g",
    "--worktree", "lane-A", "--model", "opus", "--effort", "high", "--mode", "window", "--no-close", "--recovery", "C:/i.md", "--goal-from", "s1", "--prompt-file", "C:/p.txt"]);
  assert.ok(R.freshLaunchArgs({ ...e, name: "g-merge" }, { model: "opus", effort: "high", recovery: "i" }).includes("--force")); // legacy merge session relaunch
  assert.ok(!R.freshLaunchArgs({ ...e, worktree: "C:/r" }, { model: "opus", effort: "high", recovery: "i" }).includes("--worktree"));
});

test("postToolSteps: stop delivery (parent only), subagent notice, parent fast path, early warning per agent - once each", () => {
  const ctx = (o) => ({ stops: [], looping: {}, cfg, now: t0, ...o });
  const stop = { token: "t1", text: "STOP NOW" };
  let r = R.postToolSteps({}, { agentId: "ag1", key: "Read a" }, ctx({ stops: [stop] }));
  assert.equal(r.context, null); // a subagent's event never takes the session-level stop
  r = R.postToolSteps(r.state, { agentId: null, key: "Read a" }, ctx({ stops: [stop] }));
  assert.equal(r.context, "STOP NOW"); assert.equal(r.delivered, "t1");
  r = R.postToolSteps(r.state, { agentId: null, key: "Read b" }, ctx({ stops: [stop] }));
  assert.equal(r.context, null);
  const looping = { ag2: { key: 'Bash {"command":"loop"}', type: "worker-high", text: "same call x5", transcript: "/t/agent-ag2.jsonl" } };
  r = R.postToolSteps(r.state, { agentId: "ag2", key: "Bash loop" }, ctx({ looping }));
  assert.equal(r.context, R.SUBAGENT_TEXT('Bash {"command":"loop"}'));
  r = R.postToolSteps(r.state, { agentId: "ag2", key: "Bash loop" }, ctx({ looping }));
  assert.equal(r.context, null);
  r = R.postToolSteps(r.state, { agentId: null, key: "Read c" }, ctx({ looping }));
  assert.equal(r.context, R.PARENT_TEXT({ type: "worker-high", id: "ag2", reason: "same call x5", transcript: "/t/agent-ag2.jsonl" }));
  r = R.postToolSteps(r.state, { agentId: null, key: "Read d" }, ctx({ looping }));
  assert.equal(r.context, null);
  const out = [];
  for (const [agentId, key] of [[null, "X"], ["ag3", "X"], [null, "X"], ["ag3", "X"], [null, "X"], [null, "X"]]) { r = R.postToolSteps(r.state, { agentId, key }, ctx({})); out.push(r.context); }
  assert.deepEqual(out, [null, null, null, null, R.WARN_TEXT("X", 3), null]); // per-agent streaks; once per signature
  r = R.postToolSteps({ ...r.state, waiting_since: iso(t0) }, { agentId: null, key: "Y" }, ctx({}));
  assert.equal(r.state.waiting_since, null); // a tool call followed the permission prompt
  assert.deepEqual(r.state.waits.at(-1), [t0, t0]); // ...and the wait is kept for the grace timer
  r = R.postToolSteps({}, { agentId: null, key: "Z" }, ctx({ stops: [{ token: "old", text: "OLD", at: iso(t0 - 61 * MIN) }, { token: "t9", text: "LADDER", at: iso(t0) }] }));
  assert.equal(r.context, "LADDER"); assert.match(r.state.delivered.old, /^expired/); // a stale stop is never injected
  for (let i = 0; i < 3; i++) r = R.postToolSteps(r.state, { agentId: null, key: "Monitor {}" }, ctx({}));
  assert.equal(r.context, null); // no warning for waiting with Monitor
});

test("rule (a) leaves a finished turn alone and never counts Monitor; rule (d) still judges an idle parent", () => {
  let t = tx({ start: t0 }).user("go");
  for (let i = 0; i < 4; i++) t = t.call("Bash", { command: "x" });
  const idle = t.say("done").turnDone().entries(), c = R.toolCalls(idle);
  const base = { entries: idle, calls: c, subs: [], lastEntryAt: t0, now: t0 + 3 * 3600e3, hook: {}, hooked: true };
  assert.deepEqual(R.detect(base, cfg).flags, []);
  assert.equal(R.detect({ ...base, entries: idle.slice(0, -2) }, cfg).flags[0].rule, "a"); // mid-turn: flagged
  assert.deepEqual(R.ruleA(calls(rep("Monitor ci", 6), t0), cfg), []);
  const looping = { id: "ag1", type: "worker-high", file: "/f", calls: calls(rep("Bash y", 5), t0), grewAt: t0, done: false };
  assert.deepEqual(R.detect({ ...base, subs: [looping], hook: { agent_notices: { ag1: iso(t0) } } }, cfg).flags.map((f) => f.signature), ["d:ag1"]);
});
