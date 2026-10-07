// The Claude worker adapter: creates a worker through `launch.mjs --mode bg`, reads its state, and delivers messages to
// it. Delivery paths (message): the PostToolUse/UserPromptSubmit hook (deliver-hook.mjs) picks a pending file up at the
// lane's next tool call or prompt; an idle bg lane is woken with `claude --resume <sid> --bg "<text>"` instead. Model text
// only ever travels as ONE argv element of an .exe spawn (shell: false), never through a shell. Writes go through store.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import * as store from "./store.mjs";
import { stateDir, msgKey, HL_DIR } from "./paths.mjs";
import { launchEnv, childEnv } from "./env.mjs";
import {
  readRegistry, liveness, sessionState, refreshAgents, listedAgent, claudeCli as hlClaudeCli, claudeSpawn, latestLaunch,
  forgetLiveness, tail,
} from "../handoff-launch/live.mjs";
import { liveLaneStatus } from "../handoff-launch/status-lib.mjs";

const LAUNCH_MJS = path.join(HL_DIR, "launch.mjs");
/** Same rule as the local `clean` of launch.mjs (a test pins that the two agree). */
export const clean = (s) => String(s).replace(/"/g, "'").replace(/;/g, ",");

const COPY_NOTE = /^note:.*\b(cop(y|ied)|fork(ed)?)\b/im;
const IDLE_AGENT = /^(idle|done)$/i;
const BLOCK = /^```coordinator-state[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const BLOCK_STATUS = new Set(["running", "waiting_for_user", "done", "blocked"]);
const rid32 = (id) => (/^[0-9a-f]{32}$/.test(String(id)) ? String(id) : crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 32));
/** True when both names are one file (hard links of one inode); either name missing: false. */
const sameFile = (a, b) => { try { const x = statSync(a, { bigint: true }), y = statSync(b, { bigint: true }); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };
const REQUEUE_FAILED = { ok: true, path: "requeue-failed", note: "the message could not be re-queued (the claimed file could not be renamed back): it was not delivered" };
const tailLines =(r, n = 5) => `${r.stderr || ""}\n${r.stdout || ""}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ").slice(0, 600);

/** The default launch.mjs runner. Every launch.mjs call passes an explicit `opts.env` (launchEnv()). -> {code, stdout, stderr}. */
export function makeRunNode(spawn = spawnSync) {
  return (args, opts = {}) => {
    const r = spawn(process.execPath, [LAUNCH_MJS, ...args], { encoding: "utf8", windowsHide: true, timeout: 240000, ...opts });
    return { code: r.status ?? null, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
  };
}

/** The coordinator-state block the lane's newest assistant text ends with, validated; null when there is none or it is malformed. */
export function parseStateBlock(entries) {
  for (const x of [...entries].reverse()) {
    if (!x || x.type !== "assistant" || x.isSidechain || !Array.isArray(x.message?.content)) continue;
    for (const b of [...x.message.content].reverse()) {
      if (b?.type !== "text" || typeof b.text !== "string") continue;
      const found = [...b.text.matchAll(BLOCK)];
      if (!found.length) continue;
      return validBlock(found.at(-1)[1]); // the newest block only: a malformed newest one never falls back to a stale older one
    }
  }
  return null;
}

function validBlock(text) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o) || !BLOCK_STATUS.has(o.status) || typeof o.summary !== "string") return null;
  const strs = (v, n, len) => (Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, n).map((s) => s.slice(0, len)) : []);
  return {
    status: o.status, summary: o.summary.slice(0, 200), changes: strs(o.changes, 20, 200), blockers: strs(o.blockers, 20, 200),
    needs_user: typeof o.needs_user === "string" && o.needs_user ? o.needs_user.slice(0, 200) : o.needs_user === true,
    files_changed: strs(o.files_changed, 50, 300),
  };
}

export function createClaudeAdapter({ cfg = {}, repo, deps = {} } = {}) {
  const sp = deps.spawnSync ?? spawnSync;
  const cli = deps.claudeCli ?? hlClaudeCli;
  const nowMs = deps.now ?? (() => Date.now());
  const runNode = deps.runNode ?? makeRunNode(sp);
  const runClaude = deps.runClaude ?? ((args, opts = {}) => {
    const [file, argv, sh] = claudeSpawn(args, cli());
    const r = sp(file, argv, { ...opts, ...sh, windowsHide: true, encoding: "utf8", timeout: 120000 });
    return { code: r.status ?? null, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
  });
  const wakeSupported = () => cli().exe !== null;
  const model = cfg.claude?.model ?? "opus", effort = cfg.claude?.effort ?? "high";
  const msgDir = (lane) => `messages/${msgKey(lane)}`;

  function briefText({ workerId, label, objective, instruction }) {
    const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    return [
      `# ${one(label) || workerId}`, "",
      `Worker \`${workerId}\`, started by the coordinator on the user's behalf.`, "",
      "## Paste-ready prompt", "",
      "Objective:", "", String(objective ?? "").trim(), "",
      "First instruction:", "", String(instruction ?? "").trim() || "(none: start from the objective)", "",
      "### Coordinator protocol", "",
      "End every turn with a fenced block (three backticks, then `coordinator-state`) holding one JSON object "
        + '{"session_id", "provider": "claude", "status": "running|waiting_for_user|done|blocked", "summary", "changes": [], '
        + '"blockers": [], "needs_user", "files_changed": []} (summary at most 200 chars).',
      "Messages from the user arrive through the coordinator as hook context starting with \"Message from the user, relayed by the coordinator\". Treat them as the user's instructions.",
      "Never commit unless the user asks.", "",
    ].join("\n");
  }

  /** @returns {{ok: true, lane, worktree, branch} | {ok: false, kind: "cap"|"failed", reason}} */
  function create({ workerId, label, objective, instruction }) {
    const rel = `briefs/${workerId}.md`;
    try { store.writeNew(rel, briefText({ workerId, label, objective, instruction })); } // false = a retry: the first brief stays
    catch (e) { return { ok: false, kind: "failed", reason: `brief not written: ${e.message}` }; }
    const brief = path.join(stateDir(), rel);
    const r = runNode(["--repo", repo, "--handoff", brief, "--name", workerId, "--worktree", `mc-${workerId}`,
      "--model", model, "--effort", effort, "--mode", "bg"], { env: launchEnv(), timeout: 240000 });
    if (r.code === 3) return { ok: false, kind: "cap", reason: tailLines(r) || "session cap or occupied checkout" };
    if (r.code !== 0) return { ok: false, kind: "failed", reason: tailLines(r) || `launch.mjs exited ${r.code}` };
    const e = latestLaunch(readRegistry(), workerId);
    if (!e) return { ok: false, kind: "failed", reason: "launch.mjs exited 0 but left no registry line" };
    return { ok: true, lane: e.name, worktree: e.worktree ?? null, branch: e.branch ?? null };
  }

  function profileArgs(e) {
    const r = runNode(["profile-args", "--profile", e.profile || "full", "--repo", e.worktree || repo], { env: launchEnv(), timeout: 60000 });
    if (r.code !== 0) return null;
    try { const j = JSON.parse(r.stdout); return Array.isArray(j.args) && j.args.every((a) => typeof a === "string") ? j.args : null; } catch { return null; }
  }

  /** @returns {{ok: true, path: "delivered-next-tool"|"woke-idle"|"queued-until-next-run"|"already-queued"|"delivered-unverified"|"requeue-failed", note?: string} | {ok: false, kind: "dead", reason}} */
  function message(worker, text, requestId) {
    const lane = worker.lane ?? worker.id, rid = rid32(requestId);
    forgetLiveness(undefined); // a fresh liveness and agent list: the lane may have changed since the last call
    const reg = readRegistry(), e = latestLaunch(reg, lane);
    if (!e) return { ok: false, kind: "dead", reason: `no launch line for ${lane}` };
    const lv = liveness(e, reg);
    if (lv.state === "gone") return { ok: false, kind: "dead", reason: lv.why };
    const base = `${msgDir(lane)}/${rid}`;
    // A claimed copy (.delivered.json) means this request was already handed over: a retry never sends it twice.
    if (existsSync(path.join(stateDir(), `${base}.delivered.json`))) {
      try { store.dropDuplicate(`${base}.json`); } catch { /* a pending copy left by an older unclaim: dropped; a failure leaves it for the hook */ }
      return { ok: true, path: "already-queued" };
    }
    const body = { request_id: String(requestId), text: String(text), at: new Date(nowMs()).toISOString() };
    if (!store.writeNew(`${base}.json`, JSON.stringify(body))) return { ok: true, path: "already-queued" };
    deps.afterWrite?.(); // test seam: runs where the lane's hook could claim the file just written
    // A claimed copy now exists. If our own file is already gone, the lane's hook claimed it right after the write: this first
    // send is delivered (never "already-queued"). If it is still there, another caller wrote and claimed the request between
    // the check above and the write: this file is a duplicate of the claimed copy, and is removed (never claimed again).
    // (E6) A pending name that is the SAME file as the claimed name is our own write, claimed by the hook (its link was made, its
    // unlink failed): delivered. A different file is another caller's claimed copy, so ours is a duplicate.
    const pendingFile = path.join(stateDir(), `${base}.json`), claimedFile = path.join(stateDir(), `${base}.delivered.json`);
    if (existsSync(claimedFile)) {
      const ours = existsSync(pendingFile), dup = ours && !sameFile(pendingFile, claimedFile);
      if (ours) { try { store.dropDuplicate(`${base}.json`); } catch { /* the lane's hook drops it on its next run */ } }
      return { ok: true, path: dup ? "already-queued" : "delivered-next-tool" };
    }
    if (lv.state !== "running" || !(e.mode === "bg" || e.bg_id)) return { ok: true, path: lv.state === "running" ? "delivered-next-tool" : "queued-until-next-run" };

    const st = sessionState(e);
    const agentIdle = IDLE_AGENT.test(st.liveStatus ?? "");
    const idle = agentIdle ? (!st.found || st.idle) : st.idle;
    if (!idle) return { ok: true, path: "delivered-next-tool" };
    if (!wakeSupported()) return { ok: true, path: "queued-until-next-run" }; // no .exe: a shell would carry model text
    const sid = e.session_id || listedAgent(e, refreshAgents())?.sessionId;
    const args = sid ? profileArgs(e) : null;
    if (!args) return { ok: true, path: "queued-until-next-run" };

    try { store.rename(`${base}.json`, `${base}.delivered.json`); } // claim: the woken lane's own hook must not deliver it again
    catch { return { ok: true, path: "delivered-next-tool" }; } // the lane's hook claimed it first
    // true: the message is pending again. false: the claimed file could not be renamed back (EPERM/EBUSY); it stays .delivered.json,
    // so nothing will ever deliver it and a same-request retry answers already-queued: the callers report REQUEUE_FAILED, never "queued".
    const unclaim = () => { try { (deps.unclaim ?? store.unclaim)(`${base}.delivered.json`, `${base}.json`); return true; } catch { return false; } };
    const before = refreshAgents();
    const res = runClaude(["--resume", sid, ...args, "--bg", clean(`Message from the user, relayed by the coordinator (request ${rid}): ${text}`)],
      { cwd: e.worktree || repo, env: childEnv({ extra: { HL_SESSION_ID: e.id } }) });
    const after = refreshAgents();
    const seen = new Set(Array.isArray(before) ? before.map((a) => a?.id) : []);
    const copies = Array.isArray(after) && Array.isArray(before)
      ? after.filter((a) => a && typeof a === "object" && a.id && !seen.has(a.id) && a.sessionId !== sid
        && [a.name, a.title, a.label].filter(Boolean).every((n) => n === lane)) // never stop an unrelated session that started meanwhile
      : [];
    const out = `${res.stdout}\n${res.stderr}`, note = COPY_NOTE.exec(out);
    let found = copies;
    if (!found.length && note) { // the CLI says it started a copy: look for its id in a fresh list (any name; the CLI named it)
      const id = /\bid[ :]+([\w-]+)/i.exec(out.split(/\r?\n/).find((l) => COPY_NOTE.test(l)) ?? "")?.[1], again = id ? refreshAgents() : null;
      found = Array.isArray(again) ? again.filter((x) => x && typeof x === "object" && x.id === id && x.sessionId !== sid) : [];
    }
    if (found.length) { // re-queue only when a copy was really found and stopped; otherwise the message stays delivered
      for (const c of found) runClaude(["stop", String(c.id)], { env: childEnv({}) });
      return unclaim() ? { ok: true, path: "queued-until-next-run" } : { ...REQUEUE_FAILED };
    }
    // A non-zero exit puts the message back only when the CLI named no copy: with a copy note and no copy found, the copy may
    // already hold the message, so it stays delivered (a second send would double it). That outcome is not "woke-idle" (the lane
    // itself was not confirmed woken): it is reported as delivered-unverified, whatever the exit code.
    if (note) return { ok: true, path: "delivered-unverified", note: "the CLI reported a copy but none was found: left delivered" };
    if (res.code !== 0) return unclaim() ? { ok: true, path: "queued-until-next-run" } : { ...REQUEUE_FAILED };
    return { ok: true, path: "woke-idle" };
  }

  const probeRows = deps.liveLaneStatus ?? liveLaneStatus;

  /** One worker's status. `rows()` returns the lane-status rows (statusAll shares one probe between all of its workers). */
  function statusWith(worker, rows) {
    const out = { status: "unknown", current_task: worker.current_task ?? "", last_result: "", blockers: [], needs_user: false, files_changed: [] };
    try {
      const lane = worker.lane ?? worker.id;
      forgetLiveness(undefined, { agents: 5000 });
      const reg = readRegistry(), e = latestLaunch(reg, lane);
      if (!e) return { ...out, status: "dead", blockers: [`no launch line for ${lane}`] };
      const row = rows().find((r) => r.id === e.id);
      if (!row) return out;
      const st = sessionState(e);
      let s = "unknown";
      if (row.state === "open") s = st.idle ? "idle" : "running";
      else if (row.state === "finished") s = "finished";
      else if (row.state === "closed_unfinished") s = "dead";
      else if (row.state === "paused") s = "blocked";
      if (s === "dead" || s === "blocked") out.blockers = [row.reason];
      // The lane's last coordinator-state block: read-only, last 256 KiB, assistant text only (the brief and the user's
      // prompts quote the fence as an example). It sets the status only when the lane is idle: a busy lane has started a
      // newer turn, and a finished, dead or paused lane keeps what the registry says.
      const block = st.file ? parseStateBlock(tail(st.file, 256 * 1024)) : null;
      if (block) {
        out.last_result = block.summary; out.blockers = block.blockers.length ? block.blockers : out.blockers;
        out.needs_user = block.needs_user; out.files_changed = block.files_changed;
        if (s === "idle" && (block.status === "waiting_for_user" || block.status === "done")) s = block.status === "done" ? "finished" : "waiting_for_user";
      }
      out.status = s;
    } catch { out.status = "unknown"; }
    return out;
  }

  /** @returns {{status, current_task, last_result, blockers, needs_user, files_changed}} Never throws: any probe failure is `unknown`. */
  function status(worker) { return statusWith(worker, probeRows); }

  /**
   * status() for several workers with ONE lane-status probe (liveLaneStatus is a PowerShell probe: N workers must not cost N
   * probes per turn). The probe runs lazily, so a call whose workers all lack a launch line probes nothing, and a failing
   * probe gives `unknown` for each worker that needed it. -> Map of worker id -> status. Never throws.
   */
  function statusAll(workers) {
    let memo = null;
    const rows = () => {
      memo ??= (() => { try { return { v: probeRows() }; } catch (e) { return { e }; } })(); // a failed probe is not retried per worker
      if (memo.e) throw memo.e;
      return memo.v;
    };
    const out = new Map();
    for (const w of workers ?? []) out.set(w.id, statusWith(w, rows));
    return out;
  }

  /** Messages still waiting for the lane: [{rid, request_id, text, at}], oldest first. */
  function pendingMessages(worker) {
    const dir = path.join(stateDir(), msgDir(worker.lane ?? worker.id));
    let names = [];
    try { names = readdirSync(dir); } catch { return []; }
    const out = [];
    for (const n of names.sort()) {
      const m = /^([0-9a-f]{32})\.json$/.exec(n);
      if (!m) continue;
      try { const o = JSON.parse(readFileSync(path.join(dir, n), "utf8")); out.push({ rid: m[1], request_id: o.request_id ?? m[1], text: String(o.text ?? ""), at: o.at ?? null }); } catch { /* half-written */ }
    }
    return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  return { create, message, status, statusAll, pendingMessages, wakeSupported, runNode, runClaude };
}
