import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR } from "./mc-helpers.mjs";

const PAT = /\b(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|copyFileSync|cpSync|createWriteStream|openSync|writeSync|truncateSync|symlinkSync|linkSync|rmdirSync|writeFile|appendFile)\b|node:fs\/promises|fs\.promises/;
const ALLOWED = new Set(["store.mjs", "deliver-hook.mjs"]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === "tests" || e.name === "node_modules" ? [] : walk(path.join(dir, e.name));
    return e.name.endsWith(".mjs") ? [path.join(dir, e.name)] : [];
  });
}

test("M6 file-writing APIs appear only in store.mjs and deliver-hook.mjs", () => {
  const files = walk(SKILL_DIR);
  assert.ok(files.some((f) => path.basename(f) === "store.mjs"), "scan must see store.mjs");
  const bad = files.filter((f) => !ALLOWED.has(path.basename(f)) && PAT.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(SKILL_DIR, f));
  assert.deepEqual(bad, []);
});

test("M6 the pattern really catches each API (guard against a broken regex)", () => {
  for (const s of ["fs.writeFileSync(x)", "appendFileSync", "renameSync(a,b)", "rmSync", "unlinkSync", "mkdirSync", "copyFileSync", "cpSync",
    "createWriteStream", "openSync", "writeSync", "truncateSync", "symlinkSync", "linkSync", "rmdirSync", "fs.writeFile(", "appendFile(",
    'from "node:fs/promises"', "fs.promises.writeFile"]) {
    assert.ok(PAT.test(s), s);
  }
  assert.ok(!PAT.test("readFileSync existsSync readdirSync"));
});
