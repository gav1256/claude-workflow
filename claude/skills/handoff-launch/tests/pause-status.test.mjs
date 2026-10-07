// Batch B, Part 4 "Status": `paused (<reason>, since HH:MM)` per lane and the pace header in status and sessions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, sessionLine, appendLine, setAgents } from "./helpers.mjs";

const MIN = 60000, at = new Date(Date.now() - 20 * MIN).toISOString(), hhmm = new Date(at).toTimeString().slice(0, 5);
const pace = (sb, updated = Date.now()) => { fs.mkdirSync(sb.coord, { recursive: true }); fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated,
  claude: { state: "slow", pct: 42, week_pct: 31, ahead: 11, week_ahead: 0, since: 1 }, codex: { state: "ok", pct: null, week_pct: 12, ahead: null, week_ahead: -30, since: 1 } })); };

test("status: a lane closed by a pause shows `paused (<reason>, since HH:MM)`; a relaunched one does not", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", group: "g1", branch: "a", sid: "a-s1", supersedes: null });
    appendLine(sb, { paused: a.id, name: "A", group: "g1", at, reason: "pace hold (5h +22 / week +1)", source: "pace", windows: ["five_hour"] });
    appendLine(sb, { closed: "A", id: a.id, at, why: "paused" });
    let r = sb.run("status", "--group", "g1");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^A .*\\(window closed\\)  paused \\(pace hold \\(5h \\+22 / week \\+1\\), since ${hhmm}\\)$`, "m"));
    sessionLine(sb, { name: "A", id: "A@2", gen: 2, group: "g1", branch: "a", sid: "a-s2", supersedes: a.id, launched_at: new Date().toISOString() });
    r = sb.run("status", "--group", "g1");
    assert.doesNotMatch(r.out, /paused \(/);
  } finally { sb.cleanup(); }
});

test("sessions: an open paused lane shows the note; status and sessions print the pace header from a fresh pace.json only", () => {
  const sb = sandbox();
  try {
    const b = sessionLine(sb, { name: "B", id: "B@1", group: "g1", branch: "b", sid: "b-s1", mode: "bg", bg_id: "bg-B", supersedes: null });
    setAgents(sb, [{ id: "bg-B", sessionId: "b-s1", name: "B", status: "idle" }]);
    appendLine(sb, { paused: b.id, name: "B", group: "g1", at, reason: "manual pause", source: "manual", windows: [] });
    let r = sb.run("sessions");
    assert.match(r.out, new RegExp(`^B  .*  paused \\(manual pause, since ${hhmm}\\)$`, "m"));
    assert.doesNotMatch(r.out, /^pace:/m);
    const before = sb.run("status", "--group", "g1").out;
    pace(sb);
    r = sb.run("sessions");
    assert.equal(r.out.split("\n")[0], "pace: claude 5h 42% wk 31% slow · codex wk 12% ok");
    assert.equal(sb.run("status", "--group", "g1").out, `pace: claude 5h 42% wk 31% slow · codex wk 12% ok\n${before}`);
    pace(sb, Date.now() - 16 * MIN); // stale: absent
    assert.equal(sb.run("status", "--group", "g1").out, before);
  } finally { sb.cleanup(); }
});

test("status and sessions: a lane that worked after its {paused} line + 1 min is not shown as paused (the resume --paused rule)", () => {
  const sb = sandbox();
  try {
    const mk = (name, sid) => { const e = sessionLine(sb, { name, id: `${name}@1`, group: "g1", branch: name.toLowerCase(), sid, mode: "bg", bg_id: `bg-${name}`, supersedes: null });
      appendLine(sb, { paused: e.id, name, group: "g1", at, reason: "manual pause", source: "manual", windows: [] }); return e; };
    mk("Busy", "busy-s1"); mk("Idle", "idle-s1");
    setAgents(sb, [{ id: "bg-Busy", sessionId: "busy-s1", name: "Busy", status: "idle" }, { id: "bg-Idle", sessionId: "idle-s1", name: "Idle", status: "idle" }]);
    const dir = path.join(sb.tmp, "projects", "proj"); fs.mkdirSync(dir, { recursive: true });
    for (const [sid, t] of [["busy-s1", Date.now() - 5 * MIN], ["idle-s1", Date.now() - 30 * MIN]]) { const f = path.join(dir, `${sid}.jsonl`); fs.writeFileSync(f, "{}\n"); fs.utimesSync(f, t / 1000, t / 1000); }
    for (const r of [sb.run("sessions"), sb.run("status", "--group", "g1")]) {
      assert.match(r.out, /^Idle .*paused \(manual pause, since/m);
      assert.match(r.out, /^Busy /m); assert.doesNotMatch(r.out, /^Busy .*paused \(/m);
    }
  } finally { sb.cleanup(); }
});
