import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { inSandbox, fakeClaudeAdapter, fakeCodexAdapter, blockedOutcome, seedWorker, makeRepo, runChild, SKILL_DIR } from "./mc-helpers.mjs";
import { sandbox, sessionLine, setAgents } from "../../handoff-launch/tests/helpers.mjs";
import * as store from "../store.mjs";
import { stateDir, msgKey } from "../paths.mjs";
import { DEFAULTS } from "../config.mjs";
import { emptyDecision } from "../schema.mjs";
import { foldWorkers } from "../workers.mjs";
import { validateDecision } from "../validate.mjs";
import { createDispatcher, createWorkersView, requestIdOf } from "../dispatcher.mjs";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ISO = new Date(NOW).toISOString();
const CFG = DEFAULTS;

function rig({ claude, codex, lanes = () => [], placement = () => null, cfg = CFG, repo = "C:/repo-example", clock = () => NOW } = {}) {
  const c = claude ?? fakeClaudeAdapter(), x = codex ?? fakeCodexAdapter();
  const workersView = createWorkersView({ store, claude: c, codex: x, now: clock });
  const dispatcher = createDispatcher({ cfg, store, claude: c, codex: x, workersView, now: clock, repo, lanes, placement });
  const table = () => foldWorkers(store.readJsonl("workers"));
  const check = async (d) => validateDecision(d, { workers: await workersView() });
  return { c, x, dispatcher, workersView, table, check };
}
const msg = (ids, text) => emptyDecision({ action: ids.length === 1 ? "message_session" : "message_multiple", target_session_ids: ids, worker_instruction: text });
const create = (provider, label, objective = "do the thing") => emptyDecision({ action: "create_session", new_session: { needed: true, provider, label, objective } });
const dispatchLines = () => store.readJsonl("dispatch");
const msgFiles = (lane) => { try { return fs.readdirSync(path.join(stateDir(), "messages", msgKey(lane))).filter((n) => n.endsWith(".json")); } catch { return []; } };

test("requestIdOf is 32 hex characters, stable, and ignores target order", () => {
  const a = requestIdOf("t1", msg(["b-01", "a-01"], "hi"));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, requestIdOf("t1", msg(["a-01", "b-01"], "hi")));
  assert.notEqual(a, requestIdOf("t2", msg(["a-01", "b-01"], "hi")));
  assert.notEqual(a, requestIdOf("t1", msg(["a-01", "b-01"], "hi!")));
  const expected = crypto.createHash("sha256").update(["t1", "message_multiple", "a-01,b-01", "hi", ""].join("|")).digest("hex").slice(0, 32);
  assert.equal(a, expected);
});

test("M1 the same decision and turn twice: one message file, one claude.message call, the second is a duplicate", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  const d = msg(["auth-01"], "please continue");
  const first = await r.dispatcher.dispatch(d, { turnId: "t1" });
  const second = await r.dispatcher.dispatch(d, { turnId: "t1" });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.requestId, first.requestId);
  assert.equal(second.reply, first.reply);
  assert.equal(r.c.calls.message.length, 1);
  assert.equal(msgFiles("auth-01").length, 1);
  assert.deepEqual(dispatchLines().map((l) => l.state), ["intent", "done"]);
}));

test("M1 a crash after the intent line: re-dispatching acts again and still leaves exactly one message file", () => inSandbox(async () => {
  const r = rig({ claude: fakeClaudeAdapter({ throwOnMessage: 1 }) });
  seedWorker("auth-01");
  const d = msg(["auth-01"], "please continue");
  await assert.rejects(() => r.dispatcher.dispatch(d, { turnId: "t1" }), /crash during the act/);
  assert.deepEqual(dispatchLines().map((l) => l.state), ["intent"]);
  const again = await r.dispatcher.dispatch(d, { turnId: "t1" });
  assert.equal(again.duplicate, false);
  assert.equal(r.c.calls.message.length, 2);
  assert.equal(msgFiles("auth-01").length, 1);
  assert.deepEqual(dispatchLines().map((l) => l.state), ["intent", "done"], "no second intent line for the same request");
  assert.equal((await r.dispatcher.dispatch(d, { turnId: "t1" })).duplicate, true);
}));

test("M1 a message reply has one line per target naming the delivery path", () => inSandbox(async () => {
  const paths = ["delivered-next-tool", "woke-idle", "queued-until-next-run", "already-queued"];
  const want = [/delivered at its next tool call/, /woke the idle worker/, /queued until it next runs/, /already/];
  for (const [i, p] of paths.entries()) {
    const r = rig({ claude: fakeClaudeAdapter({ message: { ok: true, path: p } }) });
    seedWorker(`w${i}-01`);
    const out = await r.dispatcher.dispatch(msg([`w${i}-01`], "x"), { turnId: `t${i}` });
    assert.match(out.reply, want[i]);
    assert.deepEqual(out.results.map((x) => [x.target, x.ok, x.path]), [[`w${i}-01`, true, p]]);
  }
}));

test("a Claude worker that is gone is reported, not thrown: ok false with the reason", () => inSandbox(async () => {
  const r = rig({ claude: fakeClaudeAdapter({ message: { ok: false, kind: "dead", reason: "no launch line for auth-01" } }) });
  seedWorker("auth-01");
  const out = await r.dispatcher.dispatch(msg(["auth-01"], "x"), { turnId: "t1" });
  assert.equal(out.results[0].ok, false);
  assert.match(out.reply, /no launch line for auth-01/);
  assert.equal(dispatchLines().at(-1).state, "failed");
}));

test("M4 message_multiple to a Claude and a Codex worker: one result each, the right adapter call, sub-ids from the request id", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  seedWorker("fix-01", "codex");
  const d = msg(["auth-01", "fix-01"], "ship it");
  const out = await r.dispatcher.dispatch(d, { turnId: "t1" });
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results.map((x) => x.target), ["auth-01", "fix-01"]);
  assert.ok(out.results.every((x) => x.ok));
  assert.equal(r.c.calls.message.length, 1);
  assert.equal(r.c.calls.message[0].worker, "auth-01");
  assert.equal(r.x.calls.start.length, 1);
  assert.equal(r.x.calls.start[0].worker, "fix-01");
  assert.equal(r.x.calls.start[0].instruction, "ship it");
  assert.equal(r.x.calls.start[0].requestId, `${out.requestId}:fix-01`);
  assert.equal(r.c.calls.message[0].rid, `${out.requestId}:auth-01`);
  assert.equal(out.reply.split("\n").length, 2);
}));

test("C10 codex.start outcomes map to replies: started, existing, queued, blocked, clarify", () => inSandbox(async () => {
  const cases = [
    [{ started: "fix-01.1" }, true, /started/i],
    [{ started: "fix-01.1", existing: true }, true, /started/i],
    [{ queued: "fix-01.2" }, true, /queued behind its current Codex run/],
    [{ queued: "fix-01.2", existing: true }, true, /queued behind its current Codex run/],
    [blockedOutcome("exhausted", "codex-quota-exhausted", CFG, { isNewWorker: false }), false, /codex-quota-exhausted/],
    [{ blocked: "failed", reason: "codex-login-api_key", fallback: null, existing: true }, false, /codex-login-api_key/],
    [{ clarify: "The worktree of fix-01 has uncommitted changes (fix-01.1)." }, false, /uncommitted changes/],
  ];
  for (const [i, [outcome, ok, re]] of cases.entries()) {
    const r = rig({ codex: fakeCodexAdapter({ start: outcome }) });
    seedWorker("fix-01", "codex");
    const out = await r.dispatcher.dispatch(msg(["fix-01"], "go"), { turnId: `c${i}` });
    assert.equal(out.results[0].ok, ok, JSON.stringify(outcome));
    assert.match(out.reply, re, JSON.stringify(outcome));
    assert.equal(r.c.calls.create.length, 0, "an existing Codex worker is never moved to Claude");
    assert.ok(!r.table().get("fix-01").status.match(/dead|finished/), "the worker is not ended");
    fs.rmSync(stateDir(), { recursive: true, force: true });
  }
}));

test("C11 codex.start rejecting after its child started: reported as started with the status pending, never ended or moved to Claude", () => inSandbox(async () => {
  const r = rig({ codex: fakeCodexAdapter({ start: () => { throw new Error("ledger append failed after spawn"); } }) });
  seedWorker("fix-01", "codex");
  const out = await r.dispatcher.dispatch(msg(["fix-01"], "go"), { turnId: "t1" });
  assert.equal(out.results[0].ok, true);
  assert.match(out.reply, /started; status pending/);
  assert.equal(r.c.calls.create.length, 0);
  assert.equal(r.table().get("fix-01").status, "running");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "ended").length, 0);
}));

test("C11 on a Codex create the same rejection keeps the new worker (no ended event, no Claude fallback)", () => inSandbox(async () => {
  const r = rig({ codex: fakeCodexAdapter({ start: () => { throw new Error("ledger append failed after spawn"); } }) });
  const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" });
  assert.match(out.reply, /started; status pending/);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].target, "fix-01");
  assert.equal(r.c.calls.create.length, 0);
  assert.ok(!["dead", "finished"].includes(r.table().get("fix-01").status));
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "ended").length, 0);
  assert.equal(out.focus, "fix-01");
}));

test("M5 a Codex create the gate refuses as exhausted starts a Claude worker, and M13 records the relationship", () => inSandbox(async () => {
  const r = rig({ codex: fakeCodexAdapter({ start: blockedOutcome("exhausted", "codex-quota-exhausted", CFG) }) });
  const out = await r.dispatcher.dispatch(create("codex", "fix", "repair login"), { turnId: "t1" });
  assert.match(out.reply, /Codex unavailable \(codex-quota-exhausted\): started a Claude worker instead/);
  assert.equal(r.c.calls.create.length, 1);
  assert.equal(r.c.calls.create[0].workerId, "fix-02");
  assert.equal(r.c.calls.create[0].label, "fix");
  assert.equal(r.c.calls.create[0].objective, "repair login");
  const t = r.table();
  assert.equal(t.get("fix-01").status, "dead");
  assert.equal(t.get("fix-01").provider, "codex");
  assert.ok(store.readJsonl("workers").some((e) => e.ev === "ended" && e.worker_id === "fix-01" && e.why === "fallback: codex-quota-exhausted"));
  const w = t.get("fix-02");
  assert.equal(w.provider, "claude");
  assert.equal(w.fallback_of, "fix-01");
  assert.equal(w.fallback_reason, "codex-quota-exhausted");
  assert.notEqual(w.status, "dead");
  assert.equal(out.focus, "fix-02");
  const records = fs.readFileSync(path.join(stateDir(), "coordinator_records.md"), "utf8");
  const rel = records.split("## Task relationships")[1];
  assert.match(rel, /fix-02 replaced a Codex request \(fallback: codex-quota-exhausted\)/);
}));

test("M5 an existing Codex worker's follow-up under exhausted is refused with no migration", () => inSandbox(async () => {
  const x = fakeCodexAdapter({ start: blockedOutcome("exhausted", "codex-quota-exhausted", CFG, { isNewWorker: false }) });
  const r = rig({ codex: x });
  seedWorker("fix-01", "codex");
  const out = await r.dispatcher.dispatch(msg(["fix-01"], "more"), { turnId: "t1" });
  assert.equal(out.results[0].ok, false);
  assert.match(out.reply, /not moved to another provider/);
  assert.equal(r.c.calls.create.length, 0);
  assert.equal(r.table().size, 1);
}));

test("config codex.fallback=refuse: a blocked new Codex worker is refused with the reason and ends", () => inSandbox(async () => {
  const cfg = { ...CFG, codex: { ...CFG.codex, fallback: "refuse" } };
  const r = rig({ cfg, codex: fakeCodexAdapter({ start: blockedOutcome("exhausted", "codex-quota-exhausted", cfg) }) });
  const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" });
  assert.equal(r.c.calls.create.length, 0);
  assert.match(out.reply, /codex-quota-exhausted/);
  assert.match(out.reply, /fallback policy: refuse/);
  assert.equal(r.table().get("fix-01").status, "dead");
}));

test("a Claude fallback that itself fails ends the fallback worker too: no phantom, label reusable", () => inSandbox(async () => {
  const r = rig({
    claude: fakeClaudeAdapter({ create: { ok: false, kind: "cap", reason: "session cap reached" } }),
    codex: fakeCodexAdapter({ start: blockedOutcome("exhausted", "codex-quota-exhausted", CFG) }),
  });
  const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" });
  assert.match(out.reply, /session cap reached/);
  assert.ok([...r.table().values()].every((w) => w.status === "dead"));
  assert.deepEqual((await r.check(create("claude", "fix"))).errors, []);
}));

test("M6 /new codex fix --in auth-01 while auth-01 runs: clarify, no worktree, no attempt, no worker; after it finishes the Codex worker gets its worktree", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01", "codex", { worktree: "/wt/codex-auth-01", branch: "codex-auth-01" });
  const d = create("codex", "fix");
  const blocked = await r.dispatcher.dispatch(d, { turnId: "t1", inWorktreeOf: "auth-01" });
  assert.equal(blocked.results[0].ok, false);
  assert.match(blocked.reply, /auth-01 is still running/);
  assert.match(blocked.reply, /a new worktree from its branch/);
  assert.equal(r.x.calls.ensureWorktree.length, 0);
  assert.equal(r.x.calls.start.length, 0);
  assert.equal(r.table().size, 1);
  store.appendJsonl("workers", { ev: "status", worker_id: "auth-01", status: "finished", at: ISO });
  const ok = await r.dispatcher.dispatch(d, { turnId: "t2", inWorktreeOf: "auth-01" });
  assert.equal(ok.results[0].ok, true, ok.reply);
  assert.equal(r.x.calls.ensureWorktree.length, 1);
  assert.equal(r.x.calls.start.length, 1);
  const given = { id: "fix-01", worktree: "/wt/codex-auth-01", branch: "codex-auth-01", in_worktree_of: "auth-01" };
  assert.deepEqual(r.x.calls.ensureWorkers[0], given, "the adapter is handed the ref's worktree, branch and in_worktree_of");
  assert.deepEqual({ id: r.x.calls.start[0].id, worktree: r.x.calls.start[0].worktree, branch: r.x.calls.start[0].branch, in_worktree_of: r.x.calls.start[0].in_worktree_of }, given);
  const w = r.table().get("fix-01");
  assert.equal(w.in_worktree_of, "auth-01");
  assert.equal(w.worktree, "/wt/codex-auth-01");
  assert.equal(w.branch, "codex-auth-01");
  const records = fs.readFileSync(path.join(stateDir(), "coordinator_records.md"), "utf8");
  assert.match(records, /fix-01 works in auth-01's worktree/);
}));

test("M6 a new worktree branch owned by a live registry lane or a running worker is a clarify; a gone lane is not", () => inSandbox(async () => {
  const lane = { name: "legacy", worktree: "/wt/legacy", branch: "mc-fix-01", gone: false };
  const r1 = rig({ lanes: () => [lane] });
  const out = await r1.dispatcher.dispatch(create("claude", "fix"), { turnId: "t1" });
  assert.equal(out.results[0].ok, false);
  assert.match(out.reply, /mc-fix-01/);
  assert.equal(r1.c.calls.create.length, 0);
  assert.equal(r1.table().size, 0);
  const r2 = rig({ lanes: () => [{ ...lane, gone: true }] });
  const ok = await r2.dispatcher.dispatch(create("claude", "fix"), { turnId: "t2" });
  assert.equal(ok.results[0].ok, true);
  assert.equal(r2.c.calls.create.length, 1);
  // a non-finished worker owning the same branch
  seedWorker("other-01", "claude", { branch: "codex-gone-01", worktree: "/wt/other" });
  const r3 = rig();
  assert.equal((await r3.dispatcher.dispatch(create("codex", "gone"), { turnId: "t3" })).results[0].ok, false);
}));

test("M6 the registry lane check also matches a lane by worktree path (case and slash insensitive)", () => inSandbox(async () => {
  seedWorker("auth-01", "codex", { worktree: "C:/repo-example/.claude/worktrees/shared", branch: "codex-auth-01" });
  store.appendJsonl("workers", { ev: "status", worker_id: "auth-01", status: "finished", at: ISO });
  const r = rig({ lanes: () => [{ name: "hand", worktree: "c:\\repo-example\\.claude\\worktrees\\SHARED", branch: "x", gone: false }] });
  const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1", inWorktreeOf: "auth-01" });
  assert.equal(out.results[0].ok, false);
  assert.match(out.reply, /registry lane hand/);
  assert.equal(r.x.calls.start.length, 0);
}));

test("M11 a failed Claude create leaves auth-01 dead and the label reusable at once (auth-02)", () => inSandbox(async () => {
  let fail = true;
  const c = fakeClaudeAdapter({ create: (a) => (fail ? { ok: false, kind: "cap", reason: "session cap reached (max_sessions 1)" } : undefined) });
  const r = rig({ claude: c });
  const out = await r.dispatcher.dispatch(create("claude", "auth", "do x"), { turnId: "t1" });
  assert.match(out.reply, /session cap reached/);
  assert.equal(out.results[0].ok, false);
  assert.equal(r.table().get("auth-01").status, "dead");
  assert.deepEqual((await r.check(create("claude", "auth", "do x"))).errors, []);
  fail = false;
  const second = await r.dispatcher.dispatch(create("claude", "auth", "do x"), { turnId: "t2" });
  assert.equal(second.results[0].ok, true);
  assert.equal(second.results[0].target, "auth-02");
  assert.equal(r.table().get("auth-02").status === "dead", false);
  assert.equal(second.focus, "auth-02");
}));

for (const [name, opts] of [
  ["ensureWorktree fails", { ensure: { ok: false, reason: "git worktree add failed: boom" } }],
  ["codex.start gives blocked with fallback refuse", { start: { blocked: "unavailable", reason: "codex-login-api_key", fallback: { action: "refuse", reason: "fallback policy: refuse" } } }],
  ["codex.start gives blocked kind conflict (fallback clarify)", { start: blockedOutcome("conflict", "workspace conflict: busy elsewhere", CFG) }],
  ["codex.start gives clarify", { start: { clarify: "worker id cannot name a Codex worktree" } }],
]) {
  test(`M11 a new Codex worker whose ${name}: the label is reusable at once, no non-finished worker is left`, () => inSandbox(async () => {
    const r = rig({ codex: fakeCodexAdapter(opts) });
    const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" });
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].target, "fix-01");
    assert.ok(out.reply.length > 10);
    assert.ok([...r.table().values()].every((w) => w.status === "dead"), JSON.stringify([...r.table().values()].map((w) => w.status)));
    assert.deepEqual((await r.check(create("codex", "fix"))).errors, []);
    assert.equal(r.c.calls.create.length, 0, "never falls back to Claude on these outcomes");
    const ended = store.readJsonl("workers").find((e) => e.ev === "ended");
    assert.ok(ended.why && ended.at, "ended carries a reason and a time");
  }));
}

test("C4 every ended and status event the dispatcher writes carries at; the fold stamps finished_at from it", () => inSandbox(async () => {
  const r = rig({ claude: fakeClaudeAdapter({ create: { ok: false, kind: "failed", reason: "launch exploded" } }) });
  await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" });
  const ended = store.readJsonl("workers").find((e) => e.ev === "ended");
  assert.equal(ended.at, ISO);
  assert.equal(r.table().get("auth-01").finished_at, ISO);
  // a status event from the live view
  seedWorker("w-01", "claude");
  const r2 = rig({ claude: fakeClaudeAdapter({ statuses: { "w-01": { status: "finished", last_result: "all done" } } }) });
  await r2.workersView();
  const ev = store.readJsonl("workers").filter((e) => e.ev === "status" && e.worker_id === "w-01");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].at, ISO);
  assert.equal(ev[0].summary, "all done");
  assert.equal(r2.table().get("w-01").finished_at, ISO);
}));

test("workersView merges the live status once, does not repeat an unchanged status, and ignores unknown probes", () => inSandbox(async () => {
  seedWorker("a-01"); seedWorker("b-01");
  const r = rig({ claude: fakeClaudeAdapter({ statuses: { "a-01": { status: "waiting_for_user", needs_user: "pick one", blockers: ["q"] }, "b-01": { status: "unknown" } } }) });
  const v1 = await r.workersView();
  const a = v1.find((w) => w.id === "a-01");
  assert.equal(a.status, "waiting_for_user");
  assert.equal(a.needs_user, "pick one");
  assert.deepEqual(a.blockers, ["q"]);
  assert.equal(v1.find((w) => w.id === "b-01").status, "running", "an unknown probe keeps the recorded status");
  const n = store.readJsonl("workers").length;
  await r.workersView();
  assert.equal(store.readJsonl("workers").length, n, "no new events for an unchanged status");
}));

test("C6 workersView asks the Claude adapter for ALL its workers in one batch call (one probe per turn), never per worker", () => inSandbox(async () => {
  for (const id of ["a-01", "b-01", "c-01"]) seedWorker(id);
  seedWorker("fix-01", "codex");
  const c = fakeClaudeAdapter();
  const r = rig({ claude: c });
  const v = await r.workersView();
  assert.equal(v.length, 4);
  assert.equal(c.calls.statusAll.length, 1);
  assert.deepEqual(c.calls.statusAll[0].sort(), ["a-01", "b-01", "c-01"]);
  assert.equal(c.calls.status.length, 0);
  assert.deepEqual(r.x.calls.status, ["fix-01"]);
}));

test("workersView falls back to status() per worker when the adapter has no statusAll", () => inSandbox(async () => {
  seedWorker("a-01"); seedWorker("b-01");
  const c = fakeClaudeAdapter({ noStatusAll: true });
  await rig({ claude: c }).workersView();
  assert.deepEqual(c.calls.status.sort(), ["a-01", "b-01"]);
}));

test("workersView does not probe finished or dead workers, and a throwing probe leaves the table unchanged", () => inSandbox(async () => {
  seedWorker("a-01", "claude", { status: "finished" });
  seedWorker("b-01");
  const c = fakeClaudeAdapter();
  c.statusAll = () => { throw new Error("probe exploded"); };
  const v = await rig({ claude: c }).workersView();
  assert.deepEqual(v.map((w) => w.status), ["finished", "running"]);
}));

test("M3 no adapter is called when a request_status/respond/clarify runs; respond and clarify only reply", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  const a = await r.dispatcher.dispatch(emptyDecision({ action: "respond", reply: "Hello there." }), { turnId: "t1" });
  assert.equal(a.reply, "Hello there.");
  const b = await r.dispatcher.dispatch(emptyDecision({ action: "clarify", clarification: "Which one?", confidence: 0.3 }), { turnId: "t2" });
  assert.equal(b.reply, "Which one?");
  assert.equal(r.c.calls.message.length + r.x.calls.start.length + r.c.calls.create.length, 0);
}));

test("request_status replies deterministically, one line per worker; no targets covers all workers", () => inSandbox(async () => {
  seedWorker("auth-01");
  seedWorker("fix-01", "codex", { objective: "repair login" });
  const r = rig({
    claude: fakeClaudeAdapter({ statuses: { "auth-01": { status: "waiting_for_user", last_result: "Need a schema decision", blockers: ["schema unclear", "no db"], needs_user: "pick a schema" } } }),
    codex: fakeCodexAdapter({ statuses: { "fix-01": { status: "running", current_task: "editing login.js" } } }),
  });
  const all = await r.dispatcher.dispatch(emptyDecision({ action: "request_status" }), { turnId: "t1" });
  const lines = all.reply.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "auth-01 (claude) waiting_for_user - Need a schema decision; blockers: schema unclear, no db; needs you: pick a schema");
  assert.match(lines[1], /^fix-01 \(codex\) running - editing login\.js$/);
  const one = await r.dispatcher.dispatch(emptyDecision({ action: "request_status", target_session_ids: ["fix-01"] }), { turnId: "t2" });
  assert.equal(one.reply.split("\n").length, 1);
  assert.equal((await r.dispatcher.status(["auth-01"])).split("\n").length, 1);
  assert.match(await r.dispatcher.status([]), /auth-01[\s\S]*fix-01/);
}));

test("M9 a record_update with a valid alias re-renders coordinator_records.md, and a note with ../ writes nothing but the ledgers and the records file", () => inSandbox(async (env) => {
  const repo = makeRepo(env.root, "repo");
  const r = rig({ repo });
  seedWorker("auth-01");
  seedWorker("fix-01");
  const hashDir = (dir) => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } };
    walk(dir); return out;
  };
  const before = hashDir(stateDir());
  const d = emptyDecision({ action: "respond", reply: "Noted.", record_update: { aliases: [{ session_id: "auth-01", alias: "login worker" }], focus: "fix-01", note: "write ../../src/x.ts and # Heading\n## Evil" } });
  await r.dispatcher.dispatch(d, { turnId: "t1" });
  const after = hashDir(stateDir());
  const changed = Object.keys(after).filter((k) => before[k] !== after[k]).sort();
  assert.ok(changed.includes("coordinator_records.md"));
  assert.ok(changed.every((k) => k === "coordinator_records.md" || /^(exchanges|dispatch|usage|workers|codex-attempts)\.jsonl$/.test(k)), changed.join(","));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "");
  assert.ok(!fs.existsSync(path.join(env.root, "src", "x.ts")));
  const records = fs.readFileSync(path.join(stateDir(), "coordinator_records.md"), "utf8");
  assert.match(records, /- login worker -> auth-01/);
  assert.match(records, /## Focus\s+- fix-01/);
  assert.match(records, /- write \.\.\/\.\.\/src\/x\.ts and # Heading ## Evil/);
  assert.equal(records.split("\n").filter((l) => /^#{1,6} /.test(l)).length, 6, "the note adds no heading");
}));

test("M10 the focus follows the last single target and the created worker; a multi-target message leaves it alone", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01"); seedWorker("inv-01");
  const a = await r.dispatcher.dispatch(msg(["auth-01"], "go"), { turnId: "t1" });
  assert.equal(a.focus, "auth-01");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "focus").at(-1).worker_id, "auth-01");
  const b = await r.dispatcher.dispatch(msg(["inv-01"], "go"), { turnId: "t2" });
  assert.equal(b.focus, "inv-01");
  const m = await r.dispatcher.dispatch(msg(["auth-01", "inv-01"], "both"), { turnId: "t3" });
  assert.equal(m.focus ?? null, null);
  const c = await r.dispatcher.dispatch(create("claude", "new"), { turnId: "t4" });
  assert.equal(c.focus, "new-01");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "focus").at(-1).worker_id, "new-01");
  const dup = await r.dispatcher.dispatch(create("claude", "new"), { turnId: "t4" });
  assert.equal(dup.duplicate, true);
}));

test("a create is idempotent per request id: a re-dispatch after a crash reuses the worker and does not launch twice", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ create: (a) => { if (boom) { boom = false; throw new Error("crash in create"); } return undefined; } });
  const r = rig({ claude: c });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash in create/);
  assert.equal(r.table().size, 1);
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" });
  assert.equal(again.duplicate, false);
  assert.equal(r.table().size, 1, "the same worker, not auth-02");
  assert.equal(again.results[0].target, "auth-01");
}));

test("an unknown action or a worker that vanished since validation is a failed result, not a crash", () => inSandbox(async () => {
  const r = rig();
  const out = await r.dispatcher.dispatch(msg(["ghost-01"], "x"), { turnId: "t1" });
  assert.equal(out.results[0].ok, false);
  assert.match(out.reply, /ghost-01/);
  seedWorker("done-01", "claude", { status: "finished" });
  const fin = await r.dispatcher.dispatch(msg(["done-01"], "x"), { turnId: "t2" });
  assert.equal(fin.results[0].ok, false);
  assert.equal(r.c.calls.message.length, 0);
}));

test("peek returns the stored result of a done request and null otherwise", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  const d = msg(["auth-01"], "x");
  assert.equal(r.dispatcher.peek(d, { turnId: "t1" }), null);
  const out = await r.dispatcher.dispatch(d, { turnId: "t1" });
  const p = r.dispatcher.peek(d, { turnId: "t1" });
  assert.equal(p.requestId, out.requestId);
  assert.equal(p.duplicate, true);
  assert.equal(p.reply, out.reply);
}));

test("a replayed Claude create whose first attempt never reached the registry: the probe marks the phantom dead and the replay launches a fresh worker", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ statuses: { "auth-01": { status: "dead", blockers: ["no launch line for auth-01"] } }, create: () => { if (boom) { boom = false; throw new Error("crash before launch"); } return undefined; } });
  const r = rig({ claude: c });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash before launch/);
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" });
  assert.equal(again.results[0].ok, true);
  assert.equal(r.table().get("auth-01").status, "dead");
  assert.equal(again.results[0].target, "auth-02");
  assert.equal(c.calls.create.length, 2);
}));

test("the default registryLanes matches lanes by branch or worktree and reports gone from the liveness probe", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "live-01", mode: "bg", bg_id: "b1", sid: "s1", branch: "mc-x" });
    sessionLine(sb, { name: "old-01", mode: "bg", bg_id: "b2", sid: "s2", branch: "mc-y" });
    sessionLine(sb, { name: "other-01", mode: "bg", bg_id: "b3", sid: "s3", branch: "mc-z" });
    setAgents(sb, [{ id: "b1", sessionId: "s1", name: "live-01", status: "busy" }]);
    const url = pathToFileURL(path.join(SKILL_DIR, "dispatcher.mjs")).href;
    const r = runChild(sb.tmp, sb.env, `const D = await import(${JSON.stringify(url)}); return D.registryLanes({ branches: ["mc-x", "mc-y"], worktrees: [] }).map((l) => [l.name, l.branch, l.gone]);`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.result.sort(), [["live-01", "mc-x", false], ["old-01", "mc-y", true]]);
  } finally { sb.cleanup(); }
});

// ---- Task 11 fix round ----------------------------------------------------------------------------------------------------------
test("P2 replaying a Codex create whose Claude fallback already exists never calls the Codex adapter on the Claude worker, and makes no third worker", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ create: () => { if (boom) { boom = false; throw new Error("crash after the fallback worker was created"); } return undefined; } });
  const x = fakeCodexAdapter({ start: blockedOutcome("exhausted", "codex-quota-exhausted", CFG) });
  const r = rig({ claude: c, codex: x });
  await assert.rejects(() => r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" }), /crash after the fallback/);
  assert.deepEqual([...r.table().keys()], ["fix-01", "fix-02"]);
  const again = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" });
  assert.equal(x.calls.start.length, 1, "codex.start ran once, for fix-01 only");
  assert.equal(x.calls.ensureWorktree.length, 1);
  assert.deepEqual([...r.table().keys()], ["fix-01", "fix-02"], "no third worker");
  assert.equal(c.calls.create.length, 1, "the fallback was already launched: not launched twice");
  assert.equal(again.results[0].target, "fix-02");
  assert.equal(again.results[0].ok, true);
  assert.match(again.reply, /Codex unavailable \(codex-quota-exhausted\): started a Claude worker instead \(fix-02\)/);
  assert.equal(again.focus, "fix-02");
  assert.equal(r.table().get("fix-02").status === "dead", false);
}));

test("P2 the same replay relaunches the Claude fallback only when the probe says it never reached the registry", () => inSandbox(async () => {
  // a stale table (the coordinator's view of the turn) still shows fix-02 alive while the lane is gone
  let boom = true;
  const c = fakeClaudeAdapter({ create: () => { if (boom) { boom = false; throw new Error("crash"); } return undefined; } });
  const x = fakeCodexAdapter({ start: blockedOutcome("exhausted", "codex-quota-exhausted", CFG) });
  const r = rig({ claude: c, codex: x });
  await assert.rejects(() => r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" }), /crash/);
  const stale = [...r.table().values()];
  c.status = () => ({ status: "dead", blockers: ["no launch line"] });
  const again = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1", workers: stale });
  assert.equal(c.calls.create.length, 2);
  assert.equal(c.calls.create[1].workerId, "fix-02");
  assert.equal(x.calls.start.length, 1);
  assert.equal(again.results[0].ok, true);
}));

test("P3 a Claude create records the worktree and branch the launch really made when they differ from the prediction", () => inSandbox(async () => {
  const c = fakeClaudeAdapter({ create: (a) => ({ ok: true, lane: a.workerId, worktree: "D:/real/place/mc-auth-01", branch: "real-branch" }) });
  const r = rig({ claude: c });
  assert.equal(r.table().size, 0);
  // the conflict check still runs on the PREDICTED value before launching
  const lane = { name: "legacy", worktree: null, branch: "mc-auth-01", gone: false };
  const blocked = rig({ claude: fakeClaudeAdapter(), lanes: () => [lane] });
  assert.equal((await blocked.dispatcher.dispatch(create("claude", "auth"), { turnId: "t0" })).results[0].ok, false);
  const out = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" });
  assert.equal(out.results[0].ok, true);
  const w = r.table().get("auth-01");
  assert.equal(w.worktree, "D:/real/place/mc-auth-01");
  assert.equal(w.branch, "real-branch");
  const ev = store.readJsonl("workers").filter((e) => e.ev === "placed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].at, ISO);
  // a launch that made exactly the predicted place writes no follow-up event
  fs.rmSync(stateDir(), { recursive: true, force: true });
  const r2 = rig({ claude: fakeClaudeAdapter({ create: (a) => ({ ok: true, lane: a.workerId, worktree: "C:/repo-example/.claude/worktrees/mc-auth-01", branch: "mc-auth-01" }) }) });
  await r2.dispatcher.dispatch(create("claude", "auth"), { turnId: "t2" });
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "placed").length, 0);
}));

// ---- Task 11 re-review fixes ---------------------------------------------------------------------------------------------------
const ended = (id) => store.appendJsonl("workers", { ev: "status", worker_id: id, status: "finished", at: ISO });

test("Q2 workspace conflicts compare canonical places: `<path>/.`, a trailing slash, other case and refs/heads/<branch> all match an active owner", () => inSandbox(async () => {
  const spellings = [
    ["a dot segment", { worktree: "/wt/shared/.", branch: "other-a" }],
    ["a trailing slash", { worktree: "/wt/shared/", branch: "other-b" }],
    ["another case and backslashes", { worktree: ["", "WT", "Shared"].join(String.fromCharCode(92)), branch: "other-c" }],
    ["a parent segment", { worktree: "/wt/x/../shared", branch: "other-d" }],
    ["the full branch ref", { worktree: "/wt/elsewhere", branch: "refs/heads/shared-branch" }],
  ];
  for (const [i, [name, ref]] of spellings.entries()) {
    fs.rmSync(stateDir(), { recursive: true, force: true });
    const r = rig();
    seedWorker("own-01", "codex", { worktree: "/wt/shared", branch: "shared-branch" }); // running: the active owner
    seedWorker("ref-01", "codex", { ...ref, status: "finished" });
    const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: `q2-${i}`, inWorktreeOf: "ref-01" });
    assert.equal(out.results[0].ok, false, name);
    assert.match(out.reply, /own-01/, name);
    assert.equal(r.x.calls.start.length, 0, name);
    assert.equal(r.x.calls.ensureWorktree.length, 0, name);
  }
}));

test("Q2 registry lanes are matched canonically too (a lane on refs/heads/<branch>, or a worktree with a dot segment)", () => inSandbox(async () => {
  for (const [i, lane] of [
    { name: "hand", worktree: "/wt/shared/.", branch: null, gone: false },
    { name: "hand", worktree: null, branch: "refs/heads/shared-branch", gone: false },
  ].entries()) {
    fs.rmSync(stateDir(), { recursive: true, force: true });
    const r = rig({ lanes: () => [lane] });
    seedWorker("ref-01", "codex", { worktree: "/wt/shared", branch: "shared-branch", status: "finished" });
    const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: `q2l-${i}`, inWorktreeOf: "ref-01" });
    assert.equal(out.results[0].ok, false);
    assert.match(out.reply, /registry lane hand/);
    assert.equal(r.x.calls.start.length, 0);
  }
  // a gone lane does not block
  fs.rmSync(stateDir(), { recursive: true, force: true });
  const r = rig({ lanes: () => [{ name: "hand", worktree: "/wt/shared/.", branch: null, gone: true }] });
  seedWorker("ref-01", "codex", { worktree: "/wt/shared", branch: "shared-branch", status: "finished" });
  assert.equal((await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "q2g", inWorktreeOf: "ref-01" })).results[0].ok, true);
}));

test("Q2 the registryLanes filter matches a branch given as refs/heads/<name>", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "live-01", mode: "bg", bg_id: "b1", sid: "s1", branch: "refs/heads/mc-x" });
    setAgents(sb, [{ id: "b1", sessionId: "s1", name: "live-01", status: "busy" }]);
    const url = pathToFileURL(path.join(SKILL_DIR, "dispatcher.mjs")).href;
    const r = runChild(sb.tmp, sb.env, `const D = await import(${JSON.stringify(url)}); return D.registryLanes({ branches: ["mc-x"], worktrees: [] }).map((l) => [l.name, l.gone]);`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.result, [["live-01", false]]);
  } finally { sb.cleanup(); }
});

test("Q2 a verified placement that differs from the prediction is rechecked: an active owner of it ends the new worker before codex.start", () => inSandbox(async () => {
  seedWorker("own-01", "codex", { worktree: "/wt/taken", branch: "taken-branch" });
  const x = fakeCodexAdapter({ ensure: { ok: true, worktree: "/wt/taken/.", branch: "refs/heads/taken-branch" } });
  const r = rig({ codex: x });
  const out = await r.dispatcher.dispatch(create("codex", "fix"), { turnId: "t1" });
  assert.equal(out.results[0].ok, false);
  assert.match(out.reply, /own-01/);
  assert.equal(x.calls.start.length, 0);
  assert.equal(r.table().get("fix-01").status, "dead");
  assert.deepEqual((await r.check(create("codex", "fix"))).errors, [], "the label is free again");
  // an equal spelling of the prediction is not a conflict with itself, and writes no placed event
  fs.rmSync(stateDir(), { recursive: true, force: true });
  const x2 = fakeCodexAdapter({ ensure: { ok: true, worktree: "C:/repo-example/.claude/worktrees/codex-fix-01/", branch: "refs/heads/codex-fix-01" } });
  const r2 = rig({ codex: x2 });
  assert.equal((await r2.dispatcher.dispatch(create("codex", "fix"), { turnId: "t2" })).results[0].ok, true);
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "placed").length, 0);
}));

test("Q4 replaying a Claude create whose launch already happened writes the real placement before returning (a crash before `placed`)", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ create: () => { if (boom) { boom = false; throw new Error("crash after the registry line, before placed"); } return undefined; } });
  const r = rig({ claude: c, placement: (id) => ({ worktree: `D:/real/${id}`, branch: "real-branch" }) });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash after the registry line/);
  assert.notEqual(r.table().get("auth-01").worktree, "D:/real/auth-01", "the prediction is what the table holds after the crash");
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" });
  assert.equal(again.results[0].ok, true);
  assert.equal(c.calls.create.length, 1, "not launched twice");
  const w = r.table().get("auth-01");
  assert.equal(w.worktree, "D:/real/auth-01");
  assert.equal(w.branch, "real-branch");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "placed").length, 1);
  // no registry answer: the prediction stands, nothing is written
  fs.rmSync(stateDir(), { recursive: true, force: true });
  boom = true;
  const r2 = rig({ claude: c, placement: () => { throw new Error("registry unreadable"); } });
  await assert.rejects(() => r2.dispatcher.dispatch(create("claude", "auth"), { turnId: "t2" }), /crash/);
  assert.equal((await r2.dispatcher.dispatch(create("claude", "auth"), { turnId: "t2" })).results[0].ok, true);
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "placed").length, 0);
}));

// ---- Task 11 third fix round ----------------------------------------------------------------------------------------------------
test("R1 a replayed Claude create whose launch was recorded but whose lane already finished (or died) before recovery: one launch, one placed, no second worker", () => inSandbox(async () => {
  for (const [i, end] of ["finished", "dead"].entries()) {
    fs.rmSync(stateDir(), { recursive: true, force: true });
    let boom = true;
    const statuses = {};
    const c = fakeClaudeAdapter({ statuses, create: () => { if (boom) { boom = false; throw new Error("crash after the registry line, before placed"); } return undefined; } });
    const r = rig({ claude: c, placement: (id) => ({ worktree: `D:/real/${id}`, branch: "real-branch" }) });
    await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: `t${i}` }), /crash after the registry line/);
    statuses["auth-01"] = { status: end, last_result: "all done" }; // the lane ended before the coordinator recovered
    const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: `t${i}` });
    assert.equal(c.calls.create.length, 1, `${end}: launched once`);
    assert.deepEqual([...r.table().keys()], ["auth-01"], `${end}: no auth-02`);
    assert.equal(again.results[0].target, "auth-01");
    assert.equal(again.results[0].ok, true);
    assert.equal(r.table().get("auth-01").status, end);
    assert.equal(r.table().get("auth-01").worktree, "D:/real/auth-01", `${end}: the real placement is repaired`);
    assert.equal(store.readJsonl("workers").filter((e) => e.ev === "placed").length, 1);
    const third = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: `t${i}` });
    assert.equal(third.duplicate, true);
    assert.equal(c.calls.create.length, 1);
  }
}));

test("R1 a finished worker of the request whose launch was never recorded is not recovered: a fresh worker launches (the phantom-dead case)", () => inSandbox(async () => {
  let boom = true;
  const statuses = {};
  const c = fakeClaudeAdapter({ statuses, create: () => { if (boom) { boom = false; throw new Error("crash before launch"); } return undefined; } });
  const r = rig({ claude: c, placement: () => null });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash before launch/);
  statuses["auth-01"] = { status: "dead" };
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" });
  assert.equal(again.results[0].target, "auth-02");
  assert.equal(c.calls.create.length, 2);
}));

test("R1b a stale non-terminal snapshot whose lane probes dead, with a recorded launch line, never launches again (no second create for the same worker)", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ create: () => { if (boom) { boom = false; throw new Error("crash after the registry line, before placed"); } return undefined; } });
  const r = rig({ claude: c, placement: (id) => ({ worktree: `D:/real/${id}`, branch: "real-branch" }) });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash after the registry line/);
  const stale = [...r.table().values()];
  assert.equal(FINISHED_NOT.has(stale[0].status), true, "the snapshot still shows a live status");
  c.status = () => ({ status: "dead", blockers: ["lane gone"] });
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1", workers: stale });
  assert.equal(c.calls.create.length, 1, "the recorded launch is never repeated");
  assert.deepEqual([...r.table().keys()], ["auth-01"]);
  assert.equal(again.results[0].target, "auth-01");
  assert.equal(again.results[0].ok, true);
  assert.equal(r.table().get("auth-01").worktree, "D:/real/auth-01");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "placed").length, 1);
}));
const FINISHED_NOT = new Set(["starting", "running", "idle", "busy", "blocked", "unknown"]);

// ---- Task 11 fourth fix round: a replay whose snapshot omits the worker ---------------------------------------------------------
test("R2 a Claude create replayed with a snapshot that OMITS the worker, after a recorded launch, never launches again (placement repaired)", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ create: () => { if (boom) { boom = false; throw new Error("crash after the registry line, before placed"); } return undefined; } });
  const r = rig({ claude: c, placement: (id) => ({ worktree: `D:/real/${id}`, branch: "real-branch" }) });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash after the registry line/);
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1", workers: [] });
  assert.equal(c.calls.create.length, 1, "the recorded launch is never repeated");
  assert.deepEqual([...r.table().keys()], ["auth-01"], "no second worker");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "created").length, 1);
  assert.equal(again.results[0].target, "auth-01");
  assert.equal(again.results[0].ok, true);
  assert.match(again.reply, /was already started/);
  assert.equal(r.table().get("auth-01").worktree, "D:/real/auth-01");
  assert.equal(r.table().get("auth-01").branch, "real-branch");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "placed").length, 1);
}));

test("R2 a Claude create replayed with a snapshot that omits the worker, no launch line and the probe says dead: one fresh launch of the same worker", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ create: () => { if (boom) { boom = false; throw new Error("crash before launch"); } return undefined; } });
  const r = rig({ claude: c, placement: () => null });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash before launch/);
  c.status = () => ({ status: "dead", blockers: ["lane gone"] });
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1", workers: [] });
  assert.equal(c.calls.create.length, 2, "the first attempt crashed before any launch line: exactly one fresh launch");
  assert.equal(c.calls.create[1].workerId, "auth-01");
  assert.deepEqual([...r.table().keys()], ["auth-01"]);
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "created").length, 1);
  assert.equal(again.results[0].target, "auth-01");
  assert.equal(again.results[0].ok, true);
  assert.match(again.reply, /Started claude worker auth-01/);
}));

test("R2b a persisted DEAD Claude worker with no launch line and an omitted snapshot: the fresh launch gets a NEW id, one created event per id, messageable", () => inSandbox(async () => {
  let boom = true;
  const c = fakeClaudeAdapter({ create: () => { if (boom) { boom = false; throw new Error("crash before launch"); } return undefined; } });
  const r = rig({ claude: c, placement: () => null });
  await assert.rejects(() => r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1" }), /crash before launch/);
  store.appendJsonl("workers", { ev: "status", worker_id: "auth-01", status: "dead", at: "2026-10-07T00:00:00.000Z" }); // the recovery probe persisted it
  const again = await r.dispatcher.dispatch(create("claude", "auth"), { turnId: "t1", workers: [] });
  const ids = store.readJsonl("workers").filter((e) => e.ev === "created").map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `no duplicate created id: ${ids}`);
  assert.equal(c.calls.create.length, 2, "exactly one fresh launch after the crash");
  const told = again.results[0].target;
  assert.equal(told, "auth-02");
  assert.equal(c.calls.create[1].workerId, told);
  const w = r.table().get(told);
  assert.ok(w && !["finished", "dead"].includes(w.status), "the worker the user is told about is live in the folded table");
  const m = await r.dispatcher.dispatch(msg([told], "go"), { turnId: "t2" });
  assert.equal(m.results[0].ok, true, "and can receive a message");
}));

test("R2b a persisted DEAD Codex worker of the request with an omitted snapshot: a fresh worker gets a NEW id, never a second created event for the old one", () => inSandbox(async () => {
  let boom = true;
  const x = fakeCodexAdapter({ ensure: (w) => { if (boom) { boom = false; throw new Error("crash after created, before start"); } return undefined; } });
  const r = rig({ codex: x });
  await assert.rejects(() => r.dispatcher.dispatch(create("codex", "auth"), { turnId: "t1" }), /crash after created/);
  store.appendJsonl("workers", { ev: "ended", worker_id: "auth-01", why: "gone", at: "2026-10-07T00:00:00.000Z" });
  const again = await r.dispatcher.dispatch(create("codex", "auth"), { turnId: "t1", workers: [] });
  const ids = store.readJsonl("workers").filter((e) => e.ev === "created").map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `no duplicate created id: ${ids}`);
  assert.notEqual(again.results[0].target, "auth-01");
  assert.ok(r.table().has(again.results[0].target));
}));

test("A2 a Codex create replayed after its worker was persisted dead: codex.start dedups to the first attempt, so that worker is reported, no new worker is allocated", () => inSandbox(async () => {
  const d = create("codex", "auth"), rid = requestIdOf("t1", d);
  const attempts = [];
  const x = fakeCodexAdapter({ start: (w, _i, o) => {
    const prior = attempts.find((a) => a.request_id === o.requestId);
    if (prior) return { started: prior.attempt_id, existing: true };
    attempts.push({ attempt_id: `${w.id}.1`, worker_id: w.id, request_id: o.requestId });
    return { started: `${w.id}.1` };
  } });
  x.attemptsByRequest = (id) => attempts.filter((a) => a.request_id === String(id));
  const r = rig({ codex: x });
  seedWorker("auth-01", "codex", { extra: { request_id: rid } });
  attempts.push({ attempt_id: "auth-01.1", worker_id: "auth-01", request_id: rid }); // launched, then the dispatch crashed before `done`
  store.appendJsonl("workers", { ev: "ended", worker_id: "auth-01", why: "gone", at: "2026-10-07T00:00:00.000Z" }); // and the worker was persisted dead
  const again = await r.dispatcher.dispatch(d, { turnId: "t1", workers: [] });
  assert.deepEqual([...r.table().keys()], ["auth-01"], "no auth-02 was allocated");
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "created").length, 1);
  assert.equal(again.results[0].target, "auth-01");
  assert.equal(again.results[0].attempt, "auth-01.1");
  assert.match(again.reply, /auth-01/);
  assert.match(again.reply, /already started/);
  assert.doesNotMatch(again.reply, /auth-02/);
  assert.equal(x.calls.ensureWorktree.length, 0, "no worktree work for a request that already started");
  assert.equal(x.calls.start.length, 1);
  assert.equal(x.calls.start[0].worker, "auth-01");
}));

test("A3 a Codex 'no repo' clarify becomes a reply on both paths: a message to a Codex worker, and a new Codex worker (which ends)", () => inSandbox(async () => {
  const r = rig({ codex: fakeCodexAdapter({ start: { clarify: "no repo" } }) });
  seedWorker("fix-01", "codex");
  const m = await r.dispatcher.dispatch(msg(["fix-01"], "go"), { turnId: "n1" });
  assert.equal(m.results[0].ok, false);
  assert.equal(m.results[0].reason, "no repo");
  assert.match(m.reply, /fix-01: no repo/);
  assert.ok(!r.table().get("fix-01").status.match(/dead|finished/), "the worker is not ended");
  const c = await r.dispatcher.dispatch(create("codex", "auth"), { turnId: "n2" });
  assert.equal(c.results[0].ok, false);
  assert.match(c.reply, /no repo/);
  assert.match(c.reply, /No worker was started/);
  assert.match(r.table().get(c.results[0].target).status, /dead|ended|finished/);
}));

test("R2 a Codex create replayed with a snapshot that omits the worker reuses the recorded worker: one created event, same id, same request id", () => inSandbox(async () => {
  let boom = true;
  const x = fakeCodexAdapter({ ensure: (w) => { if (boom) { boom = false; throw new Error("crash after created, before start"); } return undefined; } });
  const r = rig({ codex: x });
  await assert.rejects(() => r.dispatcher.dispatch(create("codex", "auth"), { turnId: "t1" }), /crash after created/);
  const again = await r.dispatcher.dispatch(create("codex", "auth"), { turnId: "t1", workers: [] });
  assert.equal(store.readJsonl("workers").filter((e) => e.ev === "created").length, 1, "the request's worker is not created twice");
  assert.deepEqual([...r.table().keys()], ["auth-01"]);
  assert.equal(x.calls.start.length, 1);
  assert.equal(x.calls.start[0].worker, "auth-01");
  assert.equal(again.results[0].target, "auth-01");
  assert.equal(again.results[0].ok, true);
}));
