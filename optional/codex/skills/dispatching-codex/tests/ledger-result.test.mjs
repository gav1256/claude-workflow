import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpEnv } from "./helpers.mjs";

const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = env.CODEX_HOME;
const P = await import("../lib/paths.mjs");
const L = await import("../lib/ledger.mjs");
const { buildResult } = await import("../lib/result.mjs");
assert.equal(P.LEDGER.startsWith(env.root), true);
after(() => env.cleanup());

test("appendRun writes one line with exactly the ledger keys, missing as null", () => {
  L.appendRun({ ts: 1790000000000, run_id: "r1", task: "t", mode: "write", model: "sol", writer: "codex-sol",
    effort: "medium", status: "done", checks_passed: true, host_checks: false, secs: 12,
    codex_tokens: { in: 1, cached: 0, out: 2 }, files: ["a (+1 -0)"], week_pct: 4, extra: "dropped" });
  L.appendRun({ run_id: "r2" });
  const lines = fs.readFileSync(P.LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  const keys = ["ts", "run_id", "task", "mode", "model", "writer", "effort", "status",
    "checks_passed", "host_checks", "secs", "codex_tokens", "files", "week_pct"];
  assert.deepEqual(Object.keys(lines[0]), keys);
  assert.deepEqual(Object.keys(lines[1]), keys);
  assert.equal(lines[1].task, null);
  assert.equal(lines[0].writer, "codex-sol");
});

const big = (n, c = "x") => c.repeat(n);

test("buildResult: small result passes through unchanged", () => {
  const r = { run: "r1", status: "done", reason: null, mode: "write", model: "gpt-6.1-sol", model_downgraded: false,
    secs: 3, files: ["a (+1 -0)"], checks: [{ cmd: "npm test", exit: 0, tail: "ok" }], host_checks: false,
    codex_note: "n", week_pct: 4, orphans: [] };
  assert.deepEqual(JSON.parse(buildResult(r)), r);
});

test("buildResult: 10 KB inputs fit in 2000 chars, valid JSON, caps applied", () => {
  const r = { run: "r1", status: "done", reason: null, mode: "review", model: "gpt-6.1-sol", model_downgraded: false,
    secs: 3, files: Array.from({ length: 200 }, (_, i) => `src/very/long/path/file-${i}.ts (+10 -2)`),
    checks: Array.from({ length: 3 }, () => ({ cmd: "npm test", exit: 1, tail: big(10000) })),
    host_checks: false, codex_note: big(10000), week_pct: 4, orphans: [],
    verdict: "rework", patch_sha256: "a".repeat(64),
    findings: Array.from({ length: 20 }, () => ({ sev: "high", file: "a.ts", line: 1, claim: big(5000), scenario: big(5000) })),
    hypotheses: Array.from({ length: 9 }, () => ({ claim: big(5000), check: big(5000) })),
    answer: big(10000) };
  const s = buildResult(r);
  assert.ok(s.length <= 2000, `length ${s.length}`);
  const o = JSON.parse(s);
  assert.equal(o.patch_sha256, "a".repeat(64));
  assert.equal(o.verdict, "rework");
  assert.equal(o.run, "r1");
});

test("buildResult: order of truncation, files get '+k more' after the earlier steps", () => {
  const base = { run: "r1", status: "done", reason: null, mode: "write", model: "m", model_downgraded: false, secs: 1,
    host_checks: false, week_pct: 1, orphans: [] };
  // check tails capped to 300 first, codex_note to 300, answer to 1500: no file truncation needed.
  const a = JSON.parse(buildResult({ ...base, files: ["f1", "f2"], checks: [{ cmd: "c", exit: 0, tail: big(900) }], codex_note: big(900) }));
  assert.equal(a.checks[0].tail.length, 300);
  assert.equal(a.codex_note.length, 300);
  assert.deepEqual(a.files, ["f1", "f2"]);
  // many files: first N + "+k more"; the result still lists at least one.
  const files = Array.from({ length: 100 }, (_, i) => `path/to/file-${i}.ts (+1 -1)`);
  const b = JSON.parse(buildResult({ ...base, files, checks: [{ cmd: "c", exit: 0, tail: big(300) }], answer: big(600) }));
  assert.match(b.files.at(-1), /^\+\d+ more$/);
  assert.equal(b.files[0], files[0]);
  // findings: at most 8, each field at most 200.
  const c = JSON.parse(buildResult({ ...base, files: [], findings: Array.from({ length: 12 }, () => ({ sev: "low", claim: big(900) })) }));
  assert.ok(c.findings.length <= 8);
  assert.ok(c.findings.every((f) => f.claim.length <= 200));
  // hypotheses: at most 5.
  const d = JSON.parse(buildResult({ ...base, files: [], hypotheses: Array.from({ length: 8 }, () => ({ claim: "c", check: "k" })) }));
  assert.equal(d.hypotheses.length, 5);
});
