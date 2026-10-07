import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeRepo, addWorktree, rmrf } from "./helpers.mjs";
import {
  changes, globMatch, scopeCheck, baseline, diffHash, fileStats, isClean, untrackedPatch,
} from "../lib/scope.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

function put(repo, rel, content = "x\n") {
  const f = path.join(repo, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

function withRepo(fn) {
  return async () => {
    const repo = makeRepo();
    try {
      await fn(repo);
    } finally {
      rmrf(path.dirname(repo));
    }
  };
}

test("changes: paths with spaces and non-ASCII come back unquoted, forward-slash", withRepo((repo) => {
  put(repo, "dir sub/a b.txt");
  put(repo, "ü.txt");
  put(repo, "src/ok.ts");
  const list = changes(repo);
  assert.deepEqual(list.map((c) => c.path).sort(), ["dir sub/a b.txt", "src/ok.ts", "ü.txt"]);
  assert.ok(list.every((c) => c.xy === "??"));
  assert.equal(isClean(repo), false);
}));

test("changes: tracked modification and deletion carry their XY", withRepo((repo) => {
  fs.writeFileSync(path.join(repo, "README.md"), "# changed\n");
  assert.deepEqual(changes(repo), [{ xy: " M", path: "README.md" }]);
  fs.rmSync(path.join(repo, "README.md"));
  assert.deepEqual(changes(repo), [{ xy: " D", path: "README.md" }]);
}));

test(".codex-tmp is always ignored", withRepo((repo) => {
  put(repo, ".codex-tmp/x");
  put(repo, ".codex-tmp/run1/check-1.cmd");
  assert.deepEqual(changes(repo), []);
  assert.equal(isClean(repo), true);
  put(repo, ".codex-tmpfoo/x"); // a different folder is not ignored
  assert.deepEqual(changes(repo).map((c) => c.path), [".codex-tmpfoo/x"]);
}));

test("a clean repo is clean; baseline is HEAD", withRepo((repo) => {
  assert.equal(isClean(repo), true);
  assert.equal(baseline(repo), git(repo, "rev-parse", "HEAD").trim());
  assert.match(baseline(repo), /^[0-9a-f]{40}$/);
}));

test("rename: both ends must be owned (into and out of scope)", withRepo((repo) => {
  put(repo, "src/a b.txt", "some content that is long enough for rename detection\nline2\nline3\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "add");
  fs.mkdirSync(path.join(repo, "other dir"));
  git(repo, "mv", "src/a b.txt", "other dir/ü c.txt");
  const list = changes(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0].xy[0], "R");
  assert.equal(list[0].path, "other dir/ü c.txt");
  assert.equal(list[0].orig, "src/a b.txt");
  // rename out of scope: new end not owned
  assert.deepEqual(scopeCheck(list, ["src/**"]), { ok: false, out: ["other dir/ü c.txt"] });
  // rename into scope: old end not owned
  assert.deepEqual(scopeCheck(list, ["other dir/**"]), { ok: false, out: ["src/a b.txt"] });
  assert.deepEqual(scopeCheck(list, ["src/**", "other dir/"]), { ok: true, out: [] });
}));

test("scopeCheck: an untracked file outside the globs is out; owned ones pass", withRepo((repo) => {
  put(repo, "src/in.ts");
  put(repo, "docs/out.md");
  put(repo, ".codex-tmp/ignored");
  const r = scopeCheck(changes(repo), ["src/**"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.out, ["docs/out.md"]);
  assert.deepEqual(scopeCheck(changes(repo), ["src/**", "docs/out.md"]), { ok: true, out: [] });
  assert.deepEqual(scopeCheck([], ["src/**"]), { ok: true, out: [] });
  // no globs at all: everything is out
  assert.equal(scopeCheck(changes(repo), []).ok, false);
}));

test("globMatch table", () => {
  const T = [
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/a.ts", "src/**", true],
    ["src/x/y/a.ts", "src/**", true],
    ["src/a.ts", "src/*", true],
    ["src/x/a.ts", "src/*", false],
    ["src/a.ts", "src/*.ts", true],
    ["src/a.tsx", "src/*.ts", false],
    ["src/a.ts", "src/?.ts", true],
    ["src/ab.ts", "src/?.ts", false],
    ["src/x/a.ts", "**/*.ts", true],
    ["a.ts", "**/*.ts", true],
    ["a.ts", "**", true],
    ["src/a.ts", "src/", true],
    ["src/x/a.ts", "src/", true],
    ["src2/a.ts", "src/", false],
    ["src", "src/", false],
    ["SRC/A.TS", "src/a.ts", true],
    ["src/A.ts", "SRC/**", true],
    ["src/a.ts", "./src/a.ts", true],
    ["src\\a.ts", "src/a.ts", true],
    ["src/a b/ü.ts", "src/a b/*.ts", true],
    ["src/a.ts", "src", false],
    ["src/a.ts", "", false],
    ["src/a.ts", "src?a.ts", false],
    ["src/a+b.ts", "src/a+b.ts", true],
    ["src/a(b).ts", "src/a(b).ts", true],
    ["src/axb.ts", "src/a.b.ts", false],
  ];
  for (const [p, g, want] of T) assert.equal(globMatch(p, g), want, `${p} vs ${g}`);
});

test("diffHash: stable, and sensitive to untracked bytes and to git add", withRepo((repo) => {
  const base = baseline(repo);
  const h0 = diffHash(repo, base);
  assert.match(h0, /^[0-9a-f]{64}$/);
  assert.equal(diffHash(repo, base), h0);
  put(repo, "new.txt", "aaaa\n");
  const h1 = diffHash(repo, base);
  assert.notEqual(h1, h0);
  assert.equal(diffHash(repo, base), h1);
  put(repo, "new.txt", "aaab\n"); // one byte
  const h2 = diffHash(repo, base);
  assert.notEqual(h2, h1);
  git(repo, "add", "new.txt");
  const h3 = diffHash(repo, base);
  assert.notEqual(h3, h2);
  fs.writeFileSync(path.join(repo, "README.md"), "# changed\n");
  assert.notEqual(diffHash(repo, base), h3);
}));

test("diffHash: ignores .codex-tmp", withRepo((repo) => {
  const base = baseline(repo);
  const h0 = diffHash(repo, base);
  put(repo, ".codex-tmp/r/x.cmd", "junk");
  assert.equal(diffHash(repo, base), h0);
}));

test("diffHash: unchanged when diff.noprefix, color.ui and friends are set in the repo", withRepo((repo) => {
  const base = baseline(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# changed\nmore\n");
  fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
  git(repo, "add", "bin.dat");
  put(repo, "dir sub/ü.txt", "untracked\n");
  const before = diffHash(repo, base);
  git(repo, "config", "diff.noprefix", "true");
  git(repo, "config", "color.ui", "always");
  git(repo, "config", "diff.mnemonicPrefix", "true");
  git(repo, "config", "diff.renames", "copies");
  git(repo, "config", "diff.external", "echo");
  assert.equal(diffHash(repo, base), before);
}));

test("diffHash: quotepath config does not change it (non-ASCII tracked path)", withRepo((repo) => {
  put(repo, "ü.txt", "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "u");
  const base = baseline(repo);
  put(repo, "ü.txt", "two\n");
  const before = diffHash(repo, base);
  git(repo, "config", "core.quotepath", "true");
  assert.equal(diffHash(repo, base), before);
}));

test("fileStats: tracked from numstat, untracked as +lines -0, binary marked", withRepo((repo) => {
  put(repo, "t.txt", "1\n2\n3\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "t");
  const base = baseline(repo);
  put(repo, "t.txt", "1\nTWO\n3\n4\n"); // +2 -1
  put(repo, "new file.txt", "a\nb\nc\n"); // +3
  put(repo, "nonl.txt", "a\nb"); // +2, no trailing newline
  fs.writeFileSync(path.join(repo, "b.bin"), Buffer.from([0, 1, 2]));
  const stats = fileStats(repo, base, changes(repo));
  assert.deepEqual(stats.sort(), [
    "b.bin (binary)",
    "new file.txt (+3 -0)",
    "nonl.txt (+2 -0)",
    "t.txt (+2 -1)",
  ]);
}));

test("fileStats: a rename lists both ends; a numstat config does not change it", withRepo((repo) => {
  put(repo, "src/a.txt", "l1\nl2\nl3\nl4\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "a");
  const base = baseline(repo);
  fs.mkdirSync(path.join(repo, "dst"));
  git(repo, "mv", "src/a.txt", "dst/a.txt");
  git(repo, "config", "diff.renames", "true");
  const stats = fileStats(repo, base, changes(repo));
  assert.deepEqual(stats.sort(), ["dst/a.txt (+4 -0)", "src/a.txt (+0 -4)"]);
}));

test("untrackedPatch: pinned no-index diff of a new file from cwd (exit 1 is normal)", withRepo((repo) => {
  put(repo, "dir sub/ü n.txt", "hello\n");
  const p = untrackedPatch(repo, "dir sub/ü n.txt").toString("utf8");
  assert.match(p, /^diff --git a\/dir sub\/ü n\.txt b\/dir sub\/ü n\.txt/m);
  assert.match(p, /^new file mode/m);
  assert.match(p, /^\+hello$/m);
  git(repo, "config", "diff.noprefix", "true");
  git(repo, "config", "color.ui", "always");
  assert.equal(untrackedPatch(repo, "dir sub/ü n.txt").toString("utf8"), p);
}));

test("works in a linked worktree whose path has a space", withRepo((repo) => {
  const wt = addWorktree(repo, "lane");
  assert.ok(wt.includes(" "));
  put(wt, "src/a.ts");
  assert.deepEqual(changes(wt), [{ xy: "??", path: "src/a.ts" }]);
  assert.equal(scopeCheck(changes(wt), ["src/**"]).ok, true);
  const base = baseline(wt);
  const h = diffHash(wt, base);
  put(wt, "src/a.ts", "y\n");
  assert.notEqual(diffHash(wt, base), h);
}));
