// Task 14: the spec's behaviours end to end. Every scenario runs in a CHILD process (live.mjs and the Codex lib read their env at
// import) on the real store, the real Claude and Codex adapters and the real dispatcher and coordinator, over the handoff-launch
// sandbox (HL_NO_SPAWN, HL_FAKE_CLAUDE, a fake agents list, a temp registry), a fake `codex login status`, the fake `codex-run`
// and a scripted MockCoordinatorProvider. Nothing real starts: no window, no claude, no Codex run, no API call, no spend.
// The CLI-level tests (M4/M5) run cli.mjs main() with stdin lines, a fake fetch and a mock Decisions provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SKILL_DIR, FAKE_CODEX_CLI, FAKE_CODEX_RUN } from "./mc-helpers.mjs";
import { msgKey } from "../paths.mjs";
import { sandbox, sessionLine, setAgents, launchLane, commitIn, writeDone } from "../../handoff-launch/tests/helpers.mjs";

const CLI = path.join(SKILL_DIR, "cli.mjs");
const CRED = /^(openai_api_key|codex_api_key|codex_run_env_allow)$/i;
const url = (rel) => pathToFileURL(path.join(SKILL_DIR, rel)).href;
let counter = 0;

// ---- the sandbox ("mcSandbox") ------------------------------------------------------------------------------------------------
/**
 * handoff-launch sandbox() (registry, repo, CLAUDE_CONFIG_DIR, agents file) plus a temp CODEX_HOME, unique pipe names,
 * CODEX_RUN_BIN=node with the fake login CLI, FAKE_LOGIN, and a scenario file for the fake codex-run. Adds:
 *   makeLive(id, status)  a bg lane (registry line + agents list) and its worker record; the lane reads running ("busy") or idle
 *   scenario(body, {env}) runs `body` in a child with `rig`, `say` etc. (see PRELUDE) and returns the JSON it returns
 *   setRun(obj)           the fake codex-run scenario file (status, reason, delay_ms, ...)
 */
function mcSandbox({ login = "chatgpt" } = {}) {
  const sb = sandbox();
  for (const k of Object.keys(sb.env)) if (CRED.test(k)) delete sb.env[k];
  const n = ++counter;
  sb.codexHome = path.join(sb.tmp, "codex-home");
  fs.mkdirSync(sb.codexHome);
  const runFile = path.join(sb.tmp, "fake-run.json");
  fs.writeFileSync(runFile, "{}");
  Object.assign(sb.env, {
    CODEX_HOME: sb.codexHome, MC_PIPE_NAME: `mc-e2e-${process.pid}-${n}`, CODEX_RUN_PIPE_PREFIX: `codex-run-e2e-${process.pid}-${n}-`,
    CODEX_RUN_BIN: process.execPath, CODEX_RUN_BIN_ARGS: JSON.stringify([FAKE_CODEX_CLI]), FAKE_LOGIN: login, FAKE_RUN_SCENARIO: runFile,
  });
  sb.state = path.join(sb.cfg, "state", "model-coordinator");
  sb.seeds = [];
  sb.setRun = (o) => fs.writeFileSync(runFile, JSON.stringify(o));
  sb.makeLive = (id, status = "busy", o = {}) => {
    const sid = `s-${id}`, bg = `b-${id}`;
    sessionLine(sb, { name: id, mode: "bg", bg_id: bg, sid, ...(o.worktree ? { worktree: o.worktree, branch: o.branch } : {}) });
    const cur = JSON.parse(fs.readFileSync(path.join(sb.tmp, "agents.json"), "utf8"));
    setAgents(sb, [...cur.filter((a) => a.id !== bg), { id: bg, sessionId: sid, name: id, status }]);
    sb.seeds.push({ id, provider: "claude", opts: { lane: id, status: "running", ...(o.worktree ? { worktree: o.worktree, branch: o.branch } : {}) } });
  };
  sb.scenario = (body, { env = {} } = {}) => {
    const file = path.join(sb.tmp, `scn-${++counter}.mjs`);
    fs.writeFileSync(file, `${prelude(sb)}\nconst out = await (async () => {\n${body}\n})();\nprocess.stdout.write("@@RESULT@@" + JSON.stringify(out ?? null) + "\\n", () => process.exit(0));\n`);
    sb.seeds.length = 0;
    const r = spawnSync(process.execPath, [file], { env: { ...sb.env, ...env }, cwd: sb.repo, encoding: "utf8", timeout: 240000, windowsHide: true });
    assert.equal(r.error, undefined, String(r.error));
    const m = /@@RESULT@@(.*)$/m.exec(r.stdout || "");
    assert.ok(m, `scenario failed (exit ${r.status}): ${r.stderr}\n${r.stdout}`);
    return JSON.parse(m[1]);
  };
  return sb;
}
const withSb = (fn, opts) => async () => { const sb = mcSandbox(opts); try { await fn(sb); } finally { sb.cleanup(); } };

/** The child's prelude: imports, the seeds, and `rig` (the full stack over a scripted Luna) with `say(line, {turnId})`. */
function prelude(sb) {
  return `
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as H from ${JSON.stringify(url("tests/mc-helpers.mjs"))};
import * as S from ${JSON.stringify(url("store.mjs"))};
import * as P from ${JSON.stringify(url("paths.mjs"))};
import { DEFAULTS } from ${JSON.stringify(url("config.mjs"))};
import { createClaudeAdapter } from ${JSON.stringify(url("claude-adapter.mjs"))};
import { createCodexAdapter } from ${JSON.stringify(url("codex-adapter.mjs"))};
import { loadCodexLib } from ${JSON.stringify(url("codex-lib.mjs"))};
import { createAllowance, createLoginCache, loginStatus } from ${JSON.stringify(url("codex-resources.mjs"))};
import { createDispatcher, createWorkersView } from ${JSON.stringify(url("dispatcher.mjs"))};
import { createCoordinator } from ${JSON.stringify(url("coordinator.mjs"))};
import { MockCoordinatorProvider } from ${JSON.stringify(url("provider.mjs"))};
import { emptyDecision } from ${JSON.stringify(url("schema.mjs"))};
import { foldWorkers } from ${JSON.stringify(url("workers.mjs"))};
const REPO = ${JSON.stringify(sb.repo)};
const PROFILE_OUT = JSON.stringify({ profile: "full", args: ["--settings", "/fake/settings.json"] });
for (const s of ${JSON.stringify(sb.seeds)}) H.seedWorker(s.id, s.provider, s.opts);
const merge = (a, b) => { for (const [k, v] of Object.entries(b ?? {})) a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v; return a; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = (lane) => { try { return fs.readdirSync(path.join(P.stateDir(), "messages", P.msgKey(lane))).sort(); } catch { return []; } };
const msgText = (lane, f) => JSON.parse(fs.readFileSync(path.join(P.stateDir(), "messages", P.msgKey(lane), f), "utf8")).text;
const workers = () => Object.fromEntries([...foldWorkers(S.readJsonl("workers"))].map(([id, w]) => [id, w]));
const msgTo = (ids, text, extra = {}) => emptyDecision({ action: ids.length === 1 ? "message_session" : "message_multiple", target_session_ids: ids, worker_instruction: text, confidence: 0.9, ...extra });
/** The full stack over a scripted Luna. opts: script (array or fn), cfg (patch), runClaude (fake claude results), runNode (fake launch.mjs), spawn (codex spawn). */
async function rig(opts = {}) {
  const cfg = merge(JSON.parse(JSON.stringify(DEFAULTS)), opts.cfg);
  const runClaude = H.fakeClaudeRunner(opts.runClaude ?? []);
  const claude = createClaudeAdapter({ cfg, repo: REPO, deps: { claudeCli: () => ({ exe: "C:/fake/claude.exe" }), runClaude, ...(opts.runNode ? { runNode: opts.runNode } : {}) } });
  const allowance = createAllowance(cfg.codex.max_parallel_jobs);
  const login = createLoginCache((bin) => loginStatus(bin, { env: process.env, spawnSync }), 300000);
  const lib = await loadCodexLib();
  const codex = createCodexAdapter({ cfg, repo: REPO, lib, allowance, login, deps: { codexRunPath: H.FAKE_CODEX_RUN, requeueDelayMs: 0, ...(opts.spawn ? { spawn: opts.spawn } : {}) } });
  const workersView = createWorkersView({ store: S, claude, codex });
  const dispatcher = createDispatcher({ cfg, store: S, claude, codex, workersView, repo: REPO });
  const mock = new MockCoordinatorProvider(opts.script ?? H.lunaLikePolicy);
  const co = createCoordinator({ cfg, store: S, provider: mock, dispatcher, workersView, project: { repo: REPO }, poll: () => codex.poll() });
  let n = 0;
  const say = (line, o = {}) => co.handleLine(line, { turnId: o.turnId ?? ("e2e-" + process.pid + "-" + (++n)) });
  const pollUntil = async (cond, ms = 60000) => {
    const t0 = Date.now(), events = [];
    for (;;) {
      events.push(...await codex.poll());
      if (cond(events)) return events;
      if (Date.now() - t0 > ms) throw new Error("pollUntil timed out: " + JSON.stringify(S.readJsonl("codex-attempts").map((a) => [a.attempt_id, a.state])));
      await sleep(100);
    }
  };
  const settle = () => pollUntil(() => S.readJsonl("codex-attempts").length === 0 || ![...new Map(S.readJsonl("codex-attempts").map((a) => [a.attempt_id, a.state])).values()].some((s) => ["queued", "reserved", "spawned"].includes(s)));
  return { cfg, claude, codex, runClaude, mock, co, say, workersView, allowance, dispatcher, pollUntil, settle };
}
`;
}

// ---- parent-side helpers --------------------------------------------------------------------------------------------------------
const msgDir = (sb, lane) => path.join(sb.state, "messages", msgKey(lane));
const files = (sb, lane) => { try { return fs.readdirSync(msgDir(sb, lane)).sort(); } catch { return []; } };
const pendingFiles = (sb, lane) => files(sb, lane).filter((f) => !f.endsWith(".delivered.json"));
const ledger = (sb, name) => { try { return fs.readFileSync(path.join(sb.state, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const msgText = (sb, lane, f) => JSON.parse(fs.readFileSync(path.join(msgDir(sb, lane), f), "utf8")).text;
const worktrees = (sb) => sb.git(sb.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9).replace(/\\/g, "/"));
/** One hash over every file below `dir` (relative path and content), `.git` excluded. */
function treeHash(dir, skip = []) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".git" || (d === dir && skip.includes(e.name))) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else h.update(`${path.relative(dir, p)}\0`).update(fs.readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}
const listAll = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listAll(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).replace(/\\/g, "/")]));
/** A rollout whose newest rate_limits event says week `pct` % used with a reset three days away (the Codex lib reads CODEX_HOME). */
function writeRollout(sb, pct) {
  const [y, m, d] = new Date().toISOString().slice(0, 10).split("-");
  const dir = path.join(sb.codexHome, "sessions", y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 3 * 86400;
  const ev = { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "token_count", rate_limits: {
    primary: { window_minutes: 300, used_percent: 5, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    secondary: { window_minutes: 10080, used_percent: pct, resets_at: reset } } } };
  fs.writeFileSync(path.join(dir, "rollout-2026-10-07T10-00-00-thread-e2e.jsonl"), `${JSON.stringify(ev)}\n`);
}
const NEW_CODEX = (label, obj = "do the job") => `await r.say(${JSON.stringify(`/new codex ${label} ${obj}`)})`;

// ---- the spec test list ---------------------------------------------------------------------------------------------------------
test("spec: explicit worker reference", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig(); const o = await r.say("auth-01: keep going"); return { rule: o.rule, reply: o.reply, calls: r.mock.calls.length, path: o.path };`);
  assert.equal(r.rule, "explicit-id");
  assert.equal(r.calls, 0, "no model call");
  assert.equal(r.path, "shortcut");
  assert.match(r.reply, /auth-01: delivered at its next tool call/);
  const f = pendingFiles(sb, "auth-01");
  assert.equal(f.length, 1);
  assert.equal(msgText(sb, "auth-01", f[0]), "auth-01: keep going");
  assert.deepEqual(files(sb, "invoice-01"), []);
}));

test("spec: alias reference", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig();
    const a = await r.say("/alias auth-01 login worker");
    const o = await r.say("tell the login worker to retry");
    return { alias: a.reply, rule: o.rule, calls: r.mock.calls.length, targets: o.decision.target_session_ids };`);
  assert.match(r.alias, /"login worker" now means auth-01/);
  assert.equal(r.rule, "alias");
  assert.equal(r.calls, 0);
  assert.deepEqual(r.targets, ["auth-01"]);
  assert.equal(msgText(sb, "auth-01", pendingFiles(sb, "auth-01")[0]), "tell the login worker to retry");
}));

test("spec: focused-session follow-up", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig();
    await r.say("/to auth-01 start on the login bug");
    const o = await r.say("also add tests");
    return { focus: r.mock.calls[0]?.focused_session_id, calls: r.mock.calls.length, targets: o.decision.target_session_ids };`);
  assert.equal(r.calls, 1);
  assert.equal(r.focus, "auth-01", "the mock saw the focused worker");
  assert.deepEqual(r.targets, ["auth-01"]);
  assert.deepEqual(pendingFiles(sb, "auth-01").map((f) => msgText(sb, "auth-01", f)).sort(), ["also add tests", "start on the login bug"]);
}));

test('spec: "him"', withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig();
    await r.say("/to auth-01 begin");
    const o = await r.say("tell him not to change the backend");
    return { targets: o.decision.target_session_ids, pronoun: r.mock.calls[0].referents.pronoun };`);
  assert.deepEqual(r.targets, ["auth-01"]);
  assert.equal(r.pronoun, "singular");
  assert.ok(pendingFiles(sb, "auth-01").map((f) => msgText(sb, "auth-01", f)).includes("tell him not to change the backend"));
}));

test('spec: "that one"', withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig();
    await r.say("/to auth-01 begin");
    const o = await r.say("have that one rerun the tests");
    return { targets: o.decision.target_session_ids };`);
  assert.deepEqual(r.targets, ["auth-01"]);
  assert.ok(pendingFiles(sb, "auth-01").map((f) => msgText(sb, "auth-01", f)).includes("have that one rerun the tests"));
}));

test('spec: "the other one"', withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig();
    await r.say("/to invoice-01 export the report");
    await r.say("/to auth-01 fix the login");
    const o = await r.say("have the other one check it too");
    return { targets: o.decision.target_session_ids, other: r.mock.calls[0].referents.other };`);
  assert.equal(r.other, "invoice-01");
  assert.deepEqual(r.targets, ["invoice-01"]);
  assert.ok(pendingFiles(sb, "invoice-01").map((f) => msgText(sb, "invoice-01", f)).includes("have the other one check it too"));
}));

test('spec: "do that for both"', withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig();
    await r.say("/to invoice-01 rebase on main");
    await r.say("/to auth-01 rebase on main");
    const o = await r.say("do that for both");
    return { action: o.decision.action, targets: [...o.decision.target_session_ids].sort(), instruction: o.decision.worker_instruction };`);
  assert.equal(r.action, "message_multiple");
  assert.deepEqual(r.targets, ["auth-01", "invoice-01"]);
  assert.equal(r.instruction, "rebase on main", "the previous instruction");
  for (const lane of ["auth-01", "invoice-01"]) {
    assert.ok(pendingFiles(sb, lane).map((f) => msgText(sb, lane, f)).filter((t) => t === "rebase on main").length >= 1, lane);
  }
}));

test('spec: "continue"', withSb(async (sb) => {
  sb.makeLive("auth-01");
  const one = sb.scenario(`const r = await rig(); const o = await r.say("continue"); return { rule: o.rule, calls: r.mock.calls.length, targets: o.decision.target_session_ids };`);
  assert.equal(one.calls, 0, "one live worker: dispatched with no model call");
  assert.equal(one.rule, "continue-single");
  assert.deepEqual(one.targets, ["auth-01"]);
  sb.makeLive("invoice-01");
  const two = sb.scenario(`const r = await rig(); const o = await r.say("continue"); return { rule: o.rule ?? null, calls: r.mock.calls.length, targets: o.decision.target_session_ids, focus: r.mock.calls[0].focused_session_id };`);
  assert.equal(two.calls, 1, "two live workers: the model is called");
  assert.equal(two.focus, "auth-01");
  assert.deepEqual(two.targets, ["auth-01"], "and routes to the focused worker");
}));

test("spec: new worker creation", withSb(async (sb) => {
  sb.makeLive("auth-01");
  sb.setRun({ status: "done" });
  const r = sb.scenario(`const r = await rig();
    const o = await r.say("make another worker for the migration");
    const events = await r.settle();
    const w = workers()["migration-01"];
    const view = (await r.workersView()).find((x) => x.id === "migration-01");
    return { reply: o.reply, action: o.decision.action, w, status: view.status, wt: fs.existsSync(w.worktree), attempts: S.readJsonl("codex-attempts").map((a) => [a.attempt_id, a.state]) };`);
  assert.equal(r.action, "create_session");
  assert.match(r.reply, /^Started codex worker migration-01 \(migration\); run migration-01\.1\.$/);
  assert.equal(r.w.provider, "codex");
  assert.match(r.w.worktree.replace(/\\/g, "/"), /\.claude\/worktrees\/codex-migration-01$/);
  assert.equal(r.w.branch, "codex-migration-01");
  assert.equal(r.wt, true, "the worktree exists");
  assert.ok(worktrees(sb).some((p) => p.endsWith("/codex-migration-01")));
  assert.deepEqual(r.attempts.at(-1), ["migration-01.1", "done"]);
  assert.equal(r.status, "waiting_for_user", "the finished run leaves the worker waiting for the user");
}));

test("spec: multiple targets", withSb(async (sb) => {
  sb.makeLive("auth-01");
  const r = sb.scenario(`const r = await rig();
    await ${NEW_CODEX("mig", "prepare the migration")};
    await r.settle();
    const o = await r.say("/to auth-01,mig-01 rebase on main");
    await r.settle();
    return { results: o.dispatched.results, reply: o.reply, action: o.decision.action };`);
  assert.equal(r.action, "message_multiple");
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.results.map((x) => [x.target, x.ok, x.path]), [["auth-01", true, "delivered-next-tool"], ["mig-01", true, "started"]]);
  assert.equal(msgText(sb, "auth-01", pendingFiles(sb, "auth-01")[0]), "rebase on main");
  const attempts = ledger(sb, "codex-attempts").filter((a) => a.worker_id === "mig-01");
  assert.equal(new Set(attempts.map((a) => a.attempt_id)).size, 2, "the Codex worker got a second run");
}));

test("spec: ambiguous target → clarification", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig(); const o = await r.say("tell him to stop");
    return { action: o.decision.action, reply: o.reply, calls: r.mock.calls.length, msgs: pending("auth-01").length + pending("invoice-01").length, noMsg: !!o.dispatched && o.dispatched.results.length };`);
  assert.equal(r.calls, 1);
  assert.equal(r.action, "clarify");
  assert.match(r.reply, /Which worker/);
  assert.equal(r.msgs, 0, "nothing dispatched");
  assert.equal(r.noMsg, 0);
}));

test("spec: nonexistent session", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const bad = msgTo(["ghost-09"], "hi");
    const r = await rig({ script: [bad, bad] });
    const a = await r.say("/to ghost-09 hi");
    const b = await r.say("please nudge the ghost thing");
    return { a: a.reply, b: b.reply, calls: r.mock.calls.length, reask: r.mock.calls[1]?.validation_errors ?? null, dispatchLines: S.readJsonl("dispatch").length };`);
  assert.match(r.a, /^No worker named ghost-09\. Workers: /);
  assert.equal(r.calls, 2, "a model decision for ghost-09 is re-asked once");
  assert.ok(r.reask.some((e) => e.code === "unknown-target"));
  assert.match(r.b, /^I could not turn that into a valid action\. Workers: /);
  assert.equal(r.dispatchLines, 0);
  assert.deepEqual(files(sb, "ghost-09"), []);
}));

test("spec: completed worker", withSb(async (sb) => {
  const wt = launchLane(sb, "g1", "auth-01");
  const head = commitIn(sb, wt, { "a.txt": "x\n" }, "work");
  writeDone(sb, "g1", "auth-01", head);
  sb.seeds.push({ id: "auth-01", provider: "claude", opts: { lane: "auth-01", status: "running", worktree: wt.replace(/\\/g, "/"), branch: "lane-auth-01" } });
  const r = sb.scenario(`const r = await rig(); const o = await r.say("/to auth-01 more please");
    const view = (await r.workersView()).find((w) => w.id === "auth-01");
    return { reply: o.reply, status: view.status, calls: r.mock.calls.length };`);
  assert.equal(r.status, "finished");
  assert.match(r.reply, /auth-01 is finished and cannot take a message\. Start a new one with \/new/);
  assert.equal(r.calls, 0);
  assert.deepEqual(files(sb, "auth-01"), [], "no message file");
}));

test("spec: duplicate dispatch retry", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const r = sb.scenario(`const r = await rig();
    const first = await r.say("/to auth-01 hi there", { turnId: "dup-1" });
    const second = await r.say("/to auth-01 hi there", { turnId: "dup-1" });
    // the dispatcher's own idempotency: the same decision under the same turn id gives the stored result
    const again = await r.dispatcher.dispatch(first.decision, { turnId: "dup-1" });
    // and the adapter's: the same request id twice is already-queued
    const w = (await r.workersView()).find((x) => x.id === "auth-01");
    const direct = r.claude.message(w, "hi there", "dup-direct");
    const direct2 = r.claude.message(w, "hi there", "dup-direct");
    return { first: first.reply, second: second.reply, replayed: second.replayed === true, again: [again.duplicate, again.reply], direct: [direct.path, direct2.path], exchanges: S.readJsonl("exchanges").filter((e) => e.turn_id === "dup-1").length };`);
  assert.equal(r.replayed, true, "the second handling of the turn is a replay");
  assert.equal(r.second, r.first);
  assert.equal(r.exchanges, 1);
  assert.deepEqual(r.again, [true, r.first]);
  assert.deepEqual(r.direct, ["delivered-next-tool", "already-queued"]);
  const f = pendingFiles(sb, "auth-01");
  assert.equal(f.length, 2, "one file for the turn and one for the direct adapter request");
  assert.equal(f.filter((x) => msgText(sb, "auth-01", x) === "hi there").length, 2);
  assert.equal(ledger(sb, "dispatch").filter((l) => l.state === "intent" && l.turn_id === "dup-1").length, 1);
}));

test("spec: worker failure", withSb(async (sb) => {
  sb.setRun({ status: "failed", reason: "tests failed" });
  const r = sb.scenario(`const r = await rig({ runNode: H.fakeClaudeRunner([{ code: 1, stdout: "", stderr: "launch.mjs: boom, worktree add failed\\n" }]) });
    await ${NEW_CODEX("mig", "break things")};
    await r.settle();
    const status = await r.say("/status");
    const claude = await r.say("/new claude demo build the demo");
    return { status: status.reply, claude: claude.reply, claudeResults: claude.dispatched.results, w: workers(), codexStatus: (await r.workersView()).find((x) => x.id === "mig-01").status };`);
  assert.equal(r.codexStatus, "failed");
  assert.match(r.status, /^mig-01 \(codex\) failed/m);
  assert.match(r.claude, /^Could not start claude worker demo-01: launch\.mjs: boom, worktree add failed\.$/);
  assert.equal(r.claudeResults[0].ok, false);
  assert.match(r.claudeResults[0].reason, /boom/);
  const ended = ledger(sb, "workers").find((e) => e.ev === "ended" && e.worker_id === "demo-01");
  assert.match(ended.why, /boom, worktree add failed/, "the failure reason is recorded");
  assert.equal(r.w["demo-01"].status, "dead");
}));

test("spec: Codex busy", withSb(async (sb) => {
  sb.setRun({ delay_ms: 1500 });
  const r = sb.scenario(`const r = await rig({ cfg: { codex: { max_parallel_jobs: 1 } } });
    const first = await ${NEW_CODEX("alpha", "first job")};
    const second = await ${NEW_CODEX("bravo", "second job")};
    const mid = new Map(S.readJsonl("codex-attempts").map((a) => [a.attempt_id, a.state]));
    await r.pollUntil(() => { const m = new Map(S.readJsonl("codex-attempts").map((a) => [a.attempt_id, a.state])); return m.get("alpha-01.1") === "done" && m.get("bravo-01.1") === "done"; });
    const end = new Map(S.readJsonl("codex-attempts").map((a) => [a.attempt_id, a.state]));
    return { first: first.reply, second: second.reply, mid: [...mid], end: [...end] };`);
  assert.match(r.first, /^Started codex worker alpha-01/);
  assert.match(r.second, /^Created codex worker bravo-01 \(bravo\); queued until a Codex slot is free/);
  assert.deepEqual(Object.fromEntries(r.mid), { "alpha-01.1": "spawned", "bravo-01.1": "queued" }, "the first run is untouched, the second waits");
  assert.deepEqual(Object.fromEntries(r.end), { "alpha-01.1": "done", "bravo-01.1": "done" }, "the second starts after poll()");
}));

test("spec: Codex exhausted", withSb(async (sb) => {
  writeRollout(sb, 99);
  const r = sb.scenario(`const r = await rig({ cfg: { codex: { fallback: "refuse" } }, spawn: H.recordingSpawn() });
    const o = await ${NEW_CODEX("mig", "fix it")};
    return { reply: o.reply, w: workers()["mig-01"], spawned: S.readJsonl("codex-attempts").length };`);
  assert.match(r.reply, /^Codex unavailable \(codex-quota [0-9T:.\-Z]+\): fallback policy: refuse\. No worker was started\.$/);
  assert.equal(r.w.status, "dead");
  assert.match(ledger(sb, "workers").find((e) => e.ev === "ended").why, /codex-quota/);
  assert.equal(r.spawned, 0, "no attempt, no codex-run");
  assert.equal(ledger(sb, "codex-attempts").length, 0);
}));

test("spec: Codex unavailable", async () => {
  for (const login of ["api_key", "none"]) {
    const sb = mcSandbox({ login });
    try {
      const r = sb.scenario(`const spawn = H.recordingSpawn(); const r = await rig({ spawn });
        const o = await ${NEW_CODEX("mig", "fix it")};
        return { reply: o.reply, spawned: spawn.calls.length, w: workers() };`);
      assert.match(r.reply, new RegExp(`^Codex unavailable \\(codex-login-${login}\\): started a Claude worker instead \\(mig-02\\)\\.$`), r.reply);
      assert.equal(r.spawned, 0, "no codex-run spawned");
      assert.equal(ledger(sb, "codex-attempts").length, 0);
      assert.equal(r.w["mig-01"].status, "dead");
      assert.equal(r.w["mig-02"].provider, "claude");
    } finally { sb.cleanup(); }
  }
});

test("spec: Claude fallback", withSb(async (sb) => {
  writeRollout(sb, 99);
  const r = sb.scenario(`const r = await rig({ cfg: { codex: { fallback: "claude" } } });
    const o = await ${NEW_CODEX("mig", "fix it")};
    return { reply: o.reply, w: workers() };`);
  assert.match(r.reply, /^Codex unavailable \(codex-quota [0-9T:.\-Z]+\): started a Claude worker instead \(mig-02\)\.$/);
  const line = sb.registry().find((x) => x.name === "mig-02" && x.launched_at);
  assert.ok(line, "launch.mjs left a registry line");
  assert.equal(line.mode, "bg");
  assert.equal(r.w["mig-02"].provider, "claude");
  assert.equal(r.w["mig-02"].label, "mig", "the same label");
  assert.equal(r.w["mig-02"].fallback_of, "mig-01");
  assert.equal(r.w["mig-01"].status, "dead");
  assert.ok(fs.existsSync(path.join(sb.state, "briefs", "mig-02.md")));
}));

test("spec: parallel Claude/Codex work", withSb(async (sb) => {
  const wt = path.join(sb.repo, ".claude", "worktrees", "mc-auth-01");
  sb.git(sb.repo, "worktree", "add", "-q", "-b", "mc-auth-01", wt);
  sb.makeLive("auth-01", "busy", { worktree: wt.replace(/\\/g, "/"), branch: "mc-auth-01" });
  sb.setRun({ delay_ms: 1500 });
  const r = sb.scenario(`const r = await rig();
    await ${NEW_CODEX("mig", "prepare the migration")};
    const mid = [...new Map(S.readJsonl("codex-attempts").map((a) => [a.attempt_id, a.state]))];
    const o = await r.say("/to auth-01,mig-01 rebase on main");
    await r.settle();
    return { mid, results: o.dispatched.results, w: workers() };`);
  assert.deepEqual(r.mid, [["mig-01.1", "spawned"]], "the Codex worker runs");
  assert.equal(r.results[0].path, "delivered-next-tool", "a Claude message file");
  assert.deepEqual([r.results[1].ok, r.results[1].path], [true, "queued"], "the Codex follow-up is queued");
  assert.equal(pendingFiles(sb, "auth-01").length, 1);
  assert.notEqual(r.w["auth-01"].worktree.replace(/\\/g, "/").toLowerCase(), r.w["mig-01"].worktree.replace(/\\/g, "/").toLowerCase(), "the worktrees differ");
  assert.equal(worktrees(sb).length, 3, "main plus one worktree per worker");
  assert.equal(sb.git(sb.repo, "status", "--porcelain", "--untracked-files=no"), "", "the main checkout is untouched");
  assert.doesNotMatch(sb.git(sb.repo, "status", "--porcelain"), /shared\.txt|check\.cjs|README/);
}));

test("spec: workspace conflict", withSb(async (sb) => {
  sb.makeLive("auth-01");
  const r = sb.scenario(`const r = await rig(); const o = await r.say("/new codex review --in auth-01 review the diff");
    return { reply: o.reply, results: o.dispatched.results, w: Object.keys(workers()) };`);
  assert.match(r.reply, /^auth-01 is still running, so review cannot work in its worktree\./);
  assert.equal(r.results[0].reason, "workspace-conflict");
  assert.deepEqual(r.w, ["auth-01"], "no worker record");
  assert.equal(worktrees(sb).length, 1, "no worktree created");
  assert.ok(!fs.existsSync(path.join(sb.repo, ".claude", "worktrees", "codex-review-01")));
}));

test("spec: Luna attempting unauthorized file edit", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const before = treeHash(sb.repo);
  const r = sb.scenario(`const edit = { ...msgTo(["auth-01"], "hi"), edit: { path: "src/a.ts", content: "x" } };
    const r = await rig({ script: [edit, { action: "write_file", path: "src/a.ts", content: "x" }] });
    const o = await r.say("please look into the flaky thing");
    return { reply: o.reply, calls: r.mock.calls.length, errors: r.mock.calls[1]?.validation_errors ?? null, dispatched: !!o.dispatched };`);
  assert.equal(r.calls, 2, "re-asked once");
  assert.ok(r.errors.some((e) => e.code === "unknown-field"), JSON.stringify(r.errors));
  assert.match(r.reply, /^I could not turn that into a valid action\./);
  assert.equal(r.dispatched, false);
  assert.equal(treeHash(sb.repo), before, "the repo tree is byte-identical");
  assert.equal(sb.git(sb.repo, "status", "--porcelain"), "");
  assert.ok(!fs.existsSync(path.join(sb.repo, "src")));
}));

test("spec: Luna cannot modify anything except its own record", withSb(async (sb) => {
  sb.makeLive("auth-01"); sb.makeLive("invoice-01");
  const before = treeHash(sb.repo, [".claude"]);
  const TOKEN = "PWNED-9f3a1c";
  const r = sb.scenario(`const note = (n, extra = {}) => ({ session_id: "auth-01", ...extra, n });
    const script = (input) => {
      const m = input.message;
      const ru = (note, aliases = []) => ({ aliases, focus: null, note });
      if (/alias/.test(m)) return msgTo(["auth-01"], "update ${TOKEN} ../../etc/passwd", { record_update: ru("remember: write ${TOKEN} into C:/Windows/evil.txt and ../../x.md", [{ session_id: "invoice-01", alias: "billing" }]) });
      if (/new worker/.test(m)) return emptyDecision({ action: "create_session", new_session: { needed: true, provider: "claude", label: "extra", objective: "do ${TOKEN} then write ../../../x" }, worker_instruction: "first step ${TOKEN}", confidence: 0.9, record_update: ru("a new worker ${TOKEN}") });
      if (/status/.test(m)) return emptyDecision({ action: "request_status", confidence: 0.9, record_update: ru("status asked ${TOKEN}") });
      return msgTo(["invoice-01"], "plain message ${TOKEN}", { record_update: ru("note ${TOKEN}") });
    };
    const r = await rig({ script });
    const replies = [];
    for (const l of ["alias the billing worker ${TOKEN}", "start a new worker for extras", "give me a status", "do the thing", "/to auth-01 verbatim ${TOKEN}"]) replies.push((await r.say(l)).reply);
    return { replies };`);
  assert.equal(r.replies.length, 5);
  assert.equal(treeHash(sb.repo, [".claude"]), before, "the repo (outside the new worktrees) is identical");
  assert.equal(sb.git(sb.repo, "status", "--porcelain", "--untracked-files=no"), "");
  // the state folder holds only what the coordinator may write
  const ALLOWED = [/^coordinator_records\.md$/, /^(exchanges|dispatch|usage|workers|codex-attempts)\.jsonl$/, /^instance\.json$/, /^briefs\/[a-z0-9.-]+\.md$/, /^messages\/[0-9a-f]{16}\/[0-9a-f]{32}(\.delivered)?\.json$/, /^codex-out\/[a-z0-9.-]+\.(out|err)$/];
  const stateFiles = listAll(sb.state);
  assert.ok(stateFiles.length > 0);
  for (const f of stateFiles) assert.ok(ALLOWED.some((re) => re.test(f)), `unexpected file in the state folder: ${f}`);
  const records = fs.readFileSync(path.join(sb.state, "coordinator_records.md"), "utf8");
  assert.ok(records.includes(TOKEN), "the note reached the record");
  // model strings never name a path: outside the state folder only worker-bound texts may hold them (launch.mjs copies the brief)
  const outside = [];
  for (const base of [sb.repo, sb.cfg, sb.temp]) {
    if (!fs.existsSync(base)) continue;
    for (const f of listAll(base)) {
      const abs = path.join(base, f);
      if (abs.startsWith(sb.state) || f.startsWith(".git/")) continue;
      let text = ""; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
      if (text.includes(TOKEN)) outside.push(abs);
    }
  }
  assert.deepEqual(outside, [], "model-derived text appears nowhere outside the state folder");
  assert.ok(!fs.existsSync(path.join(sb.tmp, "x.md")) && !fs.existsSync("C:/Windows/evil.txt"));
}));

// ---- Task 14 carried item: a long /to to a busy lane (hook cut + marker) and to an idle one (woken with the full text) ---------------
const LONG = `${"long text ".repeat(900)}END`; // 9003 characters: over the 8 KiB hook cap, under the 10,000-character limit

test("M7 a /to over 8 KiB to a BUSY lane: the file holds it all; the hook delivers it cut with a marker naming the .delivered.json file", withSb(async (sb) => {
  sb.makeLive("w-01", "busy");
  const r = sb.scenario(`const r = await rig(); const o = await r.say(${JSON.stringify(`/to w-01 ${LONG}`)}); return { reply: o.reply };`);
  assert.match(r.reply, /^w-01: delivered at its next tool call$/);
  const f = pendingFiles(sb, "w-01");
  assert.equal(f.length, 1);
  assert.equal(msgText(sb, "w-01", f[0]), LONG, "the pending file has the whole text");
  const hook = spawnSync(process.execPath, [path.join(SKILL_DIR, "deliver-hook.mjs")], {
    env: { ...sb.env, HL_SESSION_ID: "w-01@1" }, input: JSON.stringify({ hook_event_name: "PostToolUse" }), encoding: "utf8", windowsHide: true, timeout: 60000,
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(Buffer.byteLength(hook.stdout) <= 8192, "the hook output stays within 8 KiB");
  const ctx = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  const m = /\[cut: (\d+) more characters; full text in (.+?\.delivered\.json)\]/.exec(ctx);
  assert.ok(m, "the cut text carries a marker");
  assert.ok(ctx.length < LONG.length, "the hook text is cut, not whole");
  assert.equal(path.resolve(m[2]), path.resolve(path.join(msgDir(sb, "w-01"), `${f[0].replace(/\.json$/, "")}.delivered.json`)));
  assert.equal(JSON.parse(fs.readFileSync(m[2], "utf8")).text, LONG, "the named file holds the full text");
  assert.deepEqual(pendingFiles(sb, "w-01"), [], "the file was claimed");
}));

test("M7 a /to over 8 KiB to an IDLE lane wakes it with the full text", withSb(async (sb) => {
  sb.makeLive("w-02", "idle");
  const r = sb.scenario(`const r = await rig({ runNode: H.fakeClaudeRunner([{ code: 0, stdout: PROFILE_OUT }]) });
    const o = await r.say(${JSON.stringify(`/to w-02 ${LONG}`)});
    return { reply: o.reply, calls: r.runClaude.calls.map((c) => c.args) };`);
  assert.match(r.reply, /^w-02: woke the idle worker$/);
  assert.equal(r.calls.length, 1);
  const args = r.calls[0];
  assert.deepEqual(args.slice(0, 2), ["--resume", "s-w-02"]);
  assert.equal(args.at(-2), "--bg");
  assert.ok(args.at(-1).endsWith(LONG), "the wake prompt carries the full text, not a cut one");
  assert.ok(!args.at(-1).includes("[cut:"));
}));

// ---- Decisions Task 14 (M4/M5): the three spec paths and an outage, at CLI level ---------------------------------------------------
const PRICE = { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4, decisions_input_per_mtok: 1 };
const lunaBody = (decision) => JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision) }] }],
  usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } });
const lunaDecision = (p = {}) => ({ action: "respond", target_session_ids: [], worker_instruction: null, reply: "", clarification: null, confidence: 0.95,
  new_session: { needed: false, provider: null, label: null, objective: null }, record_update: null, ...p });
const writeConfig = (sb, obj) => { fs.mkdirSync(sb.state, { recursive: true }); fs.writeFileSync(path.join(sb.state, "config.json"), JSON.stringify(obj)); };

/**
 * Runs cli.mjs main() in a child: `lines` are the REPL's stdin (the input then ends), `fetchSrc` (source of a function (url, init)
 * giving {status, headers, text}; `res(body)` builds one) records every request in `seen`, `decisionsSrc` (source of a Decisions
 * provider) goes in as deps.makeDecisions. -> {code, out, err, seen, asks}.
 */
function runCliMain(sb, { lines, fetchSrc, decisionsSrc, env = {} }) {
  const file = path.join(sb.tmp, `cli-${++counter}.mjs`);
  fs.writeFileSync(file, [
    `import { Readable } from "node:stream";`,
    `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
    `import { ProviderError, MockDecisionsProvider } from ${JSON.stringify(url("provider.mjs"))};`,
    `const ch = (c, p, o = {}) => ({ type: "choice", choice: c, probs: new Map([[c, p], ...Object.entries(o)]) }); const pr = (p) => ({ type: "predicate", pTrue: p });`,
    `const out = [], err = [], seen = [], asks = [];`,
    `const input = new Readable({ read() {} }); for (const l of ${JSON.stringify(lines)}) input.push(l + "\\n"); input.push(null);`,
    `const res = (body, status = 200) => ({ status, headers: { get: () => null }, text: async () => body });`,
    `const fetchFn = ${fetchSrc};`,
    `const deps = { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, input, runLaunch: () => ({ status: 0, stdout: "", stderr: "" }),`,
    `  fetch: async (u, init) => { seen.push({ url: u, body: String(init?.body ?? "") }); return fetchFn(u, init); },`,
    `  makeDecisions: () => { const d = ${decisionsSrc}; return { ask: async (req) => { asks.push(req.input); return d.ask(req); } }; } };`,
    `const code = await main([], deps);`,
    `process.stdout.write("@@RESULT@@" + JSON.stringify({ code, out: out.join(""), err: err.join(""), seen, asks }) + "\\n", () => process.exit(0));`,
  ].join("\n"));
  const r = spawnSync(process.execPath, [file], { env: { ...sb.env, Openai_Api_Key: "sk-test-0000", ...env }, cwd: sb.repo, encoding: "utf8", timeout: 120000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.error, undefined, String(r.error));
  const m = /@@RESULT@@(.*)$/m.exec(r.stdout || "");
  assert.ok(m, `runner failed (exit ${r.status}): ${r.stderr}\n${r.stdout}`);
  const j = JSON.parse(m[1]);
  j.out = j.out.replace(/\r/g, "");
  return j;
}
/** A Decisions provider that routes to `route` (a worker id or new_session) with `provider`; only the routed worker's concern is high. */
const decisionsTo = (route, provider = "claude", needs = 0.1) => `new MockDecisionsProvider((req) => { const o = { route: ch(${JSON.stringify(route)}, 0.95), provider: ch(${JSON.stringify(provider)}, 0.95), needs_text: pr(${needs}) };
  for (const [n, id] of Object.entries(req.offered.concerns)) o[n] = pr(id === ${JSON.stringify(route)} ? 0.9 : 0.05); return o; })`;
const exchanges = (sb) => ledger(sb, "exchanges");
const NO_FETCH = `async () => { throw new Error("no HTTP call expected"); }`;
/** The workers are real lanes (registry + agents list); the table is seeded by a no-op scenario run. */
const prepare = (sb) => sb.scenario(`return null;`);

test("M4 path 1 (shortcut): /to goes straight to the worker; no Decisions call, no Luna call", withSb(async (sb) => {
  writeConfig(sb, { provider: "openai", pricing: { "gpt-6-luna": PRICE } });
  sb.makeLive("w-01");
  prepare(sb);
  const r = runCliMain(sb, { lines: ["/to w-01 hello there"], fetchSrc: NO_FETCH, decisionsSrc: decisionsTo("w-01") });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^w-01: delivered at its next tool call$/m);
  assert.equal(r.seen.length, 0, "no HTTP call");
  assert.equal(r.asks.length, 0, "no Decisions call");
  assert.equal(msgText(sb, "w-01", pendingFiles(sb, "w-01")[0]), "hello there");
  assert.equal(exchanges(sb).at(-1).path, "shortcut");
  assert.equal(exchanges(sb).at(-1).rule, "command");
}, { login: "none" }));

test("M4 path 2 (Decisions): an ambiguous line is routed by Decisions probabilities and delivered verbatim; Luna is not called", withSb(async (sb) => {
  writeConfig(sb, { provider: "openai", pricing: { "gpt-6-luna": PRICE } });
  sb.makeLive("w-01"); sb.makeLive("w-02");
  prepare(sb);
  const line = "please look into the flaky thing";
  const r = runCliMain(sb, { lines: [line], fetchSrc: NO_FETCH, decisionsSrc: decisionsTo("w-02") });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.asks.length, 1, "one Decisions call");
  assert.match(r.asks[0], /^Message: please look into the flaky thing$/m);
  assert.equal(r.seen.length, 0, "no Luna call");
  assert.match(r.out, /^w-02: delivered at its next tool call$/m);
  assert.equal(msgText(sb, "w-02", pendingFiles(sb, "w-02")[0]), line, "the user's text, verbatim");
  assert.deepEqual(files(sb, "w-01"), []);
  const ex = exchanges(sb).at(-1);
  assert.equal(ex.path, "decisions");
  assert.deepEqual(ex.targets, ["w-02"]);
  assert.ok(ex.route_p1 >= 0.9);
}, { login: "none" }));

test("M4 path 3 (Decisions + Luna writer): code picks create_session, Luna only writes the brief text; a Claude worker is created", withSb(async (sb) => {
  writeConfig(sb, { provider: "openai", pricing: { "gpt-6-luna": PRICE } });
  sb.makeLive("w-01");
  prepare(sb);
  const line = "plan the invoice export rewrite for the billing service";
  // Luna tries to change the route (respond, provider codex) and writes the label, objective and first instruction
  const answer = lunaDecision({ action: "respond", target_session_ids: [], worker_instruction: "Start by reading export.ts", reply: "ignored",
    new_session: { needed: false, provider: "codex", label: "invoice-export", objective: "Rewrite the invoice export" } });
  const r = runCliMain(sb, { lines: [line], fetchSrc: `async () => res(${JSON.stringify(lunaBody(answer))})`, decisionsSrc: decisionsTo("new_session", "claude") });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.asks.length, 1);
  assert.equal(r.seen.length, 1, "one Luna call, as the writer");
  assert.match(r.seen[0].body, /pinned_route/);
  assert.match(r.out, /^Started claude worker invoice-export-01 \(invoice-export\)\.$/m);
  const created = ledger(sb, "workers").find((e) => e.ev === "created" && e.id === "invoice-export-01");
  assert.equal(created.provider, "claude", "the provider came from code, not from Luna");
  assert.equal(created.label, "invoice-export");
  const brief = fs.readFileSync(path.join(sb.state, "briefs", "invoice-export-01.md"), "utf8");
  assert.match(brief, /Rewrite the invoice export/);
  assert.match(brief, /Start by reading export\.ts/);
  assert.ok(sb.registry().some((x) => x.name === "invoice-export-01" && x.mode === "bg"), "launch.mjs ran in bg mode");
  assert.deepEqual(files(sb, "w-01"), [], "no message went to the existing worker");
  assert.equal(exchanges(sb).at(-1).path, "decisions");
}, { login: "none" }));

test("M5 a Decisions outage falls back to Luna, which routes the line (path luna-fallback)", withSb(async (sb) => {
  writeConfig(sb, { provider: "openai", pricing: { "gpt-6-luna": PRICE } });
  sb.makeLive("w-01"); sb.makeLive("w-02");
  prepare(sb);
  const line = "please look into the flaky thing";
  const answer = lunaDecision({ action: "message_session", target_session_ids: ["w-01"], worker_instruction: line });
  const r = runCliMain(sb, { lines: [line], fetchSrc: `async () => res(${JSON.stringify(lunaBody(answer))})`,
    decisionsSrc: `{ ask: async () => { throw new ProviderError("unavailable", "fake outage"); } }` });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.asks.length, 1, "Decisions was tried first");
  assert.deepEqual(r.seen.map((s) => s.url), ["https://api.openai.com/v1/responses"], "then Luna answered");
  assert.match(r.out, /^w-01: delivered at its next tool call$/m);
  assert.equal(msgText(sb, "w-01", pendingFiles(sb, "w-01")[0]), line);
  assert.equal(exchanges(sb).at(-1).path, "luna-fallback");
  assert.deepEqual(files(sb, "w-02"), []);
}, { login: "none" }));
