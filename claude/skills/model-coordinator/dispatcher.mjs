// The dispatcher: turns one validated CoordinatorDecision into worker actions, once per request id (idempotent), and keeps the
// worker table and coordinator_records.md current. Model text only ever travels as the text of a message, a brief or an objective;
// it is never a path, a command or a file write. The only file model text reaches is coordinator_records.md (record_update notes),
// through renderRecords, which takes no path. All writes go through the store passed in (store.mjs).
//
// Ledgers: dispatch.jsonl holds {request_id, turn_id, action, targets, state: "intent"} before acting and
// {request_id, state: "done" | "failed", results, reply, focus} after. A `done` line answers a repeat of the request with the stored
// result. An `intent` with no `done` (a crash) acts again: the acts are idempotent (message files are writeNew by request id,
// a create finds the worker it already made, Codex attempts are keyed by request id).
import crypto from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import { foldWorkers, nextWorkerId, focusOf } from "./workers.mjs";
import { renderRecords } from "./records.mjs";
import { fallbackFor } from "./codex-resources.mjs";
import { FINISHED } from "./validate.mjs";
import { readRegistry, liveness, latestLaunch } from "../handoff-launch/live.mjs";

const cap = (s, n) => String(s ?? "").slice(0, n);
/** One spelling per place: absolute, dot segments gone, the real path when it exists, forward slashes, no trailing slash, case-folded on Windows. */
export function canonPath(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  let r = path.resolve(p.trim());
  try { r = realpathSync.native(r); } catch { /* not there (yet): the resolved spelling stands */ }
  r = r.split(path.sep).join("/").replace(/\/+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}
/** `refs/heads/x` and `x` are one branch. */
export const canonBranch = (b) => (typeof b === "string" && b.trim() ? b.trim().replace(/^refs\/heads\//, "") : null);
const same = (a, b) => { const x = canonPath(a); return !!x && x === canonPath(b); };
const sameBranch = (a, b) => { const x = canonBranch(a); return !!x && x === canonBranch(b); };

/** sha256(turnId | action | sorted targets | worker_instruction ?? "" | label ?? ""), 32 hex characters. */
export function requestIdOf(turnId, d) {
  const key = [String(turnId ?? ""), d.action, [...(d.target_session_ids ?? [])].sort().join(","), d.worker_instruction ?? "", d.new_session?.label ?? ""].join("|");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Registry lanes (the handoff launcher's) that could own the given branches or worktrees: [{name, worktree, branch, gone}].
 * The liveness probe runs only for a lane that matches, never for the whole registry.
 */
export function registryLanes({ branches = [], worktrees = [] } = {}) {
  const reg = readRegistry(), newest = new Map();
  for (const e of reg.entries) {
    const cur = newest.get(e.name);
    if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(e.name, e);
  }
  const out = [];
  for (const e of newest.values()) {
    const hit = (e.branch && branches.some((b) => sameBranch(b, e.branch))) || (e.worktree && worktrees.some((w) => same(w, e.worktree)));
    if (hit) out.push({ name: e.name, worktree: e.worktree ?? null, branch: e.branch ?? null, gone: liveness(e, reg).state === "gone" });
  }
  return out;
}

/** Where the launcher really put a Claude lane: {worktree, branch} from its newest registry line, or null. */
export function registryPlacement(lane) {
  const e = latestLaunch(readRegistry(), lane);
  return e ? { worktree: e.worktree ?? null, branch: e.branch ?? null } : null;
}

const PATH_REPLY = {
  "delivered-next-tool": "delivered at its next tool call",
  "woke-idle": "woke the idle worker",
  "queued-until-next-run": "queued until it next runs",
  "already-queued": "already delivered or queued (same request)",
};

/**
 * The live worker table: the fold of workers.jsonl overlaid with what the adapters report now. A changed status is written back
 * as a status event with `at` (so the fold stamps finished_at); an unchanged one writes nothing. Claude workers are probed with
 * ONE batch call (claude.statusAll, one lane probe per turn); an adapter without it is asked per worker. `unknown` never
 * overrides a known status. Returns every worker, finished and dead ones included.
 */
export function createWorkersView({ store, claude, codex, now = () => Date.now() }) {
  const same2 = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return async function workersView() {
    const fold = foldWorkers(store.readJsonl("workers"));
    const live = [...fold.values()].filter((w) => !FINISHED.has(w.status));
    const probes = new Map();
    const claudeW = live.filter((w) => w.provider === "claude");
    if (claudeW.length) {
      try {
        if (typeof claude?.statusAll === "function") for (const [id, st] of claude.statusAll(claudeW)) probes.set(id, st);
        else for (const w of claudeW) { try { probes.set(w.id, claude.status(w)); } catch { /* unknown */ } }
      } catch { /* a failing probe leaves the recorded status */ }
    }
    for (const w of live.filter((x) => x.provider === "codex")) {
      try { probes.set(w.id, codex.status(w)); } catch { /* unknown */ }
    }
    const at = new Date(now()).toISOString();
    for (const w of live) {
      const st = probes.get(w.id);
      if (!st || st.status === "unknown") continue;
      const statusChanged = st.status !== w.status;
      const extra = w.provider === "claude" && (
        (st.last_result && st.last_result !== w.last_result) || !same2(st.blockers ?? [], w.blockers) || st.needs_user !== w.needs_user
        || (st.files_changed?.length && !same2(st.files_changed, w.files_changed)));
      if (!statusChanged && !extra) continue;
      store.appendJsonl("workers", { ev: "status", worker_id: w.id, status: st.status, ...(st.last_result ? { summary: st.last_result } : {}),
        blockers: st.blockers ?? [], needs_user: st.needs_user ?? false, ...(st.files_changed?.length ? { files_changed: st.files_changed } : {}),
        ...(st.current_task ? { current_task: st.current_task } : {}), at });
    }
    const fresh = foldWorkers(store.readJsonl("workers"));
    return [...fresh.values()].map((w) => {
      const st = probes.get(w.id);
      if (!st || st.status === "unknown" || FINISHED.has(w.status)) return w;
      return { ...w, status: FINISHED.has(w.status) ? w.status : st.status, current_task: st.current_task || w.current_task, last_result: st.last_result || w.last_result,
        blockers: st.blockers?.length ? st.blockers : w.blockers, needs_user: st.needs_user ?? w.needs_user, files_changed: st.files_changed?.length ? st.files_changed : w.files_changed };
    });
  };
}

/** `cfg`, `store` (store.mjs), `claude`, `codex` (adapters), `workersView() -> Worker[]`, `repo` (for predicted worktree paths), `lanes(filter)`. */
export function createDispatcher({ cfg, store, claude, codex, workersView, now = () => Date.now(), repo = null, lanes = registryLanes, placement = registryPlacement }) {
  const iso = () => new Date(now()).toISOString();
  const rawWorkers = () => store.readJsonl("workers");
  const table = () => foldWorkers(rawWorkers());
  const endWorker = (id, why) => store.appendJsonl("workers", { ev: "ended", worker_id: id, why: cap(why, 300), at: iso() });
  const wtDir = (name) => (repo ? path.join(repo, ".claude", "worktrees", name).replace(/\\/g, "/") : null);

  // ---- status ---------------------------------------------------------------------------------------------------------------
  const statusLine = (w) => {
    const summary = w.last_result || w.current_task || w.objective || "no report yet";
    const bl = (w.blockers ?? []).filter(Boolean);
    return `${w.id} (${w.provider}) ${w.status} - ${cap(summary, 200)}${bl.length ? `; blockers: ${bl.join(", ")}` : ""}`
      + (w.needs_user ? `; needs you: ${typeof w.needs_user === "string" ? w.needs_user : "yes"}` : "");
  };
  async function status(ids = [], ws = null) {
    const view = ws ?? await workersView();
    const pick = ids?.length ? ids.map((id) => view.find((w) => w.id === id)).filter(Boolean) : view;
    if (!pick.length) return "No workers yet.";
    return pick.slice(-50).map(statusLine).join("\n");
  }

  // ---- messages -------------------------------------------------------------------------------------------------------------
  async function deliver(w, text, sub) {
    if (w.provider === "codex") {
      let out;
      try { out = await codex.start(w, text, { requestId: sub }); } catch {
        // codex.start can reject while its child already runs (a ledger append failed after spawn; the adapter keeps the slot and
        // settles it in poll). It is "started, status pending": never ended, never moved to Claude. poll() keeps watching it.
        return { target: w.id, ok: true, path: "started-pending", line: `${w.id}: started; status pending` };
      }
      if (out?.started) return { target: w.id, ok: true, path: "started", attempt: out.started, line: `${w.id}: ${out.existing ? "already started" : "started"} a Codex run (${out.started})` };
      if (out?.queued) return { target: w.id, ok: true, path: "queued", attempt: out.queued, line: `${w.id}: queued behind its current Codex run (${out.queued})` };
      if (out?.blocked) {
        const fb = out.fallback ?? fallbackFor(out.blocked, cfg, { isNewWorker: false, queueLength: 0 });
        const reason = out.reason ?? out.blocked;
        return { target: w.id, ok: false, reason, line: `${w.id}: Codex refused (${reason}); ${fb.reason}` };
      }
      if (out?.clarify) return { target: w.id, ok: false, reason: String(out.clarify), line: `${w.id}: ${out.clarify}` };
      return { target: w.id, ok: false, reason: "unexpected Codex outcome", line: `${w.id}: unexpected Codex outcome` };
    }
    const r = await claude.message(w, text, sub);
    if (r?.ok) return { target: w.id, ok: true, path: r.path, line: `${w.id}: ${PATH_REPLY[r.path] ?? r.path}` };
    const reason = r?.reason ?? "delivery failed";
    return { target: w.id, ok: false, reason, line: `${w.id}: not delivered (${reason}); try /restart-closed` };
  }

  async function messageAct(d, rid, ws) {
    const results = [];
    for (const id of d.target_session_ids) {
      const w = ws.find((x) => x.id === id);
      if (!w) results.push({ target: id, ok: false, reason: "unknown worker", line: `${id}: no such worker` });
      else if (FINISHED.has(w.status)) results.push({ target: id, ok: false, reason: w.status, line: `${id}: is ${w.status} and cannot take a message` });
      else results.push(await deliver(w, d.worker_instruction, `${rid}:${id}`));
    }
    const focus = d.action === "message_session" && results[0]?.ok ? d.target_session_ids[0] : null;
    return { results, reply: results.map((r) => r.line).join("\n"), focus };
  }

  // ---- create ---------------------------------------------------------------------------------------------------------------
  /** Why a new worktree/branch cannot be used, or null: another non-finished worker, or a registry lane that is not gone. */
  function conflictOf({ worktree, branch, selfId }, ws) {
    for (const o of ws) {
      if (o.id === selfId || FINISHED.has(o.status)) continue;
      if (same(worktree, o.worktree)) return `${o.id} (${o.provider}, ${o.status}) already works in ${o.worktree}`;
      if (sameBranch(branch, o.branch)) return `${o.id} (${o.provider}, ${o.status}) already owns the branch ${branch}`;
    }
    const lanes2 = lanes({ branches: [branch].filter(Boolean), worktrees: [worktree].filter(Boolean) }) ?? [];
    for (const l of lanes2) {
      if (l.gone) continue;
      if (same(worktree, l.worktree)) return `registry lane ${l.name} is running in ${l.worktree}`;
      if (sameBranch(branch, l.branch)) return `registry lane ${l.name} is running on the branch ${branch}`;
    }
    return null;
  }

  const created = (ev) => store.appendJsonl("workers", { ev: "created", lane: ev.id, repo, created_at: iso(), at: iso(), ...ev });

  /** Records the worktree and branch a launch really made when they differ from the prediction in the created event. */
  function placed(id, real, predicted) {
    const worktree = typeof real?.worktree === "string" && real.worktree ? real.worktree : null;
    const branch = typeof real?.branch === "string" && real.branch ? real.branch : null;
    if ((worktree && !same(worktree, predicted.worktree)) || (branch && !sameBranch(branch, predicted.branch))) {
      store.appendJsonl("workers", { ev: "placed", worker_id: id, ...(worktree ? { worktree } : {}), ...(branch ? { branch } : {}), at: iso() });
    }
  }

  /** Creates a Claude worker (event, launch). -> {id, ok, reason?, line} */
  async function startClaude({ label, objective, instruction, ws, rid, extra = {}, replay = null }) {
    const id = replay?.id ?? nextWorkerId(label, ws);
    const branch = `mc-${id}`, worktree = wtDir(`mc-${id}`);
    if (!replay) {
      const c = conflictOf({ worktree, branch, selfId: id }, ws);
      if (c) return { id, ok: false, conflict: true, reason: c, line: `Cannot start ${label}: ${c}. Nothing was started.` };
      created({ id, provider: "claude", label, objective, worktree, branch, request_id: rid, ...extra });
    } else {
      const st = claude.status?.(replay); // a replay: launch again only when the first attempt never reached the registry
      if (!(st && st.status === "dead")) {
        // the launch already happened: a crash before the `placed` event must not keep the prediction for good
        let real = null;
        try { real = placement(id); } catch { /* no registry answer: the prediction stands */ }
        placed(id, real, { worktree: replay.worktree, branch: replay.branch });
        return { id, ok: true, line: `Claude worker ${id} (${label}) was already started.` };
      }
    }
    const r = await claude.create({ workerId: id, label, objective, instruction: instruction ?? "", requestId: rid });
    if (!r?.ok) {
      const reason = r?.reason ?? r?.kind ?? "launch failed";
      endWorker(id, reason);
      return { id, ok: false, reason, line: `Could not start claude worker ${id}: ${reason}.` };
    }
    placed(id, r, { worktree, branch });
    return { id, ok: true, line: `Started claude worker ${id} (${label}).` };
  }

  async function createAct(d, rid, ws, inWorktreeOf) {
    const ns = d.new_session, provider = ns.provider ?? "claude", label = ns.label, objective = ns.objective;
    const fail = (reply, reason, id = null) => ({ results: [{ ...(id ? { target: id } : {}), ok: false, reason }], reply, focus: null });
    // a replay (crash recovery): the non-finished worker this request already made is reused
    const prevEv = rawWorkers().filter((e) => e.ev === "created" && e.request_id === rid).at(-1);
    const prev = prevEv ? ws.find((w) => w.id === prevEv.id) : null;
    const replay = prev && !FINISHED.has(prev.status) ? prev : null;
    if (prev && !replay && prev.provider === "claude") {
      // The worker this request made has finished or died since the crash. If its launch was recorded (the registry has a line for it),
      // it is the outcome of this request: repair its placement and answer without launching again. No launch line: it never started.
      let real = null;
      try { real = placement(prev.id); } catch { /* no registry answer: treated as never launched */ }
      if (real) {
        placed(prev.id, real, { worktree: prev.worktree, branch: prev.branch });
        const why = prev.fallback_reason ? `Codex unavailable (${prev.fallback_reason}): ` : "";
        const line = prev.fallback_of ? `${why}started a Claude worker instead (${prev.id}).` : `Claude worker ${prev.id} (${label}) was already started.`;
        return { results: [{ target: prev.id, ok: true, ...(prev.fallback_of ? { fallback_of: prev.fallback_of } : {}) }], reply: line, focus: prev.id };
      }
    }
    if (replay &&(replay.provider !== provider || replay.fallback_of)) {
      // A Codex request whose Claude fallback was already created: never run the Codex adapter on that Claude worker.
      const r = await startClaude({ label, objective, instruction: d.worker_instruction, ws, rid, replay });
      const why = replay.fallback_reason ? `Codex unavailable (${replay.fallback_reason}): ` : "";
      return { results: [{ target: r.id, ok: r.ok, ...(r.ok ? { fallback_of: replay.fallback_of } : { reason: r.reason }) }],
        reply: r.ok ? `${why}started a Claude worker instead (${r.id}).` : r.line, focus: r.ok ? r.id : null };
    }

    let ref = null, inRef = {};
    if (inWorktreeOf) {
      ref = ws.find((w) => w.id === inWorktreeOf) ?? null;
      if (provider === "codex" && ref && !FINISHED.has(ref.status)) {
        const msg = `${ref.id} is still ${ref.status}, so ${label} cannot work in its worktree. I can start ${label} in a new worktree from its branch instead: `
          + `/new codex ${label} <objective> (without --in), or wait until ${ref.id} finishes.`;
        return fail(msg, "workspace-conflict");
      }
      inRef = { in_worktree_of: inWorktreeOf };
    }

    if (provider === "claude") {
      const r = await startClaude({ label, objective, instruction: d.worker_instruction, ws, rid, extra: inRef, replay });
      return { results: [{ target: r.id, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }], reply: r.line, focus: r.ok ? r.id : null };
    }

    // ---- Codex ----
    const id = replay?.id ?? nextWorkerId(label, ws);
    const useRef = ref && FINISHED.has(ref.status) && ref.worktree;
    const worktree = useRef ? ref.worktree : wtDir(`codex-${id}`), branch = useRef ? ref.branch : `codex-${id}`;
    if (!replay) {
      const c = conflictOf({ worktree, branch, selfId: id }, ws);
      if (c) return fail(`Cannot start ${label}: ${c}. Nothing was started.`, c);
      created({ id, provider: "codex", label, objective, worktree, branch, request_id: rid, ...inRef });
    }
    const w = table().get(id);
    const ended = (why, reply) => { endWorker(id, why); return fail(reply, why, id); };
    const wt = codex.ensureWorktree(w);
    if (!wt?.ok) return ended(`worktree: ${wt?.reason ?? "refused"}`, `Could not create the worktree for ${id}: ${wt?.reason ?? "refused"}. Nothing was started.`);
    if ((wt.worktree && !same(wt.worktree, worktree)) || (wt.branch && !sameBranch(wt.branch, branch))) {
      // the adapter verified a different place than predicted: it is checked like any new place, before anything starts
      const c = conflictOf({ worktree: wt.worktree, branch: wt.branch, selfId: id }, [...table().values()]);
      if (c) return ended(`placement: ${c}`, `Cannot start ${label}: ${c}. Nothing was started.`);
    }
    placed(id, wt, { worktree, branch });
    let out;
    try { out = await codex.start(w, d.worker_instruction ?? objective, { requestId: rid }); } catch {
      // see deliver(): the child may already run. Keep the worker, report it pending, let poll() settle it.
      return { results: [{ target: id, ok: true, path: "started-pending" }], reply: `Codex worker ${id}: started; status pending.`, focus: id };
    }
    if (out?.started) return { results: [{ target: id, ok: true, path: "started", attempt: out.started }], reply: `Started codex worker ${id} (${label}); run ${out.started}.`, focus: id };
    if (out?.queued) return { results: [{ target: id, ok: true, path: "queued", attempt: out.queued }], reply: `Created codex worker ${id} (${label}); queued until a Codex slot is free (${out.queued}).`, focus: id };
    if (out?.clarify) return ended(String(out.clarify), `${out.clarify} No worker was started.`);
    if (out?.blocked) {
      const reason = out.reason ?? out.blocked;
      const fb = out.fallback ?? fallbackFor(out.blocked, cfg, { isNewWorker: true, queueLength: 0 });
      if (fb.action === "claude") {
        endWorker(id, `fallback: ${reason}`);
        const r = await startClaude({ label, objective, instruction: d.worker_instruction, ws: table(), rid, extra: { ...inRef, fallback_of: id, fallback_reason: cap(reason, 300) } });
        const reply = r.ok ? `Codex unavailable (${reason}): started a Claude worker instead (${r.id}).` : `Codex unavailable (${reason}); ${r.line}`;
        return { results: [{ target: r.id, ok: r.ok, ...(r.ok ? { fallback_of: id } : { reason: r.reason }) }], reply, focus: r.ok ? r.id : null };
      }
      const why = fb.action === "clarify" ? `${reason} (${fb.reason})` : reason;
      return ended(why, `Codex unavailable (${reason}): ${fb.reason}. No worker was started.`);
    }
    return ended("unexpected Codex outcome", `Codex returned an unexpected outcome for ${id}. No worker was started.`);
  }

  // ---- record_update ---------------------------------------------------------------------------------------------------------
  function applyRecordUpdate(d, rid) {
    const ru = d.record_update;
    if (!ru) return;
    const at = iso();
    for (const a of ru.aliases ?? []) store.appendJsonl("workers", { ev: "alias", worker_id: a.session_id, alias: a.alias, at });
    if (ru.note && !rawWorkers().some((e) => e.ev === "note" && e.request_id === rid)) store.appendJsonl("workers", { ev: "note", note: ru.note, request_id: rid, at });
  }

  function rerender() {
    const lines = rawWorkers();
    store.writeRecords(renderRecords({ workers: foldWorkers(lines), focus: focusOf(lines), notes: lines.filter((e) => e.ev === "note").map((e) => e.note) }));
  }

  function stored(l, rid) { return { reply: l.reply ?? "", results: l.results ?? [], requestId: rid, duplicate: true, ...(l.focus ? { focus: l.focus } : {}) }; }
  const doneLine = (rid) => store.readJsonl("dispatch").filter((l) => l.request_id === rid && l.state === "done").at(-1) ?? null;

  /** The stored result of a request that is already done (duplicate: true), or null. */
  function peek(d, { turnId } = {}) {
    const rid = requestIdOf(turnId, d), l = doneLine(rid);
    return l ? stored(l, rid) : null;
  }

  /**
   * @param {object} d a validated CoordinatorDecision
   * @param {{turnId: string, workers?: object[], inWorktreeOf?: string}} o `workers`: the turn's already fetched table (one probe per turn)
   * @returns {Promise<{reply: string, results: object[], requestId: string, duplicate: boolean, focus?: string}>}
   */
  async function dispatch(d, { turnId, workers = null, inWorktreeOf = null } = {}) {
    const rid = requestIdOf(turnId, d);
    const done = doneLine(rid);
    if (done) return stored(done, rid);
    const seen = store.readJsonl("dispatch").some((l) => l.request_id === rid && l.state === "intent");
    if (!seen) store.appendJsonl("dispatch", { request_id: rid, turn_id: turnId, action: d.action, targets: d.target_session_ids, state: "intent", at: iso() });
    const ws = workers ?? await workersView();
    let r;
    switch (d.action) {
      case "message_session": case "message_multiple": r = await messageAct(d, rid, ws); break;
      case "create_session": r = await createAct(d, rid, ws, inWorktreeOf); break;
      case "request_status": r = { results: [], reply: await status(d.target_session_ids, ws), focus: null }; break;
      case "clarify": r = { results: [], reply: d.clarification ?? d.reply ?? "", focus: null }; break;
      default: r = { results: [], reply: d.reply ?? "", focus: null }; // respond
    }
    applyRecordUpdate(d, rid);
    const focus = d.record_update?.focus ?? r.focus ?? null;
    if (focus && focusOf(rawWorkers()) !== focus) store.appendJsonl("workers", { ev: "focus", worker_id: focus, at: iso() });
    rerender();
    const ok = r.results.length === 0 || r.results.some((x) => x.ok);
    store.appendJsonl("dispatch", { request_id: rid, state: ok ? "done" : "failed", results: r.results, reply: r.reply, ...(focus ? { focus } : {}), at: iso() });
    return { reply: r.reply, results: r.results, requestId: rid, duplicate: false, ...(focus ? { focus } : {}) };
  }

  return { dispatch, status, peek };
}
