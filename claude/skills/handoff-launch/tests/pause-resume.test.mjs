// Batch B, Part 4: `launch.mjs resume --paused` (the relaunch of lanes a pause closed) and the --resume-note prompt line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun, sessionLine, appendLine, setAgents } from "./helpers.mjs";
import { freshLaunchArgs, PAUSE_RESUME_LINE, CAP_REFUSED } from "../recover-lib.mjs";
import { selfStart } from "../live.mjs";

const MIN = 60000, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const launches = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name);
// A window lane the pause closed: {paused} then {closed} (or, closed: false, a window that is gone: no pid recorded).
function pausedLane(sb, name, { group = null, closed = true, effort = "high", reason = "manual pause", source = "manual", at = ago(20) } = {}) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, group, effort, supersedes: null });
  appendLine(sb, { paused: e.id, name, group, at, reason, source, windows: [] });
  if (closed) appendLine(sb, { closed: name, id: e.id, at: ago(15), why: "paused", pause: true });
  return e;
}

test("resume --paused needs a selector; with none to relaunch it says so", () => {
  const sb = sandbox();
  try {
    let r = sb.run("resume", "--paused");
    assert.equal(r.code, 2); assert.match(r.err, /^resume --paused needs --all/);
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "no paused lanes to relaunch\n");
  } finally { sb.cleanup(); }
});

test("resume --paused waits while the pause applies, then relaunches fresh: high first, a lone lane, the gone one too, replacing the closed entry", () => {
  const sb = sandbox();
  try {
    const a = pausedLane(sb, "A", { group: "g1" }), h = pausedLane(sb, "H", { effort: "xhigh" }), z = pausedLane(sb, "Z", { closed: false });
    coordRun(sb, ["pause"]);
    let r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 1);
    assert.match(r.out, /^not relaunched: H - its pause still applies \(manual pause\)$/m);
    assert.equal(launches(sb, "A").length, 1);
    coordRun(sb, ["resume"]);
    r = sb.run("resume", "--paused", "--all", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.trim().split("\n").map((l) => l.split(" ")[2]), ["H", "A", "Z"]); // high first, then the oldest pause
    assert.equal(launches(sb, "H").length, 1); // a dry run launches nothing
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^relaunched H fresh after its pause \(manual pause\)$/m);
    for (const [e, n] of [[a, "A"], [h, "H"], [z, "Z"]]) {
      const l = launches(sb, n);
      assert.equal(l.length, 2, n);
      assert.equal(l[1].supersedes, e.id, n);
      assert.equal(l[1].group ?? null, e.group ?? null, n);
    }
    assert.equal(launches(sb, "H")[1].priority, "high");
    for (const n of ["A", "H", "Z"]) { const pf = launches(sb, n)[1].prompt_file; if (pf) assert.doesNotMatch(fs.readFileSync(pf, "utf8"), /RESUMED/, n); } // the note is never in prompt_file
    r = sb.run("resume", "--paused", "--all"); // their newest entries are the new ones: nothing left
    assert.equal(r.out, "no paused lanes to relaunch\n");
  } finally { sb.cleanup(); }
});

test("resume --paused --id relaunches that lane only; pace hold keeps normal lanes but lets a high one go", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "N", { source: "pace", reason: "pace hold (x)" });
    const h = pausedLane(sb, "H", { effort: "xhigh", source: "pace", reason: "pace hold (x)" });
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated: Date.now(), claude: { state: "hold", ahead: 21, week_ahead: 0, since: 1, windows: { five_hour: { state: "hold" }, weekly: { state: "ok" } } } }));
    let r = sb.run("resume", "--paused", "--id", "N@1");
    assert.match(r.out, /^not relaunched: N - its pause still applies \(pace hold/m);
    r = sb.run("resume", "--paused", "--id", h.id);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "relaunched H fresh after its pause (pace hold (x))\n");
    assert.equal(launches(sb, "N").length, 1);
  } finally { sb.cleanup(); }
});

test("resume --paused by hand never races the tick: refused while a tick holds tick.lock; a lane with a launch in flight is left out", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "A");
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "tick.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: selfStart(), at: new Date().toISOString() })); // a live node holder: this test runner
    let r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 1);
    assert.match(r.out, /^not relaunched: a coordinator tick runs \(it relaunches paused lanes itself\) - retry in a minute$/m);
    assert.equal(launches(sb, "A").length, 1);
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid); // the tick's lock is left alone
    fs.rmSync(lock);
    appendLine(sb, { starting: null, name: "A", pid_file: null, at: new Date().toISOString() }); // a launch of A in flight
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "no paused lanes to relaunch\n");
    assert.equal(fs.existsSync(lock), false); // its own lock released
    assert.equal(sb.run("resume", "--paused", "--all", "--dry-run").code, 0); // a dry run takes no lock
  } finally { sb.cleanup(); }
});

test("resume --paused: a session-cap refusal stops the run with exit 3 and the cap's line", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "A"); pausedLane(sb, "B");
    sessionLine(sb, { name: "R", id: "R@1", branch: "r", sid: "r-s1", mode: "bg", bg_id: "bg-R", supersedes: null });
    setAgents(sb, [{ id: "bg-R", sessionId: "r-s1", name: "R", status: "running" }]);
    fs.writeFileSync(path.join(sb.reg, "launch-config.json"), JSON.stringify({ max_sessions: 1 }));
    const r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 3);
    assert.match(r.out, /^not relaunched: A - session cap \(1 sessions running, max_sessions 1\); the rest wait too$/m);
    assert.ok(r.err.split("\n").some((l) => l.startsWith(CAP_REFUSED)));
    assert.equal(launches(sb, "B").length, 1);
  } finally { sb.cleanup(); }
});

test("--resume-note puts PAUSE_RESUME_LINE first in the prompt, never in prompt_file; freshLaunchArgs passes it without --recovery", () => {
  const sb = sandbox();
  try {
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "W", "--model", "opus", "--effort", "high", "--resume-note", "pace hold (5h +21)", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(r.out).prompt.startsWith(`${PAUSE_RESUME_LINE("pace hold (5h +21)")} Continue from the handoff`));
    const e = { worktree: "C:/r", repo: "c:/r", handoff: "C:/h.md", name: "A", group: null, branch: "a", mode: "window", session_id: "s1" };
    const a = freshLaunchArgs(e, { model: "opus", effort: "high", resumeNote: "manual pause", priority: "normal", supersedes: "A@1" });
    assert.ok(!a.includes("--recovery"));
    assert.deepEqual(a.slice(a.indexOf("--resume-note"), a.indexOf("--resume-note") + 2), ["--resume-note", "manual pause"]);
    assert.doesNotMatch(PAUSE_RESUME_LINE('a "b"; c battery 15%'), /[";%]/);
  } finally { sb.cleanup(); }
});

// A transcript for a lane's session with the given last-write time (the tick's activity source: its mtime).
function transcript(sb, sid, mtime) {
  const dir = path.join(sb.tmp, "projects", "proj"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`); fs.writeFileSync(f, "{}\n"); fs.utimesSync(f, mtime / 1000, mtime / 1000);
}

test("resume --paused leaves out a lane that worked after its {paused} line + 1 min; one idle (or within the minute) is relaunched", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "Busy", { at: ago(20) }); pausedLane(sb, "Idle", { at: ago(20) }); pausedLane(sb, "Slack", { at: ago(20) });
    transcript(sb, "Busy-s1", Date.now() - 5 * MIN); // 15 min after its line: resumed by hand
    transcript(sb, "Idle-s1", Date.now() - 19.5 * MIN - 0); // before the line + 1 min? line at -20, so -19.5 is within the minute
    transcript(sb, "Slack-s1", Date.now() - 30 * MIN); // before the line
    const r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^relaunched Idle fresh/m); assert.match(r.out, /^relaunched Slack fresh/m);
    assert.doesNotMatch(r.out, /Busy/);
    assert.equal(launches(sb, "Busy").length, 1);
    assert.equal(launches(sb, "Idle").length, 2); assert.equal(launches(sb, "Slack").length, 2);
  } finally { sb.cleanup(); }
});

test("resume --paused --id/--lane of a lane that worked after its pause says so and leaves it (exit code unchanged)", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "Busy", { at: ago(20) });
    transcript(sb, "Busy-s1", Date.now() - 5 * MIN);
    for (const sel of [["--id", "Busy@1"], ["--lane", "Busy"]]) {
      const r = sb.run("resume", "--paused", ...sel);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /^not relaunched: Busy - it worked after its pause \(resumed by hand\)$/m);
    }
    assert.equal(launches(sb, "Busy").length, 1);
    assert.equal(sb.run("resume", "--paused", "--all").out, "no paused lanes to relaunch\n"); // --all stays quiet
  } finally { sb.cleanup(); }
});
