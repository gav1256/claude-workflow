import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { canonPath, atomicWriteJson, newRunId } from "../lib/paths.mjs";
import { tmpEnv, rmrf } from "./helpers.mjs";

const PATHS_URL = pathToFileURL(path.resolve(import.meta.dirname, "../lib/paths.mjs")).href;
const win = process.platform === "win32";

// Import paths.mjs in a child with a given env (its constants are fixed at import time).
function inChild(env, code) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import * as p from ${JSON.stringify(PATHS_URL)}; ${code}`], { env, encoding: "utf8", windowsHide: true });
  return JSON.parse(out);
}

test("canonPath of a missing path throws", () => {
  assert.throws(() => canonPath(path.join(os.tmpdir(), "cdx-no-such-dir-" + process.pid)), { code: "ENOENT" });
});

test("canonPath: one value for every spelling of the same folder", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cdx-canon-")));
  try {
    const dir = path.join(base, "Long Directory Name", "Wt");
    fs.mkdirSync(dir, { recursive: true });
    const spellings = [dir, dir + path.sep, dir.replace(/\\/g, "/"), dir.replace(/\\/g, "/") + "/",
      dir.toUpperCase(), dir.toLowerCase()];
    if (win) {
      spellings.push("\\\\?\\" + dir);
      // 8.3 short name of the middle folder (identical to the long name when 8.3 is disabled)
      const mid = path.join(base, "Long Directory Name");
      const short = execSync(`for %I in ("${mid}") do @echo %~sI`,
        { shell: "cmd.exe", encoding: "utf8", windowsHide: true }).trim();
      spellings.push(path.join(short, "Wt"));
    }
    const got = new Set(spellings.map(canonPath));
    assert.equal(got.size, 1, JSON.stringify([...got]));
    const [c] = got;
    assert.equal(c, c.toLowerCase());
    assert.ok(!c.endsWith("\\") && !c.includes("/") && !c.startsWith("\\\\?\\"));
  } finally { rmrf(base); }
});

test("canonPath keeps a drive root's separator", { skip: !win }, () => {
  assert.equal(canonPath("C:\\"), "c:\\");
});

test("atomicWriteJson writes valid JSON, replaces, leaves no temp file, creates the folder", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-aw-"));
  try {
    const f = path.join(base, "sub", "x.json");
    atomicWriteJson(f, { a: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 1 });
    atomicWriteJson(f, { a: 2, b: [1] });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2, b: [1] });
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ["x.json"]);
  } finally { rmrf(base); }
});

test("newRunId has the documented shape and is unique", () => {
  const a = newRunId(new Date("2026-10-06T10:15:00.123Z"));
  assert.match(a, /^20261006T101500Z-[0-9a-f]{6}$/);
  assert.match(newRunId(), /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  assert.notEqual(newRunId(), newRunId());
});

test("path constants derive from the env overrides", () => {
  const env = tmpEnv();
  try {
    const r = inChild(env, `console.log(JSON.stringify({CFG:p.CFG,CODEX_HOME:p.CODEX_HOME,STATE:p.STATE,USAGE_DIR:p.USAGE_DIR,
      PACE:p.PACE,LEDGER:p.LEDGER,LAST_USAGE:p.LAST_USAGE,TESTED_VERSION:p.TESTED_VERSION,ACL_STATE:p.ACL_STATE,
      WT_LOCKS:p.WT_LOCKS,SLOT_LOCKS:p.SLOT_LOCKS,PIPE_PREFIX:p.PIPE_PREFIX,HL_DIR:p.HL_DIR,REAL_TEMP:p.REAL_TEMP}))`);
    const cfg = env.CLAUDE_CONFIG_DIR;
    assert.equal(r.CFG, cfg);
    assert.equal(r.CODEX_HOME, env.CODEX_HOME);
    assert.equal(r.STATE, path.join(cfg, "state", "codex"));
    assert.equal(r.USAGE_DIR, path.join(cfg, "state", "coord", "usage"));
    assert.equal(r.PACE, path.join(cfg, "state", "coord", "pace.json"));
    assert.equal(r.LEDGER, path.join(r.STATE, "runs.jsonl"));
    assert.equal(r.LAST_USAGE, path.join(r.STATE, "last-usage.json"));
    assert.equal(r.TESTED_VERSION, path.join(r.STATE, "tested-version"));
    assert.equal(r.ACL_STATE, path.join(r.STATE, "acl-scan.json"));
    assert.equal(r.WT_LOCKS, path.join(r.STATE, "worktree-locks"));
    assert.equal(r.SLOT_LOCKS, path.join(r.STATE, "slot-locks"));
    assert.equal(r.PIPE_PREFIX, env.CODEX_RUN_PIPE_PREFIX);
    assert.equal(r.HL_DIR, path.join(cfg, "skills", "handoff-launch"));
    assert.equal(r.REAL_TEMP, env.CODEX_RUN_TEMP);
    // HL_SKILL_DIR overrides the handoff-launch folder
    const r2 = inChild({ ...env, HL_SKILL_DIR: path.join(env.root, "hl") }, `console.log(JSON.stringify({d:p.HL_DIR}))`);
    assert.equal(r2.d, path.join(env.root, "hl"));
  } finally { env.cleanup(); }
});

test("defaults use the home folder when no override is set", () => {
  const env = tmpEnv();
  try {
    for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_RUN_PIPE_PREFIX", "CODEX_RUN_TEMP"]) delete env[k];
    const r = inChild(env, `console.log(JSON.stringify({CFG:p.CFG,CH:p.CODEX_HOME,PP:p.PIPE_PREFIX,T:p.REAL_TEMP}))`);
    assert.equal(r.CFG, path.join(os.homedir(), ".claude"));
    assert.equal(r.CH, path.join(os.homedir(), ".codex"));
    assert.equal(r.PP, "codex-run-");
    assert.equal(r.T, os.tmpdir());
  } finally { env.cleanup(); }
});

test("runDir creates STATE/runs/<id> under the override and rejects unsafe ids", () => {
  const env = tmpEnv();
  try {
    const r = inChild(env, `const id=p.newRunId(); const d=p.runDir(id); let bad=[];
      for (const b of ["..","../x","a/b","a\\\\b","",undefined]) { try { p.runDir(b); } catch { bad.push(String(b)); } }
      console.log(JSON.stringify({id,d,bad}))`);
    assert.equal(r.d, path.join(env.CLAUDE_CONFIG_DIR, "state", "codex", "runs", r.id));
    assert.ok(fs.statSync(r.d).isDirectory());
    assert.equal(r.bad.length, 6);
  } finally { env.cleanup(); }
});
