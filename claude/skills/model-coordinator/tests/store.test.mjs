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
    fs.closeSync(store.openOut("codex-out/auth-01.out"));
    fs.closeSync(store.openOut("codex-out/auth-01.err"));
    assert.ok(fs.existsSync(path.join(state, "briefs", "auth-01.md")));
    assert.ok(fs.existsSync(path.join(state, "codex-out", "auth-01.out")));
    assert.ok(fs.existsSync(path.join(state, "codex-out", "auth-01.err")));
    store.rename(`messages/${K16}/${K32}.json`, `messages/${K16}/${K32}.delivered.json`);
    assert.ok(fs.existsSync(path.join(state, "messages", K16, `${K32}.delivered.json`)));
    assert.ok(!fs.existsSync(path.join(state, "messages", K16, `${K32}.json`)));
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

test("M2 a junction for briefs to an outside folder is refused, nothing written outside", { skip: process.platform !== "win32" }, async () => {
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

test("M2 a junction parent in a nested path (messages/<key>) is refused", { skip: process.platform !== "win32" }, async () => {
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

// ---- Task 6 review fixes ----

test("F2 append after a torn line starts a fresh line: both created events survive, ids stay unique", async () => {
  const { foldWorkers, nextWorkerId } = await import("../workers.mjs");
  await inStore(({ store, state }) => {
    store.appendJsonl("workers", { ev: "created", id: "auth-01" });
    fs.appendFileSync(path.join(state, "workers.jsonl"), '{"ev":"torn","x":');
    store.appendJsonl("workers", { ev: "created", id: "auth-02" });
    const lines = store.readJsonl("workers");
    assert.deepEqual(lines.filter((l) => l.ev === "created").map((l) => l.id), ["auth-01", "auth-02"]);
    assert.equal(nextWorkerId("auth", foldWorkers(lines)), "auth-03");
    store.appendJsonl("usage", { n: 1 }); // a clean file gets no blank line
    store.appendJsonl("usage", { n: 2 });
    assert.equal(fs.readFileSync(path.join(state, "usage.jsonl"), "utf8"), '{"n":1}\n{"n":2}\n');
  });
});

test("F3 writeNew leaves complete content, no temp file, and EEXIST keeps the first content", async () => {
  await inStore(({ store, state }) => {
    const f = path.join(state, "briefs", "auth-01.md");
    assert.equal(store.writeNew("briefs/auth-01.md", "first content"), true);
    assert.equal(fs.readFileSync(f, "utf8"), "first content");
    assert.deepEqual(fs.readdirSync(path.join(state, "briefs")), ["auth-01.md"]);
    assert.equal(fs.statSync(f).nlink, 1);
    assert.equal(store.writeNew("briefs/auth-01.md", "second"), false);
    assert.equal(fs.readFileSync(f, "utf8"), "first content");
    assert.deepEqual(fs.readdirSync(path.join(state, "briefs")), ["auth-01.md"]);
  });
});

test("F3 the name appears only after the content is complete (linked from a finished temp file)", async () => {
  await inStore(({ store, state }) => {
    const seen = [];
    const real = fs.linkSync;
    fs.linkSync = (a, b) => { seen.push(fs.readFileSync(a, "utf8")); return real(a, b); };
    try { store.writeNew("briefs/auth-01.md", "full"); } finally { fs.linkSync = real; }
    assert.deepEqual(seen, ["full"]);
    assert.equal(fs.readFileSync(path.join(state, "briefs", "auth-01.md"), "utf8"), "full");
  });
});

test("F4 readJsonl refuses a planted link and rethrows errors other than ENOENT", async () => {
  await inStore(({ store, state }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-out-"));
    try {
      const victim = path.join(outside, "v.jsonl");
      fs.writeFileSync(victim, '{"ev":"x"}\n');
      fs.mkdirSync(state, { recursive: true });
      fs.linkSync(victim, path.join(state, "usage.jsonl")); // hard link
      assert.throws(() => store.readJsonl("usage"), store.StoreError);
      fs.mkdirSync(path.join(state, "workers.jsonl")); // a folder where the ledger should be
      assert.throws(() => store.readJsonl("workers"));
      assert.deepEqual(store.readJsonl("dispatch"), []); // missing is still empty
      let linked = false;
      try { fs.symlinkSync(victim, path.join(state, "exchanges.jsonl"), "file"); linked = true; } catch { /* no symlink privilege here */ }
      if (linked) assert.throws(() => store.readJsonl("exchanges"), store.StoreError);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("F5 mkdir racing another creator (EEXIST) is tolerated", async () => {
  await inStore(({ store, state }) => {
    const real = fs.mkdirSync;
    fs.mkdirSync = (p, o) => {
      if (String(p).endsWith(`${path.sep}briefs`)) { real(p); const e = new Error("exists"); e.code = "EEXIST"; throw e; }
      return real(p, o);
    };
    try { assert.equal(store.writeNew("briefs/auth-01.md", "x"), true); } finally { fs.mkdirSync = real; }
    assert.ok(fs.existsSync(path.join(state, "briefs", "auth-01.md")));
  });
});

test("F5 a junction planted during the mkdir race is refused", { skip: process.platform !== "win32" }, async () => {
  await inStore(({ store, state }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-out-"));
    const real = fs.mkdirSync;
    fs.mkdirSync = (p, o) => {
      if (String(p).endsWith(`${path.sep}briefs`)) { mkJunction(p, outside); const e = new Error("exists"); e.code = "EEXIST"; throw e; }
      return real(p, o);
    };
    try {
      assert.throws(() => store.writeNew("briefs/a.md", "x"), store.StoreError);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally { fs.mkdirSync = real; rmJunction(path.join(state, "briefs")); fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("F6 a hard-linked target is refused on writes", async () => {
  await inStore(({ store, state }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-out-"));
    try {
      const victim = path.join(outside, "v.txt");
      fs.writeFileSync(victim, "keep");
      fs.mkdirSync(path.join(state, "codex-out"), { recursive: true });
      fs.linkSync(victim, path.join(state, "instance.json"));
      fs.linkSync(victim, path.join(state, "codex-out", "a.out"));
      assert.throws(() => store.writeAtomic("instance.json", "x"), store.StoreError);
      assert.throws(() => store.resolveAllowed("instance.json"), store.StoreError);
      assert.throws(() => store.openOut("codex-out/a.out"), store.StoreError);
      assert.equal(fs.readFileSync(victim, "utf8"), "keep");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("F7 Windows device names are refused as the base name, any case, with or without extension", async () => {
  await inStore(({ store }) => {
    for (const p of ["briefs/con.md", "briefs/nul.md", "briefs/aux.md", "briefs/prn.md", "briefs/com1.md", "briefs/lpt9.md", "briefs/con.a.md",
      "codex-out/nul.out", "codex-out/con.err", "codex-out/COM3.out", "codex-out/lpt1.err"]) {
      assert.throws(() => store.resolveAllowed(p), store.StoreError, p);
    }
    store.resolveAllowed("briefs/console.md"); // not a device name
    store.resolveAllowed("briefs/com10.md");
    store.resolveAllowed("codex-out/auth-01.out");
  });
});

test("F8 rename only allows <rid>.json to <rid>.delivered.json in the same messages folder", async () => {
  await inStore(({ store, state }) => {
    store.writeNew("briefs/x.md", "b");
    store.writeAtomic("coordinator_records.md", "keep");
    assert.throws(() => store.rename("briefs/x.md", "coordinator_records.md"), store.StoreError);
    assert.throws(() => store.rename("briefs/x.md", "briefs/y.md"), store.StoreError);
    const K16b = "fedcba9876543210", K32b = K16b + K16b;
    store.writeNew(`messages/${K16}/${K32}.json`, "{}");
    store.writeNew(`messages/${K16b}/${K32b}.json`, "{}");
    assert.throws(() => store.rename(`messages/${K16}/${K32}.json`, `messages/${K16b}/${K32}.delivered.json`), store.StoreError);
    assert.throws(() => store.rename(`messages/${K16}/${K32}.json`, `messages/${K16}/${K32b}.delivered.json`), store.StoreError);
    assert.throws(() => store.rename(`messages/${K16}/${K32}.delivered.json`, `messages/${K16}/${K32}.json`), store.StoreError);
    assert.equal(fs.readFileSync(path.join(state, "coordinator_records.md"), "utf8"), "keep");
    store.rename(`messages/${K16}/${K32}.json`, `messages/${K16}/${K32}.delivered.json`);
    assert.ok(fs.existsSync(path.join(state, "messages", K16, `${K32}.delivered.json`)));
  });
});
