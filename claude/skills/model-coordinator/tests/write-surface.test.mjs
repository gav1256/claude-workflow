import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_DIR } from "./mc-helpers.mjs";

// M6 guard: an IMPORT ALLOWLIST. Outside store.mjs (matched by path relative to the skill folder) a source file may
// import `fs` only as named read functions, and may not reach the file system any other way.
const EXEMPT = new Set(["store.mjs"]);
const FS_READ = new Set(["existsSync", "readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync"]);
const FS_MODS = new Set(["fs", "node:fs"]);
const FS_PROMISES = new Set(["fs/promises", "node:fs/promises"]);
const CHILD = new Set(["child_process", "node:child_process"]);

function checkSpecifier(spec, clause, found) {
  if (FS_PROMISES.has(spec)) found.push(`imports ${spec}`);
  else if (CHILD.has(spec)) found.push(`imports ${spec}`);
  else if (FS_MODS.has(spec) && clause !== null) {
    const c = clause.trim();
    const m = /^\{([^}]*)\}$/.exec(c);
    if (!m) { found.push(`non-named import of ${spec}: ${c}`); return; }
    for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const name = part.split(/\s+as\s+/)[0].trim();
      if (!FS_READ.has(name)) found.push(`imports ${name} from ${spec}`);
    }
  }
}

/** Returns the list of violations in one source text (empty when it only reads). */
export function scanSource(text) {
  const found = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+([^"';]*?)\s*\bfrom\s*["']([^"']+)["']/g)) checkSpecifier(m[2], m[1], found);
  for (const m of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) checkSpecifier(m[1], null, found);
  for (const m of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const lit = /^\s*["']([^"']*)["']\s*$/.exec(m[1]);
    if (!lit) found.push(`import() with a non-literal argument: ${m[1].trim()}`);
    else if (FS_MODS.has(lit[1]) || FS_PROMISES.has(lit[1]) || CHILD.has(lit[1])) found.push(`import() of ${lit[1]}`);
  }
  if (/\bcreateRequire\b/.test(text)) found.push("createRequire");
  if (/\bprocess\s*(?:\?\.|\.|\[)\s*["']?(?:binding|dlopen|getBuiltinModule)\b/.test(text)) found.push("process.binding/dlopen/getBuiltinModule");
  if (/\bgetBuiltinModule\b/.test(text)) found.push("getBuiltinModule");
  if (/\brequire\s*\(/.test(text)) found.push("require(");
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) found.push("eval / new Function");
  return found;
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "tests" || e.name === "node_modules" ? [] : walk(p, base);
    return /\.(mjs|js|cjs)$/.test(e.name) ? [path.relative(base, p).split(path.sep).join("/")] : [];
  });
}

/** Scans every non-test source below `dir`; returns [{file, problems}] for the files that break the guard. */
export function scanTree(dir) {
  const files = walk(dir);
  return { files, bad: files.filter((f) => !EXEMPT.has(f)).map((f) => ({ file: f, problems: scanSource(fs.readFileSync(path.join(dir, f), "utf8")) })).filter((r) => r.problems.length) };
}

test("M6 the real tree only reads files outside store.mjs", () => {
  const { files, bad } = scanTree(SKILL_DIR);
  assert.ok(files.includes("store.mjs"), "scan must see store.mjs");
  assert.deepEqual(bad, []);
});

test("M6 guard flags every write API a reviewer probe slipped past the old denylist", () => {
  const cases = {
    "callback fs.rename": 'import fs from "fs"; fs.rename(a, b, cb);',
    "callback open w": 'import fs from "node:fs"; fs.open(p, "w", cb);',
    "callback write": 'import fs from "node:fs"; fs.write(fd, buf, cb);',
    "callback unlink": 'import fs from "node:fs"; fs.unlink(p, cb);',
    "callback rm": 'import fs from "node:fs"; fs.rm(p, cb);',
    "callback mkdir": 'import fs from "node:fs"; fs.mkdir(p, cb);',
    "callback copyFile": 'import fs from "node:fs"; fs.copyFile(a, b, cb);',
    "callback cp": 'import fs from "node:fs"; fs.cp(a, b, cb);',
    "callback symlink": 'import fs from "node:fs"; fs.symlink(a, b, cb);',
    writevSync: 'import fs from "node:fs"; fs.writevSync(fd, bufs);',
    ftruncateSync: 'import fs from "node:fs"; fs.ftruncateSync(fd);',
    mkdtempSync: 'import fs from "node:fs"; fs.mkdtempSync(p);',
    "named fs/promises": 'import { open } from "fs/promises"; await open(p, "w");',
    "node:fs/promises default": 'import fsp from "node:fs/promises";',
    "WriteStream": 'import fs from "node:fs"; new fs.WriteStream(p);',
    "namespace import": 'import * as fs from "node:fs"; fs.writeFileSync(p, "");',
    "default plus named": 'import fs, { readFileSync } from "node:fs";',
    "named write import": 'import { readFileSync, writeFileSync } from "node:fs";',
    "named write import aliased": 'import { writeFileSync as r } from "fs";',
    "multiline named write": 'import {\n  readFileSync,\n  rmSync,\n} from "node:fs";',
    "export from": 'export { writeFileSync } from "node:fs";',
    createRequire: 'import { createRequire } from "node:module"; const r = createRequire(import.meta.url);',
    "process.binding": 'process.binding("fs");',
    "process getBuiltinModule": 'process.getBuiltinModule("fs").writeFileSync(a, b);',
    "require(": 'const f = require("fs");',
    "dynamic import non-literal": "const m = await import(name);",
    "dynamic import template": "const m = await import(`node:${x}`);",
    "dynamic import of fs": 'const m = await import("node:fs");',
    "child_process": 'import { spawnSync } from "child_process";',
    "node:child_process": 'import cp from "node:child_process";',
  };
  for (const [name, src] of Object.entries(cases)) assert.ok(scanSource(src).length > 0, `not flagged: ${name}`);
});

test("M6 guard passes the allowed read-only imports", () => {
  for (const src of [
    'import { existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync } from "node:fs";',
    'import { readFileSync as rd } from "fs";',
    'import {\n  existsSync,\n  statSync,\n} from "node:fs";',
    'import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";',
    'import { StoreError } from "./store.mjs"; const m = await import("./x.mjs");',
    'import "./side.mjs";',
  ]) assert.deepEqual(scanSource(src), [], src);
});

test("M6 guard scans a folder by relative path: only the top-level store.mjs is exempt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ws-"));
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.mkdirSync(path.join(dir, "tests"));
    fs.writeFileSync(path.join(dir, "store.mjs"), 'import fs from "node:fs"; fs.writeFileSync(a, b);');
    fs.writeFileSync(path.join(dir, "sub", "store.mjs"), 'import fs from "node:fs";');
    fs.writeFileSync(path.join(dir, "ok.js"), 'import { readFileSync } from "node:fs";');
    fs.writeFileSync(path.join(dir, "bad.cjs"), 'const f = require("fs");');
    fs.writeFileSync(path.join(dir, "tests", "t.mjs"), 'import fs from "node:fs";');
    const { files, bad } = scanTree(dir);
    assert.deepEqual(files.sort(), ["bad.cjs", "ok.js", "store.mjs", "sub/store.mjs"]);
    assert.deepEqual(bad.map((b) => b.file).sort(), ["bad.cjs", "sub/store.mjs"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
