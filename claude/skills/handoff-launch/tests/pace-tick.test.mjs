// Batch B, Part 2 in the tick: pace.json at every unrestricted tick, and the hourly prune of usage/, pace-seen/ and pane/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun } from "./helpers.mjs";
import { workingMinutes } from "../pace-lib.mjs";

test("the weekly line's seam: workingMinutes is plain minutes with no off-time, and leaves out the off intervals given", () => {
  assert.deepEqual([workingMinutes(0, 10 * MIN), workingMinutes(0, 10 * MIN, [{ start: 2 * MIN, end: 5 * MIN }, { start: 9 * MIN, end: 20 * MIN }]), workingMinutes(5, 5)], [10, 6, 0]);
});

const MIN = 60000, DAY = 24 * 60 * MIN, S = (ms) => Math.round(ms / 1000);
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const fwd = (p) => p.split(path.sep).join("/");
const put = (f, o, mtimeMs) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); if (mtimeMs) fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs)); return f; };

test("the tick rewrites pace.json from the usage files and says a state change once; a dry run writes nothing", () => {
  const sb = sandbox();
  try {
    const now = Date.now(), u = path.join(sb.coord, "usage", "s-1.json");
    put(u, { ts: now - MIN, provider: "claude", pct: 60, resets_at: S(now + 150 * MIN), week_pct: 31, week_resets_at: S(now + 5040 * MIN) });
    const dry = tick(sb, "--dry-run");
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /^would set pace: claude ok -> slow \(5h \+13 \/ week -23\)$/m);
    assert.equal(fs.existsSync(path.join(sb.coord, "pace.json")), false);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pace: claude ok -> slow \(5h \+13 \/ week -23\)$/m);
    const p = JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8"));
    assert.equal(p.claude.state, "slow");
    r = tick(sb);
    assert.doesNotMatch(r.out, /^pace:/m); // unchanged: nothing said
    assert.ok(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8")).updated >= p.updated);
  } finally { sb.cleanup(); }
});

test("the tick without usage files writes {updated} and prints nothing about pace", () => {
  const sb = sandbox();
  try {
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /^(would set )?pace:/m);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8"))), ["updated"]);
  } finally { sb.cleanup(); }
});

test("hourly prune: Claude readings and pace-seen markers older than 8 days, pane files older than 1 day; Codex readings never", () => {
  const sb = sandbox();
  try {
    const now = Date.now(), c = (...p) => path.join(sb.coord, ...p);
    const oldReading = put(c("usage", "old-1.json"), { ts: now - 9 * DAY, pct: 1, resets_at: 1, week_pct: 1, week_resets_at: 1 });
    const newReading = put(c("usage", "new-1.json"), { ts: now - 7 * DAY, pct: 1, resets_at: 1, week_pct: 1, week_resets_at: 1 });
    const codex = put(c("usage", "codex-r1.json"), { ts: now - 30 * DAY, provider: "codex", pct: null, resets_at: null, week_pct: 1, week_resets_at: 1 });
    const oldSeen = put(c("pace-seen", "old-1"), "1", now - 9 * DAY), newSeen = put(c("pace-seen", "new-1"), "1", now - 7 * DAY);
    const oldPane = put(c("pane", "old-1.json"), {}, now - 25 * 3600e3), newPane = put(c("pane", "new-1.json"), {}, now - 23 * 3600e3);
    const otherPane = put(c("pane", "notes.txt"), "x", now - 30 * DAY);
    const goals = (...p) => path.join(sb.cfg, "goals", ...p); // goal-gate's once-markers: 14 days
    const oldNudge = put(goals(".nudged-old1"), "x", now - 15 * DAY), newNudge = put(goals(".nudged-new1"), "x", now - 13 * DAY), goalFile = put(goals("old1.md"), "x", now - 30 * DAY);
    const dry = tick(sb, "--dry-run");
    assert.deepEqual(dry.out.split("\n").filter((l) => l.startsWith("would prune ")).sort(), [oldReading, oldSeen, oldPane, oldNudge].map((f) => `would prune ${fwd(f)}`).sort());
    const r = tick(sb);
    assert.match(r.out, /^prune: removed 4 old usage reading\(s\), pace-seen marker\(s\), pane file\(s\) and nudge marker\(s\)$/m);
    for (const f of [oldReading, oldSeen, oldPane, oldNudge]) assert.equal(fs.existsSync(f), false, f);
    for (const f of [newReading, codex, newSeen, newPane, otherPane, newNudge, goalFile]) assert.equal(fs.existsSync(f), true, f);
  } finally { sb.cleanup(); }
});

test("hourly prune: a corrupt usage file and one dated more than 1 h ahead go too; a reading 30 min ahead and a corrupt Codex file stay", () => {
  const sb = sandbox();
  try {
    const now = Date.now(), c = (...p) => path.join(sb.coord, ...p), r1 = { pct: 1, resets_at: 1, week_pct: 1, week_resets_at: 1 };
    const corrupt = put(c("usage", "bad-1.json"), "{not json"), future = put(c("usage", "future-1.json"), { ts: now + 2 * 3600e3, ...r1 });
    const near = put(c("usage", "near-1.json"), { ts: now + 30 * 60000, ...r1 }), codexBad = put(c("usage", "codex-bad.json"), "{not json");
    const dry = tick(sb, "--dry-run");
    assert.deepEqual(dry.out.split("\n").filter((l) => l.startsWith("would prune ")).sort(), [corrupt, future].map((f) => `would prune ${fwd(f)}`).sort());
    tick(sb);
    for (const f of [corrupt, future]) assert.equal(fs.existsSync(f), false, f);
    for (const f of [near, codexBad]) assert.equal(fs.existsSync(f), true, f);
  } finally { sb.cleanup(); }
});
