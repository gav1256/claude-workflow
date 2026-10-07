import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, matchRef, referents, resolveLine } from "../resolve.mjs";
import { validateDecision } from "../validate.mjs";

const w = (id, provider, status, extra = {}) => ({ id, provider, label: id.replace(/-\d+$/, ""), aliases: [], status, ...extra });
const WORKERS = [
  w("auth-01", "claude", "running", { aliases: ["login worker"] }),
  w("invoice-01", "codex", "waiting_for_user"),
  w("old-01", "claude", "finished"),
];
const ex = (user, targets, instruction, extra = {}) => ({ user, reply: "ok", action: "message_session", targets, instruction, ...extra });
const R = (text, o = {}) => resolveLine(text, { workers: WORKERS, focusedId: null, exchanges: [], ...o });

test("M1 /to routes with no model call; an unknown ref is an error naming the workers", () => {
  const r = R("/to auth-01 keep going");
  assert.equal(r.kind, "decision");
  assert.equal(r.rule, "command");
  assert.deepEqual(r.decision.target_session_ids, ["auth-01"]);
  assert.equal(r.decision.action, "message_session");
  assert.equal(r.decision.worker_instruction, "keep going");
  assert.equal(r.decision.confidence, 1);
  assert.ok(validateDecision(r.decision, { workers: WORKERS }).ok);
  const e = R("/to ghost-9 hi");
  assert.equal(e.kind, "error");
  assert.match(e.reply, /No worker named ghost-9/);
  assert.match(e.reply, /auth-01/);
  assert.match(e.reply, /invoice-01/);
  assert.doesNotMatch(e.reply, /old-01/);
});

test("/to with several refs is message_multiple; a finished target is an error", () => {
  const r = R("/to auth-01,invoice,auth-01 hello  there");
  assert.equal(r.decision.action, "message_multiple");
  assert.deepEqual(r.decision.target_session_ids, ["auth-01", "invoice-01"]); // the duplicate is dropped
  assert.equal(r.decision.worker_instruction, "hello  there");
  assert.ok(validateDecision(r.decision, { workers: WORKERS }).ok);
  const e = R("/to old-01 hi");
  assert.equal(e.kind, "error");
  assert.match(e.reply, /old-01 is finished/);
  assert.equal(R('/to "login worker" retry').decision.target_session_ids[0], "auth-01");
});

test("/to keeps the text verbatim, however long", () => {
  const text = "x".repeat(10000);
  assert.equal(R(`/to auth-01 ${text}`).decision.worker_instruction, text);
});

test("parseCommand shapes", () => {
  assert.deepEqual(parseCommand("/to a-1,b-2 do it now"), { cmd: "to", targets: ["a-1", "b-2"], text: "do it now" });
  assert.deepEqual(parseCommand("/status"), { cmd: "status", targets: [] });
  assert.deepEqual(parseCommand("/status auth-01 invoice-01"), { cmd: "status", targets: ["auth-01", "invoice-01"] });
  assert.deepEqual(parseCommand("/new codex migration build the thing"), { cmd: "new", provider: "codex", label: "migration", objective: "build the thing" });
  assert.deepEqual(parseCommand("/new claude fix-ui --in auth-01 tidy css"), { cmd: "new", provider: "claude", label: "fix-ui", objective: "tidy css", inWorktreeOf: "auth-01" });
  assert.deepEqual(parseCommand("/alias auth-01 login worker"), { cmd: "alias", target: "auth-01", alias: "login worker" });
  for (const c of ["restart-closed", "workers", "help", "quit"]) assert.deepEqual(parseCommand(`/${c}`), { cmd: c });
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand("/to auth-01"), null);
  assert.equal(parseCommand("/new gemini x y"), null);
});

test("malformed or unknown commands are usage errors, never sent to the model", () => {
  assert.match(R("/to auth-01").reply, /Usage: \/to/);
  assert.match(R("/new codex").reply, /Usage: \/new/);
  assert.match(R("/frobnicate x").reply, /Unknown command \/frobnicate/);
  assert.equal(R("/quit").kind, "command");
  assert.equal(R("/quit").command, "quit");
  assert.equal(R("/workers").command, "workers");
});

test("/status, /new, /alias build valid decisions", () => {
  const s = R("/status auth-01");
  assert.equal(s.decision.action, "request_status");
  assert.deepEqual(s.decision.target_session_ids, ["auth-01"]);
  assert.deepEqual(R("/status").decision.target_session_ids, []);
  assert.match(R("/status ghost").reply, /No worker named ghost/);
  const n = R("/new codex migration build the thing");
  assert.equal(n.decision.action, "create_session");
  assert.deepEqual(n.decision.new_session, { needed: true, provider: "codex", label: "migration", objective: "build the thing" });
  assert.equal(R("/new claude fix-ui --in auth-01 tidy css").inWorktreeOf, "auth-01");
  assert.match(R("/new claude fix-ui --in ghost tidy css").reply, /No worker named ghost/);
  assert.match(R("/new codex Bad_Label x").reply, /Bad label/);
  assert.match(R("/new codex auth-01 x").reply, /label-in-use/);
  const a = R("/alias invoice-01 billing worker");
  assert.equal(a.decision.action, "respond");
  assert.deepEqual(a.decision.record_update.aliases, [{ session_id: "invoice-01", alias: "billing worker" }]);
  assert.match(R("/alias invoice-01 login worker").reply, /alias-clash/);
});

test("matchRef: id, then label (live only), then alias, ambiguity", () => {
  assert.deepEqual(matchRef("auth-01", WORKERS), { id: "auth-01" });
  assert.deepEqual(matchRef("old-01", WORKERS), { id: "old-01" });
  assert.deepEqual(matchRef("invoice", WORKERS), { id: "invoice-01" });
  assert.deepEqual(matchRef("old", WORKERS), { none: true }); // label of a finished worker
  assert.deepEqual(matchRef("login worker", WORKERS), { id: "auth-01" });
  assert.deepEqual(matchRef("nobody", WORKERS), { none: true });
  const two = [w("auth-01", "claude", "running"), w("auth-02", "claude", "idle")];
  assert.deepEqual(matchRef("auth", two), { ambiguous: ["auth-01", "auth-02"] });
});

test("M2 an alias gives a decision (rule alias)", () => {
  const r = R("tell the login worker to retry");
  assert.equal(r.kind, "decision");
  assert.equal(r.rule, "alias");
  assert.deepEqual(r.decision.target_session_ids, ["auth-01"]);
  assert.equal(r.decision.worker_instruction, "tell the login worker to retry");
  assert.equal(r.decision.confidence, 1);
});

test("an explicit id or a label gives explicit-id / exact-name", () => {
  assert.equal(R("please ask auth-01 to stop").rule, "explicit-id");
  const r = R("tell the invoice worker to retry");
  assert.equal(r.rule, "exact-name");
  assert.deepEqual(r.decision.target_session_ids, ["invoice-01"]);
  assert.equal(R("tell the auth worker to keep going").rule, "exact-name");
});

test("a name inside a longer word or id is not a mention; a shared label is not guessed", () => {
  assert.equal(R("tell the authentication worker hi").kind, "model");
  const two = [w("auth-01", "claude", "running"), w("auth-02", "claude", "idle")];
  assert.equal(resolveLine("tell auth to go", { workers: two, focusedId: "auth-01", exchanges: [] }).kind, "model");
  assert.equal(resolveLine("tell auth-02 to go", { workers: two }).decision.target_session_ids[0], "auth-02");
});

test("a pronoun, a question, or a non-messageable worker sends the line to the model", () => {
  assert.equal(R("tell the login worker to retry it").kind, "model");
  assert.equal(R("what did the invoice worker say?").kind, "model");
  assert.equal(R("tell old-01 to retry").kind, "model");
});

test("M3 continue: one messageable worker is continue-single, two go to the model", () => {
  const one = [w("auth-01", "claude", "running"), w("old-01", "claude", "finished"), w("q-01", "codex", "queued")];
  const r = resolveLine("continue", { workers: one });
  assert.equal(r.kind, "decision");
  assert.equal(r.rule, "continue-single");
  assert.deepEqual(r.decision.target_session_ids, ["auth-01"]);
  assert.equal(r.decision.worker_instruction, "continue");
  assert.equal(resolveLine("Keep going!", { workers: one }).rule, "continue-single");
  const m = R("continue", { focusedId: "auth-01" });
  assert.equal(m.kind, "model");
  assert.equal(m.referents.singular, "auth-01");
  assert.equal(resolveLine("continue with the tests", { workers: one }).kind, "model");
});

test("M4 pronouns: singular, that one, the other one, both", () => {
  const a = R("tell him not to change the backend", { focusedId: "auth-01" });
  assert.equal(a.kind, "model");
  assert.equal(a.referents.pronoun, "singular");
  assert.equal(a.referents.singular, "auth-01");
  const that = R("that one", { focusedId: "auth-01" });
  assert.equal(that.referents.pronoun, "singular");
  assert.equal(that.referents.singular, "auth-01");
  const exchanges = [ex("tell invoice-01 to retry", ["invoice-01"], "retry the export"), ex("ask auth-01 to add tests", ["auth-01"], "add tests")];
  const o = R("have the other one check it too", { focusedId: "auth-01", exchanges });
  assert.equal(o.referents.pronoun, "other");
  assert.equal(o.referents.other, "invoice-01");
  const b = R("do that for both", { focusedId: "auth-01", exchanges });
  assert.equal(b.referents.pronoun, "both");
  assert.deepEqual(b.referents.both, ["auth-01", "invoice-01"]);
  assert.equal(b.referents.last_instruction, "add tests");
});

test("referents: precedence, recency by name in text, finished workers excluded, no focus", () => {
  const exchanges = [ex("tell invoice-01 to retry", [], "x"), ex("what about the auth worker?", [], null)];
  const r = referents({ text: "tell him", workers: WORKERS, focusedId: null, exchanges });
  assert.deepEqual(r.recent, ["auth-01", "invoice-01"]); // mentioned by name in the user text, newest first
  assert.equal(r.singular, "auth-01");
  assert.equal(r.last_instruction, null);
  assert.equal(referents({ text: "both of them, the other one, it", workers: WORKERS }).pronoun, "both");
  assert.equal(referents({ text: "the other one, and it", workers: WORKERS }).pronoun, "other");
  assert.equal(referents({ text: "no pronoun here", workers: WORKERS }).pronoun, null);
  const fin = referents({ text: "it", workers: WORKERS, focusedId: "old-01", exchanges: [ex("x", ["old-01", "auth-01"], "y")] });
  assert.deepEqual(fin.recent, ["auth-01"]);
  assert.equal(fin.singular, "auth-01"); // focus is finished, so it is skipped
  assert.equal(fin.both, null);
  assert.equal(referents({ text: "it", workers: WORKERS }).singular, null);
});

test("M5 two named workers go to the model, never a guess", () => {
  assert.equal(R("tell auth-01 and invoice-01 to sync").kind, "model");
  assert.equal(R("tell the login worker and invoice-01 to sync").kind, "model");
  assert.equal(R("auth and invoice should sync").kind, "model");
});

test("K1 /to runs the validator: a control or bidi character is an error; a 5000-char text is a verbatim decision", () => {
  const e = R("/to auth-01 hi ‮ evil");
  assert.equal(e.kind, "error");
  assert.match(e.reply, /control-char/);
  const long = R(`/to auth-01 ${"y".repeat(5000)}`);
  assert.equal(long.kind, "decision");
  assert.equal(long.verbatim, true);
  assert.equal(long.decision.worker_instruction.length, 5000);
  assert.equal(R(`/to auth-01 ${"y".repeat(5000)}‮`).kind, "error");
  assert.equal(R("/to auth-01 hi").verbatim, true);
  assert.equal(R("/status").verbatim, undefined);
  assert.equal(R("tell the login worker to retry").verbatim, undefined);
});

test("K2 recency inside one exchange: the later mention is recent[0], by id, label or alias", () => {
  const a = referents({ text: "it", workers: WORKERS, exchanges: [ex("tell invoice-01 then auth-01", [], null)] });
  assert.deepEqual(a.recent, ["auth-01", "invoice-01"]);
  const b = referents({ text: "it", workers: WORKERS, exchanges: [ex("tell the auth worker then invoice-01", [], null)] });
  assert.deepEqual(b.recent, ["invoice-01", "auth-01"]);
  const c = referents({ text: "it", workers: WORKERS, exchanges: [ex("tell invoice-01 then the login worker", [], null)] });
  assert.deepEqual(c.recent, ["auth-01", "invoice-01"]);
  const d = referents({ text: "it", workers: WORKERS, exchanges: [ex("tell auth-01 hi", [], null), ex("tell invoice-01 hi", [], null)] });
  assert.deepEqual(d.recent, ["invoice-01", "auth-01"]); // a newer exchange still beats an older one
});

test("K9 continue never goes to a lone failed worker, nor when a failed one sits beside an active one", () => {
  const lone = [w("auth-01", "claude", "failed")];
  assert.equal(resolveLine("continue", { workers: lone }).kind, "model");
  const two = [w("auth-01", "claude", "running"), w("bad-01", "claude", "failed")];
  assert.equal(resolveLine("continue", { workers: two }).kind, "model");
  assert.equal(resolveLine("continue", { workers: [w("auth-01", "claude", "idle")] }).rule, "continue-single");
});

test("K10 names match on Unicode word boundaries: a name glued to Hebrew letters is not a mention", () => {
  assert.equal(R("לאauth-01 תמשיך").kind, "model");
  assert.equal(R("auth-01א go").kind, "model");
  const ok = R("תגיד ל auth-01 להמשיך");
  assert.equal(ok.kind, "decision");
  assert.deepEqual(ok.decision.target_session_ids, ["auth-01"]);
  assert.equal(R("tell the login workerא to go").kind, "model");
});
