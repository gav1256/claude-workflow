import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpEnv, makeRepo, addWorktree, scenario, rmrf, FAKE_CODEX } from "./helpers.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true }).trim();

test("rmrf retries a busy directory and gives up after the bound", () => {
  let elapsed = 0;
  let calls = 0;
  let last;
  const codes = ["EPERM", "EBUSY", "ENOTEMPTY"];
  const clock = { now: () => elapsed, sleep: (ms) => { elapsed += ms; } };
  const rm = (p, options) => {
    assert.equal(p, "fake-temp-dir");
    assert.deepEqual(options, { recursive: true, force: true });
    last = Object.assign(new Error("busy"), { code: codes[calls++ % codes.length] });
    throw last;
  };
  assert.throws(() => rmrf("fake-temp-dir", { rm, ...clock }), (e) => e === last);
  assert.equal(elapsed, 10000);
  assert.ok(calls > 5);
  for (const code of codes) {
    calls = 0;
    elapsed = 0;
    rmrf("fake-temp-dir", { ...clock, rm: () => {
      if (++calls < 4) throw Object.assign(new Error("busy"), { code });
    } });
    assert.equal(calls, 4);
    assert.ok(elapsed > 0 && elapsed < 10000);
  }
  elapsed = 0;
  const other = Object.assign(new Error("other"), { code: "EINVAL" });
  assert.throws(() => rmrf("fake-temp-dir", { ...clock, rm: () => { throw other; } }), (e) => e === other);
  assert.equal(elapsed, 0);
});

test("tmpEnv: every override points into one temp root, nothing at the real config", () => {
  const env = tmpEnv();
  try {
    const root = env.root;
    for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HL_REGISTRY_DIR", "CODEX_RUN_TEMP", "FAKE_CODEX_SCENARIO"]) {
      assert.ok(env[k].startsWith(root), `${k}=${env[k]}`);
    }
    assert.equal(env.CODEX_RUN_BIN, process.execPath);
    assert.deepEqual(JSON.parse(env.CODEX_RUN_BIN_ARGS), [FAKE_CODEX]);
    assert.match(env.CODEX_RUN_PIPE_PREFIX, /^codex-run-test-\d+-\d+-$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.FAKE_CODEX_SCENARIO, "utf8")), {});
    assert.equal(env.HL_SESSION_ID, undefined);
    assert.ok(fs.statSync(env.HL_REGISTRY_DIR).isDirectory());
    assert.ok(!Object.keys({ ...env }).includes("root"));
    const other = tmpEnv();
    try { assert.notEqual(other.CODEX_RUN_PIPE_PREFIX, env.CODEX_RUN_PIPE_PREFIX); } finally { other.cleanup(); }
  } finally { env.cleanup(); }
  assert.ok(!fs.existsSync(env.root));
});

test("tmpEnv: extra overrides win; inherited lane variables are removed", () => {
  const saved = process.env.HL_SESSION_ID;
  process.env.HL_SESSION_ID = "lane-x";
  const env = tmpEnv({ CODEX_RUN_TIMEOUT_MS: "5" });
  try {
    assert.equal(env.CODEX_RUN_TIMEOUT_MS, "5");
    assert.equal(env.HL_SESSION_ID, undefined);
  } finally {
    env.cleanup();
    if (saved === undefined) delete process.env.HL_SESSION_ID; else process.env.HL_SESSION_ID = saved;
  }
});

test("makeRepo: a git repo with exactly one commit by test@example.com", () => {
  const repo = makeRepo();
  try {
    assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1");
    assert.equal(git(repo, "log", "-1", "--format=%ae"), "test@example.com");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(git(repo, "branch", "--show-current"), "main");
  } finally { rmrf(path.dirname(repo)); }
});

test("addWorktree: a linked worktree whose path contains a space", () => {
  const repo = makeRepo();
  try {
    const wt = addWorktree(repo, "lane1");
    assert.ok(wt.includes(" "));
    assert.ok(fs.statSync(path.join(wt, ".git")).isFile(), "linked worktree has a .git file");
    assert.equal(git(wt, "branch", "--show-current"), "lane1");
    assert.equal(git(wt, "status", "--porcelain"), "");
    assert.ok(git(repo, "worktree", "list").includes("lane1"));
  } finally { rmrf(path.dirname(repo)); }
});

test("scenario: writes the JSON and, with env, points FAKE_CODEX_SCENARIO at it", () => {
  const env = tmpEnv();
  try {
    const f = scenario({ exit: 3, writes: [] }, env);
    assert.equal(env.FAKE_CODEX_SCENARIO, f);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { exit: 3, writes: [] });
    const g = scenario({ a: 1 });
    try { assert.deepEqual(JSON.parse(fs.readFileSync(g, "utf8")), { a: 1 }); } finally { rmrf(path.dirname(g)); }
  } finally { env.cleanup(); }
});
