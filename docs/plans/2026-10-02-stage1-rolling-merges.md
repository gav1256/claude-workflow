# Stage 1: rolling deterministic merges + overlap check: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fan-out lanes are merged into the group's integration branch one at a time as soon as each lane finishes,
by deterministic code under a lock, while the other lanes keep running. A model session is launched only for a real
conflict or a failing test.

**Architecture:** Two new modules sit next to `launch.mjs` in `claude/skills/handoff-launch/`. `merge-lib.mjs` holds
pure functions (config validation, lock judgement, lane classification, queue order, overlap pairs, the generated
merge-session handoff, status text). `merge.mjs` holds the side effects: the group config file, `merge.lock`, the
scratch merge worktree, the drain loop, and the overlap writer. `run-test.mjs` runs the group's test command with a
tree-killing timeout. `launch.mjs` gains the `group`, `merge` and `overlap` subcommands, a rolling `status`, a test
hook (`HL_NO_SPAWN`) and the stage-1 guards. Groups **without** `config.json` are legacy groups and keep the old
all_done → `<group>-merge` flow byte for byte.

**Tech Stack:** Node ≥ 18 ESM (`node:fs`, `node:child_process`, `node:test`), git ≥ 2.38 worktrees. No dependencies.

**Spec:** `docs/specs/2026-10-02-parallel-sessions-design.md`, section "Stage 1" (approved 2026-10-02; approval covers
stage 1 only).

## Global Constraints

- Decisions come from deterministic code, never a model call. Zero tokens for a clean merge.
- No cross-contamination: a merge never writes into a lane's worktree, and running lanes are never touched.
- Merges run only in the scratch worktree `<main repo>/.claude/worktrees/_merge-<group>` on the integration branch,
  never a lane's worktree and never the main checkout.
- The final merge into the target branch is a human-approved step and never pushes without asking.
- A merge session is `<group>-merge-<lane>`, `--model opus --effort high`, launched with `--worktree <integration
  branch>` so it reuses the `_merge-<group>` worktree.
- Group config: `<main repo>/.superpowers/sessions/<group>/config.json` =
  `{"test": "<cmd>", "integration": "<branch>", "target": "<branch>"}` (plus optional `test_timeout_min`, `mode`).
- Backward compatible: groups launched before this change (no `config.json`) keep the all_done → `<group>-merge`
  flow, the `status` output and the `merge.lock` launch guard exactly as today.
- Tests never touch the real registry: always `HL_REGISTRY_DIR=<temp>`, `HL_AGENTS_JSON=<file containing []>`,
  `HL_PROJECTS_DIR=<temp>`, `HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, temp git repos. Never `/dev/null` for
  `HL_AGENTS_JSON` (Node on Windows resolves it to `nul` and fails).
- Every change lands in both `claude/skills/handoff-launch/` (repo) and `~/.claude/skills/handoff-launch/` (live), and
  the copies stay identical. Deploy to live only after the tests and the review pass.
- No private names in the repo: the secret scan
  `grep -rniE "<the scan pattern from the private handoff>" . --exclude-dir=.git` must print nothing before a push.
- Test identities use `test@example.com`.
- Large-org variant (document only): a merge queue / CI-gated PR per lane instead of local merges.

## Decisions beyond the spec's text

- `merge` takes no `--test` flag: `config.json` is the single source of the test command ("so lanes don't guess").
- `launch.mjs group` writes `config.json` (validated: branch names, existing target, integration ≠ target). It refuses
  a group that already launched lanes without a config, so a running legacy group can never be switched mid-flight.
- Nobody is auto-launched at the end. The `merge` call that finds every lane merged or blocked prints `FINAL_READY`;
  the session that ran it asks the user to approve the final merge, then launches `next_after_merge` as a new group.
- `--skip <lane> --why` (give up on a lane's current head) and `--force` (clear a STALE lock) are the recovery paths.
  A lock whose merging process is dead is reclaimed automatically; nothing else is.
- Merge records are keyed by the done-marker head, so a lane reopened before its merge and re-done is merged again.
- `HL_NO_SPAWN=1` is a new test hook: the launcher records the launch and starts nothing.

## Review Focus

1. **Two lanes finish at the same instant** and both run `merge`: exactly one merges at a time, both lanes end up
   merged exactly once, and neither caller fails. (Test: Task 3, "two lanes finishing at the same moment".)
2. **A merge process dies mid-merge** (killed during the test command) and leaves `MERGE_HEAD` in the merge worktree
   plus a lock whose pid is dead: the next `merge` reclaims the lock, aborts the leftover half merge, and merges
   normally; it never commits the leftover state. (Test: Task 3, "a dead merge process's lock is reclaimed".)
3. **The integration branch is checked out somewhere else** (the main checkout or another worktree): `merge` stops
   with an ERROR naming that location, releases the lock and changes nothing. (Test: Task 3, "integration branch
   checked out elsewhere".)
4. **The test command hangs**: it is killed with its whole process tree after `test_timeout_min`, the merge is aborted
   and a merge session gets the timeout output. (Test: Task 3, "a hanging test command times out".)
5. **A lane re-done after `--reopen` or after `--skip`** gets a new head: the old head's `merged`/`merge_blocked`
   record does not apply to it, so it is queued and merged again. (Test: Task 4, "a skipped lane re-done with a new
   head is merged".)

Also watch, by review rather than test: the drain's re-scan after releasing the lock (a lane that printed `queued`
in the instant before the release must still be merged), and `reclaimLock` putting back a lock that a live holder
created in the race window.

## File structure

| File | Responsibility |
|---|---|
| `claude/skills/handoff-launch/merge-lib.mjs` (new) | Pure helpers: `slug/fwd/key`, `isMergeSession`, `validateConfig`, `parseLock`, `lockState`, `lockHint`, `describeLock`, `classify`, `mergeQueue`, `finalReady`, `overlapPairs`, `mergeTag`, `rollingSummary`, `legacyText`, `finalReadyText`, `conflictHandoff`. |
| `claude/skills/handoff-launch/merge.mjs` (new) | Side effects: `git`, `worktrees`, `excludeWorktrees`, `writeAtomic`, config read/write, `merge.lock` acquire/release/reclaim, `groupLanes`/`lanesNow`, `ensureMergeWorktree`, `mergeOne`, `refreshOverlap`, `drain`, `skipLane`, `forceUnlock`, `sessionClosed`. |
| `claude/skills/handoff-launch/run-test.mjs` (new) | Runs one test command with a hard timeout that kills the process tree; output to a log file. |
| `claude/skills/handoff-launch/launch.mjs` (modify) | CLI: `group`, `merge`, `overlap`, rolling `status`; `HL_NO_SPAWN`; `%` guard; lane prompt; merge-session names; rolling guards. |
| `claude/skills/handoff-launch/tests/helpers.mjs` (new) | Sandbox: temp repo + private registry + env; lane launch, commit and done-marker helpers. |
| `claude/skills/handoff-launch/tests/launcher.test.mjs` (new) | Legacy status golden, `HL_NO_SPAWN`, `%` guard, prompt and guard tests. |
| `claude/skills/handoff-launch/tests/merge-lib.test.mjs` (new) | Unit tests for every pure helper. |
| `claude/skills/handoff-launch/tests/merge.test.mjs` (new) | Temp-repo integration tests: the two-lane scenarios, locks, conflicts, failures. |
| `claude/skills/handoff-launch/tests/status.test.mjs` (new) | Rolling `status` and `overlap`. |
| `claude/skills/handoff-launch/SKILL.md` (modify) | §4 rewritten for rolling merges, legacy groups kept as a sub-section; §2 usage line. |
| `README.md`, `INSTALL_PROMPT.md` (modify) | The merge-flow sentence; the two stage-1 nits. |

Run every test from the repo root: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`.

## Execution notes for the controller

- Branch: `stage1-rolling-merges` off `main` in the main checkout (no other session works in this repo). Per-task
  commits there; the release task fast-forwards `main` and pushes.
- Dispatch sizing (`sizing-dispatches`): Task 1, 2, 6 → `worker-medium` + opus. Task 3, 4, 5 (lock and merge logic,
  data integrity in git) → `worker-high` + opus. Per-task review: `worker-high` + opus; the final whole-branch review
  is `worker-xhigh` + **fable**.
- The proving check for every task is `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`; report its real
  summary lines (`# pass`, `# fail`).

---

### Task 1: Test harness, `HL_NO_SPAWN`, the `%` guard, and the legacy-status golden

**Files:**
- Create: `claude/skills/handoff-launch/tests/helpers.mjs`
- Create: `claude/skills/handoff-launch/tests/launcher.test.mjs`
- Modify: `claude/skills/handoff-launch/launch.mjs` (header comment lines 20-22; bg branch ~413-428; window branch
  ~430-439)

**Interfaces:**
- Produces: `sandbox()` → `{ tmp, repo, reg, env, git(dir, ...args) → stdout, run(...args) → {code, out, err},
  registry() → object[], handoff, cleanup() }`; `launchLane(sb, group, name) → worktree dir` (branch
  `lane-<name>`); `commitIn(sb, dir, files, msg) → sha`; `writeDone(sb, group, name, head, extra) → marker path`;
  `LAUNCH` (absolute path of launch.mjs). Env `HL_NO_SPAWN=1`: the launcher records the launch (registry line,
  worktree) and starts nothing.

- [ ] **Step 1: Write the helpers**

`claude/skills/handoff-launch/tests/helpers.mjs`:

```js
// Test sandbox for handoff-launch: a temp git repo plus a private registry. Never touches the real registry
// (~/.claude/skills/handoff-launch/sessions.jsonl): HL_REGISTRY_DIR always points into the temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LAUNCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "launch.mjs");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export function sandbox() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hl-test-")));
  const repo = path.join(tmp, "repo"), reg = path.join(tmp, "reg");
  fs.mkdirSync(repo); fs.mkdirSync(reg);
  fs.writeFileSync(path.join(tmp, "agents.json"), "[]");
  const env = {
    ...process.env, ...GIT_ENV, HL_REGISTRY_DIR: reg, HL_AGENTS_JSON: path.join(tmp, "agents.json"),
    HL_PROJECTS_DIR: path.join(tmp, "projects"), HL_FAKE_CLAUDE: "1", HL_NO_SPAWN: "1",
  };
  const git = (dir, ...a) => {
    const r = spawnSync("git", ["-C", dir, ...a], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".superpowers/\n");
  fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
  fs.writeFileSync(path.join(repo, "check.cjs"), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0)\n");
  fs.writeFileSync(path.join(repo, "hang.cjs"), "setTimeout(() => {}, 120000)\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  const handoff = path.join(tmp, "handoff.md");
  fs.writeFileSync(handoff, "# test handoff\n");
  const run = (...a) => {
    const r = spawnSync(process.execPath, [LAUNCH, ...a], { env, encoding: "utf8", timeout: 180000 });
    return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
  };
  const regFile = path.join(reg, "sessions.jsonl");
  const registry = () => (fs.existsSync(regFile) ? fs.readFileSync(regFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { tmp, repo, reg, env, git, run, registry, handoff, cleanup };
}

// Launch a lane the way a controller does (HL_NO_SPAWN: worktree + registry line, no window). Returns its worktree.
export function launchLane(sb, group, name, extra = []) {
  const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", name, "--model", "opus", "--effort", "high",
    "--worktree", `lane-${name}`, "--group", group, ...extra);
  if (r.code !== 0) throw new Error(`launch ${name}: ${r.err}${r.out}`);
  return path.join(sb.repo, ".claude", "worktrees", `lane-${name}`);
}

export function commitIn(sb, dir, files, msg) {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  sb.git(dir, "add", "-A"); sb.git(dir, "commit", "-q", "-m", msg);
  return sb.git(dir, "rev-parse", "HEAD");
}

export function writeDone(sb, group, name, head, extra = {}) {
  const f = path.join(sb.repo, ".superpowers", "sessions", group, `${name}.done`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ name, branch: `lane-${name}`, head, status: "done", tests: "ok",
    next_after_merge: [], at: new Date().toISOString(), ...extra }));
  return f;
}
```

- [ ] **Step 2: Write the legacy-status golden test and run it against the UNMODIFIED launch.mjs**

`claude/skills/handoff-launch/tests/launcher.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane } from "./helpers.mjs";

const fwd = (p) => p.split(path.sep).join("/");

// Registry lines exactly as the pre-stage-1 launcher wrote them: the legacy all_done flow must read them unchanged.
function legacyGroup(sb) {
  sb.git(sb.repo, "branch", "laneA"); sb.git(sb.repo, "branch", "laneB");
  const head = sb.git(sb.repo, "rev-parse", "--short", "laneA");
  const gd = path.join(sb.repo, ".superpowers", "sessions", "g0");
  fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, "A.done"), JSON.stringify({ name: "A", branch: "laneA", head, status: "done", tests: "3 passed", next_after_merge: ["A2"], at: "2026-01-01T00:00:00Z" }));
  const line = (name, branch, t) => ({ id: `${name}@${t}`, name, repo: fwd(sb.repo).toLowerCase(), branch, worktree: "x", generation: 1, mode: "window", group: "g0", title: name, handoff: "h.md", done_marker: fwd(path.join(gd, `${name}.done`)), launched_at: t, session_id: null, host_pid: null, host_start: null, pid_file: null });
  const regFile = path.join(sb.reg, "sessions.jsonl");
  fs.writeFileSync(regFile, [line("A", "laneA", "2026-01-01T00:00:00.000Z"), line("B", "laneB", "2026-01-01T00:00:01.000Z")].map((o) => JSON.stringify(o)).join("\n") + "\n");
  return { gd, head, regFile, line };
}

test("legacy group status output is unchanged", () => {
  const sb = sandbox();
  try {
    const { gd, head, regFile, line } = legacyGroup(sb);
    let r = sb.run("status", "--group", "g0");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, [
      `${"A".padEnd(28)} ${"laneA".padEnd(30)} DONE  head=${head} tests=3 passed next_after_merge=["A2"]`,
      `${"B".padEnd(28)} ${"laneB".padEnd(30)} open (lane still running its stages)`,
      "members=2 done=1 all_done=false merge_launched=false merge_lock=false", ""].join("\n"));
    fs.writeFileSync(path.join(gd, "B.done"), JSON.stringify({ name: "B", branch: "laneB", head, status: "blocked", tests: "n/a" }));
    fs.writeFileSync(path.join(gd, "merge.lock"), "");
    r = sb.run("status", "--group", "g0");
    assert.match(r.out, /\nmembers=2 done=2 all_done=true merge_launched=false merge_lock=true \(STALE lock: no merge entry - relaunch the merge with --force\)\n$/);
    assert.match(r.out, /^B {28}laneB {26}BLOCKED {2}head=/m);
    fs.appendFileSync(regFile, JSON.stringify(line("g0-merge", "int", "2026-01-01T00:00:02.000Z")) + "\n");
    r = sb.run("status", "--group", "g0");
    assert.match(r.out, /\nmembers=2 done=2 all_done=true merge_launched=true merge_lock=true\n$/);
    assert.equal(sb.run("status", "--group", "none").out, "members=0 done=0 all_done=false merge_launched=false merge_lock=false\n");
  } finally { sb.cleanup(); }
});
```

Run: `node --test claude/skills/handoff-launch/tests/launcher.test.mjs`
Expected: PASS against the unmodified `launch.mjs`. This proves the golden is today's output. If it fails, fix the
**test**, never the launcher, until it passes on unmodified code.

- [ ] **Step 3: Write the failing tests for `HL_NO_SPAWN` and the `%` guard**

Append to `launcher.test.mjs`:

```js
test("HL_NO_SPAWN records a lane launch and its worktree but starts nothing", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g9", "A");
    assert.ok(fs.existsSync(path.join(wt, "shared.txt")));
    const lines = sb.registry();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].name, "A"); assert.equal(lines[0].group, "g9"); assert.equal(lines[0].host_pid, null);
    assert.equal(lines[0].branch, "lane-A");
  } finally { sb.cleanup(); }
});

test("bg mode on Windows refuses a prompt containing % (cmd.exe would expand %VAR%)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    const odd = path.join(sb.tmp, "100%done.md");
    fs.writeFileSync(odd, "# odd\n");
    const r = sb.run("--repo", sb.repo, "--handoff", odd, "--name", "pct", "--model", "opus", "--effort", "high", "--mode", "bg");
    assert.equal(r.code, 2);
    assert.match(r.err, /contains %/);
    assert.equal(sb.registry().length, 0);
  } finally { sb.cleanup(); }
});
```

Run: `node --test claude/skills/handoff-launch/tests/launcher.test.mjs`
Expected: the golden passes. "HL_NO_SPAWN …" FAILS: the launcher waits 20 s for a pid file, or opens a window running
`Start-Sleep`. If a window opened, close it. The `%` test FAILS with exit code ≠ 2.

- [ ] **Step 4: Implement**

In `launch.mjs`, extend the header comment (after the `HL_FAKE_CLAUDE=1` line):

```js
// ~/.claude/projects), HL_AGENTS_JSON (file standing in for `claude agents --json`), HL_FAKE_CLAUDE=1 (the window
// runs a sleeping powershell instead of claude), HL_NO_SPAWN=1 (record the launch - worktree, registry line - and
// start nothing; tests only).
```

Directly after the `const prompt = (...)...replace(/;/g, ",");` statement, add:

```js
// bg on Windows runs through cmd.exe, which expands %VAR% even inside the quoted prompt: refuse rather than mangle it.
if (mode === "bg" && process.platform === "win32" && prompt.includes("%")) {
  console.error(`the prompt contains % (cmd.exe would expand %VAR% in it) - move the handoff to a path without %: ${prompt}`);
  process.exit(2);
}
```

In the bg branch, replace `if (dry) process.exit(0);` with:

```js
  if (dry) process.exit(0);
  if (process.env.HL_NO_SPAWN === "1") { append(entry); console.log("HL_NO_SPAWN=1: recorded, not started"); process.exit(0); }
```

In the window branch, directly after the `const claudeArgs = [...]` line and before the `.ps1` housekeeping, add:

```js
if (!dry && process.env.HL_NO_SPAWN === "1") { // tests: record the launch, start nothing
  console.log(JSON.stringify({ mode: "window", worktree: wtPlan, registry_line: entry, prompt, spawned: false }, null, 2));
  append(entry);
  process.exit(0);
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: all PASS (`# fail 0`); the `%` test is skipped off Windows.

- [ ] **Step 6: Commit**

```bash
git add claude/skills/handoff-launch/tests claude/skills/handoff-launch/launch.mjs
git commit -m "handoff-launch: test sandbox, HL_NO_SPAWN, refuse % in bg prompts on Windows, legacy status golden"
```

---

### Task 2: `merge-lib.mjs`, the pure helpers

**Files:**
- Create: `claude/skills/handoff-launch/merge-lib.mjs`
- Create: `claude/skills/handoff-launch/tests/merge-lib.test.mjs`
- Modify: `claude/skills/handoff-launch/launch.mjs:44-46` (`slug`, `fwd`, `key` move to the lib and are imported)

**Interfaces:**
- Produces (all exported from `merge-lib.mjs`):
  - `slug(s) → string`, `fwd(p) → string`, `key(p) → string` (moved verbatim from launch.mjs).
  - `isMergeSession(group, name) → bool`: `<group>-merge` or `<group>-merge-*`.
  - `validateConfig(o) → {ok:true, config:{integration, target, test|null, test_timeout_min, mode}} | {ok:false, errors:string[]}`.
  - `parseLock(text|null) → null | {holder:"drain", token, pid, lane, at} | {holder:"session", token, session, lane, head, at} | {holder:"legacy"}`.
  - `lockState(lock, {pidAlive(pid)→bool, now:ms, maxAgeMs}) → "drain-live"|"drain-dead"|"drain-old"|"session"|"legacy"`.
  - `lockHint(state) → string` (leading space or ""), `describeLock(lock) → string`.
  - `classify(lanes) → lanes with .state`, input lane `{name, branch, entry, marker: object|null|{unreadable:true}, merged: bool, mergedSha: string|null, mergeBlocked: string|null}`; states `open|unreadable|blocked|invalid|merged|merge-blocked|queued`.
  - `mergeQueue(classified, prefer?) → queued lanes`, oldest `marker.at` first, then name; `prefer` moves to the front.
  - `finalReady(classified) → bool`.
  - `overlapPairs(finished:[{name, files}], running:[{name, files}]) → [{finished, running, files}]`.
  - `mergeTag(lane) → string`, `rollingSummary(classified, lock, {state, sessionClosed}) → string`,
    `legacyText(group) → string`, `finalReadyText(group, cfg, lanes) → string`, `conflictHandoff(p) → markdown`.

- [ ] **Step 1: Write the failing unit tests**

`claude/skills/handoff-launch/tests/merge-lib.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../merge-lib.mjs";

const lane = (name, marker, extra = {}) => ({ name, branch: `lane-${name}`, entry: {}, marker, merged: false, mergedSha: null, mergeBlocked: null, ...extra });
const done = (head, at = "2026-01-01T00:00:00Z", extra = {}) => ({ head, status: "done", at, ...extra });

test("isMergeSession", () => {
  assert.equal(L.isMergeSession("g1", "g1-merge"), true);
  assert.equal(L.isMergeSession("g1", "g1-merge-A"), true);
  assert.equal(L.isMergeSession("g1", "A"), false);
  assert.equal(L.isMergeSession("g1", "g1-mergeX"), false);
});

test("validateConfig: defaults, required fields, integration != target", () => {
  assert.deepEqual(L.validateConfig({ integration: "int", target: "main" }), { ok: true, config: { integration: "int", target: "main", test: null, test_timeout_min: 30, mode: "window" } });
  assert.equal(L.validateConfig({ integration: "int", target: "main", test: "npm test", test_timeout_min: 0.05, mode: "bg" }).config.test, "npm test");
  assert.equal(L.validateConfig({ target: "main" }).ok, false);
  assert.match(L.validateConfig({ integration: "main", target: "main" }).errors[0], /must differ/);
  assert.equal(L.validateConfig({ integration: "i", target: "t", mode: "tab" }).ok, false);
  assert.equal(L.validateConfig({ integration: "i", target: "t", test_timeout_min: 0 }).ok, false);
  assert.equal(L.validateConfig({ integration: "i", target: "t", test: "" }).ok, false);
  assert.equal(L.validateConfig([]).ok, false);
});

test("parseLock: missing, legacy (empty or foreign), drain, session", () => {
  assert.equal(L.parseLock(null), null);
  assert.deepEqual(L.parseLock(""), { holder: "legacy" });
  assert.deepEqual(L.parseLock("{\"x\":1}"), { holder: "legacy" });
  assert.equal(L.parseLock(JSON.stringify({ holder: "drain", pid: 5, token: "t" })).pid, 5);
  assert.equal(L.parseLock(JSON.stringify({ holder: "session", session: "g-merge-A", token: "t" })).session, "g-merge-A");
});

test("lockState", () => {
  const now = Date.parse("2026-01-01T01:00:00Z"), at = "2026-01-01T00:50:00Z";
  const alive = () => true, dead = () => false;
  assert.equal(L.lockState({ holder: "drain", pid: 1, at }, { pidAlive: dead, now, maxAgeMs: 3600e3 }), "drain-dead");
  assert.equal(L.lockState({ holder: "drain", pid: 1, at }, { pidAlive: alive, now, maxAgeMs: 3600e3 }), "drain-live");
  assert.equal(L.lockState({ holder: "drain", pid: 1, at }, { pidAlive: alive, now, maxAgeMs: 60e3 }), "drain-old");
  assert.equal(L.lockState({ holder: "session" }, { pidAlive: dead, now, maxAgeMs: 1 }), "session");
  assert.equal(L.lockState({ holder: "legacy" }, { pidAlive: dead, now, maxAgeMs: 1 }), "legacy");
  assert.match(L.lockHint("drain-dead"), /STALE/);
  assert.equal(L.lockHint("drain-live"), "");
});

test("classify covers every state", () => {
  const s = L.classify([
    lane("open", null), lane("bad", { unreadable: true }), lane("blk", { status: "blocked", head: "a" }),
    lane("nohead", { status: "done" }), lane("weird", done("a", undefined, { status: "failed" })),
    lane("m", done("a"), { merged: true }), lane("mb", done("a"), { mergeBlocked: "why" }), lane("q", done("a")),
    lane("q2", { head: "b" }),
  ]);
  assert.deepEqual(s.map((l) => l.state), ["open", "unreadable", "blocked", "invalid", "invalid", "merged", "merge-blocked", "queued", "queued"]);
});

test("mergeQueue orders by marker time then name; prefer goes first", () => {
  const c = L.classify([lane("b", done("1", "2026-01-01T00:00:02Z")), lane("a", done("2", "2026-01-01T00:00:02Z")), lane("z", done("3", "2026-01-01T00:00:01Z")), lane("o", null)]);
  assert.deepEqual(L.mergeQueue(c).map((l) => l.name), ["z", "a", "b"]);
  assert.deepEqual(L.mergeQueue(c, "b").map((l) => l.name), ["b", "z", "a"]);
  assert.deepEqual(L.mergeQueue(c, "o").map((l) => l.name), ["z", "a", "b"]);
});

test("finalReady: every lane merged, blocked or merge-blocked", () => {
  assert.equal(L.finalReady([]), false);
  assert.equal(L.finalReady(L.classify([lane("a", done("1"), { merged: true }), lane("b", { status: "blocked", head: "2" }), lane("c", done("3"), { mergeBlocked: "x" })])), true);
  assert.equal(L.finalReady(L.classify([lane("a", done("1"), { merged: true }), lane("b", null)])), false);
  assert.equal(L.finalReady(L.classify([lane("a", done("1"))])), false);
});

test("overlapPairs: shared files per (finished, running) pair, sorted, deduplicated", () => {
  const pairs = L.overlapPairs([{ name: "A", files: ["x", "y", "z"] }], [{ name: "B", files: ["z", "x", "x"] }, { name: "C", files: ["q"] }, { name: "A", files: ["x"] }]);
  assert.deepEqual(pairs, [{ finished: "A", running: "B", files: ["x", "z"] }]);
  assert.deepEqual(L.overlapPairs([{ name: "A", files: [] }], [{ name: "B", files: ["x"] }]), []);
});

test("mergeTag and rollingSummary", () => {
  const c = L.classify([lane("a", done("1"), { merged: true, mergedSha: "abcdef0123" }), lane("b", done("2")), lane("c", null), lane("d", done("3"), { mergeBlocked: "conflict nobody can solve" })]);
  assert.deepEqual(c.map(L.mergeTag), ["MERGED abcdef0", "QUEUED", "", "MERGE-BLOCKED (conflict nobody can solve)"]);
  const lock = { holder: "session", session: "g-merge-b", lane: "b" };
  assert.equal(L.rollingSummary(c, lock, { state: "session" }),
    "members=4 done=3 all_done=false merge_launched=true merge_lock=true merged=1 queue=[b] merge_holder=g-merge-b(b) final_ready=false");
  assert.match(L.rollingSummary(c, lock, { state: "session", sessionClosed: true }), /STALE: g-merge-b closed without merging b/);
  assert.match(L.rollingSummary(c, null, {}), /merge_launched=false merge_lock=false .* merge_holder=none/);
});

test("legacyText and finalReadyText", () => {
  assert.match(L.legacyText("g0"), /^legacy group g0 \(no config\.json\).*g0-merge/);
  const c = L.classify([lane("a", done("1", undefined, { next_after_merge: ["a2"] }), { merged: true }), lane("b", { status: "blocked", head: "2" })]);
  const t = L.finalReadyText("g1", { integration: "int", target: "main" }, c);
  assert.match(t, /^FINAL_READY g1: .*not merged: b.* int .* main/);
  assert.match(t, /next_after_merge=\{"a":\["a2"\]\}/);
});

test("conflictHandoff lists conflicts, test output and the exact commands", () => {
  const md = L.conflictHandoff({ group: "g1", lane: "C", branch: "lane-C", head: "abc", integration: "int", target: "main",
    wt: "/r/.claude/worktrees/_merge-g1", before: "def", reason: "conflict", conflicts: ["shared.txt", "b.txt"],
    output: "CONFLICT (content)\n```\nnested fence", code: null, test: "npm test", overlap: { D: ["shared.txt"] },
    launchMjs: "/h/launch.mjs", root: "/r", at: "2026-01-01T00:00:00Z" });
  assert.match(md, /^# Handoff: merge lane C into int \(group g1\)/);
  assert.match(md, /- Conflicting files:\n {2}- shared\.txt\n {2}- b\.txt/);
  assert.match(md, /running lane D: shared\.txt/);
  assert.match(md, /`node \/h\/launch\.mjs merge --group g1 --repo \/r`/);
  assert.match(md, /--skip C --why/);
  assert.match(md, /````\nCONFLICT \(content\)\n```\nnested fence\n````/);
  assert.match(md, /\n## THE PROMPT\n/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/merge-lib.test.mjs`
Expected: FAIL, `Cannot find module '.../merge-lib.mjs'`.

- [ ] **Step 3: Implement `merge-lib.mjs`**

```js
// Pure helpers for rolling merges in handoff-launch fan-out groups. No fs, no git, no clock: callers pass everything
// in, so tests/merge-lib.test.mjs covers every decision directly.
import path from "node:path";

export const slug = (s) => String(s).replace(/[^\w.-]+/g, "-").slice(0, 60);
export const fwd = (p) => p.split(path.sep).join("/");
export const key = (p) => fwd(path.resolve(p)).toLowerCase();

// <group>-merge is the legacy all-lanes merge session; <group>-merge-<lane> resolves one lane. Neither is a lane.
export const isMergeSession = (group, name) => name === `${group}-merge` || String(name).startsWith(`${group}-merge-`);

// config.json, written once by the fan-out controller (launch.mjs group).
export function validateConfig(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, errors: ["config.json must be a JSON object"] };
  const errors = [];
  for (const k of ["integration", "target"]) if (typeof o[k] !== "string" || !o[k].trim()) errors.push(`${k} must be a non-empty branch name`);
  if (!errors.length && o.integration === o.target) errors.push("integration and target must differ (the target changes only in the human-approved final merge)");
  if (o.test != null && (typeof o.test !== "string" || !o.test.trim())) errors.push("test must be a non-empty command when given");
  const timeout = o.test_timeout_min ?? 30, mode = o.mode ?? "window";
  if (!(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) errors.push("test_timeout_min must be a positive number");
  if (mode !== "window" && mode !== "bg") errors.push("mode must be window or bg");
  return errors.length ? { ok: false, errors }
    : { ok: true, config: { integration: o.integration, target: o.target, test: o.test || null, test_timeout_min: timeout, mode } };
}

// merge.lock: {holder:"drain", token, pid, lane, at} while this code merges, {holder:"session", token, session, lane,
// head, at} while a merge session resolves a lane. Anything else (the legacy launch guard is an empty file) is legacy.
export function parseLock(text) {
  if (text == null) return null;
  try { const o = JSON.parse(text); if (o && (o.holder === "drain" || o.holder === "session")) return o; } catch {}
  return { holder: "legacy" };
}
// drain-dead: the merging process is gone, safe to reclaim. drain-old: alive but older than maxAgeMs (PID reuse or a
// hung test): reported, never reclaimed automatically.
export function lockState(lock, { pidAlive, now, maxAgeMs }) {
  if (lock.holder !== "drain") return lock.holder;
  if (!pidAlive(lock.pid)) return "drain-dead";
  return now - Date.parse(lock.at) > maxAgeMs ? "drain-old" : "drain-live";
}
export function lockHint(state) {
  return state === "drain-dead" ? " (STALE: the merging process is gone - the next merge reclaims the lock)"
    : state === "drain-old" ? " (older than the test timeout - check that process, then merge --force clears it)"
    : state === "legacy" ? " (a legacy merge.lock in a rolling group - merge --force clears it)" : "";
}
export const describeLock = (lock) => (!lock ? "nobody"
  : lock.holder === "session" ? `merge session ${lock.session} (lane ${lock.lane})`
  : lock.holder === "drain" ? `merge process ${lock.pid} (lane ${lock.lane}, since ${lock.at})`
  : "a legacy merge launch");

// lanes: [{name, branch, entry, marker: object|null|{unreadable:true}, merged, mergedSha, mergeBlocked}]
export function classify(lanes) {
  return lanes.map((l) => {
    const m = l.marker, status = String(m?.status ?? "done");
    const state = !m ? "open"
      : m.unreadable ? "unreadable"
      : status === "blocked" ? "blocked"
      : status !== "done" || !m.head ? "invalid"
      : l.merged ? "merged"
      : l.mergeBlocked ? "merge-blocked"
      : "queued";
    return { ...l, state };
  });
}
export function mergeQueue(classified, prefer) {
  const q = classified.filter((l) => l.state === "queued")
    .sort((a, b) => String(a.marker.at ?? "").localeCompare(String(b.marker.at ?? "")) || a.name.localeCompare(b.name));
  const i = prefer ? q.findIndex((l) => l.name === prefer) : -1;
  if (i > 0) q.unshift(...q.splice(i, 1));
  return q;
}
export const finalReady = (classified) => classified.length > 0
  && classified.every((l) => l.state === "merged" || l.state === "blocked" || l.state === "merge-blocked");

export function overlapPairs(finished, running) {
  const out = [];
  for (const f of finished) {
    const mine = new Set(f.files);
    for (const r of running) {
      if (r.name === f.name) continue;
      const files = [...new Set(r.files)].filter((x) => mine.has(x)).sort();
      if (files.length) out.push({ finished: f.name, running: r.name, files });
    }
  }
  return out;
}

export function mergeTag(l) {
  return l.state === "merged" ? `MERGED${l.mergedSha ? ` ${l.mergedSha.slice(0, 7)}` : ""}`
    : l.state === "queued" ? "QUEUED"
    : l.state === "merge-blocked" ? `MERGE-BLOCKED (${l.mergeBlocked})`
    : l.state === "invalid" ? "INVALID marker (needs a head and status done or blocked - not merged)" : "";
}
// The legacy summary keys first (lanes and controllers parse them), then the rolling ones. merge_launched means a
// merge session holds the lock right now.
export function rollingSummary(classified, lock, { state = null, sessionClosed = false } = {}) {
  const done = classified.filter((l) => l.marker && !l.marker.unreadable).length;
  const merged = classified.filter((l) => l.state === "merged").length;
  const holder = !lock ? "none" : lock.holder === "session" ? `${lock.session}(${lock.lane})`
    : lock.holder === "drain" ? `pid${lock.pid}(${lock.lane})` : "legacy";
  const hint = sessionClosed ? ` (STALE: ${lock.session} closed without merging ${lock.lane} - merge --force retries it, merge --skip ${lock.lane} --why <reason> gives up on it)` : lockHint(state);
  return `members=${classified.length} done=${done} all_done=${classified.length > 0 && done === classified.length}`
    + ` merge_launched=${lock?.holder === "session"} merge_lock=${!!lock} merged=${merged}`
    + ` queue=[${mergeQueue(classified).map((l) => l.name).join(",")}] merge_holder=${holder} final_ready=${finalReady(classified)}${hint}`;
}

export const legacyText = (group) => `legacy group ${group} (no config.json): lanes are merged once all are done - run `
  + `status --group ${group}, and on all_done=true merge_launched=false launch the group's merge handoff as ${group}-merge `
  + "(handoff-launch SKILL.md section 4, legacy groups)";
export function finalReadyText(group, cfg, lanes) {
  const next = Object.fromEntries(lanes.filter((l) => l.marker?.next_after_merge?.length).map((l) => [l.name, l.marker.next_after_merge]));
  const notMerged = lanes.filter((l) => l.state !== "merged").map((l) => l.name);
  return `FINAL_READY ${group}: every lane is merged or blocked${notMerged.length ? ` (not merged: ${notMerged.join(", ")})` : ""}`
    + ` - ${cfg.integration} is ready for the final merge into ${cfg.target}, which needs the user's approval`
    + ` (never push without asking). next_after_merge=${JSON.stringify(next)}`;
}

const fence = (s) => { const t = String(s); let f = "`".repeat(3); while (t.includes(f)) f += "`"; return `${f}\n${t}\n${f}`; };
// The handoff a merge session <group>-merge-<lane> starts from. p: {group, lane, branch, head, integration, target, wt,
// before, reason: "conflict"|"test-failed", conflicts, output, code, test, overlap, launchMjs, root, at}
export function conflictHandoff(p) {
  const merge = `node ${p.launchMjs} merge --group ${p.group} --repo ${p.root}`;
  const why = p.reason === "conflict" ? `git merge stopped on conflicts in ${p.conflicts.length} file(s)`
    : `the test command failed (exit ${p.code}) after a clean merge`;
  const overlap = Object.entries(p.overlap || {}).map(([r, f]) => `  - running lane ${r}: ${f.join(", ")}`);
  return [
    `# Handoff: merge lane ${p.lane} into ${p.integration} (group ${p.group})`, "",
    `Generated by launch.mjs merge at ${p.at}. The group's merge.lock is held for this session: nothing else merges`,
    "until step 5 releases it.", "",
    "## State",
    `- Main repo: ${p.root}`,
    `- Merge worktree (this session's cwd): ${p.wt}, branch \`${p.integration}\`, HEAD ${p.before}`,
    `- Lane \`${p.lane}\`: branch \`${p.branch}\`, done-marker head ${p.head}`,
    `- Why a session: ${why}.`,
    ...(p.conflicts?.length ? ["- Conflicting files:", ...p.conflicts.map((f) => `  - ${f}`)] : []),
    `- Test command: ${p.test ? `\`${p.test}\`` : "(none configured)"}`,
    ...(overlap.length ? ["- Files this lane shares with lanes still running (they merge later):", ...overlap] : []),
    ...(p.output ? ["", "## Output", fence(p.output)] : []),
    "", "## Steps",
    `1. In the merge worktree: \`git merge --no-ff --no-commit ${p.head}\`.`,
    "2. Resolve every conflict so both sides' intent survives (read the lane's commits and the integration branch's). If the test failed, fix the code.",
    `3. Run the test command until it passes${p.test ? `: \`${p.test}\`` : ""}.`,
    `4. Commit the merge (\`git commit -m "Merge lane ${p.lane} into ${p.integration}"\`). Never push, never touch \`${p.target}\`, never edit a lane's worktree.`,
    `5. Run \`${merge}\` and report its output. It sees ${p.lane} merged, releases the lock and merges the next finished lanes.`,
    `If it cannot be resolved: \`git merge --abort\`, then \`${merge} --skip ${p.lane} --why "<reason>"\`, and tell the user.`,
    "", "## THE PROMPT",
    `You are the merge session for lane ${p.lane} of fan-out group ${p.group}. Your cwd is the merge worktree ${p.wt}.`
      + " Do the Steps above in order, then stop and report. Size any reviewer dispatch with sizing-dispatches.",
    "",
  ].join("\n");
}
```

In `launch.mjs`, delete the three lines `const slug = ...`, `const fwd = ...`, `const key = ...` and add after the
`node:child_process` import:

```js
import { slug, fwd, key } from "./merge-lib.mjs";
```

- [ ] **Step 4: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: all PASS, including the Task 1 golden.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/merge-lib.mjs claude/skills/handoff-launch/tests/merge-lib.test.mjs claude/skills/handoff-launch/launch.mjs
git commit -m "handoff-launch: pure helpers for rolling merges (merge-lib.mjs)"
```

---

### Task 3: `merge.mjs`, the `group` and `merge` subcommands, merge sessions

**Files:**
- Create: `claude/skills/handoff-launch/merge.mjs`
- Create: `claude/skills/handoff-launch/run-test.mjs`
- Create: `claude/skills/handoff-launch/tests/merge.test.mjs`
- Modify: `claude/skills/handoff-launch/launch.mjs`: imports; `readRegistry` (lines 62-72); the `git` helper
  (51-54); the worktree list and exclude code (344-346, 365-368); the prompt (397-399); new `group`/`merge`
  subcommands before `if (sub) { ... unknown subcommand`; the done-marker guard condition (333).

**Interfaces:**
- Consumes: everything from Task 2.
- Produces (exported from `merge.mjs`):
  - `git(dir, ...args) → {ok, out, err}`, `worktrees(root) → [{worktree, branch, prunable, ...}]`,
    `excludeWorktrees(root)`, `writeAtomic(file, text)`.
  - `groupDir(root, group)`, `mergeWorktree(root, group)`, `readConfig(gd) → null | validateConfig result`,
    `writeConfig(root, group, raw, force) → {ok, file, config, warn} | {ok:false, errors}`.
  - `readLock(gd)`, `lockStateOf(lock, cfg)`, `acquireLock(gd, {pid, lane}, cfg) → {ok, lock, reclaimed} | {ok:false, lock, state}`,
    `releaseLock(gd, token) → bool`, `ownsLock(gd, token) → bool`.
  - `groupLanes({entries, merges, group, repoKey, cfg, root}) → lanes` (unclassified), `lanesNow(ctx, cfg) → {reg, lanes}` (classified).
  - `refreshOverlap(root, cfg, lanes, {write}) → pairs`, `sessionClosed(reg, name) → bool`.
  - `drain(ctx, {prefer}) → {code, lines}` where `ctx = {readRegistry, append, launchMjs, root, repoKey, group}`.
- Registry lines added: `{merged: <lane>, group, repo, branch, head, sha, by: "drain"|<session>, at}` and
  `{merge_blocked: <lane>, group, repo, head, why, at}`. `readRegistry()` returns them as `merges`.
- `merge` output lines (tests match these): `merged <lane> -> <integration> <sha7>`,
  `merged <lane> (already contained in <integration>)`, `merged <lane> -> <integration> by <session>; merge.lock released`,
  `queued: ...`, `CONFLICT <lane>: <n> file(s): <files> - merge session <name> launched (handoff <path>) ...`,
  `TEST FAILED <lane> (exit <code>) after a clean merge - merge session <name> launched ...`,
  `MERGE-BLOCKED <lane>: <why>`, `ERROR <why>`, `FINAL_READY ...`, `nothing to merge`, legacy text.
  Exit 0 except `ERROR` (1) and usage (2).

- [ ] **Step 1: Write the failing integration tests**

`claude/skills/handoff-launch/tests/merge.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, launchLane, commitIn, writeDone, LAUNCH } from "./helpers.mjs";

const setup = (sb, group = "g1", extra = []) => {
  const r = sb.run("group", "--group", group, "--repo", sb.repo, "--integration", `int-${group}`, "--target", "main", ...extra);
  assert.equal(r.code, 0, r.err + r.out);
};
const show = (sb, ref, file) => spawnSync("git", ["-C", sb.repo, "show", `${ref}:${file}`], { encoding: "utf8" });
const gdir = (sb, g) => path.join(sb.repo, ".superpowers", "sessions", g);
const lockOf = (sb, g) => path.join(gdir(sb, g), "merge.lock");
const scratch = (sb, g) => path.join(sb.repo, ".claude", "worktrees", `_merge-${g}`);
const merge = (sb, ...a) => sb.run("merge", "--group", "g1", "--repo", sb.repo, ...a);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("group writes config.json and refuses bad input", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node check.cjs"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(gdir(sb, "g1"), "config.json"), "utf8"));
    assert.deepEqual(cfg, { integration: "int-g1", target: "main", test: "node check.cjs", test_timeout_min: 30, mode: "window" });
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "x", "--target", "main").code, 2); // exists
    assert.equal(sb.run("group", "--group", "g2", "--repo", sb.repo, "--integration", "main", "--target", "main").code, 2);
    assert.equal(sb.run("group", "--group", "g3", "--repo", sb.repo, "--integration", "i", "--target", "nope").code, 2);
    launchLane(sb, "g4", "A"); // a legacy group that already launched lanes stays legacy
    const r = sb.run("group", "--group", "g4", "--repo", sb.repo, "--integration", "int-g4", "--target", "main");
    assert.equal(r.code, 3); assert.match(r.err, /stays a legacy/);
  } finally { sb.cleanup(); }
});

test("a finished lane merges while another lane is still running", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    const ha = commitIn(sb, a, { "a.txt": "from A\n" }, "A work");
    const hb = commitIn(sb, b, { "b.txt": "from B\n" }, "B work");
    const mainBefore = sb.git(sb.repo, "rev-parse", "main");
    writeDone(sb, "g1", "A", ha);
    const r = sb.run("merge", "--group", "g1", "--repo", a, "--lane", "A"); // run from the lane's own worktree
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /merged A -> int-g1 [0-9a-f]{7}/);
    assert.equal(show(sb, "int-g1", "a.txt").stdout, "from A\n");
    assert.notEqual(show(sb, "int-g1", "b.txt").status, 0);
    assert.equal(sb.git(b, "rev-parse", "HEAD"), hb);
    assert.equal(sb.git(b, "status", "--porcelain"), "");
    assert.equal(sb.git(sb.repo, "rev-parse", "main"), mainBefore);
    assert.equal(sb.git(sb.repo, "status", "--porcelain"), "");
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.ok(sb.registry().some((o) => o.merged === "A" && o.group === "g1" && o.head === ha && o.by === "drain"));
    assert.match(sb.git(sb.repo, "log", "-1", "--format=%s", "int-g1"), /^Merge lane A \(lane-A @ [0-9a-f]{7}\) into int-g1$/);
    assert.equal(sb.git(sb.repo, "rev-list", "--parents", "-n", "1", "int-g1").split(" ").length, 3); // a real merge commit
    assert.match(merge(sb).out, /nothing to merge/);
  } finally { sb.cleanup(); }
});

test("a failing test command aborts the merge and launches a merge session with the output", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node check.cjs"]);
    const d = launchLane(sb, "g1", "D");
    writeDone(sb, "g1", "D", commitIn(sb, d, { FAIL: "x\n" }, "D adds FAIL"));
    const r = merge(sb, "--lane", "D");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /TEST FAILED D \(exit 1\) after a clean merge - merge session g1-merge-D launched/);
    assert.notEqual(show(sb, "int-g1", "FAIL").status, 0);
    assert.equal(sb.git(scratch(sb, "g1"), "status", "--porcelain", "--untracked-files=no"), "");
    const lock = JSON.parse(fs.readFileSync(lockOf(sb, "g1"), "utf8"));
    assert.equal(lock.holder, "session"); assert.equal(lock.session, "g1-merge-D"); assert.equal(lock.lane, "D");
    const s = sb.registry().filter((o) => o.name === "g1-merge-D");
    assert.equal(s.length, 1);
    assert.ok(same(s[0].worktree, scratch(sb, "g1")));
    assert.equal(s[0].branch, "int-g1");
    assert.match(fs.readFileSync(s[0].handoff, "utf8"), /the test command failed \(exit 1\)[\s\S]*`node check\.cjs`/);
  } finally { sb.cleanup(); }
});

test("a conflicting lane launches a merge session; after it resolves, the queue drains", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C"), e = launchLane(sb, "g1", "E");
    writeDone(sb, "g1", "B", commitIn(sb, b, { "shared.txt": "line1\nB\nline3\n" }, "B edits line2"));
    assert.match(merge(sb, "--lane", "B").out, /merged B/);
    const intBefore = sb.git(sb.repo, "rev-parse", "int-g1");
    const hc = commitIn(sb, c, { "shared.txt": "line1\nC\nline3\n" }, "C edits line2");
    writeDone(sb, "g1", "C", hc);
    const r = merge(sb, "--lane", "C");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /CONFLICT C: 1 file\(s\): shared\.txt - merge session g1-merge-C launched/);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
    const wt = scratch(sb, "g1");
    assert.equal(sb.git(wt, "status", "--porcelain", "--untracked-files=no"), "");
    const s = sb.registry().find((o) => o.name === "g1-merge-C");
    assert.match(fs.readFileSync(s.handoff, "utf8"), /- Conflicting files:\n {2}- shared\.txt/);
    // E finishes while the merge session works: queued, nothing touched
    writeDone(sb, "g1", "E", commitIn(sb, e, { "e.txt": "E\n" }, "E work"));
    const q = merge(sb, "--lane", "E");
    assert.equal(q.code, 0); assert.match(q.out, /queued: g1-merge-C is resolving C/);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
    // the merge session resolves C in the merge worktree, then runs the handoff's last step
    spawnSync("git", ["-C", wt, "merge", "--no-ff", "--no-commit", hc], { env: sb.env });
    fs.writeFileSync(path.join(wt, "shared.txt"), "line1\nB+C\nline3\n");
    sb.git(wt, "add", "shared.txt"); sb.git(wt, "commit", "-q", "-m", "Merge lane C into int-g1");
    const d = sb.run("merge", "--group", "g1", "--repo", wt);
    assert.equal(d.code, 0, d.err + d.out);
    assert.match(d.out, /merged C -> int-g1 by g1-merge-C; merge\.lock released/);
    assert.match(d.out, /merged E -> int-g1 [0-9a-f]{7}/);
    assert.match(d.out, /FINAL_READY g1/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.equal(show(sb, "int-g1", "e.txt").stdout, "E\n");
  } finally { sb.cleanup(); }
});

test("a live merge holds the lock: a second merge prints queued and changes nothing", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const held = JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "X", at: new Date().toISOString() });
    fs.writeFileSync(lockOf(sb, "g1"), held);
    const r = merge(sb, "--lane", "A");
    assert.equal(r.code, 0); assert.match(r.out, new RegExp(`queued: merge.lock is held by merge process ${process.pid}`));
    assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), held);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1); // not even created
  } finally { sb.cleanup(); }
});

test("a dead merge process's lock is reclaimed and its half merge aborted, never committed", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    assert.match(merge(sb).out, /merged A/);
    const hb = commitIn(sb, b, { "b.txt": "B\n" }, "B work");
    writeDone(sb, "g1", "B", hb);
    spawnSync("git", ["-C", scratch(sb, "g1"), "merge", "--no-ff", "--no-commit", hb], { env: sb.env }); // the crash left this
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "dead", pid: deadPid(), lane: "B", at: new Date().toISOString() }));
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /reclaimed merge\.lock from a dead merge process and aborted its unfinished merge/);
    assert.match(r.out, /merged B -> int-g1/);
    assert.match(sb.git(sb.repo, "log", "-1", "--format=%s", "int-g1"), /^Merge lane B /);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
  } finally { sb.cleanup(); }
});

test("two lanes finishing at the same moment: each is merged exactly once", async () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    writeDone(sb, "g1", "B", commitIn(sb, b, { "b.txt": "B\n" }, "B work"));
    const go = (lane) => new Promise((res) => {
      const p = spawn(process.execPath, [LAUNCH, "merge", "--group", "g1", "--repo", sb.repo, "--lane", lane], { env: sb.env });
      let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => res({ code, out }));
    });
    const [x, y] = await Promise.all([go("A"), go("B")]);
    assert.equal(x.code, 0, x.out); assert.equal(y.code, 0, y.out);
    const subjects = sb.git(sb.repo, "log", "--merges", "--format=%s", "int-g1").split("\n");
    assert.equal(subjects.filter((s) => s.startsWith("Merge lane A ")).length, 1);
    assert.equal(subjects.filter((s) => s.startsWith("Merge lane B ")).length, 1);
    assert.equal(sb.registry().filter((o) => o.merged).length, 2);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
  } finally { sb.cleanup(); }
});

test("a lane that finishes while another merge holds the lock is merged by the holder", () => {
  const sb2 = sandbox();
  try {
    const hook = path.join(sb2.tmp, "hook.cjs"), flagFile = path.join(sb2.tmp, "hook.out");
    setup(sb2, "g1", ["--test", `node ${hook.split(path.sep).join("/")}`]);
    const a = launchLane(sb2, "g1", "A"), f = launchLane(sb2, "g1", "F");
    const hf = commitIn(sb2, f, { "f.txt": "F\n" }, "F work");
    const markerF = path.join(gdir(sb2, "g1"), "F.done");
    // The test command plays lane F: during A's merge it writes F's done marker and runs F's merge call.
    fs.writeFileSync(hook, [
      "const fs = require('fs'), { spawnSync } = require('child_process');",
      `if (!fs.existsSync(${JSON.stringify(flagFile)})) {`,
      `  fs.writeFileSync(${JSON.stringify(markerF)}, JSON.stringify({ name: 'F', branch: 'lane-F', head: ${JSON.stringify(hf)}, status: 'done', tests: 'ok', at: new Date().toISOString() }));`,
      `  const r = spawnSync(process.execPath, [${JSON.stringify(LAUNCH)}, 'merge', '--group', 'g1', '--repo', ${JSON.stringify(sb2.repo)}, '--lane', 'F'], { encoding: 'utf8' });`,
      `  fs.writeFileSync(${JSON.stringify(flagFile)}, r.stdout + r.stderr);`,
      "}",
    ].join("\n"));
    writeDone(sb2, "g1", "A", commitIn(sb2, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb2, "--lane", "A");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(fs.readFileSync(flagFile, "utf8"), /queued: merge\.lock is held by merge process/);
    assert.match(r.out, /merged A -> int-g1/);
    assert.match(r.out, /merged F -> int-g1/);
  } finally { sb2.cleanup(); }
});

test("a hanging test command times out, is killed, and its merge is aborted", () => {
  const sb = sandbox();
  try {
    setup(sb, "g1", ["--test", "node hang.cjs", "--test-timeout-min", "0.05"]);
    const h = launchLane(sb, "g1", "H");
    writeDone(sb, "g1", "H", commitIn(sb, h, { "h.txt": "H\n" }, "H work"));
    const t0 = Date.now();
    const r = merge(sb);
    assert.ok(Date.now() - t0 < 60000, "took too long");
    assert.match(r.out, /TEST FAILED H \(exit 124\)/);
    const s = sb.registry().find((o) => o.name === "g1-merge-H");
    assert.match(fs.readFileSync(s.handoff, "utf8"), /timed out after 3 s/);
    assert.notEqual(show(sb, "int-g1", "h.txt").status, 0);
  } finally { sb.cleanup(); }
});

test("integration branch checked out elsewhere: ERROR, lock released, nothing changed", () => {
  const sb = sandbox();
  try {
    setup(sb);
    sb.git(sb.repo, "branch", "int-g1", "main");
    sb.git(sb.repo, "worktree", "add", path.join(sb.tmp, "elsewhere"), "int-g1");
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR integration branch int-g1 is checked out at .*elsewhere/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), sb.git(sb.repo, "rev-parse", "main"));
  } finally { sb.cleanup(); }
});

test("a dirty merge worktree stops the drain with ERROR and releases the lock", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    merge(sb);
    const intBefore = sb.git(sb.repo, "rev-parse", "int-g1");
    fs.writeFileSync(path.join(scratch(sb, "g1"), "shared.txt"), "hand edit\n");
    writeDone(sb, "g1", "B", commitIn(sb, b, { "b.txt": "B\n" }, "B work"));
    const r = merge(sb);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR merge worktree .* is not clean/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.equal(sb.git(sb.repo, "rev-parse", "int-g1"), intBefore);
  } finally { sb.cleanup(); }
});

test("a marker head that is not a commit blocks only that lane", () => {
  const sb = sandbox();
  try {
    setup(sb);
    launchLane(sb, "g1", "X");
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "X", "0123456789abcdef0123456789abcdef01234567", { at: "2026-01-01T00:00:00Z" });
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /MERGE-BLOCKED X: .*not a commit/);
    assert.match(r.out, /merged A -> int-g1/);
    assert.match(r.out, /FINAL_READY g1: .*not merged: X/);
  } finally { sb.cleanup(); }
});

test("legacy group: merge prints the legacy flow and touches nothing", () => {
  const sb = sandbox();
  try {
    const a = launchLane(sb, "g0", "A");
    writeDone(sb, "g0", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = sb.run("merge", "--group", "g0", "--repo", sb.repo, "--lane", "A");
    assert.equal(r.code, 0);
    assert.match(r.out, /^legacy group g0 \(no config\.json\)/);
    assert.equal(fs.existsSync(lockOf(sb, "g0")), false);
  } finally { sb.cleanup(); }
});

test("a merge session's launch prompt carries no lane done-marker instruction", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "g1-merge-Z", "--group", "g1", "--model", "opus", "--effort", "high");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(JSON.parse(r.out).prompt, /done marker/);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/merge.test.mjs`
Expected: FAIL: `unknown subcommand group` (exit 2) in `setup`, and the legacy test fails with `unknown subcommand merge`.

- [ ] **Step 3: Implement `run-test.mjs`**

```js
// Runs a fan-out group's test command with a hard timeout that kills the whole process tree. spawnSync's own timeout
// kills only the shell, and on Windows a surviving grandchild keeps the output pipe open, so the caller would hang.
// Usage: node run-test.mjs <cwd> <timeout ms> <log file> <command>. Exit code: the command's, or 124 on timeout.
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const [cwd, ms, log, cmd] = process.argv.slice(2);
const out = fs.openSync(log, "w");
const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", out, out], detached: process.platform !== "win32" });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  fs.writeSync(out, `\n[run-test] timed out after ${Math.round(Number(ms) / 1000)} s - process tree killed\n`);
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
  else try { process.kill(-child.pid, "SIGKILL"); } catch {}
}, Number(ms));
child.on("error", (e) => { fs.writeSync(out, `\n[run-test] ${e.message}\n`); });
child.on("close", (code) => { clearTimeout(timer); process.exit(timedOut ? 124 : code ?? 1); });
```

- [ ] **Step 4: Implement `merge.mjs`**

```js
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
// commit and git's own index.lock then stop the second merge.)
function reclaimLock(gd, held) {
  const f = lockFile(gd), aside = `${f}.reclaimed-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try { fs.renameSync(f, aside); } catch { return false; }
  let moved = null; try { moved = L.parseLock(fs.readFileSync(aside, "utf8")); } catch {}
  if (moved?.token === held.token) return true;
  try { fs.linkSync(aside, f); fs.rmSync(aside, { force: true }); } catch {}
  return false;
}
export function acquireLock(gd, body, cfg) {
  fs.mkdirSync(gd, { recursive: true });
  const lock = { holder: "drain", ...body, token: crypto.randomUUID(), at: iso() };
  let reclaimed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (linkCreate(lockFile(gd), JSON.stringify(lock))) return { ok: true, lock, reclaimed };
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
    const t = spawnSync(process.execPath, [RUN_TEST, wt, String(ms), log, cfg.test], { encoding: "utf8", timeout: ms + 2 * MIN });
    if (t.status !== 0) {
      let output = ""; try { output = tailLines(fs.readFileSync(log, "utf8"), 80); } catch {}
      const back = abortMerge(wt, before);
      if (!back.ok) return { result: "error", why: back.why };
      return { result: "test-failed", code: t.status, output };
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
    output: r.output, code: r.code, test: cfg.test, overlap: lanes.find((l) => l.name === lane.name)?.marker?.overlap,
    launchMjs: L.fwd(ctx.launchMjs), root: L.fwd(ctx.root), at: iso(),
  }));
  if (!ownsLock(gd, token)) return { ok: false, lines: ["ERROR lost merge.lock before launching the merge session - nothing launched"] };
  writeAtomic(lockFile(gd), JSON.stringify({ holder: "session", token, session: name, lane: lane.name, head: lane.marker.head, at: iso() }));
  const p = spawnSync(process.execPath, [ctx.launchMjs, "--repo", ctx.root, "--handoff", file, "--group", ctx.group, "--name", name,
    "--model", "opus", "--effort", "high", "--worktree", cfg.integration, "--mode", cfg.mode, "--no-close"], { encoding: "utf8", timeout: 3 * MIN });
  if (p.status !== 0) {
    releaseLock(gd, token);
    return { ok: false, lines: [`ERROR could not launch merge session ${name}: ${tailLines(`${p.stdout || ""}${p.stderr || ""}`, 10)}`, "merge.lock released - the next merge retries this lane"] };
  }
  const what = r.result === "conflict" ? `CONFLICT ${lane.name}: ${r.conflicts.length} file(s): ${r.conflicts.join(", ")}`
    : `TEST FAILED ${lane.name} (exit ${r.code}) after a clean merge`;
  return { ok: true, lines: [`${what} - merge session ${name} launched (handoff ${L.fwd(file)}); merge.lock stays held until it finishes`] };
}

// A merge session holds the lock: release it once its lane is merged (or skipped, reopened, gone); otherwise wait.
function settleSession(ctx, gd, held, cfg) {
  const { reg, lanes } = lanesNow(ctx, cfg);
  const lane = lanes.find((l) => l.name === held.lane);
  if (lane?.state === "merged") {
    if (!(reg.merges || []).some((m) => m.merged === lane.name && m.group === ctx.group && m.head === String(lane.marker.head)))
      ctx.append({ merged: lane.name, group: ctx.group, repo: ctx.repoKey, branch: lane.branch, head: String(lane.marker.head), sha: git(ctx.root, "rev-parse", `refs/heads/${cfg.integration}`).out, by: held.session, at: iso() });
    releaseLock(gd, held.token);
    return { released: true, lines: [`merged ${lane.name} -> ${cfg.integration} by ${held.session}; merge.lock released`] };
  }
  if (lane?.state !== "queued") {
    releaseLock(gd, held.token);
    return { released: true, lines: [`released merge.lock held by ${held.session}: lane ${held.lane} is ${lane ? lane.state : "gone"}`] };
  }
  const stale = sessionClosed(reg, held.session) ? ` - STALE: that session's window is closed - merge --force retries the lane, merge --skip ${held.lane} --why <reason> gives up on it` : "";
  return { released: false, lines: [`queued: ${held.session} is resolving ${held.lane}${stale}`] };
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
      if (acq.lock?.holder === "session") continue;
      out.push(`queued: merge.lock is held by ${L.describeLock(acq.lock)}, which merges the finished lanes after its own${L.lockHint(acq.state)}`);
      return { code: 0, lines: out };
    }
    const token = acq.lock.token;
    const wt = ensureMergeWorktree(ctx.root, ctx.group, cfg);
    if (!wt.ok) { releaseLock(gd, token); out.push(`ERROR ${wt.why}`); return { code: 1, lines: out }; }
    if (acq.reclaimed && inMerge(wt.dir)) { git(wt.dir, "merge", "--abort"); out.push("reclaimed merge.lock from a dead merge process and aborted its unfinished merge"); }
    for (;;) {
      ({ lanes } = lanesNow(ctx, cfg));
      next = L.mergeQueue(lanes, prefer)[0];
      if (!next) break;
      refreshOverlap(ctx.root, cfg, lanes);
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
```

- [ ] **Step 5: Wire it into `launch.mjs`**

1. Imports (extend the Task 2 import line and add one):

```js
import { slug, fwd, key, isMergeSession } from "./merge-lib.mjs";
import { git, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain } from "./merge.mjs";
```

and delete launch.mjs's own `const git = (dir, ...a) => { ... };` (lines 51-54).

2. `readRegistry` collects merge records:

```js
function readRegistry() {
  const entries = [], closed = new Set(), stops = new Map(), merges = [];
  if (fs.existsSync(REG)) for (const line of fs.readFileSync(REG, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.closed) closed.add(o.id || o.closed);
    else if (o.stop_requested) { if (!stops.has(o.stop_requested)) stops.set(o.stop_requested, []); stops.get(o.stop_requested).push(o); }
    else if (o.merged || o.merge_blocked) merges.push(o);
    else if (o.name && o.launched_at) entries.push(o);
  }
  return { entries, closed, stops, merges };
}
```

3. After `const live = (e) => !reg.closed.has(e.id);` add:

```js
const mergeCtx = (root, group) => ({ readRegistry, append, launchMjs: fileURLToPath(import.meta.url), root, repoKey: key(root), group });
const rootArg = () => mainRoot(path.resolve(opt("repo", process.cwd())));
```

4. New subcommands, inserted directly before `if (sub) { console.error(\`unknown subcommand ${sub}\`); ...`:

```js
if (sub === "group") {
  const group = opt("group") && slug(opt("group")), root = rootArg();
  if (!group || !root || !opt("integration") || !opt("target")) {
    console.error("group needs --group <id> --repo <git repo> --integration <branch> --target <branch> [--test <cmd>] [--test-timeout-min <n>] [--mode window|bg] [--force]");
    process.exit(2);
  }
  // A group that already launched lanes keeps the flow it started with: legacy groups have no config.json.
  if (!readConfig(groupDir(root, group)) && reg.entries.some((e) => e.group === group && e.repo === key(root)) && !flag("force")) {
    console.error(`group ${group} already launched sessions without a config.json - it stays a legacy (all_done) group. Pick a new group id.`);
    process.exit(3);
  }
  const t = opt("test-timeout-min");
  const r = writeConfig(root, group, { integration: opt("integration"), target: opt("target"), test: opt("test"), test_timeout_min: t === undefined ? undefined : Number(t), mode: opt("mode") }, flag("force"));
  if (!r.ok) { for (const e of r.errors) console.error(e); process.exit(2); }
  console.log(`wrote ${fwd(r.file)}: ${JSON.stringify(r.config)}`);
  if (r.warn) console.log(`WARN ${r.warn}`);
  process.exit(0);
}
if (sub === "merge") {
  const group = opt("group") && slug(opt("group")), root = rootArg();
  if (!group || !root) { console.error("merge needs --group <id> [--repo <main repo or one of its worktrees>] [--lane <name>] [--dry-run]"); process.exit(2); }
  const r = drain(mergeCtx(root, group), { prefer: opt("lane") && slug(opt("lane")) });
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
```

5. In the worktree block, replace the inline `const list = git(root, "worktree", "list", "--porcelain")...` (lines
   344-346) with `const list = worktrees(root);`, and the three exclude lines (366-368) with `excludeWorktrees(root);`.

6. The lane prompt suffix and the done-marker guard skip merge sessions. Line 333:
   `if (group && name !== mergeName && doneMarker && fs.existsSync(doneMarker)) {` becomes
   `if (group && !isMergeSession(group, name) && doneMarker && fs.existsSync(doneMarker)) {`, and the prompt:

```js
const laneNote = !group || isMergeSession(group, name) ? ""
  : ` Fan-out group ${group}: write the done marker ${fwd(doneMarker)} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
const prompt = (`Continue from the handoff at ${handoffRef} - read it first, then follow its paste-ready prompt section exactly.` + laneNote)
  .replace(/"/g, "'").replace(/;/g, ",");
```

7. Header comment usage lines (after the `status` line):

```js
//   node launch.mjs group --group <id> --repo <dir> --integration <branch> --target <branch> [--test <cmd>]
//                   [--test-timeout-min <n>] [--mode window|bg] [--force]      (rolling-merge group config)
//   node launch.mjs merge --group <id> [--repo <dir>] [--lane <name>]          (merge finished lanes now)
```

- [ ] **Step 6: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: all PASS. If the concurrency test flakes, run it 5× in a row
(`node --test --test-name-pattern "same moment" claude/skills/handoff-launch/tests/merge.test.mjs`): a flake there is a
lock bug. Do not retry it away.

- [ ] **Step 7: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "handoff-launch: rolling merges - group config, merge.lock, merge worktree, drain, merge sessions"
```

---

### Task 4: Merge-session lifecycle and the launcher's rolling rules

**Files:**
- Modify: `claude/skills/handoff-launch/merge.mjs` (add `skipLane`, `forceUnlock`)
- Modify: `claude/skills/handoff-launch/launch.mjs` (the `merge` subcommand; group guards ~319-338; the prompt)
- Modify: `claude/skills/handoff-launch/tests/merge.test.mjs` and `tests/launcher.test.mjs`

**Interfaces:**
- Consumes: Task 3 exports (`lanesNow`, `readLock`, `releaseLock`, `groupDir`, `mergeWorktree`, `readConfig`, `groupLanes`).
- Produces: `skipLane(ctx, name, why) → {ok, line}`; `forceUnlock(ctx) → string`; `merge --skip <lane> --why <reason>`,
  `merge --force`, `merge --dry-run`; rolling lane prompt naming the exact `merge` command; refusal of `<group>-merge`
  in a rolling group; rolling `--reopen` rule (refused once the lane is merged or holds the lock).

- [ ] **Step 1: Write the failing tests**

Append to `tests/merge.test.mjs` (reuses its helpers):

```js
function conflictPair(sb) {
  setup(sb);
  const b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C");
  writeDone(sb, "g1", "B", commitIn(sb, b, { "shared.txt": "line1\nB\nline3\n" }, "B edits line2"));
  merge(sb, "--lane", "B");
  const hc = commitIn(sb, c, { "shared.txt": "line1\nC\nline3\n" }, "C edits line2");
  writeDone(sb, "g1", "C", hc);
  assert.match(merge(sb, "--lane", "C").out, /CONFLICT C/);
  return { c, hc };
}

test("--skip gives up on a lane, frees its merge session's lock, and the group can finish", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const r = merge(sb, "--skip", "C", "--why", "needs the user");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /skipped C \(needs the user\); released merge\.lock held by g1-merge-C/);
    assert.match(r.out, /FINAL_READY g1: .*not merged: C/);
    assert.equal(fs.existsSync(lockOf(sb, "g1")), false);
    assert.ok(sb.registry().some((o) => o.merge_blocked === "C" && o.why === "needs the user"));
  } finally { sb.cleanup(); }
});

test("--force clears a stale session lock and retries the lane (a second merge session)", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    spawnSync("git", ["-C", scratch(sb, "g1"), "merge", "--no-ff", "--no-commit", "lane-C"], { env: sb.env }); // session died mid-resolution
    const r = merge(sb, "--force");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /cleared merge\.lock \(merge session g1-merge-C \(lane C\)\); aborted the unfinished merge in the merge worktree/);
    assert.match(r.out, /CONFLICT C/);
    assert.equal(sb.registry().filter((o) => o.name === "g1-merge-C").length, 2);
    assert.equal(JSON.parse(fs.readFileSync(lockOf(sb, "g1"), "utf8")).session, "g1-merge-C");
  } finally { sb.cleanup(); }
});

test("merge --dry-run shows the queue and the lock and changes nothing", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = merge(sb, "--dry-run");
    assert.equal(r.code, 0);
    assert.match(r.out, /would merge, in order: \[A\]; merge\.lock: nobody/);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1);
  } finally { sb.cleanup(); }
});

test("a merged lane cannot be reopened; a skipped lane re-done with a new head is merged", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), x = launchLane(sb, "g1", "X");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    merge(sb);
    const again = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--worktree", "lane-A", "--group", "g1", "--reopen");
    assert.equal(again.code, 3); assert.match(again.err, /already merged/);
    const h1 = commitIn(sb, x, { "x.txt": "v1\n" }, "X v1");
    writeDone(sb, "g1", "X", h1);
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "Z", at: new Date().toISOString() }));
    merge(sb, "--skip", "X", "--why", "wrong approach"); // skip while the lock is busy: X is not merged
    fs.rmSync(lockOf(sb, "g1"));
    launchLane(sb, "g1", "X", ["--reopen"]);
    const h2 = commitIn(sb, x, { "x.txt": "v2\n" }, "X v2");
    writeDone(sb, "g1", "X", h2);
    const r = merge(sb);
    assert.match(r.out, /merged X -> int-g1/);
    assert.equal(show(sb, "int-g1", "x.txt").stdout, "v2\n");
  } finally { sb.cleanup(); }
});
```

Append to `tests/launcher.test.mjs`:

```js
test("rolling lanes are told the exact merge command; legacy lanes keep the old prompt", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const roll = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--worktree", "lane-A", "--group", "g1").out).prompt;
    assert.match(roll, /rolling merges/);
    assert.match(roll, /launch\.mjs merge --group g1 --repo .* --lane A and report its output/);
    assert.doesNotMatch(roll, /[";]/);
    const old = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "opus", "--effort", "high", "--worktree", "lane-B", "--group", "g0").out).prompt;
    assert.match(old, / Fan-out group g0: write the done marker .*B\.done only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says\.$/);
  } finally { sb.cleanup(); }
});

test("a rolling group has no <group>-merge session; a legacy group still guards it with merge.lock", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "g1-merge", "--model", "opus", "--effort", "high", "--group", "g1");
    assert.equal(r.code, 3); assert.match(r.err, /rolling-merge group/);
    const first = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "g0-merge", "--model", "opus", "--effort", "high", "--group", "g0");
    assert.equal(first.code, 0, first.err);
    const second = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "g0-merge", "--model", "opus", "--effort", "high", "--group", "g0");
    assert.equal(second.code, 3);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: the new tests FAIL (`--skip`, `--force` and `--dry-run` are ignored; the rolling prompt is the legacy
text; `g1-merge` launches). The legacy `g0-merge` guard test already passes.

- [ ] **Step 3: Implement `skipLane` and `forceUnlock` in `merge.mjs`**

```js
// Give up on a lane's current head (a person or its merge session decided it cannot merge). Frees the lock if that
// lane's merge session holds it. A later done marker with a new head is queued again.
export function skipLane(ctx, name, why) {
  const gd = groupDir(ctx.root, ctx.group), c = readConfig(gd);
  if (!c?.ok) return { ok: false, line: c ? `ERROR config: ${c.errors.join("; ")}` : L.legacyText(ctx.group) };
  const lane = lanesNow(ctx, c.config).lanes.find((l) => l.name === name);
  if (!lane?.marker?.head) return { ok: false, line: `ERROR lane ${name} has no done marker with a head - nothing to skip` };
  ctx.append({ merge_blocked: name, group: ctx.group, repo: ctx.repoKey, head: String(lane.marker.head), why, at: iso() });
  const held = readLock(gd);
  if (held?.holder === "session" && held.lane === name) { releaseLock(gd, held.token); return { ok: true, line: `skipped ${name} (${why}); released merge.lock held by ${held.session}` }; }
  return { ok: true, line: `skipped ${name} (${why})` };
}

// Clear a stale lock (status says STALE, or the holder is known to be gone). Aborts an unfinished merge in the merge
// worktree. The next drain retries the lane, which relaunches its merge session on a conflict.
export function forceUnlock(ctx) {
  const gd = groupDir(ctx.root, ctx.group), held = readLock(gd);
  if (!held) return "no merge.lock to clear";
  const wt = mergeWorktree(ctx.root, ctx.group);
  const aborted = fs.existsSync(wt) && inMerge(wt) && git(wt, "merge", "--abort").ok ? "; aborted the unfinished merge in the merge worktree" : "";
  fs.renameSync(lockFile(gd), `${lockFile(gd)}.forced-${Date.now()}`);
  return `cleared merge.lock (${L.describeLock(held)})${aborted}`;
}
```

- [ ] **Step 4: Update `launch.mjs`**

1. Imports: add `classify, describeLock, mergeQueue, legacyText` to the merge-lib import and `readLock, lanesNow,
   groupLanes, skipLane, forceUnlock` to the merge.mjs import.

2. The `merge` subcommand body becomes:

```js
if (sub === "merge") {
  const group = opt("group") && slug(opt("group")), root = rootArg();
  if (!group || !root) { console.error("merge needs --group <id> [--repo <main repo or one of its worktrees>] [--lane <name>] [--skip <lane> --why <reason>] [--force] [--dry-run]"); process.exit(2); }
  const ctx = mergeCtx(root, group), gd = groupDir(root, group);
  if (dry) {
    const c = readConfig(gd);
    if (!c?.ok) { console.log(c ? c.errors.map((e) => `ERROR config: ${e}`).join("\n") : legacyText(group)); process.exit(0); }
    console.log(`would merge, in order: [${mergeQueue(lanesNow(ctx, c.config).lanes, opt("lane") && slug(opt("lane"))).map((l) => l.name).join(",")}]; merge.lock: ${describeLock(readLock(gd))}`);
    process.exit(0);
  }
  if (flag("force")) console.log(forceUnlock(ctx));
  if (opt("skip")) { const s = skipLane(ctx, slug(opt("skip")), opt("why", "skipped by hand")); console.log(s.line); if (!s.ok) process.exit(1); }
  const r = drain(ctx, { prefer: opt("lane") && slug(opt("lane")) });
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
```

3. Group guards. Directly after `const mergeName = group ? \`${group}-merge\` : null;` add:

```js
// Rolling-merge groups have a config.json (written by `launch.mjs group`); groups without one keep the legacy flow.
const groupCfg = group && root ? readConfig(groupDir(root, group)) : null;
if (groupCfg && !groupCfg.ok) { console.error(`group ${group} config.json is invalid: ${groupCfg.errors.join("; ")}`); process.exit(2); }
if (groupCfg && name === mergeName) {
  console.error(`${group} is a rolling-merge group: lanes merge via launch.mjs merge, and the final merge into ${groupCfg.config.target} is done by hand with the user - there is no ${mergeName} session.`);
  process.exit(3);
}
```

4. The reopen guard (the block starting `if (group && !isMergeSession(group, name) && doneMarker && fs.existsSync(doneMarker)) {`)
   computes `mergeStarted` per flow:

```js
if (group && !isMergeSession(group, name) && doneMarker && fs.existsSync(doneMarker)) {
  let mergeStarted;
  if (groupCfg) {
    const me = classify(groupLanes({ entries: reg.entries, merges: reg.merges, group, repoKey: key(root), cfg: groupCfg.config, root })).find((l) => l.name === name);
    mergeStarted = me?.state === "merged" || readLock(path.dirname(doneMarker))?.lane === name;
  } else mergeStarted = fs.existsSync(path.join(path.dirname(doneMarker), "merge.lock")) || reg.entries.some((e) => e.group === group && e.name === mergeName);
  if (flag("reopen") && mergeStarted) {
    console.error(groupCfg ? `lane ${name} is already merged (or being merged) into ${groupCfg.config.integration} - start new work as a NEW lane or group (SKILL.md section 4).`
      : `merge for ${group} already launched - --reopen would start work nothing merges. Use a NEW group (SKILL.md section 4).`);
    process.exit(3);
  }
  if (!flag("reopen")) { console.error(`lane ${name} already wrote its done marker - start post-merge stages under a NEW group (see SKILL.md section 4), or pass --reopen to reopen this lane before the merge.`); process.exit(3); }
  if (!dry) fs.renameSync(doneMarker, `${doneMarker}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
}
```

5. The rolling lane prompt (replace the `laneNote` from Task 3):

```js
const laneNote = !group || isMergeSession(group, name) ? ""
  : groupCfg ? ` Fan-out group ${group} (rolling merges): write the done marker ${fwd(doneMarker)} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - then run node ${fwd(fileURLToPath(import.meta.url))} merge --group ${group} --repo ${fwd(root)} --lane ${name} and report its output. Otherwise launch the lane next stage as the handoff says.`
  : ` Fan-out group ${group}: write the done marker ${fwd(doneMarker)} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
```

6. Header: the `merge` usage line gains `[--skip <lane> --why <reason>] [--force] [--dry-run]`.

- [ ] **Step 5: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "handoff-launch: merge --skip/--force/--dry-run, rolling lane prompt and launch guards"
```

---

### Task 5: The `overlap` subcommand and the rolling `status`

**Files:**
- Modify: `claude/skills/handoff-launch/launch.mjs` (the `status` block, lines 250-278; new `overlap` subcommand)
- Create: `claude/skills/handoff-launch/tests/status.test.mjs`

**Interfaces:**
- Consumes: `refreshOverlap`, `lanesNow`, `drain`, `readLock`, `lockStateOf`, `sessionClosed`, `readConfig`,
  `groupDir` (merge.mjs); `mergeTag`, `rollingSummary`, `legacyText` (merge-lib.mjs).
- Produces: `overlap --group <id> [--repo] [--dry-run]`; `status --group <id> [--no-merge] [--dry-run]`. For a
  rolling group, status drains first, then prints one line per lane, and the summary from `rollingSummary`. For a
  legacy group the output is unchanged (Task 1 golden).

- [ ] **Step 1: Write the failing tests**

`claude/skills/handoff-launch/tests/status.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, launchLane, commitIn, writeDone } from "./helpers.mjs";

const setup = (sb) => assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
const marker = (sb, name) => JSON.parse(fs.readFileSync(path.join(sb.repo, ".superpowers", "sessions", "g1", `${name}.done`), "utf8"));

test("overlap writes the files a finished lane shares with running lanes into its done marker", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "shared.txt": "A\n", "a.txt": "A\n" }, "A work"));
    const hb = commitIn(sb, b, { "shared.txt": "B\n" }, "B work");
    commitIn(sb, c, { "c.txt": "C\n" }, "C work");
    const r = sb.run("overlap", "--group", "g1", "--repo", sb.repo);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^A \(finished\) <-> B \(running\): shared\.txt$/m);
    assert.doesNotMatch(r.out, /C \(running\)/);
    assert.deepEqual(marker(sb, "A").overlap, { B: ["shared.txt"] });
    assert.equal(sb.git(b, "rev-parse", "HEAD"), hb);
    assert.equal(sb.git(b, "status", "--porcelain"), "");
    assert.match(sb.run("overlap", "--group", "g0", "--repo", sb.repo).err, /rolling-merge group/);
  } finally { sb.cleanup(); }
});

test("status on a rolling group drains finished lanes, then shows merge state and overlap", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"), b = launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "shared.txt": "A\n" }, "A work"));
    commitIn(sb, b, { "shared.txt": "B\n" }, "B work");
    let r = sb.run("status", "--group", "g1", "--no-merge");
    assert.match(r.out, /^A +lane-A +DONE {2}head=[0-9a-f]+ tests=ok {2}QUEUED {2}overlap=\{"B":\["shared\.txt"\]\}$/m);
    assert.match(r.out, /^B +lane-B +open \(lane still running its stages\)$/m);
    assert.match(r.out, /^members=2 done=1 all_done=false merge_launched=false merge_lock=false merged=0 queue=\[A\] merge_holder=none final_ready=false$/m);
    assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "--quiet", "int-g1"]).status, 1); // --no-merge
    r = sb.run("status", "--group", "g1");
    assert.match(r.out, /^merge: merged A -> int-g1 [0-9a-f]{7}$/m);
    assert.match(r.out, /^A +lane-A +DONE .* MERGED [0-9a-f]{7}/m);
    assert.match(r.out, /merged=1 queue=\[\] merge_holder=none final_ready=false$/m);
  } finally { sb.cleanup(); }
});

test("status reports a merge session holding the lock and a dead merge process as STALE", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const lock = path.join(sb.repo, ".superpowers", "sessions", "g1", "merge.lock");
    fs.writeFileSync(lock, JSON.stringify({ holder: "session", token: "t", session: "g1-merge-A", lane: "A", head: "x", at: new Date().toISOString() }));
    let r = sb.run("status", "--group", "g1");
    assert.match(r.out, /^merge: queued: g1-merge-A is resolving A$/m);
    assert.match(r.out, /merge_launched=true merge_lock=true merged=0 queue=\[A\] merge_holder=g1-merge-A\(A\) final_ready=false$/m);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(lock, JSON.stringify({ holder: "drain", token: "t", pid: dead, lane: "A", at: new Date().toISOString() }));
    r = sb.run("status", "--group", "g1", "--no-merge");
    assert.match(r.out, /merge_holder=pid\d+\(A\) final_ready=false \(STALE: the merging process is gone - the next merge reclaims the lock\)$/m);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/status.test.mjs`
Expected: FAIL (`unknown subcommand overlap`; status prints the legacy summary for g1).

- [ ] **Step 3: Implement**

1. Imports: add `mergeTag, rollingSummary` (merge-lib) and `refreshOverlap, lockStateOf, sessionClosed` (merge.mjs).

2. Replace the `status` block with:

```js
// One status line per lane in the legacy format; rolling groups append the merge state and overlap.
function memberLine(e) {
  let marker = null, done = false;
  if (e.done_marker && fs.existsSync(e.done_marker)) {
    try { marker = JSON.parse(fs.readFileSync(e.done_marker, "utf8")); done = true; } catch { marker = { unreadable: true }; }
    const tip = marker.head && e.branch ? git(e.repo || ".", "rev-parse", "--short", e.branch).out : "";
    if (tip && !String(marker.head).startsWith(tip) && !tip.startsWith(String(marker.head))) marker.warn = `branch tip ${tip} != marker head`;
  }
  const next = marker?.next_after_merge?.length ? ` next_after_merge=${JSON.stringify(marker.next_after_merge)}` : "";
  const m = marker?.unreadable ? "UNREADABLE marker (not counted as done)" : marker ? `${marker.warn ? `WARN ${marker.warn}  ` : ""}${String(marker.status || "done").toUpperCase()}  head=${marker.head ?? "?"} tests=${marker.tests ?? "?"}${next}` : "open (lane still running its stages)";
  return { done, text: `${e.name.padEnd(28)} ${String(e.branch).padEnd(30)} ${m}${live(e) ? "" : "  (window closed)"}` };
}
function rollingStatus(group, root, c) {
  if (!c.ok) { for (const e of c.errors) console.log(`ERROR config: ${e}`); return 1; }
  const ctx = mergeCtx(root, group);
  if (!flag("no-merge") && !dry) for (const l of drain(ctx).lines) console.log(`merge: ${l}`);
  const { reg: r, lanes } = lanesNow(ctx, c.config);
  refreshOverlap(root, c.config, lanes, { write: !dry });
  for (const l of lanes) {
    const tag = mergeTag(l), ov = l.marker?.overlap && Object.keys(l.marker.overlap).length ? `  overlap=${JSON.stringify(l.marker.overlap)}` : "";
    console.log(`${memberLine(l.entry).text}${tag ? `  ${tag}` : ""}${ov}`);
  }
  const lock = readLock(groupDir(root, group));
  console.log(rollingSummary(lanes, lock, { state: lock ? lockStateOf(lock, c.config) : null, sessionClosed: lock?.holder === "session" && sessionClosed(r, lock.session) }));
  return 0;
}
if (sub === "status") {
  const group = opt("group");
  if (!group) { console.error("status needs --group <id>"); process.exit(2); }
  const repoKey = opt("repo") ? key(mainRoot(path.resolve(opt("repo"))) || opt("repo")) : null;
  const latest = new Map();
  for (const e of reg.entries) {
    if (e.group !== slug(group) || (repoKey && e.repo !== repoKey)) continue;
    const prev = latest.get(e.name);
    if (!prev || prev.launched_at < e.launched_at) latest.set(e.name, e);
  }
  const mergeName = `${slug(group)}-merge`;
  const members = [...latest.values()].filter((e) => !isMergeSession(slug(group), e.name));
  const gdir = members[0]?.done_marker ? path.dirname(members[0].done_marker) : null;
  const cfg = gdir ? readConfig(gdir) : null;
  if (cfg) process.exit(rollingStatus(slug(group), path.resolve(gdir, "..", "..", ".."), cfg));
  let done = 0;
  for (const e of members) { const m = memberLine(e); if (m.done) done++; console.log(m.text); }
  const lockFile = gdir ? path.join(gdir, "merge.lock") : null;
  const lock = !!lockFile && fs.existsSync(lockFile);
  console.log(`members=${members.length} done=${done} all_done=${members.length > 0 && done === members.length} merge_launched=${latest.has(mergeName)} merge_lock=${lock}${lock && !latest.has(mergeName) ? " (STALE lock: no merge entry - relaunch the merge with --force)" : ""}`);
  process.exit(0);
}
```

3. The `overlap` subcommand (next to `merge`):

```js
if (sub === "overlap") {
  const group = opt("group") && slug(opt("group")), root = rootArg();
  if (!group || !root) { console.error("overlap needs --group <id> [--repo <dir>] [--dry-run]"); process.exit(2); }
  const c = readConfig(groupDir(root, group));
  if (!c) { console.error(`overlap needs a rolling-merge group (config.json with the target branch) - ${legacyText(group)}`); process.exit(2); }
  if (!c.ok) { for (const e of c.errors) console.error(`ERROR config: ${e}`); process.exit(1); }
  const pairs = refreshOverlap(root, c.config, lanesNow(mergeCtx(root, group), c.config).lanes, { write: !dry });
  for (const p of pairs) console.log(`${p.finished} (finished) <-> ${p.running} (running): ${p.files.join(", ")}`);
  if (!pairs.length) console.log("no overlap between finished and running lanes");
  process.exit(0);
}
```

4. Header: `status` usage gains `[--no-merge]`; add `//   node launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]`.

- [ ] **Step 4: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: all PASS, the Task 1 legacy golden included.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "handoff-launch: overlap subcommand and rolling status (drains, merge state, overlap)"
```

---

### Task 6: SKILL.md §4, README, INSTALL_PROMPT

**Files:**
- Modify: `claude/skills/handoff-launch/SKILL.md` (§2 usage block, §4 whole)
- Modify: `README.md:18` and `README.md:34-35`
- Modify: `INSTALL_PROMPT.md:66,71,75`

**Interfaces:** none (docs). The text must match the CLI as built in Tasks 3-5: command names, flags, output
keywords (`merged`, `queued`, `CONFLICT`, `TEST FAILED`, `MERGE-BLOCKED`, `ERROR`, `FINAL_READY`).

- [ ] **Step 1: Replace SKILL.md §4 with**

```markdown
## 4. Fan-out: parallel lanes, merged as each one finishes
1. **Set up the group once, before launching any lane:**
   `node ~/.claude/skills/handoff-launch/launch.mjs group --group <id> --repo <main repo> --integration <branch> --target <branch> [--test "<cmd>"]`
   It writes `.superpowers/sessions/<id>/config.json` (`.superpowers/` must be git-ignored). The test command runs in a
   fresh worktree of the integration branch, so it installs what it needs (e.g. `npm ci && npm test`); default timeout
   30 min (`--test-timeout-min`). Then write one handoff per task and launch each with its own branch and the same
   group: `--worktree <branch> --group <id> --name <task>`.
2. **Lanes never wait for each other** (user directive 2026-10-01). Each member (`--name`) is a LANE: its whole wave of
   stages, not one handoff. When a stage finishes and the lane has a next stage that does not need another lane's
   unmerged work, START IT NOW in a NEW session: write that stage's handoff and launch it via this skill with the SAME
   `--name`, `--group` and `--worktree <same branch>`, sized for that stage, passing `--handoff` as an ABSOLUTE path (the
   registry keeps the latest entry per name, so the done marker stays the same). Only a small follow-up (≲ 1 hour, context still < ~150k) continues in the
   same session. Stages inside an already-ruled wave (the lane's own ledger/plan) need no ask-before-handoff; anything else (memory
   queues, a new feature) → ask the user before starting it. Never idle waiting for a sibling.
3. **Done contract** — only when the lane's whole wave is finished (or blocked, or its next stage needs another lane's
   unmerged work): commit on its own branch (never push, never merge), then write
   `<main repo>/.superpowers/sessions/<id>/<name>.done` (the pointer prompt names the exact path) as JSON
   `{"name","branch","head":"<sha>","status":"done|blocked","tests":"<real test output summary>","next_after_merge":[...],"at"}`,
   then run `launch.mjs merge --group <id> --repo <main repo> --lane <name>` (the pointer prompt has the exact command)
   and act on its output:
   - `merged <lane> -> <integration> <sha>`: done; tell the user in one line.
   - `queued: ...`: another merge holds the lock and picks this lane up after its own. Nothing to do.
   - `CONFLICT ...` / `TEST FAILED ... merge session <id>-merge-<lane> launched`: that session (opus/high) resolves it.
     Nothing to do.
   - `FINAL_READY ...`: every lane is merged or blocked. Ask the user to approve the final merge of the integration
     branch into the target (never push without asking). After it, launch the listed `next_after_merge` stages as a
     NEW group, each on a NEW branch with `--base <target>`.
   - `ERROR ...`: report it to the user verbatim. Never delete the lock or edit the merge worktree yourself.
4. **How merges run** (code, zero tokens): one at a time under `.superpowers/sessions/<id>/merge.lock`, in the scratch
   worktree `.claude/worktrees/_merge-<id>` (never a lane's): `git merge --no-ff --no-commit <marker head>`, the test
   command, then the commit. A conflict or a failing test aborts the merge (the integration branch does not move) and
   launches `<id>-merge-<lane>` with a generated handoff listing the conflicts and the test output. That session holds
   the lock until its last step, `launch.mjs merge --group <id>`, sees the lane merged, releases the lock and merges
   the lanes that finished meanwhile. Running lanes are never touched.
   - `status --group <id>` also merges finished lanes (`--no-merge` only looks). Per lane it shows `MERGED`/`QUEUED`/
     `MERGE-BLOCKED` and `overlap=` (files a finished lane shares with running lanes; also `launch.mjs overlap --group
     <id>`). The summary adds `merged= queue=[..] merge_holder= final_ready=`; `merge_launched=true` means a merge
     session holds the lock.
   - Recovery: a lock whose merge process died is reclaimed by the next merge. `merge --group <id> --skip <lane> --why
     "<reason>"` gives up on a lane's current head and frees its session's lock. `merge --group <id> --force` clears a
     lock that status reports as STALE (and aborts an unfinished merge in the merge worktree); the lane is retried.
   - Large-org variant: a merge queue or CI-gated pull request per lane instead of local merges.
5. Never relaunch a finished lane under the old group: the launcher refuses a lane whose done marker exists (it would
   read as DONE at once). `--reopen` (archives the marker) reopens a lane only before it is merged; a reopened lane's
   new head is merged like any other.
6. `status` counts an unreadable marker as not done and warns when a marker's `head` is not the branch tip. Lanes always
   use `--worktree` (the head check reads the lane's recorded branch).
7. **Legacy groups** (no `config.json`, launched before 2026-10-03) keep the old flow: after its done marker, the lane
   runs `status --group <id>`; on `all_done=true merge_launched=false` it launches the merge handoff:
   `--repo <main repo> --handoff <merge handoff> --group <id> --name <id>-merge --model opus --effort high --worktree <integration branch> --base <target branch>`
   (an exclusive `merge.lock` + the registry refuse a second `<id>-merge`). That merge session confirms every lane is
   DONE, reviews and merges each branch (never pushes without asking), removes merged worktrees, and launches each
   lane's `next_after_merge` stages as a NEW group. `merge_lock` without a merge entry is stale: relaunch with `--force`.
   `--reopen` is refused once that merge has launched. `launch.mjs merge` on a legacy group only prints this flow.
```

And in §2's usage block add, after the launch command block:

```markdown
Fan-out subcommands (section 4): `launch.mjs group --group <id> --repo <dir> --integration <b> --target <b> [--test "<cmd>"]`,
`launch.mjs merge --group <id> [--lane <name>] [--skip <lane> --why <reason>] [--force] [--dry-run]`,
`launch.mjs overlap --group <id>`, `launch.mjs status --group <id> [--no-merge]`.
```

- [ ] **Step 2: README**

Line 18, replace "parallel fan-out lanes with done markers and an automatic merge session" with "parallel fan-out
lanes merged into an integration branch as each one finishes (deterministic, under a lock; a merge session only on a
conflict or a failing test)". Lines 34-35, replace "Parallel lanes run in their own worktrees, and the last one to
finish launches the merge session." with "Parallel lanes run in their own worktrees; each finished lane is merged into
the group's integration branch right away by code, and a merge session starts only for a real conflict or a failing
test. The final merge into the target branch waits for the user's approval."

- [ ] **Step 3: INSTALL_PROMPT nits**

- Lines 66 and 75: `"<CONFIG>/...` → `"CONFIG/...` (the file defines `CONFIG` without brackets on line 10).
- Line 71 (176 chars): break after `(a backslash breaks the JSON).` so no line exceeds 120 characters, keeping the
  5-space indent.
- Verify: `awk 'length > 120 {print FILENAME": "FNR": "length}' INSTALL_PROMPT.md` prints at most the pre-existing
  123-char line 79 (shorten it too if a natural break exists), and `grep -n "<CONFIG>" INSTALL_PROMPT.md` prints nothing.

- [ ] **Step 4: Check docs against the CLI**

Run each command named in the new §4 with `--dry-run` or `--help`-style misuse in a sandbox (or read the tests) and
confirm every flag and output keyword in the text exists. Run the full suite:
`node --test "claude/skills/handoff-launch/tests/*.test.mjs"` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/SKILL.md README.md INSTALL_PROMPT.md
git commit -m "handoff-launch docs: rolling merges in SKILL.md section 4, README, INSTALL_PROMPT nits"
```

---

### Task 7 (controller): review, deploy, verify, push

Not a subagent implementation task: the controller runs it.

- [ ] **Step 1: Whole-branch review.** Dispatch `worker-xhigh` + **fable** on `git diff main...stage1-rolling-merges`
  with this plan, the spec's stage-1 section and the Review Focus list. Fix findings through a `worker-high` + opus
  dispatch; anything edited after the review gets a scoped re-review of those edits.
- [ ] **Step 2: Full suite.** `node --test "claude/skills/handoff-launch/tests/*.test.mjs"` → `# fail 0`; quote the
  summary.
- [ ] **Step 3: Backward-compat baseline on the live legacy groups (read-only).** Before deploying, capture
  `node ~/.claude/skills/handoff-launch/launch.mjs status --group <id>` for each running legacy group named in the
  private handoff (legacy `status` only reads). Keep the outputs in the scratchpad.
- [ ] **Step 4: Deploy to live.** Copy `merge-lib.mjs`, `merge.mjs`, `run-test.mjs` and `tests/` into
  `~/.claude/skills/handoff-launch/` FIRST, then `launch.mjs`, then `SKILL.md` (a `launch.mjs` that imports a missing
  module would break running lanes). Then
  `diff -r claude/skills/handoff-launch ~/.claude/skills/handoff-launch` → only `pids`, `stops`, `sessions.jsonl`
  differ (live-only runtime files).
- [ ] **Step 5: Re-run the step 3 commands against the live copy** and `diff` against the baseline → identical. Also
  `node ~/.claude/skills/handoff-launch/launch.mjs status --group none` → `members=0 done=0 all_done=false merge_launched=false merge_lock=false`.
- [ ] **Step 6: Secret scan** (pattern from the private handoff) → prints nothing.
- [ ] **Step 7: Commit and push.** Fast-forward `main` to `stage1-rolling-merges`, push `main`. Commit messages end
  with the session's attribution lines.
- [ ] **Step 8: Report and hand over.** Tell the user, per running lane, what it needs: `launch.mjs`, `merge*.mjs`
  and `run-test.mjs` take effect on the next call (no restart). The changed `SKILL.md` text is picked up only by a
  session that (re)loads the skill, so legacy lanes need no restart (their flow is unchanged and `merge` on a legacy
  group prints that flow). Message the coordinator session `caludeworkflow-98` that stage 1 is deployed. Then stop
  and ask the user before any stage-2 spec or handoff.
