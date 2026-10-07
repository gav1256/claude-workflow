import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { mcEnv, withEnv, importFresh, mkJunction, rmJunction } from "./mc-helpers.mjs";

async function inStore(fn) {
  const env = mcEnv();
  try {
    await withEnv(env, async () => {
      const store = await importFresh("store.mjs");
      const paths = await importFresh("paths.mjs");
      await fn({ store, paths, env, state: paths.stateDir() });
    });
  } finally { env.cleanup(); }
}

const K16 = "0123456789abcdef", K32 = K16 + K16;

test("M1 every allowlisted path writes", async () => {
  await inStore(({ store, state }) => {
    store.writeAtomic("coordinator_records.md", "x");
    store.writeAtomic("instance.json", "{}");
    for (const l of ["exchanges", "dispatch", "usage", "workers", "codex-attempts"]) store.appendJsonl(l, { a: 1 });
    assert.equal(store.writeNew("briefs/auth-01.md", "b"), true);
    assert.equal(store.writeNew(`messages/${K16}/${K32}.json`, "{}"), true);
    assert.equal(store.writeNew(`messages/${K16}/${K32}.delivered.json`, "{}"), true);
    fs.closeSync(store.openOut("codex-out/auth-01.out"));
    fs.closeSync(store.openOut("codex-out/auth-01.err"));
    assert.ok(fs.existsSync(path.join(state, "briefs", "auth-01.md")));
    assert.ok(fs.existsSync(path.join(state, "codex-out", "auth-01.out")));
    assert.ok(fs.existsSync(path.join(state, "codex-out", "auth-01.err")));
    store.rename("briefs/auth-01.md", "briefs/auth-02.md");
    assert.ok(fs.existsSync(path.join(state, "briefs", "auth-02.md")));
    assert.ok(!fs.existsSync(path.join(state, "briefs", "auth-01.md")));
    assert.ok(store.resolveAllowed("coordinator_records.md").endsWith("coordinator_records.md"));
  });
});

test("M1 bad paths are refused with StoreError", async () => {
  await inStore(({ store }) => {
    const bad = [
      "../x", "briefs/../../x.md", path.resolve(os.tmpdir(), "x.md"), "/etc/x", "src/a.ts",
      "coordinator_records.md/../x", "briefs\\a.md", "briefs/a.md\u0000", "", "./coordinator_records.md",
      "messages/zz/aa.json", `messages/${K16}/zz.json`, "briefs/A.md", "briefs/.md", "codex-out/a.txt", "nope.jsonl",
    ];
    for (const p of bad) assert.throws(() => store.resolveAllowed(p), store.StoreError, JSON.stringify(p));
    assert.throws(() => store.resolveAllowed(null), store.StoreError);
    assert.throws(() => store.appendJsonl("secrets", {}), store.StoreError);
    assert.throws(() => store.readJsonl("secrets"), store.StoreError);
    assert.throws(() => store.writeNew("briefs/../../x.md", "x"), store.StoreError);
  });
});

test("M2 a junction for briefs to an outside folder is refused, nothing written outside", async () => {
  await inStore(({ store, state }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-out-"));
    try {
      fs.mkdirSync(state, { recursive: true });
      mkJunction(path.join(state, "briefs"), outside);
      assert.throws(() => store.writeNew("briefs/a.md", "x"), store.StoreError);
      assert.throws(() => store.writeAtomic("briefs/a.md", "x"), store.StoreError);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally { rmJunction(path.join(state, "briefs")); fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("M2 a junction parent in a nested path (messages/<key>) is refused", async () => {
  await inStore(({ store, state }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-out-"));
    try {
      fs.mkdirSync(path.join(state, "messages"), { recursive: true });
      mkJunction(path.join(state, "messages", K16), outside);
      assert.throws(() => store.writeNew(`messages/${K16}/${K32}.json`, "x"), store.StoreError);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally { rmJunction(path.join(state, "messages", K16)); fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("M2 coordinator_records.md replaced by a file symlink is refused", async (t) => {
  await inStore(({ store, state }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-out-"));
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "keep");
    fs.mkdirSync(state, { recursive: true });
    try {
      try { fs.symlinkSync(target, path.join(state, "coordinator_records.md"), "file"); }
      catch (e) { t.skip(`cannot create symlinks here (${e.code})`); return; }
      assert.throws(() => store.writeRecords("hello"), store.StoreError);
      assert.throws(() => store.writeAtomic("coordinator_records.md", "hello"), store.StoreError);
      assert.equal(fs.readFileSync(target, "utf8"), "keep");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("M2 coordinator_records.md as a folder is refused", async () => {
  await inStore(({ store, state }) => {
    fs.mkdirSync(path.join(state, "coordinator_records.md"), { recursive: true });
    assert.throws(() => store.writeRecords("hello"), store.StoreError);
  });
});

test("M3 writeNew returns false on the second call and keeps the first content", async () => {
  await inStore(({ store, state }) => {
    assert.equal(store.writeNew("briefs/auth-01.md", "first"), true);
    assert.equal(store.writeNew("briefs/auth-01.md", "second"), false);
    assert.equal(fs.readFileSync(path.join(state, "briefs", "auth-01.md"), "utf8"), "first");
  });
});

test("M4 writeRecords refuses more than 16 KiB, accepts exactly 16 KiB", async () => {
  await inStore(({ store, state }) => {
    assert.throws(() => store.writeRecords("a".repeat(16385)), store.StoreError);
    assert.throws(() => store.writeRecords("\u00e9".repeat(8193)), store.StoreError); // 2 bytes each
    assert.throws(() => store.writeRecords(5), store.StoreError);
    store.writeRecords("a".repeat(16384));
    assert.equal(fs.statSync(path.join(state, "coordinator_records.md")).size, 16384);
    store.writeRecords("b");
    assert.equal(fs.readFileSync(path.join(state, "coordinator_records.md"), "utf8"), "b");
    assert.deepEqual(fs.readdirSync(state).filter((f) => f.endsWith(".tmp")), []);
  });
});

test("M5 readJsonl skips a torn last line and bad middle lines; missing ledger is empty", async () => {
  await inStore(({ store, state }) => {
    assert.deepEqual(store.readJsonl("workers"), []);
    store.appendJsonl("workers", { ev: "a" });
    store.appendJsonl("workers", { ev: "b" });
    fs.appendFileSync(path.join(state, "workers.jsonl"), 'garbage\n{"ev":"torn","x":');
    assert.deepEqual(store.readJsonl("workers"), [{ ev: "a" }, { ev: "b" }]);
  });
});

test("appendJsonl appends one line per call", async () => {
  await inStore(({ store, state }) => {
    store.appendJsonl("usage", { n: 1 }); store.appendJsonl("usage", { n: 2 });
    assert.equal(fs.readFileSync(path.join(state, "usage.jsonl"), "utf8"), '{"n":1}\n{"n":2}\n');
  });
});

test("paths: stateDir/secretsDir follow CLAUDE_CONFIG_DIR at call time; msgKey is sha1 16", async () => {
  const env = mcEnv();
  try {
    await withEnv(env, async () => {
      const p = await importFresh("paths.mjs");
      assert.equal(p.cfgDir(), env.CLAUDE_CONFIG_DIR);
      assert.equal(p.stateDir(), path.join(env.CLAUDE_CONFIG_DIR, "state", "model-coordinator"));
      assert.equal(p.secretsDir(), path.join(env.CLAUDE_CONFIG_DIR, "secrets"));
      process.env.CLAUDE_CONFIG_DIR = path.join(env.root, "other");
      assert.equal(p.cfgDir(), path.join(env.root, "other"));
      assert.match(p.msgKey("auth-01"), /^[0-9a-f]{16}$/);
      assert.notEqual(p.msgKey("a"), p.msgKey("b"));
      assert.equal(path.basename(p.HL_DIR), "handoff-launch");
      process.env.MC_CODEX_SKILL_DIR = path.join(env.root, "cx");
      assert.equal(p.codexSkillDir(), path.join(env.root, "cx"));
      delete process.env.MC_CODEX_SKILL_DIR;
      const d = p.codexSkillDir();
      assert.ok(d === null || fs.existsSync(d));
    });
  } finally { env.cleanup(); }
});
