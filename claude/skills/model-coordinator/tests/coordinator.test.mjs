import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inSandbox, fakeClaudeAdapter, fakeCodexAdapter, blockedOutcome, seedWorker, sleep } from "./mc-helpers.mjs";
import * as store from "../store.mjs";
import { stateDir, msgKey } from "../paths.mjs";
import { DEFAULTS } from "../config.mjs";
import { emptyDecision } from "../schema.mjs";
import { foldWorkers } from "../workers.mjs";
import { validateDecision } from "../validate.mjs";
import { ProviderError, MockCoordinatorProvider, NullProvider } from "../provider.mjs";
import { createDispatcher, createWorkersView } from "../dispatcher.mjs";
import { createCoordinator, validateForDispatch } from "../coordinator.mjs";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const CFG = DEFAULTS;

function rig({ script = [], provider, claude, codex, cfg = CFG, cost = null, codexState = null, poll = null, lanes = () => [] } = {}) {
  const c = claude ?? fakeClaudeAdapter(), x = codex ?? fakeCodexAdapter();
  const prov = provider ?? new MockCoordinatorProvider(script);
  const workersView = createWorkersView({ store, claude: c, codex: x, now: () => NOW });
  const dispatcher = createDispatcher({ cfg, store, claude: c, codex: x, workersView, now: () => NOW, repo: "C:/repo-example", lanes });
  const coordinator = createCoordinator({ cfg, store, provider: prov, dispatcher, workersView, codexState: codexState ?? undefined, costState: cost ?? undefined, poll: poll ?? undefined, now: () => NOW, project: { repo: "repo-example" } });
  return { c, x, prov, coordinator, workersView, dispatcher, table: () => foldWorkers(store.readJsonl("workers")) };
}
const msg = (ids, text, p = {}) => emptyDecision({ action: ids.length === 1 ? "message_session" : "message_multiple", target_session_ids: ids, worker_instruction: text, confidence: 0.9, ...p });
const create = (provider, label, objective = "do the thing") => emptyDecision({ action: "create_session", new_session: { needed: true, provider, label, objective }, confidence: 0.9 });
const adapterCalls = (r) => r.c.calls.message.length + r.c.calls.create.length + r.x.calls.start.length + r.x.calls.ensureWorktree.length;

test("M2 a model decision targeting ghost-01 is re-asked once with validation_errors, then it is a clarify reply", () => inSandbox(async () => {
  const bad = msg(["ghost-01"], "do it");
  const r = rig({ script: [bad, bad] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("please nudge the thing", { turnId: "t1" });
  assert.equal(r.prov.calls.length, 2);
  assert.equal(r.prov.calls[0].validation_errors, undefined);
  assert.equal(r.prov.calls[1].validation_errors[0].code, "unknown-target");
  assert.deepEqual(Object.keys(r.prov.calls[1].validation_errors[0]).sort(), ["code", "field"], "codes and fields only");
  assert.match(out.reply, /auth-01/, "the clarify lists the workers");
  assert.equal(out.dispatched, undefined);
  assert.equal(adapterCalls(r), 0);
}));

test("M7 invalid twice: clarify, nothing dispatched, dispatch.jsonl unchanged", () => inSandbox(async () => {
  const bad = emptyDecision({ action: "message_session", target_session_ids: [], worker_instruction: null });
  const r = rig({ script: [bad, bad] });
  seedWorker("auth-01");
  const before = store.readJsonl("dispatch");
  const out = await r.coordinator.handleLine("do the needful", { turnId: "t1" });
  assert.deepEqual(store.readJsonl("dispatch"), before);
  assert.equal(r.prov.calls.length, 2);
  assert.equal(out.decision, undefined);
  assert.equal(adapterCalls(r), 0);
  assert.equal(fs.existsSync(path.join(stateDir(), "dispatch.jsonl")), false);
}));

test("a re-ask that comes back valid is dispatched; the first invalid answer is never acted on", () => inSandbox(async () => {
  const r = rig({ script: [msg(["ghost-01"], "x"), msg(["auth-01"], "go")] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("poke the login thing", { turnId: "t1" });
  assert.equal(r.prov.calls.length, 2);
  assert.equal(r.c.calls.message.length, 1);
  assert.match(out.reply, /auth-01: delivered at its next tool call/);
  assert.equal(out.rule, undefined);
  assert.equal(out.decision.target_session_ids[0], "auth-01");
}));

test("M3 a message to a finished worker is a clarify naming it finished and suggesting /new; a dead one suggests /restart-closed; no adapter is called", () => inSandbox(async () => {
  const r = rig({ script: [] });
  seedWorker("done-01", "claude", { status: "finished" });
  seedWorker("lost-01", "claude", { status: "dead" });
  const a = await r.coordinator.handleLine("/to done-01 hello", { turnId: "t1" });
  assert.match(a.reply, /done-01 is finished/);
  assert.match(a.reply, /\/new/);
  const b = await r.coordinator.handleLine("/to lost-01 hello", { turnId: "t2" });
  assert.match(b.reply, /lost-01 is dead/);
  assert.match(b.reply, /\/restart-closed/);
  assert.equal(adapterCalls(r), 0);
  assert.equal(r.prov.calls.length, 0);
  // the model path: the same advice after two invalid answers
  const bad = msg(["done-01"], "hello");
  const r2 = rig({ script: [bad, bad] });
  const c = await r2.coordinator.handleLine("tell the done worker hi please", { turnId: "t3" });
  assert.match(c.reply, /done-01 is finished/);
  assert.match(c.reply, /\/new/);
  assert.equal(adapterCalls(r2), 0);
}));

test("M8 /to auth-01 with 10000 characters delivers the whole text (the message file holds 10000)", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  const text = "x".repeat(10000);
  const out = await r.coordinator.handleLine(`/to auth-01 ${text}`, { turnId: "t1" });
  assert.match(out.reply, /auth-01: delivered at its next tool call/);
  assert.equal(r.c.calls.message[0].text.length, 10000);
  const dir = path.join(stateDir(), "messages", msgKey("auth-01"));
  const [f] = fs.readdirSync(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text.length, 10000);
  assert.equal(r.prov.calls.length, 0);
  assert.equal(out.rule, "command");
}));

test("C2 verbatim validation skips only the too-long check; every other check still applies", () => {
  const ws = [{ id: "auth-01", provider: "claude", label: "auth", aliases: [], status: "running" }, { id: "old-01", provider: "claude", label: "old", aliases: [], status: "finished" }];
  const long = "x".repeat(10000);
  assert.equal(validateForDispatch(msg(["auth-01"], long), { workers: ws, verbatim: true }).ok, true);
  assert.equal(validateForDispatch(msg(["auth-01"], long), { workers: ws }).ok, false, "not verbatim: too-long is an error");
  assert.ok(validateForDispatch(msg(["auth-01"], `${long}\u0007`), { workers: ws, verbatim: true }).errors.some((e) => e.code === "control-char"));
  assert.ok(validateForDispatch(msg(["ghost-01"], long), { workers: ws, verbatim: true }).errors.some((e) => e.code === "unknown-target"));
  assert.ok(validateForDispatch(msg(["old-01"], long), { workers: ws, verbatim: true }).errors.some((e) => e.code === "target-not-messageable"));
  assert.ok(validateForDispatch(msg(["auth-01"], "   "), { workers: ws, verbatim: true }).errors.some((e) => e.code === "instruction-required"));
  const tooLongReply = emptyDecision({ action: "respond", reply: "r".repeat(2001) });
  assert.ok(validateForDispatch(tooLongReply, { workers: ws, verbatim: true }).errors.some((e) => e.code === "too-long" && e.field === "reply"));
});

test("M9 a model record_update with a valid alias re-renders the records file and the alias then resolves", () => inSandbox(async () => {
  const d = emptyDecision({ action: "respond", reply: "Okay.", confidence: 0.9, record_update: { aliases: [{ session_id: "auth-01", alias: "login worker" }], focus: null, note: "user calls auth the login worker" } });
  const r = rig({ script: [d] });
  seedWorker("auth-01");
  await r.coordinator.handleLine("remember that one is the login worker", { turnId: "t1" });
  const records = fs.readFileSync(path.join(stateDir(), "coordinator_records.md"), "utf8");
  assert.match(records, /- login worker -> auth-01/);
  assert.match(records, /- user calls auth the login worker/);
  const out = await r.coordinator.handleLine('/to "login worker" hi', { turnId: "t2" });
  assert.match(out.reply, /auth-01: delivered/);
}));

test("M10 the focus follows the last single target and the created worker", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01"); seedWorker("inv-01");
  assert.equal(r.coordinator.focus(), null);
  await r.coordinator.handleLine("/to auth-01 go", { turnId: "t1" });
  assert.equal(r.coordinator.focus(), "auth-01");
  await r.coordinator.handleLine("/to inv-01 go", { turnId: "t2" });
  assert.equal(r.coordinator.focus(), "inv-01");
  await r.coordinator.handleLine("/new claude billing build the billing page", { turnId: "t3" });
  assert.equal(r.coordinator.focus(), "billing-01");
}));

test("M11 /new claude auth do x with a cap-refusing create replies with the reason, leaves auth-01 dead, and a second /new makes auth-02", () => inSandbox(async () => {
  let fail = true;
  const r = rig({ claude: fakeClaudeAdapter({ create: () => (fail ? { ok: false, kind: "cap", reason: "session cap reached (max_sessions 1)" } : undefined) }) });
  const a = await r.coordinator.handleLine("/new claude auth do x", { turnId: "t1" });
  assert.match(a.reply, /session cap reached/);
  assert.equal(r.table().get("auth-01").status, "dead");
  fail = false;
  const b = await r.coordinator.handleLine("/new claude auth do x", { turnId: "t2" });
  assert.doesNotMatch(b.reply, /label-in-use/);
  assert.match(b.reply, /Started claude worker auth-02/);
  assert.equal(r.table().get("auth-02").provider, "claude");
}));

test("M6 a create whose label equals a live worker's is label-in-use; from the model it ends in a clarify", () => inSandbox(async () => {
  const r = rig({ script: [create("claude", "auth"), create("claude", "auth")] });
  seedWorker("auth-01");
  const cmd = await r.coordinator.handleLine("/new claude auth more work", { turnId: "t1" });
  assert.match(cmd.reply, /label-in-use/);
  const model = await r.coordinator.handleLine("start one more helper for login work", { turnId: "t2" });
  assert.equal(r.prov.calls.at(-1).validation_errors[0].code, "label-in-use");
  assert.match(model.reply, /auth-01/);
  assert.equal(r.c.calls.create.length, 0);
}));

test("M6 /new codex fix --in auth-01 through the loop: clarify while running, then the worktree of the finished worker", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01", "codex", { worktree: "/wt/codex-auth-01", branch: "codex-auth-01" });
  const a = await r.coordinator.handleLine("/new codex fix --in auth-01 repair login", { turnId: "t1" });
  assert.match(a.reply, /a new worktree from its branch/);
  assert.equal(r.x.calls.ensureWorktree.length, 0);
  store.appendJsonl("workers", { ev: "status", worker_id: "auth-01", status: "finished", at: "2026-10-07T11:00:00.000Z" });
  const b = await r.coordinator.handleLine("/new codex fix --in auth-01 repair login", { turnId: "t2" });
  assert.match(b.reply, /Started codex worker fix-01/);
  assert.equal(r.table().get("fix-01").worktree, "/wt/codex-auth-01");
  assert.equal(r.x.calls.start[0].worktree, "/wt/codex-auth-01", "the adapter received the ref's worktree");
  assert.equal(r.x.calls.ensureWorkers[0].in_worktree_of, "auth-01");
}));

test("M12 a ProviderError('hard-limit') gives the Luna-is-unavailable reply and a /to in the next line still dispatches; a plain Error propagates", () => inSandbox(async () => {
  const r = rig({ script: [() => { throw new ProviderError("hard-limit", "monthly hard limit $10 reached ($10.00)"); }] });
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("what is going on with everything", { turnId: "t1" });
  assert.match(a.reply, /^Luna is unavailable \(hard-limit: monthly hard limit \$10 reached \(\$10\.00\)\)\. Use \/to <id> <text>, \/status, \/new/);
  const b = await r.coordinator.handleLine("/to auth-01 hi", { turnId: "t2" });
  assert.match(b.reply, /auth-01: delivered/);
  assert.equal(r.c.calls.message.length, 1);
  const r2 = rig({ script: [() => { throw new Error("a bug"); }] });
  seedWorker("auth-01");
  await assert.rejects(() => r2.coordinator.handleLine("how are things", { turnId: "t3" }), /a bug/);
  const after = await r2.coordinator.handleLine("/status", { turnId: "t4" });
  assert.match(after.reply, /auth-01/, "the queue recovers after a propagated error");
}));

test("with provider none the reply has the documented format", () => inSandbox(async () => {
  const r = rig({ provider: new NullProvider() });
  seedWorker("auth-01"); seedWorker("inv-01");
  const a = await r.coordinator.handleLine("what should I do next here", { turnId: "t1" });
  assert.match(a.reply, /^Luna is unavailable \(no-provider: /m);
  const b = await r.coordinator.handleLine("/to auth-01 hi", { turnId: "t2" });
  assert.match(b.reply, /delivered/);
}));

test("C1 two overlapping handleLine calls never overlap in the provider: the second decide starts after the first one ended", () => inSandbox(async () => {
  const events = [];
  let n = 0;
  const provider = { async decide() { const i = ++n; events.push(`start${i}`); await sleep(60); events.push(`end${i}`); return emptyDecision({ action: "respond", reply: `answer ${i}`, confidence: 0.9 }); } };
  const r = rig({ provider });
  seedWorker("auth-01");
  const [a, b] = await Promise.all([r.coordinator.handleLine("question one here", { turnId: "t1" }), r.coordinator.handleLine("question two here", { turnId: "t2" })]);
  assert.deepEqual(events, ["start1", "end1", "start2", "end2"]);
  assert.equal(a.reply, "answer 1");
  assert.equal(b.reply, "answer 2");
}));

test("C1 a failing line does not wedge the queue behind it", () => inSandbox(async () => {
  let n = 0;
  const provider = { async decide() { if (++n === 1) throw new Error("boom"); return emptyDecision({ action: "respond", reply: "fine", confidence: 0.9 }); } };
  const r = rig({ provider });
  const [a, b] = await Promise.allSettled([r.coordinator.handleLine("one question", { turnId: "t1" }), r.coordinator.handleLine("another question", { turnId: "t2" })]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
  assert.equal(b.value.reply, "fine");
}));

test("C3 context-over-budget replies with a clear message instead of crashing, and shortcuts still work", () => inSandbox(async () => {
  const cfg = { ...CFG, context: { ...CFG.context, max_tokens: 60 } };
  const r = rig({ cfg, script: [] });
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("what is the state of things", { turnId: "t1" });
  assert.match(a.reply, /too large for Luna's context/);
  assert.match(a.reply, /\/to <id> <text>/);
  assert.equal(r.prov.calls.length, 0);
  const b = await r.coordinator.handleLine("/to auth-01 hi", { turnId: "t2" });
  assert.match(b.reply, /auth-01: delivered/);
}));

test("C5 at the hard limit the model-bound reply states the condition, makes no provider call, and a /to in the next line still dispatches", () => inSandbox(async () => {
  const cost = () => ({ state: "hard", spent_usd: 10.4, soft: 7, hard: 10 });
  const r = rig({ cost, script: [] });
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("please summarise everything", { turnId: "t1" });
  assert.equal(r.prov.calls.length, 0);
  assert.match(a.reply, /hard limit/);
  assert.match(a.reply, /\$10/);
  assert.match(a.reply, /\/to <id> <text>/);
  assert.ok(a.notices.some((n) => /hard limit/.test(n)), "every reply shows the condition");
  const b = await r.coordinator.handleLine("/to auth-01 hi", { turnId: "t2" });
  assert.match(b.reply, /auth-01: delivered/);
  assert.ok(b.notices.some((n) => /hard limit/.test(n)), "shortcut replies show it too");
  assert.equal(r.prov.calls.length, 0);
}));

test("a soft-limit state adds a notice but still calls the provider; Codex trouble adds a notice", () => inSandbox(async () => {
  const r = rig({
    cost: () => ({ state: "soft", spent_usd: 7.5, soft: 7, hard: 10 }),
    codexState: () => ({ active_jobs: 2, max_parallel_jobs: 2, available: false, capacity_available: false, usage_status: "unknown" }),
    script: [emptyDecision({ action: "respond", reply: "hi", confidence: 0.9 })],
  });
  const out = await r.coordinator.handleLine("hello there", { turnId: "t1" });
  assert.equal(r.prov.calls.length, 1);
  assert.equal(r.prov.calls[0].project.cost.state, "soft");
  assert.ok(out.notices.some((n) => /soft limit/.test(n)));
  assert.ok(out.notices.some((n) => /Codex/.test(n)));
}));

test("a low-confidence dispatching decision becomes a clarify reply and dispatches nothing", () => inSandbox(async () => {
  const d = msg(["auth-01"], "do it", { confidence: 0.3, clarification: "Do you mean auth-01?" });
  const r = rig({ script: [d, msg(["auth-01"], "do it", { confidence: 0.2 })] });
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("do it to the thing", { turnId: "t1" });
  assert.equal(a.reply, "Do you mean auth-01?");
  const b = await r.coordinator.handleLine("do it to the thing again", { turnId: "t2" });
  assert.match(b.reply, /Which worker do you mean\?/);
  assert.equal(adapterCalls(r), 0);
  assert.equal(store.readJsonl("dispatch").length, 0);
}));

test("every line appends one exchanges.jsonl record with turn_id, at, user, reply, action, targets, instruction and rule", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  await r.coordinator.handleLine("/to auth-01 go ahead", { turnId: "t1" });
  await r.coordinator.handleLine("/to ghost-9 go", { turnId: "t2" });
  const ex = store.readJsonl("exchanges");
  assert.equal(ex.length, 2);
  assert.deepEqual(Object.keys(ex[0]).sort(), ["action", "at", "instruction", "path", "reply", "rule", "targets", "turn_id", "user"]);
  assert.equal(ex[0].turn_id, "t1");
  assert.equal(ex[0].action, "message_session");
  assert.deepEqual(ex[0].targets, ["auth-01"]);
  assert.equal(ex[0].instruction, "go ahead");
  assert.equal(ex[0].rule, "command");
  assert.equal(ex[0].at, new Date(NOW).toISOString());
  assert.equal(ex[1].rule, "error");
}));

test("the model sees the previous exchanges and the focus (the next line resolves 'him')", () => inSandbox(async () => {
  const r = rig({ script: [(input) => msg([input.focused_session_id], "also add tests")] });
  seedWorker("auth-01");
  await r.coordinator.handleLine("/to auth-01 start", { turnId: "t1" });
  const out = await r.coordinator.handleLine("also tell him to add tests", { turnId: "t2" });
  assert.equal(r.prov.calls[0].focused_session_id, "auth-01");
  assert.equal(r.prov.calls[0].exchanges.length, 1);
  assert.equal(r.prov.calls[0].exchanges[0].user, "/to auth-01 start");
  assert.match(out.reply, /auth-01: delivered/);
}));

test("/status, /workers, /help and /quit answer without the provider; /quit and /restart-closed set `command`", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  const s = await r.coordinator.handleLine("/status", { turnId: "t1" });
  assert.match(s.reply, /^auth-01 \(claude\) running - /);
  assert.match((await r.coordinator.handleLine("/workers", { turnId: "t2" })).reply, /auth-01/);
  assert.match((await r.coordinator.handleLine("/help", { turnId: "t3" })).reply, /\/to .*\/status .*\/new /s);
  const q = await r.coordinator.handleLine("/quit", { turnId: "t4" });
  assert.equal(q.command, "quit");
  const rc = await r.coordinator.handleLine("/restart-closed", { turnId: "t5" });
  assert.equal(rc.command, "restart-closed");
  assert.equal(r.prov.calls.length, 0);
}));

test("a repeat of the same decision command with the same turn id is a duplicate: no second delivery", () => inSandbox(async () => {
  const r = rig();
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("/to auth-01 once", { turnId: "t1" });
  const b = await r.coordinator.handleLine("/to auth-01 once", { turnId: "t1" });
  assert.equal(a.dispatched.duplicate, false);
  // the turn-level replay guard (before any resolver branch) answers first: the stored reply, no dispatch at all
  assert.equal(b.replayed, true);
  assert.equal(b.dispatched, undefined);
  assert.equal(b.reply, a.reply);
  assert.equal(r.c.calls.message.length, 1);
}));

test("C8 tick() polls Codex only between turns: skipped while a line is in flight, never called by handleLine, then notices ride the next reply", () => inSandbox(async () => {
  let polls = 0;
  const poll = async () => { polls++; return [{ type: "finished", worker_id: "fix-01", attempt_id: "fix-01.1", status: "waiting_for_user", summary: "tests pass", files_changed: [], blockers: [] }]; };
  const provider = { async decide() { await sleep(80); return emptyDecision({ action: "respond", reply: "slow", confidence: 0.9 }); } };
  const r = rig({ provider, poll });
  seedWorker("fix-01", "codex");
  const slow = r.coordinator.handleLine("a slow question", { turnId: "t1" });
  await sleep(10);
  const during = await r.coordinator.tick();
  assert.equal(during.skipped, true);
  assert.equal(polls, 0, "no poll while a provider call is pending");
  await slow;
  assert.equal(polls, 0, "handleLine itself never polls");
  const t = await r.coordinator.tick();
  assert.equal(polls, 1);
  assert.match(t.notices[0], /fix-01.*tests pass/);
  const next = await r.coordinator.handleLine("/status", { turnId: "t2" });
  assert.ok(next.notices.some((n) => /fix-01.*tests pass/.test(n)), "the poll notice is delivered with the next reply");
  const again = await r.coordinator.handleLine("/status", { turnId: "t3" });
  assert.ok(!again.notices.some((n) => /tests pass/.test(n)), "and only once");
}));

test("C8 a line that arrives while tick() polls waits for it (the documented stall), in order", () => inSandbox(async () => {
  const order = [];
  const poll = async () => { order.push("poll-start"); await sleep(60); order.push("poll-end"); return []; };
  const r = rig({ poll });
  seedWorker("auth-01");
  const t = r.coordinator.tick();
  await sleep(10);
  const line = r.coordinator.handleLine("/status", { turnId: "t1" }).then((x) => { order.push("line"); return x; });
  await Promise.all([t, line]);
  assert.deepEqual(order, ["poll-start", "poll-end", "line"]);
}));

test("C10 a model create_session for Codex that the gate refuses starts a Claude worker, and the exchange records the new worker", () => inSandbox(async () => {
  const d = emptyDecision({ action: "create_session", new_session: { needed: true, provider: "codex", label: "migration", objective: "run the migration" }, confidence: 0.9 });
  const r = rig({ script: [d], codex: fakeCodexAdapter({ start: blockedOutcome("exhausted", "codex-quota-exhausted", CFG) }) });
  const out = await r.coordinator.handleLine("make a new worker for the migration", { turnId: "t1" });
  assert.match(out.reply, /started a Claude worker instead/);
  assert.equal(r.coordinator.focus(), "migration-02");
  assert.deepEqual(store.readJsonl("exchanges").at(-1).targets, ["migration-02"]);
}));

test("validateDecision still guards what the model returned: an invalid decision never reaches an adapter", () => inSandbox(async () => {
  const r = rig({ script: [{ action: "message_session", extra: true }, { action: "nope" }] });
  seedWorker("auth-01");
  const out = await r.coordinator.handleLine("hmm do something", { turnId: "t1" });
  assert.equal(adapterCalls(r), 0);
  assert.equal(r.prov.calls[1].validation_errors.some((e) => e.code === "unknown-field"), true);
  assert.ok(out.reply.length > 0);
  assert.deepEqual((await r.workersView()).length, 1);
  assert.equal(validateDecision(emptyDecision({ action: "respond", reply: "x" }), { workers: [] }).ok, true);
}));

// ---- Task 13 fix round, M2: the "Codex is unavailable" notice is shown when the state changes (and in /status), not on every reply ----
test("T13 M2 the Codex-unavailable notice appears once per change, always in /status, and 'available again' once on the way back", () => inSandbox(async () => {
  const st = { active_jobs: 0, max_parallel_jobs: 2, available: false, capacity_available: false, usage_status: "ok" };
  const r = rig({ codexState: () => ({ ...st }) });
  seedWorker("auth-01");
  const unavail = (o) => o.notices.filter((n) => /Codex is unavailable/.test(n)).length;
  const a = await r.coordinator.handleLine("/to auth-01 one", { turnId: "t1" });
  const b = await r.coordinator.handleLine("/to auth-01 two", { turnId: "t2" });
  assert.equal(unavail(a), 1, "the first reply while unavailable carries it");
  assert.equal(unavail(b), 0, "the second consecutive one does not");
  const s = await r.coordinator.handleLine("/status", { turnId: "t3" });
  assert.equal(unavail(s), 1, "/status always shows it");
  st.available = true;
  const c = await r.coordinator.handleLine("/to auth-01 three", { turnId: "t4" });
  assert.ok(c.notices.some((n) => /Codex is available again/.test(n)));
  const d = await r.coordinator.handleLine("/to auth-01 four", { turnId: "t5" });
  assert.ok(!d.notices.some((n) => /Codex is available again|unavailable/.test(n)), "back to silence");
  st.available = false;
  const e = await r.coordinator.handleLine("/to auth-01 five", { turnId: "t6" });
  assert.equal(unavail(e), 1, "a second outage shows it again");
}));

// ---- Decisions Task 5: combined spend in /status and the notices; the crash residual ---------------------------------------

const SPLIT = { spent_usd: 3.5, soft: 7, hard: 10, state: "ok", by_api: { decisions: 1.25, responses: 2.25 } };

test("K-status-spend: /status shows the combined spend line with the Decisions and Luna split", () => inSandbox(async () => {
  const r = rig({ cost: () => SPLIT });
  seedWorker("auth-01");
  const s = await r.coordinator.handleLine("/status", { turnId: "t1" });
  assert.match(s.reply, /^auth-01 \(claude\) running - /);
  assert.ok(s.reply.split("\n").includes("Spend this month: $3.50 (Decisions $1.25, Luna $2.25) of $7 soft / $10 hard - ok."), s.reply);
  assert.match(store.readJsonl("exchanges").at(-1).reply, /Spend this month: \$3\.50/);
  const w = await r.coordinator.handleLine("/workers", { turnId: "t2" });
  assert.doesNotMatch(w.reply, /Spend this month/, "only a status reply carries the spend line");
  const none = rig({});
  assert.doesNotMatch((await none.coordinator.handleLine("/status", { turnId: "t3" })).reply, /Spend this month/, "no cost state: no line");
}));

test("K-spend-state: the /status spend line ends with the state word for ok, soft and hard", () => inSandbox(async () => {
  let cost = SPLIT;
  const r = rig({ cost: () => cost });
  seedWorker("auth-01");
  const line = async (id) => (await r.coordinator.handleLine("/status", { turnId: id })).reply.split(String.fromCharCode(10)).find((l) => l.startsWith("Spend this month"));
  assert.equal(await line("t1"), "Spend this month: $3.50 (Decisions $1.25, Luna $2.25) of $7 soft / $10 hard - ok.");
  cost = { ...SPLIT, spent_usd: 7.5, state: "soft", by_api: { decisions: 5, responses: 2.5 } };
  assert.equal(await line("t2"), "Spend this month: $7.50 (Decisions $5.00, Luna $2.50) of $7 soft / $10 hard - soft limit reached.");
  cost = { ...SPLIT, spent_usd: 10, state: "hard", by_api: { decisions: 7.5, responses: 2.5 } };
  assert.equal(await line("t3"), "Spend this month: $10.00 (Decisions $7.50, Luna $2.50) of $7 soft / $10 hard - hard limit reached: model calls paused.");
}));

test("K-notice: cost notices say Coordinator spend and name the combined total (soft and hard)", () => inSandbox(async () => {
  let cost = { ...SPLIT, spent_usd: 7.5, state: "soft", by_api: { decisions: 5, responses: 2.5 } };
  const r = rig({ cost: () => cost });
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("/to auth-01 hi", { turnId: "t1" });
  assert.equal(a.notices.length, 1);
  assert.match(a.notices[0], /^Coordinator spend \$7\.50 \(Decisions \$5\.00, Luna \$2\.50\) is past the \$7 monthly soft limit \(hard limit \$10\)\.$/);
  cost = { ...cost, spent_usd: 10, state: "hard", by_api: { decisions: 7.5, responses: 2.5 } };
  const b = await r.coordinator.handleLine("/to auth-01 again", { turnId: "t2" });
  assert.match(b.notices[0], /^Coordinator spend \$10\.00 \(Decisions \$7\.50, Luna \$2\.50\) has reached the monthly hard limit of \$10\. Model calls are paused/);
  assert.doesNotMatch(b.notices.join(" "), /Luna is paused|Luna spend/);
}));

test("M6 crash residual: the turn's exchange line is gone, the same turnId replays: duplicate true from the stored result, dispatch is not called again, one message is delivered", () => inSandbox(async () => {
  const r = rig();
  let dispatches = 0;
  const real = r.dispatcher.dispatch;
  r.dispatcher.dispatch = (...a) => { dispatches++; return real(...a); };
  seedWorker("auth-01");
  const a = await r.coordinator.handleLine("/to auth-01 once", { turnId: "tc" });
  assert.equal(a.dispatched.duplicate, false);
  const f = path.join(stateDir(), "exchanges.jsonl");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").filter((l) => l && JSON.parse(l).turn_id !== "tc").map((l) => `${l}\n`).join(""));
  assert.equal(store.readJsonl("exchanges").some((e) => e.turn_id === "tc"), false, "the crash left no exchange line");
  const b = await r.coordinator.handleLine("/to auth-01 once", { turnId: "tc" });
  assert.equal(b.replayed, undefined, "the turn guard found nothing");
  assert.equal(b.dispatched.duplicate, true);
  assert.equal(dispatches, 1, "the replay was answered by dispatcher.peek, not by a second dispatch call");
  assert.equal(r.c.calls.message.length, 1, "exactly one message delivered");
}));
