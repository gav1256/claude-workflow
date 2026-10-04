// Test sandbox for handoff-launch: a temp git repo plus a private registry. Never touches the real registry
// (~/.claude/skills/handoff-launch/sessions.jsonl): HL_REGISTRY_DIR always points into the temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectKey } from "../live.mjs";

export const LAUNCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "launch.mjs");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export function sandbox({ space = false } = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), space ? "hl test-" : "hl-test-")));
  const repo = path.join(tmp, "repo"), reg = path.join(tmp, "reg");
  fs.mkdirSync(repo); fs.mkdirSync(reg);
  fs.writeFileSync(path.join(tmp, "agents.json"), "[]");
  const cfg = path.join(tmp, "cfg"), temp = path.join(tmp, "temp");
  fs.mkdirSync(cfg); fs.mkdirSync(temp);
  // Never inherit the developer session's coordinator env: a test must not write the real coord state or relay alerts.
  const base = { ...process.env };
  for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG"]) delete base[k];
  const env = {
    ...base, ...GIT_ENV, HL_REGISTRY_DIR: reg, HL_AGENTS_JSON: path.join(tmp, "agents.json"),
    HL_PROJECTS_DIR: path.join(tmp, "projects"), HL_FAKE_CLAUDE: "1", HL_NO_SPAWN: "1",
    CLAUDE_CONFIG_DIR: cfg, TEMP: temp, TMP: temp, TMPDIR: temp,
  };
  const git = (dir, ...a) => {
    const r = spawnSync("git", ["-C", dir, ...a], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".superpowers/\n");
  fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
  fs.writeFileSync(path.join(repo, "check.cjs"), "process.exit(require('fs').existsSync('FAIL') ? 1 : 0)\n");
  fs.writeFileSync(path.join(repo, "hang.cjs"), "setTimeout(() => {}, 120000)\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  const handoff = path.join(tmp, "handoff.md");
  fs.writeFileSync(handoff, "# test handoff\n");
  const run = (...a) => {
    const r = spawnSync(process.execPath, [LAUNCH, ...a], { env, encoding: "utf8", timeout: 180000 });
    return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
  };
  const regFile = path.join(reg, "sessions.jsonl");
  const registry = () => (fs.existsSync(regFile) ? fs.readFileSync(regFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { tmp, repo, reg, env, git, run, registry, handoff, cleanup, cfg, temp, coord: path.join(cfg, "state", "coord") };
}

// Launch a lane the way a controller does (HL_NO_SPAWN: worktree + registry line, no window). Returns its worktree.
export function launchLane(sb, group, name, extra = []) {
  const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", name, "--model", "opus", "--effort", "high",
    "--worktree", `lane-${name}`, "--group", group, ...extra);
  if (r.code !== 0) throw new Error(`launch ${name}: ${r.err}${r.out}`);
  return path.join(sb.repo, ".claude", "worktrees", `lane-${name}`);
}

export function commitIn(sb, dir, files, msg) {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  sb.git(dir, "add", "-A"); sb.git(dir, "commit", "-q", "-m", msg);
  return sb.git(dir, "rev-parse", "HEAD");
}

export function writeDone(sb, group, name, head, extra = {}) {
  const f = path.join(sb.repo, ".superpowers", "sessions", group, `${name}.done`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ name, branch: `lane-${name}`, head, status: "done", tests: "ok",
    next_after_merge: [], at: new Date().toISOString(), ...extra }));
  return f;
}

const MIN_MS = 60000;

// Transcript fixtures in Claude Code's JSONL shape: tx({start}).user("go").call("Bash", {command: "x"}).say("done").entries()
export function tx({ start = Date.now() - 60 * MIN_MS, step = 1000 } = {}) {
  const lines = []; let t = start, n = 0, usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  const ts = () => new Date((t += step)).toISOString();
  const api = {
    at(ms) { t = ms; return api; },
    gap(ms) { t += ms; return api; },
    tokens(input, cacheRead = 0, cacheCreate = 0) { usage = { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate }; return api; },
    user(text) { lines.push({ type: "user", message: { role: "user", content: text }, timestamp: ts() }); return api; },
    call(name, input = {}, { result = true, id } = {}) {
      const tid = id || `toolu_${String(++n).padStart(4, "0")}`;
      lines.push({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: tid, name, input }] }, timestamp: ts() });
      if (result) lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] }, timestamp: ts() });
      return api;
    },
    say(text) { lines.push({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", usage, content: [{ type: "text", text }] }, timestamp: ts() }); return api; },
    limit() { return api.say("You've hit your weekly limit · resets 6pm"); },
    turnDone(bg = 0) { lines.push({ type: "system", subtype: "turn_duration", pendingBackgroundAgentCount: bg, timestamp: ts() }); return api; },
    entries: () => lines.map((x) => JSON.parse(JSON.stringify(x))),
    last: () => t,
  };
  return api;
}
const toFwd = (p) => p.split(path.sep).join("/");
export const appendLine = (sb, o) => fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify(o) + "\n");
// A launch line as a stage-2 launcher writes it. Override any field; pass coord/model/effort: undefined for a pre-stage-2 line.
export function sessionLine(sb, o) {
  const wt = o.worktree || sb.repo;
  const e = {
    id: o.id || `${o.name}@${o.gen ?? 1}`, name: o.name, repo: toFwd(path.resolve(o.repo || sb.repo)).toLowerCase(), branch: o.branch || "main",
    worktree: toFwd(wt), generation: o.gen ?? 1, mode: o.mode || "window", group: o.group ?? null, title: o.name,
    handoff: toFwd(o.handoff || sb.handoff), done_marker: o.done_marker ?? null,
    launched_at: o.launched_at || new Date(Date.now() - 2 * 3600e3).toISOString(), session_id: o.sid ?? null,
    host_pid: o.host?.pid ?? null, host_start: o.host?.start ?? null, pid_file: null, bg_id: o.bg_id ?? null,
    model: "model" in o ? o.model : "opus", effort: "effort" in o ? o.effort : "high", coord: "coord" in o ? o.coord : 1, prompt_file: o.prompt_file ?? null,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  appendLine(sb, e);
  return e;
}
export function writeTranscript(sb, dir, sid, entries) {
  const f = path.join(sb.env.HL_PROJECTS_DIR, projectKey(dir), `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return f;
}
export function writeSubagent(sb, dir, sid, agentId, entries, meta = { agentType: "worker-high", requestShape: "background", description: "a task" }, mtimeMs = Date.now()) {
  const d = path.join(sb.env.HL_PROJECTS_DIR, projectKey(dir), sid, "subagents"), f = path.join(d, `agent-${agentId}.jsonl`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(f, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(d, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
}
export const setAgents = (sb, list) => fs.writeFileSync(path.join(sb.tmp, "agents.json"), JSON.stringify(list));
