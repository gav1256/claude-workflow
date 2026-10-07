// The coordinator's config: DEFAULTS merged with <state>/config.json. The file is read only; the coordinator never writes it.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { secretsDir, stateDir } from "./paths.mjs";

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v !== null && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

export const DEFAULTS = deepFreeze({
  provider: "none",
  openai: { model: "gpt-6-luna", key_file: null, reasoning_effort: "none", timeout_ms: 20000, max_retries: 2, max_output_tokens: 600 },
  pricing: {},
  limits: { monthly_soft_usd: 7, monthly_hard_usd: 10 },
  min_confidence: 0.6,
  codex: { max_parallel_jobs: 2, model: "sol", effort: "medium", queue_max: 4, fallback: "claude", login_cache_ms: 300000 },
  claude: { model: "opus", effort: "high" },
  context: { target_tokens: 2000, max_tokens: 3000, exchanges: 5 },
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : Array.isArray(v) ? v.map(clone) : v);

/** Recursive merge: plain objects merge key by key; every other value (arrays, null, scalars) replaces. */
function merge(base, over) {
  const out = clone(base);
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
  return out;
}

/** realpath of `p`, or of its deepest existing ancestor with the missing tail appended (so a not-yet-created file still resolves). */
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    if (existsSync(cur)) {
      try { return path.join(realpathSync(cur), ...tail); } catch { return null; }
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    tail.unshift(path.basename(cur));
    cur = up;
  }
}

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

function keyFileInsideSecrets(keyFile) {
  const root = realish(secretsDir());
  const target = realish(path.resolve(secretsDir(), keyFile));
  if (!root || !target) return false;
  const rel = path.relative(norm(root), norm(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function validate(config, errors) {
  const reset = (pathKeys, defaults) => {
    let t = config, d = defaults;
    for (const k of pathKeys.slice(0, -1)) { t = t[k]; d = d[k]; }
    const last = pathKeys.at(-1);
    t[last] = clone(d[last]);
  };
  const bad = (pathKeys, msg) => { errors.push(`${pathKeys.join(".")}: ${msg}`); reset(pathKeys, DEFAULTS); };

  if (!["none", "openai"].includes(config.provider)) bad(["provider"], 'must be "none" or "openai"');
  if (typeof config.claude.model !== "string" || !config.claude.model.trim()) bad(["claude", "model"], "must be a non-empty string");
  else if (/sonnet|haiku/i.test(config.claude.model)) bad(["claude", "model"], "sonnet and haiku Claude workers are not allowed (launch.mjs refuses them)");
  const fb = config.codex.fallback;
  if (fb === "paid_api") bad(["codex", "fallback"], "paid_api fallback is not supported in V1 (deferred)");
  else if (fb !== "claude" && fb !== "refuse") bad(["codex", "fallback"], 'must be "claude" or "refuse"');
  const re = config.openai.reasoning_effort;
  if (re !== null && (typeof re !== "string" || !re.trim())) bad(["openai", "reasoning_effort"], "must be a non-empty string or null");
  const mp = config.codex.max_parallel_jobs;
  if (!Number.isInteger(mp) || mp < 1 || mp > 3) bad(["codex", "max_parallel_jobs"], "must be an integer from 1 to 3");
  const kf = config.openai.key_file;
  if (kf !== null && (typeof kf !== "string" || !kf.trim() || !keyFileInsideSecrets(kf))) bad(["openai", "key_file"], "must be a file inside the secrets folder");
}

/**
 * -> {config, errors}. `config` is always complete: a field that failed validation is reset to its default, and the
 * failure is listed in `errors` (strings), so the caller can refuse to start without ever seeing an unsafe value.
 */
export function loadConfig() {
  const errors = [];
  let user = {};
  const file = path.join(stateDir(), "config.json");
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, "utf8"));
      if (!isObj(user)) { errors.push("config.json: must be a JSON object"); user = {}; }
    } catch (e) {
      errors.push(`config.json: ${e.message}`);
      user = {};
    }
  }
  const config = merge(DEFAULTS, user);
  for (const section of ["openai", "pricing", "limits", "codex", "claude", "context"]) {
    if (!isObj(config[section])) { errors.push(`${section}: must be an object`); config[section] = clone(DEFAULTS[section]); }
  }
  validate(config, errors);
  return { config, errors };
}
