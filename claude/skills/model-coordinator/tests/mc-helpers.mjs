// Test helpers for the model-coordinator suite. Every path is a fresh temp folder; nothing touches the real
// ~/.claude. Later tasks append to this file (lunaLikePolicy, fakeClaudeRunner, FAKE_CODEX_CLI, ...).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.dirname(TESTS_DIR);

let counter = 0;

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * A complete test environment: temp CFG, CODEX_HOME, handoff registry and TEMP stand-in, HL_NO_SPAWN, HL_FAKE_CLAUDE,
 * an empty fake `claude agents --json` file, and unique pipe names. Returns an env object (a copy of process.env plus
 * the test settings). Non-enumerable extras: `root` and `dirs`, and `cleanup()` (removes the temp root).
 */
export function mcEnv(extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-t-")));
  const dirs = {
    cfg: path.join(root, "cfg"),
    codexHome: path.join(root, "codex-home"),
    registry: path.join(root, "registry"),
    temp: path.join(root, "temp"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const agents = path.join(root, "agents.json");
  fs.writeFileSync(agents, "[]");
  const n = ++counter;
  const env = { ...process.env };
  for (const k of ["HL_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "HL_SKILL_DIR", "MC_CODEX_SKILL_DIR"]) delete env[k];
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: dirs.cfg,
    CODEX_HOME: dirs.codexHome,
    HL_REGISTRY_DIR: dirs.registry,
    HL_NO_SPAWN: "1",
    HL_FAKE_CLAUDE: "1",
    HL_AGENTS_JSON: agents,
    MC_PIPE_NAME: `mc-test-${process.pid}-${n}`,
    CODEX_RUN_PIPE_PREFIX: `codex-run-mc-${process.pid}-${n}-`,
  }, extra);
  Object.defineProperty(env, "root", { value: root, enumerable: false });
  Object.defineProperty(env, "dirs", { value: dirs, enumerable: false });
  Object.defineProperty(env, "cleanup", { value: () => rmrf(root), enumerable: false });
  return env;
}

/** Runs `fn` with process.env replaced by `env` (keys not in env are removed), then restores it. Works for async fn. */
export async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

let importN = 0;
/** Dynamic import of a module relative to the skill folder (e.g. "store.mjs") with a cache-busting query. */
export function importFresh(rel) {
  const url = new URL(`../${rel}`, import.meta.url);
  url.search = `?t=${++importN}`;
  return import(url.href);
}

/** A directory junction `link` -> `target` (cmd /c mklink /J, no admin needed). Point it only at temp folders. */
export function mkJunction(link, target) {
  const cmdExe = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  const r = spawnSync(cmdExe, ["/d", "/s", "/c", `"mklink /J "${link}" "${target}""`], {
    windowsHide: true, windowsVerbatimArguments: true, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`mklink /J failed: ${r.stdout}${r.stderr}`);
}

/** Removes a junction (the link only): rmdir on a junction never touches its target. */
export function rmJunction(link) {
  try { fs.rmdirSync(link); } catch { /* already gone, or not a junction */ }
}

// ---- Task 7: a well-behaved stand-in for Luna, using only what the context provides -----------------------------
import { emptyDecision } from "../schema.mjs";

/** @param {object} input a CoordinatorInput. Returns a CoordinatorDecision. */
export function lunaLikePolicy(input) {
  const { referents: r = {}, message = "", workers = [], focused_session_id: focus = null } = input;
  const msgTo = (ids, instruction) => emptyDecision({ action: ids.length === 1 ? "message_session" : "message_multiple", target_session_ids: ids, worker_instruction: instruction, confidence: 0.9 });
  const clarify = (q) => emptyDecision({ action: "clarify", clarification: q, confidence: 0.4 });
  if (r.pronoun === "both") {
    if (!r.both) return clarify("Which two workers?");
    return /^do that/i.test(message) ? msgTo(r.both, r.last_instruction ?? message) : msgTo(r.both, message);
  }
  if (r.pronoun === "other") return r.other ? msgTo([r.other], message) : clarify("Which other worker?");
  if (r.pronoun === "singular") return r.singular ? msgTo([r.singular], message) : clarify("Which worker?");
  let m = /(make|start|create) (another|a new) worker for the (\w[\w-]*)/i.exec(message);
  if (m) return emptyDecision({ action: "create_session", new_session: { needed: true, provider: "codex", label: m[3].toLowerCase(), objective: message }, confidence: 0.9 });
  m = /what did the (\w[\w-]*) worker say/i.exec(message);
  if (m) {
    const w = workers.find((x) => x.label === m[1].toLowerCase());
    return w ? emptyDecision({ action: "request_status", target_session_ids: [w.id], confidence: 0.9 }) : clarify(`Which worker is "${m[1]}"?`);
  }
  if (!focus && (r.recent ?? []).length > 1) return clarify("Which worker do you mean?");
  return focus ? msgTo([focus], message) : clarify("Which worker do you mean?");
}

// ---- Task 9: the Claude adapter's test doubles ---------------------------------------------------------------------
import { pathToFileURL } from "node:url";

/**
 * A recording stand-in for runClaude / runNode. `script`: an array of results ({code, stdout, stderr}) or functions
 * (args, opts, index) => result, consumed in call order (calls past its end get the default {code: 0}); or one function
 * used for every call. `run.calls` holds {args, cwd, env} per call.
 */
export function fakeClaudeRunner(script = []) {
  const calls = [];
  const run = (args, opts = {}) => {
    const i = calls.length;
    calls.push({ args: [...args], cwd: opts.cwd ?? null, env: opts.env ? { ...opts.env } : null });
    const s = typeof script === "function" ? script : script[i];
    const r = typeof s === "function" ? s(args, opts, i) : s;
    return { code: 0, stdout: "", stderr: "", ...(r ?? {}) };
  };
  run.calls = calls;
  return run;
}

/**
 * Runs `body` (the text of an async function body) in a child node process with `env` (live.mjs reads its env at import,
 * so adapter calls cannot run in the test process). The body sees `A` (claude-adapter.mjs), `H` (mc-helpers.mjs),
 * `S` (store.mjs), `P` (paths.mjs) and `L` (handoff-launch/live.mjs), and returns a JSON value.
 * -> {result, stdout, stderr, status}.
 */
export function runChild(dir, env, body) {
  const url = (rel) => pathToFileURL(path.join(SKILL_DIR, rel)).href;
  const file = path.join(dir, `child-${++counter}.mjs`);
  fs.writeFileSync(file, [
    `import * as A from ${JSON.stringify(url("claude-adapter.mjs"))};`,
    `import * as H from ${JSON.stringify(import.meta.url)};`,
    `import * as S from ${JSON.stringify(url("store.mjs"))};`,
    `import * as P from ${JSON.stringify(url("paths.mjs"))};`,
    `import * as L from ${JSON.stringify(url("../handoff-launch/live.mjs"))};`,
    `const out = await (async () => {\n${body}\n})();`,
    `console.log("@@RESULT@@" + JSON.stringify(out ?? null));`,
  ].join("\n"));
  const r = spawnSync(process.execPath, [file], { env, encoding: "utf8", timeout: 240000, windowsHide: true });
  const m = /@@RESULT@@(.*)$/m.exec(r.stdout || "");
  return { result: m ? JSON.parse(m[1]) : null, stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

// ---- Task 8: the fake `codex login status` CLI (run it as CODEX_RUN_BIN=node, CODEX_RUN_BIN_ARGS=[FAKE_CODEX_CLI]) --
export const FAKE_CODEX_CLI = path.join(TESTS_DIR, "fake-codex-cli.mjs");

// ---- Task 10a: the Codex adapter's test doubles ---------------------------------------------------------------------
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
export const FAKE_CODEX_RUN = path.join(TESTS_DIR, "fake-codex-run.mjs");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real temp git repo with one commit by test@example.com. Returns its (real) path. */
export function makeRepo(root, name = "repo") {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...a], { cwd: repo, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return fs.realpathSync(repo);
}

/**
 * A fake Codex skill lib: resolveCodex -> the fake `login status` CLI, busySlots from `state.busy`, latestReading null.
 * `state` is live: a test changes `state.busy` between calls. `state.calls.busySlots` counts the slot probes.
 */
export function fakeCodexLib(state = {}) {
  state.busy ??= 0;
  state.calls = { busySlots: 0, resolveCodex: 0 };
  return {
    resolveCodex: () => { state.calls.resolveCodex++; return { cmd: process.execPath, args: [FAKE_CODEX_CLI] }; },
    busySlots: async () => { state.calls.busySlots++; return state.busy; },
    latestReading: () => { if (state.readingThrows) throw new Error("reading failed"); return null; },
    mapWindows: () => ({ week_pct: null, week_resets_at: null }),
    quotaDecision: () => ({ action: "proceed", notes: [] }),
  };
}

/**
 * A spawn that records every call ({cmd, args, opts}) and runs the real child_process.spawn. `fail` makes it throw.
 * It never closes the stdio fds it is given: closing them is the caller's job (a test checks that with fstatSync).
 */
export function recordingSpawn({ fail = null } = {}) {
  const calls = [], children = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts: { ...opts, env: opts?.env ? { ...opts.env } : opts?.env } });
    if (fail) throw new Error(fail);
    const child = nodeSpawn(cmd, args, opts);
    child.on("error", () => {});
    children.push(child);
    return child;
  };
  spawn.calls = calls;
  spawn.children = children;
  return spawn;
}

// ---- Task 11: fake adapters for the dispatcher and the coordinator ---------------------------------------------------
import crypto from "node:crypto";
import * as storeMod from "../store.mjs";
import { msgKey } from "../paths.mjs";
import { fallbackFor } from "../codex-resources.mjs";

const rid32 = (id) => crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 32);

/**
 * A recording Claude adapter. `create`/`message` results come from `opts.create` / `opts.message` (a value or a function of
 * (args, callIndex)); `message` also writes the real pending file (the adapter's own writeNew) so a test can count files.
 * `opts.throwOnMessage` throws on the first N message calls (a crash after the intent line). `opts.statuses`: id -> status object.
 */
export function fakeClaudeAdapter(opts = {}) {
  const calls = { create: [], message: [], status: [], statusAll: [] };
  let throwsLeft = opts.throwOnMessage ?? 0;
  const pick = (v, ...a) => (typeof v === "function" ? v(...a) : v);
  const stat = (w) => ({ status: "running", current_task: "", last_result: "", blockers: [], needs_user: false, files_changed: [], ...(opts.statuses?.[w.id] ?? {}) });
  return {
    calls,
    create(a) {
      calls.create.push(a);
      return pick(opts.create, a, calls.create.length - 1) ?? { ok: true, lane: a.workerId, worktree: `/wt/mc-${a.workerId}`, branch: `mc-${a.workerId}` };
    },
    message(w, text, rid) {
      calls.message.push({ worker: w.id, text, rid });
      if (throwsLeft > 0) { throwsLeft--; throw new Error("crash during the act"); }
      const r = pick(opts.message, w, text, rid, calls.message.length - 1);
      if (r && r.ok === false) return r;
      storeMod.writeNew(`messages/${msgKey(w.lane ?? w.id)}/${rid32(rid)}.json`, JSON.stringify({ request_id: rid, text }));
      return r ?? { ok: true, path: "delivered-next-tool" };
    },
    status(w) { calls.status.push(w.id); return stat(w); },
    ...(opts.noStatusAll ? {} : { statusAll(ws) { calls.statusAll.push(ws.map((w) => w.id)); return new Map(ws.map((w) => [w.id, stat(w)])); } }),
  };
}

/**
 * A recording Codex adapter. `opts.start`: a value or (worker, instruction, {requestId}, callIndex) => outcome (may be async or
 * throw); the default is `{started: "<id>.<n>"}`. `opts.ensure`: a result or function. `cfg` feeds fallbackFor for helpers.
 */
export function fakeCodexAdapter(opts = {}) {
  const calls = { ensureWorktree: [], ensureWorkers: [], start: [], poll: 0, status: [] };
  const homeOf = (w) => ({ id: w.id, worktree: w.worktree ?? null, branch: w.branch ?? null, in_worktree_of: w.in_worktree_of ?? null });
  const pick = (v, ...a) => (typeof v === "function" ? v(...a) : v);
  return {
    calls,
    ensureWorktree(w) {
      calls.ensureWorktree.push(w.id);
      calls.ensureWorkers.push(homeOf(w));
      const given = pick(opts.ensure, w);
      if (given) return given;
      // like the real adapter: a worker made with --in runs in the recorded worktree, any other gets its own codex-<id> one
      return w.in_worktree_of && w.worktree && w.branch ? { ok: true, worktree: w.worktree, branch: w.branch } : { ok: true, worktree: `/wt/codex-${w.id}`, branch: `codex-${w.id}` };
    },
    async start(w, instruction, o) {
      calls.start.push({ worker: w.id, instruction, requestId: o?.requestId, ...homeOf(w) });
      const r = await pick(opts.start, w, instruction, o, calls.start.length - 1);
      return r ?? { started: `${w.id}.${calls.start.filter((c) => c.worker === w.id).length}` };
    },
    async poll() { calls.poll++; return pick(opts.poll) ?? []; },
    status(w) { calls.status.push(w.id); return { status: "unknown", current_task: "", last_result: "", blockers: [], needs_user: false, files_changed: [], ...(opts.statuses?.[w.id] ?? {}) }; },
  };
}

/** A blocked outcome the way the real adapter builds it (fallbackFor applied). */
export const blockedOutcome = (kind, reason, cfg, { isNewWorker = true, queueLength = 0 } = {}) =>
  ({ blocked: kind, reason, fallback: fallbackFor(kind, cfg, { isNewWorker, queueLength }) });

/** Appends a `created` event to the workers ledger (the real store). Returns the id. */
export function seedWorker(id, provider = "claude", o = {}) {
  storeMod.appendJsonl("workers", { ev: "created", id, provider, label: o.label ?? id.replace(/-\d+$/, ""), objective: o.objective ?? "an objective",
    lane: o.lane ?? id, worktree: o.worktree ?? `/wt/${id}`, branch: o.branch ?? `b-${id}`, created_at: o.created_at ?? "2026-10-07T10:00:00.000Z",
    status: o.status ?? "running", ...(o.extra ?? {}) });
  return id;
}

/** Runs fn(env) inside a fresh mcEnv() applied to process.env; removes the temp root afterwards. */
export async function inSandbox(fn, extra = {}) {
  const env = mcEnv(extra);
  try { return await withEnv(env, () => fn(env)); } finally { env.cleanup(); }
}
