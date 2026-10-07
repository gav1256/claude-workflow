import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveCodex, codexVersion, versionAtLeast } from "../lib/binary.mjs";
import { tmpEnv, scenario, FAKE_CODEX, rmrf } from "./helpers.mjs";

const PLATFORM = "@openai/codex-win32-x64";
const EXE_REL = ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"];

function writePkg(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.160.0" }));
}

// <root>/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/.../codex.exe  (the real nested layout)
function nestedRoot(base) {
  // the root's folder is not called node_modules, so nothing resolves "from the root itself"
  const root = path.join(base, "npm root");
  writePkg(path.join(root, "@openai", "codex"), "@openai/codex");
  fs.mkdirSync(path.join(root, "@openai", "codex", "bin"), { recursive: true });
  const plat = path.join(root, "@openai", "codex", "node_modules", PLATFORM);
  writePkg(plat, PLATFORM);
  const exe = path.join(plat, ...EXE_REL);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "");
  return { root, exe };
}

test("resolveCodex: CODEX_RUN_BIN wins, with args from CODEX_RUN_BIN_ARGS", () => {
  const r = resolveCodex({ CODEX_RUN_BIN: "C:\\x\\node.exe", CODEX_RUN_BIN_ARGS: JSON.stringify(["a b.mjs", "--flag"]) });
  assert.deepEqual(r, { cmd: "C:\\x\\node.exe", args: ["a b.mjs", "--flag"] });
  assert.deepEqual(resolveCodex({ CODEX_RUN_BIN: "c.exe" }), { cmd: "c.exe", args: [] });
  assert.throws(() => resolveCodex({ CODEX_RUN_BIN: "c.exe", CODEX_RUN_BIN_ARGS: "not json" }), /CODEX_RUN_BIN_ARGS/);
  assert.throws(() => resolveCodex({ CODEX_RUN_BIN: "c.exe", CODEX_RUN_BIN_ARGS: '"x"' }), /CODEX_RUN_BIN_ARGS/);
});

test("resolveCodex: the nested platform package layout resolves to the native codex.exe", () => {
  const env = tmpEnv();
  try {
    const { root, exe } = nestedRoot(env.root);
    const r = resolveCodex({ CODEX_RUN_NPM_ROOT: root });
    assert.deepEqual(r, { cmd: exe, args: [] });
    // resolving from the npm root itself fails: the platform package is nested (spec:255)
    const fromRoot = createRequire(path.join(root, "x.js"));
    assert.throws(() => fromRoot.resolve(`${PLATFORM}/package.json`), { code: "MODULE_NOT_FOUND" });
  } finally { env.cleanup(); }
});

test("resolveCodex: the flat layout (platform package beside @openai/codex) fails with MODULE_NOT_FOUND", () => {
  const env = tmpEnv();
  try {
    const root = path.join(env.root, "flat root");
    writePkg(path.join(root, "@openai", "codex"), "@openai/codex");
    writePkg(path.join(root, PLATFORM), PLATFORM);
    assert.throws(() => resolveCodex({ CODEX_RUN_NPM_ROOT: root }), { code: "MODULE_NOT_FOUND" });
  } finally { env.cleanup(); }
});

test("resolveCodex reads process.env by default", () => {
  const env = tmpEnv();
  const saved = { b: process.env.CODEX_RUN_BIN, a: process.env.CODEX_RUN_BIN_ARGS };
  try {
    process.env.CODEX_RUN_BIN = env.CODEX_RUN_BIN;
    process.env.CODEX_RUN_BIN_ARGS = env.CODEX_RUN_BIN_ARGS;
    assert.deepEqual(resolveCodex(), { cmd: process.execPath, args: [FAKE_CODEX] });
  } finally {
    for (const [k, v] of [["CODEX_RUN_BIN", saved.b], ["CODEX_RUN_BIN_ARGS", saved.a]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    env.cleanup();
  }
});

test("codexVersion reads the version from `--version` of the fake", () => {
  const env = tmpEnv();
  try {
    assert.equal(codexVersion(resolveCodex(env), env), "0.160.0");
    scenario({ version: "0.161.2" }, env);
    assert.equal(codexVersion(resolveCodex(env), env), "0.161.2");
    // a bare executable string works too
    assert.equal(codexVersion({ cmd: process.execPath, args: [FAKE_CODEX] }, env), "0.161.2");
  } finally { env.cleanup(); }
});

test("codexVersion throws when the output has no version", () => {
  const env = tmpEnv();
  try {
    scenario({ version: "garbage" }, env);
    assert.throws(() => codexVersion(resolveCodex(env), env), /version/);
  } finally { env.cleanup(); }
});

test("versionAtLeast", () => {
  assert.equal(versionAtLeast("0.160.0"), true);
  assert.equal(versionAtLeast("0.159.1"), true);
  assert.equal(versionAtLeast("0.159.0"), false);
  assert.equal(versionAtLeast("0.99.9"), false);
  assert.equal(versionAtLeast("1.0.0"), true);
  assert.equal(versionAtLeast("0.160.0-beta.1"), true);
  assert.equal(versionAtLeast("0.158.9", "0.158.9"), true);
  assert.equal(versionAtLeast("0.158.8", "0.158.9"), false);
  assert.equal(versionAtLeast("0.1000.0", "0.999.0"), true, "numeric, not lexical");
  assert.equal(versionAtLeast("garbage"), false);
  assert.equal(versionAtLeast(undefined), false);
  assert.equal(versionAtLeast(""), false);
});
