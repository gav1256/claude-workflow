// The Codex worker adapter: a worktree per worker, a brief, a detached `codex-run` spawn, polling of its one JSON line, the
// coordinator's own job queue, the quarantine hint, the continuation rules (planRun) and the restart reconcile. Every write goes
// through store.mjs (the attempts ledger, the worker events, the brief, the out/err files). Worker text only ever reaches
// codex-run as the text of a brief file; the only argv elements are fixed flags, paths and config values. The dispatcher never
// runs `--clear-quarantine`: it only quotes it. No process is ever killed by pid; a pid is only probed (signal 0).
//
// Attempt lines (codex-attempts.jsonl) are written whole: each line carries the full attempt, so the newest line per attempt_id
// is the state. States: queued | reserved | spawned | done | failed | blocked | unknown.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import * as store from "./store.mjs";
import { stateDir, cfgDir, codexSkillDir } from "./paths.mjs";
import { loadCodexLib } from "./codex-lib.mjs";
import { childEnv } from "./env.mjs";
import { foldWorkers } from "./workers.mjs";
import { codexGate, fallbackFor, createAllowance, createLoginCache, loginStatus } from "./codex-resources.mjs";

const ID_RE = /^[a-z0-9][a-z0-9.-]{0,59}$/; // a worker id as a path component, a branch name and a store file name
const RESULT_STATES = new Set(["done", "failed", "blocked"]);
const REQUEUE_REASON = /^(worktree-busy|codex-slots-full)/;
const MAX_REQUEUES = 3;
const FINISHED = new Set(["finished", "dead"]);
const ACTIVE = new Set(["queued", "reserved", "spawned"]); // an attempt in one of these states is not over (planRun rule 1)
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // codex-run's own run-id rule (goodId in codex-run.mjs)
const goodRunId = (s) => typeof s === "string" && RUN_ID_RE.test(s) && !s.includes("..");
const SCRATCH_LINE = /^.{2} "?\.codex-tmp(?:[/"]|$)/; // a `git status --porcelain` line of codex-run's scratch folder: not residue
const WATCH_MS = (30 + 10) * 60000; // codex-run's default --timeout-min (the adapter passes none) plus 10 minutes
const LEDGER_GRACE_MS = 30000;
const LOGIN_UNKNOWN = "codex-login-unknown"; // a login probe that timed out: transient, never a refusal for good

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const one = (s, n = 1000) => str(s).replace(/\s+/g, " ").trim().slice(0, n); // one line: model text never starts a brief field
const cap = (s, n) => str(s).slice(0, n);
const strs = (v, n, len) => (Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, n).map((s) => s.slice(0, len)) : []);
const samePath = (a, b) => {
  const n = (p) => { let r = path.resolve(p); try { r = realpathSync(r); } catch { /* not there yet */ } return r.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); };
  return n(a) === n(b);
};

/** The last complete codex-run result line in `text`, or null. */
function lastResult(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("{")) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object" && !Array.isArray(o) && RESULT_STATES.has(o.status) && (typeof o.run === "string" || o.run === null)) return o; // run is null on codex-run's internal-crash line
    } catch { /* a torn or foreign line */ }
  }
  return null;
}

function failedChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((c, i) => (c && typeof c === "object" && c.exit !== 0 && c.exit !== undefined
    ? [`check failed: ${one(c.cmd ?? c.name ?? `#${i + 1}`, 120)} (exit ${c.exit})`] : []));
}

function compact(r) {
  return {
    run: r.run, status: r.status, reason: r.reason == null ? null : cap(r.reason, 300), mode: r.mode ?? null, model: r.model ?? null,
    secs: Number.isFinite(r.secs) ? r.secs : null, files: strs(r.files, 50, 300), note: r.codex_note == null ? null : cap(r.codex_note, 300),
    failed_checks: failedChecks(r.checks), week_pct: Number.isFinite(r.week_pct) ? r.week_pct : null,
    orphans: Array.isArray(r.orphans) ? r.orphans.length : 0,
  };
}

/**
 * `deps` = {spawn, spawnSync, codexRunPath, now, git, requeueDelayMs, openOut, closeOut, isAlive}; all optional (the defaults are
 * the real ones). `git(args, {cwd})` -> {code, stdout, stderr} is the only way this module reads a repository.
 */
export function createCodexAdapter({ cfg, repo, lib, allowance = null, login = null, deps = {} } = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const openOut = deps.openOut ?? store.openOut;
  const closeOut = deps.closeOut ?? store.closeOut;
  // signal 0 only asks whether the pid exists (EPERM: it exists, we may not signal it); nothing is ever sent to the process
  const isAlive = deps.isAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } });
  const nowMs = deps.now ?? (() => Date.now());
  const iso = () => new Date(nowMs()).toISOString();
  const requeueDelayMs = deps.requeueDelayMs ?? 10000;
  const skillDir = codexSkillDir();
  const codexRunPath = deps.codexRunPath ?? (skillDir ? path.join(skillDir, "codex-run.mjs") : null);
  const git = deps.git ?? ((args, { cwd } = {}) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000, env: childEnv() });
    return { code: r.status ?? null, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
  });
  const pool = allowance ?? createAllowance(cfg.codex.max_parallel_jobs);
  // With no login function the adapter probes `codex login status` itself, through the real spawnSync (loginStatus has no
  // default runner: without one Codex would silently always be unavailable), cached for cfg.codex.login_cache_ms.
  const loginFn = login ?? createLoginCache((bin) => loginStatus(bin, { env: process.env, spawnSync: deps.spawnSync ?? spawnSync }),
    cfg.codex.login_cache_ms ?? 300000, nowMs);
  const spawnFailures = new Map(); // attempt id -> message of an async spawn 'error' event
  // `lib` undefined: load the Codex skill's lib on first use (a successful load is kept; an absent folder is asked again, it is cheap);
  // an explicit null means Codex is absent.
  let libNow = lib;
  const getLib = async () => {
    if (libNow !== undefined) return libNow;
    const l = await loadCodexLib(skillDir);
    if (l) libNow = l;
    return l;
  };

  // ---- the attempts ledger -------------------------------------------------------------------------------------------------
  /** Newest line per attempt_id, in order of first appearance. */
  function allAttempts() {
    const m = new Map();
    for (const l of store.readJsonl("codex-attempts")) if (l && typeof l.attempt_id === "string") m.set(l.attempt_id, l);
    return [...m.values()];
  }
  const attemptsByRequest = (requestId) => allAttempts().filter((a) => a.request_id === String(requestId));
  const attemptsOf = (workerId) => allAttempts().filter((a) => a.worker_id === workerId);

  /** Appends the whole attempt with `patch` applied (and mutates `a` to match). */
  function put(a, patch) {
    Object.assign(a, patch, { at: iso() });
    for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
    store.appendJsonl("codex-attempts", a);
  }
  const workerEvent = (workerId, fields) => store.appendJsonl("workers", { ev: "status", worker_id: workerId, at: iso(), ...fields });

  // ---- worktree ------------------------------------------------------------------------------------------------------------
  function worktreeList() {
    const r = git(["worktree", "list", "--porcelain"], { cwd: repo });
    if (r.code !== 0) return null;
    const out = [];
    let cur = null;
    for (const line of r.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) { cur = { worktree: line.slice(9).trim(), branch: null }; out.push(cur); }
      else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).trim();
    }
    return out;
  }

  const worktreePathOf = (id) => path.join(repo, ".claude", "worktrees", `codex-${id}`);
  const plainBranch = (b) => str(b).replace(/^refs\/heads\//, "");
  /**
   * The worktree a worker runs in: its own `codex-<id>` one, or, for a worker made with `--in <finished worker>` (it carries
   * in_worktree_of plus the recorded worktree and branch), that worker's worktree. A shared one is never created here.
   */
  const homeOf = (worker) => {
    const shared = worker?.in_worktree_of && worker.worktree && worker.branch;
    return shared ? { path: str(worker.worktree), branch: plainBranch(worker.branch), shared: true }
      : { path: worktreePathOf(worker?.id), branch: `codex-${worker?.id}`, shared: false };
  };

  /** @returns {{ok: true, worktree, branch} | {ok: false, reason}} */
  function ensureWorktree(worker) {
    const id = worker?.id;
    if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, reason: `worker id cannot name a worktree: ${JSON.stringify(id)}` };
    const home = homeOf(worker), branch = home.branch, wt = home.path;
    const list = worktreeList();
    if (!list) return { ok: false, reason: "git worktree list failed" };
    if (home.shared) { // verify only: the worktree of another worker is listed by git, on the recorded branch, and still there
      const listed = list.find((e) => samePath(e.worktree, wt));
      if (!listed) return { ok: false, reason: `${wt} is not a worktree of this repository` };
      if (plainBranch(listed.branch) !== branch || !listed.branch) return { ok: false, reason: `${wt} is on branch ${listed.branch ? plainBranch(listed.branch) : "(detached)"}, not ${branch}` };
      if (!existsSync(wt)) return { ok: false, reason: `${wt} does not exist` };
      return { ok: true, worktree: wt, branch };
    }
    const mine = list.find((e) => samePath(e.worktree, wt));
    if (mine) {
      return mine.branch === `refs/heads/${branch}` && existsSync(wt) ? { ok: true, worktree: wt, branch }
        : { ok: false, reason: `${wt} is not this worker's worktree (branch ${mine.branch ?? "detached"})` };
    }
    if (existsSync(wt)) return { ok: false, reason: `${wt} exists and is not this worker's worktree` };
    const r = git(["worktree", "add", "-b", branch, wt, "HEAD"], { cwd: repo });
    if (r.code !== 0) return { ok: false, reason: `git worktree add failed: ${cap(`${r.stderr}${r.stdout}`.trim().split(/\r?\n/).at(-1), 200)}` };
    return { ok: true, worktree: wt, branch };
  }

  const headOf = (wt) => { const r = git(["rev-parse", "HEAD"], { cwd: wt }); return r.code === 0 ? r.stdout.trim() : null; };

  // ---- continuation rules ----------------------------------------------------------------------------------------------------
  /** {head, dirty} of a worktree (the codex-run scratch folder does not count as residue), or {error}. Never throws. */
  function treeOf(wt) {
    try {
      const head = headOf(wt);
      if (!head) return { error: "git rev-parse HEAD failed" };
      const st = git(["status", "--porcelain", "--untracked-files=all"], { cwd: wt });
      if (st.code !== 0) return { error: "git status failed" };
      return { head, dirty: st.stdout.split(/\r?\n/).some((l) => l.trim() && !SCRATCH_LINE.test(l)) };
    } catch (e) { return { error: `git failed: ${one(e?.message ?? e, 120)}` }; }
  }

  /**
   * The mode of the next run of `worker`, from its earlier `attempts` and the worktree (git only through `deps.git`):
   *   1. the last attempt is queued, reserved or spawned -> queue
   *   2. no last attempt, or a clean tree and HEAD at its head_before -> fresh
   *   3. a dirty tree, HEAD at head_before, the last attempt done with a run id codex-run accepts, in this worktree -> continue
   *   4. a clean tree and HEAD moved (the user committed) -> fresh (a new scope)
   *   5. anything else (a dirty tree with HEAD moved, a dirty tree after a failed, blocked or unknown run, git failing) -> clarify
   * codex-run's own `continueCheck` (the tree must equal that run's final diff hash) is the final word: rule 3 is a prefilter,
   * and a refusal there ends the attempt blocked with codex-run's reason (see finish). -> {mode, reason?, runId?}
   */
  function planDetail(worker, attempts) {
    const last = (attempts ?? []).reduce((m, x) => (!m || (x.seq ?? 0) >= (m.seq ?? 0) ? x : m), null);
    if (last && ACTIVE.has(last.state)) return { mode: "queue", reason: `${last.attempt_id} is ${last.state}` };
    if (!last) return { mode: "fresh" };
    if (typeof worker?.id !== "string" || !ID_RE.test(worker.id)) return { mode: "clarify", reason: `worker id cannot name a Codex worktree: ${JSON.stringify(worker?.id)}` };
    const wt = homeOf(worker).path;
    if (!existsSync(wt)) return { mode: "fresh" }; // the worktree is made again from HEAD
    const t = treeOf(wt);
    if (t.error) return { mode: "clarify", reason: `cannot read the worktree of ${worker.id}: ${t.error}` };
    if (!t.dirty && t.head === last.head_before) return { mode: "fresh" };
    if (t.dirty && t.head === last.head_before && last.state === "done" && goodRunId(last.run_id) && (!last.worktree || samePath(last.worktree, wt))) {
      return { mode: "continue", runId: last.run_id };
    }
    if (!t.dirty) return { mode: "fresh" };
    const why = t.head !== last.head_before ? "has uncommitted changes and HEAD moved since the last run"
      : last.state !== "done" ? `has uncommitted changes after a ${last.state} run` : "has uncommitted changes and the last run cannot be continued";
    return { mode: "clarify", reason: `The worktree of ${worker.id} ${why} (${last.attempt_id}). Commit or discard them, or say what to do, before another run.` };
  }
  const planRun = (worker, attempts) => planDetail(worker, attempts).mode;

  // ---- brief ---------------------------------------------------------------------------------------------------------------
  function briefText(a, worker, instruction, headBefore) {
    const prior = one(worker.last_result, 400);
    const files = strs(worker.files_changed, 20, 200).map((f) => one(f, 200)).join(", "); // every interpolated field is one line
    const constraints = Array.isArray(worker.constraints) ? worker.constraints.map((c) => one(c, 200)).join("; ") : one(worker.constraints, 400);
    return [
      `# Task ${a.attempt_id}: ${one(worker.label ?? worker.id, 80)}`,
      `Goal: ${one(worker.objective, 1000) || "(none recorded)"}`,
      ...(constraints ? [`Durable constraints: ${constraints}`] : []),
      ...(prior ? [`Prior validated result: ${prior}${files ? ` (files changed: ${files})` : ""}`] : []),
      `New instruction: ${one(instruction, 4000)}`,
      "Files you own: `**`",
      "Do not create or edit anything else.",
      `Builds on: ${headBefore ?? "none"}`,
      "Done when: the new instruction is done; report what changed",
      "Constraints: never commit; never touch files outside this worktree; fake data uses ...@example.com",
      "",
    ].join("\n");
  }

  /** The hint for a quarantined worktree (text for the user; nothing here ever runs it), or null for another reason. */
  function quarantineHint(reason, worktree) {
    if (!/^worktree-quarantined/.test(str(reason))) return null;
    return `node "${path.join(skillDir ?? "<dispatching-codex skill folder>", "codex-run.mjs")}" --clear-quarantine "${worktree}"`;
  }

  /** The blockers of a blocked state: the reason, then (for a quarantine) the quote of the user's own clearing command. */
  function blockersFor(reason, worktree) {
    const blockers = [cap(reason ?? "blocked", 300)];
    const hint = quarantineHint(reason, worktree);
    if (hint) blockers.push(`To clear the quarantine yourself, run: ${hint}`);
    return blockers;
  }

  // ---- spawn (inside the allowance lock, after the gate reserved the attempt) -------------------------------------------------
  /** The login class right now: the cache is dropped first (a 5-minute-old "chatgpt" must not admit an API-key login). */
  async function freshLogin(bin) {
    try { loginFn.reset?.(); return await loginFn(bin); } catch { return "unknown"; }
  }

  /**
   * Spawns the codex-run for `a` (an attempt record whose reservation the caller holds). `mode`: "fresh", or "continue", which
   * adds `--continue <prevRunId>`. Returns {ok: true} or {ok: false, kind, reason} (reservation released).
   */
  async function spawnAttempt(a, worker, instruction, { wt, bin, mode = "fresh", prevRunId = null }) {
    const release = () => pool.release(a.attempt_id);
    let childLive = false; // once a child runs, its reservation stays (poll releases it when the child's line arrives)
    // Blocks the attempt for good. The ledger writes here are best effort: this runs on the way out of a failure (which may be
    // the ledger itself), and the release comes first so a broken write never leaks the reservation.
    const fail = (kind, reason) => {
      release();
      try {
        put(a, { state: "blocked", kind, reason: cap(reason, 300), instruction: undefined });
        workerEvent(a.worker_id, { status: "blocked", blockers: [cap(reason, 300)], current_task: "" });
      } catch { /* the attempt line is missing: a retry of the request reaches the gate again */ }
      return { ok: false, kind, reason: cap(reason, 300) };
    };
    try {
      const who = await freshLogin(bin);
      if (who !== "chatgpt") { release(); return { ok: false, kind: "unavailable", reason: `codex-login-${who}`, unrecorded: true }; }
      const headBefore = headOf(wt.worktree);
      const text = briefText(a, worker, instruction, headBefore);
      // A false from writeNew on a first spawn is the residue of a crash between the brief and the attempt line: that brief is
      // stale, so replace it. A requeue (requeues > 0) keeps the first brief.
      if (!store.writeNew(a.brief, text) && !(a.requeues > 0)) store.writeAtomic(a.brief, text);
      let fd, fdErr, child, reservedLine = false;
      try {
        // The out/err files are opened ("w": truncated) BEFORE the reserved line is written. A requeued attempt reuses its paths, and
        // a crash after the reserved line must not leave the previous run's result line or stderr for reconcile to read.
        fd = openOut(a.out);
        fdErr = openOut(a.out.replace(/\.out$/, ".err"));
        put(a, { state: "reserved", head_before: headBefore, worktree: wt.worktree, mode, continue_from: mode === "continue" ? prevRunId : undefined });
        reservedLine = true;
        const argv = [codexRunPath, "--brief", path.join(stateDir(), a.brief), "--cwd", wt.worktree, "--mode", "write",
          "--model", cfg.codex.model, "--effort", cfg.codex.effort, "--task", a.attempt_id,
          ...(mode === "continue" ? ["--continue", prevRunId] : [])];
        // childEnv() drops HL_SESSION_ID on purpose: codex-run's lane check then takes the hand-opened path, where any worktree
        // is fine unless another live lane owns it (right for a dispatcher-made codex-<id> worktree). No registry id is passed in.
        child = spawn(process.execPath, argv, { detached: true, windowsHide: true, stdio: ["ignore", fd, fdErr], env: childEnv() });
      } catch (e) { return fail("failed", `${reservedLine ? "spawn" : "start"} failed: ${e.message}`); }
      finally { // the child holds its own copies; the parent's are closed on every path (success, spawn throwing, second open failing)
        if (fd !== undefined) closeOut(fd);
        if (fdErr !== undefined) closeOut(fdErr);
      }
      // A valid pid means the child runs: it is live from here on, whatever the handle calls below do. They are best effort.
      const hasPid = Number.isInteger(child?.pid);
      if (hasPid) childLive = true;
      try { if (typeof child?.on === "function") child.on("error", (e) => spawnFailures.set(a.attempt_id, e?.message ?? "spawn error")); } catch { /* handle misbehaves */ }
      try { if (typeof child?.unref === "function") child.unref(); } catch { /* handle misbehaves */ }
      if (!hasPid) return fail("failed", "spawn failed: no process id");
      put(a, { state: "spawned", pid: child.pid });
      workerEvent(a.worker_id, { status: "running", current_task: cap(one(instruction, 300), 300), blockers: [] });
      return { ok: true };
    } catch (e) {
      // A running child keeps its reservation and the caller sees the ledger error. The attempt then stays `reserved`, with no pid
      // recorded: reconcile() and poll() settle it from the out file (see settle).
      if (childLive) throw e;
      return fail("failed", `start failed: ${e?.message ?? e}`);
    }
  }

  const newAttempt = (worker, requestId, instruction, seq) => {
    const attempt_id = `${worker.id}.${seq}`;
    return { attempt_id, worker_id: worker.id, request_id: String(requestId), seq, state: "queued", out: `codex-out/${attempt_id}.out`,
      brief: `briefs/${attempt_id}.md`, requeues: 0, instruction: cap(instruction, 4000) };
  };

  async function gateFor(worker, a, setWt) {
    return codexGate({
      cfg, lib: await getLib(), login: loginFn, allowance: pool, attemptId: a.attempt_id, now: nowMs(),
      worktreeCheck: () => { const r = ensureWorktree(worker); if (r.ok) setWt(r); return r.ok ? { ok: true } : { ok: false, reason: r.reason }; },
    });
  }

  const queuedAttempts = () => allAttempts().filter((a) => a.state === "queued");

  function existingOutcome(a) {
    if (a.state === "queued") return { queued: a.attempt_id, existing: true };
    if (a.state === "blocked") return { blocked: a.kind ?? "failed", reason: a.reason ?? a.result?.reason ?? "blocked", fallback: null, existing: true, attempt_id: a.attempt_id };
    if (a.state === "reserved" || a.state === "spawned") return { started: a.attempt_id, existing: true };
    return { started: a.attempt_id, existing: true, state: a.state };
  }

  /**
   * Starts `instruction` for `worker` once per requestId. -> {started|queued: attemptId, existing?} | {blocked: kind, reason,
   * fallback} | {clarify: reason}. The run mode comes from planRun: a worker whose last attempt is still active queues, a dirty
   * tree left by a done run is continued (`--continue <run id>`), an unclear tree is a clarify.
   */
  function start(worker, instruction, { requestId } = {}) {
    if (requestId === undefined || requestId === null || requestId === "") throw new TypeError("start needs a requestId");
    return pool.withLock(async () => {
      if (typeof worker?.id !== "string" || !ID_RE.test(worker.id)) return { clarify: `worker id cannot name a Codex worktree: ${JSON.stringify(worker?.id)}` };
      const prior = attemptsByRequest(requestId); // before the gate: a retry never reaches it (crash recovery)
      if (prior.length) return existingOutcome(prior.at(-1));
      if (!codexRunPath) return { blocked: "unavailable", reason: "codex-skill-absent", fallback: fallbackFor("unavailable", cfg, { isNewWorker: true, queueLength: 0 }) };
      const mine = attemptsOf(worker.id);
      const seq = mine.reduce((m, x) => Math.max(m, x.seq ?? 0), 0) + 1;
      const a = newAttempt(worker, requestId, instruction, seq);
      const plan = planDetail(worker, mine);
      if (plan.mode === "clarify") return { clarify: plan.reason };
      if (plan.mode === "queue") { // the worker is busy with its own earlier attempt: no second spawn, no worktree-busy requeue
        const fb = fallbackFor("busy", cfg, { isNewWorker: false, queueLength: queuedAttempts().length }); // the follow-ups count against queue_max
        if (fb.action !== "queue") return { blocked: "busy", reason: "codex-queue-full", fallback: fb }; // no attempt line; the worker keeps its status
        put(a, { state: "queued" }); // no worker event: the running attempt still decides the worker's status
        return { queued: a.attempt_id };
      }
      const isNewWorker = mine.length === 0;
      let wt = null;
      const gate = await gateFor(worker, a, (r) => { wt = r; });
      if (!gate.ok) {
        if (gate.kind === "conflict") return { clarify: gate.reason };
        const fb = fallbackFor(gate.kind, cfg, { isNewWorker, queueLength: queuedAttempts().length });
        if (fb.action === "queue") {
          put(a, { state: "queued" });
          workerEvent(worker.id, { status: "queued", current_task: cap(one(instruction, 300), 300) });
          return { queued: a.attempt_id };
        }
        return { blocked: gate.kind, reason: gate.reason, fallback: fb };
      }
      const r = await spawnAttempt(a, worker, instruction, { wt, bin: gate.bin, mode: plan.mode, prevRunId: plan.runId ?? null });
      if (r.ok) return { started: a.attempt_id };
      return { blocked: r.kind, reason: r.reason, fallback: fallbackFor("unavailable", cfg, { isNewWorker, queueLength: 0 }) }; // queueLength only matters for "busy"
    });
  }

  // ---- poll ----------------------------------------------------------------------------------------------------------------
  function finish(a, result, events, workers) {
    const r = compact(result);
    const base = { worker_id: a.worker_id, attempt_id: a.attempt_id, run_id: r.run };
    if (result.status === "blocked" && REQUEUE_REASON.test(str(result.reason))) {
      if ((a.requeues ?? 0) < MAX_REQUEUES) {
        pool.release(a.attempt_id);
        put(a, { state: "queued", requeues: (a.requeues ?? 0) + 1, not_before: nowMs() + requeueDelayMs, pid: undefined, result: r });
        workerEvent(a.worker_id, { status: "queued", blockers: [] });
        events.push({ type: "requeued", ...base, reason: r.reason, requeues: a.requeues });
        return;
      }
      r.reason = `${r.reason} (gave up after ${MAX_REQUEUES} requeues)`;
    }
    let ev, blockers = [];
    if (result.status === "done") {
      blockers = r.failed_checks;
      ev = { status: "waiting_for_user", summary: cap(r.note ?? "done", 200), files_changed: r.files, blockers };
    } else if (result.status === "failed") {
      blockers = [cap(r.reason ?? "codex-run failed", 300)];
      ev = { status: "failed", summary: cap(r.reason ?? "failed", 200), files_changed: r.files, blockers };
    } else {
      blockers = blockersFor(r.reason, a.worktree ?? workers.get(a.worker_id)?.worktree ?? "");
      ev = { status: "blocked", summary: cap(r.reason ?? "blocked", 200), blockers };
    }
    workerEvent(a.worker_id, { ...ev, current_task: "" }); // the worker event first: a crash in between re-emits the same event
    pool.release(a.attempt_id);
    put(a, { state: result.status, run_id: r.run, result: r, instruction: undefined, not_before: undefined });
    events.push({ type: "finished", ...base, state: result.status, status: ev.status, summary: ev.summary, files_changed: ev.files_changed ?? [], blockers });
  }

  function readOut(a) {
    try { return readFileSync(path.join(stateDir(), a.out), "utf8"); } catch { return ""; }
  }
  const readErr = (a) => { try { return readFileSync(path.join(stateDir(), a.out.replace(/\.out$/, ".err")), "utf8"); } catch { return ""; } };

  /** The Codex ledger line (codex-run's runs.jsonl) of this attempt's run: task === the attempt id, written since the attempt began. */
  function ledgerOf(a) {
    let text;
    try { text = readFileSync(path.join(cfgDir(), "state", "codex", "runs.jsonl"), "utf8"); } catch { return null; }
    const since = (Date.parse(a.at) || 0) - 5000; // an earlier run under the same task id (a requeue) is not this run
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim().startsWith("{")) continue;
      try {
        const o = JSON.parse(lines[i]);
        if (o && o.task === a.attempt_id && typeof o.run_id === "string" && (Number(o.ts) || 0) >= since) return o;
      } catch { /* a torn line */ }
    }
    return null;
  }

  /** Ends an attempt whose process is gone without a result line and without a ledger line: status unknown, worktree kept. */
  function markUnknown(a, events) {
    const reason = "the run ended without a result line; check the worktree";
    workerEvent(a.worker_id, { status: "unknown", blockers: [reason], current_task: "" });
    pool.release(a.attempt_id);
    put(a, { state: "unknown", reason, instruction: undefined, not_before: undefined });
    events.push({ type: "unknown", worker_id: a.worker_id, attempt_id: a.attempt_id, reason });
  }

  /**
   * Settles one reserved or spawned attempt. -> true while it is still watched (its reservation stays), false once it is settled.
   *   result line in the out file  -> persist it
   *   an async spawn error         -> blocked
   *   pid alive and younger than timeout + 10 min -> watched
   *   else a Codex ledger line of this attempt -> persist {state: ledger status, run id}
   *   else -> unknown
   * A reserved attempt has no pid: its spawned line failed to write after the child started (spawnAttempt rethrew), or the
   * process died between the two lines. In poll() it counts as running until it is too old; at startup (`startup`) it needs
   * a sign of the child (a ledger line or any output), else it is blocked `not-spawned`.
   * PID reuse is an accepted residual: process.kill(pid, 0) cannot tell a reused pid from the original. The age bound limits it
   * to one own-cap slot held (and the worker `running`) until the attempt passes 40 minutes. Large-org variant: record the process
   * start time and compare it, as live.mjs checkHost does for window hosts.
   */
  function settle(a, { startup, events, workers }) {
    let result = lastResult(readOut(a));
    if (result) { finish(a, result, events, workers); return false; }
    if (spawnFailures.has(a.attempt_id)) {
      const reason = `spawn failed: ${spawnFailures.get(a.attempt_id)}`;
      spawnFailures.delete(a.attempt_id);
      workerEvent(a.worker_id, { status: "blocked", blockers: [cap(reason, 300)], current_task: "" });
      pool.release(a.attempt_id);
      put(a, { state: "blocked", kind: "failed", reason: cap(reason, 300), instruction: undefined });
      events.push({ type: "blocked", worker_id: a.worker_id, attempt_id: a.attempt_id, kind: "failed", reason });
      return false;
    }
    const hasPid = Number.isInteger(a.pid);
    const alive = hasPid ? isAlive(a.pid) : null;
    if (alive === false) { // it may have ended between the two reads
      result = lastResult(readOut(a));
      if (result) { finish(a, result, events, workers); return false; }
    }
    const led = ledgerOf(a);
    if (!hasPid && startup && !led && !readOut(a).trim() && !readErr(a).trim()) {
      const reason = "not-spawned";
      workerEvent(a.worker_id, { status: "blocked", blockers: [reason], current_task: "" });
      pool.release(a.attempt_id);
      put(a, { state: "blocked", kind: "failed", reason, instruction: undefined });
      events.push({ type: "blocked", worker_id: a.worker_id, attempt_id: a.attempt_id, kind: "failed", reason });
      return false;
    }
    const age = nowMs() - (Date.parse(a.at) || 0);
    // No pid: a ledger line says the child has ended, but codex-run appends it a moment BEFORE it prints the result line, so a fresh
    // one (younger than LEDGER_GRACE_MS) is not trusted yet: the result line would be lost.
    if (!hasPid && led && nowMs() - (Number(led.ts) || 0) < LEDGER_GRACE_MS) return true; // also at the watchdog cutoff
    const running = hasPid ? alive : !led;
    if (running && age < WATCH_MS) return true;
    if (led && RESULT_STATES.has(led.status)) {
      const note = "recovered from the Codex ledger";
      finish(a, { run: led.run_id, status: led.status, reason: led.status === "done" ? null : `${note}: ${led.status}`, files: led.files, codex_note: led.status === "done" ? note : null }, events, workers);
      return false;
    }
    markUnknown(a, events);
    return false;
  }

  /** Persists finished attempts and starts queued ones (the full gate runs again). -> events. */
  function poll() {
    return pool.withLock(async () => {
      const events = [], workers = foldWorkers(store.readJsonl("workers"));
      for (const a of allAttempts().filter((x) => x.state === "spawned" || x.state === "reserved")) settle(a, { startup: false, events, workers });
      for (const a of queuedAttempts()) { // oldest first
        if ((a.not_before ?? 0) > nowMs()) continue;
        const worker = workers.get(a.worker_id) ?? { id: a.worker_id, label: a.worker_id, objective: "" };
        const stop = (kind, reason) => {
          workerEvent(a.worker_id, { status: "blocked", blockers: [cap(reason, 300)], current_task: "" });
          put(a, { state: "blocked", kind, reason: cap(reason, 300), instruction: undefined });
          events.push({ type: "blocked", worker_id: a.worker_id, attempt_id: a.attempt_id, kind, reason });
        };
        if (FINISHED.has(worker.status)) { stop("failed", "worker-not-live"); continue; }
        // the mode is decided now, from the attempts before this one (an earlier one of the same worker may still be running)
        const plan = planDetail(worker, attemptsOf(a.worker_id).filter((x) => (x.seq ?? 0) < (a.seq ?? 0)));
        if (plan.mode === "queue") continue;
        if (plan.mode === "clarify") { stop("conflict", plan.reason); continue; }
        let wt = null;
        const gate = await gateFor(worker, a, (r) => { wt = r; });
        if (!gate.ok) {
          // not a refusal for good: it stays queued, and nothing behind it starts first
          if (gate.kind === "busy" || gate.kind === "unknown" || gate.reason === LOGIN_UNKNOWN) break;
          stop(gate.kind, gate.reason);
          continue;
        }
        const r = await spawnAttempt(a, worker, a.instruction, { wt, bin: gate.bin, mode: plan.mode, prevRunId: plan.runId ?? null });
        if (r.ok) events.push({ type: "started", worker_id: a.worker_id, attempt_id: a.attempt_id });
        else if (r.unrecorded) { // the fresh login check refused: no run was made
          if (r.reason === LOGIN_UNKNOWN) break; // a probe timeout is transient
          stop(r.kind, r.reason);
        } else events.push({ type: "blocked", worker_id: a.worker_id, attempt_id: a.attempt_id, kind: r.kind, reason: r.reason });
      }
      return events;
    });
  }

  /**
   * At startup, before the first poll: settles every reserved and spawned attempt the way poll does (a reserved one needs a sign
   * of its child, else it is blocked `not-spawned`) and rebuilds the allowance from the ones that are still watched. -> events.
   */
  function reconcile() {
    return pool.withLock(async () => {
      const events = [], workers = foldWorkers(store.readJsonl("workers")), watched = [];
      for (const a of allAttempts().filter((x) => x.state === "spawned" || x.state === "reserved")) {
        if (settle(a, { startup: true, events, workers })) watched.push(a.attempt_id);
      }
      pool.rebuild(watched);
      return events;
    });
  }

  /** {status, current_task, last_result, blockers, needs_user, files_changed}. Never throws. */
  function status(worker) {
    const out = { status: "unknown", current_task: worker?.current_task ?? "", last_result: "", blockers: [], needs_user: false, files_changed: [] };
    try {
      const list = attemptsOf(worker.id);
      const a = list.find((x) => x.state === "reserved" || x.state === "spawned") ?? list.at(-1); // a running attempt beats a queued follow-up
      if (!a) return { ...out, status: worker.status ?? "starting" };
      const r = a.result ?? {};
      switch (a.state) {
        case "queued": return { ...out, status: "queued" };
        case "reserved": case "spawned": return { ...out, status: "running" };
        case "done": return { ...out, status: "waiting_for_user", last_result: cap(r.note ?? "done", 200), blockers: r.failed_checks ?? [], files_changed: r.files ?? [] };
        case "failed": return { ...out, status: "failed", last_result: cap(r.reason ?? "", 200), blockers: [cap(r.reason ?? "codex-run failed", 300)] };
        case "blocked": return { ...out, status: "blocked", blockers: blockersFor(a.reason ?? r.reason, a.worktree ?? worker.worktree ?? "") };
        default: return { ...out, blockers: a.reason ? [cap(a.reason, 300)] : [] }; // unknown
      }
    } catch { return out; }
  }

  return { ensureWorktree, start, poll, reconcile, planRun, status, quarantineHint, attemptsByRequest };
}
