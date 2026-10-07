// Task 3: `launch.mjs resume --closed` reopens lanes that closed unfinished (crashed, failed to start, ladder-blocked).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane, appendLine } from "./helpers.mjs";

// A real launch writes its {starting} line a few ms after launched_at, so a lane launched under 5 min ago counts as having a
// launch in flight (the pause-lib guard). Age the launch and starting lines by 10 min: these lanes "crashed" a while ago.
function launch(sb, group, name) {
  launchLane(sb, group, name);
  const f = path.join(sb.reg, "sessions.jsonl"), old = (t) => new Date(Date.parse(t) - 10 * 60000).toISOString();
  const lines = fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const o = JSON.parse(l);
    if (o.launched_at) o.launched_at = old(o.launched_at); else if ("starting" in o) o.at = old(o.at);
    return JSON.stringify(o);
  });
  fs.writeFileSync(f, lines.join("\n") + "\n");
}
const idOf = (sb, name) => sb.registry().find((x) => x.name === name && x.launched_at).id;

test("M1: resume --closed --dry-run lists only unfinished closed lanes", () => {
  const sb = sandbox({});
  try {
    launch(sb, "g1", "crashed-lane");
    launch(sb, "g1", "done-lane");
    launch(sb, "g1", "paused-lane");
    const now = new Date().toISOString();
    appendLine(sb, { kill_intent: idOf(sb, "done-lane"), kind: "close", why: "idle", at: now });
    appendLine(sb, { closed: "done-lane", id: idOf(sb, "done-lane"), why: "idle", at: now });
    appendLine(sb, { kill_intent: idOf(sb, "paused-lane"), kind: "close", why: "usage pause", at: now });
    appendLine(sb, { closed: "paused-lane", id: idOf(sb, "paused-lane"), why: "usage pause", pause: true, at: now });
    const before = sb.registry().length;
    const r = sb.run("resume", "--closed", "--all", "--dry-run");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /would reopen crashed-lane/);
    assert.doesNotMatch(r.out, /done-lane/);
    assert.doesNotMatch(r.out, /paused-lane/);
    assert.equal(sb.registry().length, before, "a dry run writes nothing");
  } finally { sb.cleanup(); }
});

test("M2: resume --closed without a selector exits 2", () => {
  const sb = sandbox({});
  try { const r = sb.run("resume", "--closed"); assert.equal(r.code, 2); assert.match(r.err, /resume --closed needs --all or --id/); }
  finally { sb.cleanup(); }
});

test("M3: resume --closed --id relaunches with supersedes", () => {
  const sb = sandbox({});
  try {
    launch(sb, "g1", "crashed-lane");
    launch(sb, "g1", "other-lane");
    const old = idOf(sb, "crashed-lane");
    const r = sb.run("resume", "--closed", "--id", old);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /reopen crashed-lane \(crashed or window closed\)/);
    assert.doesNotMatch(r.out, /other-lane/);
    assert.ok(sb.registry().some((x) => x.launched_at && x.supersedes === old));
  } finally { sb.cleanup(); }
});

test("M4: a lane with a launch in flight is skipped", () => {
  const sb = sandbox({});
  try {
    launch(sb, "g1", "crashed-lane");
    appendLine(sb, { starting: "x", name: "crashed-lane", group: "g1", at: new Date().toISOString() });
    const before = sb.registry().length;
    for (const extra of [["--dry-run"], []]) {
      const r = sb.run("resume", "--closed", "--all", ...extra);
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(r.out, /skipped crashed-lane \(a launch is in flight\)/);
      assert.doesNotMatch(r.out, /reopen crashed-lane/);
    }
    assert.equal(sb.registry().length, before);
  } finally { sb.cleanup(); }
});

test("M4: a {starting} line older than 5 minutes does not block", () => {
  const sb = sandbox({});
  try {
    launch(sb, "g1", "crashed-lane");
    appendLine(sb, { starting: "x", name: "crashed-lane", group: "g1", at: new Date(Date.now() - 10 * 60000).toISOString() });
    const r = sb.run("resume", "--closed", "--all", "--dry-run");
    assert.match(r.out, /would reopen crashed-lane/);
  } finally { sb.cleanup(); }
});

test("M6: a ladder-killed lane without a lane_blocked line is skipped (restart pending), in dry-run too", () => {
  const sb = sandbox({});
  try {
    launch(sb, "g1", "ladder-lane");
    const id = idOf(sb, "ladder-lane"), now = new Date().toISOString();
    appendLine(sb, { kill_intent: id, name: "ladder-lane", kind: "ladder", why: "loop ladder", at: now });
    appendLine(sb, { closed: "ladder-lane", id, why: "loop ladder (already gone)", at: now });
    const before = sb.registry().length;
    for (const extra of [["--dry-run"], []]) {
      const r = sb.run("resume", "--closed", "--all", ...extra);
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(r.out, /skipped ladder-lane \(loop ladder restart pending\)/);
      assert.doesNotMatch(r.out, /reopen ladder-lane/);
    }
    assert.equal(sb.registry().length, before);
  } finally { sb.cleanup(); }
});

test("M6: a ladder-killed lane with a lane_blocked line (recover gave up) is reopened", () => {
  const sb = sandbox({});
  try {
    launch(sb, "g1", "ladder-lane");
    const id = idOf(sb, "ladder-lane"), now = new Date().toISOString();
    appendLine(sb, { kill_intent: id, name: "ladder-lane", kind: "ladder", why: "loop ladder", at: now });
    appendLine(sb, { closed: "ladder-lane", id, why: "loop ladder (already gone)", at: now });
    appendLine(sb, { lane_blocked: "ladder-lane", group: "g1", handoff: "h.md", incident: "i.md", at: now });
    const r = sb.run("resume", "--closed", "--all", "--dry-run");
    assert.match(r.out, /would reopen ladder-lane \(blocked after loop ladder\)/);
  } finally { sb.cleanup(); }
});
