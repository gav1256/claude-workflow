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
  assert.match(md, /--skip C --session g1-merge-C --why "<reason>"/); // the session names itself: a running holder may skip
  assert.match(md, /````\nCONFLICT \(content\)\n```\nnested fence\n````/);
  assert.match(md, /\n## THE PROMPT\n/);
});
