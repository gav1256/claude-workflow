// Scope check and diff hash for write mode (spec Part 2 step 4, plan Task 7).
// Every path returned is forward-slash and relative to the repo root (= the worktree `cwd`);
// `.codex-tmp/` (the run's scratch folder) is always ignored.
//
// All git calls are pinned so the user's or the repo's git config cannot change what is hashed:
// `-c core.quotepath=false -c color.ui=never`, `--no-ext-diff --no-color --no-textconv --no-renames`
// and explicit `--src-prefix=a/ --dst-prefix=b/` (they beat diff.noprefix / diff.mnemonicPrefix).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRATCH = ".codex-tmp";

const PIN_CONFIG = ["-c", "core.quotepath=false", "-c", "color.ui=never"];
const PIN_DIFF = ["--no-ext-diff", "--no-color", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

function gitEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return env;
}

/** Run git in `cwd`; returns stdout as a Buffer. `okStatus` lists the exit codes that are not errors. */
function git(cwd, args, okStatus = [0]) {
  const r = spawnSync("git", args, {
    cwd, env: gitEnv(), windowsHide: true, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw new Error(`git ${args.slice(0, 6).join(" ")}: ${r.error.message}`);
  if (!okStatus.includes(r.status)) {
    throw new Error(`git ${args.slice(0, 6).join(" ")} exited ${r.status}: ${String(r.stderr).trim()}`);
  }
  return r.stdout;
}

const isScratch = (p) => {
  const q = p.toLowerCase();
  return q === SCRATCH || q.startsWith(SCRATCH + "/");
};

/**
 * Every changed path, tracked and untracked (`git status --porcelain=v1 -z --untracked-files=all`).
 * A rename or copy carries `orig` (the old path). `-z` output is unquoted, so spaces and
 * non-ASCII names come back as they are.
 */
export function changes(cwd) {
  const out = git(cwd, [...PIN_CONFIG, "status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString("utf8");
  const parts = out.split("\0");
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue; // trailing empty entry
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    let orig;
    if (/[RC]/.test(xy)) orig = parts[++i];
    if (isScratch(p)) continue;
    list.push(orig === undefined ? { xy, path: p } : { xy, path: p, orig });
  }
  return list;
}

const normPath = (p) => String(p).replace(/\\/g, "/").replace(/^(\.\/)+/, "").toLowerCase();

const globCache = new Map();
function compile(g) {
  let re = globCache.get(g);
  if (re) return re;
  let src = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") { src += "(?:.*/)?"; i += 2; } else { src += ".*"; i += 1; }
      } else src += "[^/]*";
    } else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re = new RegExp("^" + src + "$", "s");
  globCache.set(g, re);
  return re;
}

/**
 * `**` any depth, `*` within one segment, `?` one non-slash char, an exact file, `dir/` = everything
 * under dir. Case-insensitive; backslashes and a leading `./` are normalized. Empty glob matches nothing.
 */
export function globMatch(p, glob) {
  const g = normPath(glob);
  const q = normPath(p);
  if (g === "") return false;
  if (g.endsWith("/")) return q.length > g.length && q.startsWith(g);
  return compile(g).test(q);
}

/** `out` lists every touched path that matches no glob; a rename needs both ends owned. */
export function scopeCheck(list, globs) {
  const out = [];
  const seen = new Set();
  const note = (p) => {
    if (p === undefined || seen.has(p)) return;
    seen.add(p);
    if (!globs.some((g) => globMatch(p, g))) out.push(p);
  };
  for (const c of list) {
    note(c.path);
    note(c.orig);
  }
  return { ok: out.length === 0, out };
}

export function baseline(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]).toString("utf8").trim();
}

export function isClean(cwd) {
  return changes(cwd).length === 0;
}

/** The pinned tracked-files patch of the working tree against `base` (a Buffer). */
export function trackedPatch(cwd, base) {
  return git(cwd, [...PIN_CONFIG, "diff", "--binary", ...PIN_DIFF, "--no-renames", base]);
}

/**
 * A new-file hunk for one untracked file: `git diff --no-index --binary -- /dev/null <relpath>`
 * run from `cwd` with the relative path (exit 1 means "differs" and is normal). Returns a Buffer.
 */
export function untrackedPatch(cwd, relpath) {
  return git(cwd, [...PIN_CONFIG, "diff", "--no-index", "--binary", ...PIN_DIFF, "--", "/dev/null", relpath], [0, 1]);
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function untrackedPaths(cwd) {
  return changes(cwd).filter((c) => c.xy === "??").map((c) => c.path).sort(byCodeUnit);
}

function fileBytes(abs) {
  const st = fs.lstatSync(abs);
  return st.isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs), "utf8") : fs.readFileSync(abs);
}

/** sha256 of the pinned tracked patch against `base` + per untracked file (sorted): path \0 bytes. */
export function diffHash(cwd, base) {
  const h = crypto.createHash("sha256");
  h.update(trackedPatch(cwd, base));
  for (const p of untrackedPaths(cwd)) {
    h.update(p, "utf8");
    h.update("\0");
    h.update(fileBytes(path.join(cwd, ...p.split("/"))));
  }
  return h.digest("hex");
}

function countLines(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/**
 * "src/a.ts (+12 -3)" per changed path from the pinned `git diff --numstat -z`; untracked files are
 * "(+lines -0)", a binary file "(binary)". A rename lists both ends (the old one as all deletions).
 */
export function fileStats(cwd, base, list) {
  const raw = git(cwd, [...PIN_CONFIG, "diff", "--numstat", "-z", ...PIN_DIFF, "--no-renames", base]).toString("utf8");
  const stat = new Map();
  for (const rec of raw.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rec);
    if (m) stat.set(m[3], m[1] === "-" ? "(binary)" : `(+${m[1]} -${m[2]})`);
  }
  const lines = [];
  const seen = new Set();
  const add = (p, untracked) => {
    if (p === undefined || seen.has(p)) return;
    seen.add(p);
    let s = stat.get(p);
    if (s === undefined && untracked) {
      const buf = fileBytes(path.join(cwd, ...p.split("/")));
      s = buf.subarray(0, 8000).includes(0) ? "(binary)" : `(+${countLines(buf)} -0)`;
    }
    lines.push(`${p} ${s ?? "(+0 -0)"}`);
  };
  for (const c of list) {
    add(c.path, c.xy === "??");
    add(c.orig, false);
  }
  return lines;
}
