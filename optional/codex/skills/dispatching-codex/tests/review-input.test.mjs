import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpEnv, makeRepo, rmrf } from "./helpers.mjs";

const env = tmpEnv();
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = env.CODEX_HOME;
const P = await import("../lib/paths.mjs");
const { reviewInput } = await import("../lib/review-input.mjs");
const { diffHash, baseline } = await import("../lib/scope.mjs");
assert.equal(P.STATE.startsWith(env.root), true);
after(() => env.cleanup());

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

let seq = 0;
const newId = () => `20261007T000000Z-r${++seq}`;

function put(repo, rel, content = "x\n") {
  const f = path.join(repo, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

/** A repo with a tracked edit + an untracked file, and the meta.json of a finished write run over it. */
function fixture({ record = true } = {}) {
  const repo = makeRepo();
  put(repo, "README.md", "# test repo\nsecond line\n");
  put(repo, "src/new.txt", "brand new\n");
  const writeRun = newId();
  const base = baseline(repo);
  if (record) {
    const dir = P.runDir(writeRun);
    P.atomicWriteJson(path.join(dir, "meta.json"), {
      run_id: writeRun, cwd: P.canonPath(repo), mode: "write", baseline: base,
      diff_hash: diffHash(repo, base), files: ["README.md (+1 -0)", "src/new.txt (+1 -0)"],
    });
  }
  return { repo, writeRun, base };
}

const done = (repo) => rmrf(path.dirname(repo));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test("--review-of: tracked edits and untracked files are in the patch; sha256 binds the patch bytes", async () => {
  const { repo, writeRun } = fixture();
  try {
    const runId = newId();
    const r = await reviewInput({ cwd: repo, runId, reviewOf: writeRun });
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = fs.readFileSync(path.join(P.runDir(runId), "review.patch"), "utf8");
    assert.match(text, /\+\+\+ b\/README\.md/);
    assert.match(text, /second line/);
    assert.match(text, /new file mode/);
    assert.match(text, /\+\+\+ b\/src\/new\.txt/);
    assert.match(text, /brand new/);
    assert.equal(r.sha256, sha(fs.readFileSync(path.join(P.runDir(runId), "review.patch"))));
    assert.equal(r.patchPath, path.join(repo, ".codex-tmp", runId, "review.patch"));
    assert.equal(fs.readFileSync(r.patchPath, "utf8"), text);
    const meta = JSON.parse(fs.readFileSync(path.join(P.runDir(runId), "meta.json"), "utf8"));
    assert.equal(meta.patch_sha256, r.sha256);
  } finally {
    done(repo);
  }
});

test("--review-of: the sha256 changes when the content changes (bound to this patch)", async () => {
  const a = fixture();
  const b = fixture();
  try {
    put(b.repo, "src/new.txt", "different\n");
    // re-record b's hash for its new content
    P.atomicWriteJson(path.join(P.runDir(b.writeRun), "meta.json"), {
      run_id: b.writeRun, cwd: P.canonPath(b.repo), baseline: b.base, diff_hash: diffHash(b.repo, b.base),
    });
    const ra = await reviewInput({ cwd: a.repo, runId: newId(), reviewOf: a.writeRun });
    const rb = await reviewInput({ cwd: b.repo, runId: newId(), reviewOf: b.writeRun });
    assert.equal(ra.ok && rb.ok, true);
    assert.notEqual(ra.sha256, rb.sha256);
  } finally {
    done(a.repo);
    done(b.repo);
  }
});

test("--review-of: a worktree that changed since the run -> worktree-changed", async () => {
  const { repo, writeRun } = fixture();
  try {
    put(repo, "src/new.txt", "edited after the run\n");
    const r = await reviewInput({ cwd: repo, runId: newId(), reviewOf: writeRun });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "worktree-changed");
  } finally {
    done(repo);
  }
});

test("--review-of: an empty patch -> empty-patch", async () => {
  const repo = makeRepo();
  try {
    const writeRun = newId();
    const base = baseline(repo);
    P.atomicWriteJson(path.join(P.runDir(writeRun), "meta.json"), {
      run_id: writeRun, cwd: P.canonPath(repo), baseline: base, diff_hash: diffHash(repo, base),
    });
    const r = await reviewInput({ cwd: repo, runId: newId(), reviewOf: writeRun });
    assert.deepEqual(r, { ok: false, reason: "empty-patch" });
  } finally {
    done(repo);
  }
});

test("--review-of: unknown run, missing diff_hash and a different cwd are refused", async () => {
  const { repo, writeRun } = fixture();
  const other = fixture();
  try {
    let r = await reviewInput({ cwd: repo, runId: newId(), reviewOf: newId() });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^review-of-unknown/);
    const noHash = newId();
    P.atomicWriteJson(path.join(P.runDir(noHash), "meta.json"), { run_id: noHash, cwd: P.canonPath(repo), baseline: baseline(repo) });
    r = await reviewInput({ cwd: repo, runId: newId(), reviewOf: noHash });
    assert.match(r.reason, /^review-of-unknown/);
    r = await reviewInput({ cwd: other.repo, runId: newId(), reviewOf: writeRun });
    assert.match(r.reason, /^review-of-cwd-mismatch/);
  } finally {
    done(repo);
    done(other.repo);
  }
});

test("--base: git diff <ref>...HEAD; an empty range -> empty-range; a bad ref -> base-not-found", async () => {
  const repo = makeRepo();
  try {
    const first = baseline(repo);
    put(repo, "lib/x.js", "export const x = 1;\n");
    git(repo, "add", "lib/x.js");
    git(repo, "commit", "-q", "-m", "add x");
    const runId = newId();
    const r = await reviewInput({ cwd: repo, runId, base: first });
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = fs.readFileSync(path.join(P.runDir(runId), "review.patch"), "utf8");
    assert.match(text, /\+\+\+ b\/lib\/x\.js/);
    assert.equal(r.sha256, sha(Buffer.from(text, "utf8")));
    assert.equal(fs.existsSync(r.patchPath), true);
    const empty = await reviewInput({ cwd: repo, runId: newId(), base: "HEAD" });
    assert.deepEqual(empty, { ok: false, reason: "empty-range" });
    const bad = await reviewInput({ cwd: repo, runId: newId(), base: "no-such-ref" });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /^base-not-found/);
  } finally {
    done(repo);
  }
});

test("a hard-linked changed file (nlink > 1) is refused", async () => {
  const { repo, writeRun } = fixture();
  try {
    fs.linkSync(path.join(repo, "src", "new.txt"), path.join(repo, "src", "alias.txt"));
    // the recorded hash no longer matches, but the link refusal comes first
    const r = await reviewInput({ cwd: repo, runId: newId(), reviewOf: writeRun });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^linked-path: /);
  } finally {
    done(repo);
  }
});

test("a changed path under a junction is refused (junction made with mklink /J, removed with rmdir)", { skip: process.platform !== "win32" }, async () => {
  const repo = makeRepo();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-junc-"));
  const link = path.join(repo, "lnk");
  let made = false;
  try {
    fs.writeFileSync(path.join(ext, "secret.txt"), "outside the repo\n");
    execFileSync("cmd", ["/c", "mklink", "/J", link, ext], { windowsHide: true, stdio: "ignore" });
    made = true;
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "node reports the junction as a link");
    put(repo, "src/ok.txt", "fine\n");
    const writeRun = newId();
    P.atomicWriteJson(path.join(P.runDir(writeRun), "meta.json"), {
      run_id: writeRun, cwd: P.canonPath(repo), baseline: baseline(repo), diff_hash: "0".repeat(64),
    });
    const r = await reviewInput({ cwd: repo, runId: newId(), reviewOf: writeRun });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^linked-path: /);
    assert.match(r.reason, /lnk/);
  } finally {
    if (made) execFileSync("cmd", ["/c", "rmdir", link], { windowsHide: true, stdio: "ignore" });
    assert.equal(fs.existsSync(path.join(ext, "secret.txt")), true, "rmdir removed only the junction");
    rmrf(ext);
    done(repo);
  }
});
