import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sandbox, sessionLine, writeTranscript, writeSubagent, setAgents, tx, host, emptyHost, jobHost, nodeJobHost, hasPython, LAUNCH, coordRun } from "./helpers.mjs";
import { checkHost, matchNewAgent, listedAgent, windowScript, projectKey, isClaudeProc, procInfo, probeWhy, hostBelow, launcherEnv,
  hostsBelow, hostsBelowScript, processList, sleep } from "../live.mjs";

test("the sandbox never inherits the developer session's coordinator env", () => {
  const sb = sandbox();
  try {
    for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG"]) assert.equal(sb.env[k], undefined, k);
    assert.ok(sb.env.CLAUDE_CONFIG_DIR.startsWith(sb.tmp));
    assert.ok(sb.env.TEMP.startsWith(sb.tmp));
  } finally { sb.cleanup(); }
});

test("the sandbox carries main's cap and profile env: HL_FREE_GB 64, max_sessions 1000, a temp HL_CLAUDE_JSON, no HL_PROFILES_JSON", () => {
  const prev = process.env.HL_PROFILES_JSON;
  process.env.HL_PROFILES_JSON = "C:/somewhere/else/profiles.json"; // a developer's override never leaks into a test
  const sb = sandbox();
  try {
    assert.equal(sb.env.HL_FREE_GB, "64");
    assert.equal(sb.env.HL_PROFILES_JSON, undefined);
    assert.ok(sb.env.HL_CLAUDE_JSON.startsWith(sb.tmp));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.reg, "launch-config.json"), "utf8")), { max_sessions: 1000 });
  } finally { sb.cleanup(); if (prev === undefined) delete process.env.HL_PROFILES_JSON; else process.env.HL_PROFILES_JSON = prev; }
});

test("claude agents --json that is not a list ({}) never throws: listedAgent/matchNewAgent find nothing; a launch, status and the tick run", () => {
  // In-process: the pure matchers on non-lists and odd elements.
  const e = { session_id: "s-b", bg_id: "bg-b" };
  for (const bad of [{}, null, undefined, "x", 5]) {
    assert.equal(listedAgent(e, bad), null);
    assert.equal(matchNewAgent(bad, [{ id: "n", name: "B" }], "B"), null);
    assert.equal(matchNewAgent([], bad, "B"), null);
  }
  assert.deepEqual(listedAgent(e, [null, 5, "s", { id: "bg-b", status: "running" }]), { id: "bg-b", status: "running" });
  assert.equal(listedAgent(e, [null, { id: "other" }]), null);
  assert.deepEqual(matchNewAgent([null], [null, 7, { id: "n", name: "B" }], "B"), { id: "n", name: "B" });
  // Child processes: HL_AGENTS_JSON holds {} while the registry has a background lane.
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.env.HL_AGENTS_JSON, "{}");
    sessionLine(sb, { name: "B", sid: "s-b", mode: "bg", bg_id: "bg-b", branch: "b", group: "g1", launched_at: new Date().toISOString() });
    fs.writeFileSync(path.join(sb.reg, "launch-config.json"), JSON.stringify({ max_sessions: 1 }));
    // The session cap reads the bg lane's liveness: unknown (not a list), so it counts as doubtful - never a TypeError.
    let r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--worktree", "lane-a");
    assert.equal(r.code, 3, r.err + r.out);
    assert.match(r.err, /^ {2}B \(b\): doubtful, counted - claude agents --json is not a list$/m);
    assert.doesNotMatch(r.err, /TypeError|is not a function/);
    fs.writeFileSync(path.join(sb.reg, "launch-config.json"), JSON.stringify({ max_sessions: 1000 }));
    r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--mode", "bg");
    assert.equal(r.code, 0, r.err);
    r = sb.run("status", "--group", "g1", "--repo", sb.repo);
    assert.equal(r.code, 0, r.err); assert.doesNotMatch(r.err, /TypeError/);
    assert.match(r.out, /liveness=unknown \(claude agents --json is not a list\)/);
    r = coordRun(sb, ["tick"]);
    assert.equal(r.code, 0, r.err); assert.doesNotMatch(r.out + r.err, /TypeError|tick failed/);
    assert.match(r.out, /^unknown B: liveness unknown \(claude agents --json is not a list\) - no action$/m);
  } finally { sb.cleanup(); }
});

test("merge rule 5: launch lines keep every stage-2 field and gain profile (window, bg, --resume)", () => {
  const sb = sandbox();
  try {
    const STAGE2 = ["id", "name", "repo", "branch", "worktree", "generation", "mode", "group", "title", "handoff", "done_marker", "launched_at",
      "session_id", "host_pid", "host_start", "pid_file", "model", "effort", "coord", "prompt_file", "no_spawn"];
    const run = (...a) => { const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--model", "opus", "--effort", "high", ...a); assert.equal(r.code, 0, r.err); };
    run("--name", "W", "--profile", "python");
    run("--name", "B", "--mode", "bg", "--worktree", "lane-b");
    const lines = () => sb.registry().filter((o) => o.launched_at);
    const w = lines().find((o) => o.name === "W"), b = lines().find((o) => o.name === "B");
    for (const k of STAGE2) { assert.ok(k in w, `window: ${k}`); assert.ok(k in b, `bg: ${k}`); }
    assert.deepEqual([w.profile, b.profile, w.coord, b.coord], ["python", "lean", 1, 1]);
    const r = sb.run("--resume", w.session_id);
    assert.equal(r.code, 0, r.err);
    const n = lines().at(-1);
    for (const k of [...STAGE2, "resumed_from"]) assert.ok(k in n, `--resume: ${k}`);
    assert.deepEqual([n.profile, n.resumed_from, n.session_id], ["python", w.id, w.session_id]);
    // {starting} lines keep their shape (they need not carry a profile).
    for (const s of sb.registry().filter((o) => "starting" in o)) assert.deepEqual(Object.keys(s).filter((k) => k !== "group").sort(), ["at", "name", "pid_file", "starting"]);
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
  const w = { pidFile: "C:/r/pids/A-1.pid", name: "A", workDir: "C:/w", banner: "Handoff: h.md", regId: "A@1", claudeLine: "claude -n 'A'" };
  const s = windowScript({ ...w, configDir: "C:/o'k cfg" });
  const lines = s.split("\r\n");
  assert.match(lines[1], /\(\$_\.Name -like 'CLAUDE\*' -and \$_\.Name -ne 'CLAUDE_CONFIG_DIR'\)/);
  assert.equal(lines[2], "$env:HL_SESSION_ID = 'A@1'");
  // Windows Terminal may give a new window its own env: a set config dir is written into the script explicitly.
  assert.equal(lines[3], "$env:CLAUDE_CONFIG_DIR = 'C:/o''k cfg'");
  assert.equal(lines.at(-1), "claude -n 'A'");
  assert.doesNotMatch(windowScript({ ...w, configDir: null }), /CLAUDE_CONFIG_DIR = /);
  assert.equal(projectKey("C:\\Users\\a_b\\Desktop\\Projects\\X"), path.resolve("C:\\Users\\a_b\\Desktop\\Projects\\X").replace(/[^a-zA-Z0-9]/g, "-"));
});

test("a launch line records model, effort, coord, prompt_file and no_spawn; the prompt file holds the prompt", () => {
  const sb = sandbox();
  try {
    const out = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "fable", "--effort", "xhigh").out);
    const [e] = sb.registry().filter((o) => o.launched_at); // after its {starting} line
    assert.equal(e.model, "fable"); assert.equal(e.effort, "xhigh"); assert.equal(e.coord, 1); assert.equal(e.no_spawn, true);
    assert.match(e.pid_file, /\/pids\/A-[\dT-]+Z\.pid$/);
    assert.equal(e.prompt_file, e.pid_file.replace(/\.pid$/, ".prompt.txt"));
    assert.equal(fs.readFileSync(e.prompt_file, "utf8"), out.prompt);
    const bg = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "opus", "--effort", "high", "--mode", "bg");
    assert.equal(bg.code, 0, bg.err);
    const b = sb.registry().find((o) => o.name === "B" && o.launched_at);
    assert.equal(b.coord, 1); assert.equal(b.pid_file, null); assert.match(b.prompt_file, /\/pids\/B-.*\.prompt\.txt$/);
  } finally { sb.cleanup(); }
});

test("auto-close never marks a session closed on an unknown probe", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const line = { id: "w@1", name: "w", repo: sb.repo.split(path.sep).join("/").toLowerCase(), branch: "main", worktree: "x", generation: 1, mode: "window", group: null, title: "w", handoff: "h.md", done_marker: null, launched_at: new Date(Date.now() - 3600e3).toISOString(), session_id: null, host_pid: dead, host_start: null, pid_file: null };
    // Batch A: the launch-time close takes the new launch's chain beyond its direct predecessor (w@2 -> w@1).
    fs.writeFileSync(path.join(sb.reg, "sessions.jsonl"), [{ ...line, supersedes: null }, { ...line, id: "w@2", generation: 2, supersedes: "w@1" }].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const dryLaunch = (env) => JSON.parse(spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "w", "--model", "opus", "--effort", "high", "--supersedes", "w@2", "--dry-run"], { env, encoding: "utf8" }).stdout).auto_close;
    assert.match(dryLaunch(sb.env)[0], /^skip w \(gen 1, pid \d+\): not running - would mark closed$/);
    assert.match(dryLaunch({ ...sb.env, HL_FAKE_PROBE: "fail" })[0], /^skip w \(gen 1, pid \d+\): liveness unknown \(process probe failed .*\) - nothing done$/);
    // The apply path (unknown never writes {closed}) needs a real window launch: a live-verify item, not a test here.
  } finally { sb.cleanup(); }
});

// The single-host claude-below probe (claudeBelowScript / hasClaudeBelow, no production caller) is gone: every host-below
// question goes through hostsBelow, whose loud CIM failure is tested below. Its one predicate:
test("isClaudeProc: claude.exe, or node running Claude Code (npm install) or the tests' stand-in; never a plain node job or a .claude path", () => {
  for (const [name, cmd, want] of [
    ["claude.exe", "", true], ["Claude.exe", "\"C:\\x\\claude.exe\" --resume s", true], ["claude", null, true],
    ["node.exe", "\"C:\\nodejs\\node.exe\" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js -n A", true],
    ["node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", true],
    ["node.exe", "\"C:\\nodejs\\node.exe\" C:\\T\\hl-claude-standin-42.cjs C:\\T\\x.ready", true],
    ["node.exe", "\"C:\\nodejs\\node.exe\" C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js test", false], // npm test
    ["node.exe", "node C:/r/.claude/worktrees/lane-a/node_modules/.bin/vitest", false], // "claude" in a path only
    ["node.exe", "node claude.js", false], ["node.exe", "", false], ["node.exe", null, false],
    ["python.exe", "python -m claude_code", false], ["claude-helper.exe", "", false], ["cmd.exe", "@anthropic-ai/claude-code", false],
  ]) assert.equal(isClaudeProc(name, cmd), want, `${name} ${cmd}`);
});

test("a successful probe clears the last failure reason", { skip: process.platform !== "win32" }, () => {
  const saved = process.env.HL_FAKE_PROBE;
  try {
    process.env.HL_FAKE_PROBE = "fail";
    assert.equal(procInfo([process.pid]), null);
    assert.match(probeWhy(), /HL_FAKE_PROBE=fail/);
    delete process.env.HL_FAKE_PROBE;
    assert.equal(procInfo([process.pid]).get(process.pid).name, "node");
    assert.equal(probeWhy(), null);
  } finally { if (saved === undefined) delete process.env.HL_FAKE_PROBE; else process.env.HL_FAKE_PROBE = saved; }
});

test("auto-close at launch keeps an idle N-2 window whose pending background agents are unknown (no turn_duration record)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hosts = [host(), host()];
  try {
    const old = Date.now() - 40 * 60000;
    const known = tx({ start: old }).user("go").say("handed off").turnDone().entries();
    const unknown = tx({ start: old }).user("go").say("handed off").entries(); // the turn ended without a turn_duration record
    // Batch A: each launch closes its own chain beyond its direct predecessor: k@2 -> k@1, u@2 -> u@1.
    const k = sessionLine(sb, { name: "k", id: "k@1", gen: 1, sid: "k-s1", host: hosts[0], supersedes: null }); writeTranscript(sb, sb.repo, k.session_id, known);
    const u = sessionLine(sb, { name: "u", id: "u@1", gen: 1, sid: "u-s1", host: hosts[1], supersedes: null }); writeTranscript(sb, sb.repo, u.session_id, unknown);
    sessionLine(sb, { name: "k", id: "k@2", gen: 2, sid: "k-s2", supersedes: "k@1" });
    sessionLine(sb, { name: "u", id: "u@2", gen: 2, sid: "u-s2", supersedes: "u@1" });
    const dry = (n, sup) => spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", n, "--model", "opus", "--effort", "high", "--supersedes", sup, "--dry-run"], { env: sb.env, encoding: "utf8" });
    const r = dry("k", "k@2"), r2 = dry("u", "u@2");
    assert.equal(r.status, 0, r.stderr); assert.equal(r2.status, 0, r2.stderr);
    const auto = [...JSON.parse(r.stdout).auto_close, ...JSON.parse(r2.stdout).auto_close];
    assert.ok(auto.some((l) => /^would close k \(gen 1, pid \d+\): idle \d+ min$/.test(l)), auto.join("\n"));
    assert.ok(auto.some((l) => /^skip u \(gen 1, pid \d+\): pending background agents unknown \(the turn ended without a turn_duration record\) - nothing done$/.test(l)), auto.join("\n"));
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("auto-close at launch follows the new launch's chain, never the generation order: a legacy link ends it, a co-tenant is never in it", () => {
  const sb = sandbox();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid, gone = { pid: dead, start: null };
    // One repo + branch (main): legacy generations L@1-3 (no supersedes key), a --force'd co-tenant C@1 (gen 2) and the chain
    // N@1 <- N@2 (gens 4, 5). The next launch is gen 6, so the stage-2 rule (gen <= N-2) would select L@1-3, C@1 and N@1.
    for (const g of [1, 2, 3]) sessionLine(sb, { name: "L", id: `L@${g}`, gen: g, host: gone });
    sessionLine(sb, { name: "C", id: "C@1", gen: 2, host: gone, supersedes: null });
    sessionLine(sb, { name: "N", id: "N@1", gen: 4, host: gone, supersedes: null });
    sessionLine(sb, { name: "N", id: "N@2", gen: 5, host: gone, supersedes: "N@1" });
    const dry = (name, ...extra) => {
      const r = spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", name, "--model", "opus", "--effort", "high", ...extra, "--dry-run"], { env: sb.env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      assert.equal(o.registry_line.generation, 6);
      return o.auto_close;
    };
    assert.deepEqual(dry("L", "--supersedes", "L@3"), []); // a legacy link ends the chain: L@1-2 are not in it
    const n = dry("N", "--supersedes", "N@2"); // N@2 is the direct predecessor (never closed here): N@1 is the only one beyond it
    assert.equal(n.length, 1, n.join("\n")); assert.match(n[0], /^skip N \(gen 4, pid \d+\): /);
    assert.deepEqual(dry("X"), []); // replaces nothing: no chain, so nothing to close
  } finally { sb.cleanup(); }
});

// batch A, Part 2: sessionState in a child process with the sandbox env (live.mjs reads its dirs at import).
const LIVE_URL = pathToFileURL(path.join(import.meta.dirname, "..", "live.mjs")).href;
const stateOf = (sb, e) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e",
  `import { sessionState } from ${JSON.stringify(LIVE_URL)}; const s = sessionState(${JSON.stringify(e)}); process.stdout.write(JSON.stringify({ idle: s.idle, busy: s.busy, bgTasks: s.bgTasks }));`],
  { env: sb.env, encoding: "utf8" }).stdout);

test("sessionState: an otherwise idle session with an open background shell task is busy until the task ends; older tasks and ended ones never count", () => {
  const sb = sandbox();
  try {
    const t0 = Date.now() - 30 * 60000, iso = (ms) => new Date(ms).toISOString();
    const e = { id: "A@1", name: "A", session_id: "a-s1", mode: "window", launched_at: iso(t0) };
    const t = tx({ start: t0 }).user("go").call("Bash", { command: "x" }).say("waiting").turnDone().entries();
    const res = t.findIndex((o) => Array.isArray(o.message?.content) && o.message.content[0]?.type === "tool_result");
    t[res].toolUseResult = { backgroundTaskId: "b1" };
    const f = writeTranscript(sb, sb.repo, e.session_id, [{ type: "user", timestamp: iso(t0 - 60000), toolUseResult: { backgroundTaskId: "old" } }, ...t]);
    assert.deepEqual(stateOf(sb, e), { idle: false, busy: ["1 background task(s) running"], bgTasks: ["b1"] });
    // A subagent's task notifies in the main file: started there, ended here.
    writeSubagent(sb, sb.repo, e.session_id, "ag1", [{ type: "user", timestamp: iso(t0 + 5000), toolUseResult: { backgroundTaskId: "s1" } }]);
    assert.deepEqual(stateOf(sb, e).bgTasks, ["b1", "s1"]);
    fs.appendFileSync(f, [`{"type":"queue-operation","operation":"enqueue","timestamp":"${iso(t0 + 9000)}","content":"<task-notification><task-id>b1</task-id><status>completed</status></task-notification>"}`,
      `{"type":"user","timestamp":"${iso(t0 + 9500)}","toolUseResult":{"message":"Successfully stopped task: s1 (x)","task_id":"s1"}}`,
      `{"type":"assistant","timestamp":"${iso(t0 + 9600)}","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}`,
      `{"type":"system","subtype":"turn_duration","timestamp":"${iso(t0 + 9700)}"}`].join("\n") + "\n");
    assert.deepEqual(stateOf(sb, e), { idle: true, busy: [], bgTasks: [] });
  } finally { sb.cleanup(); }
});

test("hostBelow: a claude stand-in, an empty host (claude exited) and a user's job below it", { skip: process.platform !== "win32" }, () => {
  const hosts = [host(), emptyHost(), ...(hasPython() ? [jobHost()] : [])];
  try {
    assert.deepEqual(hostBelow(hosts[0].pid), { names: ["node.exe"], claude: true, empty: false });
    assert.deepEqual(hostBelow(hosts[1].pid), { names: [], claude: false, empty: true });
    if (hosts[2]) assert.deepEqual(hostBelow(hosts[2].pid), { names: ["python.exe"], claude: false, empty: false });
  } finally { for (const h of hosts) h.kill(); }
});

test("launcherEnv drops HL_SESSION_ID and CLAUDE_CODE_SESSION_ID and keeps the rest", () => {
  const saved = { a: process.env.HL_SESSION_ID, b: process.env.CLAUDE_CODE_SESSION_ID };
  try {
    process.env.HL_SESSION_ID = "X@1"; process.env.CLAUDE_CODE_SESSION_ID = "s-x";
    const env = launcherEnv({ EXTRA: "1" });
    assert.equal(env.HL_SESSION_ID, undefined); assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.EXTRA, "1"); assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
  } finally {
    if (saved.a === undefined) delete process.env.HL_SESSION_ID; else process.env.HL_SESSION_ID = saved.a;
    if (saved.b === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved.b;
  }
});

// Plan amendment 3: one process scan per tick. A fake process list cannot stand in: hostsBelow runs a CIM script.
test("hostsBelow: one probe answers for every host - a claude stand-in, an empty host, a user's node or python job and a gone host", { skip: process.platform !== "win32" }, () => {
  const hosts = [host(), emptyHost(), nodeJobHost(), ...(hasPython() ? [jobHost()] : [])];
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  try {
    // Under the full suite's load the whole-table CIM query can time out (null, never "empty"): retried once after 1 s.
    const probe = () => hostsBelow([...hosts.map((h) => h.pid), dead]);
    let m = probe();
    if (m === null) { sleep(1000); m = probe(); }
    assert.ok(m instanceof Map, `hostsBelow failed twice: ${probeWhy()}`);
    assert.equal(m.size, hosts.length + 1);
    assert.deepEqual(m.get(hosts[0].pid), { names: ["node.exe"], claude: true, empty: false });
    assert.deepEqual(m.get(hosts[1].pid), { names: [], claude: false, empty: true });
    // A plain node job (npm test) is shown as node.exe but is not claude: only Claude Code's command line or the stand-in's is.
    assert.deepEqual(m.get(hosts[2].pid), { names: ["node.exe"], claude: false, empty: false });
    if (hosts[3]) assert.deepEqual(m.get(hosts[3].pid), { names: ["python.exe"], claude: false, empty: false });
    // A gone host answers as hostBelow always did (nothing below it); callers judge liveness first.
    assert.deepEqual(m.get(dead), { names: [], claude: false, empty: true });
    assert.deepEqual(hostBelow(dead), m.get(dead));
    assert.deepEqual(hostsBelow([]), new Map()); // no candidates: no probe
  } finally { for (const h of hosts) h.kill(); }
});

test("the hosts-below probe fails loudly on a CIM error instead of answering \"empty\"", { skip: process.platform !== "win32" }, () => {
  const ps = (script) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const ok = ps(hostsBelowScript([dead]));
  assert.equal(ok.status, 0, ok.stderr); assert.equal(ok.stdout.trim(), "OK");
  const bad = ps(`function Get-CimInstance { Write-Error 'fake CIM failure' }; ${hostsBelowScript([dead])}`);
  assert.equal(bad.status, 1); assert.equal(bad.stdout.trim(), "ERR"); assert.match(bad.stderr, /fake CIM failure/);
});

// Plan amendment 6: HL_FAKE_PROBE=fail:<label>.
test("HL_FAKE_PROBE=fail:<label> fails only the probes with that label (the host-below probes are \"below\")", { skip: process.platform !== "win32" }, () => {
  const saved = process.env.HL_FAKE_PROBE;
  try {
    process.env.HL_FAKE_PROBE = "fail:below";
    assert.equal(hostsBelow([process.pid]), null);
    assert.equal(hostBelow(process.pid), null);
    assert.match(probeWhy(), /HL_FAKE_PROBE=fail:below/);
    assert.equal(procInfo([process.pid]).get(process.pid).name, "node"); // a powershell probe runs for real
    process.env.HL_FAKE_PROBE = "fail:powershell";
    assert.equal(procInfo([process.pid]), null);
    assert.ok(hostBelow(process.pid), "a below probe runs for real");
  } finally { if (saved === undefined) delete process.env.HL_FAKE_PROBE; else process.env.HL_FAKE_PROBE = saved; }
});

test("agentsList under HL_FAKE_PROBE=fail:<label> reads HL_AGENTS_JSON (never a real claude agents --json); fail still fails it", () => {
  const sb = sandbox();
  try {
    const list = [{ id: "bg-1", sessionId: "s-1", status: "running" }];
    setAgents(sb, list);
    const agents = (fake) => spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { agentsList } from ${JSON.stringify(LIVE_URL)}; process.stdout.write(JSON.stringify(agentsList()));`],
      { env: { ...sb.env, HL_FAKE_PROBE: fake }, encoding: "utf8" }).stdout;
    assert.deepEqual(JSON.parse(agents("fail:below")), list);
    assert.equal(JSON.parse(agents("fail")), null);
  } finally { sb.cleanup(); }
});

// Task 3 carry: isPlaywrightProc and staleProfileDirs read p.cmd.
test("processList carries each process's command line as cmd, a | inside it included", { skip: process.platform !== "win32" }, () => {
  const saved = process.env.HL_FAKE_PROCS; delete process.env.HL_FAKE_PROCS;
  const mark = `hl-cmd-${process.pid}-${Date.now()}`;
  const kid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", `${mark}|tail`], { stdio: "ignore", windowsHide: true });
  try {
    const list = processList();
    assert.ok(Array.isArray(list) && list.length > 1);
    assert.ok(list.every((p) => typeof p.cmd === "string"));
    const me = list.find((p) => p.pid === kid.pid);
    assert.ok(me, "the child is listed");
    assert.equal(me.name, "node.exe");
    assert.ok(me.cmd.includes(`${mark}|tail`), me.cmd);
  } finally { kid.kill(); if (saved !== undefined) process.env.HL_FAKE_PROCS = saved; }
});

// Plan amendment 5: no leftover test file.
const HELPERS_URL = pathToFileURL(path.join(import.meta.dirname, "helpers.mjs")).href;
test("the claude stand-in's script file is removed when the test process exits", { skip: process.platform !== "win32" }, () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { host } from ${JSON.stringify(HELPERS_URL)}; `
    + `const h = host(); h.kill(); `
    + `process.stdout.write(JSON.stringify({ pid: process.pid, had: fs.existsSync(path.join(os.tmpdir(), "hl-claude-standin-" + process.pid + ".cjs")) }));`],
    { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.had, true, "host() wrote the stand-in");
  assert.equal(fs.existsSync(path.join(os.tmpdir(), `hl-claude-standin-${o.pid}.cjs`)), false);
});
