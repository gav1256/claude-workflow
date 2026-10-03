// Pure helpers for rolling merges in handoff-launch fan-out groups. No fs, no git, no clock: callers pass everything
// in, so tests/merge-lib.test.mjs covers every decision directly.
import path from "node:path";

export const slug = (s) => String(s).replace(/[^\w.-]+/g, "-").slice(0, 60);
export const fwd = (p) => p.split(path.sep).join("/");
export const key = (p) => fwd(path.resolve(p)).toLowerCase();

// <group>-merge is the legacy all-lanes merge session; <group>-merge-<lane> resolves one lane. Neither is a lane.
export const isMergeSession = (group, name) => name === `${group}-merge` || String(name).startsWith(`${group}-merge-`);

// config.json, written once by the fan-out controller (launch.mjs group).
export function validateConfig(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, errors: ["config.json must be a JSON object"] };
  const errors = [];
  for (const k of ["integration", "target"]) if (typeof o[k] !== "string" || !o[k].trim()) errors.push(`${k} must be a non-empty branch name`);
  if (!errors.length && o.integration === o.target) errors.push("integration and target must differ (the target changes only in the human-approved final merge)");
  if (o.test != null && (typeof o.test !== "string" || !o.test.trim())) errors.push("test must be a non-empty command when given");
  const timeout = o.test_timeout_min ?? 30, mode = o.mode ?? "window";
  if (!(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) errors.push("test_timeout_min must be a positive number");
  if (mode !== "window" && mode !== "bg") errors.push("mode must be window or bg");
  return errors.length ? { ok: false, errors }
    : { ok: true, config: { integration: o.integration, target: o.target, test: o.test || null, test_timeout_min: timeout, mode } };
}

// merge.lock: {holder:"drain", token, pid, lane, at} while this code merges, {holder:"session", token, session, lane,
// head, at} while a merge session resolves a lane. Anything else (the legacy launch guard is an empty file) is legacy.
export function parseLock(text) {
  if (text == null) return null;
  try { const o = JSON.parse(text); if (o && (o.holder === "drain" || o.holder === "session")) return o; } catch {}
  return { holder: "legacy" };
}
// drain-dead: the merging process is gone, safe to reclaim. drain-old: alive but older than maxAgeMs (PID reuse or a
// hung test): reported, never reclaimed automatically.
export function lockState(lock, { pidAlive, now, maxAgeMs }) {
  if (lock.holder !== "drain") return lock.holder;
  if (!pidAlive(lock.pid)) return "drain-dead";
  return now - Date.parse(lock.at) > maxAgeMs ? "drain-old" : "drain-live";
}
export function lockHint(state) {
  return state === "drain-dead" ? " (STALE: the merging process is gone - the next merge reclaims the lock)"
    : state === "drain-old" ? " (older than the test timeout - check that process, then merge --force clears it)"
    : state === "legacy" ? " (a legacy merge.lock in a rolling group - merge --force clears it)" : "";
}
export const describeLock = (lock) => (!lock ? "nobody"
  : lock.holder === "session" ? `merge session ${lock.session} (lane ${lock.lane})`
  : lock.holder === "drain" ? `merge process ${lock.pid} (lane ${lock.lane}, since ${lock.at})`
  : "a legacy merge launch");

// lanes: [{name, branch, entry, marker: object|null|{unreadable:true}, merged, mergedSha, mergeBlocked}]
export function classify(lanes) {
  return lanes.map((l) => {
    const m = l.marker, status = String(m?.status ?? "done");
    const state = !m ? "open"
      : m.unreadable ? "unreadable"
      : status === "blocked" ? "blocked"
      : status !== "done" || !m.head ? "invalid"
      : l.merged ? "merged"
      : l.mergeBlocked ? "merge-blocked"
      : "queued";
    return { ...l, state };
  });
}
export function mergeQueue(classified, prefer) {
  const q = classified.filter((l) => l.state === "queued")
    .sort((a, b) => String(a.marker.at ?? "").localeCompare(String(b.marker.at ?? "")) || a.name.localeCompare(b.name));
  const i = prefer ? q.findIndex((l) => l.name === prefer) : -1;
  if (i > 0) q.unshift(...q.splice(i, 1));
  return q;
}
export const finalReady = (classified) => classified.length > 0
  && classified.every((l) => l.state === "merged" || l.state === "blocked" || l.state === "merge-blocked");

export function overlapPairs(finished, running) {
  const out = [];
  for (const f of finished) {
    const mine = new Set(f.files);
    for (const r of running) {
      if (r.name === f.name) continue;
      const files = [...new Set(r.files)].filter((x) => mine.has(x)).sort();
      if (files.length) out.push({ finished: f.name, running: r.name, files });
    }
  }
  return out;
}

export function mergeTag(l) {
  return l.state === "merged" ? `MERGED${l.mergedSha ? ` ${l.mergedSha.slice(0, 7)}` : ""}`
    : l.state === "queued" ? "QUEUED"
    : l.state === "merge-blocked" ? `MERGE-BLOCKED (${l.mergeBlocked})`
    : l.state === "invalid" ? "INVALID marker (needs a head and status done or blocked - not merged)" : "";
}
// The legacy summary keys first (lanes and controllers parse them), then the rolling ones. merge_launched means a
// merge session holds the lock right now.
export function rollingSummary(classified, lock, { state = null, sessionClosed = false } = {}) {
  const done = classified.filter((l) => l.marker && !l.marker.unreadable).length;
  const merged = classified.filter((l) => l.state === "merged").length;
  const holder = !lock ? "none" : lock.holder === "session" ? `${lock.session}(${lock.lane})`
    : lock.holder === "drain" ? `pid${lock.pid}(${lock.lane})` : "legacy";
  const hint = sessionClosed ? ` (STALE: ${lock.session} closed without merging ${lock.lane} - merge --force retries it, merge --skip ${lock.lane} --why <reason> gives up on it)` : lockHint(state);
  return `members=${classified.length} done=${done} all_done=${classified.length > 0 && done === classified.length}`
    + ` merge_launched=${lock?.holder === "session"} merge_lock=${!!lock} merged=${merged}`
    + ` queue=[${mergeQueue(classified).map((l) => l.name).join(",")}] merge_holder=${holder} final_ready=${finalReady(classified)}${hint}`;
}

export const legacyText = (group) => `legacy group ${group} (no config.json): lanes are merged once all are done - run `
  + `status --group ${group}, and on all_done=true merge_launched=false launch the group's merge handoff as ${group}-merge `
  + "(handoff-launch SKILL.md section 4, legacy groups)";
export function finalReadyText(group, cfg, lanes) {
  const next = Object.fromEntries(lanes.filter((l) => l.marker?.next_after_merge?.length).map((l) => [l.name, l.marker.next_after_merge]));
  const notMerged = lanes.filter((l) => l.state !== "merged").map((l) => l.name);
  return `FINAL_READY ${group}: every lane is merged or blocked${notMerged.length ? ` (not merged: ${notMerged.join(", ")})` : ""}`
    + ` - ${cfg.integration} is ready for the final merge into ${cfg.target}, which needs the user's approval`
    + ` (never push without asking). next_after_merge=${JSON.stringify(next)}`;
}

const fence = (s) => { const t = String(s); let f = "`".repeat(3); while (t.includes(f)) f += "`"; return `${f}\n${t}\n${f}`; };
// The handoff a merge session <group>-merge-<lane> starts from. p: {group, lane, branch, head, integration, target, wt,
// before, reason: "conflict"|"test-failed", conflicts, output, code, exit, test, overlap, launchMjs, root, at, session}
// session: this merge session's name (default <group>-merge-<lane>, slugged as launchMergeSession names it); its skip
// command passes it, because `merge --skip` refuses a running holder's lane to anyone else.
// exit: optional text for how the test ended (e.g. "killed: no result after 120 s"); default `exit <code>`.
export function conflictHandoff(p) {
  const merge = `node ${p.launchMjs} merge --group ${p.group} --repo ${p.root}`;
  const why = p.reason === "conflict" ? `git merge stopped on conflicts in ${p.conflicts.length} file(s)`
    : `the test command failed (${p.exit ?? `exit ${p.code}`}) after a clean merge`;
  const overlap = Object.entries(p.overlap || {}).map(([r, f]) => `  - running lane ${r}: ${f.join(", ")}`);
  return [
    `# Handoff: merge lane ${p.lane} into ${p.integration} (group ${p.group})`, "",
    `Generated by launch.mjs merge at ${p.at}. The group's merge.lock is held for this session: nothing else merges`,
    "until step 5 releases it.", "",
    "## State",
    `- Main repo: ${p.root}`,
    `- Merge worktree (this session's cwd): ${p.wt}, branch \`${p.integration}\`, HEAD ${p.before}`,
    `- Lane \`${p.lane}\`: branch \`${p.branch}\`, done-marker head ${p.head}`,
    `- Why a session: ${why}.`,
    ...(p.conflicts?.length ? ["- Conflicting files:", ...p.conflicts.map((f) => `  - ${f}`)] : []),
    `- Test command: ${p.test ? `\`${p.test}\`` : "(none configured)"}`,
    ...(overlap.length ? ["- Files this lane shares with lanes still running (they merge later):", ...overlap] : []),
    ...(p.output ? ["", "## Output", fence(p.output)] : []),
    "", "## Steps",
    `1. In the merge worktree: \`git merge --no-ff --no-commit ${p.head}\`.`,
    "2. Resolve every conflict so both sides' intent survives (read the lane's commits and the integration branch's). If the test failed, fix the code.",
    `3. Run the test command until it passes${p.test ? `: \`${p.test}\`` : ""}.`,
    `4. Commit the merge (\`git commit -m "Merge lane ${p.lane} into ${p.integration}"\`). Never push, never touch \`${p.target}\`, never edit a lane's worktree.`,
    `5. Run \`${merge}\` and report its output. It sees ${p.lane} merged, releases the lock and merges the next finished lanes.`,
    `If it cannot be resolved: \`git merge --abort\`, then \`${merge} --skip ${p.lane} --session ${p.session ?? slug(`${p.group}-merge-${p.lane}`)} --why "<reason>"\`, and tell the user.`,
    "", "## THE PROMPT",
    `You are the merge session for lane ${p.lane} of fan-out group ${p.group}. Your cwd is the merge worktree ${p.wt}.`
      + " Do the Steps above in order, then stop and report. Size any reviewer dispatch with sizing-dispatches.",
    "",
  ].join("\n");
}
