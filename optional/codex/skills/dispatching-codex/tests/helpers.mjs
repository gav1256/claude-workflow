// Test helpers for the dispatching-codex suite. Nothing here touches the real ~/.claude,
// ~/.codex or %TEMP%\claude: every path is a fresh temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.dirname(TESTS_DIR);
export const FAKE_CODEX = path.join(TESTS_DIR, "fake-codex.mjs");

let counter = 0;

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * A complete test environment: temp CFG, CODEX_HOME, handoff registry and TEMP stand-in,
 * the fake codex as CODEX_RUN_BIN, a unique pipe prefix and an empty scenario.
 * Returns an env object for spawn() / process.env. Non-enumerable extras: `root` (the temp
 * folder) and `cleanup()` (removes it); they are dropped by `{...env}`.
 */
export function tmpEnv(extra = {}) {
  const root = mkTmp("cdx-t-");
  const dirs = {
    cfg: path.join(root, "cfg"),
    codexHome: path.join(root, "codex-home"),
    registry: path.join(root, "registry"),
    temp: path.join(root, "temp"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const k of ["HL_SESSION_ID", "HL_SKILL_DIR", "CODEX_RUN_PROCS", "CODEX_RUN_TIMEOUT_MS", "CODEX_RUN_NPM_ROOT"]) {
    delete env[k];
  }
  const scenarioFile = path.join(root, "scenario-0.json");
  fs.writeFileSync(scenarioFile, "{}");
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: dirs.cfg,
    CODEX_HOME: dirs.codexHome,
    HL_REGISTRY_DIR: dirs.registry,
    CODEX_RUN_TEMP: dirs.temp,
    CODEX_RUN_BIN: process.execPath,
    CODEX_RUN_BIN_ARGS: JSON.stringify([FAKE_CODEX]),
    FAKE_CODEX_SCENARIO: scenarioFile,
    CODEX_RUN_PIPE_PREFIX: `codex-run-test-${process.pid}-${++counter}-`,
  }, extra);
  Object.defineProperty(env, "root", { value: root, enumerable: false });
  Object.defineProperty(env, "cleanup", { value: () => rmrf(root), enumerable: false });
  return env;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** A git repo (branch main) with one commit by test@example.com. Returns its path. */
export function makeRepo(parent = mkTmp("cdx-repo-")) {
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  for (const [k, v] of [["user.email", "test@example.com"], ["user.name", "Test"],
    ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repo, ["config", k, v]);
  fs.writeFileSync(path.join(repo, "README.md"), "# test repo\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

/** A linked worktree of `repo` on a new branch `name`; the folder is "<name> wt" (has a space). */
export function addWorktree(repo, name) {
  const wt = path.join(path.dirname(repo), `${name} wt`);
  git(repo, ["worktree", "add", "-q", "-b", name, wt]);
  return wt;
}

/**
 * Write a FAKE_CODEX_SCENARIO JSON file. With `env` (from tmpEnv) the file goes into its temp
 * root and env.FAKE_CODEX_SCENARIO is pointed at it. Returns the file path.
 */
export function scenario(obj, env) {
  const dir = env?.root ?? mkTmp("cdx-sc-");
  const file = path.join(dir, `scenario-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  if (env) env.FAKE_CODEX_SCENARIO = file;
  return file;
}
