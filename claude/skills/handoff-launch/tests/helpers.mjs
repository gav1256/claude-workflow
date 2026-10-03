// Test sandbox for handoff-launch: a temp git repo plus a private registry. Never touches the real registry
// (~/.claude/skills/handoff-launch/sessions.jsonl): HL_REGISTRY_DIR always points into the temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LAUNCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "launch.mjs");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export function sandbox() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hl-test-")));
  const repo = path.join(tmp, "repo"), reg = path.join(tmp, "reg");
  fs.mkdirSync(repo); fs.mkdirSync(reg);
  fs.writeFileSync(path.join(tmp, "agents.json"), "[]");
  const env = {
    ...process.env, ...GIT_ENV, HL_REGISTRY_DIR: reg, HL_AGENTS_JSON: path.join(tmp, "agents.json"),
    HL_PROJECTS_DIR: path.join(tmp, "projects"), HL_FAKE_CLAUDE: "1", HL_NO_SPAWN: "1",
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
  return { tmp, repo, reg, env, git, run, registry, handoff, cleanup };
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
