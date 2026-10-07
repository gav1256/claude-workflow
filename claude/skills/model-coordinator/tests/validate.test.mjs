import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyDecision, validateShape, DECISION_SCHEMA } from "../schema.mjs";
import { validateDecision, lowConfidence } from "../validate.mjs";

const w = (id, status, extra) => ({ id, provider: "claude", label: id.replace(/-\d+$/, ""), aliases: [], status, ...extra });
const has = (res, code) => res.errors.some((e) => e.code === code);
const clone = (x) => structuredClone(x);

test("M1 emptyDecision passes validateShape; each top-level field missing gives missing-field", () => {
  assert.deepEqual(validateShape(emptyDecision()), { ok: true, errors: [] });
  for (const k of DECISION_SCHEMA.required) {
    const d = emptyDecision();
    delete d[k];
    const r = validateShape(d);
    assert.ok(r.errors.some((e) => e.code === "missing-field" && e.field === k), k);
  }
});

test("M2 extra top-level or nested fields give unknown-field", () => {
  const CASES = [
    ["file_path", (d) => ({ ...d, file_path: "/etc/passwd" })],
    ["edit", (d) => ({ ...d, edit: {} })],
    ["tool_call", (d) => ({ ...d, tool_call: "x" })],
    ["new_session.cwd", (d) => ({ ...d, new_session: { ...d.new_session, cwd: "/" } })],
    ["record_update.path", (d) => ({ ...d, record_update: { aliases: [], focus: null, note: null, path: "/x" } })],
    ["alias.extra", (d) => ({ ...d, record_update: { aliases: [{ session_id: "a-1", alias: "ab", extra: 1 }], focus: null, note: null } })],
  ];
  for (const [name, mutate] of CASES) assert.ok(has(validateShape(mutate(emptyDecision())), "unknown-field"), name);
});

test("M3 action outside the enum gives enum", () => {
  for (const a of ["write_file", "run_shell", 5, undefined]) {
    assert.ok(has(validateShape({ ...emptyDecision(), action: a }), "enum"), String(a));
  }
});

test("M4 too-long, control-char and range", () => {
  const CASES = [
    ["long instruction", (d) => ({ ...d, worker_instruction: "x".repeat(4001) }), "too-long"],
    ["NUL in reply", (d) => ({ ...d, reply: "a\u0000b" }), "control-char"],
    ["C1 control in reply", (d) => ({ ...d, reply: "a\u009bb" }), "control-char"],
    ["bidi override in reply", (d) => ({ ...d, reply: "a\u202eb" }), "control-char"],
    ["bidi isolate in instruction", (d) => ({ ...d, worker_instruction: "a\u2066b" }), "control-char"],
    ["bidi isolate end in instruction", (d) => ({ ...d, worker_instruction: "a\u2069b" }), "control-char"],
    ["bidi embedding in reply", (d) => ({ ...d, reply: "a\u202ab" }), "control-char"],
    ["confidence 1.2", (d) => ({ ...d, confidence: 1.2 }), "range"],
    ["confidence NaN", (d) => ({ ...d, confidence: NaN }), "range"],
    ["confidence -0.1", (d) => ({ ...d, confidence: -0.1 }), "range"],
    ["label pattern", (d) => ({ ...d, new_session: { ...d.new_session, label: "Bad Label" } }), "pattern"],
    ["alias pattern", (d) => ({ ...d, record_update: { aliases: [{ session_id: "a-1", alias: "Bad!" }], focus: null, note: null } }), "pattern"],
  ];
  for (const [name, mutate, code] of CASES) assert.ok(has(validateShape(mutate(emptyDecision())), code), name);
  assert.ok(!has(validateShape({ ...emptyDecision(), worker_instruction: "x".repeat(4000) }), "too-long"), "4000 chars is fine");
});

test("M5 message targets: unknown, not messageable, target-count", () => {
  const workers = [w("a-1", "running"), w("b-2", "finished"), w("c-3", "dead"), w("d-4", "running")];
  const msg = (action, ids) => emptyDecision({ action, target_session_ids: ids, worker_instruction: "do it" });
  assert.ok(has(validateDecision(msg("message_session", ["zzz"]), { workers }), "unknown-target"));
  assert.ok(has(validateDecision(msg("message_session", ["b-2"]), { workers }), "target-not-messageable"));
  assert.ok(has(validateDecision(msg("message_session", ["c-3"]), { workers }), "target-not-messageable"));
  assert.ok(has(validateDecision(msg("message_multiple", ["a-1"]), { workers }), "target-count"));
  assert.ok(has(validateDecision(msg("message_session", ["a-1", "d-4"]), { workers }), "target-count"));
  assert.ok(validateDecision(msg("message_session", ["a-1"]), { workers }).ok);
  assert.ok(validateDecision(msg("message_multiple", ["a-1", "d-4"]), { workers }).ok);
  assert.ok(has(validateDecision({ ...msg("message_session", ["a-1"]), worker_instruction: "  " }, { workers }), "instruction-required"));
});

test("M6 create_session label-in-use only for live workers", () => {
  const create = (label) => emptyDecision({ action: "create_session", new_session: { needed: true, provider: "claude", label, objective: "do x" } });
  assert.ok(has(validateDecision(create("api-work"), { workers: [w("api-work-1", "running")] }), "label-in-use"));
  assert.ok(validateDecision(create("api-work"), { workers: [w("api-work-1", "finished")] }).ok);
  assert.ok(validateDecision(create("api-work"), { workers: [w("api-work-1", "dead")] }).ok);
  assert.ok(has(validateDecision(emptyDecision({ action: "create_session" }), { workers: [] }), "new-session-required"));
  // a new label equal to a live worker's alias or id is also a clash
  assert.ok(has(validateDecision(create("nickname"), { workers: [w("a-1", "running", { aliases: ["nickname"] })] }), "label-in-use"));
  assert.ok(has(validateDecision(create("a-1"), { workers: [w("a-1", "running")] }), "label-in-use"));
  assert.ok(validateDecision(create("nickname"), { workers: [w("a-1", "finished", { aliases: ["nickname"] })] }).ok);
  assert.ok(validateDecision(create("a-1"), { workers: [w("a-1", "dead")] }).ok);
});

test("M7 alias-clash with another worker id, label or alias", () => {
  const workers = [w("a-1", "running", { label: "alpha", aliases: ["first"] }), w("b-2", "running", { label: "beta" })];
  const ru = (alias) => emptyDecision({ record_update: { aliases: [{ session_id: "a-1", alias }], focus: null, note: null } });
  assert.ok(has(validateDecision(ru("beta"), { workers }), "alias-clash"));
  assert.ok(has(validateDecision(ru("b-2"), { workers }), "alias-clash"));
  const w2 = [w("a-1", "running"), w("b-2", "running", { aliases: ["shared"] })];
  assert.ok(has(validateDecision(ru("shared"), { workers: w2 }), "alias-clash"));
  assert.ok(validateDecision(ru("fresh"), { workers }).ok);
  const dup = (a, b) => emptyDecision({ record_update: { aliases: [a, b], focus: null, note: null } });
  const two = [w("a-1", "running"), w("b-2", "running")];
  assert.ok(has(validateDecision(dup({ session_id: "a-1", alias: "main" }, { session_id: "b-2", alias: "main" }), { workers: two }), "alias-clash"));
  assert.ok(validateDecision(dup({ session_id: "a-1", alias: "main" }, { session_id: "b-2", alias: "other" }), { workers: two }).ok);
  assert.ok(validateDecision(dup({ session_id: "a-1", alias: "main" }, { session_id: "a-1", alias: "main" }), { workers: two }).ok);
  assert.ok(has(validateDecision(emptyDecision({ record_update: { aliases: [{ session_id: "nope", alias: "fresh" }], focus: null, note: null } }), { workers }), "unknown-target"));
  assert.ok(has(validateDecision(emptyDecision({ record_update: { aliases: [], focus: "nope", note: null } }), { workers }), "unknown-target"));
});

test("M8 validator and DECISION_SCHEMA agree (strict-mode rules)", () => {
  const walk = (s, at) => {
    if (s.anyOf) return s.anyOf.forEach((x, i) => walk(x, `${at}.anyOf${i}`));
    if (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object"))) {
      assert.equal(s.additionalProperties, false, `${at} additionalProperties`);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${at} required == properties`);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${at}.${k}`);
    } else if (s.type === "array") walk(s.items, `${at}[]`);
  };
  assert.ok(!DECISION_SCHEMA.anyOf, "root must not be anyOf");
  assert.equal(DECISION_SCHEMA.type, "object");
  walk(DECISION_SCHEMA, "$");
  // the validator's key lists match the schema: dropping any schema-required key is reported
  const ns = DECISION_SCHEMA.properties.new_session;
  const ru = DECISION_SCHEMA.properties.record_update.anyOf[0];
  const d = emptyDecision({ record_update: { aliases: [], focus: null, note: null } });
  assert.deepEqual(validateShape(d), { ok: true, errors: [] });
  for (const k of ns.required) { const x = clone(d); delete x.new_session[k]; assert.ok(has(validateShape(x), "missing-field"), k); }
  for (const k of ru.required) { const x = clone(d); delete x.record_update[k]; assert.ok(has(validateShape(x), "missing-field"), k); }
  for (const k of ru.properties.aliases.items.required) {
    const x = clone(d); x.record_update.aliases = [{ session_id: "a-1", alias: "ab" }]; delete x.record_update.aliases[0][k];
    assert.ok(has(validateShape(x), "missing-field"), k);
  }
});

test("other actions and lowConfidence", () => {
  const workers = [w("a-1", "running")];
  assert.ok(has(validateDecision(emptyDecision({ target_session_ids: ["a-1"] }), { workers }), "targets-not-allowed"));
  assert.ok(has(validateDecision(emptyDecision({ worker_instruction: "x" }), { workers }), "instruction-not-allowed"));
  assert.ok(has(validateDecision(emptyDecision({ action: "clarify" }), { workers }), "clarification-required"));
  assert.ok(validateDecision(emptyDecision({ action: "clarify", clarification: "which one?" }), { workers }).ok);
  assert.ok(validateDecision(emptyDecision({ action: "request_status", target_session_ids: ["a-1"] }), { workers }).ok);
  assert.ok(has(validateDecision(emptyDecision({ action: "request_status", target_session_ids: ["x"] }), { workers }), "unknown-target"));
  assert.ok(has(validateShape(emptyDecision({ target_session_ids: ["a", "a"] })), "duplicate"));
  assert.ok(has(validateShape(emptyDecision({ target_session_ids: Array.from({ length: 9 }, (_, i) => `s${i}`) })), "too-many"));
  assert.ok(lowConfidence(emptyDecision({ action: "message_session", confidence: 0.3 }), 0.6));
  assert.ok(!lowConfidence(emptyDecision({ action: "respond", confidence: 0.3 }), 0.6));
  assert.ok(!lowConfidence(emptyDecision({ action: "message_session", confidence: 0.9 }), 0.6));
  assert.equal(validateShape(null).ok, false);
  assert.equal(validateShape([]).ok, false);
});

test("new_session must be all-null for non-create actions", () => {
  const workers = [w("a-1", "running")];
  const stray = [
    { needed: true }, { provider: "claude" }, { label: "x-y" }, { objective: "do" },
  ];
  for (const action of ["respond", "request_status", "clarify", "message_session"]) {
    for (const ns of stray) {
      const base = { action, new_session: ns, clarification: action === "clarify" ? "q?" : null,
        target_session_ids: action === "message_session" ? ["a-1"] : [], worker_instruction: action === "message_session" ? "go" : null };
      assert.ok(has(validateDecision(emptyDecision(base), { workers }), "new-session-not-allowed"), `${action} ${JSON.stringify(ns)}`);
    }
  }
});

test("lowConfidence has a safe default threshold", () => {
  assert.ok(lowConfidence(emptyDecision({ action: "message_session", confidence: 0.3 })));
  assert.ok(lowConfidence(emptyDecision({ action: "create_session", confidence: 0.3 }), undefined));
  assert.ok(!lowConfidence(emptyDecision({ action: "message_session", confidence: 0.9 })));
  assert.ok(!lowConfidence(emptyDecision({ action: "respond", confidence: 0.1 })));
});
