import { test } from "node:test";
import assert from "node:assert/strict";
import { foldWorkers } from "../workers.mjs";
import { renderRecords } from "../records.mjs";

const created = (id, extra = {}) => ({ ev: "created", id, provider: "claude", label: id.replace(/-\d+$/, ""), objective: `obj ${id}`, ...extra });
const table = () => foldWorkers([
  created("auth-01"),
  { ev: "alias", worker_id: "auth-01", alias: "login worker" },
  { ev: "status", worker_id: "auth-01", status: "running", summary: "doing it" },
  created("ui-01", { provider: "codex", in_worktree_of: "auth-01" }),
  created("api-01"),
  { ev: "ended", worker_id: "api-01", why: "SECRET-WHY-TEXT" },
  created("api-02", { fallback_of: "api-01", fallback_reason: "codex slots full" }),
]);
const heads = ["# Coordinator records", "## Workers", "## Focus", "## Aliases", "## Notes", "## Task relationships"];
const headings = (out) => out.split("\n").filter((l) => l.startsWith("#"));

test("M8 has all sections in order, one heading each", () => {
  const out = renderRecords({ workers: table(), focus: "auth-01", notes: ["n1"] });
  assert.deepEqual(headings(out), heads);
  assert.match(out, /auth-01/);
  assert.match(out, /login worker/);
  assert.match(out, /## Focus\n+[^\n]*auth-01/);
});

test("M8 empty inputs still render every section", () => {
  assert.deepEqual(headings(renderRecords({ workers: new Map(), focus: null, notes: [] })), heads);
});

test("M8 a note with markdown injection renders as one escaped bullet line", () => {
  const out = renderRecords({ workers: table(), focus: null, notes: ["# rm -rf /\n## Workers"] });
  assert.deepEqual(headings(out), heads);
  const bullets = out.split("\n").filter((l) => l.includes("rm -rf /"));
  assert.equal(bullets.length, 1);
  assert.match(bullets[0], /^- /);
  assert.ok(!/^- #/.test(bullets[0]));
});

test("M8 notes: last 20 only, each capped at 300 characters", () => {
  const notes = Array.from({ length: 30 }, (_, i) => `note-${String(i).padStart(2, "0")} ${"x".repeat(400)}`);
  const out = renderRecords({ workers: new Map(), focus: null, notes });
  assert.ok(!out.includes("note-09"));
  assert.ok(out.includes("note-10") && out.includes("note-29"));
  const nl = out.split("\n").filter((l) => l.startsWith("- note-"));
  assert.equal(nl.length, 20);
  assert.ok(nl.every((l) => l.length <= 2 + 300));
});

test("M8 output stays at most 16 KiB with 200 notes (oldest dropped)", () => {
  const notes = Array.from({ length: 200 }, (_, i) => `n${i} ${"\u00e9".repeat(400)}`);
  const out = renderRecords({ workers: table(), focus: "auth-01", notes });
  assert.ok(Buffer.byteLength(out) <= 16384);
  assert.ok(!out.includes("n0 ") && out.includes("n199 "));
});

test("M8 stays at most 16 KiB even with a huge worker table", () => {
  const lines = [];
  for (let i = 1; i <= 300; i++) lines.push(created(`w-${i}`, { objective: "y".repeat(900) }));
  const out = renderRecords({ workers: foldWorkers(lines), focus: null, notes: ["keep"] });
  assert.ok(Buffer.byteLength(out) <= 16384);
  assert.deepEqual(headings(out), heads);
});

test("M8 Task relationships lists in_worktree_of and fallback_of with fallback_reason, never ended.why", () => {
  const out = renderRecords({ workers: table(), focus: null, notes: [] });
  const rel = out.slice(out.indexOf("## Task relationships"));
  assert.match(rel, /ui-01 works in auth-01's worktree/);
  assert.match(rel, /api-02 replaced a Codex request \(fallback: codex slots full\)/);
  assert.ok(!out.includes("SECRET-WHY-TEXT"));
});

test("M8 worker text and aliases are sanitized too (no injected heading)", () => {
  const w = foldWorkers([created("a-01", { objective: "x\n# Evil\n## Focus" }), { ev: "alias", worker_id: "a-01", alias: "al" }]);
  const out = renderRecords({ workers: w, focus: null, notes: [] });
  assert.deepEqual(headings(out), heads);
});

test("renderRecords accepts a worker array and note objects", () => {
  const out = renderRecords({ workers: [...table().values()], focus: null, notes: [{ note: "obj note" }] });
  assert.match(out, /obj note/);
});
