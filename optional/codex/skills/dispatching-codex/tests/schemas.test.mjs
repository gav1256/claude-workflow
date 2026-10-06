import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR } from "./helpers.mjs";

const load = (name) => JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "schemas", `${name}.json`), "utf8"));

/** Every object node must be strict (Codex --output-schema): additionalProperties:false and required = all keys. */
function checkStrict(node, where) {
  if (!node || typeof node !== "object") return;
  if (node.type === "object" || node.properties) {
    assert.equal(node.additionalProperties, false, `${where}: additionalProperties:false`);
    assert.deepEqual([...node.required ?? []].sort(), Object.keys(node.properties ?? {}).sort(), `${where}: required = all keys`);
    for (const [k, v] of Object.entries(node.properties ?? {})) checkStrict(v, `${where}.${k}`);
  }
  if (node.items) checkStrict(node.items, `${where}[]`);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[k])) node[k].forEach((n, i) => checkStrict(n, `${where}.${k}[${i}]`));
}

for (const name of ["write", "review", "diagnose", "research"]) {
  test(`schemas/${name}.json parses and is strict`, () => {
    const s = load(name);
    assert.equal(s.type, "object");
    checkStrict(s, name);
  });
}

test("review schema is the adopted upstream layout with attribution", () => {
  const s = load("review");
  assert.deepEqual(Object.keys(s.properties).sort(), ["findings", "next_steps", "summary", "verdict"]);
  assert.deepEqual(s.properties.verdict.enum, ["approve", "needs-attention"]);
  assert.deepEqual(Object.keys(s.properties.findings.items.properties).sort(),
    ["body", "confidence", "file", "line_end", "line_start", "recommendation", "severity", "title"]);
  assert.match(s.$comment, /openai\/codex-plugin-cc/);
  assert.match(s.$comment, /db52e28f4d9ded852ab3942cea316258ae4ef346/);
  assert.match(s.$comment, /Apache-2\.0/);
  assert.match(s.$comment, /modified: none/);
  const notice = fs.readFileSync(path.join(SKILL_DIR, "NOTICE"), "utf8");
  assert.match(notice, /This product includes software from openai\/codex-plugin-cc \(https:\/\/github\.com\/openai\/codex-plugin-cc\), Copyright 2026 OpenAI, licensed under the Apache License 2\.0\./);
});

test("diagnose and research schemas have the planned keys", () => {
  const d = load("diagnose");
  assert.deepEqual(Object.keys(d.properties).sort(), ["hypotheses", "note"]);
  assert.deepEqual(Object.keys(d.properties.hypotheses.items.properties).sort(), ["check", "claim"]);
  const r = load("research");
  assert.deepEqual(Object.keys(r.properties).sort(), ["answer", "findings", "note"]);
  assert.deepEqual(Object.keys(r.properties.findings.items.properties).sort(), ["claim", "confidence", "source_url"]);
  assert.deepEqual(r.properties.findings.items.properties.confidence.enum, ["high", "medium", "low"]);
});

test("templates: review, diagnose and research carry their extra lines", () => {
  const t = (n) => fs.readFileSync(path.join(SKILL_DIR, "templates", `${n}.md`), "utf8");
  assert.match(t("review"), /^Review input: \.codex-tmp\/<run-id>\/review\.patch \(sha256 <hash>\)$/m);
  assert.match(t("diagnose"), /^Failed attempts:/m);
  assert.match(t("diagnose"), /^Ruled out:/m);
  assert.match(t("research"), /secrets|private project names/);
  assert.match(t("research"), /source/i);
  for (const n of ["review", "diagnose", "research"]) assert.match(t(n), /^Worker rules: \{\{WORKER_RULES\}\}[ \t]*$/m);
});
