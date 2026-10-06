// C1: linkedPaths flags every changed path that goes through a junction/symlink, or is a hard-linked file, so the
// host never reads (hashes, counts lines of) a protected file Codex linked into an owned folder.
// Junctions are made with `cmd /c mklink /J` and point only at temp folders this test creates; they are removed
// with rmdir, never with a recursive rm through them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, rmrf, mkJunction, rmJunction } from "./helpers.mjs";
import { changes, linkedPaths } from "../lib/scope.mjs";

function withRepo(fn) {
  return async () => {
    const repo = makeRepo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cdx-lk-")));
    const links = [];
    const junction = (rel, target) => {
      const link = path.join(repo, ...rel.split("/"));
      fs.mkdirSync(path.dirname(link), { recursive: true });
      mkJunction(link, target);
      links.push(link);
      return link;
    };
    try {
      await fn(repo, outside, junction);
    } finally {
      for (const l of links) rmJunction(l);
      rmrf(path.dirname(repo));
      rmrf(outside);
    }
  };
}

const put = (file, body = "x\n") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

test("linkedPaths: files listed through a junction are flagged (git lists the target's files as untracked)", withRepo((repo, outside, junction) => {
  put(path.join(outside, "secret.txt"), "TOP SECRET\n");
  junction("src/leak", outside);
  put(path.join(repo, "src", "ok.txt"));
  const list = changes(repo);
  assert.ok(list.some((c) => c.path.startsWith("src/leak")), `git lists the junction contents: ${JSON.stringify(list)}`);
  const flagged = linkedPaths(repo, list);
  assert.ok(flagged.length >= 1);
  assert.ok(flagged.every((p) => p.startsWith("src/leak")), JSON.stringify(flagged));
  assert.ok(!flagged.includes("src/ok.txt"));
}));

test("linkedPaths: a path below a junction is flagged even when the file itself does not exist (parent segment)", withRepo((repo, outside, junction) => {
  junction("src/leak", outside);
  assert.deepEqual(linkedPaths(repo, [{ xy: " D", path: "src/leak/gone.txt" }]), ["src/leak/gone.txt"]);
}));

test("linkedPaths: c.orig is walked too (a rename out of a junction)", withRepo((repo, outside, junction) => {
  junction("src/leak", outside);
  put(path.join(repo, "src", "b.txt"));
  assert.deepEqual(linkedPaths(repo, [{ xy: "R ", path: "src/b.txt", orig: "src/leak/a.txt" }]), ["src/leak/a.txt"]);
}));

test("linkedPaths: a hard-linked file (nlink > 1) is flagged; ordinary files and deleted paths are not", withRepo((repo, outside) => {
  const secret = path.join(outside, "secret.txt");
  put(secret, "TOP SECRET\n");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.linkSync(secret, path.join(repo, "src", "hl.txt"));
  put(path.join(repo, "src", "plain.txt"));
  const list = [
    { xy: "??", path: "src/hl.txt" }, { xy: "??", path: "src/plain.txt" },
    { xy: " D", path: "src/deleted.txt" }, { xy: " D", path: "nodir/deleted.txt" },
  ];
  assert.deepEqual(linkedPaths(repo, list), ["src/hl.txt"]);
}));

test("linkedPaths: a real change list with only ordinary files is empty", withRepo((repo) => {
  put(path.join(repo, "src", "a.txt"));
  put(path.join(repo, "dir sub", "b c.txt"));
  assert.deepEqual(linkedPaths(repo, changes(repo)), []);
}));
