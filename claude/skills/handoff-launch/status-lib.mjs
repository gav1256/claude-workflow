// Lane status for the model coordinator: one row per lane (newest launch), classified open / unknown / finished /
// paused / closed_unfinished. classify and laneStatus are pure: callers pass liveness, goal and marker probes, so tests
// need no processes. liveLaneStatus is the impure wrapper (it reads the real registry and probes).
import fs from "node:fs";
import { pausedLineOf, lanePauseKey } from "./pause-lib.mjs";
import { readRegistry, liveness, primeLiveness, goalOf } from "./live.mjs";
import { parseGoal } from "./recover-lib.mjs";

// First match wins. Every real close writes {kill_intent, kind: "close"} first, so a kill_intent alone never means
// finished. gone(e): "running" | "gone" | "unknown".
export function classify(e, { lines, closedIds, gone, doneMarker, goal }) {
  const live = gone(e);
  if (live === "running") return { state: "open", reason: "running" };
  if (live === "unknown") return { state: "unknown", reason: "liveness unknown" };
  if (doneMarker) return { state: "finished", reason: "done marker" };
  if (goal && goal.items?.length && goal.open === 0 && goal.blocked === 0) return { state: "finished", reason: "goal complete" };
  const closed = [...lines].reverse().find((o) => o.closed && (o.id ?? o.closed) === e.id);
  const p = pausedLineOf(lines, e); // counts only {paused: e.id, source: <string>} lines at or after the launch
  if (closed?.pause === true || p) return { state: "paused", reason: `paused: ${p?.reason ?? p?.source ?? closed?.why ?? "unknown"}` };
  if (/^claude exited/.test(closed?.why ?? "")) return { state: "closed_unfinished", reason: "claude exited" };
  if (lines.some((o) => o.dead_start === e.id)) return { state: "closed_unfinished", reason: "failed to start" };
  // A lane the loop ladder killed (kind "ladder") or the coordinator blocked ({lane_blocked}, written by a failed restart
  // or a dead start) with no newer launch is not finished: this entry is the lane's newest, so no relaunch followed.
  if (lines.some((o) => o.kill_intent === e.id && o.kind === "ladder")
    || lines.some((o) => o.lane_blocked === e.name && (o.group ?? null) === (e.group || null) && (Date.parse(o.at) || 0) >= (Date.parse(e.launched_at) || 0))) {
    return { state: "closed_unfinished", reason: "blocked after loop ladder" };
  }
  if (!closedIds.has(e.id)) return { state: "closed_unfinished", reason: "crashed or window closed" };
  return { state: "finished", reason: `closed: ${closed?.why ?? "no reason"}` };
}

export function laneStatus(reg, { gone, readGoal, markerExists }) {
  const newest = new Map();
  for (const e of reg.entries) {
    const k = lanePauseKey(e), cur = newest.get(k);
    if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(k, e);
  }
  return [...newest.values()].map((e) => {
    const goal = readGoal(e);
    const { state, reason } = classify(e, { lines: reg.lines, closedIds: reg.closed, gone, doneMarker: !!markerExists(e), goal });
    return { id: e.id, name: e.name, repo: e.repo ?? null, group: e.group ?? null, branch: e.branch ?? null, mode: e.mode ?? null,
      state, reason, goal: goal?.goal ?? null, launched_at: e.launched_at, session_id: e.session_id ?? null,
      bg_id: e.bg_id ?? null, worktree: e.worktree ?? null };
  });
}

export const closedUnfinished = (rows) => rows.filter((r) => r.state === "closed_unfinished");

// The impure wrapper: the real registry, the real liveness probes, the lane's GOAL.md and done marker.
export function liveLaneStatus() {
  const reg = readRegistry();
  primeLiveness(reg.entries);
  return laneStatus(reg, {
    gone: (e) => liveness(e, reg).state,
    readGoal: (e) => {
      try { const p = e.session_id && goalOf(e.session_id); return p ? parseGoal(fs.readFileSync(p, "utf8")) : null; } catch { return null; }
    },
    markerExists: (e) => !!e.done_marker && fs.existsSync(e.done_marker),
  });
}
