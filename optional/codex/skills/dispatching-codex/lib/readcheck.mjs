// The read boundary (spec Part 2 step 1, Part 9): a zero-token check, run inside `codex sandbox`,
// that every known credential file and a fresh sentinel in every protected folder read as DENIED;
// the host-side ACL scan (icacls /T, ACLs only, never contents) and the per-run deny assertion (`denyAclCheck`);
// the `--setup` deny lines; and the new-version gate.
//
// The deny design (2026-10-07, Codex 0.160.0): on every sandbox run Codex grants its GROUP CodexSandboxUsers (OI)(CI)(RX)
// on every direct child of %USERPROFILE% except a short list (.ssh .tsh .brev .gnupg .aws .azure .kube .docker .config
// .npm .pki .terraform.d), with SetEntriesInAcl SET_ACCESS, which removes a group deny. A deny for the individual USERS
// CodexSandboxOffline and CodexSandboxOnline survives. So only a read deny for BOTH users counts here.
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
import { CFG, CODEX_HOME, REAL_TEMP, ACL_STATE, TESTED_VERSION, atomicWriteJson, mkdirNoLink, writeNew } from "./paths.mjs";
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
    appData: c.appData ?? process.env.APPDATA ?? path.join(c.home ?? os.homedir(), "AppData", "Roaming"),
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

// Credential folders under %APPDATA% (the roaming profile). Codex grants its group RX on every profile child, AppData
// included, so these are readable by the sandbox unless the per-user denies are there: the GitHub CLI token folder and the
// Claude Desktop config (it can hold MCP server env secrets). The README names the rest of AppData as a residual.
const APPDATA_FOLDERS = ["GitHub CLI", "Claude"];
const APPDATA_FILES = [["GitHub CLI", "hosts.yml"], ["Claude", "claude_desktop_config.json"]];
const appDataFolders = (c) => APPDATA_FOLDERS.map((n) => path.join(c.appData, n)).filter(isDir);

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
  // Known residual (user-accepted 2026-10-07), deliberately NOT a target: ~/.claude.json (in the home folder) is readable
  // by the sandbox. Codex re-grants every direct child of the home folder on each run, and Claude rewrites that file (a
  // new file loses any per-user deny), so a deny cannot be kept on it. Do not add it here: the check would always fail.
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
  candidates.push(...APPDATA_FILES.map((p) => path.join(c.appData, ...p)));
  const files = candidates.filter(isFile).map((p, n) => ({ n, path: p }));
  const sentinelDirs = [...protectedFolders(c), ...appDataFolders(c)];
  const sentinels = sentinelDirs.map((dir, i) => ({
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
    mkdirNoLink(runTmp); // I2: every host write below is create-only (`wx`) in a folder that is not a link
    // the positive control: readable by construction, named with the hazards of the targets' paths
    const all = [...targets.files, ...targets.sentinels];
    const control = path.join(runTmp, controlName(all.map((x) => x.path)));
    writeNew(control, "codex read-check control: safe to delete\r\n");
    created.push(control);
    const cmdFile = path.join(runTmp, "readcheck.cmd");
    // the version gate and the run both check with this run id: a leftover file (or a link planted in its place) is removed
    // first (removing a link never touches its target), then the create-only write fails closed on any race
    rmQuiet(cmdFile);
    writeNew(cmdFile, readcheckCmd(targets, control), "utf8");
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
// `icacls /C` error line for a file or folder deleted between the walk and the ACL read (only these two Windows messages).
const VANISHED_RE = /^(?:[A-Za-z]:[\\/]|\\\\).+: The system cannot find the (?:file|path) specified\.$/;
const ACE_TAIL_RE = /:((?:\([^)]*\))+)\s*$/;
// Rights that make a deny block reads: R, RX (read and execute), GR/GA (generic), F (full), RD (read data).
const READ_RIGHTS = new Set(["R", "RX", "GR", "GA", "F", "RD"]);
// Rights that make a deny block writes (the %TEMP%\claude requirement): W, GW/GA (generic), F (full).
const WRITE_RIGHTS = new Set(["W", "GW", "GA", "F"]);
// The two sandbox accounts, in the order they are checked. Codex re-grants the GROUP CodexSandboxUsers on every
// run (SetEntriesInAcl SET_ACCESS removes a group deny), so only a deny for each of these two USERS counts.
const SANDBOX_ACCOUNT_RE = /(?:^|[\s\\])CodexSandbox(Offline|Online)$/i;
const ACCOUNTS = ["Offline", "Online"];
// A line that starts an icacls entry: a drive path `X:\...` or a UNC / `\\?\` path `\\...`. Every other line is an ACE
// continuation, indented or not (for paths of about 260 characters or more icacls prints those with NO indent).
const ENTRY_START_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

// Inheritance flags in an ACE tail; every other group is a right.
const ACE_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);
// An ALLOW is read-capable when it is a read right, Modify (M includes read), or a right the holder can turn into a read:
// WDAC (change the ACL), WO (take ownership), MA (maximum allowed), GE and X (execute / traverse). A DENY of these does not
// block reads, so READ_RIGHTS stays the set for denies.
const ALLOW_READ_RIGHTS = new Set([...READ_RIGHTS, "M", "MA", "WDAC", "WO", "GE", "X"]);
// Trustees that apply to a sandbox user besides its own name: the group CodexSandboxUsers (its members), Users, Everyone,
// Authenticated Users. An unresolved SID fails closed (treated as applying). SYSTEM, Administrators, the host user and
// CREATOR OWNER are deliberately not listed: they are never the sandbox users. `Domain Users` is not `Users`.
const GROUP_TRUSTEE_RES = [
  /(?:^|[\s\\])CodexSandboxUsers$/i, /(?:^|\s)BUILTIN\\Users$/i, /(?:^|\s)(?<!Domain )Users$/i,
  /(?:^|\s)Everyone$/i, /(?:^|\s)(?:NT AUTHORITY\\)?Authenticated Users$/i, /(?:^|\s)S-1-\d+(?:-\d+)+$/,
];
const SID_TRUSTEE_RE = /(?:^|\s)S-1-\d+(?:-\d+)+$/;

// Trustees that can never be a sandbox token: only an ALLOW ACE for one of these (or the host user) leaves an entry
// "default" (protected); an allow for any other principal might be one the sandbox token holds (INTERACTIVE, LOCAL, BATCH,
// SERVICE, This Organization, another local group ...), so the entry then reads as open. Large-org variant: also list the
// service accounts that own the host's files.
// Matched against `ace.name` (the trustee alone, entry path and indent removed; see ACE names in the parser) and anchored on
// the WHOLE name, so `LAPTOP\Evil CREATOR OWNER` or `HOST\x CREATOR GROUP` (an account that merely ends in the text) never match.
// OWNER RIGHTS (S-1-3-4 when printed as a SID) is what Windows prints for a python `mkdtemp` folder: the owner of an entry
// under the protected roots is its creator, and the sandbox accounts cannot create entries there. Residual: an entry a sandbox
// account created and owns (its OWNER RIGHTS is then the sandbox user) reads as protected by default.
const NEVER_SANDBOX_RES = [
  /^NT AUTHORITY\\SYSTEM$/i, /^BUILTIN\\Administrators$/i, /^CREATOR OWNER$/i, /^CREATOR GROUP$/i,
  /^NT SERVICE\\TrustedInstaller$/i, /^OWNER RIGHTS$/i, /^S-1-3-4$/,
];
/** The host user as icacls prints it (`<USERDOMAIN or COMPUTERNAME>\<USERNAME>`), or null when the env does not say. */
export function hostUserName(env = process.env) {
  const user = env.USERNAME;
  const dom = env.USERDOMAIN || env.COMPUTERNAME;
  return user && dom ? `${dom}\\${user}` : null;
}
// The host user's whole-name matcher, built once per parser (null when the host user is unknown: its ACE is then unknown).
const hostUserRe = (hostUser) => (hostUser ? new RegExp(`^${hostUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") : null);
const neverSandbox = (ace, hostRe) => NEVER_SANDBOX_RES.some((re) => re.test(ace.name)) || !!hostRe?.test(ace.name);
// The trustee of an entry's FIRST ACE line, which starts with the path. With the column known (`indent`, read from a
// continuation line) it is exact; without one (a single-ACE entry) only a space-free path can be told from the trustee,
// anything else stays whole and so matches nothing (fail closed).
function firstAceName(trustee, indent) {
  if (indent != null) return trustee.slice(indent).trim();
  const m = /^(?:[A-Za-z]:[\\/]|\\\\)\S*\s+(.*)$/.exec(trustee);
  return (m ? m[1] : trustee).trim();
}

// One ACE line parsed: `{ trustee (the text before the tail: it ends with the trustee), io, deny, rights }`.
function parseAce(line, tail) {
  const groups = [...tail[1].matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  const i = groups.indexOf("DENY");
  const flagGroups = (i < 0 ? groups : groups.slice(0, i)).flatMap((g) => g.split(","));
  const rights = (i < 0 ? groups.filter((g) => !g.split(",").every((x) => ACE_FLAGS.has(x))) : groups.slice(i + 1)).flatMap((g) => g.split(","));
  return {
    trustee: line.slice(0, tail.index), io: groups.some((g) => g.split(",").includes("IO")), deny: i >= 0, rights, // IO anywhere: inherit-only
    inherits: flagGroups.includes("OI") && flagGroups.includes("CI"), // reaches files and folders created inside later
  };
}

// Does this ACE apply to the sandbox user `user` ("Offline" | "Online"): its own name, or one of the group trustees above.
// OWNER RIGHTS as a bare SID (S-1-3-4) is the owner, never a sandbox token: it is not an "unresolved SID" that fails closed.
const appliesTo = (ace, user) => ace.name !== "S-1-3-4" &&
  (new RegExp(`(?:^|[\\s\\\\])CodexSandbox${user}$`, "i").test(ace.trustee) || GROUP_TRUSTEE_RES.some((re) => re.test(ace.trustee)));

// The read decision for one sandbox user, walking the ACEs in printed (DACL) order: the first ACE that is not inherit-only,
// applies to the user and carries a read right decides. "deny" = protected (an explicit per-user deny), "allow" = open,
// "default" = NO applicable ACE carries a read right AND every non-inherit-only ALLOW ACE names a known never-sandbox
// trustee (SYSTEM, Administrators, CREATOR OWNER/GROUP, TrustedInstaller, the host user), so Windows' default (deny)
// applies: protected, but with no explicit deny (a python `mkdtemp` entry: protected owner-only DACL, inheritance removed).
// Default-deny holds by exclusion only: an allow for any other principal (INTERACTIVE, LOCAL, BATCH, an unlisted local
// group ...) may be one the sandbox token holds, so it makes the entry open (null), whatever its rights.
// null = a read right applies but nothing decides (a group deny alone), or an unknown allow trustee: open.
// Not visible here: the object owner's implicit WRITE_DAC/READ_CONTROL (icacls does not print it). Not a regression: it
// only matters if the sandbox user owned the object, and it is not an ACE the walk could ever have judged.
// Only a deny that names the user itself counts as "deny": Codex re-grants its GROUP on every run (SET_ACCESS removes a group
// deny), so a deny for a group trustee is not a protection and does not decide (a later allow still wins). An unresolved SID
// with a read right (allow or deny) decides "allow": it cannot be told from a grant, so it fails closed.
// `denyAclCheck` on the protected roots accepts only "deny" (explicit, inheriting): Codex re-grants its group RX there every run.
function readDecision(aces, user, hostRe) {
  const own = new RegExp(`(?:^|[\\s\\\\])CodexSandbox${user}$`, "i");
  let sawRead = false;
  for (const a of aces) {
    if (a.io || !appliesTo(a, user)) continue;
    const carries = a.rights.some((r) => (a.deny ? READ_RIGHTS : ALLOW_READ_RIGHTS).has(r));
    if (!carries) continue;
    sawRead = true;
    if (!a.deny || SID_TRUSTEE_RE.test(a.trustee)) return { state: "allow", inherits: false };
    if (own.test(a.trustee)) return { state: "deny", inherits: a.inherits };
  }
  if (sawRead) return { state: null, inherits: false };
  // no deciding ACE and no applicable read ACE: protected by default only when every allow here is a never-sandbox trustee
  const unknown = aces.some((a) => !a.io && !a.deny && !neverSandbox(a, hostRe));
  return { state: unknown ? null : "default", inherits: false };
}

// The rights this ACE DENIES a sandbox account on the object itself (for the write requirement): `{ user, rights }`, or null.
function aceDeny(ace) {
  const who = SANDBOX_ACCOUNT_RE.exec(ace.trustee);
  if (!who || !ace.deny || ace.io) return null;
  return { user: who[1][0].toUpperCase() + who[1].slice(1).toLowerCase(), rights: ace.rights };
}

const hasRight = (rights, set) => rights.some((r) => set.has(r));

/**
 * Incremental parser for `icacls <dir> /T /C` output (a big scan streams into it line by line).
 * An entry is a line that starts with a path (`X:\` or `\\`: path + first ACE) plus the ACE lines after it (indented, or
 * not for long paths), blank-line separated. An entry is protected when, for BOTH CodexSandboxOffline and
 * CodexSandboxOnline, the first ACE that applies and carries a read right is a DENY for that user (explicit or inherited,
 * never inherit-only), or when no applicable ACE carries a read right at all (Windows' default is deny: an owner-only
 * entry); a group deny alone does not count (see readDecision). Anything it cannot read (an error line, a stray line, an
 * ACE line before any entry, a summary with failures, no summary at all) sets `error`: the callers block on it. The one
 * exception is the vanished-file error line (`<path>: The system cannot find the file|path specified.`, a file deleted
 * mid-scan): it is skipped, its path recorded (`vanishedPaths()`), and the summary's "Failed processing N" must equal the
 * number of such lines (more or fewer is an error).
 * Options: `hostUser` (`DOMAIN\user`, default from the env; the one non-system trustee that does not stop an entry from being
 * protected by default, see readDecision), `skip(path)` drops matching entries from `missing` (the scan exemptions); `keep` also returns `entries`
 * (`{ path, rights: { Offline: string[], Online: string[] } }`, the rights each account is denied) for the callers
 * that look at one folder.
 */
export function createIcaclsParser({ skip, keep = false, hostUser = hostUserName() } = {}) {
  const missing = [];
  const entries = [];
  let error = false;
  let why = null; // the first cause of `error`, for the callers that name it
  let summary = false;
  let failed = 0; // "Failed processing N" from the summary
  let vanished = 0; // the recognised vanished-file error lines, subtracted from N
  const vanishedPaths = []; // their paths, so a caller can check each one is really gone (aclScan does)
  const hostRe = hostUserRe(hostUser);
  let cur = null;
  const entryPath = (e) => {
    if (e.indent != null) return e.first.slice(0, e.indent).trimEnd();
    // no indented continuation line to read the column from (a single-ACE entry, or a long path): cut the first ACE off
    return e.first.replace(/\s+\S+:(?:\([^)]*\))+\s*$/, "").replace(/ (?:NT|APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION)$/, "");
  };
  const take = (e, line, tail) => {
    const ace = parseAce(line, tail);
    ace.name = e.aces.length ? ace.trustee.trim() : null; // the first ACE's name needs the column: set in close()
    e.aces.push(ace);
    const d = aceDeny(ace);
    if (d) e.rights[d.user].push(...d.rights);
  };
  const close = () => {
    if (cur) {
      const p = entryPath(cur);
      cur.aces[0].name = firstAceName(cur.aces[0].trustee, cur.indent);
      const dec = Object.fromEntries(ACCOUNTS.map((u) => [u, readDecision(cur.aces, u, hostRe)]));
      const decision = Object.fromEntries(ACCOUNTS.map((u) => [u, dec[u].state]));
      const inherits = Object.fromEntries(ACCOUNTS.map((u) => [u, dec[u].inherits]));
      const denied = ACCOUNTS.every((u) => decision[u] === "deny" || decision[u] === "default");
      if (!denied && !(skip && skip(p))) missing.push(p);
      if (keep) entries.push({ path: p, rights: cur.rights, decision, inherits });
    }
    cur = null;
  };
  return {
    why: () => why,
    vanishedPaths: () => [...vanishedPaths],
    push(raw) {
      const line = String(raw).replace(/\r$/, "");
      if (line.trim() === "") { close(); return; }
      const s = SUMMARY_RE.exec(line.trim());
      if (s) {
        close();
        summary = true;
        failed = Number(s[2]); // judged in end(): a vanished-file line may still arrive after the summary
        return;
      }
      // a file deleted mid-scan: `icacls /C` prints `<path>: The system cannot find the file|path specified.` and counts it
      // as failed. Skipped without touching the open entry (stderr is read next to stdout, so it can land mid-entry).
      if (VANISHED_RE.test(line.trim())) {
        vanished++;
        vanishedPaths.push(line.trim().replace(/: The system cannot find the (?:file|path) specified\.$/, ""));
        return;
      }
      const tail = ACE_TAIL_RE.exec(line);
      if (ENTRY_START_RE.test(line)) {
        close();
        if (!tail) { error = true; why ??= "unreadable output line"; return; } // e.g. "<path>: Access is denied."
        cur = { first: line, indent: null, aces: [], rights: { Offline: [], Online: [] } };
        take(cur, line, tail);
        return;
      }
      if (!cur || !tail) { error = true; why ??= "unreadable output line"; return; }
      if (cur.indent == null && /^\s/.test(line)) cur.indent = /^ */.exec(line)[0].length;
      take(cur, line, tail);
    },
    end() {
      close();
      if (!summary) { error = true; why ??= "no summary line (truncated output)"; } // truncated output
      else if (failed !== vanished) { // more failures than vanished lines: unexplained; fewer: the output is inconsistent
        error = true;
        why ??= failed > vanished ? `${failed - vanished} files failed processing` : `inconsistent output: ${vanished} vanished-file lines for ${failed} failed`;
      }
      return keep ? { missing, error, entries } : { missing, error };
    },
  };
}

/** `{ missing: string[] (paths lacking the deny), error: boolean }` for a whole icacls output. */
export function parseIcacls(text, opts) {
  const p = createIcaclsParser(opts);
  for (const l of String(text ?? "").split("\n")) p.push(l);
  return p.end();
}

// ---------------------------------------------------------------------------- the ACL scan

// By full path, like cmd.exe in argv.mjs: never a PATH search for a program that lists ACLs.
export const ICACLS_EXE = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");

// Does this path exist right now (lstat, no symlink follow)? The `\\?\` prefix makes it work for paths past MAX_PATH. Only a
// definite "not there" (ENOENT / ENOTDIR) counts as gone; any other error (EACCES, EPERM ...) fails closed as "exists".
function pathExists(p) {
  try {
    fs.lstatSync(p.startsWith("\\\\") ? p : "\\\\?\\" + p);
    return true;
  } catch (e) {
    return !(e?.code === "ENOENT" || e?.code === "ENOTDIR");
  }
}

// Default runner: `icacls "<dir>" /T /C` (listing only), lines streamed to onLine. A scan of the
// config folder can take more than 5 minutes, so the timeout is long. `{ recurse: false }` lists the folder alone
// (`icacls "<dir>"`, no /T: about 50 ms), for the per-run deny check.
function icaclsList(dir, onLine, { recurse = true, timeoutMs = recurse ? 30 * 60 * 1000 : 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ICACLS_EXE, recurse ? [dir, "/T", "/C"] : [dir], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

// Codex's own working folders under CODEX_HOME. They carry explicit allows the sandbox needs to run (a read deny there
// would break every sandbox start) and hold no user credentials, so the ACL scan skips each of them and everything
// under it. Names are matched case-insensitively and whole: `.sandbox-binx` or `.sandboxes` are not exempt, nor is a
// `.sandbox` below some other folder. Anything else under CODEX_HOME (auth.json, sessions, config, `.sandbox-secrets`) is
// scanned. `app-server-control` and `app-server-daemon` are Codex runtime folders (socket, lock, pid; no credentials) with
// inheritance disabled, so they never carry the per-user deny.
export const ACL_SCAN_EXEMPT = Object.freeze([".sandbox-bin", ".sandbox", "app-server-control", "app-server-daemon"]);

/**
 * Host-side ACL scan: `icacls "<dir>" /T /C` for each protected folder that EXISTS (the list is
 * overridable with `dirs`; the runner with `icacls(dir, onLine, opts) => Promise<{code}>`). Entries
 * that are open to CodexSandboxOffline or CodexSandboxOnline (see createIcaclsParser: no read deny first in DACL order and
 * some applicable read ACE, or an allow for a principal that is not known never to be the sandbox) are returned in
 * `missing`, except those under ACL_SCAN_EXEMPT (under CODEX_HOME). A pass that ends with an error (a parse error, a
 * non-zero exit, a thrown or timed-out icacls run, or a vanished-file line for a path that still exists) is run once more
 * (a live tree changes under it); a second error stands, so the worst case is two full runs, a timeout included (it
 * doubles). A clean, complete scan records `last_complete` in the ACL state file; a scan with a gap or an error records
 * nothing. Injectable for tests: `hostUser` (see createIcaclsParser) and `exists(path) => boolean` (the vanished-line check).
 */
export async function aclScan({ ctx, dirs, icacls = icaclsList, hostUser, exists = pathExists } = {}) {
  const c = mkCtx(ctx);
  const list = dirs ?? protectedFolders(c);
  const norm = (p) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const exempt = ACL_SCAN_EXEMPT.map((n) => norm(path.join(c.codexHome, n)));
  const skip = (p) => { const n = norm(p); return exempt.some((r) => n === r || n.startsWith(r + "\\")); };
  // One pass over every folder: `{ missing }` for a finished scan (gaps are a result, not an error), `{ missing, error }`
  // when it ends with an error (a live tree changes under the scan; the whole pass is retried once below).
  const pass = async () => {
    const found = [];
    for (const dir of list) {
      const parser = createIcaclsParser(hostUser === undefined ? { skip } : { skip, hostUser });
      let res;
      try {
        res = await icacls(dir, (l) => parser.push(l));
      } catch (e) {
        return { missing: found, error: `acl scan of ${tilde(dir, c.home)}: ${e.message}` };
      }
      const r = parser.end();
      found.push(...r.missing.map((m) => tilde(m, c.home))); // no absolute user path leaves this module
      // a vanished-file line is only believed when the path is really gone: a path that exists means the entry was skipped
      const stale = parser.vanishedPaths().some((p) => exists(p));
      if (r.error || stale || res?.code !== 0) {
        // name the real cause: the parser's reason (a failed-file count is NOT an exit code) and icacls' own exit code
        const cause = r.error ? parser.why() : stale ? "vanished-line for an existing path" : "icacls reported a failure";
        return { missing: found, error: `acl scan of ${tilde(dir, c.home)} did not complete cleanly: ${cause} (icacls exit ${res?.code ?? "?"})` };
      }
    }
    return { missing: found };
  };
  let result = await pass();
  if (result.error) result = await pass(); // retry the whole scan once; a second error stands
  if (result.error) return { ok: false, missing: result.missing, error: result.error };
  if (result.missing.length) return { ok: false, missing: result.missing };
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

// ---------------------------------------------------------------------------- the per-run deny check

// The folders whose per-user denies are asserted on the host before every run (and in the version gate), in order:
// `write` means the user denies must cover write as well as read (the Claude scratchpad root is an injection channel).
// Folders must be denied with (OI)(CI) (M3: a deny that does not inherit leaves new files inside readable); the home
// credential files (`file: true`) have no children and need no inheritance.
const denyFolders = (c) => [
  { dir: c.cfg }, { dir: c.codexHome }, { dir: path.join(c.temp, "claude"), write: true },
  { dir: path.join(c.home, ".ssh") }, { dir: path.join(c.home, ".docker") },
  { dir: path.join(c.home, ".config", "gh") }, { dir: path.join(c.home, ".aws") }, { dir: path.join(c.home, ".azure") },
  ...APPDATA_FOLDERS.map((n) => ({ dir: path.join(c.appData, n) })),
].filter((f) => isDir(f.dir)).concat(CRED_HOME_FILES.map((f) => ({ dir: path.join(c.home, f), file: true })).filter((f) => isFile(f.dir)));

/**
 * Host-side ACL assertion, every run: `icacls "<target>"` (full System32 path, no /T, about 50 ms each) for ~/.claude,
 * ~/.codex, %TEMP%\claude, ~/.ssh, ~/.docker, ~/.config/gh, ~/.aws, ~/.azure, %APPDATA%\GitHub CLI and %APPDATA%\Claude,
 * and each home credential file (CRED_HOME_FILES), each only if it exists. Codex re-grants the group CodexSandboxUsers on
 * every run (which removes a group deny), so each target must carry a read deny for CodexSandboxOffline AND for
 * CodexSandboxOnline, decided in DACL order (see readDecision: an allow listed first wins; inherit-only ACEs never count),
 * a folder deny must carry (OI)(CI), and %TEMP%\claude a write deny for both as well. Returns `{ ok: true }`, or `{ ok: false, reason: "read-boundary-open: <folder> lacks <user> deny" }`
 * (`<user> write deny` for the write requirement); a listing that cannot be read (runner error, bad exit, no summary or
 * more or fewer than one entry) is `read-check-failed: ...`. Lists only; `icacls(dir, onLine, { recurse:false })`
 * is injectable and returns `{ code }`. Large-org variant: check every protected folder's whole tree, not just its root.
 */
export async function denyAclCheck({ ctx, icacls = icaclsList } = {}) {
  const c = mkCtx(ctx);
  for (const { dir, write, file } of denyFolders(c)) {
    const shown = tilde(dir, c.home);
    const parser = createIcaclsParser({ keep: true });
    let res;
    try {
      res = await icacls(dir, (l) => parser.push(l), { recurse: false });
    } catch (e) {
      return { ok: false, reason: `read-check-failed: icacls: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}` };
    }
    const r = parser.end();
    if (r.error || res?.code !== 0 || r.entries.length !== 1) {
      return { ok: false, reason: `read-check-failed: icacls listing of ${shown} incomplete (exit ${res?.code ?? "?"})` };
    }
    const { rights, decision, inherits } = r.entries[0];
    for (const u of ACCOUNTS) {
      if (decision[u] !== "deny") return { ok: false, reason: `read-boundary-open: ${shown} lacks CodexSandbox${u} deny` };
      if (!file && !inherits[u]) return { ok: false, reason: `read-boundary-open: ${shown} lacks CodexSandbox${u} (OI)(CI) deny` };
      if (write && !hasRight(rights[u], WRITE_RIGHTS)) return { ok: false, reason: `read-boundary-open: ${shown} lacks CodexSandbox${u} write deny` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------- --setup

// The `--setup` targets, present ones only: folders (with the rights to deny: `R`, and `R,W,D` for %TEMP%\claude) and
// home credential files.
function setupTargets(c) {
  const tempClaude = path.join(c.temp, "claude");
  const folders = [c.cfg, tempClaude, c.codexHome, ...CRED_FOLDERS.map((p) => path.join(c.home, ...p)), ...APPDATA_FOLDERS.map((n) => path.join(c.appData, n))]
    .filter(isDir).map((dir) => ({ dir, rights: dir === tempClaude ? "R,W,D" : "R" }));
  const files = CRED_HOME_FILES.map((f) => path.join(c.home, f)).filter(isFile);
  return { folders, files };
}

/**
 * The `icacls /deny` lines the user runs once (P5), for the present targets only, per sandbox USER (the group
 * deny is stripped by Codex on every run): folders with `(OI)(CI)(R)` (`(OI)(CI)(R,W,D)` for %TEMP%\claude), home
 * credential files with `(R)`. This is the one place that creates a folder:
 * `%TEMP%\claude` is made first so its line can be printed (A14). Nothing else is created.
 */
export function setupLines({ ctx } = {}) {
  const c = mkCtx(ctx);
  fs.mkdirSync(path.join(c.temp, "claude"), { recursive: true });
  const { folders, files } = setupTargets(c);
  const deny = (rights) => ["CodexSandboxOffline", "CodexSandboxOnline"].map((u) => `"${u}:${rights}"`).join(" ");
  return [
    ...folders.map((f) => `icacls "${f.dir}" /deny ${deny(`(OI)(CI)(${f.rights})`)}`),
    ...files.map((f) => `icacls "${f}" /deny ${deny("(R)")}`),
  ];
}

/** The undo for `setupLines`: `icacls "<target>" /remove:d CodexSandboxOffline CodexSandboxOnline` per present target. Creates nothing. */
export function setupUndoLines({ ctx } = {}) {
  const { folders, files } = setupTargets(mkCtx(ctx));
  return [...folders.map((f) => f.dir), ...files].map((t) => `icacls "${t}" /remove:d CodexSandboxOffline CodexSandboxOnline`);
}

// ---------------------------------------------------------------------------- the version gate

// Feature names the run disables (`--disable <name>` in execArgs): they must all exist.
function disabledFeatureNames() {
  const a = execArgs({ mode: "write", cwd: "C:\\x", runDirPath: "C:\\x", schemaPath: "C:\\x" });
  return a.flatMap((v, i) => (v === "--disable" ? [a[i + 1]] : []));
}

/**
 * New-version gate (spec:216-222). All must pass, cheapest first: a control write inside the
 * worktree works (so a failing probe means "blocked", not "sandbox broken"); the TEMP probe (a write to
 * %TEMP%\claude, when it exists) and the outside-worktree probe both fail with no file left; every `--disable` name is in
 * `codex features list`; the host-side deny check (`denyAclCheck`), the group check and the read-boundary check; the ACL scan. Then the version is recorded in
 * `TESTED_VERSION`. A probe file that did get created is deleted and reported.
 * Failure is `{ ok: false, reason: "codex-version-untested", detail }`.
 */
export async function versionGate({ bin, cwd, runId, env = process.env, ctx, icacls, timeoutMs = 120000, groupCheck = sandboxGroupCheck, denyCheck = denyAclCheck } = {}) {
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
    mkdirNoLink(runTmp);

    // A write attempt inside `codex sandbox -P :workspace`: { exit, existed } (the file is removed). A failed redirect in a
    // .cmd prints "Access is denied." but leaves ERRORLEVEL 0, so the line ends `|| exit /b 1` and callers decide on the
    // file's EXISTENCE, never on the exit code (B1). The check file itself is create-only (I2).
    const attempt = async (name, target) => {
      const cmdFile = path.join(runTmp, `${name}.cmd`);
      const body = "setlocal DisableDelayedExpansion\r\n" + (NON_ASCII.test(target) ? "chcp 65001>nul\r\n" : "") + `(echo x> "${bq(target)}") || exit /b 1`;
      writeNew(cmdFile, cmdFileText(body), "utf8");
      toDelete.push(cmdFile, target);
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
    // 2. TEMP probe, 3. outside-worktree probe. The TEMP probe targets %TEMP%\claude (the Claude scratchpad root, the
    // real injection channel), only when it exists: a run never creates a protected folder, and a write into a missing
    // folder would fail for the wrong reason. The general %TEMP% write (Codex grants its group (M) there) is an
    // accepted residual and is not probed.
    const probes = [];
    const tempClaude = path.join(c.temp, "claude");
    if (isDir(tempClaude)) probes.push(["temp probe (write to %TEMP%\\claude, the Claude scratchpad root)", "probe-temp", tempClaude]);
    probes.push(["outside-worktree probe (write to the worktree's parent folder)", "probe-outside", path.dirname(cwd)]);
    for (const [label, name, dir] of probes) {
      const p = await attempt(name, path.join(dir, `codex-gate-${runId}.txt`));
      if (p.launchError) return fail(`${label}: sandbox did not run: ${p.launchError}`);
      if (p.existed) return fail(`${label}: the probe file was created (write not blocked); it was deleted`);
      // no file = blocked, whatever the exit code (exit 0 with "Access is denied." is the usual shape)
    }
    // 4. every --disable name is a known feature
    const f = await runProc(bin.cmd, [...(bin.args ?? []), "features", "list"], { env, timeoutMs });
    if (f.error || f.code !== 0) return fail(`codex features list failed: ${f.error ?? "exit " + f.code}`);
    const known = new Set(f.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
    const unknown = disabledFeatureNames().filter((n) => !known.has(n));
    if (unknown.length) return fail(`--disable names not in codex features list: ${unknown.join(", ")}`);
    // 5. read boundary: the per-user deny ACLs on the host, both sandbox users in CodexSandboxUsers (I2), then the read check
    const dn = await denyCheck({ ctx });
    if (!dn.ok) return fail(`read check: ${dn.reason}`);
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
