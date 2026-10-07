import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classify, laneStatus, closedUnfinished } from "../status-lib.mjs";
import { sandbox, launchLane } from "./helpers.mjs";

const STATUS_LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "status-lib.mjs");
const T0 = "2026-10-07T00:00:00.000Z", T1 = "2026-10-07T01:00:00.000Z", T2 = "2026-10-07T02:00:00.000Z";
const e = (name, at, extra = {}) => ({ id: `${name}@${at}`, name, repo: "r", launched_at: at, ...extra });
const base = { lines: [], closedIds: new Set(), gone: () => "gone", doneMarker: false, goal: null };

test("rule 1: a running lane is open", () => {
  assert.deepEqual(classify(e("a", T0), { ...base, gone: () => "running" }), { state: "open", reason: "running" });
});
test("rule 2: liveness unknown is its own state", () => {
  assert.deepEqual(classify(e("a", T0), { ...base, gone: () => "unknown" }), { state: "unknown", reason: "liveness unknown" });
});
test("rule 3: a done marker is finished", () => {
  assert.deepEqual(classify(e("a", T0), { ...base, doneMarker: true }), { state: "finished", reason: "done marker" });
});
test("rule 3: a fully ticked goal is finished", () => {
  const goal = { items: [{}], open: 0, blocked: 0 };
  assert.deepEqual(classify(e("a", T0), { ...base, goal }), { state: "finished", reason: "goal complete" });
});
test("rule 3: a goal with an open or blocked item is not finished", () => {
  assert.equal(classify(e("a", T0), { ...base, goal: { items: [{}], open: 1, blocked: 0 } }).state, "closed_unfinished");
  assert.equal(classify(e("a", T0), { ...base, goal: { items: [{}], open: 0, blocked: 1 } }).state, "closed_unfinished");
});
test("rule 4: the real pause close sequence is paused", () => {
  const x = e("a", T0);
  const lines = [{ kill_intent: x.id, kind: "close", why: "paused (usage)" },
    { closed: "a", id: x.id, why: "paused (usage)", pause: true, at: T1 }];
  assert.equal(classify(x, { ...base, lines, closedIds: new Set([x.id]) }).state, "paused");
  const lifted = [{ kill_intent: x.id, kind: "close", why: "paused, and its pause lifted: closed to relaunch" },
    { closed: "a", id: x.id, why: "paused, and its pause lifted: closed to relaunch", pause: true, at: T1 }];
  assert.equal(classify(x, { ...base, lines: lifted, closedIds: new Set([x.id]) }).state, "paused");
});
test("rule 4 before rule 5: a window that exited while its lane was paused is paused, not closed_unfinished", () => {
  const x = e("a", T0);
  const lines = [{ kill_intent: x.id, kind: "close", why: "claude exited", at: T1 },
    { closed: "a", id: x.id, why: "claude exited", pause: true, at: T1 }];
  assert.equal(classify(x, { ...base, lines, closedIds: new Set([x.id]) }).state, "paused");
});
test("rule 4: a {paused} line with a source wins over a crash", () => {
  const x = e("a", T0);
  const lines = [{ paused: x.id, source: "pace", reason: "usage", at: T1 }];
  const r = classify(x, { ...base, lines });
  assert.equal(r.state, "paused");
  assert.equal(r.reason, "paused: usage");
});
test("M2: a {paused} line without source (a pre-B2 hand line) does not make a lane paused", () => {
  const x = e("a", T0);
  const lines = [{ paused: x.id, reason: "usage", at: T1 }];
  assert.equal(classify(x, { ...base, lines }).state, "closed_unfinished");
});
test("rule 5: the real tick close sequence (kill_intent + claude exited) is closed_unfinished", () => {
  const x = e("a", T0);
  const lines = [{ kill_intent: x.id, kind: "close", why: "claude exited (already gone: pid)" },
    { closed: "a", id: x.id, why: "claude exited (already gone: pid)", at: T1 }];
  assert.deepEqual(classify(x, { ...base, lines, closedIds: new Set([x.id]) }), { state: "closed_unfinished", reason: "claude exited" });
});
test("rule 5: a {dead_start} line is closed_unfinished (failed to start)", () => {
  const x = e("a", T0);
  const lines = [{ dead_start: x.id, name: "a", group: "g", at: T1 }, { closed: "a", id: x.id, why: "dead start", at: T1 }];
  assert.deepEqual(classify(x, { ...base, lines, closedIds: new Set([x.id]) }), { state: "closed_unfinished", reason: "failed to start" });
});
test("a kill_intent alone never means finished (the close was never recorded)", () => {
  const x = e("a", T0);
  const lines = [{ kill_intent: x.id, name: "a", kind: "close", why: "idle", at: T1 }];
  assert.deepEqual(classify(x, { ...base, lines }), { state: "closed_unfinished", reason: "crashed or window closed" });
});
test("a ladder-killed lane that was never relaunched is closed_unfinished, not finished", () => {
  const x = e("a", T0, { group: "g" });
  const why = "loop ladder: still looping after the grace period (already gone: closed in the registry)";
  const lines = [{ kill_intent: x.id, name: "a", kind: "ladder", why, at: T1 }, { closed: "a", id: x.id, why, at: T1 }];
  assert.deepEqual(classify(x, { ...base, lines, closedIds: new Set([x.id]) }), { state: "closed_unfinished", reason: "blocked after loop ladder" });
});
test("a {lane_blocked} line after the launch (restart failed) is closed_unfinished", () => {
  const x = e("a", T0, { group: "g" });
  const lines = [{ restart_failed: "a", n: 1, kind: "fresh", from: x.id, handoff: "h.md", why: "x", log: null, at: T1 },
    { lane_blocked: "a", group: "g", handoff: "h.md", incident: "i.md", at: T1 }, { closed: "a", id: x.id, why: "done", at: T1 }];
  assert.deepEqual(classify(x, { ...base, lines, closedIds: new Set([x.id]) }), { state: "closed_unfinished", reason: "blocked after loop ladder" });
});
test("a {lane_blocked} line with group null blocks an entry with group empty string", () => {
  const x = e("a", T0, { group: "" });
  const lines = [{ lane_blocked: "a", group: null, at: T1 }, { closed: "a", id: x.id, why: "idle", at: T1 }];
  assert.equal(classify(x, { ...base, lines, closedIds: new Set([x.id]) }).state, "closed_unfinished");
});
test("a {lane_blocked} line of another group or older than the launch does not block", () => {
  const x = e("a", T1, { group: "g" });
  const lines = [{ lane_blocked: "a", group: "g", at: T0 }, { lane_blocked: "a", group: "other", at: "2026-10-07T02:00:00.000Z" },
    { closed: "a", id: x.id, why: "idle", at: "2026-10-07T02:00:00.000Z" }];
  assert.equal(classify(x, { ...base, lines, closedIds: new Set([x.id]) }).state, "finished");
});
test("a ladder kill of an older launch does not affect the newer (relaunched) lane", () => {
  const old = e("a", T0), neu = e("a", T1);
  const lines = [{ kill_intent: old.id, kind: "ladder", why: "loop", at: T1 }, { closed: "a", id: old.id, why: "loop", at: T1 },
    { closed: "a", id: neu.id, why: "idle", at: T2 }];
  const reg = { lines, closed: new Set([old.id, neu.id]), entries: [old, neu] };
  const rows = laneStatus(reg, { gone: () => "gone", readGoal: () => null, markerExists: () => false });
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [[neu.id, "finished"]]);
});
test("rule 6: gone without a closed line is closed_unfinished (crashed or window closed)", () => {
  assert.deepEqual(classify(e("a", T0), base), { state: "closed_unfinished", reason: "crashed or window closed" });
});
test("rule 7: a deliberate idle close is finished", () => {
  const x = e("a", T0);
  const lines = [{ kill_intent: x.id, kind: "close", why: "idle" }, { closed: "a", id: x.id, why: "idle", at: T1 }];
  assert.deepEqual(classify(x, { ...base, lines, closedIds: new Set([x.id]) }), { state: "finished", reason: "closed: idle" });
});
test("M3: laneStatus keeps only the newest entry per lane", () => {
  const reg = { lines: [], closed: new Set(), entries: [e("a", T0), e("a", T1, { mode: "bg", bg_id: "b1", worktree: "/w" })] };
  const rows = laneStatus(reg, { gone: () => "gone", readGoal: () => null, markerExists: () => false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].launched_at, T1);
  assert.equal(rows[0].mode, "bg");
  assert.equal(rows[0].bg_id, "b1");
  assert.equal(rows[0].worktree, "/w");
  assert.equal(closedUnfinished(rows).length, 1);
});
test("M3: the newest launch wins even when an older launch line comes later in the file", () => {
  const reg = { lines: [], closed: new Set(), entries: [e("a", T1), e("a", T0)] };
  const rows = laneStatus(reg, { gone: () => "gone", readGoal: () => null, markerExists: () => false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].launched_at, T1);
});
test("laneStatus separates lanes by repo, group and name", () => {
  const reg = { lines: [], closed: new Set(), entries: [e("a", T0), e("a", T1, { group: "g2" }), e("b", T0)] };
  const rows = laneStatus(reg, { gone: () => "running", readGoal: () => ({ goal: "G" }), markerExists: () => false });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.state === "open" && r.goal === "G"));
});

test("M4: liveLaneStatus lists a launched lane (HL_NO_SPAWN: gone, crashed or window closed)", async () => {
  const sb = sandbox({});
  try {
    launchLane(sb, "g1", "lane-a");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { liveLaneStatus } from ${JSON.stringify(pathToFileURL(STATUS_LIB).href)}; console.log(JSON.stringify(liveLaneStatus()))`],
      { env: sb.env, encoding: "utf8", timeout: 60000 });
    const rows = JSON.parse(r.stdout);
    const row = rows.find((x) => x.name === "lane-a");
    assert.equal(row.state, "closed_unfinished");
    assert.equal(row.id, sb.registry().find((x) => x.name === "lane-a" && x.launched_at).id);
  } finally { sb.cleanup(); }
});
