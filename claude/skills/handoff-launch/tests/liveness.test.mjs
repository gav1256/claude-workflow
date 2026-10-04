import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, LAUNCH } from "./helpers.mjs";
import { checkHost, matchNewAgent, windowScript, projectKey } from "../live.mjs";

test("the sandbox never inherits the developer session's coordinator env", () => {
  const sb = sandbox();
  try {
    for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG"]) assert.equal(sb.env[k], undefined, k);
    assert.ok(sb.env.CLAUDE_CONFIG_DIR.startsWith(sb.tmp));
    assert.ok(sb.env.TEMP.startsWith(sb.tmp));
  } finally { sb.cleanup(); }
});

test("checkHost is tri-state: a failed probe or an unreadable start is unknown, never gone", () => {
  const e = { host_pid: 42, host_start: "2026-01-01T00:00:00.000Z", launched_at: "2026-01-01T00:00:00.500Z" };
  assert.equal(checkHost(e, null).state, "unknown");
  assert.equal(checkHost(e, new Map([[42, { name: "DEAD", start: null }]])).state, "gone");
  assert.equal(checkHost(e, new Map([[42, { name: "node", start: e.host_start }]])).state, "gone");
  assert.equal(checkHost(e, new Map([[42, { name: "powershell", start: null }]])).state, "unknown");
  assert.equal(checkHost(e, new Map([[42, { name: "powershell", start: "2026-01-01T00:00:01.000Z" }]])).state, "running");
  assert.equal(checkHost(e, new Map([[42, { name: "powershell", start: "2026-01-01T00:00:09.000Z" }]])).state, "gone");
  assert.equal(checkHost({ host_pid: null, launched_at: new Date().toISOString() }, null).state, "unknown");
  assert.equal(checkHost({ host_pid: null, launched_at: "2026-01-01T00:00:00Z" }, null).state, "gone");
});

test("matchNewAgent takes the one new entry carrying the launch name", () => {
  const before = [{ id: "a", name: "x" }];
  assert.deepEqual(matchNewAgent(before, [...before, { id: "b", name: "lane", sessionId: "s" }], "lane"), { id: "b", name: "lane", sessionId: "s" });
  assert.equal(matchNewAgent(before, [...before, { id: "b", name: "other" }], "lane"), null);
  assert.equal(matchNewAgent(before, [...before, { id: "b", name: "lane" }, { id: "c", name: "lane" }], "lane"), null);
  assert.equal(matchNewAgent([{ id: "b", name: "lane" }], [{ id: "b", name: "lane" }], "lane"), null);
});

test("the window script keeps CLAUDE_CONFIG_DIR and sets HL_SESSION_ID after stripping the parent env", () => {
  const s = windowScript({ pidFile: "C:/r/pids/A-1.pid", name: "A", workDir: "C:/w", banner: "Handoff: h.md", regId: "A@1", claudeLine: "claude -n 'A'" });
  const lines = s.split("\r\n");
  assert.match(lines[1], /\(\$_\.Name -like 'CLAUDE\*' -and \$_\.Name -ne 'CLAUDE_CONFIG_DIR'\)/);
  assert.equal(lines[2], "$env:HL_SESSION_ID = 'A@1'");
  assert.equal(lines.at(-1), "claude -n 'A'");
  assert.equal(projectKey("C:\\Users\\a_b\\Desktop\\Projects\\X"), path.resolve("C:\\Users\\a_b\\Desktop\\Projects\\X").replace(/[^a-zA-Z0-9]/g, "-"));
});

test("a launch line records model, effort, coord, prompt_file and no_spawn; the prompt file holds the prompt", () => {
  const sb = sandbox();
  try {
    const out = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "fable", "--effort", "xhigh").out);
    const [e] = sb.registry();
    assert.equal(e.model, "fable"); assert.equal(e.effort, "xhigh"); assert.equal(e.coord, 1); assert.equal(e.no_spawn, true);
    assert.match(e.pid_file, /\/pids\/A-[\dT-]+Z\.pid$/);
    assert.equal(e.prompt_file, e.pid_file.replace(/\.pid$/, ".prompt.txt"));
    assert.equal(fs.readFileSync(e.prompt_file, "utf8"), out.prompt);
    const bg = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "opus", "--effort", "high", "--mode", "bg");
    assert.equal(bg.code, 0, bg.err);
    const b = sb.registry().find((o) => o.name === "B");
    assert.equal(b.coord, 1); assert.equal(b.pid_file, null); assert.match(b.prompt_file, /\/pids\/B-.*\.prompt\.txt$/);
  } finally { sb.cleanup(); }
});

test("auto-close never marks a session closed on an unknown probe", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const line = { id: "w@1", name: "w", repo: sb.repo.split(path.sep).join("/").toLowerCase(), branch: "main", worktree: "x", generation: 1, mode: "window", group: null, title: "w", handoff: "h.md", done_marker: null, launched_at: new Date(Date.now() - 3600e3).toISOString(), session_id: null, host_pid: dead, host_start: null, pid_file: null };
    fs.writeFileSync(path.join(sb.reg, "sessions.jsonl"), [line, { ...line, id: "w@2", generation: 2 }].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const dryLaunch = (env) => JSON.parse(spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "w", "--model", "opus", "--effort", "high", "--dry-run"], { env, encoding: "utf8" }).stdout).auto_close;
    assert.match(dryLaunch(sb.env)[0], /^skip w \(gen 1, pid \d+\): not running - would mark closed$/);
    assert.match(dryLaunch({ ...sb.env, HL_FAKE_PROBE: "fail" })[0], /^skip w \(gen 1, pid \d+\): liveness unknown \(process probe failed .*\) - nothing done$/);
    assert.equal(sb.registry().filter((o) => o.closed).length, 0);
  } finally { sb.cleanup(); }
});
