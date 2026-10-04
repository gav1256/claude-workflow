import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.mjs";

const HEAVY = ["playwright@claude-plugins-official", "context7@claude-plugins-official", "pyright-lsp@claude-plugins-official", "typescript-lsp@claude-plugins-official"];
const uq = (s) => s.slice(1, -1).replace(/''/g, "'"); // undo the launcher's PowerShell q()
const launch = (sb, name, ...extra) => sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", name, "--model", "opus", "--effort", "high", ...extra);
const winOut = (r) => { assert.equal(r.code, 0, r.err + r.out); return JSON.parse(r.out); };
const bgOut = (r) => { assert.equal(r.code, 0, r.err + r.out); return JSON.parse(r.out.slice(0, r.out.indexOf("\nwatchdog:"))); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const disabled = (settingsFile) => Object.entries(readJson(settingsFile).enabledPlugins).filter(([, v]) => v === false).map(([k]) => k).sort();
// Window claude args: '--settings' <file> '--strict-mcp-config' '--mcp-config' <file>, then an option (-n).
function profileFiles(claudeArgs) {
  assert.deepEqual([claudeArgs[0], claudeArgs[2], claudeArgs[3], claudeArgs[5]], ["'--settings'", "'--strict-mcp-config'", "'--mcp-config'", "-n"]);
  return { settings: uq(claudeArgs[1]), mcp: uq(claudeArgs[4]) };
}
const setCap = (sb, cfg) => fs.writeFileSync(path.join(sb.reg, "launch-config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));

test("default profile is lean: all heavy plugins off, empty strict MCP config, registry profile lean", () => {
  const sb = sandbox();
  try {
    const f = profileFiles(winOut(launch(sb, "A")).claude_args);
    assert.deepEqual(disabled(f.settings), [...HEAVY].sort());
    assert.deepEqual(readJson(f.mcp), { mcpServers: {} });
    assert.equal(path.dirname(f.settings), path.join(sb.reg, "profiles").split(path.sep).join("/"));
    assert.match(path.basename(f.settings), /^lean-[0-9a-f]{8}\.settings\.json$/);
    assert.equal(sb.registry().at(-1).profile, "lean");
    // Same profile again: the same content-addressed files.
    const g = profileFiles(winOut(launch(sb, "B")).claude_args);
    assert.deepEqual(g, f);
    assert.equal(fs.readdirSync(path.join(sb.reg, "profiles")).length, 2);
  } finally { sb.cleanup(); }
});

test("--profile python,browser keeps those two plugins and is canonical browser,python", () => {
  const sb = sandbox();
  try {
    const f = profileFiles(winOut(launch(sb, "A", "--profile", "python,browser")).claude_args);
    assert.deepEqual(disabled(f.settings), ["context7@claude-plugins-official", "typescript-lsp@claude-plugins-official"]);
    assert.match(path.basename(f.settings), /^browser\+python-[0-9a-f]{8}\.settings\.json$/);
    assert.equal(sb.registry().at(-1).profile, "browser,python");
    assert.equal(sb.registry().length, 1);
  } finally { sb.cleanup(); }
});

test("--profile explore takes exactly its servers from ~/.claude.json; maps resolves from the worktree .mcp.json", () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.env.HL_CLAUDE_JSON, JSON.stringify({ mcpServers: { repomix: { command: "npx", args: ["repomix", "--mcp"] }, "ast-grep": { command: "ast-grep-mcp" }, other: { command: "x" } } }));
    let f = profileFiles(winOut(launch(sb, "A", "--profile", "explore")).claude_args);
    assert.deepEqual(readJson(f.mcp), { mcpServers: { repomix: { command: "npx", args: ["repomix", "--mcp"] }, "ast-grep": { command: "ast-grep-mcp" } } });
    assert.deepEqual(disabled(f.settings), [...HEAVY].sort());
    // maps: not in the user servers -> not found yet
    let r = launch(sb, "B", "--profile", "maps");
    assert.equal(r.code, 2); assert.match(r.err, /MCP server google-maps not found/);
    assert.equal(sb.registry().length, 1);
    fs.writeFileSync(path.join(sb.repo, ".mcp.json"), JSON.stringify({ mcpServers: { "google-maps": { command: "maps-mcp", env: { KEY: "test-key" } } } }));
    sb.git(sb.repo, "add", ".mcp.json"); sb.git(sb.repo, "commit", "-q", "-m", "mcp");
    f = profileFiles(winOut(launch(sb, "B", "--profile", "maps", "--worktree", "lane-m")).claude_args);
    assert.deepEqual(readJson(f.mcp), { mcpServers: { "google-maps": { command: "maps-mcp", env: { KEY: "test-key" } } } });
    assert.equal(sb.registry().at(-1).profile, "maps");
  } finally { sb.cleanup(); }
});

test("unknown profile, missing --profile value and an invalid profiles file exit 2", () => {
  const sb = sandbox();
  try {
    let r = launch(sb, "A", "--profile", "nope,lean");
    assert.equal(r.code, 2); assert.match(r.err, /unknown profile nope - valid: lean, python, browser, maps, explore, full/);
    r = launch(sb, "A", "--profile");
    assert.equal(r.code, 2); assert.match(r.err, /--profile needs a comma list/);
    const bad = path.join(sb.tmp, "profiles.json");
    fs.writeFileSync(bad, "{nope");
    sb.env.HL_PROFILES_JSON = bad;
    r = launch(sb, "A");
    assert.equal(r.code, 2); assert.match(r.err, /profiles file .*profiles\.json is missing or not valid JSON/);
    fs.writeFileSync(bad, JSON.stringify({ default: "x", profiles: {} }));
    r = launch(sb, "A");
    assert.equal(r.code, 2); assert.match(r.err, /profiles file .* is invalid/);
    assert.equal(sb.registry().length, 0);
  } finally { sb.cleanup(); }
});

test("--profile full (anywhere in the list) adds no profile flags and records profile full", () => {
  const sb = sandbox();
  try {
    const a = winOut(launch(sb, "A", "--profile", "python,full")).claude_args;
    assert.equal(a[0], "-n");
    assert.ok(!a.some((x) => /settings|mcp-config/.test(x)));
    assert.equal(sb.registry().at(-1).profile, "full");
    assert.ok(!fs.existsSync(path.join(sb.reg, "profiles")));
  } finally { sb.cleanup(); }
});

test("bg mode carries the profile args, followed by an option", () => {
  const sb = sandbox();
  try {
    const o = bgOut(launch(sb, "A", "--mode", "bg", "--profile", "python"));
    const c = o.command;
    assert.deepEqual([c[0], c[1], c[2], c[4], c[5], c[7]], ["claude", "--bg", "--settings", "--strict-mcp-config", "--mcp-config", "-n"]);
    assert.deepEqual(disabled(c[3]), HEAVY.filter((p) => !/pyright/.test(p)).sort());
    assert.equal(sb.registry().at(-1).profile, "python");
    assert.equal(sb.registry().at(-1).mode, "bg");
  } finally { sb.cleanup(); }
});

test("profile-args prints {profile, args} with the same files a launch uses", () => {
  const sb = sandbox();
  try {
    let r = sb.run("profile-args", "--profile", "python", "--repo", sb.repo);
    assert.equal(r.code, 0, r.err);
    const pa = JSON.parse(r.out);
    assert.equal(pa.profile, "python");
    assert.deepEqual([pa.args[0], pa.args[2], pa.args[3]], ["--settings", "--strict-mcp-config", "--mcp-config"]);
    const f = profileFiles(winOut(launch(sb, "A", "--profile", "python")).claude_args);
    assert.deepEqual([pa.args[1], pa.args[4]], [f.settings, f.mcp]);
    assert.equal(JSON.parse(sb.run("profile-args").out).profile, "lean");
    assert.deepEqual(JSON.parse(sb.run("profile-args", "--profile", "full").out), { profile: "full", args: [] });
    r = sb.run("profile-args", "--profile", "bogus");
    assert.equal(r.code, 2); assert.match(r.err, /unknown profile bogus/);
  } finally { sb.cleanup(); }
});

test("a registry path with a space stays one argument in claude_args and in the bg command", () => {
  const sb = sandbox({ space: true });
  try {
    const a = winOut(launch(sb, "A")).claude_args;
    for (const i of [1, 4]) { assert.match(a[i], /^'.* .*'$/); assert.ok(fs.existsSync(uq(a[i]))); }
    const c = bgOut(launch(sb, "B", "--mode", "bg")).command;
    assert.ok(c[3].includes(" ") && fs.existsSync(c[3]));
    assert.ok(c[6].includes(" ") && fs.existsSync(c[6]));
  } finally { sb.cleanup(); }
});

test("session cap: max_sessions refuses the next launch (exit 3) until --force; a same repo+branch relay is not blocked", () => {
  const sb = sandbox();
  try {
    setCap(sb, { max_sessions: 2 });
    winOut(launch(sb, "A", "--worktree", "lane-a"));
    winOut(launch(sb, "B", "--worktree", "lane-b"));
    let r = launch(sb, "C", "--worktree", "lane-c");
    assert.equal(r.code, 3, r.out);
    assert.match(r.err, /refused - session cap: 2 sessions running, max_sessions 2 \(config .*launch-config\.json\)/);
    assert.match(r.err, /^ {2}A \(lane-a\): doubtful, counted - no pid recorded$/m);
    assert.match(r.err, /^ {2}B \(lane-b\): doubtful, counted - no pid recorded$/m);
    assert.match(r.err, /close idle sessions first, or pass --force \(ask the user first\)/);
    assert.equal(sb.registry().length, 2);
    r = launch(sb, "C", "--worktree", "lane-c", "--force");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /session cap overridden by --force: 2 sessions running, max_sessions 2/);
    assert.equal(sb.registry().length, 3);
    // Relay on lane-a at max 3: A (same repo+branch) is not counted -> B and C = 2 < 3, launched (counting A would
    // refuse). A launch on a fourth branch then sees A, A2, B, C (the predecessor runs until it is closed).
    setCap(sb, { max_sessions: 3 });
    winOut(launch(sb, "A2", "--worktree", "lane-a"));
    r = launch(sb, "D", "--worktree", "lane-d");
    assert.equal(r.code, 3); assert.match(r.err, /4 sessions running, max_sessions 3/);
  } finally { sb.cleanup(); }
});

test("session cap: low free RAM refuses; --dry-run reports would_refuse and exits 0", () => {
  const sb = sandbox();
  try {
    setCap(sb, { max_sessions: 1, min_free_gb: 3 });
    sb.env.HL_FREE_GB = "1";
    let r = launch(sb, "A");
    assert.equal(r.code, 3); assert.match(r.err, /refused - session cap: 1\.0 GB free RAM, min_free_gb 3/);
    sb.env.HL_FREE_GB = "64";
    winOut(launch(sb, "A", "--worktree", "lane-a"));
    r = launch(sb, "B", "--worktree", "lane-b", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).cap, { running: 1, max: 1, free_gb: 64, min_free_gb: 3, would_refuse: true });
    r = launch(sb, "B", "--worktree", "lane-b", "--mode", "bg", "--dry-run");
    assert.equal(bgOut(r).cap.would_refuse, true);
    assert.equal(sb.registry().length, 1);
  } finally { sb.cleanup(); }
});

test("session cap counts live bg sessions and running windows only; an invalid config warns and uses the defaults", () => {
  const sb = sandbox();
  try {
    const old = "2026-01-01T00:00:00.000Z";
    const line = (o) => ({ repo: "elsewhere", worktree: "x", generation: 1, group: null, title: o.name, handoff: "h.md", done_marker: null, launched_at: old, session_id: null, host_pid: null, host_start: null, pid_file: null, id: `${o.name}@${old}`, ...o });
    fs.writeFileSync(path.join(sb.reg, "sessions.jsonl"), [
      line({ name: "X", branch: "bx", mode: "bg", bg_id: "bgx" }),
      line({ name: "Y", branch: "by", mode: "bg", bg_id: "bgy" }),
      line({ name: "W", branch: "bw", mode: "bg", bg_id: "bgw" }),
      line({ name: "Z", branch: "bz", mode: "window" }),
    ].map((o) => JSON.stringify(o)).join("\n") + "\n");
    fs.writeFileSync(sb.env.HL_AGENTS_JSON, JSON.stringify([{ id: "bgx", status: "running" }, { id: "bgy", status: "Completed" }]));
    setCap(sb, { max_sessions: 1 });
    let r = launch(sb, "A");
    assert.equal(r.code, 3);
    assert.match(r.err, /1 sessions running, max_sessions 1/);
    assert.match(r.err, /^ {2}X \(bx\): running - bg session bgx status running$/m);
    assert.doesNotMatch(r.err, /\b[YWZ] \(/);
    setCap(sb, "{bad");
    r = launch(sb, "A");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /WARN .*launch-config\.json: .* - using the defaults max_sessions=6 min_free_gb=3/);
    setCap(sb, { max_sessions: "2" });
    r = launch(sb, "B");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /WARN .*max_sessions must be a number >= 0/);
  } finally { sb.cleanup(); }
});
