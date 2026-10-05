import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../lane-lib.mjs";

const at = (m) => new Date(Date.UTC(2026, 9, 5, 10, m)).toISOString();
// A launch line: legacy unless `supersedes` is given (null included).
const ln = (id, o = {}) => ({ id, name: o.name ?? id.split("@")[0], repo: "c:/r", branch: "main", worktree: "C:/r", generation: 1, mode: "window", launched_at: at(0), ...o });

test("chainOf: a new line follows its links; a legacy entry reached through a link ends the chain; a legacy line keeps the generation rule", () => {
  const a = ln("A@1", { generation: 1, launched_at: at(1) });                         // legacy
  const b = ln("B@2", { generation: 2, launched_at: at(2), supersedes: "A@1" });       // new, links to legacy A
  const c = ln("C@3", { generation: 3, launched_at: at(3), supersedes: "B@2" });
  const x = ln("X@4", { generation: 4, launched_at: at(4) });                          // legacy (no supersedes key)
  const entries = [a, b, c, x];
  assert.deepEqual(G.chainOf(c, entries).map((e) => e.id), ["B@2", "A@1"]);
  assert.deepEqual(G.chainOf(b, entries).map((e) => e.id), ["A@1"]);
  // Mixed boundary: legacy A has gen-1 predecessors on its checkout, but a chain that reaches A stops there.
  const old = ln("O@0", { generation: 0, launched_at: at(0) });
  assert.deepEqual(G.chainOf(c, [old, ...entries]).map((e) => e.id), ["B@2", "A@1"]);
  // A legacy N: every lower generation of its repo + branch (today's rule), whatever their keys.
  assert.deepEqual(G.chainOf(x, [old, ...entries]).map((e) => e.id).sort(), ["A@1", "B@2", "C@3", "O@0"]);
  // supersedes: null starts no chain; a cycle (hand-edited) ends; a missing link ends.
  assert.deepEqual(G.chainOf(ln("N@5", { supersedes: null }), entries), []);
  const p = ln("P@6", { supersedes: "Q@7" }), q = ln("Q@7", { supersedes: "P@6" });
  assert.deepEqual(G.chainOf(p, [p, q]).map((e) => e.id), ["Q@7"]);
  assert.deepEqual(G.chainOf(ln("M@8", { supersedes: "gone@1" }), entries), []);
});

test("supersedes: N after O and O in N's chain; chains pass through closed entries; a co-tenant is not a successor", () => {
  const o = ln("O@1", { launched_at: at(1), supersedes: null });
  const m = ln("M@2", { launched_at: at(2), supersedes: "O@1" });
  const n = ln("N@3", { launched_at: at(3), supersedes: "M@2" });
  const t = ln("T@4", { launched_at: at(4), supersedes: null }); // a --force'd co-tenant on the same checkout
  const all = [o, m, n, t];
  assert.equal(G.supersedes(n, o, all), true);
  assert.equal(G.supersedes(o, n, all), false);
  assert.equal(G.supersedes(t, o, all), false);
  assert.deepEqual(G.supersedersOf(o, all, new Set(["M@2"])).map((e) => e.id), ["N@3"]); // M is closed: N still supersedes O through it
  // Launch times equal to the millisecond (hand-made or test lines): a legacy N still supersedes its lower generation,
  // and a link still counts; a link from an OLDER line does not.
  const l1 = ln("L@1", { generation: 1, launched_at: at(9) }), l2 = ln("L@2", { generation: 2, launched_at: at(9) });
  assert.equal(G.supersedes(l2, l1, [l1, l2]), true);
  assert.equal(G.supersedes(ln("Q@2", { launched_at: at(1), supersedes: "O@1" }), o, all), true);
  assert.equal(G.supersedes(ln("Q@0", { launched_at: at(0), supersedes: "O@1" }), o, all), false);
});

test("pickSupersedes: resume, explicit, relay (same worktree path or same repo + branch), merge, none", () => {
  const L = ln("L@1", { session_id: "s-l", worktree: "C:/r/.claude/worktrees/lane-a", branch: "lane-a" });
  const other = ln("K@1", { branch: "lane-k", worktree: "C:/r/.claude/worktrees/lane-k" });
  const entries = [L, other];
  const target = { repo: "c:/r", branch: "lane-a", worktree: "c:\\r\\.claude\\worktrees\\lane-a\\" };
  assert.deepEqual(G.pickSupersedes({ entries, resumeOf: L, explicit: "K@1", hlSessionId: "L@1", target, name: "L" }), { supersedes: "L@1", rule: "resume", launcher: null, note: null });
  assert.equal(G.pickSupersedes({ entries, explicit: "K@1", hlSessionId: "L@1", target, name: "L" }).supersedes, "K@1");
  let r = G.pickSupersedes({ entries, hlSessionId: "L@1", target, name: "L" });
  assert.deepEqual([r.supersedes, r.rule, r.note], ["L@1", "relay", null]);
  // Found by launched_by (a launcher without HL_SESSION_ID), under another --name: a relay, with its note.
  r = G.pickSupersedes({ entries, launchedBy: "s-l", target, name: "L2" });
  assert.deepEqual([r.supersedes, r.note], ["L@1", "note: this launch replaces L (gen 1) as its relay"]);
  // L switched its checkout's branch after its own launch: the worktree path still makes it a relay.
  r = G.pickSupersedes({ entries, hlSessionId: "L@1", target: { ...target, branch: "lane-a2" }, name: "L" });
  assert.equal(r.rule, "relay");
  // A registry session launching onto another checkout: none (rule 5).
  r = G.pickSupersedes({ entries, hlSessionId: "L@1", target: { repo: "c:/r", branch: "lane-k", worktree: "C:/r/.claude/worktrees/lane-k" }, name: "X" });
  assert.deepEqual([r.supersedes, r.rule], [null, "none"]);
  // A merge session with no known launcher: the target's newest open entry; with a known launcher elsewhere: none.
  const m1 = ln("g-merge-a@1", { branch: "int", worktree: "C:/r/.claude/worktrees/_merge-g", launched_at: at(1) });
  const m2 = ln("g-merge-b@2", { branch: "int", worktree: "C:/r/.claude/worktrees/_merge-g", launched_at: at(2) });
  const mt = { repo: "c:/r", branch: "int", worktree: "C:/r/.claude/worktrees/_merge-g" };
  assert.equal(G.pickSupersedes({ entries: [m1, m2], target: mt, name: "g-merge-c", isMerge: true }).supersedes, "g-merge-b@2");
  assert.equal(G.pickSupersedes({ entries: [m1, m2], closed: new Set(["g-merge-b@2"]), target: mt, name: "g-merge-c", isMerge: true }).supersedes, "g-merge-a@1");
  assert.equal(G.pickSupersedes({ entries: [m1, m2, L], hlSessionId: "L@1", target: mt, name: "g-merge-c", isMerge: true }).supersedes, null);
  // A hand-opened session or a plain terminal: none.
  assert.equal(G.pickSupersedes({ entries, launchedBy: "s-unknown", target, name: "X" }).supersedes, null);
});

test("occupantAct: running refuses, unknown warns, an empty host closes (dead start or exited), a user's job below keeps it", () => {
  const w = ln("W@1"), b = ln("B@1", { mode: "bg" });
  const run = { state: "running", why: "host pid 1" };
  assert.equal(G.occupantAct({ e: w, lv: { state: "gone", why: "x" }, below: null, ageMs: 0 }).act, "ignore");
  assert.equal(G.occupantAct({ e: w, lv: { state: "unknown", why: "probe" }, below: null, ageMs: 0 }).act, "warn");
  assert.equal(G.occupantAct({ e: b, lv: run, below: null, ageMs: 0 }).act, "refuse");
  assert.equal(G.occupantAct({ e: w, lv: run, below: null, ageMs: 0 }).act, "warn");
  assert.equal(G.occupantAct({ e: w, lv: run, below: { claude: true, empty: false, names: ["claude.exe"] }, ageMs: 3600e3 }).act, "refuse");
  assert.deepEqual(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: false, names: ["python.exe"] }, ageMs: 3600e3 }), { act: "refuse", why: "its window runs python.exe" });
  // A probe answer without names (or an empty list) still refuses, it never throws.
  assert.deepEqual(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: false }, ageMs: 3600e3 }), { act: "refuse", why: "its window runs something" });
  assert.deepEqual(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: false, names: [] }, ageMs: 3600e3 }), { act: "refuse", why: "its window runs something" });
  assert.equal(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: true, names: [] }, ageMs: 3600e3 }).act, "close");
  assert.equal(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: true, names: [] }, ageMs: 30000 }).act, "refuse"); // still starting
  assert.match(G.OCCUPIED({ repo: "C:/r", branch: "main", e: { ...w, generation: 3 } }), /^refused - C:\/r@main already has a running session W \(gen 3, id W@1\): two sessions must not share a worktree\. .* --supersedes W@1\. --force overrides \(ask the user first\)\.$/);
});

test("restartBlockers is the union: newer on the same repo + branch, or a successor on a switched branch; isSuccessor tells a co-tenant", () => {
  const e = ln("E@1", { generation: 1, launched_at: at(1), supersedes: null });
  const relay = ln("R@2", { generation: 1, branch: "other", launched_at: at(2), supersedes: "E@1" }); // relay that switched branch
  const co = ln("T@3", { generation: 2, launched_at: at(3), supersedes: null });                     // co-tenant, newer gen
  const all = [e, relay, co];
  assert.deepEqual(G.restartBlockers(e, all).map((x) => x.id), ["R@2", "T@3"]);
  assert.deepEqual(G.restartBlockers(e, all, new Set(["R@2", "T@3"])), []);
  assert.equal(G.isSuccessor(relay, e, all), true);
  assert.equal(G.isSuccessor(co, e, all), false);
  // A legacy newer generation is a successor (its chain is the generation rule).
  const leg = ln("L@4", { generation: 3, launched_at: at(4) });
  assert.equal(G.isSuccessor(leg, e, [...all, leg]), true);
});

test("priority: derived from the sizing, set by a later {priority} line, sorted high -> normal -> low then the given order", () => {
  assert.equal(G.derivePriority({ model: "fable", effort: "high" }), "high");
  assert.equal(G.derivePriority({ model: "opus", effort: "xhigh" }), "high");
  assert.equal(G.derivePriority({ model: "opus", effort: "max" }), "high");
  assert.equal(G.derivePriority({ model: "opus", effort: "high" }), "normal");
  assert.equal(G.derivePriority({ model: "opus", effort: "medium" }), "low");
  assert.equal(G.derivePriority({ model: "opus", effort: "low" }), "low");
  assert.equal(G.derivePriority({}), "normal");
  const e = ln("A@1", { group: "g", model: "opus", effort: "high", launched_at: at(5) });
  const lines = [e, { priority: "A", group: "g", value: "high", at: at(4) }]; // older than the launch: ignored
  assert.equal(G.effectivePriority(lines, e), "normal");
  lines.push({ priority: "A", group: "other", value: "low", at: at(6) });     // another group: ignored
  lines.push({ priority: "A", group: "g", value: "low", at: at(7) });
  assert.equal(G.effectivePriority(lines, e), "low");
  assert.equal(G.effectivePriority(lines, { ...e, priority: "high", launched_at: at(8) }), "high"); // a newer launch line wins
  const items = [{ n: "a", p: "low" }, { n: "b", p: "normal" }, { n: "c", p: "high" }, { n: "d", p: "normal" }, { n: "e", p: undefined }];
  assert.deepEqual(G.byPriority(items, (x) => x.p).map((x) => x.n), ["c", "b", "d", "e", "a"]);
});

test("fenceDecision: own root, config, temp, .superpowers, unowned agent worktrees allow; other lanes and the main checkout deny", () => {
  const main = "C:/Users/me/r";
  const mine = ln("A@1", { repo: "c:/users/me/r", worktree: `${main}/.claude/worktrees/lane-a`, branch: "lane-a" });
  const b = ln("B@1", { repo: "c:/users/me/r", worktree: `${main}/.claude/worktrees/lane-b`, branch: "lane-b" });
  const ext = ln("X@1", { repo: "c:/users/me/r", worktree: "D:/elsewhere/r-x", branch: "lane-x" });
  const onMain = ln("M@1", { repo: "c:/users/me/r", worktree: main, branch: "main", launched_at: at(3) });
  const ctx = { cwd: `${main}/.claude/worktrees/lane-a`, own: G.ownRoot(mine), main, config: "C:/Users/me/.claude", tmp: "C:/Users/me/AppData/Local/Temp", others: [b, ext, onMain] };
  const d = (p, c = ctx) => G.fenceDecision(p, c);
  assert.equal(d("src/a.js").allow, true);                                                  // relative, own worktree
  assert.equal(d("C:\\USERS\\ME\\R\\.claude\\worktrees\\LANE-A\\x.md").allow, true);           // case, backslashes
  assert.equal(d("\\\\?\\C:\\Users\\me\\r\\.claude\\worktrees\\lane-a\\y").allow, true);       // a long-path prefix
  assert.equal(d("C:/Users/me/.claude/experiments/ledger.md").allow, true);
  assert.equal(d("C:/Users/me/AppData/Local/Temp/claude/x/scratchpad/GOAL.md").allow, true);
  assert.equal(d(`${main}/.superpowers/sessions/g/A.done`).allow, true);
  assert.equal(d(`${main}/.claude/worktrees/agent-1234/f.js`).allow, true);                    // a subagent's own worktree
  assert.equal(d("D:/other-repo/f.js").allow, true);
  // A denial's owner is {name, branch} only (not the whole launch line).
  const denyB = { allow: false, owner: { name: "B", branch: "lane-b" }, mainCheckout: false };
  let r = d(`${main}/.claude/worktrees/lane-b/f.js`);
  assert.deepEqual(r, denyB);
  r = d("D:/elsewhere/r-x/sub/f.js");
  assert.deepEqual(r, { allow: false, owner: { name: "X", branch: "lane-x" }, mainCheckout: false });
  r = d(`${main}/README.md`);
  assert.deepEqual([r.allow, r.owner, r.mainCheckout], [false, { name: "M", branch: "main" }, true]);
  // `..`, `.` and doubled separators collapse in absolute paths too (like merge-lib key()): no way around the fence.
  assert.deepEqual(d(`${main}/.claude/worktrees/lane-a/../lane-b/f.js`), denyB);
  assert.deepEqual(d(`${main}/.claude/worktrees//lane-b/f.js`), denyB);
  assert.deepEqual(d(`${main}\\.claude\\worktrees\\lane-a\\.\\..\\lane-b\\f.js`), denyB);
  assert.deepEqual(d("../lane-b/f.js"), denyB);                                                // relative, from lane-a
  assert.deepEqual(d(`${main}/.claude/worktrees/lane-a/../../../README.md`), { allow: false, owner: { name: "M", branch: "main" }, mainCheckout: true });
  // normPath: case, separators, a trailing slash and a bare drive root as before; `..` and `//` collapsed; empty stays empty.
  assert.equal(G.normPath("C:\\R\\X\\"), "c:/r/x");
  assert.equal(G.normPath("C:/r/x//"), "c:/r/x");
  assert.equal(G.normPath("C:/"), "c:");
  assert.equal(G.normPath("C:\\"), "c:");
  assert.equal(G.normPath("C:"), "c:");
  assert.equal(G.normPath("C:/r/./x//y/../z"), "c:/r/x/z");
  assert.equal(G.normPath("\\\\?\\C:\\r\\a\\..\\b"), "c:/r/b");
  assert.equal(G.normPath("y/../z", "C:\\r\\x\\"), "c:/r/x/z");
  assert.equal(G.normPath(""), "");
  assert.equal(G.normPath(null), "");
  assert.equal(d(`${main}/README.md`, { ...ctx, others: [b] }).owner, null);                  // the main checkout has no session
  // A session on the main checkout writes the main checkout, never another lane's worktree.
  const mctx = { ...ctx, cwd: main, own: G.ownRoot(onMain), others: [b, mine] };
  assert.equal(d(`${main}/README.md`, mctx).allow, true);
  assert.equal(d(`${main}/.claude/worktrees/lane-b/f.js`, mctx).allow, false);
  assert.equal(d(`${main}/.claude/worktrees/agent-9/f.js`, mctx).allow, true);
  // Nested: another lane's worktree inside this one's root is not this lane's.
  const nested = ln("N@1", { repo: "c:/users/me/r", worktree: `${main}/.claude/worktrees/lane-a/.claude/worktrees/n`, branch: "n" });
  assert.equal(d(`${main}/.claude/worktrees/lane-a/.claude/worktrees/n/f`, { ...ctx, others: [nested] }).allow, false);
  // A session launched on a subdirectory of the main checkout owns the main checkout.
  assert.equal(G.ownRoot(ln("S@1", { repo: "c:/users/me/r", worktree: `${main}/sub` })), "c:/users/me/r");
  assert.equal(G.ownRoot(ext), "d:/elsewhere/r-x");
  assert.match(G.fenceText({ p: "C:/x", own: "c:/w", owner: { name: "B", branch: "lane-b" }, mainCheckout: false, launchMjs: "L.mjs", ownName: "A" }),
    /^Write fence: C:\/x belongs to lane B \(lane-b\), not to this lane \(c:\/w\)\. Do not edit it from here\. Queue the change: node L\.mjs queue --to B --text "<what to change>" \[--after-merge\], or tell the user\.$/);
  assert.match(G.fenceText({ p: "C:/x", own: "c:/w", owner: null, mainCheckout: true, launchMjs: "L.mjs", ownName: "A" }), /belongs to the main checkout \(no session\): tell the user, or queue it --after-merge in your group/);
});

test("lane note text, its hash and the lane sets", () => {
  const me = { name: "A", branch: "lane-a", own: "c:/r/.claude/worktrees/lane-a", priority: "high" };
  const t = G.laneNoteText(me, [{ name: "B", branch: "lane-b", scope: "Batch B: merge" }]);
  assert.equal(t, "Lane note: you are lane A (branch lane-a, c:/r/.claude/worktrees/lane-a, priority high). Other live lanes in this repo: B (lane-b, Batch B: merge). "
    + "A request meant for another lane: say it belongs to that lane and offer launch.mjs queue --to <lane>. Work on files another live lane is changing: queue it with --after-merge.");
  assert.equal(G.laneNoteText(me, []), "Lane note: you are lane A (branch lane-a, c:/r/.claude/worktrees/lane-a, priority high). No other live lanes in this repo.");
  assert.notEqual(G.textHash(t), G.textHash(G.laneNoteText(me, [])));
  const lanes = [{ id: "A@1", branch: "lane-a", worktree: "C:/r/.claude/worktrees/lane-a" }, { id: "B@1", branch: "lane-b", worktree: "C:/r/.claude/worktrees/lane-b" }];
  assert.deepEqual(G.otherLanes(lanes, { id: "A@2", branch: "lane-a", worktree: "c:/r/.claude/worktrees/lane-a" }).map((l) => l.id), ["B@1"]);
  // The session's own predecessor after a branch switch (same worktree, old branch) is not another lane; neither is a
  // registry-fallback entry of the same repo + branch under another worktree path; another branch in another worktree is.
  const meR = { id: "A@3", repo: "c:/r", branch: "lane-a2", worktree: "C:/r/.claude/worktrees/lane-a" };
  const fallback = [
    { id: "A@1", repo: "c:/r", branch: "lane-a", worktree: "C:/r/.claude/worktrees/lane-a" },
    { id: "A@0", repo: "c:/r", branch: "lane-a2", worktree: "C:/r/old-path" },
    { id: "B@1", repo: "c:/r", branch: "lane-b", worktree: "C:/r/.claude/worktrees/lane-b" },
  ];
  assert.deepEqual(G.otherLanes(fallback, meR).map((l) => l.id), ["B@1"]);
  assert.deepEqual(G.otherLanes([{ id: "A@1", branch: "lane-a", worktree: "C:\\r\\.claude\\worktrees\\lane-a\\" }, lanes[1]], meR).map((l) => l.id), ["B@1"]); // a lanes.json lane (no repo key)
  const e1 = ln("A@1", { branch: "a", launched_at: at(1) }), e2 = ln("A@2", { branch: "a", launched_at: at(2) }), e3 = ln("C@1", { repo: "c:/other", branch: "a" });
  assert.deepEqual(G.openLanes([e1, e2, e3], new Set(), "c:/r").map((e) => e.id), ["A@2"]);
  assert.deepEqual(G.openLanes([e1, e2], new Set(["A@2"]), "c:/r").map((e) => e.id), ["A@1"]);
});

test("scope and inbox helpers", () => {
  assert.equal(G.scopeOf("intro\n# Batch A: lane hygiene\n## x"), "Batch A: lane hygiene");
  assert.equal(G.scopeOf(`# ${"x".repeat(100)}`).length, 80);
  assert.equal(G.scopeOf("no heading"), null);
  const t = G.inboxBlock("2026-10-05T10:00:00.000Z", "B", "fix the parser\n") + G.inboxBlock("2026-10-05T10:01:00.000Z", "user", "and the docs");
  assert.equal(G.inboxItems(t), 2);
  assert.equal(G.inboxItems("## not an item\n"), 0);
  assert.equal(G.INBOX_SENTENCE("C:/r/x.md"), " Read your inbox first: C:/r/x.md - items other lanes queued for you.");
});
