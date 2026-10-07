import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR, runChild } from "./mc-helpers.mjs";
import { msgKey } from "../paths.mjs";
import { sandbox, sessionLine, setAgents, writeTranscript, tx, host } from "../../handoff-launch/tests/helpers.mjs";
import { parseStateBlock, clean } from "../claude-adapter.mjs";

const RID = "a".repeat(32);
const RID2 = "b".repeat(32);
const state = (sb) => path.join(sb.cfg, "state", "model-coordinator");
const msgFolder = (sb, lane) => path.join(state(sb), "messages", msgKey(lane));
const files = (sb, lane) => { try { return fs.readdirSync(msgFolder(sb, lane)).sort(); } catch { return []; } };
const PROFILE_OUT = JSON.stringify({ profile: "full", args: ["--settings", "/fake/settings.json"] });

/** Runs `body` in a child process with the sandbox env; `ad(deps)` builds an adapter for the sandbox repo. */
function run(sb, body, { env = {} } = {}) {
  const prelude = `const REPO = ${JSON.stringify(sb.repo)};
const CLI_EXE = () => ({ exe: "C:/fake/claude.exe" });
const profileRunNode = H.fakeClaudeRunner([{ code: 0, stdout: ${JSON.stringify(PROFILE_OUT)} }]);
const ad = (deps = {}) => A.createClaudeAdapter({ cfg: { claude: { model: "opus", effort: "high" } }, repo: REPO, deps: { claudeCli: CLI_EXE, runNode: profileRunNode, ...deps } });
const fs = await import("node:fs");\n`;
  const r = runChild(sb.tmp, { ...sb.env, ...env }, prelude + body);
  assert.equal(r.status, 0, `child failed: ${r.stderr}\n${r.stdout}`);
  return r.result;
}
/** A bg lane the registry and the fake agents list know: status "busy" | "idle". */
function bgLane(sb, name, { sid = "s1", bg = "b1", status = "busy", extra = {} } = {}) {
  const e = sessionLine(sb, { name, mode: "bg", bg_id: bg, sid, ...extra });
  const cur = fs.existsSync(path.join(sb.tmp, "agents.json")) ? JSON.parse(fs.readFileSync(path.join(sb.tmp, "agents.json"), "utf8")) : [];
  setAgents(sb, [...cur.filter((a) => a.id !== bg), { id: bg, sessionId: sid, name, status }]);
  return e;
}
const withSb = (fn, opts) => async () => { const sb = sandbox(opts); try { await fn(sb); } finally { sb.cleanup(); } };

test("M1 create under HL_NO_SPAWN runs launch.mjs in bg mode, opus/high, with a brief", withSb((sb) => {
  const r = run(sb, `return ad({ runNode: undefined }).create({ workerId: "auth-01", label: "auth", objective: "Fix the login bug", instruction: "Start with a failing test", requestId: "r1" });`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lane, "auth-01");
  assert.match(r.worktree, /worktrees\/mc-auth-01$/);
  assert.equal(r.branch, "mc-auth-01");
  const brief = path.join(state(sb), "briefs", "auth-01.md");
  const text = fs.readFileSync(brief, "utf8");
  assert.match(text, /Fix the login bug/);
  assert.match(text, /Start with a failing test/);
  assert.match(text, /coordinator-state/);
  assert.match(text, /Never commit unless the user asks/);
  const line = sb.registry().find((x) => x.name === "auth-01" && x.launched_at);
  assert.ok(line, "the registry has the launch line");
  assert.equal(line.mode, "bg");
  assert.equal(line.model, "opus");
  assert.equal(line.effort, "high");
  assert.equal(line.handoff.toLowerCase(), brief.split(path.sep).join("/").toLowerCase());
}));

test("M1 a retried create keeps the first brief", withSb((sb) => {
  const body = (obj) => `return ad({ runNode: undefined }).create({ workerId: "auth-01", label: "auth", objective: ${JSON.stringify(obj)}, instruction: "", requestId: "r1" });`;
  assert.equal(run(sb, body("first objective")).ok, true);
  assert.equal(run(sb, body("second objective")).ok, true);
  assert.match(fs.readFileSync(path.join(state(sb), "briefs", "auth-01.md"), "utf8"), /first objective/);
}));

test("M2 a launch.mjs refusal (exit 3) is a cap, other failures carry the last output lines", withSb((sb) => {
  // launch-config.json max_sessions must be an integer >= 1 (0 falls back to the defaults): one running lane fills it.
  fs.writeFileSync(path.join(sb.reg, "launch-config.json"), JSON.stringify({ max_sessions: 1 }));
  bgLane(sb, "other-01", { sid: "s0", bg: "b0", status: "busy" });
  const cap = run(sb, `return ad({ runNode: undefined }).create({ workerId: "auth-01", label: "auth", objective: "o", instruction: "i", requestId: "r1" });`);
  assert.equal(cap.ok, false);
  assert.equal(cap.kind, "cap");
  assert.match(cap.reason, /sessions running|max_sessions/);
  // exit 1 from the injected runner: `failed`, with the tail of its output
  const bad = run(sb, `return ad({ runNode: H.fakeClaudeRunner([{ code: 1, stdout: "a\\nb\\n", stderr: "boom: worktree list failed\\n" }]) }).create({ workerId: "auth-02", label: "auth", objective: "o", instruction: "i", requestId: "r2" });`);
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, "failed");
  assert.match(bad.reason, /boom: worktree list failed/);
  // a real refusal that is not a cap: a repo that is not a git repo (--worktree needs one)
  const notGit = path.join(sb.tmp, "plain");
  fs.mkdirSync(notGit);
  const real = run(sb, `return A.createClaudeAdapter({ cfg: {}, repo: ${JSON.stringify(notGit)}, deps: { claudeCli: CLI_EXE } }).create({ workerId: "auth-03", label: "auth", objective: "o", instruction: "i", requestId: "r3" });`);
  assert.equal(real.kind, "failed");
  assert.match(real.reason, /git repo/);
}));

test("M3 a message to a busy bg lane writes one file; the same request again writes nothing and calls no runner", withSb((sb) => {
  bgLane(sb, "w-01", { status: "busy" });
  const r = run(sb, `const rc = H.fakeClaudeRunner(); const a = ad({ runClaude: rc });
    const first = a.message({ lane: "w-01" }, "please rebase", ${JSON.stringify(RID)});
    const second = a.message({ lane: "w-01" }, "please rebase", ${JSON.stringify(RID)});
    return { first, second, calls: rc.calls.length, node: profileRunNode.calls.length };`);
  assert.deepEqual(r.first, { ok: true, path: "delivered-next-tool" });
  assert.deepEqual(r.second, { ok: true, path: "already-queued" });
  assert.equal(r.calls, 0);
  assert.equal(r.node, 0);
  assert.deepEqual(files(sb, "w-01"), [`${RID}.json`]);
  const body = JSON.parse(fs.readFileSync(path.join(msgFolder(sb, "w-01"), `${RID}.json`), "utf8"));
  assert.equal(body.text, "please rebase");
  assert.equal(body.request_id, RID);
  assert.ok(Date.parse(body.at) > 0);
}));

test("a request id that is not 32 hex (a dispatcher sub-id) maps to a stable file name", withSb((sb) => {
  bgLane(sb, "w-01", { status: "busy" });
  const r = run(sb, `const a = ad(); return [a.message({ lane: "w-01" }, "x", "abc:w-01"), a.message({ lane: "w-01" }, "x", "abc:w-01"), a.message({ lane: "w-01" }, "y", "abc:w-02")];`);
  assert.equal(r[0].path, "delivered-next-tool");
  assert.equal(r[1].path, "already-queued");
  assert.equal(files(sb, "w-01").length, 2);
  assert.ok(files(sb, "w-01").every((f) => /^[0-9a-f]{32}\.json$/.test(f)));
}));

test("M4 + M3b a message to an idle bg lane wakes it with --resume ... --bg, claims the file, and a retry sends nothing", withSb((sb) => {
  const e = bgLane(sb, "w-01", { status: "idle" });
  const r = run(sb, `const rc = H.fakeClaudeRunner(); const a = ad({ runClaude: rc });
    const first = a.message({ lane: "w-01" }, "please rebase", ${JSON.stringify(RID)});
    const second = a.message({ lane: "w-01" }, "please rebase", ${JSON.stringify(RID)});
    return { first, second, calls: rc.calls, node: profileRunNode.calls };`);
  assert.deepEqual(r.first, { ok: true, path: "woke-idle" });
  assert.deepEqual(r.second, { ok: true, path: "already-queued" });
  assert.equal(r.calls.length, 1, "exactly one --resume call");
  const [c] = r.calls;
  assert.deepEqual(c.args.slice(0, 4), ["--resume", "s1", "--settings", "/fake/settings.json"]);
  assert.equal(c.args.at(-2), "--bg");
  assert.equal(c.args.at(-1), `Message from the user, relayed by the coordinator (request ${RID}): please rebase`);
  assert.equal(c.args.length, 6);
  assert.equal(c.cwd, e.worktree);
  assert.equal(c.env.HL_SESSION_ID, e.id);
  assert.equal(c.env.HL_NO_SPAWN, undefined, "the wake env is the strict childEnv: no HL_*");
  assert.equal(c.env.CLAUDE_CONFIG_DIR, sb.cfg);
  assert.deepEqual(r.node[0].args.slice(0, 3), ["profile-args", "--profile", "full"]);
  assert.deepEqual(files(sb, "w-01"), [`${RID}.delivered.json`]);
}));

test("M5 the wake detects a copy (note + a new agent), stops it and puts the message back", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  const agents = JSON.stringify(path.join(sb.tmp, "agents.json"));
  const r = run(sb, `const list = () => JSON.parse(fs.readFileSync(${agents}, "utf8"));
    const rc = H.fakeClaudeRunner((args) => {
      if (args[0] === "--resume") { fs.writeFileSync(${agents}, JSON.stringify([...list(), { id: "b2", sessionId: "s2" }])); return { code: 0, stdout: "note: started a copy (id b2)\\n" }; }
      return { code: 0 };
    });
    const out = ad({ runClaude: rc }).message({ lane: "w-01" }, "please rebase", ${JSON.stringify(RID)});
    return { out, calls: rc.calls.map((c) => c.args) };`);
  assert.deepEqual(r.out, { ok: true, path: "queued-until-next-run" });
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1], ["stop", "b2"]);
  assert.deepEqual(files(sb, "w-01").filter((f) => !f.endsWith(".delivered.json")), [`${RID}.json`], "pending again");
}));

test("the wake treats a new nameless or same-named agent as a copy even without the note, never an unrelated one", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  const agents = JSON.stringify(path.join(sb.tmp, "agents.json"));
  const r = run(sb, `const list = () => JSON.parse(fs.readFileSync(${agents}, "utf8"));
    const rc = H.fakeClaudeRunner((args) => {
      if (args[0] === "--resume") fs.writeFileSync(${agents}, JSON.stringify([...list(), { id: "b2", sessionId: "s2", name: "w-01" }, { id: "b9", sessionId: "s9", name: "someone-elses" }]));
      return { code: 0 };
    });
    const out = ad({ runClaude: rc }).message({ lane: "w-01" }, "x", ${JSON.stringify(RID)});
    return { out, calls: rc.calls.map((c) => c.args) };`);
  assert.equal(r.out.path, "queued-until-next-run");
  assert.deepEqual(r.calls.slice(1), [["stop", "b2"]]);
}));

test("H3 a copy note with no copy found leaves the message delivered (no double send); a copy found only by the note's id is stopped and re-queued", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  const none = run(sb, `const rc = H.fakeClaudeRunner([{ code: 0, stdout: "note: started a copy (id b7)\\n" }]);
    const out = ad({ runClaude: rc }).message({ lane: "w-01" }, "x", ${JSON.stringify(RID)}); return { out, calls: rc.calls.map((c) => c.args) };`);
  assert.equal(none.out.ok, true);
  assert.equal(none.out.path, "woke-idle");
  assert.equal(none.calls.length, 1, "nothing to stop");
  assert.deepEqual(files(sb, "w-01"), [`${RID}.delivered.json`], "stays delivered");
  // the copy carries another name, so the new-entry rule skips it; the note's id finds it in a refreshed list
  const agents = JSON.stringify(path.join(sb.tmp, "agents.json"));
  const found = run(sb, `const list = () => JSON.parse(fs.readFileSync(${agents}, "utf8"));
    const rc = H.fakeClaudeRunner((args) => {
      if (args[0] === "--resume") { fs.writeFileSync(${agents}, JSON.stringify([...list(), { id: "b7", sessionId: "s7", name: "renamed-copy" }])); return { code: 0, stdout: "note: started a copy (id b7)\\n" }; }
      return { code: 0 };
    });
    const out = ad({ runClaude: rc }).message({ lane: "w-01" }, "x", ${JSON.stringify(RID2)}); return { out, calls: rc.calls.map((c) => c.args) };`);
  assert.equal(found.out.path, "queued-until-next-run");
  assert.deepEqual(found.calls[1], ["stop", "b7"]);
  assert.ok(files(sb, "w-01").includes(`${RID2}.json`));
}));

test("H4 a request claimed in the gap between the .delivered check and the write leaves no duplicate pending file", withSb((sb) => {
  bgLane(sb, "w-01", { status: "busy" });
  const dir = JSON.stringify(path.join(msgFolder(sb, "w-01")));
  const r = run(sb, `let n = 0; const rc = H.fakeClaudeRunner();
    const now = () => { if (n++ === 0) { fs.mkdirSync(${dir}, { recursive: true }); fs.writeFileSync(${dir} + "/" + ${JSON.stringify(RID)} + ".delivered.json", "{}"); } return Date.now(); };
    return ad({ runClaude: rc, now }).message({ lane: "w-01" }, "x", ${JSON.stringify(RID)});`);
  assert.deepEqual(r, { ok: true, path: "already-queued" });
  assert.deepEqual(files(sb, "w-01"), [`${RID}.delivered.json`]);
}));

test("a failed wake (non-zero exit) puts the message back; an unclaimed retry is idempotent", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  const r = run(sb, `const rc = H.fakeClaudeRunner([{ code: 2, stderr: "no" }]); const a = ad({ runClaude: rc });
    return [a.message({ lane: "w-01" }, "x", ${JSON.stringify(RID)}), a.message({ lane: "w-01" }, "x", ${JSON.stringify(RID)}), rc.calls.length];`);
  assert.equal(r[0].path, "queued-until-next-run");
  assert.equal(r[1].path, "already-queued");
  assert.equal(r[2], 1);
  assert.ok(files(sb, "w-01").includes(`${RID}.json`));
}));

test("a running window lane is delivered by the hook, never woken", withSb((sb) => {
  const h = host();
  try {
    sessionLine(sb, { name: "win-01", mode: "window", host: { pid: h.pid, start: h.start } });
    const r = run(sb, `const rc = H.fakeClaudeRunner(); const out = ad({ runClaude: rc }).message({ lane: "win-01" }, "x", ${JSON.stringify(RID)}); return { out, calls: rc.calls.length, node: profileRunNode.calls.length };`);
    assert.deepEqual(r.out, { ok: true, path: "delivered-next-tool" });
    assert.equal(r.calls, 0);
    assert.equal(r.node, 0);
    assert.deepEqual(files(sb, "win-01"), [`${RID}.json`]);
  } finally { h.kill(); }
}));

test("M6 a message to a gone lane is dead and writes nothing", withSb((sb) => {
  bgLane(sb, "w-01", { status: "stopped" }); // listed but ended: gone
  const r = run(sb, `const a = ad(); return [a.message({ lane: "w-01" }, "x", ${JSON.stringify(RID)}), a.message({ lane: "never-launched" }, "x", ${JSON.stringify(RID2)})];`);
  for (const x of r) { assert.equal(x.ok, false); assert.equal(x.kind, "dead"); assert.ok(x.reason); }
  assert.deepEqual(files(sb, "w-01"), []);
  assert.equal(fs.existsSync(path.join(state(sb), "messages")), false, "no message folder at all");
}));

// ---- M7 status ---------------------------------------------------------------------------------------------------
const FENCE = (o) => "```coordinator-state\n" + JSON.stringify(o) + "\n```";
const BLOCK = { session_id: "s1", provider: "claude", status: "waiting_for_user", summary: "Need a decision on the schema", changes: ["added x"], blockers: ["schema unclear"], needs_user: true, files_changed: ["src/x.js"] };
const status = (sb, lane = "w-01", env = {}) => run(sb, `return ad().status({ id: ${JSON.stringify(lane)}, lane: ${JSON.stringify(lane)} });`, { env });

test("M7 a valid coordinator-state block in the last assistant text gives waiting_for_user with the summary", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  writeTranscript(sb, sb.repo, "s1", tx().user("go").call("Bash", { command: "x" }).say(`Done for now.\n${FENCE(BLOCK)}`).entries());
  const r = status(sb);
  assert.equal(r.status, "waiting_for_user");
  assert.equal(r.last_result, "Need a decision on the schema");
  assert.deepEqual(r.blockers, ["schema unclear"]);
  assert.equal(r.needs_user, true);
  assert.deepEqual(r.files_changed, ["src/x.js"]);
}));

test("M7 a done block gives finished; a busy lane keeps running (the block is from an older turn)", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  writeTranscript(sb, sb.repo, "s1", tx().user("go").say(FENCE({ ...BLOCK, status: "done", summary: "all done", needs_user: false })).entries());
  assert.equal(status(sb).status, "finished");
  setAgents(sb, [{ id: "b1", sessionId: "s1", name: "w-01", status: "busy" }]);
  const busy = status(sb);
  assert.equal(busy.status, "running");
  assert.equal(busy.last_result, "all done");
}));

test("M7 a malformed block is ignored, and so is one inside a user entry", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  writeTranscript(sb, sb.repo, "s1", tx().user("go").say("Done.\n```coordinator-state\n{not json\n```").entries());
  assert.equal(status(sb).status, "idle");
  // the brief and the user's prompts hold the fence as an example; no assistant entry has one
  writeTranscript(sb, sb.repo, "s1", tx().user(`Example:\n${FENCE({ ...BLOCK, status: "done", summary: "fake" })}`).say("ok, working on it").entries());
  const r = status(sb);
  assert.equal(r.status, "idle");
  assert.equal(r.last_result, "");
  // a tool_use block inside an assistant entry is no text either
  writeTranscript(sb, sb.repo, "s1", tx().user("go").call("Bash", { command: FENCE({ ...BLOCK, status: "done" }) }).say("working").entries());
  assert.equal(status(sb).status, "idle");
}));

test("M7 a malformed newest block never falls back to an older valid one", () => {
  const entries = tx().user("go").say(FENCE(BLOCK)).say("later\n```coordinator-state\n{broken\n```").entries();
  assert.equal(parseStateBlock(entries), null);
  assert.equal(parseStateBlock(tx().user("go").say(FENCE({ ...BLOCK, status: "bogus" })).entries()), null);
  assert.equal(parseStateBlock(tx().user("go").say(FENCE({ ...BLOCK, summary: undefined })).entries()), null);
  assert.equal(parseStateBlock(tx().user("go").say(FENCE({ ...BLOCK, summary: "x".repeat(500) })).entries()).summary.length, 200);
});

test("M7 HL_FAKE_PROBE=fail gives unknown, not a throw", withSb((sb) => {
  bgLane(sb, "w-01", { status: "idle" });
  assert.equal(status(sb, "w-01", { HL_FAKE_PROBE: "fail" }).status, "unknown");
}));

test("M7 a finished lane (done marker) is finished, a crashed lane is dead, a launch-less lane is dead", withSb((sb) => {
  const marker = path.join(sb.tmp, "f-01.done");
  fs.writeFileSync(marker, "{}");
  bgLane(sb, "f-01", { sid: "sf", bg: "bf", status: "stopped", extra: { done_marker: marker.split(path.sep).join("/") } });
  bgLane(sb, "c-01", { sid: "sc", bg: "bc", status: "stopped" });
  assert.equal(status(sb, "f-01").status, "finished");
  const dead = status(sb, "c-01");
  assert.equal(dead.status, "dead");
  assert.ok(dead.blockers[0]);
  assert.equal(status(sb, "ghost-01").status, "dead");
}));

test("pendingMessages lists the unclaimed files, oldest first", withSb((sb) => {
  bgLane(sb, "w-01", { status: "busy" });
  const r = run(sb, `const a = ad(); a.message({ lane: "w-01" }, "one", ${JSON.stringify(RID)}); await new Promise((r) => setTimeout(r, 20)); a.message({ lane: "w-01" }, "two", ${JSON.stringify(RID2)});
    return [a.pendingMessages({ lane: "w-01" }).map((m) => m.text), a.pendingMessages({ lane: "nobody" })];`);
  assert.deepEqual(r, [["one", "two"], []]);
}));

// ---- M11 / M12: the child env and the no-shell rule ---------------------------------------------------------------
test("M11 create passes launchEnv() explicitly: the sandbox registry gets the line, the real one is untouched, no key reaches launch.mjs", withSb((sb) => {
  const real = path.join(SKILL_DIR, "..", "handoff-launch", "sessions.jsonl");
  const stat = () => { try { const s = fs.statSync(real); return `${s.size}:${s.mtimeMs}`; } catch { return "absent"; } };
  const before = stat();
  const spyFile = path.join(sb.tmp, "spy.json");
  const env = { ...sb.env };
  for (const k of Object.keys(env)) if (/^openai_api_key$/i.test(k)) delete env[k];
  env.Openai_Api_Key = "x"; // mixed case on purpose: the strip must match case-insensitively, and the assertion below can fail
  const r = runChild(sb.tmp, env, `const fs = await import("node:fs"); const real = A.makeRunNode();
    const spy = (args, opts) => { fs.writeFileSync(${JSON.stringify(spyFile)}, JSON.stringify({ envKeys: Object.keys(opts.env ?? {}), procHasKey: Object.keys(process.env).some((k) => k.toLowerCase() === "openai_api_key") })); return real(args, opts); };
    const ad = A.createClaudeAdapter({ cfg: { claude: { model: "opus", effort: "high" } }, repo: ${JSON.stringify(sb.repo)}, deps: { runNode: spy } });
    return ad.create({ workerId: "auth-01", label: "auth", objective: "o", instruction: "i", requestId: "r1" });`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  const spy = JSON.parse(fs.readFileSync(spyFile, "utf8"));
  assert.equal(spy.procHasKey, true, "the child process really holds the key, so the strip is what removes it");
  assert.ok(spy.envKeys.includes("HL_REGISTRY_DIR") && spy.envKeys.includes("HL_NO_SPAWN"));
  assert.ok(!spy.envKeys.some((k) => /^(openai_api_key|codex_api_key|codex_run_env_allow)$/i.test(k)));
  const line = sb.registry().find((x) => x.name === "auth-01" && x.launched_at);
  assert.ok(line, "the launch line is in the sandbox registry (HL_REGISTRY_DIR reached the launcher)");
  assert.ok(!line.bg_id && line.no_spawn === true, "HL_NO_SPAWN was honoured: nothing started");
  assert.equal(stat(), before, "the real registry file is untouched");
}));

test("M12 the wake text is ONE argv element of an .exe spawn: quotes become ', semicolons ',' and shell is false", withSb((sb) => {
  bgLane(sb, "w-01", { sid: "s1", bg: "b1", status: "idle" });
  bgLane(sb, "w-02", { sid: "s2", bg: "b2", status: "busy" });
  const text = `tell it " & echo pwned ; x`;
  const r = run(sb, `const spawned = [];
    const sp = (file, argv, o) => { spawned.push({ file, argv, o }); return { status: 0, stdout: "", stderr: "" }; };
    const idle = ad({ spawnSync: sp }).message({ lane: "w-01" }, ${JSON.stringify(text)}, ${JSON.stringify(RID)});
    return { idle, spawned };`);
  assert.equal(r.idle.path, "woke-idle");
  assert.equal(r.spawned.length, 1);
  const [c] = r.spawned;
  assert.equal(c.file, "C:/fake/claude.exe");
  assert.equal(c.o.shell, false);
  assert.equal(c.o.windowsHide, true);
  const expected = `Message from the user, relayed by the coordinator (request ${RID}): tell it ' & echo pwned , x`;
  assert.equal(c.argv.filter((a) => a === expected).length, 1, "exactly one argv element carries the text");
  assert.equal(c.argv.at(-1), expected);
  assert.ok(c.argv.every((a) => !a.includes('"') && !(a !== expected && a.includes("pwned"))));
}));

test("M12 without a claude.exe the idle wake spawns nothing and queues; a busy lane is still delivered by the hook", withSb((sb) => {
  bgLane(sb, "w-01", { sid: "s1", bg: "b1", status: "idle" });
  bgLane(sb, "w-02", { sid: "s2", bg: "b2", status: "busy" });
  const r = run(sb, `const spawned = [];
    const sp = (file, argv, o) => { spawned.push({ file, argv, o }); return { status: 0, stdout: "", stderr: "" }; };
    const a = ad({ spawnSync: sp, claudeCli: () => ({ exe: null }) });
    return { idle: a.message({ lane: "w-01" }, "x", ${JSON.stringify(RID)}), busy: a.message({ lane: "w-02" }, "y", ${JSON.stringify(RID)}), spawned: spawned.length, wake: a.wakeSupported() };`);
  assert.equal(r.idle.path, "queued-until-next-run");
  assert.equal(r.busy.path, "delivered-next-tool");
  assert.equal(r.spawned, 0);
  assert.equal(r.wake, false);
  assert.deepEqual(files(sb, "w-01"), [`${RID}.json`], "still pending for the hook");
}));

test("M12 the adapter's clean() matches the clean in launch.mjs on 5 samples", () => {
  const src = fs.readFileSync(path.join(SKILL_DIR, "..", "handoff-launch", "launch.mjs"), "utf8");
  const m = /^const clean = (\(s\) => .*);\s*$/m.exec(src);
  assert.ok(m, "the clean line of launch.mjs is found");
  const launchClean = new Function(`return ${m[1]}`)();
  for (const s of ['say "hi"', "a; b; c", `both " and ;`, "plain text", `"";;""`]) assert.equal(clean(s), launchClean(s), s);
  assert.equal(clean(`x "y"; z`), "x 'y', z");
});
