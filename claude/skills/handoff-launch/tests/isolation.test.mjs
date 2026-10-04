// End-to-end isolation tests for the coordinator tick (spec "Isolation guarantees", "Merge sessions", "Testing"):
// the tick touches only the looping lane; a merge session at its restart cap keeps merge.lock; a --repo tick closes
// only that repo's superseded windows.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane, commitIn, writeDone, sessionLine, appendLine, writeTranscript, setAgents, coordRun, tx, host, alive } from "./helpers.mjs";
import { RESUME_WORKS } from "../recover-lib.mjs";

const MIN = 60000;
const loopT = (cmd) => { let t = tx({ start: Date.now() - 10 * MIN }).user("go"); for (let i = 0; i < 5; i++) t = t.call("Bash", { command: cmd }); return t.entries(); };

test("isolation: the tick kills and restarts only the looping lane; the other lane is byte- and pid-identical", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hA = host(), hB = host();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const wa = launchLane(sb, "g1", "A"), wb = launchLane(sb, "g1", "B");
    commitIn(sb, wb, { "b.txt": "B work\n" }, "B work");
    fs.writeFileSync(path.join(wb, "scratch.txt"), "uncommitted\n");
    // A lane's launch line (a {starting} line with the same name precedes it).
    const first = (n) => sb.registry().find((o) => o.name === n && o.launched_at);
    const lane = (n, wt, h) => sessionLine(sb, { name: n, id: `${n}@live`, group: "g1", branch: `lane-${n}`, worktree: wt, gen: 2, sid: `sid-${n}`, host: h,
      done_marker: first(n).done_marker, prompt_file: first(n).prompt_file, profile: first(n).profile });
    lane("A", wa, hA); lane("B", wb, hB);
    writeTranscript(sb, wa, "sid-A", loopT("poll"));
    const tB = writeTranscript(sb, wb, "sid-B", tx({ start: Date.now() - 10 * MIN }).user("go").call("Read", { file_path: "b.txt" }).call("Edit", { file_path: "b.txt" }).call("Bash", { command: "npm test" }).entries());
    // Every registry line about B: its {starting} and launch lines, and any line naming B, one of its ids or its session
    // id anywhere in the line (nested values included). The bare name counts only as a whole JSON string: the letter B
    // can sit in any path.
    const bIds = ["sid-B", ...sb.registry().filter((o) => o.name === "B" && o.launched_at).map((o) => o.id)];
    assert.equal(bIds.length, 3); // B's session id, its own launch and its live generation
    const aboutBLine = (o) => { const s = JSON.stringify(o); return s.includes('"B"') || bIds.some((id) => s.includes(id)); };
    // B's hook state, seeded with real content: a hook writes only its own session's state, and the tick never rewrites it.
    const hookB = path.join(sb.coord, "sessions", "sid-B.json");
    fs.mkdirSync(path.dirname(hookB), { recursive: true });
    fs.writeFileSync(hookB, JSON.stringify({ streaks: { main: { hash: "0123456789", call: 'Bash {"command":"npm test"}', n: 1 } },
      warned: {}, agent_notices: {}, parent_notices: {}, delivered: {}, waits: [] }));
    const readOrNull = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
    const listB = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith("B-")) : []);
    // A grouped lane's incidents go beside its done marker (recover.mjs incidentPath); the CFG folder is the fallback.
    const { done_marker: doneB, prompt_file: promptB } = first("B");
    assert.ok(doneB && promptB && fs.existsSync(promptB));
    const snap = () => ({
      lines: sb.registry().filter(aboutBLine).map((o) => JSON.stringify(o)),
      head: sb.git(wb, "rev-parse", "HEAD"), status: sb.git(wb, "status", "--porcelain"),
      files: fs.readdirSync(wb).filter((f) => f !== ".git").sort().map((f) => [f, fs.statSync(path.join(wb, f)).isFile() ? fs.readFileSync(path.join(wb, f), "utf8") : "dir"]),
      transcript: fs.readFileSync(tB, "utf8"),
      stops: listB(path.join(sb.reg, "stops")),
      incidents: listB(path.join(sb.coord, "incidents")),
      laneIncidents: listB(path.join(path.dirname(doneB), "incidents")),
      done: readOrNull(doneB), prompt: readOrNull(promptB), // the tick never writes done markers or another lane's files
      hook: readOrNull(hookB),
    });
    const before = snap();
    assert.equal(before.lines.length, 3); // B's {starting} line, its launch line and its live generation
    let r = coordRun(sb, ["tick"]);
    assert.match(r.out, /^LOOPING A \(gen 2\): .* - stop requested/m);
    const aboutB = / B[ :@(]|sid-B|lane-B/;
    assert.doesNotMatch(r.out, aboutB);
    const stop = JSON.parse(fs.readFileSync(path.join(sb.reg, "stops", "A-live.ladder.stop.json"), "utf8"));
    appendLine(sb, { stop_delivered: "A@live", token: stop.token, at: new Date(Date.now() - 6 * MIN).toISOString() });
    r = coordRun(sb, ["tick"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^killed A: closed$/m);
    assert.doesNotMatch(r.out, aboutB);
    assert.match(r.out, new RegExp(`^restarted A: ${RESUME_WORKS ? "resume" : "fresh"} \\(opus/high\\)$`, "m"));
    assert.equal(alive(hA.pid), false);
    assert.equal(alive(hB.pid), true); // same pid, still running
    assert.deepEqual(snap(), before);
    assert.equal((JSON.parse(fs.readFileSync(path.join(sb.coord, "looping.json"), "utf8")))["sid-B"], undefined);
    const again = sb.registry().filter((o) => o.name === "A" && o.launched_at).at(-1);
    assert.equal(again.worktree, first("A").worktree); // A's own worktree only
    if (RESUME_WORKS) { assert.equal(again.session_id, "sid-A"); assert.equal(again.resumed_from, "A@live"); }
  } finally { hA.kill(); hB.kill(); sb.cleanup(); }
});

test("a looping merge session at its cap: blocked, merge.lock untouched, the alert names abort-then-force", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C");
    writeDone(sb, "g1", "B", commitIn(sb, b, { "shared.txt": "line1\nB\nline3\n" }, "B edits line2"));
    assert.match(sb.run("merge", "--group", "g1", "--repo", sb.repo).out, /merged B/);
    writeDone(sb, "g1", "C", commitIn(sb, c, { "shared.txt": "line1\nC\nline3\n" }, "C edits line2"));
    assert.match(sb.run("merge", "--group", "g1", "--repo", sb.repo).out, /CONFLICT C/);
    const lockFile = path.join(sb.repo, ".superpowers", "sessions", "g1", "merge.lock"), lockBefore = fs.readFileSync(lockFile, "utf8");
    const m = sb.registry().filter((o) => o.name === "g1-merge-C" && o.launched_at).at(-1);
    const live = sessionLine(sb, { name: "g1-merge-C", id: "g1-merge-C@live", group: "g1", branch: "int-g1", worktree: m.worktree, gen: m.generation + 1,
      sid: "sid-M", mode: "bg", bg_id: "bg-M", handoff: m.handoff, done_marker: m.done_marker });
    setAgents(sb, [{ id: "bg-M", sessionId: "sid-M", name: "g1-merge-C", status: "running" }]);
    for (let i = 0; i < 2; i++) appendLine(sb, { restart: "g1-merge-C", n: i + 1, kind: "fresh", from: `g1-merge-C@${i}`, handoff: m.handoff, at: new Date().toISOString() });
    writeTranscript(sb, m.worktree, "sid-M", loopT("git status"));
    coordRun(sb, ["tick"]);
    const stop = JSON.parse(fs.readFileSync(path.join(sb.reg, "stops", "g1-merge-C-live.ladder.stop.json"), "utf8"));
    appendLine(sb, { stop_delivered: live.id, token: stop.token, at: new Date(Date.now() - 6 * MIN).toISOString() });
    const r = coordRun(sb, ["tick"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^BLOCKED g1-merge-C after 2 restart\(s\): incident .*\/incidents\/g1-merge-C-1\.md/m);
    assert.equal(fs.readFileSync(lockFile, "utf8"), lockBefore); // the ladder never touches merge.lock
    assert.ok(sb.registry().some((o) => o.lane_blocked === "g1-merge-C" && o.group === "g1"));
    // The blocked-merge alert, picked by its text among the queued ones (not by file order).
    const d = path.join(sb.coord, "alerts"), texts = fs.readdirSync(d).filter((x) => /^\d/.test(x)).map((x) => JSON.parse(fs.readFileSync(path.join(d, x), "utf8")).text);
    const capAlert = texts.find((t) => t.startsWith("Merge session g1-merge-C looped at its restart cap"));
    assert.ok(capAlert, JSON.stringify(texts));
    assert.match(capAlert, /Next: git merge --abort in \.claude\/worktrees\/_merge-g1, then node .*launch\.mjs merge --group g1 --force \(or --skip C --why \.\.\.\)\./);
    assert.match(sb.run("status", "--group", "g1", "--repo", sb.repo, "--no-merge").out, /STALE: g1-merge-C closed without merging C/);
  } finally { sb.cleanup(); }
});

test("a --repo tick closes only that repo's idle superseded window; an equally closable one of another repo is untouched", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hosts = Array.from({ length: 4 }, () => host());
  try {
    const repoB = path.join(sb.tmp, "repo-b");
    fs.mkdirSync(repoB);
    sb.git(repoB, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repoB, "x.txt"), "x\n");
    sb.git(repoB, "add", "-A"); sb.git(repoB, "commit", "-q", "-m", "init");
    const idleT = tx({ start: Date.now() - 40 * MIN }).user("go").call("Bash", { command: "x" }).say("handed off").turnDone().entries();
    // The same lane shape in each repo: an idle generation 1 window whose generation 2 is running.
    const mk = (repo, name, i, gen, t) => {
      const e = sessionLine(sb, { name, id: `${name}@${gen}`, repo, worktree: repo, branch: "work", gen, sid: `${name}-s${gen}`, host: hosts[i] });
      if (t) writeTranscript(sb, repo, e.session_id, t);
      return e;
    };
    const a1 = mk(sb.repo, "X", 0, 1, idleT); mk(sb.repo, "X", 1, 2, null);
    const b1 = mk(repoB, "Y", 2, 1, idleT); mk(repoB, "Y", 3, 2, null);
    const r = sb.run("watchdog", "--repo", sb.repo, "--stop-looping");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed X \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.doesNotMatch(r.out, /\bY\b/);
    assert.equal(alive(hosts[0].pid), false);
    for (const i of [1, 2, 3]) assert.equal(alive(hosts[i].pid), true, `host ${i}`);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.kill_intent === a1.id && o.kind === "close"));
    assert.ok(lines.some((o) => o.closed && o.id === a1.id));
    assert.equal(lines.filter((o) => o.kill_intent === b1.id || (o.closed && o.id === b1.id)).length, 0);
    // The positive control: B's window was closable all along - an unrestricted tick closes it.
    const all = coordRun(sb, ["tick"]);
    assert.equal(all.code, 0, all.err);
    assert.match(all.out, /^closed Y \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.equal(alive(hosts[2].pid), false);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});
