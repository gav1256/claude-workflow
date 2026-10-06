import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpEnv, rmrf } from "./helpers.mjs";

const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = env.CODEX_HOME;
const P = await import("../lib/paths.mjs");
const { verdictCmd } = await import("../lib/verdict.mjs");
assert.equal(P.LEDGER.startsWith(env.root), true, "ledger must be inside the temp root");
after(() => env.cleanup());

beforeEach(() => rmrf(P.STATE));

const lines = () => fs.readFileSync(P.LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const seedRun = (id) => {
  fs.mkdirSync(P.STATE, { recursive: true });
  fs.appendFileSync(P.LEDGER, JSON.stringify({ ts: "t", run_id: id, status: "done" }) + "\n");
};

test("run id with a run line appends {ts, run_id, verdict, note}", () => {
  seedRun("r1");
  const r = verdictCmd(["--verdict", "r1", "approve", "looks good"]);
  assert.equal(r.ok, true);
  const last = lines().at(-1);
  assert.deepEqual(Object.keys(last), ["ts", "run_id", "verdict", "note"]);
  assert.equal(last.run_id, "r1");
  assert.equal(last.verdict, "approve");
  assert.equal(last.note, "looks good");
  assert.ok(Number.isFinite(Date.parse(last.ts)));
});

test("unknown run, and a missing ledger, are blocked: unknown-run", () => {
  assert.deepEqual(verdictCmd(["--verdict", "nope", "reject", "x"]), { ok: false, status: "blocked", reason: "unknown-run" });
  assert.equal(fs.existsSync(P.LEDGER), false);
  seedRun("other");
  assert.equal(verdictCmd(["--verdict", "nope", "reject", "x"]).reason, "unknown-run");
  assert.equal(lines().length, 1);
});

test("a verdict line alone does not make a run id known", () => {
  seedRun("r1");
  verdictCmd(["--verdict", "r1", "rework", "a"]);
  fs.writeFileSync(P.LEDGER, fs.readFileSync(P.LEDGER, "utf8").split("\n").slice(1).join("\n"));
  assert.equal(verdictCmd(["--verdict", "r1", "approve", "b"]).reason, "unknown-run");
});

test("sonnet:<task> appends the writer line, also with no ledger yet", () => {
  const r = verdictCmd(["--verdict", "sonnet:t16", "rework", "needs tests"]);
  assert.equal(r.ok, true);
  const last = lines().at(-1);
  assert.deepEqual(Object.keys(last), ["ts", "run_id", "task", "writer", "verdict", "note"]);
  assert.equal(last.run_id, null);
  assert.equal(last.task, "t16");
  assert.equal(last.writer, "sonnet");
  assert.equal(last.verdict, "rework");
});

test("bad verdict word is blocked: bad-verdict and writes nothing", () => {
  seedRun("r1");
  assert.deepEqual(verdictCmd(["--verdict", "r1", "maybe", "x"]), { ok: false, status: "blocked", reason: "bad-verdict" });
  assert.equal(verdictCmd(["--verdict", "sonnet:a", "APPROVE", "x"]).reason, "bad-verdict");
  assert.equal(lines().length, 1);
});

test("missing arguments are blocked: bad-args", () => {
  assert.equal(verdictCmd(["--verdict"]).reason, "bad-args");
  assert.equal(verdictCmd(["--verdict", "r1"]).reason, "bad-args");
  assert.equal(verdictCmd(["--verdict", "sonnet:", "approve", "x"]).reason, "bad-args");
});

test("note with quotes survives, is trimmed, and is cut to 200 chars; extra words join", () => {
  seedRun("r1");
  verdictCmd(["--verdict", "r1", "approve", `  said "ok" and 'fine'  `]);
  assert.equal(lines().at(-1).note, `said "ok" and 'fine'`);
  verdictCmd(["--verdict", "r1", "approve", "x".repeat(500)]);
  assert.equal(lines().at(-1).note.length, 200);
  verdictCmd(["--verdict", "r1", "approve", "two", "words"]);
  assert.equal(lines().at(-1).note, "two words");
  verdictCmd(["--verdict", "r1", "approve"]);
  assert.equal(lines().at(-1).note, "");
});

test("flags before --verdict in argv are ignored", () => {
  seedRun("r1");
  assert.equal(verdictCmd(["--cwd", "x", "--verdict", "r1", "approve", "n"]).ok, true);
});
