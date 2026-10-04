// Coordinator hook entry (stage 2 of handoff-launch). Subcommands:
//   post-tool   PostToolUse hook of launcher sessions (launch.mjs passes it with --settings): stop delivery, notices
//               for looping subagents, the early warning and the tick trigger. Prints at most one additionalContext.
//   notify      Notification hook: records waiting_since, for permission prompts only.
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any error: exit 0 and no
// output - a broken hook must never block a tool call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// <config>/hooks/coord.mjs -> <config>/skills/handoff-launch (the repo has the same layout). HL_SKILL_DIR: tests.
const SKILL = path.resolve(process.env.HL_SKILL_DIR || path.join(HERE, "..", "skills", "handoff-launch"));
const mod = (f) => import(pathToFileURL(path.join(SKILL, f)).href);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const readJson = (f, d) => { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return isObj(v) ? v : d; } catch { return d; } };
const str = (v) => typeof v === "string" && v !== "";
// A session id names this session's state file: a plain id only, never a path.
const plainId = (v) => str(v) && /^[\w-]+$/.test(v);

async function context() {
  const [V, L] = await Promise.all([mod("live.mjs"), mod("recover-lib.mjs")]);
  let text = null; try { text = fs.readFileSync(path.join(V.COORD, "config.json"), "utf8"); } catch {}
  return { V, L, cfg: L.loadConfig(text).config };
}

// Steps 1-5 of the spec's "Prevention: the session hook". Writes only this session's state file and, for a delivered
// stop, this session's {stop_delivered} line.
export async function postTool(input, env = process.env) {
  const regId = env.HL_SESSION_ID, sid = input?.session_id;
  if (!regId || !plainId(sid) || !input.tool_name) return null;
  const { V, L, cfg } = await context();
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`);
  // Corrupt shapes are skipped: a stop without a token and a text, or a looping entry without a key, is never acted on.
  const stops = ["ladder", "close", "manual"].map((c) => readJson(path.join(V.STOP_DIR, `${V.stem(regId)}.${c}.stop.json`), null))
    .filter((s) => s?.id === regId && str(s.token) && str(s.text));
  const mine = readJson(path.join(V.COORD, "looping.json"), {})[sid];
  const looping = isObj(mine) ? Object.fromEntries(Object.entries(mine).filter(([, a]) => isObj(a) && str(a.key))) : {};
  const r = L.postToolSteps(readJson(stateFile, {}), { agentId: input.agent_id || null, key: L.callKey(input.tool_name, input.tool_input) },
    { stops, looping, cfg, now: Date.now() });
  V.writeAtomic(stateFile, JSON.stringify(r.state));
  if (r.delivered) V.append({ stop_delivered: regId, token: r.delivered, at: V.now() });
  V.triggerTick("post-tool", cfg.tick_min);
  return r.context;
}
// Probe 2 recorded the type field: a permission prompt, not an idle prompt, makes the session "waiting for the user".
export const isPermission = (i) => (i?.notification_type ? i.notification_type === "permission_prompt" : /permission/i.test(String(i?.message || "")));
export async function notify(input, env = process.env) {
  if (!env.HL_SESSION_ID || !plainId(input?.session_id) || !isPermission(input)) return;
  const { V } = await context();
  const f = path.join(V.COORD, "sessions", `${input.session_id}.json`);
  V.writeAtomic(f, JSON.stringify({ ...readJson(f, {}), waiting_since: V.now() }));
}

const stdin = () => { try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; } };
async function main(argv) {
  const sub = argv[0];
  if (sub === "post-tool") {
    const c = await postTool(stdin());
    // Wait for the write before process.exit (a pipe may flush asynchronously); a closed pipe is ignored, not thrown.
    if (c) await new Promise((done) => { process.stdout.on("error", done); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: c } }), done); });
  } else if (sub === "notify") await notify(stdin());
}
const self = (p) => path.resolve(p || "").toLowerCase();
if (self(process.argv[1]) === self(fileURLToPath(import.meta.url))) {
  try { await main(process.argv.slice(2)); } catch {}
  process.exit(0);
}
