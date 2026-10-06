// Review mode input (spec:125-133, plan Task 12, Decision 4): the script prepares the exact patch the reviewer reads
// and binds the verdict to its sha256. Returns { ok, patchPath, patchRunPath, sha256 } or { ok:false, reason }.
//
//   --review-of <run-id>: that run's meta.json holds the baseline and diff_hash; the worktree must still hash the
//     same (else worktree-changed). The patch = the pinned tracked diff against the baseline + every untracked file
//     as a new-file hunk (the same bytes diffHash covers). Empty -> empty-patch.
//   --base <ref>: `git diff <ref>...HEAD`. Empty -> empty-range.
//
// Linked paths are refused first: a changed path (or any folder on the way to it) that is a symlink or junction, or a
// file with more than one hard link, could make the patch read something outside the worktree.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { STATE, runDir, canonPath, atomicWriteJson } from "./paths.mjs";
import { changes, diffHash, trackedPatch, untrackedPatch } from "./scope.mjs";

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PIN_CONFIG = ["-c", "core.quotepath=false", "-c", "color.ui=never"];
const PIN_DIFF = ["--no-ext-diff", "--no-color", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function git(cwd, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  const r = spawnSync("git", args, { cwd, env, windowsHide: true, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`git ${args.slice(0, 4).join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.slice(0, 4).join(" ")} exited ${r.status}: ${String(r.stderr).trim()}`);
  return r.stdout;
}

/** The first changed path that is, or sits under, a symlink/junction or is a multiply-linked file; else null. */
function linkedPath(cwd, rels) {
  for (const rel of rels) {
    const segs = rel.split("/").filter(Boolean);
    let cur = cwd;
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch (e) {
        if (e && e.code === "ENOENT") break; // a deleted path: nothing to read
        return `${rel} (unreadable)`;
      }
      if (st.isSymbolicLink()) return rel;
      if (i === segs.length - 1 && st.isFile() && st.nlink > 1) return `${rel} (hard-linked)`;
    }
  }
  return null;
}

function readMeta(id) {
  if (typeof id !== "string" || !RUN_ID_RE.test(id) || id.includes("..")) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(STATE, "runs", id, "meta.json"), "utf8"));
    return m && typeof m === "object" && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

function save({ cwd, runId, patch }) {
  const sha256 = crypto.createHash("sha256").update(patch).digest("hex");
  const dir = runDir(runId);
  const patchRunPath = path.join(dir, "review.patch");
  fs.writeFileSync(patchRunPath, patch);
  const tmpDir = path.join(cwd, ".codex-tmp", runId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const patchPath = path.join(tmpDir, "review.patch");
  fs.writeFileSync(patchPath, patch);
  const prev = readMeta(runId) ?? {};
  atomicWriteJson(path.join(dir, "meta.json"), { ...prev, patch_sha256: sha256 });
  return { ok: true, patchPath, patchRunPath, sha256 };
}

export async function reviewInput({ cwd, runId, reviewOf, base }) {
  const hasOf = reviewOf !== undefined && reviewOf !== null;
  const hasBase = base !== undefined && base !== null;
  if (hasOf === hasBase) return { ok: false, reason: "review-input-failed: need exactly one of reviewOf and base" };
  if (hasOf) {
    const m = readMeta(reviewOf);
    if (!m || typeof m.baseline !== "string" || typeof m.diff_hash !== "string") {
      return { ok: false, reason: `review-of-unknown: no usable meta.json for run ${reviewOf}` };
    }
    if (typeof m.cwd !== "string" || m.cwd !== canonPath(cwd)) {
      return { ok: false, reason: `review-of-cwd-mismatch: run ${reviewOf} ran in another worktree` };
    }
    const list = changes(cwd);
    const link = linkedPath(cwd, list.flatMap((c) => (c.orig === undefined ? [c.path] : [c.path, c.orig])));
    if (link) return { ok: false, reason: `linked-path: ${link}` };
    if (diffHash(cwd, m.baseline) !== m.diff_hash) return { ok: false, reason: "worktree-changed" };
    const parts = [trackedPatch(cwd, m.baseline)];
    const untracked = list.filter((c) => c.xy === "??").map((c) => c.path).sort(byCodeUnit);
    for (const p of untracked) parts.push(untrackedPatch(cwd, p));
    const patch = Buffer.concat(parts);
    if (patch.length === 0) return { ok: false, reason: "empty-patch" };
    return save({ cwd, runId, patch });
  }
  // --base <ref>
  if (typeof base !== "string" || base === "" || base.startsWith("-")) return { ok: false, reason: "base-not-found: bad ref" };
  const range = `${base}...HEAD`;
  try {
    git(cwd, ["rev-parse", "--verify", "-q", `${base}^{commit}`]);
    git(cwd, ["merge-base", base, "HEAD"]);
  } catch {
    return { ok: false, reason: `base-not-found: ${base}` };
  }
  const names = git(cwd, [...PIN_CONFIG, "diff", "--name-only", "-z", "--no-renames", range]).toString("utf8").split("\0").filter(Boolean);
  const link = linkedPath(cwd, names);
  if (link) return { ok: false, reason: `linked-path: ${link}` };
  const patch = git(cwd, [...PIN_CONFIG, "diff", "--binary", ...PIN_DIFF, "--no-renames", range]);
  if (patch.length === 0) return { ok: false, reason: "empty-range" };
  return save({ cwd, runId, patch });
}
