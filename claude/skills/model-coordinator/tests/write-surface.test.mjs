import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SKILL_DIR } from "./mc-helpers.mjs";

// M6 guard: an IMPORT ALLOWLIST. Outside store.mjs (matched by path relative to the skill folder) a source file may
// import `fs` only as named read functions, and may not reach the file system any other way.
const EXEMPT = new Set(["store.mjs"]);
const FS_READ = new Set(["existsSync", "readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync"]);
const FS_MODS = new Set(["fs", "node:fs"]);
const FS_PROMISES = new Set(["fs/promises", "node:fs/promises"]);
const CHILD = new Set(["child_process", "node:child_process"]);
// Modules that may import child_process (named imports only; they still get no fs write APIs). These are the places
// the plan spawns from: claude-adapter (Task 9), codex-adapter (Task 10a/10b), cli (Task 13). Adding a module to
// this set needs a review.
const CHILD_OK = new Set(["claude-adapter.mjs", "codex-adapter.mjs", "cli.mjs"]);
// Relative imports that leave the skill folder, as paths resolved from the skill folder. Later tasks add entries
// (live.mjs, status-lib.mjs, codex libs) under review; each one is code outside this guard's reach.
const OUTSIDE_OK = new Set([
  // claude-adapter.mjs (Task 9): registry, liveness, agents list, transcript tail and `claude` spawn primitives. Its own
  // writes still go through store.mjs; live.mjs is the launcher's shared module and stays code outside this guard.
  "../handoff-launch/live.mjs",
  // claude-adapter.mjs (Task 9): liveLaneStatus(), the lane classifier (open / finished / paused / closed_unfinished).
  "../handoff-launch/status-lib.mjs",
]);

// A non-literal dynamic import() is allowed in exactly one module: codex-lib.mjs, which holds nothing but the loader of the Codex
// skill's read-only lib (the fixed `href` construction, assertLibHref and the one import). The file is pinned by the sha256 of its
// content (CRLF normalised to LF), so any change makes the guard flag it. Changing codex-lib.mjs REQUIRES A REVIEW and an update of
// this hash. Every other module (codex-adapter.mjs included) may not have a non-literal import() at all.
const DYNAMIC_PIN = new Map([["codex-lib.mjs", "da9441603874c87d1566e7830d473fc0e5e717be74275e00dd4027c87c5f31f8"]]);
const sha256 = (text) => crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

function checkSpecifier(spec, clause, found, rel) {
  if (/^(\.\.?\/|\/|file:)/.test(spec)) {
    const resolved = spec.startsWith(".") ? path.posix.join(path.posix.dirname(rel), spec) : spec;
    if ((resolved.startsWith("..") || !spec.startsWith(".")) && !OUTSIDE_OK.has(resolved)) found.push(`imports outside the skill folder: ${spec}`);
    return;
  }
  if (FS_PROMISES.has(spec)) found.push(`imports ${spec}`);
  else if (CHILD.has(spec)) {
    if (!CHILD_OK.has(rel)) found.push(`imports ${spec}`);
    else if (clause === null || !/^\{[^}]*\}$/.test(clause.trim())) found.push(`non-named import of ${spec}`);
  }
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
export function scanSource(text, rel = "fixture.mjs") {
  const found = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+([^"';]*?)\s*\bfrom\s*["']([^"']+)["']/g)) checkSpecifier(m[2], m[1], found, rel);
  for (const m of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) checkSpecifier(m[1], null, found, rel);
  const pinned = DYNAMIC_PIN.get(rel) === sha256(text); // the pinned module's non-literal import() is the reviewed one
  for (const m of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const lit = /^\s*["']([^"']*)["']\s*$/.exec(m[1]);
    if (!lit && pinned) continue;
    if (!lit) found.push(`import() with a non-literal argument: ${m[1].trim()}`);
    else if (/^(\.\.?\/|\/|file:)/.test(lit[1])) checkSpecifier(lit[1], null, found, rel);
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
  return { files, bad: files.filter((f) => !EXEMPT.has(f)).map((f) => ({ file: f, problems: scanSource(fs.readFileSync(path.join(dir, f), "utf8"), f) })).filter((r) => r.problems.length) };
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

test("G1 child_process is allowed only in the CHILD_OK modules, as named imports", () => {
  const src = 'import { spawnSync } from "node:child_process";';
  for (const f of ["claude-adapter.mjs", "codex-adapter.mjs", "cli.mjs"]) assert.deepEqual(scanSource(src, f), [], f);
  assert.ok(scanSource(src, "dispatcher.mjs").length > 0);
  assert.ok(scanSource(src, "sub/claude-adapter.mjs").length > 0, "matched by relative path, not basename");
  assert.ok(scanSource('import cp from "child_process";', "claude-adapter.mjs").length > 0, "default import stays refused");
  assert.ok(scanSource('import * as cp from "child_process";', "cli.mjs").length > 0);
  assert.ok(scanSource('import { spawnSync } from "node:child_process"; import fs from "node:fs";', "cli.mjs").length > 0, "no fs writes there either");
  assert.ok(scanSource('const m = await import("node:child_process");', "cli.mjs").length > 0);
});

test("G2 relative imports that leave the skill folder are flagged unless in OUTSIDE_OK", () => {
  for (const src of ['import { x } from "../handoff-launch/launch.mjs";', 'import "../x.mjs";', 'const m = await import("../handoff-launch/launch.mjs");',
    'export { x } from "../../y.mjs";', 'import { x } from "file:///etc/x.mjs";']) {
    assert.ok(scanSource(src, "a.mjs").length > 0, src);
  }
  assert.ok(scanSource('import { x } from "../a.mjs";', "sub/b.mjs").length === 0, "inside the folder when resolved from a subfolder");
  assert.ok(scanSource('import { x } from "../../a.mjs";', "sub/b.mjs").length > 0);
  for (const src of ['import { x } from "./a.mjs";', 'const m = await import("./sub/a.mjs");']) assert.deepEqual(scanSource(src, "b.mjs"), [], src);
});

test("G3 a non-literal import() is flagged in every module but the pinned codex-lib.mjs", () => {
  for (const src of ["const m = await import(href);", "const m = await import(name);", "const m = await import(`node:${href}`);", "async function f(href) { return import(href); }"]) {
    for (const rel of ["codex-adapter.mjs", "claude-adapter.mjs", "sub/codex-lib.mjs", "other.mjs"]) assert.ok(scanSource(src, rel).length > 0, `${rel}: ${src}`);
  }
});

const LIB_PATH = path.join(SKILL_DIR, "codex-lib.mjs");

test("Y1 codex-lib.mjs is pinned by hash: the real file passes, and one changed byte (or any appended statement) is flagged", () => {
  const real = fs.readFileSync(LIB_PATH, "utf8");
  assert.ok(real.includes("await import(href)"), "the pinned module really holds the dynamic import");
  assert.equal(sha256(real), DYNAMIC_PIN.get("codex-lib.mjs"), "update DYNAMIC_PIN only after a review of codex-lib.mjs");
  assert.deepEqual(scanSource(real, "codex-lib.mjs"), []);
  assert.deepEqual(scanSource(real.replace(/\n/g, "\r\n"), "codex-lib.mjs"), [], "a CRLF checkout hashes the same");
  for (const [name, text] of Object.entries({
    "one byte changed": real.replace("(?:binary", "(?:binarx"),
    "a trailing statement": real.replace("await import(href);", "await import(href); evil();"),
    "a hoisted shadow after the import": real + "\nfunction assertLibHref() {}\n",
    "a second import": real + "\nexport const other = (href) => import(href);\n",
    "a space added": real + " ",
  })) assert.ok(scanSource(text, "codex-lib.mjs").length > 0, `not flagged: ${name}`);
  assert.ok(scanSource(real, "codex-adapter.mjs").length > 0, "the same text is not exempt in another module");
});

test("Y1 codex-adapter.mjs has no dynamic import and imports codex-lib.mjs statically", () => {
  const src = fs.readFileSync(path.join(SKILL_DIR, "codex-adapter.mjs"), "utf8");
  assert.ok(!/\bimport\s*\(/.test(src), "no import() call, not even in a comment");
  assert.match(src, /import \{ loadCodexLib \} from "\.\/codex-lib\.mjs";/);
});
