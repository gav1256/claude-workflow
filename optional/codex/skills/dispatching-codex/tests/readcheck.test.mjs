// Task 6: the read-boundary check, the ACL scan, --setup lines and the new-version gate.
// Safety: every path is a temp folder this test creates; the fake codex stands in for codex.exe;
// icacls is injected (the one real icacls call only LISTS a temp folder). No ACL is ever changed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
const bin = (env) => ({ cmd: env.CODEX_RUN_BIN, args: JSON.parse(env.CODEX_RUN_BIN_ARGS) });

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
    "@echo off\r\n" +
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
  assert.deepEqual(parseMarkers("D:0\nD:1\nD:2\nEND\n", 3), { ok: true });
  assert.deepEqual(parseMarkers("D:0\r\nD:1\r\nEND\r\n", 2), { ok: true });
  assert.deepEqual(parseMarkers("END\n", 0), { ok: true });
});

test("parseMarkers: any R: is read-boundary-open and lists the open indexes", () => {
  const r = parseMarkers("D:0\nR:1\nD:2\nR:3\nEND\n", 4);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^read-boundary-open: /);
  assert.deepEqual(r.open, [1, 3]);
});

test("parseMarkers: missing, extra, duplicate, no END, marker after END, empty are read-check-failed", () => {
  const bad = [
    ["D:0\nEND\n", 2], // missing 1
    ["D:0\nD:1\nD:2\nEND\n", 2], // extra index
    ["D:0\nD:0\nD:1\nEND\n", 2], // duplicate
    ["D:0\nR:0\nD:1\nEND\n", 2], // same index both ways
    ["D:0\nD:1\n", 2], // no END
    ["D:0\nEND\nD:1\n", 2], // marker after END
    ["", 1],
    ["garbage\n", 1],
    ["D:0\nD:1\nEND\nEND\n", 2], // END twice
  ];
  for (const [out, n] of bad) {
    const r = parseMarkers(out, n);
    assert.equal(r.ok, false, JSON.stringify(out));
    assert.equal(r.reason, "read-check-failed", JSON.stringify(out));
  }
});

test("parseMarkers: a duplicate open marker still fails closed (never reports ok)", () => {
  const r = parseMarkers("R:0\nR:0\nEND\n", 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "read-check-failed");
});

test("parseMarkers: unrelated lines (a banner) are ignored", () => {
  assert.deepEqual(parseMarkers("codex sandbox starting\nD:0\nEND\n", 1), { ok: true });
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
    'const f = process.argv[process.argv.length - 1]; const n = (fs.readFileSync(f, "utf8").match(/echo R:/g) || []).length; ' +
    'for (let i = 0; i < n; i++) console.log("D:" + i); console.log("END"); process.exit(1);\n');
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
    'const f = process.argv[process.argv.length - 1]; const n = (fs.readFileSync(f, "utf8").match(/echo R:/g) || []).length; ' +
    'for (let i = 0; i < n; i++) console.log("D:" + i); console.log("END");\n');
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

test("parseIcacls: only a DENY of a read right for CodexSandboxUsers counts", () => {
  const p = "C:\\x\\f.txt";
  const pad = " ".repeat(p.length + 1);
  const one = (ace) => `${p} ${ace}\n${pad}HOST\\USER:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  const ok = (ace) => parseIcacls(one(ace)).missing.length === 0;
  assert.ok(ok("HOST\\CodexSandboxUsers:(DENY)(R)"));
  assert.ok(ok("HOST\\CodexSandboxUsers:(I)(DENY)(R)"));
  assert.ok(ok("HOST\\CodexSandboxUsers:(OI)(CI)(DENY)(R)"));
  assert.ok(ok("HOST\\CodexSandboxUsers:(I)(DENY)(RX)"));
  assert.ok(ok("CodexSandboxUsers:(DENY)(R)"));
  assert.ok(!ok("HOST\\CodexSandboxUsers:(I)(M)")); // allow
  assert.ok(!ok("HOST\\CodexSandboxUsers:(DENY)(W)")); // denies writes only
  assert.ok(!ok("HOST\\CodexSandboxUsers:(DENY)(RC)")); // read-control is not read
  assert.ok(!ok("HOST\\OtherUsers:(DENY)(R)")); // other group
  assert.ok(!ok("HOST\\NotCodexSandboxUsers:(DENY)(R)")); // account name must match whole
  assert.ok(!ok("HOST\\CodexSandboxUsers:(OI)(CI)(IO)(DENY)(R)")); // inherit-only: not on this object
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
  const folder = (d) => `icacls "${d}" /deny "CodexSandboxUsers:(OI)(CI)(R)"`;
  const file = (f) => `icacls "${f}" /deny "CodexSandboxUsers:(R)"`;
  assert.deepEqual(lines, [
    folder(ctx.cfg), folder(path.join(ctx.temp, "claude")), folder(ctx.codexHome),
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

// ---------------------------------------------------------------- versionGate

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
    "const blocks = JSON.parse(process.env.WRAP_BLOCK || '[]');",
    "if (blocks.some((s) => text.includes(s))) process.exit(1);",
    'if (/echo R:/.test(text)) { const n = (text.match(/echo R:/g) || []).length; for (let i = 0; i < n; i++) console.log("D:" + i); console.log("END"); process.exit(0); }',
    'const r = spawnSync(process.env.ComSpec, ["/d", "/c", f], { stdio: "inherit", windowsHide: true });',
    "process.exit(r.status ?? 1);",
    "",
  ].join("\n"));
  return { cmd: process.execPath, args: [wrap] };
}

test("versionGate: all checks pass -> ok and the version is recorded", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES, version: "0.161.0" }, env);
  const r = await versionGate({ bin: bin(env), cwd, runId: "g1", env, ctx, icacls: cleanScan });
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.readFileSync(ctx.testedVersion, "utf8").trim(), "0.161.0");
  assert.ok(!fs.existsSync(path.join(ctx.temp, "codex-gate-g1.txt")));
  assert.ok(!fs.existsSync(path.join(path.dirname(cwd), "codex-gate-g1.txt")));
  assert.ok(!fs.existsSync(path.join(ctx.temp, "claude")), "the gate creates no protected folder");
});

test("versionGate: gateOpen -> codex-version-untested, nothing recorded", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES, gateOpen: true }, env);
  const r = await versionGate({ bin: bin(env), cwd, runId: "g2", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /temp/i);
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: a TEMP probe file that did get created is deleted and reported", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = "[]"; // nothing blocked: the write lands
  const r = await versionGate({ bin: wrapperBin(env), cwd, runId: "g3", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /temp/i);
  assert.match(r.detail, /created/i);
  assert.ok(!fs.existsSync(path.join(ctx.temp, "codex-gate-g3.txt")), "probe file removed");
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: an outside-worktree probe file that did get created is deleted and reported", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify([ctx.temp]); // TEMP write blocked, the worktree's parent is not
  const r = await versionGate({ bin: wrapperBin(env), cwd, runId: "g4", env, ctx, icacls: cleanScan });
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
  const r = await versionGate({ bin: wrapperBin(env), cwd, runId: "g5", env, ctx, icacls: cleanScan });
  assert.deepEqual(r, { ok: true });
  assert.ok(fs.existsSync(ctx.testedVersion));
  assert.ok(!fs.existsSync(path.join(cwd, ".codex-tmp", "g5", "control.txt")), "control file removed");
});

test("versionGate: a probe that fails because the sandbox itself is broken is not a pass (control)", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES }, env);
  env.WRAP_BLOCK = JSON.stringify(["codex-gate-", "control"]); // even the in-worktree write fails
  const r = await versionGate({ bin: wrapperBin(env), cwd, runId: "g6", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /control/i);
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: a --disable name missing from `codex features list` blocks and is named", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES.filter((l) => !l.startsWith("browser_use")) }, env);
  const r = await versionGate({ bin: bin(env), cwd, runId: "g7", env, ctx, icacls: cleanScan });
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /browser_use/);
  assert.ok(!fs.existsSync(ctx.testedVersion));
});

test("versionGate: a name that only appears inside another feature's description does not count", async (t) => {
  const { env, ctx, cwd } = setup(t);
  const features = FEATURES.filter((l) => !l.startsWith("apps")).concat(["plugins_extra   stable   uses apps and more"]);
  scenario({ features }, env);
  const r = await versionGate({ bin: bin(env), cwd, runId: "g8", env, ctx, icacls: cleanScan });
  assert.equal(r.reason, "codex-version-untested");
  assert.match(r.detail, /\bapps\b/);
});

test("versionGate: read boundary open blocks; so does an ACL gap or a scan error", async (t) => {
  const { env, ctx, cwd, home } = setup(t);
  touch(path.join(home, ".npmrc"));
  scenario({ features: FEATURES, readOpen: [0] }, env);
  const a = await versionGate({ bin: bin(env), cwd, runId: "g9", env, ctx, icacls: cleanScan });
  assert.equal(a.reason, "codex-version-untested");
  assert.match(a.detail, /read-boundary-open: ~\\\.npmrc/);
  scenario({ features: FEATURES }, env);
  const b = await versionGate({ bin: bin(env), cwd, runId: "g10", env, ctx, icacls: fakeIcacls(fixture("icacls-missing.txt")) });
  assert.equal(b.reason, "codex-version-untested");
  assert.match(b.detail, /acl/i);
  const c = await versionGate({ bin: bin(env), cwd, runId: "g11", env, ctx, icacls: async () => ({ code: 5 }) });
  assert.equal(c.reason, "codex-version-untested");
  assert.match(c.detail, /acl/i);
  assert.ok(!fs.existsSync(ctx.testedVersion));
  assert.deepEqual(sentinelsLeft([ctx.cfg, ctx.codexHome]), []);
});

test("versionGate: an unreadable version blocks instead of recording nothing silently", async (t) => {
  const { env, ctx, cwd } = setup(t);
  scenario({ features: FEATURES, version: "not-a-version" }, env);
  const r = await versionGate({ bin: bin(env), cwd, runId: "g12", env, ctx, icacls: cleanScan });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "codex-version-untested");
  assert.ok(!fs.existsSync(ctx.testedVersion));
});
