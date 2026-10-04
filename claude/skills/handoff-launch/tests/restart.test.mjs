import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane, sessionLine, appendLine, setAgents, tx } from "./helpers.mjs";
import { projectKey } from "../live.mjs";

const fwdp = (p) => p.split(path.sep).join("/");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("recover sets the recovery mode: the latest line wins; bad arguments exit 2", () => {
  const sb = sandbox();
  try {
    launchLane(sb, "g1", "A");
    assert.equal(sb.run("recover", "--group", "g1", "--mode", "report").code, 0);
    assert.equal(sb.run("recover", "--group", "g1", "--mode", "auto").out, "set recovery mode of group g1 to auto\n");
    assert.deepEqual(sb.registry().filter((o) => o.recovery_mode).map((o) => [o.recovery_mode, o.mode]), [["g1", "report"], ["g1", "auto"]]);
    assert.equal(sb.run("recover", "--group", "g1").code, 2);
    assert.equal(sb.run("recover", "--group", "g1", "--name", "A", "--mode", "auto").code, 2);
    assert.equal(sb.run("recover", "--group", "nope", "--mode", "auto").code, 2);
    // A lane's mode is its group's (recoveryMode reads the group): --name on a grouped lane is refused.
    const ga = sb.run("recover", "--name", "A", "--mode", "report");
    assert.equal(ga.code, 2); assert.match(ga.err, /^A belongs to group g1 - use --group g1$/m);
    sessionLine(sb, { name: "Solo", branch: "solo" });
    assert.equal(sb.run("recover", "--name", "Solo", "--mode", "report", "--dry-run").out, "would set recovery mode of session Solo to report\n");
    assert.equal(sb.registry().filter((o) => o.recovery_mode).length, 2);
    sessionLine(sb, { name: "Old", group: "g9", coord: undefined, branch: "old" });
    assert.match(sb.run("recover", "--group", "g9", "--mode", "auto").out, /^WARN no session hook in Old \(launched before stage 2\): stop requests cannot reach it/m);
  } finally { sb.cleanup(); }
});

test("--resume relaunches the newest generation with the same session id, a RECOVERY prompt and fresh hook state", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: "s-1", model: "fable", effort: "high", prompt_file: fwdp(path.join(sb.reg, "p.txt")) });
    fs.mkdirSync(path.join(sb.coord, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "sessions", "s-1.json"), JSON.stringify({ warned: { x: 1 } }));
    fs.writeFileSync(path.join(sb.coord, "looping.json"), JSON.stringify({ "s-1": { ag: { key: "k" } }, other: { ag: { key: "k" } } }));
    const inc = path.join(sb.repo, ".superpowers", "sessions", "g", "incidents", "A-1.md");
    const r = sb.run("--resume", "s-1", "--recovery", inc);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.deepEqual(out.claude_args.slice(0, 4), ["--resume", "'s-1'", "-n", "'A'"]);
    assert.ok(out.claude_args.includes("--settings"));
    assert.match(out.prompt, new RegExp(`^RECOVERY: you were stopped for a loop\\. Read ${esc(fwdp(inc))}\\. Find and fix the cause`));
    const n = sb.registry().filter((o) => o.name === "A" && o.launched_at).at(-1);
    assert.equal(n.session_id, "s-1"); assert.equal(n.resumed_from, e.id); assert.equal(n.generation, 2);
    assert.equal(n.model, "fable"); assert.equal(n.coord, 1); assert.equal(n.prompt_file, e.prompt_file);
    assert.equal(fs.existsSync(path.join(sb.coord, "sessions", "s-1.json")), false); // its warnings fire again
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "looping.json"), "utf8"))), ["other"]); // its old subagents' flags go too
    sessionLine(sb, { name: "B", id: "B@1", sid: "s-b1", branch: "b" }); sessionLine(sb, { name: "B", id: "B@2", gen: 2, sid: "s-b2", branch: "b" });
    let x = sb.run("--resume", "s-b1");
    assert.equal(x.code, 3); assert.match(x.err, /has a newer launch \(B@2\) - only the newest generation is resumed/);
    sessionLine(sb, { name: "C", sid: "s-c", mode: "bg", bg_id: "bg-c", branch: "c" });
    x = sb.run("--resume", "s-c");
    assert.equal(x.code, 2); assert.match(x.err, /background lanes restart fresh/);
    assert.equal(sb.run("--resume", "nope").code, 2);
  } finally { sb.cleanup(); }
});

test("a fresh restart: the RECOVERY line, then the original pointer prompt; its GOAL.md is copied; prompt_file keeps the base", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A");
    const first = sb.registry().find((o) => o.name === "A" && o.launched_at);
    const base = fs.readFileSync(first.prompt_file, "utf8");
    // The old session's project folder as Claude Code named it - not what projectKey(path) computes - holds its transcript.
    const key = "Q--claude-chose-this-folder";
    const oldT = path.join(sb.env.HL_PROJECTS_DIR, key, "old-sid.jsonl");
    fs.mkdirSync(path.dirname(oldT), { recursive: true }); fs.writeFileSync(oldT, tx().user("go").entries().map((x) => JSON.stringify(x)).join("\n") + "\n");
    const oldGoal = path.join(sb.temp, "claude", key, "old-sid", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(oldGoal), { recursive: true }); fs.writeFileSync(oldGoal, "- [ ] finish the lane\n");
    const inc = path.join(sb.tmp, "A-1.md");
    const r = sb.run("--repo", wt, "--handoff", sb.handoff, "--name", "A", "--group", "g1", "--worktree", "lane-A", "--model", "opus", "--effort", "xhigh",
      "--no-close", "--recovery", inc, "--goal-from", "old-sid", "--prompt-file", first.prompt_file);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out), n = sb.registry().filter((o) => o.name === "A" && o.launched_at).at(-1);
    assert.equal(out.prompt, `RECOVERY: you were stopped for a loop. Read ${fwdp(inc)}. Find and fix the cause (systematic-debugging), record it in the incident's Cause section and the lane ledger, then continue. ${base}`);
    assert.equal(fs.readFileSync(n.prompt_file, "utf8"), base); // no RECOVERY prefix: prefixes never pile up
    assert.equal(n.effort, "xhigh"); assert.equal(n.generation, 2);
    assert.equal(fs.readFileSync(path.join(sb.temp, "claude", key, n.session_id, "scratchpad", "GOAL.md"), "utf8"), "- [ ] finish the lane\n");
    assert.equal(fs.readFileSync(path.join(sb.cfg, "goals", `${n.session_id}.md`), "utf8"), "- [ ] finish the lane\n"); // goal-gate's fallback
    assert.equal(fs.existsSync(path.join(sb.temp, "claude", projectKey(wt), n.session_id)), false);
    // An unreadable --prompt-file falls back to the computed pointer prompt, and says so on stderr.
    const missing = path.join(sb.tmp, "gone.prompt.txt");
    const w = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "W", "--model", "opus", "--effort", "high", "--prompt-file", missing);
    assert.equal(w.code, 0, w.err);
    assert.match(w.err, new RegExp(`^warning: --prompt-file ${esc(missing)} unreadable \\(ENOENT\\) - using the computed pointer prompt$`, "m"));
    const wp = JSON.parse(w.out).prompt;
    assert.match(wp, /^Continue from the handoff at /);
    assert.equal(fs.readFileSync(sb.registry().filter((o) => o.name === "W" && o.launched_at).at(-1).prompt_file, "utf8"), wp);
  } finally { sb.cleanup(); }
});

test("resume --group relaunches blocked lanes fresh from their last incident and resets their restart budget", () => {
  const sb = sandbox();
  try {
    launchLane(sb, "g1", "A"); launchLane(sb, "g1", "B");
    const a = sb.registry().find((o) => o.name === "A" && o.launched_at);
    appendLine(sb, { lane_blocked: "A", group: "g1", handoff: a.handoff, incident: "C:/inc/A-3.md", at: new Date().toISOString() });
    assert.match(sb.run("resume", "--group", "g1", "--dry-run").out, /^would relaunch A fresh from .* \(incident C:\/inc\/A-3\.md\)$/m);
    const r = sb.run("resume", "--group", "g1");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^relaunched A fresh \(incident C:\/inc\/A-3\.md\); restart budget reset$/m);
    assert.ok(sb.registry().some((o) => o.lane_resumed === "A" && o.group === "g1" && o.handoff === a.handoff));
    assert.equal(sb.registry().filter((o) => o.name === "A" && o.launched_at).length, 2);
    assert.equal(sb.registry().filter((o) => o.name === "B" && o.launched_at).length, 1);
    assert.equal(sb.run("resume", "--group", "g1").out, "no blocked lanes in group g1\n");
    assert.equal(sb.run("resume").code, 2);
  } finally { sb.cleanup(); }
});

test("resume --group refuses a blocked lane whose newest launch is still running", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A"), a = sb.registry().find((o) => o.name === "A" && o.launched_at), now = new Date().toISOString();
    sessionLine(sb, { name: "A", id: "A@live", group: "g1", branch: "lane-A", worktree: wt, gen: 2, sid: "s-live", mode: "bg", bg_id: "bg-live" });
    setAgents(sb, [{ id: "bg-live", sessionId: "s-live", name: "A", status: "running" }]); // the "failed" launch did start
    appendLine(sb, { restart_failed: "A", from: a.id, handoff: a.handoff, why: "the launcher exited 1: x", at: now });
    appendLine(sb, { lane_blocked: "A", group: "g1", handoff: a.handoff, incident: "C:/inc/A-1.md", at: now });
    const before = sb.registry().filter((o) => o.launched_at).length;
    const r = sb.run("resume", "--group", "g1");
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^not relaunched: A@live is running \(bg session bg-live\)/m);
    assert.equal(sb.registry().filter((o) => o.launched_at).length, before);
    assert.equal(sb.registry().filter((o) => o.lane_resumed).length, 0);
  } finally { sb.cleanup(); }
});

test("a recovery prompt keeps a spaced incident path intact", () => {
  const sb = sandbox({ space: true });
  try {
    const inc = path.join(sb.tmp, "incidents", "A-1.md");
    const out = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--recovery", inc).out);
    assert.ok(out.prompt.startsWith(`RECOVERY: you were stopped for a loop. Read '${fwdp(inc)}'. Find`), out.prompt);
    assert.doesNotMatch(out.prompt, /[";]/);
    assert.equal(out.claude_args.at(-1), `'${out.prompt.replace(/'/g, "''")}'`);
  } finally { sb.cleanup(); }
});

test("--resume refuses a session not confirmed gone, a missing worktree and a sizing the launch refuses", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", sid: "s-1", launched_at: new Date().toISOString() }); // no pid file yet: unknown
    let x = sb.run("--resume", "s-1");
    assert.equal(x.code, 1, x.err);
    assert.match(x.err, /^--resume: A@1 is unknown \(starting \(no pid file yet\)\) - stop it or wait, then re-run$/m);
    sessionLine(sb, { name: "W", sid: "s-w", branch: "w", worktree: path.join(sb.tmp, "gone-worktree") });
    x = sb.run("--resume", "s-w");
    assert.equal(x.code, 2); assert.match(x.err, /^--resume: the worktree of W \(.*gone-worktree\) no longer exists/m);
    sessionLine(sb, { name: "S", sid: "s-s", branch: "s" });
    x = sb.run("--resume", "s-s", "--model", "sonnet");
    assert.equal(x.code, 2); assert.match(x.err, /^--resume: never sonnet as a session/m);
    x = sb.run("--resume", "s-s", "--effort", "huge");
    assert.equal(x.code, 2); assert.match(x.err, /^--resume: --effort must be low\|medium\|high\|xhigh\|max, got huge$/m);
    sessionLine(sb, { name: "H", sid: "s-h", branch: "h", model: "claude-haiku" });
    x = sb.run("--resume", "s-h");
    assert.equal(x.code, 2); assert.match(x.err, /^--resume: never Haiku for a session$/m);
    assert.equal(sb.registry().filter((o) => o.resumed_from).length, 0); // nothing was launched
  } finally { sb.cleanup(); }
});

test("resume --group refuses a blocked lane whose newest launch cannot be judged", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A"), a = sb.registry().find((o) => o.name === "A" && o.launched_at), at = new Date().toISOString();
    sessionLine(sb, { name: "A", id: "A@new", group: "g1", branch: "lane-A", worktree: wt, gen: 2, launched_at: at }); // no pid file yet: unknown
    appendLine(sb, { lane_blocked: "A", group: "g1", handoff: a.handoff, incident: "C:/inc/A-1.md", at });
    const r = sb.run("resume", "--group", "g1");
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^not relaunched: A@new is unknown \(starting \(no pid file yet\)\)/m);
    assert.equal(sb.registry().filter((o) => o.lane_resumed).length, 0);
  } finally { sb.cleanup(); }
});

test("resume --group: a failed relaunch leaves the lane blocked for a re-run; no incident or no launch line is skipped", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A"), a = sb.registry().find((o) => o.name === "A" && o.launched_at), at = new Date().toISOString();
    sessionLine(sb, { name: "A", id: "A@2", group: "g1", branch: "lane-A", worktree: wt, gen: 2, effort: "bogus" }); // the child launcher refuses it
    sessionLine(sb, { name: "B", group: "g1", branch: "lane-B" });
    appendLine(sb, { lane_blocked: "A", group: "g1", handoff: a.handoff, incident: "C:/inc/A-2.md", at });
    appendLine(sb, { lane_blocked: "B", group: "g1", handoff: a.handoff, at }); // no incident
    appendLine(sb, { lane_blocked: "Ghost", group: "g1", handoff: a.handoff, incident: "C:/inc/G-1.md", at }); // no launch line
    const before = sb.registry().filter((o) => o.launched_at).length;
    for (let i = 0; i < 2; i++) { // still blocked after the failure: the re-run tries again
      const r = sb.run("resume", "--group", "g1");
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.out, /^ERROR relaunching A: .*--effort must be low\|medium\|high\|xhigh\|max, got bogus/m);
      assert.match(r.out, /^not relaunched: the lane_blocked line of B names no incident/m);
      assert.match(r.out, /^not relaunched: no launch line for Ghost in group g1$/m);
    }
    assert.equal(sb.registry().filter((o) => o.lane_resumed).length, 0);
    assert.equal(sb.registry().filter((o) => o.launched_at).length, before);
  } finally { sb.cleanup(); }
});

test("a GOAL.md copy that fails warns and never fails the launch", () => {
  const sb = sandbox();
  try {
    const key = "Q--old-folder";
    fs.mkdirSync(path.join(sb.env.HL_PROJECTS_DIR, key), { recursive: true });
    fs.writeFileSync(path.join(sb.env.HL_PROJECTS_DIR, key, "old-sid.jsonl"), tx().user("go").entries().map((x) => JSON.stringify(x)).join("\n") + "\n");
    const oldGoal = path.join(sb.temp, "claude", key, "old-sid", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(oldGoal), { recursive: true }); fs.writeFileSync(oldGoal, "- [ ] x\n");
    fs.writeFileSync(path.join(sb.cfg, "goals"), "a file where the goals folder belongs\n"); // the fallback copy cannot be written
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--goal-from", "old-sid");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^warning: GOAL\.md not copied \(E[A-Z]+\)$/m);
    assert.equal(sb.registry().filter((o) => o.name === "A" && o.launched_at).length, 1);
  } finally { sb.cleanup(); }
});
