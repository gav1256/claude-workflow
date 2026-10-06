// The read boundary (spec Part 2 step 1, Part 9): a zero-token check, run inside `codex sandbox`,
// that every known credential file and a fresh sentinel in every protected folder read as DENIED;
// the host-side ACL scan (icacls /T, ACLs only, never contents); the `--setup` deny lines; and the
// new-version gate.
//
// Safety rules this file keeps:
//   - Credential files are only ever stat()ed here (existence), never opened by this script. The
//     sandboxed `type ... >nul` is the one thing that tries to read them, and it prints markers only.
//   - A run never creates a protected folder: sentinels go only into folders that already exist.
//     The one exception is `setupLines()` (`--setup`), which creates %TEMP%\claude so its deny line
//     can be printed (A14).
//   - Nothing here changes an ACL. `icacls` is only used to LIST. The user runs the deny lines.
//   - Every function takes an optional `ctx` ({home, cfg, codexHome, temp, aclState, testedVersion})
//     and `env`; the defaults are the real paths from paths.mjs, so production callers pass nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, CODEX_HOME, REAL_TEMP, ACL_STATE, TESTED_VERSION, atomicWriteJson } from "./paths.mjs";
import { sandboxArgs, execArgs, cmdFileText } from "./argv.mjs";
import { codexVersion } from "./binary.mjs";

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SENTINEL_TEXT = "codex read-boundary sentinel: safe to delete\r\n";
const ACL_SCAN_MAX_AGE_MS = 24 * 3600 * 1000;

function mkCtx(c = {}) {
  return {
    home: c.home ?? os.homedir(),
    cfg: c.cfg ?? CFG,
    codexHome: c.codexHome ?? CODEX_HOME,
    temp: c.temp ?? REAL_TEMP,
    aclState: c.aclState ?? ACL_STATE,
    testedVersion: c.testedVersion ?? TESTED_VERSION,
  };
}

function checkRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId) || runId.includes("..")) {
    throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  }
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// "~\rest" for a path under the home folder (no absolute user path in a reason), else as is.
function tilde(p, home) {
  const h = home.replace(/[\\/]+$/, "");
  const lp = p.toLowerCase();
  const lh = h.toLowerCase();
  if (lp === lh) return "~";
  if (lp.startsWith(lh + "\\") || lp.startsWith(lh + "/")) return "~\\" + p.slice(h.length + 1).replace(/\//g, "\\");
  return p;
}

// ---------------------------------------------------------------------------- targets

// Credential folders under the home folder, in the spec's order.
const CRED_FOLDERS = [[".ssh"], [".config", "gh"], [".docker"], [".aws"], [".azure"]];
// Credential files directly under the home folder that get a file deny (`--setup`).
const CRED_HOME_FILES = [".git-credentials", ".npmrc", ".pypirc", ".netrc"];

function protectedFolders(c) {
  const all = [c.cfg, c.codexHome, path.join(c.temp, "claude"), ...CRED_FOLDERS.map((p) => path.join(c.home, ...p))];
  const seen = new Set();
  return all.filter((d) => {
    const k = d.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return isDir(d);
  });
}

/**
 * The targets of the read check, existing ones only (existence is a stat, never an open):
 * `files` (known credential files, spec:228-234) and `sentinels` (one fresh file name per
 * protected folder that exists). Indexes `n` run over files then sentinels. Creates nothing.
 */
export function readTargets({ runId, ctx } = {}) {
  checkRunId(runId);
  const c = mkCtx(ctx);
  const candidates = [
    path.join(c.codexHome, "auth.json"),
    path.join(c.cfg, ".credentials.json"),
    path.join(c.home, ".git-credentials"),
    path.join(c.home, ".config", "gh", "hosts.yml"),
    path.join(c.home, ".docker", "config.json"),
    path.join(c.home, ".npmrc"),
    path.join(c.home, ".pypirc"),
    path.join(c.home, ".netrc"),
    path.join(c.home, ".aws", "credentials"),
  ];
  const sshDir = path.join(c.home, ".ssh");
  try {
    for (const f of fs.readdirSync(sshDir).filter((x) => x.startsWith("id_")).sort()) candidates.push(path.join(sshDir, f));
  } catch { /* no ~/.ssh */ }
  const files = candidates.filter(isFile).map((p, n) => ({ n, path: p }));
  const sentinels = protectedFolders(c).map((dir, i) => ({
    n: files.length + i, dir, path: path.join(dir, `codex-read-sentinel-${runId}.txt`),
  }));
  return { files, sentinels };
}

// ---------------------------------------------------------------------------- the check file

// A path inside a double-quoted batch argument: `%` is doubled (batch expansion), and a character
// that could end the quote or the line is refused (Windows paths cannot hold them anyway).
function bq(p) {
  if (/["\r\n\0]/.test(p)) throw new Error(`unsafe character in path: ${JSON.stringify(p)}`);
  return p.replace(/%/g, "%%");
}
const NON_ASCII = /[^\x00-\x7f]/;
const CONTROL_MAX_CHARS = 20;

/**
 * File name of a positive-control file: it holds every distinct non-ASCII character found in
 * `paths` (first ones, capped) plus the ASCII hazards ! % ^ & ( ) and a space. If cmd.exe
 * can open a file with this name, it can open the targets whose paths use those characters:
 * a mangled path (no code page, delayed expansion, a ^ or %) reads as "not found", which looks
 * exactly like "denied", so every "denied" is only believed next to a control that read fine.
 */
export function controlName(paths) {
  const seen = new Set();
  for (const p of paths) {
    for (const ch of String(p)) {
      if (ch.codePointAt(0) > 127 && seen.size < CONTROL_MAX_CHARS) seen.add(ch);
    }
  }
  return "ctl !%^&() " + [...seen].join("") + ".txt";
}

/**
 * Text of `readcheck.cmd`: delayed expansion off (line 2: a ! in a path must not be eaten, even
 * under `cmd /v:on`), `chcp 65001` when a path is not ASCII (the file is written as UTF-8), the
 * control line `type "<control>" ... && echo C:ok || echo C:no` (when `control` is given), per target
 * `type "<path>" >nul 2>nul && echo R:<n> || echo D:<n>` (markers only, never contents), then
 * `echo END`. CRLF.
 */
export function readcheckCmd(targets, control) {
  const all = [...targets.files, ...targets.sentinels];
  const lines = ["@echo off", "setlocal DisableDelayedExpansion"];
  if (all.some((t) => NON_ASCII.test(t.path)) || (control && NON_ASCII.test(control))) lines.push("chcp 65001>nul");
  if (control) lines.push(`type "${bq(control)}" >nul 2>nul && echo C:ok || echo C:no`);
  for (const t of all) lines.push(`type "${bq(t.path)}" >nul 2>nul && echo R:${t.n} || echo D:${t.n}`);
  lines.push("echo END");
  return lines.join("\r\n") + "\r\n";
}

/**
 * Exactly one `C:ok` (the positive control: the check could read a file named with the same
 * hazard characters), every index 0..count-1 exactly once as `R:` or `D:`, then exactly one `END`.
 * Other lines (a banner) are ignored. A missing, duplicate or `C:no` control, a missing, extra or
 * duplicate marker, a marker after END or no END -> `read-check-failed` (the control outranks an
 * `R:`: with a mangled-path check nothing it prints can be believed). Otherwise any `R:` ->
 * `read-boundary-open: <indexes>` with `open` (the caller maps indexes to paths).
 */
export function parseMarkers(stdout, count) {
  const fail = { ok: false, reason: "read-check-failed" };
  const seen = new Map();
  const controls = [];
  let end = false;
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "END") {
      if (end) return fail;
      end = true;
      continue;
    }
    const c = /^C:(ok|no)$/.exec(line);
    if (c) {
      if (end) return fail;
      controls.push(c[1]);
      continue;
    }
    const m = /^([RD]):(\d+)$/.exec(line);
    if (!m) continue;
    if (end) return fail;
    const n = Number(m[2]);
    if (n >= count || seen.has(n)) return fail;
    seen.set(n, m[1]);
  }
  if (!end || seen.size !== count) return fail;
  if (controls.length !== 1 || controls[0] !== "ok") return fail;
  const open = [...seen].filter(([, v]) => v === "R").map(([n]) => n).sort((a, b) => a - b);
  if (open.length) return { ok: false, reason: `read-boundary-open: ${open.join(", ")}`, open };
  return { ok: true };
}

// ---------------------------------------------------------------------------- processes

// Run a program with stdin closed, no window, output captured (capped), a hard timeout.
function runProc(cmd, args, { env = process.env, cwd, timeoutMs = 120000, maxOut = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, error: e.message, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let error = null;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, error, stdout, stderr });
    };
    const timer = setTimeout(() => {
      error = `timeout after ${timeoutMs} ms`;
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < maxOut) stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { if (stderr.length < maxOut) stderr += d.toString("utf8"); });
    child.on("error", (e) => { error = e.message; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

const runSandbox = (bin, { profile, cwd, cmdFile }, o) =>
  runProc(bin.cmd, [...(bin.args ?? []), ...sandboxArgs({ profile, cwd, cmdFile })], { env: o.env, timeoutMs: o.timeoutMs });

const rmQuiet = (p) => { try { fs.rmSync(p, { force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } };

// ---------------------------------------------------------------------------- the sandbox group (I2)

// By full path, like icacls: never a PATH search for the program that lists the group.
const NET_EXE = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "net.exe");
const SANDBOX_USERS = ["CodexSandboxOffline", "CodexSandboxOnline"];
const MEMBER_RE = /^(?:.*\\)?CodexSandbox(Offline|Online)$/i;

// The default runner. CODEX_RUN_NET_FIXTURE (a JSON file {code, stdout}) replaces net.exe in tests.
async function netRun(exe, args) {
  const fx = process.env.CODEX_RUN_NET_FIXTURE;
  if (fx) {
    const j = JSON.parse(fs.readFileSync(fx, "utf8"));
    return { code: j.code ?? 0, stdout: String(j.stdout ?? ""), stderr: "", error: null };
  }
  return runProc(exe, args, { timeoutMs: 30000 });
}

/**
 * The read check runs as the offline sandbox user only; the network sandbox user is covered by the read-deny ACEs
 * because both accounts belong to CodexSandboxUsers. This runs `net.exe localgroup CodexSandboxUsers` and requires
 * exit 0 plus a member line for BOTH CodexSandboxOffline and CodexSandboxOnline (bare or DOMAIN\name). A missing
 * member is `read-boundary-open: <user> not in CodexSandboxUsers`; an error, a non-zero exit or a throwing runner
 * is `read-check-failed: ...`; output that lists neither member (localized or garbage) fails closed as open.
 * `run(exe, args)` is injectable and returns `{ code, stdout, stderr, error }`.
 */
export async function sandboxGroupCheck({ run = netRun, exe = NET_EXE() } = {}) {
  let r;
  try {
    r = await run(exe, ["localgroup", "CodexSandboxUsers"]);
  } catch (e) {
    return { ok: false, reason: `read-check-failed: net.exe: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}` };
  }
  if (!r || r.error) return { ok: false, reason: `read-check-failed: net.exe: ${String(r?.error ?? "no result").slice(0, 120)}` };
  if (r.code !== 0) return { ok: false, reason: `read-check-failed: net.exe exited ${r.code}` };
  const found = new Set();
  for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
    const m = MEMBER_RE.exec(line.trim());
    if (m) found.add(m[1].toLowerCase());
  }
  for (const u of SANDBOX_USERS) {
    if (!found.has(u.slice("CodexSandbox".length).toLowerCase())) {
      return { ok: false, reason: `read-boundary-open: ${u} not in CodexSandboxUsers` };
    }
  }
  return { ok: true };
}

/**
 * The read-boundary check, every run: one `codex sandbox -P :read-only` call over
 * `<cwd>\.codex-tmp\<runId>\readcheck.cmd`. Sentinels are created here (only in existing folders,
 * never overwriting) and always deleted in `finally`, as is the control file. Fails closed: any problem other than a clean
 * all-denied marker set is `{ ok: false, reason }`.
 */
export async function runReadCheck({ bin, cwd, runId, env = process.env, ctx, timeoutMs = 120000 } = {}) {
  const c = mkCtx(ctx);
  const created = [];
  try {
    const targets = readTargets({ runId, ctx });
    for (const s of targets.sentinels) {
      let fd;
      try {
        fd = fs.openSync(s.path, "wx"); // never overwrites; no mkdir: the folder exists
        created.push(s.path);
        fs.writeSync(fd, SENTINEL_TEXT);
      } catch (e) {
        if (fd !== undefined && !created.includes(s.path)) created.push(s.path);
        return { ok: false, reason: "read-check-failed" };
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      }
    }
    const runTmp = path.join(cwd, ".codex-tmp", runId);
    fs.mkdirSync(runTmp, { recursive: true });
    // the positive control: readable by construction, named with the hazards of the targets' paths
    const all = [...targets.files, ...targets.sentinels];
    const control = path.join(runTmp, controlName(all.map((x) => x.path)));
    fs.writeFileSync(control, "codex read-check control: safe to delete\r\n");
    created.push(control);
    const cmdFile = path.join(runTmp, "readcheck.cmd");
    fs.writeFileSync(cmdFile, readcheckCmd(targets, control), "utf8");
    const r = await runSandbox(bin, { profile: ":read-only", cwd, cmdFile }, { env, timeoutMs });
    if (r.error || r.code !== 0) return { ok: false, reason: "read-check-failed" };
    const m = parseMarkers(r.stdout, all.length);
    if (m.ok) return { ok: true };
    if (m.open) {
      const byN = new Map(all.map((t) => [t.n, t.path]));
      return { ok: false, reason: `read-boundary-open: ${m.open.map((n) => tilde(byN.get(n), c.home)).join(", ")}` };
    }
    return { ok: false, reason: m.reason };
  } catch {
    return { ok: false, reason: "read-check-failed" };
  } finally {
    for (const p of created) rmQuiet(p);
  }
}

// ---------------------------------------------------------------------------- icacls parsing

const SUMMARY_RE = /^Successfully processed (\d+) files?; Failed processing (\d+) files?$/;
const ACE_TAIL_RE = /:((?:\([^)]*\))+)\s*$/;
// Rights that make a deny block reads: R, RX (read and execute), GR/GA (generic), F (full), RD (read data).
const READ_RIGHTS = new Set(["R", "RX", "GR", "GA", "F", "RD"]);

// Does this ACE line deny read to CodexSandboxUsers on the object itself?
function aceDeniesRead(line, tail) {
  if (!/(?:^|[\s\\])CodexSandboxUsers$/i.test(line.slice(0, tail.index))) return false;
  const groups = [...tail[1].matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  const i = groups.indexOf("DENY");
  if (i < 0) return false;
  if (groups.some((g) => g.split(",").includes("IO"))) return false; // inherit-only (IO anywhere): not this object
  return groups.slice(i + 1).flatMap((g) => g.split(",")).some((r) => READ_RIGHTS.has(r));
}

/**
 * Incremental parser for `icacls <dir> /T /C` output (a big scan streams into it line by line).
 * An entry is a non-indented line (path + first ACE) plus indented ACE lines, blank-line
 * separated. An entry lacks protection when none of its ACEs is a CodexSandboxUsers DENY of read.
 * Anything it cannot read (an error line, a stray line, a summary with failures, no summary at
 * all) sets `error`: the callers block on it.
 */
export function createIcaclsParser() {
  const missing = [];
  let error = false;
  let summary = false;
  let cur = null;
  const entryPath = (e) => {
    if (e.indent != null) return e.first.slice(0, e.indent).trimEnd();
    // single-ACE entry: no continuation line to read the column from; cut the trailing ACE off
    return e.first.replace(/\s+\S+:(?:\([^)]*\))+\s*$/, "").replace(/ NT$/, "");
  };
  const close = () => {
    if (cur && !cur.denied) missing.push(entryPath(cur));
    cur = null;
  };
  return {
    push(raw) {
      const line = String(raw).replace(/\r$/, "");
      if (line.trim() === "") { close(); return; }
      const s = SUMMARY_RE.exec(line.trim());
      if (s) {
        close();
        summary = true;
        if (Number(s[2]) > 0) error = true;
        return;
      }
      const tail = ACE_TAIL_RE.exec(line);
      if (/^\s/.test(line)) {
        if (!cur || !tail) { error = true; return; }
        if (cur.indent == null) cur.indent = /^ */.exec(line)[0].length;
        if (aceDeniesRead(line, tail)) cur.denied = true;
        return;
      }
      close();
      if (!tail) { error = true; return; } // e.g. "<path>: Access is denied."
      cur = { first: line, indent: null, denied: aceDeniesRead(line, tail) };
    },
    end() {
      close();
      if (!summary) error = true; // truncated output
      return { missing, error };
    },
  };
}

/** `{ missing: string[] (paths lacking the deny), error: boolean }` for a whole icacls output. */
export function parseIcacls(text) {
  const p = createIcaclsParser();
  for (const l of String(text ?? "").split("\n")) p.push(l);
  return p.end();
}

// ---------------------------------------------------------------------------- the ACL scan

// By full path, like cmd.exe in argv.mjs: never a PATH search for a program that lists ACLs.
export const ICACLS_EXE = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");

// Default runner: `icacls "<dir>" /T /C` (listing only), lines streamed to onLine. A scan of the
// config folder can take more than 5 minutes, so the timeout is long.
function icaclsList(dir, onLine, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ICACLS_EXE, [dir, "/T", "/C"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    const feed = (stream) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      stream.on("end", () => { if (buf) onLine(buf); });
    };
    feed(child.stdout);
    feed(child.stderr);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      reject(new Error(`icacls timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code }); });
  });
}

/**
 * Host-side ACL scan: `icacls "<dir>" /T /C` for each protected folder that EXISTS (the list is
 * overridable with `dirs`; the runner with `icacls(dir, onLine) => Promise<{code}>`). Entries
 * lacking the CodexSandboxUsers read deny are returned in `missing`. A clean, complete scan
 * records `last_complete` in the ACL state file; a scan with a gap or an error records nothing.
 */
export async function aclScan({ ctx, dirs, icacls = icaclsList } = {}) {
  const c = mkCtx(ctx);
  const list = dirs ?? protectedFolders(c);
  const missing = [];
  for (const dir of list) {
    const parser = createIcaclsParser();
    let res;
    try {
      res = await icacls(dir, (l) => parser.push(l));
    } catch (e) {
      return { ok: false, missing, error: `acl scan of ${tilde(dir, c.home)}: ${e.message}` };
    }
    const r = parser.end();
    missing.push(...r.missing.map((m) => tilde(m, c.home))); // no absolute user path leaves this module
    if (r.error || res?.code !== 0) {
      return { ok: false, missing, error: `acl scan of ${tilde(dir, c.home)} did not complete cleanly (exit ${res?.code ?? "?"})` };
    }
  }
  if (missing.length) return { ok: false, missing };
  atomicWriteJson(c.aclState, { last_complete: new Date().toISOString() });
  return { ok: true, missing: [] };
}

/** True when there is no complete scan on record, or it is 24 h old or more (or dated in the future). */
export function aclScanDue(now, { ctx } = {}) {
  const c = mkCtx(ctx);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let last;
  try {
    last = Date.parse(JSON.parse(fs.readFileSync(c.aclState, "utf8")).last_complete);
  } catch {
    return true;
  }
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return true;
  const age = nowMs - last;
  return age < 0 || age >= ACL_SCAN_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------- --setup

/**
 * The `icacls /deny` lines the user runs once (P5), for the present targets only: folders with
 * `(OI)(CI)(R)`, home credential files with `(R)`. This is the one place that creates a folder:
 * `%TEMP%\claude` is made first so its line can be printed (A14). Nothing else is created.
 */
export function setupLines({ ctx } = {}) {
  const c = mkCtx(ctx);
  const tempClaude = path.join(c.temp, "claude");
  fs.mkdirSync(tempClaude, { recursive: true });
  const folders = [c.cfg, tempClaude, c.codexHome, ...CRED_FOLDERS.map((p) => path.join(c.home, ...p))].filter(isDir);
  const files = CRED_HOME_FILES.map((f) => path.join(c.home, f)).filter(isFile);
  return [
    ...folders.map((d) => `icacls "${d}" /deny "CodexSandboxUsers:(OI)(CI)(R)"`),
    ...files.map((f) => `icacls "${f}" /deny "CodexSandboxUsers:(R)"`),
  ];
}

// ---------------------------------------------------------------------------- the version gate

// Feature names the run disables (`--disable <name>` in execArgs): they must all exist.
function disabledFeatureNames() {
  const a = execArgs({ mode: "write", cwd: "C:\\x", runDirPath: "C:\\x", schemaPath: "C:\\x" });
  return a.flatMap((v, i) => (v === "--disable" ? [a[i + 1]] : []));
}

/**
 * New-version gate (spec:216-222). All must pass, cheapest first: a control write inside the
 * worktree works (so a failing probe means "blocked", not "sandbox broken"); the TEMP probe and
 * the outside-worktree probe both fail with no file left; every `--disable` name is in
 * `codex features list`; the read-boundary check; the ACL scan. Then the version is recorded in
 * `TESTED_VERSION`. A probe file that did get created is deleted and reported.
 * Failure is `{ ok: false, reason: "codex-version-untested", detail }`.
 */
export async function versionGate({ bin, cwd, runId, env = process.env, ctx, icacls, timeoutMs = 120000, groupCheck = sandboxGroupCheck } = {}) {
  checkRunId(runId);
  const c = mkCtx(ctx);
  const fail = (detail) => ({ ok: false, reason: "codex-version-untested", detail });
  const runTmp = path.join(cwd, ".codex-tmp", runId);
  const toDelete = [];
  try {
    let version;
    try {
      version = codexVersion(bin, env);
    } catch (e) {
      return fail(`cannot read the codex version: ${e.message}`);
    }
    fs.mkdirSync(runTmp, { recursive: true });

    // A write attempt inside `codex sandbox -P :workspace`: { exit, existed } (the file is removed).
    const attempt = async (name, target) => {
      const cmdFile = path.join(runTmp, `${name}.cmd`);
      toDelete.push(cmdFile, target);
      const body = "setlocal DisableDelayedExpansion\r\n" + (NON_ASCII.test(target) ? "chcp 65001>nul\r\n" : "") + `echo x> "${bq(target)}"`;
      fs.writeFileSync(cmdFile, cmdFileText(body), "utf8");
      rmQuiet(target);
      const r = await runSandbox(bin, { profile: ":workspace", cwd, cmdFile }, { env, timeoutMs });
      const existed = fs.existsSync(target);
      rmQuiet(target);
      return { launchError: r.error, exit: r.code, existed };
    };

    // 1. control: the sandbox can write inside the worktree, to a file named with the hazards (! % ^ & ( )
    // space, every non-ASCII char) of the probe paths: a probe that "fails" only because its path was
    // mangled must not count as a blocked write
    const control = await attempt("probe-control", path.join(runTmp, controlName([c.temp, path.dirname(cwd), runTmp])));
    if (control.launchError || control.exit !== 0 || !control.existed) {
      return fail(`control write in the worktree failed (sandbox not working): ${control.launchError ?? "exit " + control.exit}`);
    }
    // 2. TEMP probe, 3. outside-worktree probe
    for (const [label, name, dir] of [
      ["temp probe (write to the real TEMP)", "probe-temp", c.temp],
      ["outside-worktree probe (write to the worktree's parent folder)", "probe-outside", path.dirname(cwd)],
    ]) {
      const p = await attempt(name, path.join(dir, `codex-gate-${runId}.txt`));
      if (p.launchError) return fail(`${label}: sandbox did not run: ${p.launchError}`);
      if (p.existed) return fail(`${label}: the probe file was created (write not blocked); it was deleted`);
      if (p.exit === 0) return fail(`${label}: the write was not blocked (exit 0)`);
    }
    // 4. every --disable name is a known feature
    const f = await runProc(bin.cmd, [...(bin.args ?? []), "features", "list"], { env, timeoutMs });
    if (f.error || f.code !== 0) return fail(`codex features list failed: ${f.error ?? "exit " + f.code}`);
    const known = new Set(f.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
    const unknown = disabledFeatureNames().filter((n) => !known.has(n));
    if (unknown.length) return fail(`--disable names not in codex features list: ${unknown.join(", ")}`);
    // 5. read boundary: both sandbox users in CodexSandboxUsers (I2), then the read check
    const grp = await groupCheck();
    if (!grp.ok) return fail(`read check: ${grp.reason}`);
    const rc = await runReadCheck({ bin, cwd, runId, env, ctx, timeoutMs });
    if (!rc.ok) return fail(`read check: ${rc.reason}`);
    // 6. ACL scan (slow: last)
    const scan = await aclScan({ ctx, icacls });
    if (!scan.ok) {
      return fail(scan.error ?? `acl scan: entries lack the read deny: ${scan.missing.join(", ")}`);
    }
    // all pass: record the version
    fs.mkdirSync(path.dirname(c.testedVersion), { recursive: true });
    const tmp = `${c.testedVersion}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, version + "\n");
    fs.renameSync(tmp, c.testedVersion);
    return { ok: true };
  } catch (e) {
    return fail(`gate error: ${e.message}`);
  } finally {
    for (const p of toDelete) rmQuiet(p);
  }
}
