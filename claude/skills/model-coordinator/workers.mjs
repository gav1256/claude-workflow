// The worker table: a pure fold over the events in workers.jsonl. No file access here (store.mjs reads and writes).
//
// Events: {ev:"created", id, provider, label, objective, repo, worktree, branch, lane, created_at,
//          in_worktree_of?, fallback_of?, fallback_reason?, aliases?, status?}
//         {ev:"alias", worker_id, alias}
//         {ev:"status", worker_id, status, summary?, changes?, blockers?, needs_user?, files_changed?, current_task?}
//         Any event may carry `at` (ISO string or epoch ms): the event time. finished_at is the `at` of the event that
//         moved the worker into finished/dead (null when unknown, or when the worker is live).
//         {ev:"placed", worker_id, worktree?, branch?}   (the worktree and branch the launch really made; the created event holds
//          a prediction made before the launch)
//         {ev:"focus", worker_id | null}
//         {ev:"ended", worker_id, why}      (folds to status "dead")

const FINISHED = new Set(["finished", "dead"]);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const strs = (v) => (Array.isArray(v) ? v.map(str) : []);

/** @returns {Map<string, object>} workers by id, in creation order. */
export function foldWorkers(lines) {
  const m = new Map(), ended = new Set(); // ended is terminal: a late status event must not revive a worker
  for (const ev of lines ?? []) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.ev === "created") {
      const id = ev.id ?? ev.worker_id;
      if (typeof id !== "string" || !id || m.has(id)) continue;
      const w = {
        id, provider: ev.provider, label: ev.label, aliases: strs(ev.aliases), objective: str(ev.objective),
        repo: ev.repo ?? null, worktree: ev.worktree ?? null, branch: ev.branch ?? null, lane: ev.lane ?? null,
        status: ev.status ?? "starting", current_task: str(ev.current_task), last_result: "", blockers: [],
        needs_user: false, changes: [], files_changed: [], created_at: ev.created_at ?? null, finished_at: null,
      };
      for (const k of ["in_worktree_of", "fallback_of", "fallback_reason"]) if (ev[k] != null) w[k] = ev[k];
      m.set(id, w);
      continue;
    }
    const w = m.get(ev.worker_id);
    if (!w) continue;
    if (ev.ev === "alias") {
      if (typeof ev.alias === "string" && !w.aliases.includes(ev.alias)) w.aliases.push(ev.alias);
    } else if (ev.ev === "placed") {
      if (typeof ev.worktree === "string" && ev.worktree) w.worktree = ev.worktree;
      if (typeof ev.branch === "string" && ev.branch) w.branch = ev.branch;
    } else if (ev.ev === "status") {
      if (ended.has(w.id)) continue;
      if (typeof ev.status === "string") {
        const was = FINISHED.has(w.status);
        w.status = ev.status;
        if (!FINISHED.has(w.status)) w.finished_at = null;
        else if (!was) w.finished_at = ev.at ?? null;
      }
      if (ev.summary !== undefined) w.last_result = str(ev.summary);
      if (ev.current_task !== undefined) w.current_task = str(ev.current_task);
      if (ev.changes !== undefined) w.changes = strs(ev.changes);
      if (ev.blockers !== undefined) w.blockers = strs(ev.blockers);
      if (ev.files_changed !== undefined) w.files_changed = strs(ev.files_changed);
      if (ev.needs_user !== undefined) w.needs_user = ev.needs_user;
    } else if (ev.ev === "ended") {
      if (!FINISHED.has(w.status)) w.finished_at = ev.at ?? null;
      w.status = "dead";
      ended.add(w.id);
    }
  }
  return m;
}

/** `<label>-NN`, starting at 01, one above the highest number ever used for the label (ended workers stay in the table). */
export function nextWorkerId(label, workers) {
  const ids = workers instanceof Map ? [...workers.keys()] : Array.isArray(workers) ? workers.map((w) => w.id) : [];
  const prefix = `${label}-`;
  let max = 0;
  for (const id of ids) {
    if (typeof id !== "string" || !id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

/** The focused worker id: the last focus event's worker_id (null clears), or null. */
export function focusOf(lines) {
  let f = null;
  for (const ev of lines ?? []) if (ev && ev.ev === "focus") f = ev.worker_id ?? null;
  return f;
}

const cap = (s, n) => str(s).slice(0, n);

/** A WorkerSummary (what Luna sees): objective 200, current_task 300, last_result 200 characters, 3 blockers. */
export function toSummary(w) {
  return {
    id: w.id, provider: w.provider, label: w.label, aliases: [...(w.aliases ?? [])], status: w.status,
    objective: cap(w.objective, 200), current_task: cap(w.current_task, 300), last_result: cap(w.last_result, 200),
    blockers: (w.blockers ?? []).slice(0, 3).map((b) => cap(b, 200)),
  };
}
