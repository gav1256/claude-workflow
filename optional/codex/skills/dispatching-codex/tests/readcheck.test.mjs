// Task 6: the read-boundary check, the ACL scan, --setup lines and the new-version gate.
// Safety: every path is a temp folder this test creates; the fake codex stands in for codex.exe;
// icacls is injected (the one real icacls call only LISTS a temp folder). No ACL is ever changed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as RC from "../lib/readcheck.mjs";
import { tmpEnv, scenario, FAKE_CODEX, TESTS_DIR } from "./helpers.mjs";
import {
  readTargets, readcheckCmd, parseMarkers, runReadCheck, parseIcacls, aclScan, aclScanDue,
  setupLines, versionGate,
} from "../lib/readcheck.mjs";

const win = process.platform === "win32";
const FIX = path.join(TESTS_DIR, "fixtures");
const fixture = (n) => fs.readFileSync(path.join(FIX, n), "utf8");
const fakeIcacls = (text) => async (_dir, onLine) => { for (const l of text.split(/\r?\n/)) onLine(l); return { code: 0 }; };
const touch = (p, body = "fake") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
// The fake codex behind a thin wrapper that adds the control marker the real check file prints
// (the fake itself only knows R:/D:/END). env.CTRL: ok (default) | no | dup | none.
function bin(env) {
  const wrap = path.join(env.root, "fake-ctl-wrap.mjs");
  fs.writeFileSync(wrap, [
    'import { spawnSync } from "node:child_process";',
    `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_CODEX)}, ...process.argv.slice(2)], { encoding: "utf8", windowsHide: true });`,
    'const lines = { ok: "C:ok\\n", no: "C:no\\n", dup: "C:ok\\nC:ok\\n", none: "" };',
    'const pre = process.argv[2] === "sandbox" ? lines[process.env.CTRL || "ok"] : "";',
    // the fake now prints its own `C:ok`: drop it so env.CTRL alone decides what the control looks like
    'process.stdout.write(pre + (r.stdout ?? "").replace(/^C:(?:ok|no)\\r?\\n/gm, "")); process.stderr.write(r.stderr ?? ""); process.exit(r.status ?? 1);',
    "",
  ].join("\n"));
  return { cmd: process.execPath, args: [wrap] };
}
// Inline fake-sandbox script body: a clean D: for every target, plus the control marker, then END.
const CLEAN_OUT = 'const n = (fs.readFileSync(f, "utf8").match(/echo R:/g) || []).length; console.log("C:ok"); ' +
  'for (let i = 0; i < n; i++) console.log("D:" + i); console.log("END");';

// A temp "home" (with a space in its name) laid out like a profile, plus a worktree-like cwd.
function setup(t, { home = "home dir" } = {}) {
  const env = tmpEnv();
  t.after(() => env.cleanup());
  const h = path.join(env.root, home);
  const ctx = {
    home: h, cfg: path.join(h, ".claude"), codexHome: path.join(h, ".codex"),
    temp: path.join(h, "AppData", "Local", "Temp"),
    aclState: path.join(env.root, "state", "acl-scan.json"),
    testedVersion: path.join(env.root, "state", "tested-version"),
  };
  fs.mkdirSync(ctx.cfg, { recursive: true });
  fs.mkdirSync(ctx.codexHome, { recursive: true });
  fs.mkdirSync(ctx.temp, { recursive: true }); // %TEMP% exists, %TEMP%\claude does not
  const cwd = path.join(env.root, "wt dir");
  fs.mkdirSync(cwd, { recursive: true });
  return { env, ctx, cwd, home: h };
}

// Fake credential files (non-secret text) and folders, as a profile would have them.
function fakeCreds(h, ctx) {
  touch(path.join(ctx.codexHome, "auth.json"));
  touch(path.join(ctx.cfg, ".credentials.json"));
  touch(path.join(h, ".git-credentials"));
  touch(path.join(h, ".config", "gh", "hosts.yml"));
  touch(path.join(h, ".docker", "config.json"));
  touch(path.join(h, ".npmrc"));
  touch(path.join(h, ".aws", "credentials"));
  touch(path.join(h, ".ssh", "id_ed25519"));
  touch(path.join(h, ".ssh", "id_ed25519.pub"));
  touch(path.join(h, ".ssh", "config")); // not id_*: not a target
}

const sentinelsLeft = (dirs) => dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d) : []))
  .filter((f) => f.startsWith("codex-read-sentinel-"));

// ---------------------------------------------------------------- readTargets

test("readTargets: only present files, id_* expanded, sentinels only in folders that exist", (t) => {
  const { ctx, home } = setup(t);
  fakeCreds(home, ctx);
  const { files, sentinels } = readTargets({ runId: "r1", ctx });
  const rel = (p) => path.relative(home, p).replace(/\\/g, "/");
  assert.deepEqual(files.map((f) => rel(f.path)), [
    ".codex/auth.json", ".claude/.credentials.json", ".git-credentials", ".config/gh/hosts.yml",
    ".docker/config.json", ".npmrc", ".aws/credentials", ".ssh/id_ed25519", ".ssh/id_ed25519.pub",
  ]);
  assert.deepEqual(files.map((f) => f.n), files.map((_, i) => i));
  // exact set (order: CFG, CODEX_HOME, %TEMP%\claude, then credential folders in the spec's order)
  assert.deepEqual(sentinels.map((s) => rel(s.dir)), [".claude", ".codex", ".ssh", ".config/gh", ".docker", ".aws"]);
  assert.deepEqual(sentinels.map((s) => s.n), sentinels.map((_, i) => files.length + i));
  for (const s of sentinels) assert.equal(s.path, path.join(s.dir, "codex-read-sentinel-r1.txt"));
  // no %TEMP%\claude, no ~/.azure: no sentinel there, and nothing was created
  assert.ok(!sentinels.some((s) => /Temp[\\/]claude$/.test(s.dir) || s.dir.endsWith(".azure")));
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude")));
  assert.ok(!fs.existsSync(path.join(home, ".azure")));
});

test("readTargets: %TEMP%\\claude and .azure get a sentinel once they exist", (t) => {
  const { ctx, home } = setup(t);
  fs.mkdirSync(path.join(ctx.temp, "claude"));
  fs.mkdirSync(path.join(home, ".azure"));
  const { files, sentinels } = readTargets({ runId: "r2", ctx });
  assert.deepEqual(files, []);
  assert.ok(sentinels.some((s) => s.dir === path.join(ctx.temp, "claude")));
  assert.ok(sentinels.some((s) => s.dir === path.join(home, ".azure")));
});

test("readTargets: a bad run id is rejected before any path is built", (t) => {
  const { ctx } = setup(t);
  for (const bad of ["", "..", "a/b", "a\\b", "x y", undefined]) {
    assert.throws(() => readTargets({ runId: bad, ctx }), /invalid run id/);
  }
});

// ---------------------------------------------------------------- readcheckCmd

test("readcheckCmd: CRLF, one marker line per target, ends with echo END", () => {
  const text = readcheckCmd({
    files: [{ n: 0, path: "C:\\a b\\x.json" }],
    sentinels: [{ n: 1, dir: "C:\\d & e", path: "C:\\d & e\\s.txt" }],
  });
  assert.equal(text,
    "@echo off\r\nsetlocal DisableDelayedExpansion\r\n" +
    'type "C:\\a b\\x.json" >nul 2>nul && echo R:0 || echo D:0\r\n' +
    'type "C:\\d & e\\s.txt" >nul 2>nul && echo R:1 || echo D:1\r\n' +
    "echo END\r\n");
});

test("readcheckCmd: a percent sign in a path is doubled so cmd does not expand it", () => {
  const text = readcheckCmd({ files: [{ n: 0, path: "C:\\100%\\x" }], sentinels: [] });
  assert.ok(text.includes('type "C:\\100%%\\x"'));
});

test("readcheckCmd: a path with a double quote or a line break is refused", () => {
  for (const bad of ['C:\\a"b', "C:\\a\nb", "C:\\a\rb"]) {
    assert.throws(() => readcheckCmd({ files: [{ n: 0, path: bad }], sentinels: [] }), /unsafe/);
  }
});

// ---------------------------------------------------------------- parseMarkers

test("parseMarkers: complete all-denied set is ok (CRLF too)", () => {
  assert.deepEqual(parseMarkers("C:ok\nD:0\nD:1\nD:2\nEND\n", 3), { ok: true });
  assert.deepEqual(parseMarkers("C:ok\r\nD:0\r\nD:1\r\nEND\r\n", 2), { ok: true });
  assert.deepEqual(parseMarkers("C:ok\nEND\n", 0), { ok: true });
  assert.deepEqual(parseMarkers("D:0\nC:ok\nD:1\nEND\n", 2), { ok: true }, "the control may come anywhere before END");
});

test("parseMarkers: any R: is read-boundary-open and lists the open indexes", () => {
  const r = parseMarkers("C:ok\nD:0\nR:1\nD:2\nR:3\nEND\n", 4);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^read-boundary-open: /);
  assert.deepEqual(r.open, [1, 3]);
});

test("parseMarkers: missing, extra, duplicate, no END, marker after END, empty are read-check-failed", () => {
  const bad = [
    ["C:ok\nD:0\nEND\n", 2], // missing 1
    ["C:ok\nD:0\nD:1\nD:2\nEND\n", 2], // extra index
    ["C:ok\nD:0\nD:0\nD:1\nEND\n", 2], // duplicate
    ["C:ok\nD:0\nR:0\nD:1\nEND\n", 2], // same index both ways
    ["C:ok\nD:0\nD:1\n", 2], // no END
    ["C:ok\nD:0\nEND\nD:1\n", 2], // marker after END
    ["", 1],
    ["garbage\n", 1],
    ["C:ok\nD:0\nD:1\nEND\nEND\n", 2], // END twice
    // the positive control (C:ok exactly once) is part of the contract
    ["D:0\nEND\n", 1], // control missing
    ["C:ok\nC:ok\nD:0\nEND\n", 1], // control duplicated
    ["C:no\nD:0\nEND\n", 1], // the check could not read its own control file
    ["C:no\nR:0\nEND\n", 1], // ... which outranks an R:
    ["C:ok\nC:no\nD:0\nEND\n", 1], // ok and no together
    ["C:ok\nD:0\nEND\nC:ok\n", 1], // control after END
  ];
  for (const [out, n] of bad) {
    const r = parseMarkers(out, n);
    assert.equal(r.ok, false, JSON.stringify(out));
    assert.equal(r.reason, "read-check-failed", JSON.stringify(out));
  }
});

test("parseMarkers: a duplicate open marker still fails closed (never reports ok)", () => {
  const r = parseMarkers("C:ok\nR:0\nR:0\nEND\n", 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "read-check-failed");
});

test("parseMarkers: unrelated lines (a banner) are ignored", () => {
  assert.deepEqual(parseMarkers("codex sandbox starting\nC:ok\nD:0\nEND\n", 1), { ok: true });
});

// ---------------------------------------------------------------- runReadCheck (fake codex)

test("runReadCheck: all denied -> ok; sentinels exist only during the run and are deleted", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  const r = await runReadCheck({ bin: bin(env), cwd, runId: "run-ok", env, ctx });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome, path.join(home, ".ssh"), path.join(home, ".aws")]), []);
  // the check file is in the worktree's .codex-tmp, never in a protected folder
  const cmdFile = path.join(cwd, ".codex-tmp", "run-ok", "readcheck.cmd");
  const text = fs.readFileSync(cmdFile, "utf8");
  assert.ok(text.includes("\r\n") && !/[^\r]\n/.test(text));
  assert.ok(text.includes("echo END"));
  const n = readTargets({ runId: "run-ok", ctx });
  assert.equal((text.match(/echo R:/g) || []).length, n.files.length + n.sentinels.length);
});

test("runReadCheck: readOpen [2] -> read-boundary-open naming that target, ~-relative", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  scenario({ readOpen: [2] }, env);
  const r = await runReadCheck({ bin: bin(env), cwd, runId: "run-open", env, ctx });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "read-boundary-open: ~\\.git-credentials");
  assert.ok(!r.reason.includes(home), "no absolute user path in the reason");
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome, path.join(home, ".ssh")]), []);
});

test("runReadCheck: an open sentinel is named too (inherited folder deny missing)", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  const { files } = readTargets({ runId: "run-sent", ctx });
  scenario({ readOpen: [files.length] }, env); // first sentinel = CFG
  const r = await runReadCheck({ bin: bin(env), cwd, runId: "run-sent", env, ctx });
  assert.equal(r.reason, "read-boundary-open: ~\\.claude\\codex-read-sentinel-run-sent.txt");
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome]), []);
});

test("runReadCheck: garbage output (no END) -> read-check-failed, sentinels deleted", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  scenario({ readGarbage: true }, env);
  const r = await runReadCheck({ bin: bin(env), cwd, runId: "run-garb", env, ctx });
  assert.deepEqual(r, { ok: false, reason: "read-check-failed" });
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome, path.join(home, ".ssh")]), []);
});

test("runReadCheck: launch error -> read-check-failed, sentinels deleted", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  const r = await runReadCheck({
    bin: { cmd: path.join(env.root, "no-such-codex.exe"), args: [] }, cwd, runId: "run-nobin", env, ctx,
  });
  assert.deepEqual(r, { ok: false, reason: "read-check-failed" });
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome, path.join(home, ".ssh")]), []);
});

test("runReadCheck: a non-zero exit from codex sandbox is read-check-failed even with clean markers", async (t) => {
  const { env, ctx, cwd } = setup(t);
  const wrap = path.join(env.root, "exit1.mjs");
  // exactly one clean D: per target and END, then a failing exit: only the exit code can fail it
  fs.writeFileSync(wrap, 'import fs from "node:fs"; ' +
    'const f = process.argv[process.argv.length - 1]; ' + CLEAN_OUT + ' process.exit(1);\n');
  const r = await runReadCheck({ bin: { cmd: process.execPath, args: [wrap] }, cwd, runId: "run-exit", env, ctx });
  assert.deepEqual(r, { ok: false, reason: "read-check-failed" });
});

test("runReadCheck: a file where a credential folder would be is not a folder: no sentinel, no error", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  // a FILE named like a protected folder is not a directory, so no sentinel is placed there
  fs.writeFileSync(path.join(home, ".azure"), "not a folder");
  const r = await runReadCheck({ bin: bin(env), cwd, runId: "run-file", env, ctx });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome]), []);
});

test("runReadCheck: never creates a protected folder", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  const r = await runReadCheck({ bin: bin(env), cwd, runId: "run-nocreate", env, ctx });
  assert.deepEqual(r, { ok: true });
  for (const p of [path.join(ctx.temp, "claude"), path.join(home, ".ssh"), path.join(home, ".azure"),
    path.join(home, ".aws"), path.join(home, ".docker"), path.join(home, ".config")]) {
    assert.ok(!fs.existsSync(p), `${p} must not exist`);
  }
});

test("runReadCheck: a worktree path with a space and an ampersand reaches the sandbox call intact", async (t) => {
  const { env, ctx, home } = setup(t);
  fakeCreds(home, ctx);
  const cwd = path.join(env.root, "my wt & more");
  fs.mkdirSync(cwd, { recursive: true });
  const argvFile = path.join(env.root, "argv.json");
  const wrap = path.join(env.root, "argv-wrap.mjs");
  fs.writeFileSync(wrap, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2))); ` +
    'const f = process.argv[process.argv.length - 1]; ' + CLEAN_OUT + '\n');
  const r = await runReadCheck({ bin: { cmd: process.execPath, args: [wrap] }, cwd, runId: "run-sp", env, ctx });
  assert.deepEqual(r, { ok: true });
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.deepEqual(argv.slice(0, 5), ["sandbox", "-P", ":read-only", "-C", cwd]);
  assert.equal(argv[argv.length - 1], path.join(cwd, ".codex-tmp", "run-sp", "readcheck.cmd"));
});

// The generated check file against REAL cmd.exe on readable temp files: it must print R: for a file
// that can be read and D: for one that cannot, with spaces, &, % and non-ASCII in the paths.
test("readcheck.cmd under real cmd.exe: R for readable, D for unreadable; odd characters survive",
  { skip: !win }, async (t) => {
    const { env, ctx, cwd } = setup(t, { home: "h & 100% \u00e9t\u00e9" });
    touch(path.join(ctx.codexHome, "auth.json"));
    const wrap = path.join(env.root, "realcmd.mjs");
    fs.writeFileSync(wrap, 'import { spawnSync } from "node:child_process"; ' +
      'const f = process.argv[process.argv.length - 1]; ' +
      'const r = spawnSync(process.env.ComSpec, ["/d", "/c", f], { stdio: "inherit", windowsHide: true }); process.exit(r.status ?? 1);\n');
    // 1. nothing denies reads here, so every target reads: all R
    const r = await runReadCheck({ bin: { cmd: process.execPath, args: [wrap] }, cwd, runId: "run-real", env, ctx });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^read-boundary-open: /);
    assert.ok(r.reason.includes("auth.json"), r.reason);
    assert.ok(r.reason.includes("codex-read-sentinel-run-real.txt"), r.reason);
    assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome]), []);
    // 2. a target that does not exist reads as D: run the file the script wrote, with one path broken
    const cmdFile = path.join(cwd, ".codex-tmp", "run-real", "readcheck.cmd");
    const text = fs.readFileSync(cmdFile, "utf8").replace(/auth\.json/g, "auth-missing.json");
    fs.writeFileSync(cmdFile, text);
    const out = spawnSync(process.env.ComSpec, ["/d", "/c", cmdFile], { encoding: "utf8", windowsHide: true }).stdout;
    assert.match(out, /^D:0\r?$/m);
    assert.match(out, /^END\r?$/m);
  });

// ---------------------------------------------------------------- parseIcacls

test("parseIcacls: denied fixture -> nothing missing, no error", () => {
  assert.deepEqual(parseIcacls(fixture("icacls-denied.txt")), { missing: [], error: false });
});

test("parseIcacls: missing fixture -> exactly the file without the deny (an allow ACE for the group is no deny)", () => {
  const r = parseIcacls(fixture("icacls-missing.txt"));
  assert.equal(r.error, false);
  assert.deepEqual(r.missing, ["C:\\Users\\USER\\AppData\\Local\\Temp\\claude\\p7tmp\\sub dir\\b.txt"]);
});

test("parseIcacls: real sanitized listing without any deny -> all three entries missing", () => {
  const r = parseIcacls(fixture("icacls-partial.txt"));
  assert.equal(r.error, false);
  assert.equal(r.missing.length, 3);
  assert.equal(r.missing[0], "C:\\Users\\USER\\AppData\\Local\\Temp\\acltest\\p7tmp");
  assert.ok(r.missing[1].endsWith("\\p7tmp\\a.txt"), r.missing[1]);
  assert.ok(r.missing[2].endsWith("\\p7tmp\\b.txt"), r.missing[2]); // single-ACE entry
  assert.ok(!r.missing.some((m) => m.includes("NT AUTHORITY")), "path never swallows an account name");
});

test("parseIcacls: CRLF output parses the same", () => {
  const crlf = fixture("icacls-missing.txt").replace(/\n/g, "\r\n");
  assert.deepEqual(parseIcacls(crlf), parseIcacls(fixture("icacls-missing.txt")));
});

// The deny design (2026-10-07): Codex re-grants the GROUP CodexSandboxUsers on every run (SET_ACCESS removes a group
// deny), so only a read deny for BOTH the per-user accounts CodexSandboxOffline and CodexSandboxOnline counts.
const SUM1 = "\n\nSuccessfully processed 1 files; Failed processing 0 files\n";
// An entry for `p` with one ACE line per account, aligned under the path (icacls' short-path layout).
const entryOf = (p, aces) => `${p} ${aces[0]}\n${aces.slice(1).map((a) => " ".repeat(p.length + 1) + a).join("\n")}${aces.length > 1 ? "\n" : ""}`;
const perUser = (tail, users = ["Offline", "Online"]) => users.map((u) => `HOST\\CodexSandbox${u}:${tail}`);
const coveredBy = (aces, p = "C:\\x\\f.txt") => parseIcacls(entryOf(p, [...aces, "HOST\\USER:(F)"]) + SUM1).missing.length === 0;

test("parseIcacls: only a DENY of a read right for BOTH CodexSandboxOffline and CodexSandboxOnline counts", () => {
  for (const tail of ["(DENY)(R)", "(I)(DENY)(R)", "(OI)(CI)(DENY)(R)", "(I)(DENY)(RX)", "(OI)(CI)(DENY)(R,W,D)"]) {
    assert.ok(coveredBy(perUser(tail)), tail);
  }
  assert.ok(coveredBy(["CodexSandboxOffline:(DENY)(R)", "CodexSandboxOnline:(DENY)(R)"]), "bare account names");
  assert.ok(coveredBy(perUser("(DENY)(R)", ["Online", "Offline"])), "either order");
  // one user alone, either one
  assert.ok(!coveredBy(perUser("(DENY)(R)", ["Offline"])));
  assert.ok(!coveredBy(perUser("(DENY)(R)", ["Online"])));
  // the group deny alone no longer counts (Codex can strip it), and does not complete a half pair
  assert.ok(!coveredBy(["HOST\\CodexSandboxUsers:(OI)(CI)(DENY)(R)"]));
  assert.ok(!coveredBy([...perUser("(DENY)(R)", ["Offline"]), "HOST\\CodexSandboxUsers:(DENY)(R)"]));
  // an allow, a write-only deny, read-control, other accounts, a name that only contains ours: no deny of read
  assert.ok(!coveredBy(perUser("(I)(M)")));
  assert.ok(!coveredBy(perUser("(DENY)(W)")));
  assert.ok(!coveredBy(perUser("(DENY)(RC)")));
  assert.ok(!coveredBy(["HOST\\Other:(DENY)(R)", "HOST\\Other2:(DENY)(R)"]));
  assert.ok(!coveredBy(["HOST\\NotCodexSandboxOffline:(DENY)(R)", "HOST\\NotCodexSandboxOnline:(DENY)(R)"]));
  assert.ok(!coveredBy(perUser("(OI)(CI)(IO)(DENY)(R)"))); // inherit-only: not on this object
  // a deny for one user and an inherit-only deny for the other is still half
  assert.ok(!coveredBy(["HOST\\CodexSandboxOffline:(DENY)(R)", "HOST\\CodexSandboxOnline:(OI)(CI)(IO)(DENY)(R)"]));
});

test("parseIcacls: a group-only deny listing (the old fixtures) is all missing", () => {
  const only = entryOf("C:\\x\\g.txt", ["HOST\\CodexSandboxUsers:(OI)(CI)(DENY)(R)", "HOST\\USER:(F)"]) + SUM1;
  assert.deepEqual(parseIcacls(only), { missing: ["C:\\x\\g.txt"], error: false });
});

// Long paths (about 260 characters or more): icacls prints the continuation ACE lines with NO indent, found live.
test("parseIcacls: a 300-character path with unindented ACE lines parses by shape (fixture)", () => {
  const text = fixture("icacls-longpath.txt");
  const first = text.split("\n")[0];
  const p = first.slice(0, first.indexOf(" HOST\\"));
  assert.equal(p.length, 300);
  assert.ok(text.split("\n").slice(1, 8).every((l) => !/^\s/.test(l) && l.trim() !== ""), "the continuation lines are not indented");
  const r = parseIcacls(text);
  assert.equal(r.error, false);
  assert.deepEqual(r.missing, [`${p}\\open file.txt`]);
});

test("parseIcacls: an unindented ACE line before any entry, or a bare non-ACE line, is an error; a drive letter or \\\\ starts an entry", () => {
  const ok = fixture("icacls-denied.txt");
  assert.equal(parseIcacls("HOST\\USER:(F)\n\n" + ok).error, true, "ACE line with no entry");
  assert.equal(parseIcacls(ok.replace("\nSuccessfully", "\nsome stray line\nSuccessfully")).error, true);
  const both = perUser("(DENY)(R)");
  const unc = `\\\\server\\share\\dir ${both[0]}\n${both[1]}\nHOST\\USER:(F)\n\n\\\\?\\C:\\long\\path ${both[0]}\n${both[1]}\nHOST\\USER:(F)\n\nC:\\x\\open.txt HOST\\USER:(F)\n`;
  assert.deepEqual(parseIcacls(unc + "\nSuccessfully processed 3 files; Failed processing 0 files\n"), { missing: ["C:\\x\\open.txt"], error: false });
  // an entry that follows another without a blank line still starts at its drive letter
  const noBlank = `C:\\a\\b.txt ${both[0]}\n${both[1]}\nC:\\a\\c.txt HOST\\USER:(F)\n` + "\nSuccessfully processed 2 files; Failed processing 0 files\n";
  assert.deepEqual(parseIcacls(noBlank), { missing: ["C:\\a\\c.txt"], error: false });
});

test("parseIcacls: 'Failed processing N' with N > 0 is an error; so is an error line or no summary", () => {
  const ok = fixture("icacls-denied.txt");
  assert.equal(parseIcacls(ok.replace("Failed processing 0", "Failed processing 2")).error, true);
  assert.equal(parseIcacls("C:\\x: Access is denied.\n\n" + ok).error, true);
  assert.equal(parseIcacls(ok.replace(/\nSuccessfully.*\n$/, "\n")).error, true); // truncated: no summary
  assert.equal(parseIcacls("").error, true);
  assert.equal(parseIcacls(ok).error, false);
});

// ---------------------------------------------------------------- aclScanDue

const H = 3600 * 1000;
test("aclScanDue: no state, garbage, 24 h exactly, a future stamp -> due; 23 h 59 m -> not", (t) => {
  const { ctx } = setup(t);
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(aclScanDue(now, { ctx }), true); // no file
  const stamp = (ms) => {
    fs.mkdirSync(path.dirname(ctx.aclState), { recursive: true });
    fs.writeFileSync(ctx.aclState, JSON.stringify({ last_complete: new Date(ms).toISOString() }));
  };
  stamp(now - 24 * H + 60000);
  assert.equal(aclScanDue(now, { ctx }), false, "23 h 59 m");
  assert.equal(aclScanDue(new Date(now), { ctx }), false, "a Date works too");
  stamp(now - 24 * H);
  assert.equal(aclScanDue(now, { ctx }), true, "24 h");
  stamp(now + 5 * 60000);
  assert.equal(aclScanDue(now, { ctx }), true, "a stamp in the future cannot suppress scans");
  fs.writeFileSync(ctx.aclState, "{not json");
  assert.equal(aclScanDue(now, { ctx }), true);
  fs.writeFileSync(ctx.aclState, JSON.stringify({ last_complete: "yesterday-ish" }));
  assert.equal(aclScanDue(now, { ctx }), true);
});

// ---------------------------------------------------------------- aclScan

test("aclScan: scans only the protected folders that exist, never creates one", async (t) => {
  const { ctx, home } = setup(t);
  fs.mkdirSync(path.join(home, ".ssh"));
  const seen = [];
  const icacls = async (dir, onLine) => { seen.push(dir); for (const l of fixture("icacls-denied.txt").split("\n")) onLine(l); return { code: 0 }; };
  const r = await aclScan({ ctx, icacls });
  assert.deepEqual(r, { ok: true, missing: [] });
  assert.deepEqual(seen, [ctx.cfg, ctx.codexHome, path.join(home, ".ssh")]);
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude")));
});

test("aclScan: a complete clean scan records last_complete; a scan with a gap does not", async (t) => {
  const { ctx } = setup(t);
  const bad = await aclScan({ ctx, icacls: fakeIcacls(fixture("icacls-missing.txt")) });
  assert.equal(bad.ok, false);
  assert.equal(bad.missing.length, 2); // same output for CFG and CODEX_HOME: one gap each
  assert.ok(!fs.existsSync(ctx.aclState));
  assert.equal(aclScanDue(Date.now(), { ctx }), true);
  const good = await aclScan({ ctx, icacls: fakeIcacls(fixture("icacls-denied.txt")) });
  assert.equal(good.ok, true);
  const st = JSON.parse(fs.readFileSync(ctx.aclState, "utf8"));
  assert.ok(Math.abs(Date.parse(st.last_complete) - Date.now()) < 60000);
  assert.equal(aclScanDue(Date.now(), { ctx }), false);
});

test("aclScan: a scan error (summary, exit code, runner throw) is not ok and records nothing", async (t) => {
  const { ctx } = setup(t);
  const failed = fixture("icacls-denied.txt").replace("Failed processing 0", "Failed processing 1");
  const a = await aclScan({ ctx, icacls: fakeIcacls(failed) });
  assert.equal(a.ok, false);
  assert.ok(a.error);
  const b = await aclScan({ ctx, icacls: async () => ({ code: 5 }) });
  assert.equal(b.ok, false);
  assert.ok(b.error);
  const c = await aclScan({ ctx, icacls: async () => { throw new Error("spawn icacls ENOENT"); } });
  assert.equal(c.ok, false);
  assert.match(c.error, /ENOENT/);
  assert.ok(!fs.existsSync(ctx.aclState));
});

test("aclScan (spec:250): a file without the deny added after a scan is caught by the next scan", async (t) => {
  const { ctx } = setup(t);
  const clean = fixture("icacls-denied.txt");
  assert.equal((await aclScan({ ctx, icacls: fakeIcacls(clean) })).ok, true);
  const extra = "C:\\Users\\USER\\.claude\\late.json HOST\\USER:(F)\n\n";
  const after = clean.replace(/\nSuccessfully/, "\n" + extra + "Successfully");
  const r = await aclScan({ ctx, icacls: fakeIcacls(after) });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("C:\\Users\\USER\\.claude\\late.json"), JSON.stringify(r.missing));
});

test("aclScan: real icacls LISTS a temp folder (read-only), reports it as lacking the deny", { skip: !win }, async (t) => {
  const { env, ctx } = setup(t);
  const dir = path.join(env.root, "scan me & co");
  fs.mkdirSync(dir);
  touch(path.join(dir, "f.txt"));
  const r = await aclScan({ ctx, dirs: [dir] });
  assert.equal(r.ok, false);
  assert.equal(r.error, undefined);
  assert.ok(r.missing.some((m) => m.toLowerCase() === dir.toLowerCase()), JSON.stringify(r.missing));
  assert.ok(r.missing.some((m) => m.toLowerCase().endsWith("f.txt")), JSON.stringify(r.missing));
});

// ---------------------------------------------------------------- aclScan exemptions (Codex's own working folders)

test("ACL_SCAN_EXEMPT names exactly Codex's working folders under ~/.codex", () => {
  assert.deepEqual([...RC.ACL_SCAN_EXEMPT], [".sandbox-bin", ".sandbox", ".sandbox-secrets"]);
});

test("aclScan: ~/.codex\\.sandbox-bin, .sandbox and .sandbox-secrets (and everything under them) are skipped; look-alikes and other folders are not", async (t) => {
  const { ctx } = setup(t);
  const open = (p) => `${p} HOST\\USER:(F)\n\n`;
  const under = (...p) => path.join(ctx.codexHome, ...p);
  const paths = [
    under(".sandbox-bin"), under(".sandbox-bin", "codex.exe"), under(".sandbox"), under(".sandbox", "a", "b.log"),
    under(".sandbox-secrets"), under(".sandbox-secrets", "k.json"), under(".SANDBOX-BIN", "Upper.exe"),
    under(".sandboxes"), under(".sandbox-binx", "f.txt"), under("auth.json"), under("sub", ".sandbox", "x.txt"),
  ];
  const text = paths.map(open).join("") + "Successfully processed 11 files; Failed processing 0 files\n";
  const r = await aclScan({ ctx, dirs: [ctx.codexHome], icacls: fakeIcacls(text) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [
    "~\\.codex\\.sandboxes", "~\\.codex\\.sandbox-binx\\f.txt", "~\\.codex\\auth.json", "~\\.codex\\sub\\.sandbox\\x.txt",
  ]);
  // with only exempt entries the scan is clean and recorded
  const only = paths.slice(0, 7).map(open).join("") + "Successfully processed 7 files; Failed processing 0 files\n";
  const ok = await aclScan({ ctx, dirs: [ctx.codexHome], icacls: fakeIcacls(only) });
  assert.deepEqual(ok, { ok: true, missing: [] });
  assert.equal(aclScanDue(Date.now(), { ctx }), false);
});

// ---------------------------------------------------------------- denyAclCheck (host-side, every run)

// icacls' listing of one folder (no /T): one entry, then the summary.
const FIRST = "(OI)(CI)";
const listing = (p, aces) => entryOf(p, [...aces, "HOST\\USER:(OI)(CI)(F)"]) + SUM1;
const denyOf = (users, rights = "R", flags = FIRST) => users.map((u) => `HOST\\CodexSandbox${u}:${flags}(DENY)(${rights})`);
const BOTH = ["Offline", "Online"];
// A runner that answers per folder; unknown folders are an error. `calls` records (dir, opts).
function denyRunner(texts, calls = []) {
  return async (dir, onLine, opts) => {
    calls.push([dir, opts]);
    const text = texts.get(dir);
    if (text === undefined) return { code: 5 };
    for (const l of text.split(/\r?\n/)) onLine(l);
    return { code: 0 };
  };
}
function protectedLayout(t) {
  const s = setup(t);
  const tc = path.join(s.ctx.temp, "claude");
  fs.mkdirSync(tc, { recursive: true });
  fs.mkdirSync(path.join(s.home, ".ssh"));
  fs.mkdirSync(path.join(s.home, ".docker"));
  const good = new Map([
    [s.ctx.cfg, listing(s.ctx.cfg, denyOf(BOTH))],
    [s.ctx.codexHome, listing(s.ctx.codexHome, denyOf(BOTH))],
    [tc, listing(tc, denyOf(BOTH, "R,W,D"))],
    [path.join(s.home, ".ssh"), listing(path.join(s.home, ".ssh"), denyOf(BOTH))],
    [path.join(s.home, ".docker"), listing(path.join(s.home, ".docker"), denyOf(BOTH))],
  ]);
  return { ...s, tc, good, ssh: path.join(s.home, ".ssh"), docker: path.join(s.home, ".docker") };
}

test("denyAclCheck: both per-user denies on every protected folder -> ok; one icacls per folder, never recursive", async (t) => {
  const L = protectedLayout(t);
  const calls = [];
  const r = await RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(L.good, calls) });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.map(([d]) => d), [L.ctx.cfg, L.ctx.codexHome, L.tc, L.ssh, L.docker]);
  assert.ok(calls.every(([, o]) => o && o.recurse === false), "no /T");
});

test("denyAclCheck: only folders that exist are checked, none is created; no folder at all is ok", async (t) => {
  const { ctx, home } = setup(t);
  fs.rmSync(ctx.cfg, { recursive: true });
  fs.rmSync(ctx.codexHome, { recursive: true });
  const calls = [];
  assert.deepEqual(await RC.denyAclCheck({ ctx, icacls: denyRunner(new Map(), calls) }), { ok: true });
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude")) && !fs.existsSync(path.join(home, ".ssh")) && !fs.existsSync(ctx.cfg));
  // ~/.config\gh, ~/.aws and ~/.azure are not part of this check (only ~/.claude, ~/.codex, %TEMP%\claude, ~/.ssh, ~/.docker)
  fs.mkdirSync(path.join(home, ".aws"));
  assert.deepEqual(await RC.denyAclCheck({ ctx, icacls: denyRunner(new Map(), calls) }), { ok: true });
  assert.deepEqual(calls, []);
});

test("denyAclCheck: a missing user deny names the folder (~-relative) and the user; the group alone is not enough", async (t) => {
  const L = protectedLayout(t);
  const with_ = (dir, aces) => new Map([...L.good, [dir, listing(dir, aces)]]);
  const run = (m) => RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(m) });
  assert.deepEqual(await run(with_(L.ctx.cfg, denyOf(["Online"]))), { ok: false, reason: "read-boundary-open: ~\\.claude lacks CodexSandboxOffline deny" });
  assert.deepEqual(await run(with_(L.ctx.codexHome, denyOf(["Offline"]))), { ok: false, reason: "read-boundary-open: ~\\.codex lacks CodexSandboxOnline deny" });
  const groupOnly = await run(with_(L.ssh, ["HOST\\CodexSandboxUsers:(OI)(CI)(DENY)(R)"]));
  assert.deepEqual(groupOnly, { ok: false, reason: "read-boundary-open: ~\\.ssh lacks CodexSandboxOffline deny" });
  const none = await run(with_(L.docker, ["HOST\\CodexSandboxUsers:(OI)(CI)(RX)"]));
  assert.equal(none.reason, "read-boundary-open: ~\\.docker lacks CodexSandboxOffline deny");
  // an inherit-only deny does not apply to the folder itself; an explicit or inherited one does
  assert.equal((await run(with_(L.ctx.cfg, denyOf(BOTH, "R", "(OI)(CI)(IO)")))).ok, false);
  assert.equal((await run(with_(L.ctx.cfg, denyOf(BOTH, "R", "(I)(OI)(CI)")))).ok, true);
  assert.equal((await run(with_(L.ctx.cfg, denyOf(BOTH, "W,D")))).ok, false, "a write-only deny is not a read deny");
  // rights may be split over several ACEs of the same user
  assert.equal((await run(with_(L.tc, [...denyOf(BOTH, "R"), ...denyOf(BOTH, "W,D")]))).ok, true);
});

test("denyAclCheck: %TEMP%\\claude must deny write as well as read, for both users", async (t) => {
  const L = protectedLayout(t);
  const run = (aces) => RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(new Map([...L.good, [L.tc, listing(L.tc, aces)]])) });
  const tilde = "~\\AppData\\Local\\Temp\\claude";
  assert.deepEqual(await run(denyOf(BOTH, "R")), { ok: false, reason: `read-boundary-open: ${tilde} lacks CodexSandboxOffline write deny` });
  assert.deepEqual(await run([...denyOf(["Offline"], "R,W,D"), ...denyOf(["Online"], "R")]),
    { ok: false, reason: `read-boundary-open: ${tilde} lacks CodexSandboxOnline write deny` });
  assert.deepEqual(await run(denyOf(BOTH, "W,D")), { ok: false, reason: `read-boundary-open: ${tilde} lacks CodexSandboxOffline deny` });
  assert.deepEqual(await run(denyOf(BOTH, "R,W")), { ok: true });
  // the other folders do not need a write deny
  assert.deepEqual(await RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(L.good) }), { ok: true });
});

test("denyAclCheck: a runner failure, a bad exit, a truncated or multi-entry listing all fail closed as read-check-failed", async (t) => {
  const L = protectedLayout(t);
  const failing = async () => { throw new Error("spawn icacls ENOENT"); };
  const a = await RC.denyAclCheck({ ctx: L.ctx, icacls: failing });
  assert.equal(a.ok, false);
  assert.match(a.reason, /^read-check-failed: .*ENOENT/);
  const b = await RC.denyAclCheck({ ctx: L.ctx, icacls: async () => ({ code: 5 }) });
  assert.match(b.reason, /^read-check-failed: /);
  const truncated = new Map([...L.good, [L.ctx.cfg, listing(L.ctx.cfg, denyOf(BOTH)).replace(/\n\nSuccessfully.*\n$/, "\n")]]);
  assert.match((await RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(truncated) })).reason, /^read-check-failed: /);
  const failedCount = new Map([...L.good, [L.ctx.cfg, listing(L.ctx.cfg, denyOf(BOTH)).replace("Failed processing 0", "Failed processing 1")]]);
  assert.match((await RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(failedCount) })).reason, /^read-check-failed: /);
  const two = new Map([...L.good, [L.ctx.cfg, fixture("icacls-denied.txt")]]);
  assert.match((await RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(two) })).reason, /^read-check-failed: /);
  const empty = new Map([...L.good, [L.ctx.cfg, ""]]);
  assert.match((await RC.denyAclCheck({ ctx: L.ctx, icacls: denyRunner(empty) })).reason, /^read-check-failed: /);
  assert.ok(!JSON.stringify([a, b]).includes(L.home), "no absolute user path in a reason");
});

test("denyAclCheck: real icacls (full System32 path, no /T) lists a temp folder with a child; it has no deny -> read-boundary-open", { skip: !win }, async (t) => {
  const { ctx } = setup(t);
  touch(path.join(ctx.cfg, "child.json"));
  const r = await RC.denyAclCheck({ ctx });
  assert.equal(r.ok, false);
  // a /T listing would have two entries (read-check-failed); one entry means the folder alone was listed
  assert.equal(r.reason, "read-boundary-open: ~\\.claude lacks CodexSandboxOffline deny");
});

// ---------------------------------------------------------------- setupLines

test("setupLines: deny lines for present targets only; creates %TEMP%\\claude first (A14)", (t) => {
  const { ctx, home } = setup(t);
  touch(path.join(home, ".ssh", "id_rsa"));
  touch(path.join(home, ".config", "gh", "hosts.yml"));
  touch(path.join(home, ".npmrc"));
  touch(path.join(home, ".netrc"));
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude")));
  const lines = setupLines({ ctx });
  assert.ok(fs.statSync(path.join(ctx.temp, "claude")).isDirectory(), "setup created %TEMP%\\claude");
  // per-user denies (Codex re-grants the group on every run); %TEMP%\claude also denies write and delete
  const folder = (d, r = "R") => `icacls "${d}" /deny "CodexSandboxOffline:(OI)(CI)(${r})" "CodexSandboxOnline:(OI)(CI)(${r})"`;
  const file = (f) => `icacls "${f}" /deny "CodexSandboxOffline:(R)" "CodexSandboxOnline:(R)"`;
  assert.deepEqual(lines, [
    folder(ctx.cfg), folder(path.join(ctx.temp, "claude"), "R,W,D"), folder(ctx.codexHome),
    folder(path.join(home, ".ssh")), folder(path.join(home, ".config", "gh")),
    file(path.join(home, ".npmrc")), file(path.join(home, ".netrc")),
  ]);
  // absent ones (.docker, .aws, .azure, .git-credentials, .pypirc) are not listed and not created
  assert.ok(!fs.existsSync(path.join(home, ".docker")));
  assert.ok(!fs.existsSync(path.join(home, ".azure")));
});

test("setupLines: an absent CODEX_HOME or CFG is skipped, not created", (t) => {
  const { ctx } = setup(t);
  fs.rmSync(ctx.codexHome, { recursive: true });
  const lines = setupLines({ ctx });
  assert.ok(!lines.some((l) => l.includes(ctx.codexHome)));
  assert.ok(!fs.existsSync(ctx.codexHome));
});

test("setupUndoLines: one `/remove:d` line per present target, for both sandbox users; creates nothing", (t) => {
  const { ctx, home } = setup(t);
  touch(path.join(home, ".ssh", "id_rsa"));
  touch(path.join(home, ".npmrc"));
  const undo = (x) => `icacls "${x}" /remove:d CodexSandboxOffline CodexSandboxOnline`;
  assert.deepEqual(RC.setupUndoLines({ ctx }), [undo(ctx.cfg), undo(ctx.codexHome), undo(path.join(home, ".ssh")), undo(path.join(home, ".npmrc"))]);
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude")), "undo lines never create %TEMP%\\claude");
  fs.mkdirSync(path.join(ctx.temp, "claude"));
  assert.ok(RC.setupUndoLines({ ctx }).includes(undo(path.join(ctx.temp, "claude"))));
});

// ---------------------------------------------------------------- versionGate

const okDeny = async () => ({ ok: true });
// versionGate with the host-side deny check stubbed (the real one runs icacls on the folders) and %TEMP%\claude present
// (the TEMP probe targets it); `noTempClaude` leaves it absent.
const vg = ({ noTempClaude, ...o }) => {
  if (!noTempClaude) fs.mkdirSync(path.join(o.ctx.temp, "claude"), { recursive: true });
  return versionGate({ denyCheck: okDeny, ...o });
};

const DISABLES = ["plugins", "apps", "browser_use", "in_app_browser", "computer_use"];
const FEATURES = DISABLES.map((n) => `${n}   experimental   false`);
const cleanScan = fakeIcacls(fixture("icacls-denied.txt"));

// A fake sandbox that really runs the check file (so a probe write can really land in a temp
// folder), except for files whose text contains one of WRAP_BLOCK's substrings (then it fails).
function wrapperBin(env) {
  const wrap = path.join(env.root, "blocking-wrap.mjs");
  fs.writeFileSync(wrap, [
    'import fs from "node:fs"; import { spawnSync } from "node:child_process";',
    "const argv = process.argv.slice(2);",
    'if (argv[0] !== "sandbox") {',
    `  const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_CODEX)}, ...argv], { stdio: "inherit", windowsHide: true });`,
    "  process.exit(r.status ?? 1);",
    "}",
    'const f = argv[argv.length - 1]; const text = fs.readFileSync(f, "utf8");',
    'if (process.env.WRAP_LOG) fs.appendFileSync(process.env.WRAP_LOG, JSON.stringify({ file: f, text }) + "\\n");',
    "const blocks = JSON.parse(process.env.WRAP_BLOCK || '[]');",
    "if (blocks.some((s) => text.includes(s))) process.exit(1);",
    'if (/echo R:/.test(text)) { const n = (text.match(/echo R:/g) || []).length; console.log("C:ok"); for (let i = 0; i < n; i++) console.log("D:" + i); console.log("END"); process.exit(0); }',
    // WRAP_NOCHCP simulates `chcp 65001` silently doing nothing; WRAP_V runs cmd with delayed expansion on
    'let g = f; if (process.env.WRAP_NOCHCP) { g = f + ".nochcp.cmd"; fs.writeFileSync(g, text.replace(/^chcp 65001>nul\\r?\\n/m, "")); }',
    'const flags = process.env.WRAP_V ? ["/d", "/v:on", "/c"] : ["/d", "/c"];',
    'const r = spawnSync(process.env.ComSpec, [...flags, g], { stdio: "inherit", windowsHide: true });',
    "process.exit(r.status ?? 1);",
    "",
  ].join("\n"));
  return { cmd: process.execPath, args: [wrap] };
}

// Real cmd.exe as the "sandbox" (so a readable file reads R and a mangled path reads D). Switches:
// env.REAL_V (delayed expansion on), REAL_NOCHCP (drop the chcp line), REAL_DETACHED (spawn detached).
function realBin(env) {
  const wrap = path.join(env.root, "real-cmd-wrap.mjs");
  fs.writeFileSync(wrap, [
    'import fs from "node:fs"; import { spawnSync } from "node:child_process";',
    'const f = process.argv[process.argv.length - 1]; let g = f;',
    'if (process.env.REAL_NOCHCP) { g = f + ".nochcp.cmd"; fs.writeFileSync(g, fs.readFileSync(f, "utf8").replace(/^chcp 65001>nul\\r?\\n/m, "")); }',
    'const flags = process.env.REAL_V ? ["/d", "/v:on", "/c"] : ["/d", "/c"];',
    'const r = spawnSync(process.env.ComSpec, [...flags, g], { encoding: "utf8", windowsHide: true, detached: !!process.env.REAL_DETACHED, stdio: ["ignore", "pipe", "pipe"] });',
    'process.stdout.write(r.stdout ?? ""); process.exit(r.status ?? 1);',
    "",
  ].join("\n"));
  return { cmd: process.execPath, args: [wrap] };
}

test("versionGate: all checks pass -> ok and the version is recorded", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES, version: "0.161.0" }, env);
  const r = await vg({ bin: bin(env), cwd, runId: "g1", env, ctx, icacls: cleanScan });
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.readFileSync(ctx.testedVersion, "utf8").trim(), "0.161.0");
  assert.ok(!fs.existsSync(path.join(ctx.temp, "codex-gate-g1.txt")));
  assert.ok(!fs.existsSync(path.join(path.dirname(cwd), "codex-gate-g1.txt")));
  assert.deepEqual(fs.readdirSync(path.join(ctx.temp, "claude")), [], "the gate leaves nothing in %TEMP%\\claude");
});

test("versionGate: the TEMP probe writes to %TEMP%\\claude (the Claude scratchpad root), not to the general %TEMP%", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify(["codex-gate-"]);
  env.WRAP_LOG = path.join(env.root, "wrap-tc.log");
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g-tc", env, ctx, icacls: cleanScan });
  assert.deepEqual(r, { ok: true });
  const texts = fs.readFileSync(env.WRAP_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
  const probes = texts.filter((x) => x.includes("codex-gate-"));
  assert.equal(probes.length, 2, "the TEMP probe and the outside-worktree probe");
  assert.ok(probes.some((x) => x.includes(path.join(ctx.temp, "claude", "codex-gate-g-tc.txt"))), probes.join("|"));
  assert.ok(!texts.some((x) => x.includes(path.join(ctx.temp, "codex-gate-"))), "the general %TEMP% write is an accepted residual: never probed");
});

test("versionGate: %TEMP%\\claude absent -> the TEMP probe is skipped (nothing to protect) and the gate creates no folder", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify(["codex-gate-"]);
  env.WRAP_LOG = path.join(env.root, "wrap-notc.log");
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g-notc", env, ctx, icacls: cleanScan, noTempClaude: true });
  assert.deepEqual(r, { ok: true });
  const texts = fs.readFileSync(env.WRAP_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
  assert.equal(texts.filter((x) => x.includes("codex-gate-")).length, 1, "only the outside-worktree probe");
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude")));
});

test("versionGate: the host-side deny check runs before the group check and the sandboxed read check; its failure blocks and records nothing", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  const order = [];
  const denyCheck = async (o) => { order.push(["deny", o?.ctx === ctx]); return { ok: false, reason: "read-boundary-open: ~\\.claude lacks CodexSandboxOffline deny" }; };
  const groupCheck = async () => { order.push(["group"]); return { ok: true }; };
  const r = await vg({ bin: bin(env), cwd, runId: "g-deny", env, ctx, icacls: cleanScan, denyCheck, groupCheck });
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /read-boundary-open: ~\\\.claude lacks CodexSandboxOffline deny/);
  assert.deepEqual(order, [["deny", true]], "group check and read check never ran");
  assert.ok(!fs.existsSync(ctx.testedVersion));
  const seq = [];
  const ok = await vg({ bin: bin(env), cwd, runId: "g-deny2", env, ctx, icacls: cleanScan,
    denyCheck: async () => { seq.push("deny"); return { ok: true }; }, groupCheck: async () => { seq.push("group"); return { ok: true }; } });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(seq, ["deny", "group"]);
});

test("versionGate: a sandbox user missing from CodexSandboxUsers (I2) -> codex-version-untested naming it, nothing recorded", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES, version: "0.161.0" }, env);
  const groupCheck = async () => ({ ok: false, reason: "read-boundary-open: CodexSandboxOnline not in CodexSandboxUsers" });
  const r = await vg({ bin: bin(env), cwd, runId: "g1b", env, ctx, icacls: cleanScan, groupCheck });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /CodexSandboxOnline not in CodexSandboxUsers/);
  assert.ok(!fs.existsSync(ctx.testedVersion));
  const ok = await vg({ bin: bin(env), cwd, runId: "g1c", env, ctx, icacls: cleanScan, groupCheck: async () => ({ ok: true }) });
  assert.deepEqual(ok, { ok: true });
});

test("versionGate: gateOpen -> codex-version-untested, nothing recorded", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES, gateOpen: true }, env);
  const r = await vg({ bin: bin(env), cwd, runId: "g2", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /temp/i);
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: a TEMP probe file that did get created is deleted and reported", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = "[]"; // nothing blocked: the write lands
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g3", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /temp/i);
  assert.match(r.detail, /created/i);
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude", "codex-gate-g3.txt")), "probe file removed");
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: an outside-worktree probe file that did get created is deleted and reported", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify([ctx.temp]); // TEMP write blocked, the worktree's parent is not
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g4", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /outside|parent/i);
  assert.match(r.detail, /created/i);
  assert.ok(!fs.existsSync(path.join(path.dirname(cwd), "codex-gate-g4.txt")), "probe file removed");
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: both probes blocked by the wrapper, control write works -> ok", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify(["codex-gate-"]);
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g5", env, ctx, icacls: cleanScan });
  assert.deepEqual(r, { ok: true });
  assert.ok(fs.existsSync(ctx.testedVersion));
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".codex-tmp", "g5")).filter((f) => !f.endsWith(".cmd")), [], "control file removed");
});

test("versionGate: a probe that fails because the sandbox itself is broken is not a pass (control)", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify(["codex-gate-", "ctl !"]); // even the in-worktree (control file) write fails
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g6", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /control/i);
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: a --disable name missing from `codex features list` blocks and is named", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES.filter((l) => !l.startsWith("browser_use")) }, env);
  const r = await vg({ bin: bin(env), cwd, runId: "g7", env, ctx, icacls: cleanScan });
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /browser_use/);
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: a name that only appears inside another feature's description does not count", async (t) => {
  const { env, ctx, cwd } = setup(t);
  const features = FEATURES.filter((l) => !l.startsWith("apps")).concat(["plugins_extra   stable   uses apps and more"]);
  scenario({ features }, env);
  const r = await vg({ bin: bin(env), cwd, runId: "g8", env, ctx, icacls: cleanScan });
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /\bapps\b/);
});

test("versionGate: read boundary open blocks; so does an ACL gap or a scan error", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  touch(path.join(home, ".npmrc"));
  scenario({ features: FEATURES, readOpen: [0] }, env);
  const a = await vg({ bin: bin(env), cwd, runId: "g9", env, ctx, icacls: cleanScan });
  assert.equal(a.reason, "codex-version-untested");
  assert.match(a.detail, /read-boundary-open: ~\\\.npmrc/);
  scenario({ features: FEATURES }, env);
  const b = await vg({ bin: bin(env), cwd, runId: "g10", env, ctx, icacls: fakeIcacls(fixture("icacls-missing.txt")) });
  assert.equal(b.reason, "codex-version-untested");
  assert.match(b.detail, /acl/i);
  const c = await vg({ bin: bin(env), cwd, runId: "g11", env, ctx, icacls: async () => ({ code: 5 }) });
  assert.equal(c.reason, "codex-version-untested");
  assert.match(c.detail, /acl/i);
  assert.ok(!fs.existsSync(ctx.testedVersion));
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome]), []);
});

test("versionGate: an unreadable version blocks instead of recording nothing silently", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES, version: "not-a-version" }, env);
  const r = await vg({ bin: bin(env), cwd, runId: "g12", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

// ================================================================ Fable review fixes (Task 6)
// Each test below failed before its fix (see the commit message); they pin the fail-closed rules:
// a path that cmd.exe mangles must never turn "not found" into a pass.

const HAZARDS = ["!", "%", "^", "&", "(", ")", " "];
const tmpOf = (cwd, runId) => path.join(cwd, ".codex-tmp", runId);
const runCmd = (flags, file) => spawnSync(process.env.ComSpec, [...flags, file], { encoding: "utf8", windowsHide: true });

// ---- 1. delayed expansion

test("readcheckCmd: line 2 switches delayed expansion off", () => {
  const text = readcheckCmd({ files: [{ n: 0, path: "C:\\x" }], sentinels: [] }, "C:\\w\\ctl.txt");
  assert.equal(text.split("\r\n")[0], "@echo off");
  assert.equal(text.split("\r\n")[1], "setlocal DisableDelayedExpansion");
});

test("readcheck.cmd under `cmd /d /v:on`: a readable path with ! reads R (not a mangled D)", { skip: !win }, (t) => {
  const { env } = setup(t);
  const dir = path.join(env.root, "d!v! dir");
  const file = path.join(dir, "a!b!c.txt");
  const ctl = path.join(dir, "ctl !%^&().txt");
  touch(file);
  touch(ctl);
  const cmdFile = path.join(dir, "check.cmd");
  fs.writeFileSync(cmdFile, readcheckCmd({ files: [{ n: 0, path: file }], sentinels: [] }, ctl), "utf8");
  const out = runCmd(["/d", "/v:on", "/c"], cmdFile).stdout;
  assert.match(out, /^R:0[ \t]*\r?$/m, out); // `echo R:0 || ...` leaves a trailing space
  assert.match(out, /^C:ok[ \t]*\r?$/m, out);
  assert.match(out, /^END\r?$/m, out);
});

test("runReadCheck under delayed expansion: a readable credential with ! in its path is reported open", { skip: !win }, async (t) => {
  const { env, ctx, cwd } = setup(t, { home: "h!x!y" });
  touch(path.join(ctx.codexHome, "auth.json"));
  env.REAL_V = "1";
  const r = await runReadCheck({ bin: realBin(env), cwd, runId: "run-bang", env, ctx });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^read-boundary-open: /);
  assert.ok(r.reason.includes("auth.json"), r.reason);
});

test("versionGate under delayed expansion: probe files with ! in the worktree path still work", { skip: !win }, async (t) => {
  const { env, ctx } = setup(t);
  const cwd = path.join(env.root, "wt!dir!");
  fs.mkdirSync(cwd);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify(["codex-gate-"]);
  env.WRAP_V = "1";
  env.WRAP_LOG = path.join(env.root, "wrap.log");
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g-bang", env, ctx, icacls: cleanScan });
  assert.deepEqual(r, { ok: true });
  const texts = fs.readFileSync(env.WRAP_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
  const probes = texts.filter((x) => x.includes("echo x>"));
  assert.equal(probes.length, 3);
  for (const p of probes) assert.equal(p.split("\r\n")[1], "setlocal DisableDelayedExpansion", p);
});

// ---- 2. the positive control

test("parseMarkers: the control is part of the contract (C:no / missing / duplicate)", () => {
  assert.deepEqual(parseMarkers("C:ok\nD:0\nEND\n", 1), { ok: true });
  for (const out of ["D:0\nEND\n", "C:ok\nC:ok\nD:0\nEND\n", "C:no\nD:0\nEND\n"]) {
    assert.deepEqual(parseMarkers(out, 1), { ok: false, reason: "read-check-failed" }, JSON.stringify(out));
  }
});

test("runReadCheck: control missing, duplicate or C:no -> read-check-failed, sentinels and control removed", async (t) => {
  for (const mode of ["none", "dup", "no"]) {
    const { env, ctx, cwd, home } = setup(t);
    fakeCreds(home, ctx);
    env.CTRL = mode;
    const r = await runReadCheck({ bin: bin(env), cwd, runId: `run-c-${mode}`, env, ctx });
    assert.deepEqual(r, { ok: false, reason: "read-check-failed" }, mode);
    assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome, path.join(home, ".ssh")]), [], mode);
    assert.deepEqual(fs.readdirSync(tmpOf(cwd, `run-c-${mode}`)).filter((f) => !f.endsWith(".cmd")), [], `${mode}: control file removed`);
  }
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  assert.deepEqual(await runReadCheck({ bin: bin(env), cwd, runId: "run-c-ok", env, ctx }), { ok: true });
});

test("runReadCheck: the control file is hazard-named, holds every non-ASCII char of the targets (deduped), exists during the run, is deleted after", async (t) => {
  const { env, ctx, cwd } = setup(t, { home: "h \u00e9\u4e2d\ud83d\ude00 \u00e9" });
  touch(path.join(ctx.codexHome, "auth.json"));
  const rec = path.join(env.root, "rec.json");
  const wrap = path.join(env.root, "rec-wrap.mjs");
  fs.writeFileSync(wrap, 'import fs from "node:fs"; const f = process.argv[process.argv.length - 1]; const text = fs.readFileSync(f, "utf8"); ' +
    'const m = /type "([^"]+)" >nul 2>nul && echo C:ok/.exec(text); const ctl = m ? m[1].replace(/%%/g, "%") : null; ' +
    `fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ ctl, exists: ctl ? fs.existsSync(ctl) : null })); ` + CLEAN_OUT + "\n");
  const r = await runReadCheck({ bin: { cmd: process.execPath, args: [wrap] }, cwd, runId: "run-ctl", env, ctx });
  assert.deepEqual(r, { ok: true });
  const { ctl, exists } = JSON.parse(fs.readFileSync(rec, "utf8"));
  assert.ok(ctl, "the check file has a control line");
  assert.equal(path.dirname(ctl), tmpOf(cwd, "run-ctl"));
  const name = path.basename(ctl);
  for (const ch of ["\u00e9", "\u4e2d", "\ud83d\ude00", ...HAZARDS]) assert.ok(name.includes(ch), `${JSON.stringify(ch)} in ${name}`);
  assert.equal([...name].filter((ch) => ch === "\u00e9").length, 1, "deduped");
  assert.equal(exists, true, "the control exists while the sandbox runs");
  assert.ok(!fs.existsSync(ctl), "the control is deleted afterwards");
});

test("runReadCheck: the control name caps the non-ASCII characters at 20", async (t) => {
  const many = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
  const { env, ctx, cwd } = setup(t, { home: "h" + many });
  const rec = path.join(env.root, "rec2.json");
  const wrap = path.join(env.root, "rec-wrap2.mjs");
  fs.writeFileSync(wrap, 'import fs from "node:fs"; const f = process.argv[process.argv.length - 1]; const text = fs.readFileSync(f, "utf8"); ' +
    `fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify(/type "([^"]+)" >nul 2>nul && echo C:ok/.exec(text)?.[1] ?? null)); ` + CLEAN_OUT + "\n");
  const r = await runReadCheck({ bin: { cmd: process.execPath, args: [wrap] }, cwd, runId: "run-cap", env, ctx });
  assert.deepEqual(r, { ok: true });
  const name = path.basename(JSON.parse(fs.readFileSync(rec, "utf8")));
  const non = [...name].filter((ch) => ch.codePointAt(0) > 127);
  assert.ok(non.length >= 1 && non.length <= 20, `${non.length} non-ASCII chars in ${name}`);
});

test("runReadCheck: chcp silently doing nothing + a readable non-ASCII target -> fails closed, never ok", { skip: !win }, async (t) => {
  const { env, ctx, cwd } = setup(t, { home: "h \u00e9t\u00e9" });
  touch(path.join(ctx.codexHome, "auth.json"));
  env.REAL_NOCHCP = "1";
  const r = await runReadCheck({ bin: realBin(env), cwd, runId: "run-nochcp", env, ctx });
  assert.deepEqual(r, { ok: false, reason: "read-check-failed" });
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome]), []);
});

test("runReadCheck: real cmd spawned detached (windowsHide, no console) + non-ASCII target -> never ok", { skip: !win }, async (t) => {
  const { env, ctx, cwd } = setup(t, { home: "h \u00e9t\u00e9 \u4e2d" });
  touch(path.join(ctx.codexHome, "auth.json"));
  env.REAL_DETACHED = "1";
  const r = await runReadCheck({ bin: realBin(env), cwd, runId: "run-detached", env, ctx });
  // The file is readable. With a working code page it reads R (open); without one the control
  // is mangled too (read-check-failed). A bare ok would mean "mangled path read as denied".
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^(read-check-failed|read-boundary-open: )/);
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome]), []);
});

test("runReadCheck: a sentinel name already taken -> read-check-failed; the other file is kept, ours are removed", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  const taken = path.join(ctx.codexHome, "codex-read-sentinel-run-taken.txt");
  fs.writeFileSync(taken, "a file that is not ours");
  const r = await runReadCheck({ bin: bin(env), cwd, runId: "run-taken", env, ctx });
  assert.deepEqual(r, { ok: false, reason: "read-check-failed" });
  assert.equal(fs.readFileSync(taken, "utf8"), "a file that is not ours", "a file we did not create is never deleted");
  assert.ok(!fs.existsSync(path.join(ctx.cfg, "codex-read-sentinel-run-taken.txt")), "the sentinel created before it is removed");
});

// ---- 4. readTargets inside the try

test("runReadCheck: a throw while building the targets (bad run id) is read-check-failed, not a throw", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  fakeCreds(home, ctx);
  for (const bad of ["bad id", "..", "", undefined]) {
    const r = await runReadCheck({ bin: bin(env), cwd, runId: bad, env, ctx });
    assert.deepEqual(r, { ok: false, reason: "read-check-failed" }, String(bad));
  }
});

// ---- 5. icacls by full path

test("icacls is spawned by full path under SystemRoot, like cmd.exe in argv.mjs", { skip: !win }, () => {
  assert.equal(RC.ICACLS_EXE, path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"));
  assert.ok(fs.existsSync(RC.ICACLS_EXE));
});

// ---- 3. aclScan tildes the home folder

test("aclScan: missing paths under the home folder come back as ~\\...; versionGate does not tilde twice", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  const p = path.join(ctx.cfg, "late.json");
  const text = `${p} HOST\\USER:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  const r = await aclScan({ ctx, dirs: [ctx.cfg], icacls: fakeIcacls(text) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["~\\.claude\\late.json"]);
  assert.ok(!JSON.stringify(r).includes(home), "no absolute user path");
  scenario({ features: FEATURES }, env);
  const g = await vg({ bin: bin(env), cwd, runId: "g-tilde", env, ctx, icacls: fakeIcacls(text) });
  assert.equal(g.reason, "codex-version-untested");
  assert.ok(g.detail.includes("~\\.claude\\late.json") && !g.detail.includes(home) && !g.detail.includes("~\\~"), g.detail);
});

// ---- 6. icacls ACE parsing

test("parseIcacls: IO in any flag group is inherit-only; comma-list rights parse", () => {
  const covered = (tail) => coveredBy(perUser(tail));
  assert.ok(!covered("(OI)(CI)(IO)(DENY)(R,GR)"), "inherit-only comma list");
  assert.ok(covered("(DENY)(R,GR)"));
  assert.ok(covered("(OI)(CI)(DENY)(R,GR)"));
  assert.ok(covered("(DENY)(GR,R)"));
  assert.ok(!covered("(DENY)(IO)(R)"), "IO after DENY");
  assert.ok(!covered("(DENY)(OI,IO)(R)"), "IO inside a comma group");
  assert.ok(!covered("(OI)(CI)(DENY)(IO,R)"), "IO inside the rights group");
  assert.ok(!covered("(DENY)(W,D)"), "write-only comma list");
});

test("parseIcacls: a localized summary line is an error (cannot be verified)", () => {
  const r = parseIcacls(fixture("icacls-denied-de.txt"));
  assert.equal(r.error, true);
});

test("parseIcacls: an entry named CodexSandboxOffline/Online does not spoof a deny", () => {
  for (const name of ["CodexSandboxOffline", "CodexSandboxOnline", "CodexSandboxUsers"]) {
    const p = `C:\\x\\${name}`;
    const pad = " ".repeat(p.length + 1);
    const out = (first, second, third = "HOST\\USER:(F)") => `${p} ${first}\n${pad}${second}\n${pad}${third}${SUM1}`;
    assert.deepEqual(parseIcacls(out("HOST\\USER:(F)", "BUILTIN\\Administrators:(F)")), { missing: [p], error: false });
    assert.deepEqual(parseIcacls(out("HOST\\Other:(DENY)(R)", "HOST\\USER:(F)")), { missing: [p], error: false });
    // single-ACE entry whose path ends in the account name
    assert.deepEqual(parseIcacls(`${p} HOST\\USER:(F)${SUM1}`), { missing: [p], error: false });
    // a real pair of denies on such an entry still counts
    assert.deepEqual(parseIcacls(out(...perUser("(DENY)(R)"))), { missing: [], error: false });
  }
});

test("aclScan: a file named CodexSandboxOffline inside a scanned folder is reported, not trusted", async (t) => {
  const { ctx } = setup(t);
  const p = path.join(ctx.cfg, "CodexSandboxOffline");
  const text = `${p} HOST\\USER:(F)\n${" ".repeat(p.length + 1)}BUILTIN\\Administrators:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  const r = await aclScan({ ctx, dirs: [ctx.cfg], icacls: fakeIcacls(text) });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1);
  assert.ok(!fs.existsSync(ctx.aclState));
});

// ---- 2 (gate). the version-gate control

test("versionGate: the control write uses a hazard-named file, removed afterwards", async (t) => {
  const { env, ctx, cwd } = setup(t, { home: "h \u00e9t\u00e9" });
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify(["codex-gate-"]);
  env.WRAP_LOG = path.join(env.root, "wrap2.log");
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g-ctl", env, ctx, icacls: cleanScan });
  assert.deepEqual(r, { ok: true });
  const texts = fs.readFileSync(env.WRAP_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
  const control = texts.find((x) => x.includes("echo x>") && !x.includes("codex-gate-"));
  const target = /echo x> "([^"]+)"/.exec(control)[1].replace(/%%/g, "%");
  const name = path.basename(target);
  for (const ch of ["\u00e9", ...HAZARDS]) assert.ok(name.includes(ch), `${JSON.stringify(ch)} in ${name}`);
  assert.deepEqual(fs.readdirSync(tmpOf(cwd, "g-ctl")).filter((f) => !f.endsWith(".cmd")), []);
});

test("versionGate: chcp doing nothing + a non-ASCII TEMP -> the control write fails the gate (a probe write is not 'blocked')", { skip: !win }, async (t) => {
  const { env, ctx, cwd } = setup(t, { home: "h \u00e9t\u00e9" });
  scenario({ features: FEATURES }, env);
  // only the outside-worktree probe is blocked by the fake sandbox; the TEMP probe is left to real
  // cmd.exe, which (without a code page) writes into a mangled folder and "fails" harmlessly
  env.WRAP_BLOCK = JSON.stringify([path.dirname(cwd) + path.sep + "codex-gate-"]);
  env.WRAP_NOCHCP = "1";
  const r = await vg({ bin: wrapperBin(env), cwd, runId: "g-nochcp", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /control/i);
  assert.ok(!fs.existsSync(ctx.testedVersion));
});
