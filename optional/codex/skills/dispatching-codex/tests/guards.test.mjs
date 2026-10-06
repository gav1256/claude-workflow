// Task 9: lib/guards.mjs (isLinkedWorktree, laneCheck, continueCheck). Fake registry and fake codex only.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpEnv, makeRepo, addWorktree, rmrf, SKILL_DIR } from "./helpers.mjs";

// paths.mjs and live.mjs read the environment at import: set it before the dynamic imports.
const env = tmpEnv();
const HL_SRC = path.resolve(SKILL_DIR, "..", "..", "..", "..", "claude", "skills", "handoff-launch");
const REG = path.join(env.HL_REGISTRY_DIR, "sessions.jsonl");
const AGENTS_JSON = path.join(env.root, "agents.json");
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME, HL_REGISTRY_DIR: env.HL_REGISTRY_DIR,
  HL_SKILL_DIR: HL_SRC, HL_AGENTS_JSON: AGENTS_JSON,
});
delete process.env.HL_SESSION_ID;
delete process.env.HL_FAKE_PROBE;
const G = await import("../lib/guards.mjs");
const HL = await import(pathToFileURL(path.join(HL_SRC, "live.mjs")).href);
const SC = await import("../lib/scope.mjs");

const dirs = [];
after(() => {
  for (const d of dirs) rmrf(d);
  env.cleanup();
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();

// one repo with: the main checkout, the lane's worktree, a sibling and another lane's worktree; and a second repo
const repoA = makeRepo();
dirs.push(path.dirname(repoA));
const wtMe = addWorktree(repoA, "me");
const wtSib = addWorktree(repoA, "sib");
const wtOth = addWorktree(repoA, "oth");
const repoB = makeRepo();
dirs.push(path.dirname(repoB));
const wtB = addWorktree(repoB, "bee");

const entry = (o) => ({
  repo: "r", branch: o.name, launched_at: new Date().toISOString(), generation: 1, mode: "bg", bg_id: `bg-${o.id}`, ...o,
});
function registry(entries, { running = [], closed = [] } = {}) {
  const lines = entries.map((e) => JSON.stringify(e));
  for (const id of closed) lines.push(JSON.stringify({ closed: id }));
  fs.mkdirSync(path.dirname(REG), { recursive: true });
  fs.writeFileSync(REG, lines.join("\n") + "\n");
  fs.writeFileSync(AGENTS_JSON, JSON.stringify(running.map((id) => ({ id: `bg-${id}`, status: "running" }))));
  HL.forgetLiveness();
}
beforeEach(() => {
  delete process.env.HL_SESSION_ID;
  registry([]);
});

// ------------------------------------------------------------------------------------------ isLinkedWorktree

test("isLinkedWorktree: a linked worktree is, the main checkout and a plain folder are not, a missing path is not (no throw)", () => {
  assert.equal(G.isLinkedWorktree(wtMe), true);
  assert.equal(G.isLinkedWorktree(repoA), false);
  const plain = path.join(env.root, "plain");
  fs.mkdirSync(plain);
  assert.equal(G.isLinkedWorktree(plain), false);
  assert.equal(G.isLinkedWorktree(path.join(env.root, "nope")), false);
  // a subfolder of a linked worktree is inside one too (git resolves the same git-dir)
  fs.mkdirSync(path.join(wtMe, "sub"), { recursive: true });
  assert.equal(G.isLinkedWorktree(path.join(wtMe, "sub")), true);
});

// ------------------------------------------------------------------------------------------ laneCheck (HL_SESSION_ID unset)

test("laneCheck, no HL_SESSION_ID: another lane whose newest generation is running blocks its worktree", () => {
  registry([entry({ id: "L1", name: "lane-a", worktree: wtOth })], { running: ["L1"] });
  const r = G.laneCheck(wtOth);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^lane-busy: /);
  assert.match(r.reason, /lane-a/);
});

test("laneCheck, no HL_SESSION_ID: a worktree nobody owns, and one whose lane is gone (closed), pass", () => {
  registry([entry({ id: "L1", name: "lane-a", worktree: wtOth })], { closed: ["L1"] });
  assert.equal(G.laneCheck(wtOth).ok, true);
  assert.equal(G.laneCheck(wtSib).ok, true);
  assert.equal(G.laneCheck(wtB).ok, true);
});

test("laneCheck: unknown liveness blocks (the conservative side)", () => {
  // a window launch a few seconds ago with no pid file yet: liveness() says unknown
  registry([entry({ id: "L2", name: "lane-b", worktree: wtOth, mode: "window", bg_id: undefined })]);
  assert.equal(HL.liveness(HL.readRegistry().entries[0]).state, "unknown");
  const r = G.laneCheck(wtOth);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^lane-busy: .*unknown/);
});

test("laneCheck: only the newest generation of a lane counts (an older running one is superseded)", () => {
  const old = entry({ id: "L1", name: "lane-a", worktree: wtOth, generation: 1 });
  const fresh = entry({ id: "L3", name: "lane-a", worktree: wtSib, generation: 2 });
  registry([old, fresh], { running: ["L1"], closed: ["L3"] });
  // the newest entry of lane-a is L3 (closed, on wtSib): wtOth is not held by a live newest generation
  assert.equal(G.laneCheck(wtOth).ok, true);
});

test("laneCheck: a path spelled differently (case, slashes, trailing slash) is still the lane's worktree", () => {
  registry([entry({ id: "L1", name: "lane-a", worktree: wtOth })], { running: ["L1"] });
  const spelled = wtOth.toUpperCase().replace(/\\/g, "/") + "/";
  assert.equal(G.laneCheck(spelled).ok, false);
});

// ------------------------------------------------------------------------------------------ laneCheck (HL_SESSION_ID set)

function me(extra = {}) {
  return entry({ id: "ME", name: "lane-me", worktree: wtMe, ...extra });
}

test("laneCheck, HL_SESSION_ID set: the lane's own worktree passes; a self-created sibling linked worktree of the same repo passes", () => {
  process.env.HL_SESSION_ID = "ME";
  registry([me()], { running: ["ME"] });
  assert.equal(G.laneCheck(wtMe).ok, true);
  assert.equal(G.laneCheck(wtSib).ok, true); // ruling (a): Codex gets its own linked worktree
});

test("laneCheck, HL_SESSION_ID set: another live lane's worktree blocks, even in the same repo", () => {
  process.env.HL_SESSION_ID = "ME";
  registry([me(), entry({ id: "L1", name: "lane-a", worktree: wtOth })], { running: ["ME", "L1"] });
  const r = G.laneCheck(wtOth);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^lane-busy: /);
});

test("laneCheck, HL_SESSION_ID set: a linked worktree of a different repo, and an unregistered id, block", () => {
  process.env.HL_SESSION_ID = "ME";
  registry([me()], { running: ["ME"] });
  const r = G.laneCheck(wtB);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^lane-mismatch: /);
  process.env.HL_SESSION_ID = "NOT-THERE";
  const u = G.laneCheck(wtMe);
  assert.equal(u.ok, false);
  assert.match(u.reason, /^lane-unknown: /);
});

// ------------------------------------------------------------------------------------------ laneCheck without / with a broken handoff-launch folder

function guardsIn(hlDir, cwd) {
  const code = `import(${JSON.stringify(pathToFileURL(path.resolve(SKILL_DIR, "lib", "guards.mjs")).href)})` +
    `.then((g) => console.log(JSON.stringify(g.laneCheck(${JSON.stringify(cwd)}))))`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...env, HL_SKILL_DIR: hlDir }, encoding: "utf8", windowsHide: true, timeout: 60000,
  });
  assert.equal(r.status, 0, JSON.stringify({ status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message }));
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("laneCheck: the handoff-launch folder absent -> skipped with the note", () => {
  const r = guardsIn(path.join(env.root, "no-handoff-launch"), wtMe);
  assert.deepEqual(r, { ok: true, note: "lane-check: handoff-launch absent" });
});

test("laneCheck: a handoff-launch folder that does not load blocks (lane-check-failed), never a silent pass", () => {
  const bad = path.join(env.root, "bad-hl");
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, "live.mjs"), "throw new Error('boom');\n");
  fs.writeFileSync(path.join(bad, "lane-lib.mjs"), "export const normPath = (p) => p;\n");
  const r = guardsIn(bad, wtMe);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^lane-check-failed: /);
});

// ------------------------------------------------------------------------------------------ continueCheck

function residue() {
  const repo = makeRepo();
  dirs.push(path.dirname(repo));
  const wt = addWorktree(repo, "cont");
  const base = git(wt, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "a.txt"), "one\n");
  const meta = { run_id: "20261006T100000Z-aaaaaa", cwd: wt, mode: "write", baseline: base, owned: ["src/**"], diff_hash: SC.diffHash(wt, base) };
  return { wt, base, meta };
}

test("continueCheck: the run's own residue (same baseline, same hash) passes", () => {
  const { wt, meta } = residue();
  assert.deepEqual(G.continueCheck(meta, wt), { ok: true });
});

test("continueCheck: an extra edit, an extra untracked file, a moved HEAD all fail with continue-mismatch", () => {
  let { wt, meta } = residue();
  fs.writeFileSync(path.join(wt, "src", "a.txt"), "two\n");
  let r = G.continueCheck(meta, wt);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^continue-mismatch: /);

  ({ wt, meta } = residue());
  fs.writeFileSync(path.join(wt, "src", "b.txt"), "x\n");
  assert.match(G.continueCheck(meta, wt).reason, /^continue-mismatch: /);

  ({ wt, meta } = residue());
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "moved");
  assert.match(G.continueCheck(meta, wt).reason, /^continue-mismatch: /);
});

test("continueCheck: no recorded final hash, another worktree, a non-write run, no meta: all fail", () => {
  const { wt, meta } = residue();
  const { diff_hash: _drop, ...noHash } = meta;
  assert.match(G.continueCheck(noHash, wt).reason, /^continue-mismatch: /);
  const other = residue();
  assert.match(G.continueCheck(meta, other.wt).reason, /^continue-mismatch: /);
  assert.match(G.continueCheck({ ...meta, mode: "review" }, wt).reason, /^continue-mismatch: /);
  assert.match(G.continueCheck(null, wt).reason, /^continue-mismatch: /);
  assert.match(G.continueCheck("junk", wt).reason, /^continue-mismatch: /);
});
