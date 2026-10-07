// Where the model coordinator keeps things. Everything is computed at call time from the environment, never at import.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const cfgDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
export const stateDir = () => path.join(cfgDir(), "state", "model-coordinator");
export const secretsDir = () => path.join(cfgDir(), "secrets");
/** The sibling handoff-launch skill (the repo layout and the deployed layout both have it next to this folder). */
export const HL_DIR = path.resolve(HERE, "..", "handoff-launch");

/** The dispatching-codex skill: MC_CODEX_SKILL_DIR, else the deployed sibling, else the repo layout, else null. */
export function codexSkillDir() {
  const env = process.env.MC_CODEX_SKILL_DIR;
  if (env) return env;
  for (const c of [path.resolve(HERE, "..", "dispatching-codex"), path.resolve(HERE, "..", "..", "..", "optional", "codex", "skills", "dispatching-codex")]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** The mailbox key of a lane name: sha1(name).slice(0, 16). */
export const msgKey = (laneName) => crypto.createHash("sha1").update(String(laneName)).digest("hex").slice(0, 16);
