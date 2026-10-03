// Rolling merges for handoff-launch fan-out groups (stage 1): group config, merge.lock, the merge worktree, the drain
// loop and the overlap check. launch.mjs owns the CLI and the registry and passes them in as ctx = {readRegistry,
// append, launchMjs, root, repoKey, group}. Every decision is code; a model session starts only for a real conflict
// or a failing test.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as L from "./merge-lib.mjs";

const MIN = 60000;
const RUN_TEST = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-test.mjs");
const iso = () => new Date().toISOString();

export const git = (dir, ...a) => {
  const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};
export function worktrees(root) {
  return git(root, "worktree", "list", "--porcelain").out.split(/\r?\n\r?\n/).map((blk) => {
    const o = {}; for (const l of blk.split(/\r?\n/)) { const [k, ...v] = l.split(" "); o[k] = v.join(" ") || true; } return o;
  });
}
// Keep <main>/.claude/worktrees/ out of the main checkout's `git status` (local-only exclude, never committed).
export function excludeWorktrees(root) {
  const excl = path.join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").out, "info", "exclude");
  const cur = fs.existsSync(excl) ? fs.readFileSync(excl, "utf8") : "";
  if (!/^\/?\.claude\/worktrees\/?$/m.test(cur)) { fs.mkdirSync(path.dirname(excl), { recursive: true }); fs.appendFileSync(excl, `${cur && !cur.endsWith("\n") ? "\n" : ""}.claude/worktrees/\n`); }
}
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export const groupDir = (root, group) => path.join(root, ".superpowers", "sessions", group);
export const mergeWorktree = (root, group) => path.join(root, ".claude", "worktrees", `_merge-${group}`);
const lockFile = (gd) => path.join(gd, "merge.lock");

// ---------- group config: null = legacy group (all_done -> <group>-merge) ----------
export function readConfig(gd) {
  const f = path.join(gd, "config.json");
  if (!fs.existsSync(f)) return null;
  try { return L.validateConfig(JSON.parse(fs.readFileSync(f, "utf8"))); }
  catch (e) { return { ok: false, errors: [`${L.fwd(f)} is not valid JSON: ${e.message}`] }; }
}
export function writeConfig(root, group, raw, force) {
  const v = L.validateConfig(raw);
  if (!v.ok) return v;
  for (const b of [v.config.integration, v.config.target]) if (!git(root, "check-ref-format", "--branch", b).ok) return { ok: false, errors: [`not a valid branch name: ${b}`] };
  if (!git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${v.config.target}`).ok) return { ok: false, errors: [`target branch ${v.config.target} does not exist`] };
  const gd = groupDir(root, group), file = path.join(gd, "config.json");
  if (fs.existsSync(file) && !force) return { ok: false, errors: [`${L.fwd(file)} exists - pass --force to overwrite it`] };
  fs.mkdirSync(gd, { recursive: true });
  writeAtomic(file, JSON.stringify(v.config, null, 2) + "\n");
  const ignored = git(root, "check-ignore", "-q", ".superpowers/sessions").ok;
  return { ok: true, file, config: v.config, warn: ignored ? null : ".superpowers/ is not git-ignored in this repo - add it to .gitignore" };
}

// ---------- merge.lock ----------
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
export const lockStateOf = (lock, cfg) => L.lockState(lock, { pidAlive, now: Date.now(), maxAgeMs: (cfg.test_timeout_min + 10) * MIN });
export function readLock(gd) { try { return L.parseLock(fs.readFileSync(lockFile(gd), "utf8")); } catch { return null; } }
export const ownsLock = (gd, token) => readLock(gd)?.token === token;
// Create the lock WITH its content in one step: hard-link a finished temp file to merge.lock. link() fails when the
// lock exists, so nobody ever reads a half-written lock.
function linkCreate(file, text) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.linkSync(tmp, file); return true; }
  catch (e) { if (e.code === "EEXIST") return false; throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
}
// Move a dead holder's lock aside - only the very lock judged dead (same token). If a live holder slipped in between,
// put its lock back. (If a third process grabbed the lock in that instant the restore fails; ownsLock() before the
// commit and git's own index.lock then stop the second merge. Whoever ends up holding the lock aborts a leftover merge.)
function reclaimLock(gd, held) {
  const f = lockFile(gd), aside = `${f}.reclaimed-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try { fs.renameSync(f, aside); } catch { return false; }
  let moved = null; try { moved = L.parseLock(fs.readFileSync(aside, "utf8")); } catch {}
  if (moved?.token === held.token) { fs.rmSync(aside, { force: true }); return true; }
  try { fs.linkSync(aside, f); fs.rmSync(aside, { force: true }); } catch {}
  return false;
}
export function acquireLock(gd, body, cfg) {
  fs.mkdirSync(gd, { recursive: true });
  const lock = { holder: "drain", ...body, token: crypto.randomUUID(), at: iso() };
  let reclaimed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let made;
    try { made = linkCreate(lockFile(gd), JSON.stringify(lock)); }
    catch (e) { return { ok: false, lock: null, state: "error", error: `merge.lock needs a filesystem with hard links (${e.code || e.message})` }; }
    if (made) return { ok: true, lock, reclaimed };
    const held = readLock(gd);
    if (!held) continue; // released between our attempt and the read
    const state = lockStateOf(held, cfg);
    if (state !== "drain-dead") return { ok: false, lock: held, state };
    reclaimed = reclaimLock(gd, held) || reclaimed;
  }
  const held = readLock(gd);
  return { ok: false, lock: held, state: held ? lockStateOf(held, cfg) : "contended" };
}
export function releaseLock(gd, token) {
  if (!ownsLock(gd, token)) return false;
  fs.rmSync(lockFile(gd), { force: true });
  return true;
}

// ---------- lanes ----------
// Latest registry entry per lane name (merge sessions excluded), its done marker, and whether that marker's head is
// merged (a {merged} record for that head, or the head is already in the integration branch) or merge-blocked.
export function groupLanes({ entries, merges, group, repoKey, cfg, root }) {
  const latest = new Map();
  for (const e of entries) {
    if (e.group !== group || (repoKey && e.repo !== repoKey) || L.isMergeSession(group, e.name)) continue;
    const prev = latest.get(e.name);
    if (!prev || prev.launched_at < e.launched_at) latest.set(e.name, e);
  }
  return [...latest.values()].map((e) => {
    let marker = null;
    if (e.done_marker && fs.existsSync(e.done_marker)) {
      try { marker = JSON.parse(fs.readFileSync(e.done_marker, "utf8")); } catch { marker = { unreadable: true }; }
      // null, false, 0, a string or an array is no marker object: unreadable, never "open" (it would never merge).
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) marker = { unreadable: true };
    }
    const head = marker?.head ? String(marker.head) : null;
    const rec = (k) => [...merges].reverse().find((m) => m[k] === e.name && m.group === group && (!repoKey || m.repo === repoKey) && head && m.head === head);
    const mergedRec = rec("merged");
    let merged = !!mergedRec;
    if (!merged && head && cfg && root) {
      const c = git(root, "rev-parse", "--verify", "--quiet", `${head}^{commit}`);
      merged = c.ok && git(root, "merge-base", "--is-ancestor", c.out, `refs/heads/${cfg.integration}`).ok;
    }
    return { name: e.name, branch: e.branch, entry: e, marker, merged, mergedSha: mergedRec?.sha ?? null, mergeBlocked: rec("merge_blocked")?.why ?? null };
  });
}
export function lanesNow(ctx, cfg) {
  const reg = ctx.readRegistry();
  return { reg, lanes: L.classify(groupLanes({ entries: reg.entries, merges: reg.merges || [], group: ctx.group, repoKey: ctx.repoKey, cfg, root: ctx.root })) };
}
export function sessionClosed(reg, name) {
  const e = [...reg.entries].reverse().find((x) => x.name === name);
  return !!e && reg.closed.has(e.id);
}

// ---------- overlap: files each finished lane shares with each running lane, written into its done marker ----------
export function refreshOverlap(root, cfg, lanes, { write = true } = {}) {
  const files = (ref) => { const r = git(root, "diff", "--name-only", `${cfg.target}...${ref}`); return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : []; };
  const finished = lanes.filter((l) => l.state === "queued");
  const running = lanes.filter((l) => l.state === "open" && l.branch && l.branch !== "HEAD");
  const pairs = L.overlapPairs(finished.map((l) => ({ name: l.name, files: files(l.marker.head) })), running.map((l) => ({ name: l.name, files: files(l.branch) })));
  for (const l of finished) {
    const overlap = Object.fromEntries(pairs.filter((p) => p.finished === l.name).map((p) => [p.running, p.files]));
    if (JSON.stringify(l.marker.overlap || {}) === JSON.stringify(overlap)) continue;
    l.marker.overlap = overlap;
    if (write) writeAtomic(l.entry.done_marker, JSON.stringify(l.marker, null, 2) + "\n");
  }
  return pairs;
}

// ---------- the merge worktree ----------
export function ensureMergeWorktree(root, group, cfg) {
  const dir = mergeWorktree(root, group);
  const hit = worktrees(root).find((w) => w.branch === `refs/heads/${cfg.integration}`);
  if (hit && !hit.prunable) {
    if (L.key(hit.worktree) !== L.key(dir)) return { ok: false, why: `integration branch ${cfg.integration} is checked out at ${hit.worktree}, not the merge worktree ${L.fwd(dir)} - free it there and re-run` };
    return { ok: true, dir };
  }
  if (hit?.prunable || fs.existsSync(dir)) git(root, "worktree", "prune");
  if (fs.existsSync(dir)) return { ok: false, why: `${L.fwd(dir)} exists but is not a worktree of ${cfg.integration} - move it away and re-run` };
  const exists = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${cfg.integration}`).ok;
  const r = exists ? git(root, "worktree", "add", dir, cfg.integration) : git(root, "worktree", "add", dir, "-b", cfg.integration, cfg.target);
  if (!r.ok) return { ok: false, why: `git worktree add failed: ${r.err}` };
  excludeWorktrees(root);
  return { ok: true, dir };
}

const tailLines = (s, n) => String(s).split(/\r?\n/).slice(-n).join("\n").trim();
const inMerge = (wt) => git(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD").ok;
// How a test run ended: "exit <n>", or why there is no exit code (the runner was killed or timed out).
export function testExitLabel(t, ms) {
  if (t.status != null) return `exit ${t.status}`;
  if (t.error?.code === "ETIMEDOUT") return `killed: no result after ${Math.round(ms / 1000)} s`;
  return `killed${t.signal ? ` by ${t.signal}` : ""}: no exit code`;
}
// Abort and prove the worktree is back where it was.
function abortMerge(wt, before) {
  if (inMerge(wt)) git(wt, "merge", "--abort");
  const head = git(wt, "rev-parse", "HEAD").out, dirty = git(wt, "status", "--porcelain", "--untracked-files=no").out;
  return head === before && !dirty ? { ok: true }
    : { ok: false, why: `merge worktree ${L.fwd(wt)} did not return to ${before.slice(0, 7)} after the abort (HEAD ${head.slice(0, 7)}${dirty ? ", uncommitted changes" : ""}) - inspect it by hand` };
}

// Merge one finished lane in the merge worktree: git merge --no-ff --no-commit, the test command, then the commit.
// Any failure aborts, so the integration branch moves only on success.
// -> {result:"merged"|"already", sha} | {result:"conflict", conflicts, output} | {result:"test-failed", code, output}
//    | {result:"lane-error", why} (this lane only) | {result:"error", why} (stop the drain)
export function mergeOne({ wt, gd, lane, cfg, owns }) {
  const c = git(wt, "rev-parse", "--verify", "--quiet", `${lane.marker.head}^{commit}`);
  if (!c.ok) return { result: "lane-error", why: `done-marker head ${lane.marker.head} is not a commit in this repo` };
  const head = c.out;
  if (git(wt, "merge-base", "--is-ancestor", head, "HEAD").ok) return { result: "already", sha: git(wt, "rev-parse", "HEAD").out };
  if (git(wt, "status", "--porcelain", "--untracked-files=no").out || inMerge(wt))
    return { result: "error", why: `merge worktree ${L.fwd(wt)} is not clean (a half-finished merge or hand edits) - inspect it, git merge --abort / git stash there, then re-run` };
  const before = git(wt, "rev-parse", "HEAD").out;
  const m = git(wt, "merge", "--no-ff", "--no-commit", head);
  if (!m.ok) {
    const conflicts = git(wt, "diff", "--name-only", "--diff-filter=U").out.split(/\r?\n/).filter(Boolean);
    const output = `${m.out}\n${m.err}`.trim();
    const back = abortMerge(wt, before);
    if (!back.ok) return { result: "error", why: back.why };
    return conflicts.length ? { result: "conflict", conflicts, output } : { result: "error", why: `git merge failed without conflicts: ${output}` };
  }
  if (cfg.test) {
    const ms = Math.round(cfg.test_timeout_min * MIN), log = path.join(gd, `test-${L.slug(lane.name)}.log`);
    const limit = ms + 2 * MIN;
    const t = spawnSync(process.execPath, [RUN_TEST, wt, String(ms), log, cfg.test], { encoding: "utf8", timeout: limit });
    if (t.status !== 0) {
      let output = ""; try { output = tailLines(fs.readFileSync(log, "utf8"), 80); } catch {}
      const back = abortMerge(wt, before);
      if (!back.ok) return { result: "error", why: back.why };
      return { result: "test-failed", code: t.status, exit: testExitLabel(t, limit), output };
    }
  }
  if (!owns()) { abortMerge(wt, before); return { result: "error", why: "lost merge.lock during the merge (forced or reclaimed by another process) - aborted, nothing committed" }; }
  const done = git(wt, "commit", "-q", "-m", `Merge lane ${lane.name} (${lane.branch} @ ${head.slice(0, 7)}) into ${cfg.integration}`);
  if (!done.ok) { const back = abortMerge(wt, before); return { result: "error", why: `git commit failed: ${done.err || done.out}${back.ok ? "" : ` | ${back.why}`}` }; }
  return { result: "merged", sha: git(wt, "rev-parse", "HEAD").out };
}

// Hand the lock to a merge session for this lane and launch it (<group>-merge-<lane>, opus/high, reusing the merge
// worktree). If the launch fails the lock is released, so the next merge retries the lane.
function launchMergeSession(ctx, { gd, token, lane, cfg, wt, r, lanes }) {
  const name = L.slug(`${ctx.group}-merge-${lane.name}`);
  const file = path.join(gd, `${name}.handoff.md`);
  writeAtomic(file, L.conflictHandoff({
    group: ctx.group, lane: lane.name, branch: lane.branch, head: lane.marker.head, integration: cfg.integration,
    target: cfg.target, wt: L.fwd(wt), before: git(wt, "rev-parse", "HEAD").out, reason: r.result, conflicts: r.conflicts || [],
    output: r.output, code: r.code, exit: r.exit, test: cfg.test, overlap: lanes.find((l) => l.name === lane.name)?.marker?.overlap,
    launchMjs: L.fwd(ctx.launchMjs), root: L.fwd(ctx.root), at: iso(), session: name,
  }));
  if (!ownsLock(gd, token)) return { ok: false, lines: ["ERROR lost merge.lock before launching the merge session - nothing launched"] };
  writeAtomic(lockFile(gd), JSON.stringify({ holder: "session", token, session: name, lane: lane.name, head: lane.marker.head, at: iso() }));
  const started = iso();
  const p = spawnSync(process.execPath, [ctx.launchMjs, "--repo", ctx.root, "--handoff", file, "--group", ctx.group, "--name", name,
    "--model", "opus", "--effort", "high", "--worktree", cfg.integration, "--mode", cfg.mode, "--no-close"], { encoding: "utf8", timeout: 3 * MIN });
  const what = r.result === "conflict" ? `CONFLICT ${lane.name}: ${r.conflicts.length} file(s): ${r.conflicts.join(", ")}`
    : `TEST FAILED ${lane.name} (${r.exit ?? `exit ${r.code}`}) after a clean merge`;
  const launched = `${what} - merge session ${name} launched (handoff ${L.fwd(file)}); merge.lock stays held until it finishes`;
  if (p.status !== 0) {
    const tail = tailLines(`${p.stdout || ""}${p.stderr || ""}`, 10);
    // bg mode returns `claude --bg`'s status after the session may already run, and a timeout has no status: if the
    // launcher registered the session, it owns the lock - releasing it would let a drain merge under its feet.
    if (ctx.readRegistry().entries.some((e) => e.name === name && e.launched_at >= started))
      return { ok: true, lines: [launched, `merge session ${name} was registered but its launcher exited ${p.status ?? "without a status (killed or timed out)"}: ${tail} - if that session is not running, merge --force retries the lane`] };
    releaseLock(gd, token);
    return { ok: false, lines: [`ERROR could not launch merge session ${name}: ${tail}`, "merge.lock released - the next merge retries this lane"] };
  }
  return { ok: true, lines: [launched] };
}

// A merge session holds the lock: release it once its lane is merged, skipped (merge-blocked), reopened (open) or gone.
// Blocked, invalid or unreadable markers keep the lock: the session may still have a half merge in the worktree.
function settleSession(ctx, gd, held, cfg) {
  const { reg, lanes } = lanesNow(ctx, cfg);
  const lane = lanes.find((l) => l.name === held.lane);
  if (lane?.state === "merged") {
    if (!(reg.merges || []).some((m) => m.merged === lane.name && m.group === ctx.group && m.head === String(lane.marker.head)))
      ctx.append({ merged: lane.name, group: ctx.group, repo: ctx.repoKey, branch: lane.branch, head: String(lane.marker.head), sha: git(ctx.root, "rev-parse", `refs/heads/${cfg.integration}`).out, by: held.session, at: iso() });
    releaseLock(gd, held.token);
    return { released: true, lines: [`merged ${lane.name} -> ${cfg.integration} by ${held.session}; merge.lock released`] };
  }
  const state = lane ? lane.state : "gone";
  if (state === "gone" || state === "open" || state === "merge-blocked") {
    releaseLock(gd, held.token);
    return { released: true, lines: [`released merge.lock held by ${held.session}: lane ${held.lane} is ${state}`] };
  }
  if (state !== "queued")
    return { released: false, lines: [`queued: ${held.session} holds merge.lock for ${held.lane}, which is now ${state} - finish or abort that session's merge, then merge --skip ${held.lane} --why <reason> or merge --force`] };
  const gone = ctx.sessionGone ? ctx.sessionGone(held.session) : sessionClosed(reg, held.session);
  const stale = gone ? ` - STALE: that session is gone (window closed or process ended) - merge --force retries the lane, merge --skip ${held.lane} --why <reason> gives up on it` : "";
  return { released: false, lines: [`queued: ${held.session} is resolving ${held.lane}${stale}`] };
}

// Give up on a lane's current head (a person or its merge session decided it cannot merge): record merge_blocked for
// that head, and free the lock if that lane's merge session holds it - whatever the lane's state now (settleSession keeps
// the lock for a blocked or unreadable lane, so this is the way out). A later done marker with a new head is queued again.
// Refused while that session's merge is still in progress in the merge worktree: releasing the lock then would let the
// next drain abort the session's half merge as a leftover and merge another lane under it.
export function skipLane(ctx, name, why) {
  const gd = groupDir(ctx.root, ctx.group), c = readConfig(gd);
  if (!c?.ok) return { ok: false, line: c ? `ERROR config: ${c.errors.join("; ")}` : L.legacyText(ctx.group) };
  const lane = lanesNow(ctx, c.config).lanes.find((l) => l.name === name);
  const held = readLock(gd), mine = held?.holder === "session" && held.lane === name;
  if (lane?.state === "merged") return { ok: false, line: `ERROR lane ${name} is already merged into ${c.config.integration} - nothing to skip` };
  // A blocked or unreadable marker may have no head: the session lock records the head it was resolving.
  const head = lane?.marker?.head ? String(lane.marker.head) : mine && held.head ? String(held.head) : null;
  if (!head && !mine) return { ok: false, line: lane ? `ERROR lane ${name} has no done marker with a head - nothing to skip` : `ERROR lane ${name} is not a member of group ${ctx.group} - nothing to skip` };
  const wt = mergeWorktree(ctx.root, ctx.group);
  if (mine && fs.existsSync(wt) && inMerge(wt))
    return { ok: false, line: `ERROR ${name}'s merge is still in progress in ${L.fwd(wt)} - git merge --abort there first (a dead session: merge --force)` };
  if (head) ctx.append({ merge_blocked: name, group: ctx.group, repo: ctx.repoKey, head, why, at: iso() });
  if (mine) { releaseLock(gd, held.token); return { ok: true, line: `skipped ${name} (${why}); released merge.lock held by ${held.session}` }; }
  return { ok: true, line: `skipped ${name} (${why})` };
}

// Clear a stale lock (status says STALE, or the holder is known to be gone) -> {ok, line}; ok:false is a refusal.
// It never touches the merge worktree: the next drain aborts a leftover merge under its own fresh lock, then retries
// the lane, which relaunches its merge session on a conflict. Refused: a live merge process younger than the test
// timeout (it is merging right now), a session lock whose lane is already merged (a plain merge records that merge
// and releases the lock - clearing it would lose the {merged} record), and a session lock while a merge is in progress
// in the merge worktree (the session may still be resolving it: the person aborts it there first). Whether a session
// is still running is checked by the caller (launch.mjs owns the process checks).
export function forceUnlock(ctx) {
  const gd = groupDir(ctx.root, ctx.group), c = readConfig(gd);
  if (!c?.ok) return { ok: false, line: "not a rolling-merge group with a valid config.json - nothing cleared" };
  const held = readLock(gd);
  if (!held) return { ok: true, line: "no merge.lock to clear" };
  if (held.holder === "drain" && lockStateOf(held, c.config) === "drain-live")
    return { ok: false, line: `not cleared: merge.lock is held by ${L.describeLock(held)}, which is alive and younger than the test timeout - it is merging now` };
  if (held.holder === "session" && lanesNow(ctx, c.config).lanes.find((l) => l.name === held.lane)?.state === "merged")
    return { ok: false, line: `not cleared: lane ${held.lane} is already merged - run merge without --force (it records the merge and releases the lock)` };
  // The session may still be resolving there: the next drain would abort its uncommitted resolution. --force never aborts.
  const wt = mergeWorktree(ctx.root, ctx.group);
  if (held.holder === "session" && fs.existsSync(wt) && inMerge(wt))
    return { ok: false, line: `not cleared: a merge is in progress in ${L.fwd(wt)} - if ${held.session} is gone, git merge --abort there first, then re-run merge --force` };
  // Move aside only the very lock judged above; if another holder took it in between, put that one back.
  const f = lockFile(gd), aside = `${f}.forced-${Date.now()}`;
  try { fs.renameSync(f, aside); } catch { return { ok: true, line: "merge.lock was released while clearing it - nothing to clear" }; }
  let moved = null; try { moved = L.parseLock(fs.readFileSync(aside, "utf8")); } catch {}
  if (moved?.token !== held.token) {
    try { fs.linkSync(aside, f); fs.rmSync(aside, { force: true }); } catch {}
    return { ok: false, line: `not cleared: merge.lock changed hands while clearing it (now ${L.describeLock(moved)}) - check status and re-run` };
  }
  return { ok: true, line: `cleared merge.lock (${L.describeLock(held)})` };
}

// Merge every finished lane, one at a time, under merge.lock. Called by `merge` and by `status`.
export function drain(ctx, { prefer } = {}) {
  const gd = groupDir(ctx.root, ctx.group), out = [];
  const c = readConfig(gd);
  if (!c) return { code: 0, lines: [L.legacyText(ctx.group)] };
  if (!c.ok) return { code: 1, lines: c.errors.map((e) => `ERROR config: ${e}`) };
  const cfg = c.config;
  if (prefer) {
    const me = lanesNow(ctx, cfg).lanes.find((l) => l.name === prefer);
    if (!me) out.push(`lane ${prefer}: not a member of group ${ctx.group}`);
    else if (me.state !== "queued") out.push(`lane ${prefer}: ${me.state}`);
  }
  for (let round = 0; round < 100; round++) {
    const held = readLock(gd);
    if (held?.holder === "session") {
      const s = settleSession(ctx, gd, held, cfg);
      out.push(...s.lines);
      if (!s.released) return { code: 0, lines: out };
      continue;
    }
    let { lanes } = lanesNow(ctx, cfg);
    let next = L.mergeQueue(lanes, prefer)[0];
    if (!next) break;
    const acq = acquireLock(gd, { pid: process.pid, lane: next.name }, cfg);
    if (!acq.ok) {
      if (acq.error) { out.push(`ERROR ${acq.error}`); return { code: 1, lines: out }; }
      if (acq.lock?.holder === "session") continue;
      out.push(acq.lock ? `queued: merge.lock is held by ${L.describeLock(acq.lock)}, which merges the finished lanes after its own${L.lockHint(acq.state)}`
        : "merge.lock changed hands repeatedly - run merge again");
      return { code: 0, lines: out };
    }
    const token = acq.lock.token;
    const wt = ensureMergeWorktree(ctx.root, ctx.group, cfg);
    if (!wt.ok) { releaseLock(gd, token); out.push(`ERROR ${wt.why}`); return { code: 1, lines: out }; }
    // Under a freshly acquired drain lock no legitimate merge is in progress here: a MERGE_HEAD is left over (a dead
    // merge process, a lost reclaim race, a deleted stale lock). Abort it; hand edits without one are still refused.
    if (inMerge(wt.dir)) {
      const ab = git(wt.dir, "merge", "--abort");
      if (!ab.ok || inMerge(wt.dir)) { releaseLock(gd, token); out.push(`ERROR could not abort the unfinished merge left in ${L.fwd(wt.dir)}: ${ab.err || ab.out} - inspect it by hand`); return { code: 1, lines: out }; }
      out.push(acq.reclaimed ? "reclaimed merge.lock from a dead merge process and aborted its unfinished merge" : "aborted an unfinished merge left in the merge worktree");
    }
    for (;;) {
      ({ lanes } = lanesNow(ctx, cfg));
      next = L.mergeQueue(lanes, prefer)[0];
      if (!next) break;
      refreshOverlap(ctx.root, cfg, lanes);
      // A fresh `at` per lane: a long drain stays drain-live (status and --force age the lock from `at`).
      if (ownsLock(gd, token)) writeAtomic(lockFile(gd), JSON.stringify({ ...acq.lock, at: iso() }));
      const r = mergeOne({ wt: wt.dir, gd, lane: next, cfg, owns: () => ownsLock(gd, token) });
      const rec = { group: ctx.group, repo: ctx.repoKey, head: String(next.marker.head), at: iso() };
      if (r.result === "merged" || r.result === "already") {
        ctx.append({ merged: next.name, ...rec, branch: next.branch, sha: r.sha, by: "drain" });
        out.push(r.result === "merged" ? `merged ${next.name} -> ${cfg.integration} ${r.sha.slice(0, 7)}` : `merged ${next.name} (already contained in ${cfg.integration})`);
        continue;
      }
      if (r.result === "lane-error") { ctx.append({ merge_blocked: next.name, ...rec, why: r.why }); out.push(`MERGE-BLOCKED ${next.name}: ${r.why}`); continue; }
      if (r.result === "error") { releaseLock(gd, token); out.push(`ERROR ${r.why}`); return { code: 1, lines: out }; }
      const s = launchMergeSession(ctx, { gd, token, lane: next, cfg, wt: wt.dir, r, lanes });
      out.push(...s.lines);
      return { code: s.ok ? 0 : 1, lines: out };
    }
    releaseLock(gd, token);
    // The next round re-scans: a lane that finished while we held the lock printed "queued" and exited, so it is ours.
  }
  const { lanes } = lanesNow(ctx, cfg);
  if (L.finalReady(lanes) && !readLock(gd)) out.push(L.finalReadyText(ctx.group, cfg, lanes));
  if (!out.length) out.push("nothing to merge");
  return { code: 0, lines: out };
}
