// B2 release fix round: a legacy {paused} line (written by hand before B2: no `source`, matched by NAME) keeps only its
// stage-2 meaning, the loop-check exemption (pause-lib pausedLineOf { legacy: true }); no B2 path (pause close, resume, the
// watcher, status) counts it. Also: the loop exemption ends when the lane worked after its line; the status gone line shows
// the paused note; the usage prune never treats a read error as corrupt.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun, sessionLine, appendLine, writeTranscript, setAgents, tx, emptyHost } from "./helpers.mjs";

const MIN = 60000, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const SID = "aaaaaaaa-0000-0000-0000-000000000001";
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const manual = (sb) => { fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true }); fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "test", at: ago(5) })); };
const legacyLine = (name, min) => ({ paused: name, at: ago(min) }); // as written by hand: no id, no source
const b2Line = (e, min) => ({ paused: e.id, name: e.name, group: null, at: ago(min), reason: "manual pause", source: "manual", windows: [] });
// A window lane with no host: gone, never closed (a reboot while paused).
const goneLane = (sb, name) => sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, supersedes: null });

test("M1a: a gone, unclosed lane with a legacy {paused} line is not waiting for a resume (no `would relaunch`); a B2 line is (control)", () => {
  const sb = sandbox();
  try {
    const old = goneLane(sb, "A");
    appendLine(sb, legacyLine("A", 30));
    assert.doesNotMatch(tick(sb, "--dry-run").out, /would relaunch/);
    const sb2 = sandbox();
    try {
      const e = goneLane(sb2, "A");
      appendLine(sb2, b2Line(e, 30));
      assert.match(tick(sb2, "--dry-run").out, /^would relaunch A after its pause \(manual pause\)$/m);
    } finally { sb2.cleanup(); }
    assert.ok(old);
  } finally { sb.cleanup(); }
});

test("M1b: an open idle lane with a legacy {paused} line under an active pause is not closed; with a B2 line it is (control)", () => {
  const run = (line) => {
    const sb = sandbox();
    try {
      manual(sb);
      const e = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", mode: "bg", bg_id: "bg-A", supersedes: null });
      writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 20 * MIN, step: 1000 }).user("go").say("saved").turnDone().entries());
      setAgents(sb, [{ id: "bg-A", sessionId: "A-s1", name: "A", status: "idle" }]);
      appendLine(sb, line(e));
      const r = tick(sb);
      return { out: r.out, kills: sb.registry().filter((o) => o.kill_intent === e.id).length };
    } finally { sb.cleanup(); }
  };
  const legacy = run(() => legacyLine("A", 5));
  assert.doesNotMatch(legacy.out, /closed A /); assert.equal(legacy.kills, 0);
  const b2 = run((e) => b2Line(e, 5));
  assert.match(b2.out, /^closed A \(gen 1\): paused \(manual pause\)$/m); assert.equal(b2.kills, 1);
});

test("M1c: a window whose claude exited, with a legacy {paused} line: its {closed} line carries no pause: true (a B2 line does: control)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox(), hosts = [emptyHost(), emptyHost()];
  try {
    const old = Date.now() - 60 * MIN, idleTx = (start) => tx({ start }).user("go").call("Bash", { command: "x" }).say("handed off").turnDone().entries();
    const a = sessionLine(sb, { name: "E", id: "E@1", branch: "e", sid: "E-s1", host: hosts[0], supersedes: null });
    const b = sessionLine(sb, { name: "F", id: "F@1", branch: "f", sid: "F-s1", host: hosts[1], supersedes: null });
    for (const x of [a, b]) { const f = writeTranscript(sb, sb.repo, x.session_id, idleTx(old)); fs.utimesSync(f, new Date(old), new Date(old)); }
    appendLine(sb, legacyLine("E", 50)); appendLine(sb, b2Line(b, 50));
    const r = sb.run("watchdog", "--repo", sb.repo, "--stop-looping");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed E \(gen 1\): claude exited$/m);
    const closes = sb.registry().filter((o) => o.closed);
    assert.equal(closes.find((o) => o.id === "E@1").pause, undefined);
    assert.equal(closes.find((o) => o.id === "F@1").pause, true);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("M1d: the watcher is not needed for a legacy {paused} line (tick and watch --once); a B2 line needs it (control)", () => {
  const sb = sandbox(), sb2 = sandbox();
  try {
    goneLane(sb, "A"); appendLine(sb, legacyLine("A", 30));
    assert.doesNotMatch(tick(sb, "--dry-run").out, /would start the watcher/);
    assert.equal(coordRun(sb, ["watch", "--once"]).out, "watch: stopped - nothing is paused or waiting to resume\n");
    const e = goneLane(sb2, "A"); appendLine(sb2, b2Line(e, 30));
    assert.match(tick(sb2, "--dry-run").out, /^would start the watcher \(lanes wait for their pause resume\)$/m);
  } finally { sb.cleanup(); sb2.cleanup(); }
});

// A running background session (listed by claude agents) whose transcript repeats one call 5 times, 10 min ago.
function loopingLane(sb) {
  const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
  setAgents(sb, [{ id: e.bg_id, sessionId: e.session_id, name: e.name, status: "running" }]);
  let t = tx({ start: Date.now() - 10 * MIN }).user("go");
  for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
  writeTranscript(sb, sb.repo, e.session_id, t.entries());
  return e;
}

test("M1e + M4: a legacy {paused} line still exempts a looping lane from the loop check, until the lane worked after it (then it is flagged again)", () => {
  const exempt = sandbox(), worked = sandbox();
  try {
    loopingLane(exempt);
    appendLine(exempt, legacyLine("A", 5)); // the lane's last record (10 min ago) is before its line: it did not work after it
    const r = tick(exempt);
    assert.doesNotMatch(r.out, /LOOPING A|report-only A|stop requested/);
    assert.equal(exempt.registry().filter((o) => o.stop_requested || o.incident).length, 0);
    loopingLane(worked);
    appendLine(worked, legacyLine("A", 30)); // the loop is 20 min after its line: resumed by hand
    assert.match(tick(worked).out, /^LOOPING A \(gen 1\): same call x5 .* - stop requested: loop: /m);
  } finally { exempt.cleanup(); worked.cleanup(); }
});

test("M5: `sessions` shows the paused note on a `<name> gone (not closed)` line like on an open lane", () => {
  const sb = sandbox();
  try {
    const e = goneLane(sb, "A");
    appendLine(sb, b2Line(e, 20));
    const hhmm = new Date(Date.now() - 20 * MIN).toTimeString().slice(0, 5);
    const r = sb.run("sessions");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^A gone \\(not closed\\)  paused \\(manual pause, since ${hhmm}\\)$`, "m"));
    const sb2 = sandbox();
    try {
      goneLane(sb2, "B");
      assert.match(sb2.run("sessions").out, /^B gone \(not closed\)$/m);
    } finally { sb2.cleanup(); }
  } finally { sb.cleanup(); }
});

test("M6: the usage prune counts a file corrupt on a JSON parse error or a non-object value, never on a read error", () => {
  const sb = sandbox();
  try {
    const u = (n) => path.join(sb.coord, "usage", n);
    fs.mkdirSync(u("."), { recursive: true });
    fs.writeFileSync(u("bad-1.json"), "{not json"); fs.writeFileSync(u("num-1.json"), "42"); fs.writeFileSync(u("null-1.json"), "null");
    fs.mkdirSync(u("dir-1.json")); // reading it fails (EISDIR / EPERM): a read error, not a corrupt file
    const r = tick(sb, "--dry-run");
    const pruned = r.out.split("\n").filter((l) => l.startsWith("would prune ")).map((l) => path.basename(l));
    assert.deepEqual(pruned.sort(), ["bad-1.json", "null-1.json", "num-1.json"]);
  } finally { sb.cleanup(); }
});
