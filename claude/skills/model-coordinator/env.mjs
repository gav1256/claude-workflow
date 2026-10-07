// Child environments for processes the coordinator starts. Neither builder mutates process.env.
// Credentials never reach a child (matched case-insensitively): the model coordinator holds the API key, workers do not.
export const CREDENTIAL_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_RUN_ENV_ALLOW"];

const CRED = new Set(CREDENTIAL_ENV);
const up = (k) => k.toUpperCase();
const entries = () => Object.entries(process.env).filter(([, v]) => v !== undefined);

/**
 * For launch.mjs and `launch.mjs resume --closed`: the same rule as launcherEnv() in handoff-launch/live.mjs (keeps HL_*
 * and CLAUDE_CONFIG_DIR, drops HL_SESSION_ID and CLAUDE_CODE_SESSION_ID) plus the credential strip. `extra` goes last.
 */
export function launchEnv({ extra = {} } = {}) {
  return {
    ...Object.fromEntries(entries().filter(([k]) => {
      const u = up(k);
      return u !== "HL_SESSION_ID" && u !== "CLAUDE_CODE_SESSION_ID" && !CRED.has(u);
    })),
    ...extra,
  };
}

/**
 * For codex-run.mjs and the `claude --resume --bg` wake: the strict strip. Drops the credentials, every HL_*, every CLAUDE*
 * except CLAUDE_CONFIG_DIR, AI_AGENT and CLAUDE_CODE_SESSION_ID. `extra` goes last.
 */
export function childEnv({ extra = {} } = {}) {
  return {
    ...Object.fromEntries(entries().filter(([k]) => {
      const u = up(k);
      if (CRED.has(u) || u === "AI_AGENT" || u === "CLAUDE_CODE_SESSION_ID" || u.startsWith("HL_")) return false;
      return !u.startsWith("CLAUDE") || u === "CLAUDE_CONFIG_DIR";
    })),
    ...extra,
  };
}
