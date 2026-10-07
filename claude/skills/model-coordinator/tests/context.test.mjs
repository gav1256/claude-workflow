import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInput, estimateTokens, cutText, instructionsText } from "../context.mjs";
import { referents, resolveLine } from "../resolve.mjs";
import { validateDecision } from "../validate.mjs";
import { lunaLikePolicy } from "./mc-helpers.mjs";

const CFG = { context: { target_tokens: 2000, max_tokens: 3000, exchanges: 5 } };
const NOW = Date.parse("2026-10-07T12:00:00Z");
const w = (id, provider, status, extra = {}) => ({ id, provider, label: id.replace(/-\d+$/, ""), aliases: [], status, objective: "", current_task: "", last_result: "", blockers: [], ...extra });
const WORKERS = [
  w("auth-01", "claude", "running", { aliases: ["login worker"], objective: "add the login page with email and password fields, validation and a reset link", current_task: "writing the unit tests for the login form validation and error states", last_result: "login form and validation merged; tests pass; reset link still needs a design decision" }),
  w("invoice-01", "codex", "waiting_for_user", { objective: "export all open invoices to CSV with the customer id and totals", current_task: "waiting for a decision on the date format", last_result: "export works for one customer; needs a decision on the date format before the batch run" }),
  w("old-01", "claude", "finished", { finished_at: NOW - 3600e3, last_result: "done" }),
];
const ex = (user, targets, instruction) => ({ user, reply: "Sent that on to the worker and it has acknowledged; it will report back when the step is finished.", action: "message_session", targets, instruction });
const EX5 = [
  ex("tell invoice-01 to start", ["invoice-01"], "start the export"), ex("status please", [], null),
  ex("ask auth-01 to add tests", ["auth-01"], "add tests"), ex("how is it going", [], null), ex("tell auth-01 to keep going", ["auth-01"], "keep going"),
];
const input = (o = {}) => {
  const message = o.message ?? "x".repeat(200);
  const ref = referents({ text: message, workers: o.workers ?? WORKERS, focusedId: "auth-01", exchanges: o.exchanges ?? EX5 });
  return buildInput({ cfg: CFG, project: { repo: "demo", codex: "ok", cost: "$0.10 this month" }, workers: WORKERS, focusedId: "auth-01", referents: ref, exchanges: EX5, message, now: NOW, ...o });
};

test("M6 a typical input estimates 1000-3000 tokens and holds no transcript", () => {
  const i = input();
  const t = estimateTokens(i);
  assert.ok(t >= 1000 && t <= 3000, `tokens ${t}`);
  assert.equal(i.v, 1);
  assert.equal(i.exchanges.length, 5);
  assert.equal(i.focused_session_id, "auth-01");
  assert.deepEqual(i.workers.map((x) => x.id), ["auth-01", "invoice-01", "old-01"]);
  const json = JSON.stringify(i);
  assert.ok(!/"transcript"/.test(json));
  assert.ok(Buffer.byteLength(json) <= 12 * 1024);
  assert.equal(estimateTokens({ a: "x".repeat(40) }), Math.ceil(JSON.stringify({ a: "x".repeat(40) }).length / 4));
  assert.ok(!("validation_errors" in i));
});

const LONG = "L".repeat(1000);
function bigWorkers(n = 12) {
  return Array.from({ length: n }, (_, k) => w(`worker-${String(k + 1).padStart(2, "0")}`, k % 2 ? "codex" : "claude", "running", {
    aliases: ["alias one here", "alias two here", "alias three here", "alias four here"], objective: LONG, current_task: LONG, last_result: LONG,
    blockers: [LONG, LONG, LONG, LONG],
  }));
}
const bigEx = Array.from({ length: 10 }, (_, k) => ({ user: "U".repeat(900), reply: "R".repeat(900), action: "message_session", targets: ["worker-01"], instruction: "I".repeat(3000), n: k }));

test("M6 12 long workers + 10 exchanges + a 10k message stay within 3000 tokens and keep at least 2 exchanges", () => {
  const ws = bigWorkers();
  const msg = "M".repeat(10000);
  const ref = referents({ text: msg, workers: ws, focusedId: "worker-01", exchanges: bigEx });
  const i = buildInput({ cfg: CFG, project: { repo: "demo" }, workers: ws, focusedId: "worker-01", referents: ref, exchanges: bigEx, message: msg, now: NOW });
  const t = estimateTokens(i);
  assert.ok(t <= 3000, `tokens ${t}`);
  assert.ok(i.exchanges.length >= 2, `exchanges ${i.exchanges.length}`);
  assert.equal(i.workers.length, 12);
  assert.match(i.message, /\[\.\.\. 8000 chars cut\]$/);
  assert.ok(i.message.length <= 2000 + 30);
  const json = JSON.stringify(i);
  assert.ok(!/"transcript"/.test(json));
  assert.ok(Buffer.byteLength(json) <= 12 * 1024);
});

test("caps: exchange user 500, reply 300, message 2000 with a cut marker", () => {
  const e = [{ user: "u".repeat(900), reply: "r".repeat(900), action: "respond", targets: [], instruction: null }];
  const i = buildInput({ cfg: CFG, workers: WORKERS, referents: {}, exchanges: e, message: "m".repeat(2500), now: NOW });
  assert.equal(i.exchanges[0].user.length, 500);
  assert.equal(i.exchanges[0].reply.length, 300);
  assert.equal(i.message, `${"m".repeat(2000)}[... 500 chars cut]`);
  assert.equal(cutText("short", 10), "short");
});

test("exchanges follow cfg.context.exchanges, newest kept", () => {
  const i = input({ cfg: { context: { max_tokens: 3000, exchanges: 2 } } });
  assert.equal(i.exchanges.length, 2);
  assert.equal(i.exchanges[1].user, "tell auth-01 to keep going");
});

test("finished workers: only those finished in the last 24 h, newest first, at most 12; live workers all stay", () => {
  const fin = Array.from({ length: 15 }, (_, k) => w(`done-${String(k + 1).padStart(2, "0")}`, "claude", "finished", { finished_at: NOW - (k + 1) * 60e3 }));
  const stale = w("stale-01", "claude", "dead", { finished_at: NOW - 30 * 3600e3 });
  const i = buildInput({ cfg: CFG, workers: [...WORKERS.slice(0, 2), stale, ...fin], referents: {}, exchanges: [], message: "hi", now: NOW });
  const ids = i.workers.map((x) => x.id);
  assert.ok(!ids.includes("stale-01"));
  assert.equal(ids.filter((x) => x.startsWith("done-")).length, 12);
  assert.deepEqual(ids.slice(0, 3), ["auth-01", "invoice-01", "done-01"]);
});

test("over budget cuts finished workers before dropping exchanges below 2", () => {
  const fin = Array.from({ length: 12 }, (_, k) => w(`done-${k + 1}`, "claude", "finished", { finished_at: NOW - 1000, objective: LONG, last_result: LONG }));
  const live = bigWorkers(6);
  const i = buildInput({ cfg: CFG, workers: [...live, ...fin], referents: {}, exchanges: bigEx, message: "hi", now: NOW });
  assert.ok(estimateTokens(i) <= 3000);
  assert.ok(i.workers.every((x) => x.status === "running") || i.workers.length > 6);
  assert.ok(i.exchanges.length >= 2);
});

test("an impossible budget throws context-over-budget", () => {
  assert.throws(() => buildInput({ cfg: { context: { max_tokens: 100 } }, workers: WORKERS, referents: {}, exchanges: [], message: "hi", now: NOW }), /context-over-budget/);
});

test("validation_errors are passed through when present", () => {
  const errs = [{ code: "unknown-target", field: "target_session_ids.0", detail: "ghost-9" }];
  assert.deepEqual(input({ validationErrors: errs }).validation_errors, errs);
  assert.ok(!("validation_errors" in input({ validationErrors: [] })));
});

test("instructions: carries the new_session all-null rule, no-invented-ids, no tools, clarify, coreference order", () => {
  const t = instructionsText();
  assert.match(t, /new_session must be all-null \(needed: false, provider, label and objective null\) for every action other than create_session/);
  assert.match(t, /never invent an id/i);
  assert.match(t, /use only ids that appear in `workers`/i);
  assert.match(t, /no tools/i);
  assert.match(t, /materially ambiguous/);
  assert.match(t, /explicit id.*label.*alias.*referents.*focused_session_id/s);
  for (const a of ["respond", "message_session", "message_multiple", "create_session", "request_status", "clarify"]) assert.ok(t.includes(a), a);
  assert.ok(estimateTokens(t) < 600, `instructions ${estimateTokens(t)} tokens`);
  assert.equal(input().instructions, t);
});

test("the spec's coreference examples reach a valid decision through resolveLine, buildInput and lunaLikePolicy", () => {
  const workers = [...WORKERS, w("migration-01", "codex", "idle")].filter((x) => x.id !== "migration-01");
  const cases = [
    ["tell the auth worker to keep going", (d) => assert.deepEqual(d.target_session_ids, ["auth-01"])],
    ["tell him not to change the backend", (d) => assert.deepEqual(d.target_session_ids, ["auth-01"])],
    ["have the other one check it too", (d) => assert.deepEqual(d.target_session_ids, ["invoice-01"])],
    ["do that for both", (d) => { assert.equal(d.action, "message_multiple"); assert.equal(d.worker_instruction, "keep going"); }],
    ["make another worker for the migration", (d) => { assert.equal(d.action, "create_session"); assert.equal(d.new_session.label, "migration"); }],
    ["what did the invoice worker say?", (d) => { assert.equal(d.action, "request_status"); assert.deepEqual(d.target_session_ids, ["invoice-01"]); }],
  ];
  const exchanges = [ex("tell invoice-01 to start", ["invoice-01"], "start the export"), ex("tell auth-01 to keep going", ["auth-01"], "keep going")];
  for (const [line, check] of cases) {
    const r = resolveLine(line, { workers, focusedId: "auth-01", exchanges });
    let d;
    if (r.kind === "decision") d = r.decision;
    else {
      assert.equal(r.kind, "model", line);
      d = lunaLikePolicy(buildInput({ cfg: CFG, workers, focusedId: "auth-01", referents: r.referents, exchanges, message: line, now: NOW }));
    }
    check(d);
    assert.deepEqual(validateDecision(d, { workers }).errors, [], line);
  }
});

test("lunaLikePolicy clarifies an ambiguous recent set with no focus", () => {
  const exchanges = [ex("tell invoice-01 to start", ["invoice-01"], "a"), ex("tell auth-01 to go", ["auth-01"], "b")];
  const r = resolveLine("continue", { workers: WORKERS, focusedId: null, exchanges });
  assert.equal(r.kind, "model");
  const d = lunaLikePolicy(buildInput({ cfg: CFG, workers: WORKERS, focusedId: null, referents: { ...r.referents, pronoun: null }, exchanges, message: "continue", now: NOW }));
  assert.equal(d.action, "clarify");
});
