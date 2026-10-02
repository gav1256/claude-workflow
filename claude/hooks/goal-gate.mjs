// Goal gate — a Stop hook that keeps Claude working until the session's goal is met,
// without an endless loop. No model call: it only reads a goal file Claude maintains.
//
// Contract (see ~/.claude/CLAUDE.md "Goal gate"):
//   <session scratchpad>/GOAL.md holds checklist lines:
//     - [ ] open criterion        (keeps the session going)
//     - [x] done — evidence: ...  (met, with proof)
//     - [!] blocked — reason: ... (needs the user / impossible; lets the session stop)
//
// Loop guards: at most MAX_BLOCKS continuations per user turn; a continuation that leaves
// GOAL.md unchanged gets ONE "report honestly" block, then the gate lets go; a turn that
// ends with a question to the user is never blocked; a goal file older than STALE_HOURS
// is ignored. Any error fails OPEN (allows the stop).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const MAX_BLOCKS = Number(process.env.GOAL_GATE_MAX ?? 3);
const STALE_HOURS = Number(process.env.GOAL_GATE_STALE_HOURS ?? 12);

const allow = (systemMessage) => {
  if (systemMessage) process.stdout.write(JSON.stringify({ systemMessage }));
  process.exit(0);
};
const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
};

let input;
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { allow(); }
if (process.env.GOAL_GATE_LOG) {
  try { fs.appendFileSync(process.env.GOAL_GATE_LOG, JSON.stringify({ at: new Date().toISOString(), ...input, last_assistant_message: String(input.last_assistant_message ?? "").slice(0, 120) }) + "\n"); } catch {}
}

try {
  // The Stop input carries session_id + transcript_path (no scratchpad_dir on 2.1.281, verified 2026-09-24).
  // The session scratchpad is <tmp>/claude/<project key>/<session id>/scratchpad, where the project key is the
  // transcript's folder name. Fallback: ~/.claude/goals/<session id>.md.
  const sid = input.session_id;
  if (!sid) allow();
  const candidates = [];
  if (input.scratchpad_dir) candidates.push(path.join(input.scratchpad_dir, "GOAL.md"));
  if (input.transcript_path) {
    const key = path.basename(path.dirname(input.transcript_path));
    candidates.push(path.join(os.tmpdir(), "claude", key, sid, "scratchpad", "GOAL.md"));
  }
  candidates.push(path.join(os.homedir(), ".claude", "goals", `${sid}.md`));
  const goalPath = candidates.find((p) => fs.existsSync(p));
  if (!goalPath) allow();
  const dir = path.dirname(goalPath);
  const stat = fs.statSync(goalPath);
  if (Date.now() - stat.mtimeMs > STALE_HOURS * 3600e3) allow();

  const text = fs.readFileSync(goalPath, "utf8");
  const open = text.split(/\r?\n/).filter((l) => /^\s*[-*]\s*\[ \]/.test(l)).map((l) => l.trim());
  const statePath = path.join(dir, `.goal-gate-${sid}.json`);
  const hash = crypto.createHash("sha1").update(text).digest("hex");
  let state = { blocks: 0, lastHash: null, finalAsked: false };
  if (input.stop_hook_active) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(statePath, "utf8")) }; } catch {}
  }
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state));

  if (open.length === 0) { fs.rmSync(statePath, { force: true }); allow(); }

  const last = String(input.last_assistant_message ?? "").trim();
  if (last.endsWith("?")) allow(); // waiting on the user — not a premature stop
  // Waiting on background work is not a premature stop: its completion re-invokes the session.
  if (Array.isArray(input.background_tasks) && input.background_tasks.length > 0) allow();

  if (state.blocks >= MAX_BLOCKS) {
    fs.rmSync(statePath, { force: true });
    allow(`Goal gate: ${open.length} criterion(s) still open after ${MAX_BLOCKS} continuations — stopped to avoid a loop. See GOAL.md in the session scratchpad.`);
  }

  if (state.blocks > 0 && state.lastHash === hash) {
    if (state.finalAsked) { fs.rmSync(statePath, { force: true }); allow(); }
    state.finalAsked = true; state.blocks += 1; save();
    block(
      "Goal gate: GOAL.md did not change during the last continuation, so repeating won't help. " +
      "Do not retry the same approach. For each open criterion either finish it with a genuinely different approach, " +
      "or mark it `[!] blocked — reason: <the concrete blocker or the decision you need from the user>`. " +
      "Then give the user an honest status: what is done (with evidence), what is blocked and why."
    );
  }

  state.blocks += 1; state.lastHash = hash; save();
  block(
    `Goal gate (continuation ${state.blocks}/${MAX_BLOCKS}): the session goal is not met yet. Open criteria in ${goalPath}:\n` +
    open.map((l) => `  ${l}`).join("\n") +
    "\nKeep working on them. Tick `[x]` only with evidence (command output, test result, file:line). " +
    "If one needs the user's decision or is impossible, mark it `[!] blocked — reason: ...` instead of looping. " +
    "If you learned something non-obvious on the way, record it per the 'Learning across sessions' rules before you finish."
  );
} catch {
  allow();
}
