import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SECRET_PATTERNS, WORKER_ONLY, FALLBACK_RULES,
  secretScan, workerRules, finalizeBrief, parseBrief, checkFeedback,
} from "../lib/brief.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "..");
const agentsPath = join(here, "..", "..", "..", "..", "..", "claude", "AGENTS.md");
const agents = readFileSync(agentsPath, "utf8");
const template = readFileSync(join(skillDir, "templates", "write.md"), "utf8");

// fakes built at run time, never literals
const fakeSk = "sk-" + "ant-" + "x".repeat(12);
const fakeGh = "ghp" + "_" + "a".repeat(20);
const fakeAkia = "AK" + "IA" + "A".repeat(16);
const fakePem = "-----" + "BEGIN PRIVATE KEY";

test("each pattern hits a runtime-built fake", () => {
  assert.deepEqual(Object.keys(SECRET_PATTERNS), ["sk", "gh", "akia", "pem", "authjson"]);
  assert.deepEqual(secretScan(`key ${fakeSk}`), ["sk"]);
  assert.deepEqual(secretScan(`t ${fakeGh}`), ["gh"]);
  assert.deepEqual(secretScan(`id ${fakeAkia}`), ["akia"]);
  assert.deepEqual(secretScan(fakePem), ["pem"]);
  assert.deepEqual(secretScan("read auth.json now"), ["authjson"]);
});

test("near-misses do not match", () => {
  assert.deepEqual(secretScan("sk-short"), []);
  assert.deepEqual(secretScan("ghp" + "_" + "a".repeat(19)), []);
  assert.deepEqual(secretScan("akia" + "A".repeat(16)), []);
  assert.deepEqual(secretScan("BEGIN PRIVATE KEY"), []);
  assert.deepEqual(secretScan("authXjson"), []);
});

test("secretScan never returns the matched text", () => {
  const r = secretScan(`${fakeSk} ${fakeGh} ${fakeAkia} ${fakePem} auth.json`);
  assert.equal(r.length, 5);
  const joined = r.join("|");
  for (const f of [fakeSk, fakeGh, fakeAkia, fakePem, "auth.json"]) assert.ok(!joined.includes(f));
});

test("checkFeedback redacts every brief-scan pattern in commands and output, with repeated matches", () => {
  const secrets = [fakeSk, fakeGh, fakeAkia, fakePem, "auth.json"];
  const marker = (text) => text.match(/\[redacted\]/g).length;
  // sk / gh / akia in the output are replaced in place; pem / authjson in the output withhold the whole output
  const inplace = checkFeedback([{ cmd: secrets.join(" "), exit: 1, tail: [fakeSk, fakeGh, fakeAkia, fakeSk, fakeGh, fakeAkia].join("\n") }]);
  assert.deepEqual(secretScan(inplace), []);
  assert.equal(marker(inplace), 5 + 6);
  for (const secret of secrets) assert.equal(inplace.includes(secret), false);
  const withheld = checkFeedback([{ cmd: secrets.join(" "), exit: 1, tail: secrets.concat(secrets).join("\n") }]);
  assert.deepEqual(secretScan(withheld), []);
  assert.equal(marker(withheld), 5);
  assert.ok(withheld.includes("[redacted: output withheld, matched pem, authjson]"));
});

test("checkFeedback withholds the whole output when a PEM block or an auth.json dump is in it", () => {
  const body = "FAKEKEYBODY0123456789abcdef";
  const pem = checkFeedback([{ cmd: "c", exit: 1, tail: `before\n${fakePem}-----\n${body}\n-----END PRIVATE KEY-----\nafter` }]);
  assert.equal(pem.includes(body), false);
  assert.equal(pem.includes("before"), false);
  assert.ok(pem.includes("Output:\n[redacted: output withheld, matched pem]\n"));
  const tok = "FAKEREFRESHTOKEN0123";
  const auth = checkFeedback([{ cmd: "c", exit: 1, tail: `cat auth.json\n{"id_token":"FAKEIDTOKEN","refresh_token":"${tok}"}` }]);
  assert.equal(auth.includes(tok), false);
  assert.equal(auth.includes("FAKEIDTOKEN"), false);
  assert.ok(auth.includes("Output:\n[redacted: output withheld, matched authjson]\n"));
  // another failing check without a hit keeps its output
  const two = checkFeedback([{ cmd: "a", exit: 1, tail: `${fakePem}\nx` }, { cmd: "b", exit: 1, tail: "plain output" }]);
  assert.ok(two.includes("Output:\nplain output"));
});

test("checkFeedback withholds a check flagged withhold", () => {
  const text = checkFeedback([
    { cmd: "flagged", exit: 1, tail: "FAKEBODY_AFTER_MARKER", withhold: true },
    { cmd: "plain", exit: 1, tail: "ordinary output", withhold: false },
    { cmd: "timeout", exit: null, timeout: true, tail: "FAKE_TIMEOUT_BODY", withhold: true },
  ]);
  assert.equal(text.includes("FAKEBODY_AFTER_MARKER"), false);
  assert.equal(text.includes("FAKE_TIMEOUT_BODY"), false);
  assert.match(text, /Output:\n\[redacted: output withheld/);
  assert.ok(text.includes("Output:\nordinary output"));
});

test("the pem END marker withholds in feedback only (secretScan unchanged)", () => {
  const end = "-----" + "END";
  const tail = `FAKEBODY_BEFORE_END\n${end} PRIVATE KEY-----\nafter`;
  assert.deepEqual(secretScan(tail), []);
  const text = checkFeedback([{ cmd: "c", exit: 1, tail }]);
  assert.equal(text.includes("FAKEBODY_BEFORE_END"), false);
  assert.equal(text.includes(end), false);
  assert.ok(text.includes("[redacted: output withheld, matched pem]"));
  const nearMiss = checkFeedback([{ cmd: "c", exit: 1, tail: "----END ordinary output" }]);
  assert.ok(nearMiss.includes("----END ordinary output"));
});

test("checkFeedback drops the first partial line of a tail cut to 3000 characters", () => {
  const fragment = "a".repeat(18) + "SPLITTOKENTAIL";
  const rest = ("line-ok\n").repeat(Math.floor((3000 - fragment.length - 1) / 8));
  let tail = fragment + "\n" + rest;
  tail = tail + "z".repeat(3000 - tail.length);
  assert.equal(tail.length, 3000);
  const text = checkFeedback([{ cmd: "c", exit: 1, tail }]);
  assert.equal(text.includes("SPLITTOKENTAIL"), false);
  assert.ok(text.includes("line-ok"));
  // a single cut line has nothing safe to keep
  assert.equal(checkFeedback([{ cmd: "c", exit: 1, tail: "q".repeat(3000) }]).includes("qqqq"), false);
});

test("checkFeedback includes only failures and timeouts, preserving the last 3000 characters", () => {
  const text = checkFeedback([
    { cmd: "passing", exit: 0, tail: "omit passing output" },
    { cmd: "failing", exit: 2, tail: "omit prefix" + "x".repeat(2000) + "\n" + "x".repeat(996) + "end" },
    { cmd: "timed out", exit: null, timeout: true, tail: "timeout output" },
  ]);
  assert.equal(text.includes("passing"), false);
  assert.equal(text.includes("omit prefix"), false);
  assert.ok(text.includes("x".repeat(996) + "end"));
  assert.match(text, /Command: timed out\nResult: check-timeout\nOutput:\ntimeout output/);
});

test("the fallback rules keep the sandbox-only exception", () => {
  assert.match(FALLBACK_RULES, /only cannot run in the sandbox/);
  assert.match(FALLBACK_RULES, /not "done"/);
});

test("WORKER_ONLY equals claude/AGENTS.md:3-4 joined across the wrap", () => {
  const lines = agents.split(/\r?\n/);
  assert.equal(`${lines[2]} ${lines[3]}`, WORKER_ONLY);
  assert.equal(agents.split("dispatched as a worker").length - 1, 1);
});

test("workerRules extracts from the real AGENTS.md, LF and CRLF", () => {
  const lf = workerRules(agents.replace(/\r\n/g, "\n"));
  assert.equal(lf.fallback, false);
  assert.ok(lf.text.startsWith("## Worker rules"));
  assert.ok(lf.text.includes("No dispatching."));
  assert.ok(!lf.text.includes("## Toolkit"));
  const crlf = workerRules(agents.replace(/\r?\n/g, "\r\n"));
  assert.equal(crlf.fallback, false);
  assert.equal(crlf.text, lf.text);
});

test("a ### heading does not end the section; the next ## does", () => {
  const t = "# T\n\n## Worker rules\n- a\n### Sub\n- b\n\n## Toolkit\n- c\n";
  assert.equal(workerRules(t).text, "## Worker rules\n- a\n### Sub\n- b");
});

test("an HTML comment before ## Worker rules is not extracted", () => {
  const t = "intro\n<!-- controller-only note -->\nController line.\n\n## Worker rules\n- keep\n\n## Next\n- no\n";
  const r = workerRules(t);
  assert.ok(!r.text.includes("<!--"));
  assert.ok(!r.text.includes("Controller line"));
  assert.equal(r.text, "## Worker rules\n- keep");
});

test("fallback when heading missing or section empty", () => {
  assert.deepEqual(workerRules("# x\n## Other\n- a\n"), { text: FALLBACK_RULES, fallback: true });
  assert.equal(workerRules("## Worker rules\n\n## Next\n").fallback, true);
  assert.equal(workerRules(undefined).fallback, true);
  const n = FALLBACK_RULES.split("\n").length;
  assert.ok(n >= 8 && n <= 12);
});

test("finalizeBrief replaces the placeholder and prefixes WORKER_ONLY", () => {
  const brief = "# Task 1: x\nFiles you own: a.mjs.\nWorker rules: {{WORKER_RULES}}\n";
  const f = finalizeBrief(brief, agents);
  assert.equal(f.workerRules, "agents");
  assert.ok(!f.text.includes("{{WORKER_RULES}}"));
  assert.ok(f.text.includes(`${WORKER_ONLY}\nWorker rules:\n## Worker rules\n`));
  const g = finalizeBrief(brief, "no rules here");
  assert.equal(g.workerRules, "fallback");
  assert.ok(g.text.includes(FALLBACK_RULES));
});

test("finalizeBrief appends when the placeholder is absent", () => {
  const f = finalizeBrief("# Task 2\nFiles you own: a.", agents);
  assert.ok(f.text.startsWith("# Task 2\nFiles you own: a.\n"));
  assert.ok(f.text.includes(`${WORKER_ONLY}\nWorker rules:\n`));
});

test("80-line limit applies to the raw brief, before insertion", () => {
  const mk = (n) => Array.from({ length: n - 1 }, (_, i) => `l${i}`).join("\n") + "\nFiles you own: a.";
  assert.equal(parseBrief(mk(80), "write").ok, true);
  assert.deepEqual(parseBrief(mk(81), "write"), { ok: false, reason: "brief-invalid: too long" });
  // the finalized text is far over 80 lines yet the raw brief passed
  assert.ok(finalizeBrief(mk(80), agents).text.split("\n").length > 80);
});

test("secretScan runs on the finalized text: a secret in the inserted rules is caught", () => {
  const poisoned = `## Worker rules\n- do not use ${fakeSk}\n`;
  const raw = "# T\nFiles you own: a.\nWorker rules: {{WORKER_RULES}}\n";
  assert.deepEqual(secretScan(raw), []);
  assert.deepEqual(secretScan(finalizeBrief(raw, poisoned).text), ["sk"]);
});

test("parseBrief: owned-file grammar", () => {
  const p = (l, m = "write") => parseBrief(`# T\n${l}\nDo not create or edit anything else.\n`, m);
  assert.deepEqual(p("Files you own: lib/brief.mjs, tests/brief.test.mjs.").owned, ["lib/brief.mjs", "tests/brief.test.mjs"]);
  assert.deepEqual(p("Files you own: lib/**/*.mjs.").owned, ["lib/**/*.mjs"]);
  assert.deepEqual(p("Files you own: `a.mjs` `b.mjs`.").owned, ["a.mjs", "b.mjs"]);
  assert.deepEqual(p("Files you own: `dir with space/x.md`, y.md").owned, ["dir with space/x.md", "y.md"]);
  assert.deepEqual(p("Files you own: a.mjs b.mjs").owned, ["a.mjs", "b.mjs"]);
});

test("parseBrief: wrapped owned-files field reads continuation lines", () => {
  const b = "# T\nFiles you own: a/x.mjs, b/**/*.mjs,\n  c/y.md `d e/z.md`,\nlast.txt.\nDo not create or edit anything else.\nRead first: none\n";
  assert.deepEqual(parseBrief(b, "write").owned, ["a/x.mjs", "b/**/*.mjs", "c/y.md", "d e/z.md", "last.txt"]);
  const c = "Files you own: a.mjs,\nb.mjs\nRead first: none\n\nprose.mjs\n";
  assert.deepEqual(parseBrief(c, "write").owned, ["a.mjs", "b.mjs"]);
  // marker-less prose directly after the field (no blank line) is read as part of it
  assert.deepEqual(parseBrief("Files you own: a.mjs\nsome prose\n", "write").owned, ["a.mjs", "some", "prose"]);
  assert.deepEqual(parseBrief("Files you own: a.mjs\n\nsome prose\n", "write").owned, ["a.mjs"]);
});

test("parseBrief: missing owned files", () => {
  assert.deepEqual(parseBrief("# T\nGoal: x\n", "write"), { ok: false, reason: "brief-invalid: no owned files" });
  assert.deepEqual(parseBrief("# T\nFiles you own:\n", "write"), { ok: false, reason: "brief-invalid: no owned files" });
  assert.equal(parseBrief("# T\nGoal: x\n", "review").ok, true);
});

test("the template's own Files you own line parses; fields in order", () => {
  const r = parseBrief(template, "write");
  assert.equal(r.ok, true);
  assert.deepEqual(r.owned, ["<paths/globs>"]);
  const keys = ["# Task", "Goal:", "Files you own:", "Do not create or edit anything else.", "Read first:",
    "Builds on:", "Done when:", "Constraints:", "Worker rules: {{WORKER_RULES}}"];
  const idx = keys.map((k) => template.indexOf(k));
  assert.ok(idx.every((i) => i >= 0));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  assert.ok(template.split("\n").includes("Do not create or edit anything else."));
  assert.ok(template.includes(WORKER_ONLY));
  assert.match(template, /Windows process\/CIM\/window tests.*set status done.*unverified checks in the note; the host runs them after/);
  assert.deepEqual(secretScan(finalizeBrief(template, agents).text), []);
});

test("write.json is strict", () => {
  const s = JSON.parse(readFileSync(join(skillDir, "schemas", "write.json"), "utf8"));
  const walk = (o) => {
    if (o && o.type === "object") {
      assert.equal(o.additionalProperties, false);
      assert.deepEqual([...o.required].sort(), Object.keys(o.properties).sort());
      Object.values(o.properties).forEach(walk);
    }
    if (o && o.type === "array") walk(o.items);
  };
  walk(s);
  assert.deepEqual(s.properties.status.enum, ["done", "failed", "blocked"]);
  assert.deepEqual(s.properties.checks_run.items.properties.exit.type, ["integer", "null"]);
});
