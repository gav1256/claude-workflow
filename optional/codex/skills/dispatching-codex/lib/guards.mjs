// Guards that run before any lock or record is touched (spec Part 2 step 1, plan Task 9 / Decision 9):
//   isLinkedWorktree  the --cwd is a linked git worktree, never a main checkout
//   laneCheck         the lane rule, read from the handoff-launch registry
//   continueCheck     --continue: the worktree holds exactly the earlier run's residue
//
// laneCheck reuses handoff-launch (`readRegistry` and `liveness` from live.mjs, `normPath` from lane-lib.mjs, both in
// ${HL_SKILL_DIR || CFG/skills/handoff-launch}). The two modules are loaded once, at import (top-level await), so that
// laneCheck keeps the plan's synchronous signature. The registry itself is re-read on every call.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { HL_DIR, canonPath } from "./paths.mjs";
import { baseline, diffHash } from "./scope.mjs";

// ------------------------------------------------------------------------------------------ git helpers

function gitLines(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// git prints a path relative to `cwd` (or absolute, with forward slashes): one canonical spelling, or null.
function resolveGit(cwd, p) {
  try { return canonPath(path.resolve(cwd, p)); } catch { return null; }
}

/** `git rev-parse --git-dir` differs from `--git-common-dir` (both resolved). A non-repo or a missing path is false. */
export function isLinkedWorktree(cwd) {
  const out = gitLines(cwd, ["rev-parse", "--git-dir", "--git-common-dir"]);
  if (!out || out.length < 2) return false;
  const gitDir = resolveGit(cwd, out[0]);
  const common = resolveGit(cwd, out[1]);
  return gitDir !== null && common !== null && gitDir !== common;
}

function commonDirOf(dir) {
  if (typeof dir !== "string" || dir === "") return null;
  const out = gitLines(dir, ["rev-parse", "--git-common-dir"]);
  return out && out.length ? resolveGit(dir, out[0]) : null;
}

// ------------------------------------------------------------------------------------------ the lane check

const HL = await (async () => {
  if (!fs.existsSync(HL_DIR)) return { absent: true };
  try {
    const live = await import(pathToFileURL(path.join(HL_DIR, "live.mjs")).href);
    const lane = await import(pathToFileURL(path.join(HL_DIR, "lane-lib.mjs")).href);
    for (const [n, f] of [["readRegistry", live.readRegistry], ["liveness", live.liveness], ["normPath", lane.normPath]]) {
      if (typeof f !== "function") throw new Error(`${n} is not exported`);
    }
    return { readRegistry: live.readRegistry, liveness: live.liveness, normPath: lane.normPath };
  } catch (e) {
    return { error: String(e?.message ?? e).split("\n")[0].slice(0, 160) };
  }
})();

/**
 * Decision 9 and ruling (a). With `HL_SESSION_ID` set, `cwd` is that registry entry's worktree, or a linked worktree of
 * the same repository (the lane's own, self-created one: Codex gets its own worktree and runs in parallel). With it
 * unset (a hand-opened session) any worktree is fine. In both cases `cwd` must not be the worktree of another lane
 * whose newest generation is not `gone` (`unknown` blocks: the conservative side). If the handoff-launch folder is
 * absent the check is skipped with a note; if it is there but does not load, the run is blocked.
 */
export function laneCheck(cwd) {
  if (HL.absent) return { ok: true, note: "lane-check: handoff-launch absent" };
  if (HL.error) return { ok: false, reason: `lane-check-failed: ${HL.error}` };
  try {
    const reg = HL.readRegistry();
    const target = HL.normPath(cwd);
    const sid = process.env.HL_SESSION_ID;
    let own = null;
    if (sid) {
      own = [...reg.entries].reverse().find((e) => e.id === sid) ?? null;
      if (!own) return { ok: false, reason: `lane-unknown: HL_SESSION_ID ${sid} is not in the registry` };
      if (!own.worktree || HL.normPath(own.worktree) !== target) {
        const mine = commonDirOf(own.worktree);
        const theirs = commonDirOf(cwd);
        if (!mine || !theirs || mine !== theirs || !isLinkedWorktree(cwd)) {
          return { ok: false, reason: "lane-mismatch: --cwd is neither this lane's worktree nor a linked worktree of its repository" };
        }
      }
    }
    const newest = new Map(); // lane name -> newest launch (the registry is append-only: the later line wins)
    for (const e of reg.entries) newest.set(e.name, e);
    for (const e of newest.values()) {
      if (own && e.name === own.name) continue;
      if (!e.worktree || HL.normPath(e.worktree) !== target) continue;
      const lv = HL.liveness(e, reg);
      if (lv.state !== "gone") return { ok: false, reason: `lane-busy: lane ${e.name} owns this worktree (${lv.state}: ${lv.why ?? "?"})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `lane-check-failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}` };
  }
}

// ------------------------------------------------------------------------------------------ --continue

/**
 * `prevMeta` is the earlier write run's meta.json ({cwd, mode, baseline, diff_hash, ...}). The worktree may hold exactly
 * that run's residual edits: the same worktree, HEAD still at the recorded baseline, and the diff hash of the whole
 * tree (tracked and untracked, against that baseline) equal to the hash recorded at the end of that run.
 */
export function continueCheck(prevMeta, cwd) {
  const no = (why) => ({ ok: false, reason: `continue-mismatch: ${why}` });
  if (!prevMeta || typeof prevMeta !== "object" || Array.isArray(prevMeta)) return no("no meta.json for that run");
  if (prevMeta.mode !== "write") return no("that run was not a write run");
  if (typeof prevMeta.baseline !== "string" || prevMeta.baseline === "") return no("that run recorded no baseline");
  if (typeof prevMeta.diff_hash !== "string" || !/^[0-9a-f]{64}$/.test(prevMeta.diff_hash)) return no("that run recorded no final diff hash");
  try {
    if (canonPath(String(prevMeta.cwd)) !== canonPath(cwd)) return no("that run belongs to another worktree");
  } catch {
    return no("that run's worktree cannot be resolved");
  }
  try {
    if (baseline(cwd) !== prevMeta.baseline) return no("HEAD moved since that run");
    if (diffHash(cwd, prevMeta.baseline) !== prevMeta.diff_hash) return no("the worktree differs from that run's final state");
  } catch (e) {
    return no(`git failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 100)}`);
  }
  return { ok: true };
}
