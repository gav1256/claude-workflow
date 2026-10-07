// Test helpers for the model-coordinator suite. Every path is a fresh temp folder; nothing touches the real
// ~/.claude. Later tasks append to this file (lunaLikePolicy, fakeClaudeRunner, FAKE_CODEX_CLI, ...).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.dirname(TESTS_DIR);

let counter = 0;

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * A complete test environment: temp CFG, CODEX_HOME, handoff registry and TEMP stand-in, HL_NO_SPAWN, HL_FAKE_CLAUDE,
 * an empty fake `claude agents --json` file, and unique pipe names. Returns an env object (a copy of process.env plus
 * the test settings). Non-enumerable extras: `root` and `dirs`, and `cleanup()` (removes the temp root).
 */
export function mcEnv(extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-t-")));
  const dirs = {
    cfg: path.join(root, "cfg"),
    codexHome: path.join(root, "codex-home"),
    registry: path.join(root, "registry"),
    temp: path.join(root, "temp"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const agents = path.join(root, "agents.json");
  fs.writeFileSync(agents, "[]");
  const n = ++counter;
  const env = { ...process.env };
  for (const k of ["HL_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "HL_SKILL_DIR", "MC_CODEX_SKILL_DIR"]) delete env[k];
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: dirs.cfg,
    CODEX_HOME: dirs.codexHome,
    HL_REGISTRY_DIR: dirs.registry,
    HL_NO_SPAWN: "1",
    HL_FAKE_CLAUDE: "1",
    HL_AGENTS_JSON: agents,
    MC_PIPE_NAME: `mc-test-${process.pid}-${n}`,
    CODEX_RUN_PIPE_PREFIX: `codex-run-mc-${process.pid}-${n}-`,
  }, extra);
  Object.defineProperty(env, "root", { value: root, enumerable: false });
  Object.defineProperty(env, "dirs", { value: dirs, enumerable: false });
  Object.defineProperty(env, "cleanup", { value: () => rmrf(root), enumerable: false });
  return env;
}

/** Runs `fn` with process.env replaced by `env` (keys not in env are removed), then restores it. Works for async fn. */
export async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

let importN = 0;
/** Dynamic import of a module relative to the skill folder (e.g. "store.mjs") with a cache-busting query. */
export function importFresh(rel) {
  const url = new URL(`../${rel}`, import.meta.url);
  url.search = `?t=${++importN}`;
  return import(url.href);
}

/** A directory junction `link` -> `target` (cmd /c mklink /J, no admin needed). Point it only at temp folders. */
export function mkJunction(link, target) {
  const cmdExe = process.env.ComSpec || "C:\Windows\System32\cmd.exe";
  const r = spawnSync(cmdExe, ["/d", "/s", "/c", `"mklink /J "${link}" "${target}""`], {
    windowsHide: true, windowsVerbatimArguments: true, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`mklink /J failed: ${r.stdout}${r.stderr}`);
}

/** Removes a junction (the link only): rmdir on a junction never touches its target. */
export function rmJunction(link) {
  try { fs.rmdirSync(link); } catch { /* already gone, or not a junction */ }
}
