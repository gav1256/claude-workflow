// The coordinator CLI: `coordinator [--repo <dir>] [--status [--json]] [--once "<line>"] [--yes | --no]`.
// It wires the pieces (config, instance lock, provider, adapters, dispatcher, turn loop) and runs a REPL. It writes nothing itself: every
// file write goes through store.mjs, and every launch.mjs call goes through deps.runLaunch with launchEnv() (so a test can spy on it).
// Lines are processed strictly in order; a 5 s timer polls Codex and prints worker completion notices above the prompt.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as store from "./store.mjs";
import { HL_DIR } from "./paths.mjs";
import { loadConfig } from "./config.mjs";
import { acquireInstance, releaseInstance } from "./instance.mjs";
import { ConfigError, NullProvider } from "./provider.mjs";
import { createOpenAILunaProvider } from "./openai-provider.mjs";
import { createOpenAIDecisionsProvider } from "./decisions-provider.mjs";
import { createMeter } from "./cost.mjs";
import { launchEnv, childEnv, CREDENTIAL_ENV } from "./env.mjs";
import { createClaudeAdapter } from "./claude-adapter.mjs";
import { createCodexAdapter } from "./codex-adapter.mjs";
import { loadCodexLib } from "./codex-lib.mjs";
import { codexGate, createAllowance, createLoginCache, loginStatus, resourceState } from "./codex-resources.mjs";
import { createDispatcher, createWorkersView, requestIdOf } from "./dispatcher.mjs";
import { createCoordinator } from "./coordinator.mjs";
import { FINISHED } from "./validate.mjs";
import { liveLaneStatus, closedUnfinished } from "../handoff-launch/status-lib.mjs";

const LAUNCH_MJS = path.join(HL_DIR, "launch.mjs");
const USAGE = 'usage: coordinator [--repo <dir>] [--status [--json]] [--once "<line>"] [--yes | --no]';
const NO_REPO = "start the coordinator inside a git repo or pass --repo";
const POLL_MS = 5000;
const CODEX_REFRESH_MS = 30000;
const CRED_NAMES = new Set(CREDENTIAL_ENV);

/** The default launch.mjs runner: every launch.mjs call of the CLI passes an explicit opts.env (launchEnv()). -> the spawnSync result. */
export function defaultRunLaunch(args, opts = {}) {
  return spawnSync(process.execPath, [LAUNCH_MJS, ...args], { ...opts, encoding: "utf8", windowsHide: true, timeout: 600000 });
}

/**
 * Which closed lanes may be reopened. A dead Claude lane whose worktree a live `--in` worker now uses (a non-finished worker whose
 * in_worktree_of is that lane: its name, its registry id, or the lane of the worker it names) is skipped: reopening it would start
 * a second session in a checkout that is in use. -> {restart: rows[], skipped: [{row, holder}]}.
 */
export function selectRestart(rows, workers) {
  const byId = new Map((workers ?? []).map((w) => [w.id, w]));
  const holders = (workers ?? []).filter((w) => w.in_worktree_of && !FINISHED.has(w.status));
  const restart = [], skipped = [];
  for (const row of rows) {
    const holder = holders.find((w) => {
      const ref = byId.get(w.in_worktree_of);
      return w.in_worktree_of === row.name || w.in_worktree_of === row.id || (ref && (ref.lane ?? ref.id) === row.name);
    });
    if (holder) skipped.push({ row, holder }); else restart.push(row);
  }
  return { restart, skipped };
}

/**
 * Asks `question` on `rl` and resolves true/false for y/n, or null when the prompt is abandoned: Ctrl+C (the rl "SIGINT" event, which
 * a listener must exist for - without one readline just closes and the answer callback never runs) or the input closing. The caller
 * then leaves cleanly instead of waiting on an answer that can no longer come. Not covered by a real terminal test (no TTY in the test
 * run); the tests drive it with a fake TTY stream and a fake readline.
 */
export function askYesNo(rl, question) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; rl.removeListener("close", onClose); rl.removeListener("SIGINT", onSigint); resolve(v); };
    const onClose = () => done(null);
    const onSigint = () => { done(null); try { rl.close(); } catch { /* already closed */ } };
    rl.once("close", onClose);
    rl.once("SIGINT", onSigint);
    rl.question(question, (a) => done(/^y(es)?$/i.test(String(a).trim())));
  });
}

function parseArgs(argv) {
  const o = { repo: null, status: false, json: false, once: null, yes: false, no: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo" || a === "--once") {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      if (a === "--repo") o.repo = v; else o.once = v;
    } else if (a === "--status") o.status = true;
    else if (a === "--json") o.json = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--no") o.no = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else return { error: `unknown option: ${a}` };
  }
  if (o.yes && o.no) return { error: "choose --yes or --no, not both" };
  if (o.status && o.once !== null) return { error: "choose --status or --once, not both" };
  if (o.json && !o.status) return { error: "--json goes with --status" };
  return { opts: o };
}

function gitRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true, timeout: 15000, env: childEnv() });
  const t = r.status === 0 ? String(r.stdout || "").trim() : "";
  return t ? path.resolve(t) : null;
}

/** The first value of a credential variable, matched in any case (Windows spells env names as it likes). */
const envCredential = (name) => {
  const k = Object.keys(process.env).find((x) => x.toUpperCase() === name);
  return k ? process.env[k] : undefined;
};
/** Credentials are held by the provider only: no probe child (live.mjs, the Claude adapter's status calls) may inherit them. */
function scrubCredentials() {
  for (const k of Object.keys(process.env)) if (CRED_NAMES.has(k.toUpperCase())) delete process.env[k];
}

const cap = (s, n) => String(s ?? "").slice(0, n);
const money = (v) => `$${Number(v).toFixed(2)}`;
const eventLine = (e) => `${e?.worker_id ?? "?"}: ${e?.type ?? "event"}${e?.status ? ` ${e.status}` : ""}${e?.reason ? ` (${cap(e.reason, 200)})` : ""}${e?.summary ? ` - ${cap(e.summary, 200)}` : ""}`;

/** @returns {Promise<number>} the exit code: 0 ok, 1 another instance runs, 2 bad arguments or config. */
export async function main(argv, deps = {}) {
  const out = deps.out ?? process.stdout, errOut = deps.err ?? process.stderr;
  const print = (s) => { out.write(`${s}\n`); };
  const eprint = (s) => { errOut.write(`${s}\n`); };
  const parsed = parseArgs(argv);
  if (parsed.error) { eprint(parsed.error); eprint(USAGE); return 2; }
  const opts = parsed.opts;
  if (opts.help) { print(USAGE); return 0; }
  process.env.HL_MODEL_COORDINATOR = "1";

  const { config: cfg, errors } = loadConfig();
  if (errors.length) {
    eprint("coordinator: the config has errors (fix config.json and start again):");
    for (const e of errors) eprint(`  ${e}`);
    return 2;
  }
  const repo = opts.repo ? path.resolve(opts.repo) : gitRoot(deps.cwd ?? process.cwd());
  const runLaunch = deps.runLaunch ?? defaultRunLaunch;

  let server = null;
  if (!opts.status) {
    const a = await acquireInstance();
    if (a.taken !== undefined) {
      eprint(a.taken ? `coordinator already running (pid ${a.taken.pid}, since ${a.taken.started_at})` : "coordinator already running (pid unknown)");
      return 1;
    }
    server = a.server;
  }

  let timer = null, rl = null, replOn = false;
  try {
    // ---- provider (the only holder of the key), then the credentials leave process.env --------------------------------------
    const meter = createMeter({ cfg, store, ...(deps.now ? { now: deps.now } : {}) });
    const notes = [];
    let provider = new NullProvider();
    if (cfg.provider === "openai") {
      try { provider = createOpenAILunaProvider({ cfg, meter, apiKey: envCredential("OPENAI_API_KEY"), fetch: deps.fetch }); } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        notes.push(`Luna provider not started: ${e.message}. Running without Luna: shortcuts only (/to, /status, /new, /alias).`);
      }
    }
    // Decisions (the routing provider) is built separately from Luna: either can run without the other. `decisions.enabled: false`
    // builds nothing and prints no note (this is the only gate: createCoordinator uses whatever it is given).
    let decisions = null;
    if (cfg.provider === "openai" && cfg.decisions?.enabled === true) {
      try {
        decisions = (deps.makeDecisions ?? createOpenAIDecisionsProvider)({ cfg, meter: createMeter({ cfg, store, api: "decisions", ...(deps.now ? { now: deps.now } : {}) }), apiKey: envCredential("OPENAI_API_KEY"), fetch: deps.fetch });
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        notes.push(`Decisions routing not started: ${e.message}. Luna routes every message.`);
      }
    }
    scrubCredentials();

    // ---- adapters, dispatcher, turn loop ---------------------------------------------------------------------------------------
    const claude = deps.claude ?? createClaudeAdapter({ cfg, repo });
    const allowance = createAllowance(cfg.codex.max_parallel_jobs);
    const login = createLoginCache((bin) => loginStatus(bin, { env: process.env, spawnSync }), cfg.codex.login_cache_ms ?? 300000);
    const lib = await loadCodexLib();
    const codex = deps.codex ?? createCodexAdapter({ cfg, repo, lib, allowance, login });
    const workersView = createWorkersView({ store, claude, codex });
    const base = createDispatcher({ cfg, store, claude, codex, workersView, repo });
    // a create with no repo cannot place a worktree: say what to do instead of guessing a directory
    const dispatcher = repo ? base : {
      ...base,
      dispatch: async (d, o = {}) => (d.action === "create_session"
        ? { reply: NO_REPO, results: [{ ok: false, reason: "no-repo" }], requestId: requestIdOf(o.turnId, d), duplicate: false }
        : base.dispatch(d, o)),
    };

    let codexSnap = null, codexAt = 0;
    const refreshCodex = async () => {
      try { // the gate's own state, read without reserving anything (the worktree check refuses on purpose)
        const g = await allowance.withLock(() => codexGate({ cfg, lib, login, allowance, attemptId: "status-probe", worktreeCheck: () => ({ ok: false, reason: "status probe" }) }));
        codexSnap = resourceState({ cfg, allowance, gate: g });
      } catch { /* the last snapshot stands */ }
      codexAt = Date.now();
    };
    const coordinator = createCoordinator({
      cfg, store, provider, decisions, dispatcher, workersView, project: { repo },
      codexState: () => codexSnap, costState: () => ({ ...meter.state(), by_api: meter.byApi() }), poll: () => codex.poll(), ...(deps.now ? { now: deps.now } : {}),
    });

    // ---- output: above the prompt while the REPL runs ---------------------------------------------------------------------------
    const emit = (text) => {
      const tty = replOn && rl?.terminal;
      if (tty) out.write("\r\x1b[K");
      out.write(`${text}\n`);
      if (tty) rl.prompt(true);
    };
    const shown = []; // notices the timer printed that the next reply would carry again
    const fresh = (list) => (list ?? []).filter((n) => { const i = shown.indexOf(n); if (i >= 0) { shown.splice(i, 1); return false; } return true; });

    const statusLines = async (view) => [
      await dispatcher.status([], view),
      ...(() => { const c = meter.state(), a = meter.byApi(); return [`Spend this month: ${money(c.spent_usd)} (Decisions ${money(a.decisions)}, Luna ${money(a.responses)}) of ${money(c.soft).replace(/\.00$/, "")} soft / ${money(c.hard).replace(/\.00$/, "")} hard.`]; })(),
      ...(codexSnap ? [`Codex: ${codexSnap.available ? "available" : "unavailable"}, ${codexSnap.active_jobs}/${codexSnap.max_parallel_jobs} jobs, usage ${codexSnap.usage_status}`] : []),
    ];

    if (opts.status) {
      await refreshCodex();
      const view = await workersView();
      if (opts.json) print(JSON.stringify({ workers: view, cost: meter.state(), codex: codexSnap ?? resourceState({ cfg, allowance }) }, null, 2));
      else for (const l of await statusLines(view)) print(l);
      return 0;
    }

    // ---- startup -------------------------------------------------------------------------------------------------------------------
    for (const n of notes) print(n);
    try { for (const e of (await codex.reconcile()) ?? []) print(eventLine(e)); } catch (e) { print(`Codex reconcile failed: ${cap(e?.message ?? e, 200)}`); }
    await refreshCodex();
    if (opts.once === null) for (const l of await statusLines(await workersView())) print(l);

    const planRestart = async () => {
      let rows;
      try { rows = closedUnfinished(liveLaneStatus()); } catch (e) { return { error: cap(e?.message ?? e, 200), rows: [], restart: [], skipped: [] }; }
      if (!rows.length) return { rows, restart: [], skipped: [] };
      let ws = [];
      try { ws = await workersView(); } catch { /* no table: nothing is held */ }
      return { rows, ...selectRestart(rows, ws) };
    };
    const planText = (plan) => [
      ...plan.skipped.map(({ row, holder }) => `skipped ${row.name}: ${holder.id} is working in its worktree (started with --in ${holder.in_worktree_of}), so it is not reopened`),
    ];
    const runRestart = (plan) => {
      // --all reopens every closed lane: with a skipped lane each remaining one is reopened by its registry id instead
      const calls = !plan.restart.length ? [] : plan.skipped.length ? plan.restart.map((r) => ["resume", "--closed", "--id", r.id]) : [["resume", "--closed", "--all"]];
      for (const args of calls) {
        let r;
        try { r = runLaunch(args, { env: launchEnv() }); } catch (e) { print(`launch failed: ${cap(e?.message ?? e, 200)}`); continue; }
        const text = `${r?.stdout ?? ""}${r?.stderr ?? ""}`.trim();
        if (text) print(text);
        if (r?.error) print(`launch failed: ${cap(r.error.message ?? r.error, 200)}`);
        else if (r?.status !== undefined && r.status !== 0 && r.status !== null) print(`launch.mjs exited ${r.status}`);
      }
    };

    const input = deps.input ?? process.stdin;
    const ensureRl = () => (rl ??= readline.createInterface({ input, output: input.isTTY ? process.stdout : undefined, terminal: !!input.isTTY, prompt: "coordinator> " }));
    let answer = opts.yes ? "yes" : opts.no ? "no" : null;
    if (answer === null && opts.once === null && input.isTTY) answer = "ask";
    if (answer !== null && answer !== "no") {
      const plan = await planRestart();
      if (plan.error) print(`Could not list closed sessions: ${plan.error}`);
      else if (plan.rows.length) {
        print(`Closed unfinished sessions: ${plan.rows.map((r) => `${r.name} (${r.reason})`).join(", ")}`);
        for (const l of planText(plan)) print(l);
        let yes = answer === "yes";
        if (answer === "ask") {
          const asked = await askYesNo(ensureRl(), "Restart closed sessions? (y/n) ");
          if (asked === null) { print(""); return 0; } // Ctrl+C (or the input ended) at the prompt: leave cleanly; the finally below frees the pipe
          yes = asked;
        }
        if (yes) runRestart(plan);
      }
    }

    // ---- one line -------------------------------------------------------------------------------------------------------------------
    // a reply, its notices, and what a command asks for. Returns "quit" when the line was /quit.
    const handle = async (text) => {
      let r;
      try { r = await coordinator.handleLine(text); } catch (e) { emit(`error: ${cap(e?.message ?? e, 300)}`); return null; }
      emit(r.reply);
      for (const n of fresh(r.notices)) emit(`! ${n}`);
      if (r.command === "restart-closed") {
        const plan = await planRestart();
        if (plan.error) emit(`Could not list closed sessions: ${plan.error}`);
        else if (!plan.rows.length) emit("No closed sessions to reopen.");
        else { for (const l of planText(plan)) emit(l); runRestart(plan); }
      }
      return r.command === "quit" ? "quit" : null;
    };

    if (opts.once !== null) { await handle(opts.once); return 0; }

    // ---- the REPL -------------------------------------------------------------------------------------------------------------------
    const rlIn = ensureRl();
    let quit = false, finished = false, chain = Promise.resolve(), busy = false, resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const finish = () => { if (finished) return; finished = true; clearInterval(timer); rlIn.close(); resolveDone(); };
    const prompt = () => { if (rlIn.terminal) rlIn.prompt(); };
    rlIn.on("line", (line) => {
      chain = chain.then(async () => { // strictly in order; a line after /quit is dropped
        if (quit) return;
        const t = line.trim();
        if (t && (await handle(t)) === "quit") { quit = true; finish(); return; }
        prompt();
      });
    });
    rlIn.on("close", () => { chain = chain.then(finish); }); // end of input: the queued lines finish first
    rlIn.on("SIGINT", () => { quit = true; finish(); });
    const onSignal = () => { quit = true; finish(); };
    process.once("SIGINT", onSignal);
    timer = setInterval(async () => {
      if (busy || finished) return;
      busy = true;
      try {
        const t = await coordinator.tick();
        if (!t.skipped) {
          for (const n of t.notices) { shown.push(n); emit(`! ${n}`); }
          if (Date.now() - codexAt > CODEX_REFRESH_MS) await refreshCodex();
        }
      } catch { /* a failed poll is tried again on the next beat */ } finally { busy = false; }
    }, deps.pollMs ?? POLL_MS);
    replOn = true;
    print("Type a message or /help. /quit leaves; workers keep running.");
    prompt();
    try { await done; } finally { process.removeListener("SIGINT", onSignal); }
    return 0;
  } finally {
    clearInterval(timer);
    try { rl?.close(); } catch { /* already closed */ }
    await releaseInstance(server);
  }
}

const isEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    const a = realpathSync(process.argv[1]), b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();
if (isEntry) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e?.stack ?? e); process.exit(1); });
}
