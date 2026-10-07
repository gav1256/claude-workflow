// Task 18: contract tests. Four contracts across the skill folder: strict schemas, the template fields, the 2000-char
// result line, and one end-to-end fake run per mode (review runs on the patch of a prior fake write run).
// The fake runs go through the real codex-run.mjs with the fake codex and the fake icacls preload (same setup as run.test.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpEnv, makeRepo, addWorktree, scenario, rmrf, SKILL_DIR, TESTS_DIR } from "./helpers.mjs";

// paths.mjs reads the environment at import: set it before the dynamic imports.
const env = tmpEnv();
const HOME = path.join(env.root, "home");
fs.mkdirSync(HOME, { recursive: true });
env.USERPROFILE = HOME;
const ICACLS_PRELOAD = path.join(env.root, "fake-icacls-preload.mjs");
fs.writeFileSync(ICACLS_PRELOAD, 'import cp from "node:child_process";\nimport { syncBuiltinESMExports } from "node:module";\n' +
  "const orig = cp.spawn;\n" +
  `cp.spawn = (f, a, o) => (/icacls\\.exe$/i.test(String(f)) ? orig(process.execPath, [${JSON.stringify(path.join(TESTS_DIR, "fake-icacls.mjs"))}, ...a], o) : orig(f, a, o));\n` +
  "syncBuiltinESMExports();\n");
env.NODE_OPTIONS = `--import ${pathToFileURL(ICACLS_PRELOAD).href}`;
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME, CODEX_RUN_PIPE_PREFIX: env.CODEX_RUN_PIPE_PREFIX,
  CODEX_RUN_BIN: env.CODEX_RUN_BIN, CODEX_RUN_BIN_ARGS: env.CODEX_RUN_BIN_ARGS, CODEX_RUN_TEMP: env.CODEX_RUN_TEMP,
});
delete process.env.CODEX_RUN_PROCS;
const P = await import("../lib/paths.mjs");
const PR = await import("../lib/procs.mjs");
const { buildResult } = await import("../lib/result.mjs");
const { WORKER_ONLY } = await import("../lib/brief.mjs");
assert.equal(P.STATE.startsWith(env.root), true, "state folder must be inside the temp root");

const CODEX_RUN = path.join(SKILL_DIR, "codex-run.mjs");
const dirs = [];
after(() => {
  for (const d of dirs) rmrf(d);
  env.cleanup();
});

const load = (name) => JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "schemas", `${name}.json`), "utf8"));
const template = (name) => fs.readFileSync(path.join(SKILL_DIR, "templates", `${name}.md`), "utf8").replace(/\r\n/g, "\n");
const MODES = ["write", "review", "diagnose", "research"];

// ------------------------------------------------------------------------------------------ 1: schemas are strict

function strictness(node, where, errors) {
  if (!node || typeof node !== "object") return;
  const types = [].concat(node.type ?? []);
  if (types.includes("object") || node.properties) {
    if (node.additionalProperties !== false) errors.push(`${where}: additionalProperties is not false`);
    const props = Object.keys(node.properties ?? {}).sort();
    const req = [...(node.required ?? [])].sort();
    if (JSON.stringify(props) !== JSON.stringify(req)) errors.push(`${where}: required [${req}] != properties [${props}]`);
    for (const [k, v] of Object.entries(node.properties ?? {})) strictness(v, `${where}.${k}`, errors);
  }
  if (node.items) strictness(node.items, `${where}[]`, errors);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[k])) node[k].forEach((n, i) => strictness(n, `${where}.${k}[${i}]`, errors));
}

test("contract: every schemas/*.json is strict (additionalProperties false, required equals the property keys, at every object)", () => {
  const files = fs.readdirSync(path.join(SKILL_DIR, "schemas")).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, MODES.map((m) => `${m}.json`).sort(), "one schema per mode, nothing else");
  for (const f of files) {
    const s = load(f.replace(/\.json$/, ""));
    assert.equal(s.type, "object", `${f}: root is an object`);
    const errors = [];
    strictness(s, f, errors);
    assert.deepEqual(errors, []);
  }
});

test("contract: the review schema keeps the upstream layout (verdict approve|needs-attention, summary, findings, next_steps)", () => {
  const s = load("review");
  assert.deepEqual(Object.keys(s.properties).sort(), ["findings", "next_steps", "summary", "verdict"]);
  assert.deepEqual(s.properties.verdict.enum, ["approve", "needs-attention"]);
  assert.deepEqual(Object.keys(s.properties.findings.items.properties).sort(),
    ["body", "confidence", "file", "line_end", "line_start", "recommendation", "severity", "title"]);
});

// ------------------------------------------------------------------------------------------ 2: templates

// spec:113-124 fields; "Files you own" belongs to write only (the read-only modes edit nothing).
const COMMON_FIELDS = ["# Task <id>", "Goal:", "Read first:", "Builds on:", "Done when:", "Constraints:", "Worker rules:"];
const EXTRA_FIELDS = {
  write: ["Files you own:"],
  review: ["Review input:"],
  diagnose: ["Failed attempts:", "Ruled out:"],
  research: ["Privacy:", "Sources:"],
};

for (const mode of MODES) {
  test(`contract: templates/${mode}.md has every field, the {{WORKER_RULES}} line and the WORKER_ONLY sentence`, () => {
    const t = template(mode);
    const lines = t.split("\n");
    for (const f of [...COMMON_FIELDS, ...EXTRA_FIELDS[mode]]) {
      assert.ok(lines.some((l) => l.startsWith(f)), `${mode}: missing field ${f}`);
    }
    assert.equal(t.split("{{WORKER_RULES}}").length - 1, 1, "exactly one placeholder");
    assert.match(t, /^Worker rules: \{\{WORKER_RULES\}\}[ \t]*$/m);
    assert.ok(t.includes(WORKER_ONLY), "the WORKER_ONLY sentence, verbatim");
    // the sentence sits directly above the placeholder line, as finalizeBrief writes it
    const at = lines.findIndex((l) => l.startsWith("Worker rules:"));
    assert.equal(lines[at - 1], WORKER_ONLY);
  });
}

test("contract: the diagnose and research templates carry their extra fields in a fixed place", () => {
  const d = template("diagnose");
  assert.match(d, /^Failed attempts: /m);
  assert.match(d, /^Ruled out: /m);
  assert.ok(d.indexOf("Failed attempts:") < d.indexOf("Ruled out:") && d.indexOf("Ruled out:") < d.indexOf("Read first:"));
  const r = template("research");
  assert.match(r, /^Privacy: .*(secrets|private project names)/m);
  assert.match(r, /^Sources: .*source_url/m);
});

// ------------------------------------------------------------------------------------------ 3: buildResult stays under 2000

test("contract: buildResult keeps a review result with 20 findings under 2000 chars, compacted and capped at 8", () => {
  const findings = Array.from({ length: 20 }, (_, i) => ({
    severity: ["critical", "high", "medium", "low"][i % 4], title: `Finding ${i} ` + "t".repeat(300), body: "b".repeat(2000),
    file: `src/very/long/path/number-${i}.js`, line_start: i + 1, line_end: i + 5, confidence: 0.9, recommendation: "r".repeat(1000),
  }));
  const line = buildResult({
    run: "20260101T000000Z-aaaaaa", mode: "review", status: "done", reason: null, verdict: "needs-attention",
    summary: "s".repeat(1000), findings, next_steps: ["n".repeat(500)], patch_sha256: "f".repeat(64),
  });
  assert.ok(line.length < 2000, `result line is ${line.length} chars`);
  const j = JSON.parse(line);
  assert.equal(j.verdict, "needs-attention");
  assert.equal(j.patch_sha256, "f".repeat(64), "patch_sha256 passes through untouched");
  assert.ok(j.findings.length >= 1 && j.findings.length <= 8, `findings kept: ${j.findings.length}`);
  for (const f of j.findings) {
    assert.deepEqual(Object.keys(f).sort(), ["file", "line_end", "line_start", "severity", "title"]);
    assert.ok(f.title.length <= 100);
  }
  assert.deepEqual(j.findings.map((f) => f.line_start), j.findings.map((_, i) => i + 1), "the first findings are the ones kept, in order");
});

test("contract: buildResult keeps a research result with a 5 KB answer under 2000 chars", () => {
  const line = buildResult({
    run: "20260101T000000Z-bbbbbb", mode: "research", status: "done", reason: null, answer: "a".repeat(5 * 1024),
    findings: Array.from({ length: 6 }, (_, i) => ({ claim: "c".repeat(400) + i, source_url: "https://example.com/" + "u".repeat(300), confidence: "high" })),
  });
  assert.ok(line.length < 2000, `result line is ${line.length} chars`);
  const j = JSON.parse(line);
  assert.equal(j.mode, "research");
  assert.equal(typeof j.answer, "string");
  assert.ok(j.answer.length > 0 && j.answer.length <= 1500);
  assert.ok(Array.isArray(j.findings));
});

// ------------------------------------------------------------------------------------------ 4: end to end per mode

let seq = 0;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeText = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

function resetState() {
  rmrf(P.STATE);
  rmrf(P.USAGE_DIR);
  rmrf(path.join(P.CODEX_HOME, "sessions"));
  fs.mkdirSync(P.STATE, { recursive: true });
  writeText(P.TESTED_VERSION, "0.160.0\n");
  writeText(P.ACL_STATE, JSON.stringify({ last_complete: new Date().toISOString() }));
  writeText(PR.LISTER_PROBE, JSON.stringify({ version: "0.160.0", ok: true, at: new Date().toISOString() }));
  rmrf(path.join(env.CLAUDE_CONFIG_DIR, "AGENTS.md"));
  scenario({}, env);
  const file = path.join(env.root, `fx-${++seq}.json`);
  writeText(file, JSON.stringify({ log: path.join(env.root, `procs-${seq}.log`), session: { ok: true, rows: [] }, full: { ok: true, rows: [] } }));
  env.CODEX_RUN_PROCS = file;
}

function briefFile(text) {
  const f = path.join(env.root, `brief-${++seq}.md`);
  writeText(f, text);
  return f;
}

function runCli(args) {
  // env is spread (enumerable keys only; root and cleanup stay out)
  const r = spawnSync(process.execPath, [CODEX_RUN, ...args], { env: { ...env }, encoding: "utf8", windowsHide: true, timeout: 240000 });
  const lines = String(r.stdout ?? "").split("\n").filter(Boolean);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.equal(lines.length, 1, `stdout is not one line: ${r.stdout}`);
  assert.ok(lines[0].length <= 2000, `line is ${lines[0].length} chars`);
  return JSON.parse(lines[0]);
}

const GOOD = {
  write: { status: "done", note: "did it", checks_run: [] },
  review: { verdict: "needs-attention", summary: "one issue", findings: [{ severity: "high", title: "Off by one", body: "b", file: "src/a.txt", line_start: 1, line_end: 1, confidence: 0.8, recommendation: "fix it" }], next_steps: ["rerun"] },
  diagnose: { hypotheses: [{ claim: "stale cache", check: "clear it" }, { claim: "bad path", check: "print it" }], note: "n" },
  research: { answer: "short answer", findings: [{ claim: "c", source_url: "https://example.com/doc", confidence: "high" }], note: "n" },
};

test("contract: an end-to-end fake run per mode returns the mode's fields (review runs on the patch of a prior write run)", () => {
  resetState();
  const repo = makeRepo();
  dirs.push(path.dirname(repo));
  const wt = addWorktree(repo, "c18");

  // write
  scenario({ writes: [{ path: "src/a.txt", content: "hello\n" }], lastJson: GOOD.write }, env);
  const w = runCli(["--brief", briefFile("# Task T1: demo\nGoal: do it.\nFiles you own: src/**.\nDo not create or edit anything else.\nDone when: echo ok\nWorker rules: {{WORKER_RULES}}\n"),
    "--cwd", wt, "--mode", "write", "--task", "W1"]);
  assert.equal(w.status, "done", JSON.stringify(w));
  assert.equal(w.mode, "write");
  assert.deepEqual(w.files, ["src/a.txt (+1 -0)"]);
  assert.equal(w.codex_note, "did it");
  assert.ok(Array.isArray(w.checks));

  // review of that run
  scenario({ writes: [], lastJson: GOOD.review }, env);
  const r = runCli(["--brief", briefFile("# Task R1: review\nGoal: review it\n"), "--cwd", wt, "--mode", "review", "--review-of", w.run, "--task", "R1"]);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(r.mode, "review");
  assert.equal(r.verdict, "needs-attention");
  assert.equal(r.summary, "one issue");
  assert.deepEqual(r.findings, [{ severity: "high", title: "Off by one", file: "src/a.txt", line_start: 1, line_end: 1 }]);
  assert.match(r.patch_sha256, /^[0-9a-f]{64}$/);
  assert.equal(readJson(path.join(P.STATE, "runs", r.run, "meta.json")).patch_sha256, r.patch_sha256);

  // diagnose
  scenario({ writes: [], lastJson: GOOD.diagnose }, env);
  const d = runCli(["--brief", briefFile("# Task D1: diagnose\nGoal: why\n"), "--cwd", wt, "--mode", "diagnose", "--task", "D1"]);
  assert.equal(d.status, "done", JSON.stringify(d));
  assert.equal(d.mode, "diagnose");
  assert.deepEqual(d.hypotheses, GOOD.diagnose.hypotheses);

  // research
  scenario({ writes: [], lastJson: GOOD.research }, env);
  const s = runCli(["--brief", briefFile("# Task S1: research\nGoal: what\n"), "--cwd", wt, "--mode", "research", "--task", "S1"]);
  assert.equal(s.status, "done", JSON.stringify(s));
  assert.equal(s.mode, "research");
  assert.equal(s.answer, "short answer");
  assert.deepEqual(s.findings, GOOD.research.findings);
});
