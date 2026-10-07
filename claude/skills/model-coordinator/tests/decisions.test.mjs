import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR } from "./mc-helpers.mjs";
import {
  buildDecisionsRequest, interpretAnswers, labelFrom, takenNames, RISKY_RE, TEXT_RE, EPS,
} from "../decisions.mjs";
import { validateForDispatch } from "../coordinator.mjs";
import { validateDecision } from "../validate.mjs";
import { LABEL_RE } from "../schema.mjs";

// The Task 1 defaults, as a local literal (Task 1 runs in parallel; this test does not import DEFAULTS).
const D = {
  enabled: true, model: "gpt-6-luna", timeout_ms: 10000, max_retries: 1, min_route_probability: 0.8, min_margin: 0.2,
  concern_high: 0.8, concern_low: 0.3, needs_text_threshold: 0.5, risky_min_probability: 0.9, fallback_min_confidence: 0.8,
  max_input_chars: 16000, max_message_chars: 6000,
};
const CFG = { decisions: { ...D } };
const cfgWith = (o) => ({ decisions: { ...D, ...o } });

let t0 = 1.76e12;
const w = (id, provider, status, extra = {}) => ({
  id, provider, label: id.replace(/-\d+$/, ""), aliases: [], status, objective: "", current_task: "", last_result: "", blockers: [],
  created_at: new Date((t0 += 60000)).toISOString(), ...extra,
});
const AUTH = () => w("auth-01", "claude", "running", { objective: "fix login", aliases: ["login worker"] });
const UI = () => w("ui-02", "codex", "running", { objective: "header" });
const DB = () => w("db-03", "claude", "idle");
const OLD = () => w("old-01", "claude", "finished");
const TWO = () => [AUTH(), UI(), OLD()];

const ch = (choice, p, others = {}) => ({ type: "choice", choice, probs: new Map([[choice, p], ...Object.entries(others)]) });
const pr = (p) => ({ type: "predicate", pTrue: p });
const REFS0 = { singular: null, other: null, both: null, recent: [] };
const build = (ws, o = {}) => buildDecisionsRequest({
  workers: ws, focusedId: o.focusedId ?? null, referents: { ...REFS0, ...(o.referents ?? {}) }, exchanges: o.exchanges ?? [],
  lastEvent: o.lastEvent ?? null, message: o.message ?? "do the thing", codexEligible: o.codex ?? true, cfg: o.cfg ?? CFG,
});

/** Builds a request, fabricates answers keyed by its `offered`, and interprets them. */
function run(ws, o = {}) {
  const message = o.message ?? "do the thing", focusedId = o.focusedId ?? null, cfg = o.cfg ?? CFG;
  const referents = { ...REFS0, ...(o.referents ?? {}) };
  const req = build(ws, { ...o, message });
  assert.ok(!req.tooLong, "request unexpectedly too long");
  const [rc, rp, others] = o.route ?? ["auth-01", 0.9, {}];
  const byName = { route: ch(rc, rp, others), needs_text: pr(o.needs ?? 0.1) };
  const [pc, pp, po] = o.provider ?? ["claude", 0.95, {}];
  byName.provider = ch(pc, pp, po);
  for (const [name, id] of Object.entries(req.offered.concerns)) byName[name] = pr(o.concerns?.[id] ?? 0.05);
  const final = o.byName ? o.byName(byName, req) : byName;
  const res = interpretAnswers(final, { offered: req.offered, workers: o.fresh ?? ws, focusedId, referents, message, cfg });
  return { res, req, message, ws: o.fresh ?? ws };
}
/** Every plan must pass validateForDispatch (verbatim for message actions); a plan is also what Task 4a dispatches. */
function assertValid(res, ws) {
  const d = res.decision;
  const v = validateForDispatch(d, { workers: ws, verbatim: d.action === "message_session" || d.action === "message_multiple" });
  assert.ok(v.ok, JSON.stringify(v.errors));
  if (!(d.action === "message_session" || d.action === "message_multiple")) assert.deepEqual(validateDecision(d, { workers: ws }), v);
}

// ---- constants ------------------------------------------------------------------------------------------------

test("exports: RISKY_RE, TEXT_RE, EPS", () => {
  assert.equal(EPS, 1e-9);
  for (const s of ["delete it", "Drop the table", "force push", "force-push", "rm -rf x", "revert all", "wipe it", "truncate x"]) assert.ok(RISKY_RE.test(s), s);
  for (const s of ["fix the login typo", "deleted file list", "undelete"]) assert.ok(!RISKY_RE.test(s), s);
  for (const s of ["plan the work", "explain this", "figure out why", "Design it"]) assert.ok(TEXT_RE.test(s), s);
  assert.ok(!TEXT_RE.test("fix the typo"));
});

// ---- builder ----------------------------------------------------------------------------------------------------

test("B-input: the input format, sections in order, field caps, finished excluded", () => {
  const ws = [
    w("auth-01", "claude", "running", { objective: "o".repeat(300), current_task: "t".repeat(300), last_result: "l".repeat(300), aliases: ["login worker", "auth"] }),
    w("ui-02", "codex", "idle", { objective: "header" }),
    OLD(),
  ];
  const ex = Array.from({ length: 8 }, (_, i) => ({ user: `u${i} ${"x".repeat(300)}`, reply: `r${i} ${"y".repeat(300)}`, action: "message_session", targets: ["auth-01"] }));
  const req = build(ws, {
    focusedId: "auth-01", message: "hello there", exchanges: ex, lastEvent: `auth-01: finished - ${"z".repeat(400)}`,
    referents: { singular: "auth-01", other: "ui-02", both: ["auth-01", "ui-02"], recent: ["auth-01", "ui-02"] },
  });
  const lines = req.input.split("\n");
  assert.equal(lines[0], "Message: hello there");
  assert.equal(lines[1], "Focused worker: auth-01");
  assert.equal(lines[2], "Referents: singular=auth-01 other=ui-02 both=auth-01,ui-02 recent=auth-01,ui-02");
  assert.equal(lines[3], "Recent turns (oldest first):");
  const turns = lines.slice(4, 10);
  assert.equal(turns.length, 6);
  assert.match(turns[0], /^- user: u2 x+ \| reply: r2 y+ \| action: message_session -> auth-01$/); // the LAST 6, oldest first
  assert.match(turns[5], /^- user: u7 /);
  for (const t of turns) { const m = /^- user: (.*) \| reply: (.*) \| action: /.exec(t); assert.ok(m[1].length <= 200 && m[2].length <= 200, t); }
  assert.match(lines[10], /^Last event: auth-01: finished - z+$/);
  assert.equal(lines[10].length, "Last event: ".length + 150);
  assert.equal(lines[11], "Workers:");
  assert.match(lines[12], /^- auth-01 \[claude, running\] label=auth aliases=login worker\|auth objective=o{200} task=t{200} last=l{150}$/);
  assert.match(lines[13], /^- ui-02 \[codex, idle\] label=ui aliases= objective=header task= last=$/);
  assert.equal(lines.length, 14);
  assert.ok(!req.input.includes("old-01"));
  // no focus / no event / no exchanges
  const bare = build([UI()], { message: "hi" }).input.split("\n");
  assert.equal(bare[1], "Focused worker: none");
  assert.equal(bare[2], "Referents: singular=none other=none both=none recent=none");
  assert.equal(bare[4], "Last event: none");
  assert.equal(bare[3], "Recent turns (oldest first):");
});

test("B-ctrl: control, bidi and C1 characters in every field become spaces", () => {
  const bad = "a\u0000b\u0007c\u202ed\u2066e\u009ff\ng\th\r";
  const ws = [w("auth-01", "claude", "running", { objective: `obj${bad}`, current_task: bad, last_result: bad })];
  const req = build(ws, { message: `fix${bad}it`, lastEvent: `ev${bad}`, exchanges: [{ user: bad, reply: bad, action: "respond", targets: [] }], referents: { recent: ["auth-01"] } });
  const body = req.input.split("\n");
  assert.equal(body[0], "Message: fixa b c d e f g h it");
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(req.input));
  assert.equal(req.input.split("\n").length, 8); // Message, Focused, Referents, header, 1 turn, Last event, Workers:, 1 worker: no stray splits
  for (const q of req.questions) for (const c of q.choices ?? []) assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(c.description ?? ""));
});

test("B-cap: sections shrink in order and the input fits max_input_chars", () => {
  const ws = Array.from({ length: 8 }, (_, i) => w(`job-0${i + 1}`, "claude", "running", { objective: "o".repeat(200), current_task: "t".repeat(200), last_result: "l".repeat(150) }));
  const ex = Array.from({ length: 6 }, (_, i) => ({ user: "u".repeat(200), reply: "r".repeat(200), action: "respond", targets: [] }));
  const count = (s, re) => (s.match(re) ?? []).length;
  const at = (cap) => build(ws, { exchanges: ex, lastEvent: "e".repeat(150), message: "m".repeat(300), cfg: cfgWith({ max_input_chars: cap }) });
  // each level's size is the cap just below the previous level: the first section to give way is the exchanges (6 -> 2 -> 0)
  const l6 = at(20000);
  assert.equal(count(l6.input, /^- user:/gm), 6);
  const l2 = at(l6.input.length - 1);
  assert.equal(count(l2.input, /^- user:/gm), 2);
  assert.ok(l2.input.length < l6.input.length && l2.input.includes("objective="));
  const l0 = at(l2.input.length - 1);
  assert.equal(count(l0.input, /^- user:/gm), 0);
  assert.ok(l0.input.includes("objective=") && l0.input.includes("Last event: eee"));
  // then the worker fields shrink to id/status/label, Last event kept
  const lmin = at(l0.input.length - 1);
  assert.ok(!lmin.input.includes("objective=") && !lmin.input.includes("aliases=") && lmin.input.includes("- job-08 [running] label=job"));
  assert.match(lmin.input, /Last event: e+/);
  // then Last event is dropped
  const lnoev = at(lmin.input.length - 1);
  assert.match(lnoev.input, /Last event: none/);
  assert.ok(lnoev.input.includes("- job-08 [running] label=job"));
  // every level fits its cap and carries the whole message
  for (const r of [l6, l2, l0, lmin, lnoev]) assert.ok(r.input.includes(`Message: ${"m".repeat(300)}\n`));
  assert.ok(l6.input.length > l2.input.length && l2.input.length > l0.input.length && l0.input.length > lmin.input.length && lmin.input.length > lnoev.input.length);
  // nothing fits -> tooLong, and the message is never cut to make room
  assert.deepEqual(at(lnoev.input.length - 1), { tooLong: true });
  assert.ok(!at(lnoev.input.length).tooLong);
});

test("B-long: 6001 characters is too long, 5999 is included whole", () => {
  assert.deepEqual(build(TWO(), { message: "x".repeat(6001) }), { tooLong: true });
  const ok = build(TWO(), { message: "x".repeat(5999) });
  assert.ok(!ok.tooLong && ok.input.includes(`Message: ${"x".repeat(5999)}\n`));
  assert.ok(!build(TWO(), { message: "x".repeat(6000) }).tooLong);
});

test("B-choices: live workers only, fixed choices, descriptions capped at 300", () => {
  const ws = [...TWO(), w("dead-01", "claude", "dead"), w("long-01", "claude", "running", { objective: "g".repeat(200), current_task: "n".repeat(300), last_result: "l".repeat(200), aliases: ["a1", "a2"] })];
  const req = build(ws, { message: "hi" });
  const route = req.questions.find((q) => q.name === "route");
  assert.equal(route.type, "choice");
  assert.match(route.instructions, /Pick where the user's message should go/);
  assert.deepEqual(route.choices.map((c) => c.value), ["auth-01", "ui-02", "long-01", "new_session", "status", "respond", "clarify"]);
  assert.deepEqual(req.offered.route, route.choices.map((c) => c.value));
  for (const c of route.choices) { assert.ok(c.description.length > 0 && c.description.length <= 300); }
  assert.match(route.choices[0].description, /^claude, running; auth; aliases login worker; goal fix login; now ; last /);
  assert.equal(route.choices[2].description.length, 300);
  assert.ok(!req.input.includes("old-01") && !req.input.includes("dead-01"));
  assert.ok(!Object.values(req.offered.concerns).includes("old-01"));
  for (const q of req.questions) assert.ok(["choice", "predicate"].includes(q.type) && q.name && q.instructions);
  const needs = req.questions.find((q) => q.name === "needs_text");
  assert.equal(needs.type, "predicate");
  assert.match(needs.instructions, /needs a written brief/);
  const c1 = req.questions.find((q) => q.name === "concerns_auth_01");
  assert.equal(c1.type, "predicate");
  assert.equal(c1.instructions, "The user's message is meant for worker auth-01 (auth).");
  assert.equal(req.offered.concerns.concerns_auth_01, "auth-01");
  // statuses that can still take a message are offered; blocked/failed/queued included
  const more = build([w("a-01", "claude", "blocked"), w("b-01", "claude", "failed"), w("c-01", "codex", "queued")], { message: "hi" });
  assert.deepEqual(more.offered.route.slice(0, 3), ["a-01", "b-01", "c-01"]);
});

test("B-choices: sanitised question names stay unique", () => {
  const req = build([w("auth-01", "claude", "running", { id: "a-b_1" }), w("x-01", "claude", "running", { id: "a_b-1" })], { message: "hi" });
  const names = Object.keys(req.offered.concerns);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2);
  for (const n of names) assert.match(n, /^concerns_[a-z0-9_]+$/);
  assert.deepEqual(Object.values(req.offered.concerns).sort(), ["a-b_1", "a_b-1"]);
});

test("B-codex: codex is offered only when eligible", () => {
  const yes = build(TWO(), { codex: true });
  const no = build(TWO(), { codex: false });
  assert.deepEqual(yes.questions.find((q) => q.name === "provider").choices.map((c) => c.value), ["claude", "codex"]);
  assert.deepEqual(no.questions.find((q) => q.name === "provider").choices.map((c) => c.value), ["claude"]);
  assert.deepEqual(yes.offered.provider, ["claude", "codex"]);
  assert.deepEqual(no.offered.provider, ["claude"]);
  assert.match(no.questions.find((q) => q.name === "provider").instructions, /which kind fits/);
});

test("B-nine: 9 live workers, the concern set is 8 incl. the focused one (the oldest)", () => {
  const ws = Array.from({ length: 9 }, (_, i) => w(`job-0${i + 1}`, "claude", "running")); // job-01 is the oldest
  const req = build(ws, { focusedId: "job-01" });
  const ids = Object.values(req.offered.concerns);
  assert.equal(ids.length, 8);
  assert.equal(ids[0], "job-01"); // focused first
  assert.ok(ids.includes("job-01") && !ids.includes("job-02")); // then the newest by created_at: 09..03
  assert.deepEqual(ids, ["job-01", "job-09", "job-08", "job-07", "job-06", "job-05", "job-04", "job-03"]);
  // without a focus: the 8 newest
  assert.deepEqual(Object.values(build(ws, {}).offered.concerns), ["job-09", "job-08", "job-07", "job-06", "job-05", "job-04", "job-03", "job-02"]);
  // referents.recent come after the focused worker and before the rest
  const rec = build(ws, { focusedId: "job-05", referents: { recent: ["job-01", "job-05", "job-02"] } });
  assert.deepEqual(Object.values(rec.offered.concerns), ["job-05", "job-01", "job-02", "job-09", "job-08", "job-07", "job-06", "job-04"]);
  // a focused worker that is not live is not in the set; 9 route choices remain
  const fin = ws.map((x) => (x.id === "job-01" ? { ...x, status: "finished" } : x));
  assert.equal(Object.values(build(fin, { focusedId: "job-01" }).offered.concerns).length, 8);
  assert.equal(build(ws, {}).offered.route.length, 9 + 4);
});

// ---- interpretation -------------------------------------------------------------------------------------------

const planOf = (r) => { assert.equal(r.res.kind, "plan", JSON.stringify(r.res)); return r.res; };
const clarifyOf = (r) => { assert.equal(r.res.kind, "clarify", JSON.stringify(r.res)); assert.ok(r.res.text.length <= 500); return r.res; };

test("I-route boundaries: p1 0.80 accept, 0.79 clarify; margin 0.20 accept (float), 0.19 clarify", () => {
  const ws = TWO();
  const acc = run(ws, { route: ["auth-01", 0.8, { "ui-02": 0.2 }], concerns: { "auth-01": 0.9 } });
  assert.equal(planOf(acc).decision.action, "message_session");
  assert.ok(Math.abs(acc.res.meta.p1 - 0.8) < 1e-12 && acc.res.meta.winner === "auth-01");
  const lo = clarifyOf(run(ws, { route: ["auth-01", 0.79, { "ui-02": 0.21 }], concerns: { "auth-01": 0.9 } }));
  assert.match(lo.text, /^Which worker do you mean: auth-01 \(auth\) or ui-02 \(ui\)\? Use \/to <id> <text> to be exact\.$/);
  // the float case: 0.85 - 0.65 is 0.19999999999999996 and still counts as a 0.2 margin
  assert.ok(0.85 - 0.65 < 0.2);
  assert.equal(planOf(run(ws, { route: ["auth-01", 0.85, { "ui-02": 0.65 }], concerns: { "auth-01": 0.9 } })).decision.action, "message_session");
  clarifyOf(run(ws, { route: ["auth-01", 0.84, { "ui-02": 0.65 }], concerns: { "auth-01": 0.9 } })); // margin 0.19
  // a looser route threshold with a realistic sum: 0.6 / 0.4 is a 0.2 margin
  const c = cfgWith({ min_route_probability: 0.5 });
  assert.equal(planOf(run(ws, { cfg: c, route: ["auth-01", 0.6, { "ui-02": 0.4 }], concerns: { "auth-01": 0.9 } })).decision.action, "message_session");
  clarifyOf(run(ws, { cfg: c, route: ["auth-01", 0.59, { "ui-02": 0.41 }], concerns: { "auth-01": 0.9 } }));
  // a single worker plus a non-worker runner-up: the "Did you mean" text
  const mixed = clarifyOf(run(ws, { route: ["auth-01", 0.5, { new_session: 0.45 }], concerns: { "auth-01": 0.9 } }));
  assert.equal(mixed.text, "Did you mean send it to auth-01 (auth) or start a new worker? Use /to <id> <text>, /new claude|codex <label> <objective>, or /status to be exact.");
  const two = clarifyOf(run(ws, { route: ["status", 0.5, { respond: 0.45 }] }));
  assert.match(two.text, /^Did you mean a status update or an answer from me\?/);
});

test("I-truncated: unreported probability mass counts as a possible runner-up", () => {
  const ws = TWO();
  const c = cfgWith({ min_route_probability: 0.5, min_margin: 0.3 });
  const r = run(ws, { cfg: c, route: ["auth-01", 0.55, { "ui-02": 0.1 }], concerns: { "auth-01": 0.9 } }); // p2 = max(0.10, 1 - 0.65) = 0.35
  clarifyOf(r);
  assert.ok(Math.abs(r.res.meta.margin - 0.2) < 1e-9);
  // control: a complete list reaches the same p2; a high winner is accepted
  planOf(run(ws, { cfg: c, route: ["auth-01", 0.85, { "ui-02": 0.1 }], concerns: { "auth-01": 0.9 } }));
  clarifyOf(run(ws, { cfg: c, route: ["auth-01", 0.55, { "ui-02": 0.45 }], concerns: { "auth-01": 0.9 } }));
});

test("I-concern boundaries: 0.80 is H, 0.79 and 0.31 are U, 0.30 is neither", () => {
  const ws = TWO();
  assert.equal(planOf(run(ws, { concerns: { "auth-01": 0.8 } })).decision.action, "message_session");
  const u79 = clarifyOf(run(ws, { concerns: { "auth-01": 0.79 } })); // winner is a worker, U non-empty (rule 3)
  assert.match(u79.text, /auth-01/);
  // winner `status`: U decides between a clarify and a status for everyone
  const st = (p) => run(ws, { route: ["status", 0.9, {}], concerns: { "auth-01": p } });
  assert.equal(clarifyOf(st(0.31)).text.includes("auth-01"), true);
  const neither = planOf(st(0.3));
  assert.equal(neither.decision.action, "request_status");
  assert.deepEqual(neither.decision.target_session_ids, []);
  assert.equal(clarifyOf(st(0.79)).kind, "clarify");
  // a worker winner whose own concern is exactly 0.30 (neither): consistency check (rule 5c) clarifies
  const c30 = clarifyOf(run(ws, { concerns: { "auth-01": 0.3 } }));
  assert.ok(c30.text.length > 0);
  // U with a non-worker, non-status winner does not clarify
  assert.equal(planOf(run(ws, { route: ["new_session", 0.9, {}], concerns: { "auth-01": 0.5 }, message: "start a worker to fix the typo" })).decision.action, "create_session");
  // U text names U + H (max 3)
  const four = [AUTH(), UI(), DB(), w("x-04", "claude", "running"), w("y-05", "claude", "running")];
  const t = clarifyOf(run(four, { route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.5, "ui-02": 0.5, "db-03": 0.5, "x-04": 0.5, "y-05": 0.85 } }));
  assert.equal((t.text.match(/-\d\d \(/g) ?? []).length, 3);
});

test("I-H-multi: two or more concerned workers", () => {
  const ws = [AUTH(), UI(), DB()];
  const msg = "tell both of them to check the logs";
  const multi = planOf(run(ws, { message: msg, route: ["auth-01", 0.5, { "ui-02": 0.45 }], concerns: { "auth-01": 0.85, "ui-02": 0.8 } }));
  assert.equal(multi.decision.action, "message_multiple");
  assert.deepEqual(multi.decision.target_session_ids, ["ui-02", "auth-01"]);
  assert.equal(multi.decision.worker_instruction, msg);
  assert.equal(multi.writer, null);
  assertValid(multi, ws);
  // winner is not in H -> clarify naming H
  const other = clarifyOf(run(ws, { message: msg, route: ["db-03", 0.9, {}], concerns: { "auth-01": 0.85, "ui-02": 0.85 } }));
  assert.match(other.text, /ui-02 \(ui\) or auth-01 \(auth\)/);
  clarifyOf(run(ws, { message: msg, route: ["new_session", 0.9, {}], concerns: { "auth-01": 0.85, "ui-02": 0.85 } }));
  // winner `status` -> request_status for H
  const st = planOf(run(ws, { message: "how are both of them doing", route: ["status", 0.9, {}], concerns: { "auth-01": 0.85, "ui-02": 0.85 } }));
  assert.equal(st.decision.action, "request_status");
  assert.deepEqual(st.decision.target_session_ids, ["ui-02", "auth-01"]);
  assertValid(st, ws);
  // one of the two sits at 0.79: U + worker winner -> clarify
  clarifyOf(run(ws, { message: msg, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.85, "ui-02": 0.79 } }));
  // a H member that finished since the snapshot -> advice for it, never a send
  const dead = run(ws, { message: msg, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.85, "ui-02": 0.85 }, fresh: [AUTH(), { ...UI(), status: "finished" }, DB()] });
  assert.equal(dead.res.kind, "advice");
  assert.equal(dead.res.text, "ui-02 is finished. Start a new one with /new claude|codex <label> <objective>.");
  // eight concerned workers fit LIMITS.targets
  const eight = Array.from({ length: 8 }, (_, i) => w(`job-0${i + 1}`, "claude", "running"));
  const big = planOf(run(eight, { message: "tell all of them to stop", route: ["job-01", 0.4, {}], concerns: Object.fromEntries(eight.map((x) => [x.id, 0.9])) }));
  assert.equal(big.decision.target_session_ids.length, 8);
  assertValid(big, eight);
});

test("I-risky-multi: a destructive message to two workers needs 0.90 each", () => {
  const ws = [AUTH(), UI()];
  const msg = "wipe the db on both of them";
  const r = clarifyOf(run(ws, { message: msg, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.85, "ui-02": 0.85 } }));
  assert.match(r.text, /destructive/);
  const ok = planOf(run(ws, { message: msg, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.9, "ui-02": 0.95 } }));
  assert.equal(ok.decision.action, "message_multiple");
  // 0.89 for one of them
  clarifyOf(run(ws, { message: msg, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.9, "ui-02": 0.89 } }));
});

test("I-risky: p1 below 0.90 with destructive text clarifies; 0.90 and plain text pass", () => {
  const ws = TWO(), msg = "delete all the old branches";
  const r = clarifyOf(run(ws, { message: msg, route: ["auth-01", 0.85, { "ui-02": 0.1 }], concerns: { "auth-01": 0.9 } }));
  assert.equal(r.text, "That looks destructive. Which worker, exactly? Use /to <id> <text>.");
  clarifyOf(run(ws, { message: msg, route: ["auth-01", 0.89, { "ui-02": 0.11 }], concerns: { "auth-01": 0.9 } }));
  assert.equal(planOf(run(ws, { message: msg, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.9 } })).decision.action, "message_session");
  assert.equal(planOf(run(ws, { message: "fix the branches", route: ["auth-01", 0.85, {}], concerns: { "auth-01": 0.9 } })).decision.action, "message_session");
  // rule 6 applies to a new_session winner too
  clarifyOf(run(ws, { message: "start a worker to delete the temp files", route: ["new_session", 0.85, {}] }));
  assert.equal(planOf(run(ws, { message: "start a worker to delete the temp files", route: ["new_session", 0.95, {}] })).decision.action, "create_session");
});

test("I-dead: a winner that finished or died since the snapshot gets advice, never a send", () => {
  const ws = TWO();
  const fin = run(ws, { concerns: { "auth-01": 0.9 }, fresh: [{ ...AUTH(), status: "finished" }, UI(), OLD()] });
  assert.equal(fin.res.kind, "advice");
  assert.equal(fin.res.text, "auth-01 is finished. Start a new one with /new claude|codex <label> <objective>.");
  const dead = run(ws, { concerns: { "auth-01": 0.9 }, fresh: [{ ...AUTH(), status: "dead" }, UI()] });
  assert.equal(dead.res.kind, "advice");
  assert.equal(dead.res.text, "auth-01 is dead. Use /restart-closed to reopen closed sessions, or start a new one with /new.");
  const gone = run(ws, { concerns: { "auth-01": 0.9 }, fresh: [UI()] });
  assert.equal(gone.res.kind, "advice");
  assert.equal(gone.res.text, "auth-01 is no longer listed. Use /workers to see the current workers.");
  assert.ok(!gone.res.decision);
});

test("I-nine: a winner outside the concern set while another worker is the only concerned one clarifies", () => {
  const ws = Array.from({ length: 9 }, (_, i) => w(`job-0${i + 1}`, "claude", "running")); // job-01 oldest -> outside the set
  const r = run(ws, { route: ["job-01", 0.95, {}], concerns: { "job-05": 0.9 } });
  assert.ok(!Object.values(r.req.offered.concerns).includes("job-01"));
  const c = clarifyOf(r);
  assert.match(c.text, /job-01/);
  assert.match(c.text, /job-05/);
});

test("I-outside-H-empty: an outside-the-set winner at 0.95 with every concern low clarifies", () => {
  const ws = Array.from({ length: 9 }, (_, i) => w(`job-0${i + 1}`, "claude", "running"));
  const r = run(ws, { route: ["job-01", 0.95, {}] }); // concerns all 0.05
  const c = clarifyOf(r);
  assert.match(c.text, /job-01/);
  // control: a winner INSIDE the set with a high concern is sent
  assert.equal(planOf(run(ws, { route: ["job-09", 0.95, {}], concerns: { "job-09": 0.9 } })).decision.target_session_ids[0], "job-09");
});

test("I-H-elsewhere: the concern predicates point at another worker -> clarify naming both", () => {
  const ws = [AUTH(), UI(), DB()];
  const c = clarifyOf(run(ws, { route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.1, "ui-02": 0.9, "db-03": 0.1 } }));
  assert.equal(c.text, "Which worker do you mean: auth-01 (auth) or ui-02 (ui)? Use /to <id> <text> to be exact.");
});

test("I-concern-low: the winner's own concern below 0.80 (and not U) clarifies", () => {
  const ws = TWO();
  clarifyOf(run(ws, { concerns: { "auth-01": 0.05 } }));
  clarifyOf(run(ws, { concerns: { "auth-01": 0.3 } }));
});

test("I-other: 'the other one' contradictions, with and without a focus", () => {
  const ws = [AUTH(), UI(), DB()];
  const msg = "tell the other one to check it too";
  const refs = { singular: "auth-01", other: "ui-02", both: ["auth-01", "ui-02"], recent: ["auth-01", "ui-02"] };
  // 2a with a focus
  clarifyOf(run(ws, { message: msg, focusedId: "auth-01", referents: refs, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.9 } }));
  // 2a without a focus: referents.singular is the winner
  clarifyOf(run(ws, { message: msg, referents: refs, route: ["auth-01", 0.9, {}], concerns: { "auth-01": 0.9 } }));
  // winner is not the singular: no contradiction (the M3 path)
  assert.equal(planOf(run(ws, { message: msg, focusedId: "auth-01", referents: refs, route: ["ui-02", 0.9, {}], concerns: { "ui-02": 0.9 } })).decision.target_session_ids[0], "ui-02");
  // 2b: the winner differs from the focus, but the concerns include the focused worker
  clarifyOf(run(ws, { message: msg, focusedId: "auth-01", referents: refs, route: ["ui-02", 0.9, {}], concerns: { "auth-01": 0.9, "ui-02": 0.5 } }));
  // 2b alone: the only concerned worker is the focused one, and the winner is a non-worker route
  clarifyOf(run(ws, { message: "tell the other one to start fresh", focusedId: "auth-01", referents: refs, route: ["new_session", 0.9, {}], concerns: { "auth-01": 0.9 } }));
  assert.equal(planOf(run(ws, { message: "tell the other one to start fresh", focusedId: "auth-01", referents: refs, route: ["new_session", 0.9, {}], concerns: { "auth-01": 0.1 } })).decision.action, "create_session");
  // 2c: a pronoun and two concerned workers
  clarifyOf(run(ws, { message: msg, referents: refs, route: ["ui-02", 0.9, {}], concerns: { "ui-02": 0.9, "db-03": 0.9 } }));
  clarifyOf(run(ws, { message: "tell it to stop", referents: refs, route: ["ui-02", 0.9, {}], concerns: { "ui-02": 0.9, "db-03": 0.9 } }));
  // "both" is not a contradiction with two concerned workers
  assert.equal(planOf(run(ws, { message: "tell both of them to stop", referents: refs, route: ["ui-02", 0.9, {}], concerns: { "ui-02": 0.9, "db-03": 0.9 } })).decision.action, "message_multiple");
  // rule 2 runs before any multi-message route
  clarifyOf(run(ws, { message: msg, focusedId: "auth-01", referents: refs, route: ["auth-01", 0.5, {}], concerns: { "auth-01": 0.9, "ui-02": 0.9 } }));
});

test("I-other-multi: focused auth-01, 'the other one', concerns auth-01 and ui-02 both 0.95 -> clarify", () => {
  const ws = [AUTH(), UI()];
  const refs = { singular: "auth-01", other: "ui-02", both: ["auth-01", "ui-02"], recent: ["auth-01", "ui-02"] };
  const c = clarifyOf(run(ws, { message: "tell the other one to check it too", focusedId: "auth-01", referents: refs, route: ["ui-02", 0.9, {}], concerns: { "auth-01": 0.95, "ui-02": 0.95 } }));
  assert.match(c.text, /auth-01/);
  assert.match(c.text, /ui-02/);
});

test("I-provider-unsure: new_session 0.95 with a provider split 0.55/0.45 clarifies, never a silent Claude", () => {
  const ws = TWO(), msg = "start a worker to fix the login typo";
  const c = clarifyOf(run(ws, { message: msg, route: ["new_session", 0.95, {}], provider: ["codex", 0.55, { claude: 0.45 }] }));
  assert.equal(c.text, "Should the new worker be Claude or Codex? Use /new claude|codex <label> <objective>.");
  const ok = planOf(run(ws, { message: msg, route: ["new_session", 0.95, {}], provider: ["codex", 0.9, { claude: 0.1 }] }));
  assert.equal(ok.decision.new_session.provider, "codex");
  assert.equal(planOf(run(ws, { message: msg, route: ["new_session", 0.95, {}], provider: ["claude", 0.8, { codex: 0.2 }] })).decision.new_session.provider, "claude");
  clarifyOf(run(ws, { message: msg, route: ["new_session", 0.95, {}], provider: ["claude", 0.79, { codex: 0.21 }] }));
});

test("I-refusal-first: a refusal plus a missing answer clarifies (not unusable); also a lone refusal", () => {
  const ws = TWO();
  const r = run(ws, { byName: () => ({ route: { type: "refusal" } }) });
  assert.equal(r.res.kind, "clarify");
  assert.ok(r.res.text.length <= 500 && /Use \/to <id> <text> or \/new\./.test(r.res.text));
  assert.match(r.res.text, /auth-01 \(running\)/);
  assert.doesNotMatch(r.res.text, /old-01/);
  const two = run(ws, { byName: (b) => ({ ...b, needs_text: { type: "refusal" }, provider: undefined }) });
  assert.equal(two.res.kind, "clarify");
  const none = run([OLD()], { byName: () => ({ provider: { type: "refusal" } }) });
  assert.equal(none.res.kind, "clarify");
  assert.match(none.res.text, /I could not tell where that should go\. Workers: none\./);
});

test("I-unusable: a missing or malformed answer, or a choice that was not offered", () => {
  const ws = TWO();
  const cases = [
    ["missing route", (b) => { delete b.route; return b; }],
    ["missing provider", (b) => { delete b.provider; return b; }],
    ["missing needs_text", (b) => { delete b.needs_text; return b; }],
    ["missing concern", (b) => { delete b.concerns_auth_01; return b; }],
    ["route not offered", (b) => ({ ...b, route: ch("ghost-09", 0.9) })],
    ["provider not offered", (b) => ({ ...b, provider: ch("gpt", 0.9) })],
    ["finished worker as route", (b) => ({ ...b, route: ch("old-01", 0.9) })],
    ["route has no probability for its choice", (b) => ({ ...b, route: { type: "choice", choice: "auth-01", probs: new Map([["ui-02", 0.5]]) } })],
    ["predicate NaN", (b) => ({ ...b, needs_text: pr(NaN) })],
    ["predicate above 1", (b) => ({ ...b, concerns_auth_01: pr(1.2) })],
    ["predicate as a choice", (b) => ({ ...b, route: pr(0.9) })],
    ["choice as a predicate", (b) => ({ ...b, needs_text: ch("x", 0.9) })],
  ];
  for (const [name, mut] of cases) {
    const r = run(ws, { byName: (b) => mut(b) });
    assert.equal(r.res.kind, "unusable", name);
    assert.equal(typeof r.res.reason, "string", name);
  }
});

test("I-status / I-respond / I-clarify winners", () => {
  const ws = TWO();
  const st = planOf(run(ws, { route: ["status", 0.9, {}] }));
  assert.equal(st.decision.action, "request_status");
  assert.deepEqual(st.decision.target_session_ids, []);
  assert.equal(st.writer, null);
  assertValid(st, ws);
  const one = planOf(run(ws, { route: ["status", 0.9, {}], concerns: { "ui-02": 0.9 } }));
  assert.deepEqual(one.decision.target_session_ids, ["ui-02"]);
  const rp = planOf(run(ws, { route: ["respond", 0.9, {}], message: "summarise the results" }));
  assert.equal(rp.decision.action, "respond");
  assert.equal(rp.decision.reply, "");
  assert.equal(rp.writer, "reply");
  assertValid(rp, ws);
  const cl = clarifyOf(run(ws, { route: ["clarify", 0.9, { "auth-01": 0.05, "ui-02": 0.04 }] }));
  assert.match(cl.text, /auth-01/);
  const cl2 = clarifyOf(run(ws, { route: ["clarify", 0.9, {}] }));
  assert.match(cl2.text, /I could not tell where that should go/);
});

test("I-new-session writer: the brief is needed for long, plan-like or needs_text >= 0.50 lines", () => {
  const ws = TWO();
  const w0 = (message, needs = 0.1) => planOf(run(ws, { message, route: ["new_session", 0.95, {}], needs }));
  assert.equal(w0("start a worker to fix the login typo").writer, null);
  assert.equal(w0("start a worker to fix the login typo", 0.49).writer, null);
  assert.equal(w0("start a worker to fix the login typo", 0.5).writer, "brief");
  assert.equal(w0("start a worker to fix the login typo", 0.5 - 1e-10).writer, "brief"); // EPS
  assert.equal(w0("let a worker figure out the flaky test").writer, "brief");
  assert.equal(w0("x".repeat(400)).writer, null);
  assert.equal(w0("x".repeat(401)).writer, "brief");
  const long = w0("y".repeat(1500));
  assert.equal(long.decision.new_session.objective.length, 1000);
  assertValid(long, ws);
});

test("I-long: a 5000-character message to a worker is kept whole (verbatim flag is Task 4a's)", () => {
  const ws = TWO(), msg = `fix ${"z".repeat(4996)}`;
  assert.equal(msg.length, 5000);
  const p = planOf(run(ws, { message: msg, concerns: { "auth-01": 0.9 } }));
  assert.equal(p.decision.action, "message_session");
  assert.equal(p.decision.worker_instruction, msg);
  assert.deepEqual(p.decision.target_session_ids, ["auth-01"]);
  assert.equal(p.writer, null);
  assertValid(p, ws);
});

test("M3 spec paths", () => {
  const ws = [AUTH(), UI(), DB()];
  // 1. "the other one"
  const msg = "tell the other one to check it too";
  const a = planOf(run(ws, { message: msg, focusedId: "auth-01", referents: { singular: "auth-01", other: "ui-02", both: ["auth-01", "ui-02"], recent: ["auth-01", "ui-02"] }, route: ["ui-02", 0.9, {}], concerns: { "ui-02": 0.9 } }));
  assert.equal(a.decision.action, "message_session");
  assert.deepEqual(a.decision.target_session_ids, ["ui-02"]);
  assert.equal(a.decision.worker_instruction, msg);
  assert.equal(a.writer, null);
  assertValid(a, ws);
  // 2. the auth-architecture line
  const arch = "start a new worker to design the auth architecture for the whole platform";
  const b = planOf(run(ws, { message: arch, route: ["new_session", 0.92, {}], needs: 0.6 }));
  assert.equal(b.decision.action, "create_session");
  assert.equal(b.decision.new_session.needed, true);
  assert.equal(b.writer, "brief");
  assertValid(b, ws);
  // 3. the typo line
  const c = planOf(run(ws, { message: "start a worker to fix the login typo", route: ["new_session", 0.92, {}], needs: 0.1 }));
  assert.equal(c.decision.action, "create_session");
  assert.equal(c.decision.new_session.label, "fix-login-typo");
  assert.equal(c.decision.new_session.provider, "claude");
  assert.equal(c.decision.new_session.objective, "start a worker to fix the login typo");
  assert.equal(c.writer, null);
  assert.deepEqual(c.decision.target_session_ids, []);
  assertValid(c, ws);
  // a new label that clashes with a live worker is made unique
  const d = planOf(run([w("fix-login-typo-01", "claude", "running", { label: "fix-login-typo" })], { message: "start a worker to fix the login typo", route: ["new_session", 0.92, {}] }));
  assert.equal(d.decision.new_session.label, "fix-login-typo-2");
  assertValid(d, [w("fix-login-typo-01", "claude", "running", { label: "fix-login-typo" })]);
});

test("every plan passes validateForDispatch (message_session)", () => {
  const ws = TWO();
  const p = planOf(run(ws, { message: "fix the login typo", concerns: { "auth-01": 0.9 } }));
  assertValid(p, ws);
  assert.equal(p.decision.confidence, 1);
  assert.equal(p.decision.clarification, null);
  assert.equal(p.decision.record_update, null);
  // a message with a control character cannot become a valid plan
  const bad = run(ws, { message: "fix\u0007it", concerns: { "auth-01": 0.9 } });
  assert.equal(bad.res.kind, "unusable");
});

// ---- labels -----------------------------------------------------------------------------------------------------

const labelCases = [
  ["fix the login typo", [], "fix-login-typo"],
  ["start a worker to fix the login typo", [], "fix-login-typo"],
  ["Please make a new worker for the API", [], "api"],
  ["Add OAuth login to the website now", [], "add-oauth-login"],
  ["ab cd", [], "ab-cd"],
  ["go", [], "worker"],
  ["42", [], "worker"],
  ["9 lives", [], "worker"],
  ["\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd", [], "worker"],
  ["login", ["login"], "login-2"],
  ["fix the login typo", ["fix-login-typo", "fix-login-typo-2"], "fix-login-typo-3"],
];
for (const [msg, taken, expect] of labelCases) {
  test(`L-basic ${JSON.stringify(msg)} -> ${expect}`, () => {
    const l = labelFrom(msg, new Set(taken));
    assert.equal(l, expect);
    assert.match(l, LABEL_RE);
  });
}

test("L-ctrl: control, bidi and emoji-only input -> worker / worker-2", () => {
  for (const m of ["\u0000\u0007\u202e\u2066", "\u{1F680}\u{1F680}", "\u200b\u200f", "", "   \n\t"]) {
    assert.equal(labelFrom(m, new Set()), "worker", JSON.stringify(m));
    assert.equal(labelFrom(m, new Set(["worker"])), "worker-2");
    assert.equal(labelFrom(m, new Set(["worker", "worker-2"])), "worker-3");
  }
  assert.equal(labelFrom("fix\u202etypo\u0000now", new Set()), "fix-typo-now");
});

test("L-long: a 3-word base of 32 characters that is taken gets a suffixed label of at most 32 characters", () => {
  const msg = "aaaaaaaaaaa bbbbbbbbbbb cccccccccc dddd";
  const base = labelFrom(msg, new Set());
  assert.equal(base.length, 32);
  assert.equal(base, "aaaaaaaaaaa-bbbbbbbbbbb-cccccccc");
  const second = labelFrom(msg, new Set([base]));
  assert.equal(second, "aaaaaaaaaaa-bbbbbbbbbbb-cccccc-2");
  assert.ok(second.length <= 32);
  assert.match(second, LABEL_RE);
  const tenth = labelFrom(msg, new Set([base, ...Array.from({ length: 8 }, (_, i) => `x${i}`), ...Array.from({ length: 8 }, (_, i) => `aaaaaaaaaaa-bbbbbbbbbbb-cccccc-${i + 2}`)]));
  assert.equal(tenth, "aaaaaaaaaaa-bbbbbbbbbbb-ccccc-10");
  assert.match(tenth, LABEL_RE);
  // a long single word is cut to 32 and a trailing "-" is trimmed
  const one = labelFrom("a".repeat(40), new Set());
  assert.equal(one, "a".repeat(32));
  const trimmed = labelFrom(`${"a".repeat(30)} bb`, new Set());
  assert.equal(trimmed, `${"a".repeat(30)}-b`);
  assert.equal(labelFrom(`${"a".repeat(31)} bb`, new Set()), "a".repeat(31)); // the cut lands on the hyphen
});

test("L-taken: a base equal to a live worker's id, label or alias is suffixed; takenNames skips finished workers", () => {
  const ws = [w("auth-01", "claude", "running", { aliases: ["login"] }), w("api-02", "codex", "idle"), w("old-01", "claude", "finished", { aliases: ["gone"] }), w("dead-01", "claude", "dead")];
  const taken = takenNames(ws);
  assert.ok(taken instanceof Set);
  for (const n of ["auth-01", "auth", "login", "api-02", "api"]) assert.ok(taken.has(n), n);
  for (const n of ["old-01", "old", "gone", "dead-01", "dead"]) assert.ok(!taken.has(n), n);
  assert.equal(labelFrom("login", taken), "login-2"); // alias
  assert.equal(labelFrom("auth", taken), "auth-2"); // label
  assert.equal(labelFrom("api-02", taken), "api-02-2"); // id (the words are api, 02)
  assert.equal(labelFrom("old", taken), "old"); // finished: free again
  assert.equal(takenNames(new Map(ws.map((x) => [x.id, x]))).has("auth"), true);
});

// ---- purity ---------------------------------------------------------------------------------------------------

test("M5: decisions.mjs imports only the listed pure modules", () => {
  const src = fs.readFileSync(path.join(SKILL_DIR, "decisions.mjs"), "utf8");
  const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(specs.length >= 3);
  const allowed = new Set(["./workers.mjs", "./validate.mjs", "./schema.mjs", "./resolve.mjs"]);
  for (const s of specs) assert.ok(allowed.has(s), s);
  assert.ok(!/\bimport\s*\(/.test(src) && !/\brequire\s*\(/.test(src));
  assert.ok(!/\b(process|fetch|Date\.now|Math\.random)\b/.test(src.replace(/\/\/.*$/gm, "")));
});
