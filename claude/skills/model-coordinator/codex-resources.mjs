// Codex resource manager: login class, own job cap, machine slots, quota, worktree, and the fallback policy.
// The Codex skill's lib (resolveCodex, busySlots, latestReading, mapWindows, quotaDecision) arrives as the `lib` argument
// (the caller imports it from codexSkillDir()/lib/); a null `lib` means Codex is not installed.
// This module starts no process and writes no file: loginStatus takes the process runner as `spawnSync` (the Codex adapter,
// which may import child_process, injects it). Without one the login class is "unknown", never a guess.
import os from "node:os";
import path from "node:path";
import { childEnv } from "./env.mjs";

// `codex login status` wording (Step 0 was run by the controller): a subscription login prints exactly "Logged in using
// ChatGPT" and exits 0; an API-key login says "Logged in using an API key" (exit 0); no login says "Not logged in" with
// exit 1 (the text may continue, e.g. "... Run codex login or supply an API key."). Output may arrive on stdout or stderr.
// Only the class is kept; the raw text is never returned or logged.
function classify(r) {
  if (!r || r.error || r.status === null || r.status === undefined) return "unknown"; // timeout, spawn failure
  const t = `${r.stdout ?? ""}
${r.stderr ?? ""}`;
  if (/not logged in/i.test(t)) return "none"; // first: "Not logged in ... API key" must never read as a login
  if (r.status !== 0) return "unknown"; // an authenticated class needs a clean exit
  if (/logged in using chatgpt/i.test(t)) return "chatgpt";
  if (/logged in using an api key/i.test(t)) return "api_key";
  return "unknown";
}

/**
 * Runs `<bin.cmd> [...bin.args] login status` and returns "chatgpt" | "api_key" | "none" | "unknown".
 * The child gets childEnv() (no credentials, no HL_*, no CLAUDE* but CLAUDE_CONFIG_DIR) plus CODEX_HOME.
 */
export function loginStatus(bin, { env = process.env, timeoutMs = 15000, spawnSync = null } = {}) {
  if (typeof spawnSync !== "function" || !bin?.cmd) return "unknown";
  const codexHome = env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let r;
  try {
    r = spawnSync(bin.cmd, [...(bin.args ?? []), "login", "status"], {
      env: childEnv({ from: env, extra: { CODEX_HOME: codexHome } }), encoding: "utf8", timeout: timeoutMs, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { return "unknown"; }
  return classify(r);
}

/**
 * A cached, de-duplicated login probe: `await cache(bin)` calls `probe(bin)` at most once per `ttlMs` (concurrent calls
 * share one probe). `now` is a clock function. `cache.reset()` forgets the answer.
 */
export function createLoginCache(probe, ttlMs, now = Date.now) {
  const entries = new Map(); // key (the bin) -> {at, value, inflight}
  const keyOf = (bin) => JSON.stringify([bin?.cmd ?? null, bin?.args ?? []]);
  const cache = (bin) => {
    const key = keyOf(bin);
    let e = entries.get(key);
    if (!e) entries.set(key, (e = { at: null, value: null, inflight: null }));
    if (e.at !== null && now() - e.at < ttlMs) return Promise.resolve(e.value);
    if (!e.inflight) {
      // assigned before the probe runs and cleared on settlement, so a synchronous throw or a rejection is never cached
      const p = Promise.resolve().then(() => probe(bin)).then((v) => { e.value = v; e.at = now(); return v; });
      e.inflight = p;
      const clear = () => { if (e.inflight === p) e.inflight = null; };
      p.then(clear, clear);
    }
    return e.inflight;
  };
  cache.reset = () => entries.clear();
  return cache;
}

/** {status: ok|near_limit|exhausted|unknown, why, blocks}. `model` is the model the wrapper will run (cfg.codex.model). */
export function usageStatus(reading, { now, busySlots, lib, model }) {
  if (!reading || !reading.rl) return { status: "unknown", why: "no-reading", blocks: false }; // first run makes one
  const mw = lib.mapWindows(reading.rl);
  const qd = lib.quotaDecision({ reading, now, busySlots, mode: "write", model }); // the configured model, never a constant
  if (qd.action === "block") {
    return qd.reason === "codex-quota-unknown-reset"
      ? { status: "unknown", why: qd.reason, blocks: true }
      : { status: "exhausted", why: qd.reason, blocks: true };
  }
  if (mw.week_pct !== null && mw.week_resets_at === null) return { status: "unknown", why: "no-reset", blocks: true }; // Resolution C
  if (mw.week_pct === null && mw.week_resets_at === null) return { status: "unknown", why: "no-weekly-window", blocks: false };
  // the wrapper's effective pct (usage.mjs); downgrade is sol-only, near_limit is not
  const eff = (mw.week_resets_at * 1000 <= now ? 0 : (mw.week_pct ?? 0)) + 2 * busySlots;
  if (qd.action === "downgrade" || eff >= 85) return { status: "near_limit", why: qd.reason ?? `week-pct ${eff}`, blocks: false };
  return { status: "ok", why: null, blocks: false };
}

/** The coordinator's own count of running Codex jobs. `reserve` is called only inside `withLock`. */
export function createAllowance(max) {
  let held = new Set(), chain = Promise.resolve();
  const withLock = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  return {
    withLock,
    reserve: (id) => (held.size < max ? (held.add(id), true) : false),
    release: (id) => { held.delete(id); },
    active: () => held.size,
    rebuild: (ids) => { held = new Set(ids); },
  };
}

/**
 * Call inside allowance.withLock. Order: lib -> binary -> login -> own cap -> machine slots -> quota -> worktree; reserves
 * `attemptId` on success. -> {ok: true, state, bin} | {ok: false, kind, reason, state}.
 * kind: unavailable | busy | exhausted | unknown | conflict.
 */
export async function codexGate({ cfg, lib, login, allowance, worktreeCheck, attemptId, now = Date.now() }) {
  const state = { active_jobs: allowance.active(), max_parallel_jobs: cfg.codex.max_parallel_jobs,
    available: false, capacity_available: false, usage_status: "unknown" };
  const no = (kind, reason) => ({ ok: false, kind, reason, state });
  if (!lib) return no("unavailable", "codex-skill-absent");
  let bin;
  try { bin = lib.resolveCodex(); } catch { return no("unavailable", "codex-not-found"); }
  let who;
  try { who = await login(bin); } catch { return no("unavailable", "codex-login-error"); }
  if (who !== "chatgpt") return no("unavailable", `codex-login-${who}`); // api_key never used silently (Resolution E)
  state.available = true;
  if (allowance.active() >= cfg.codex.max_parallel_jobs) return no("busy", "codex-own-cap");
  let busy;
  try { busy = await lib.busySlots(); } catch { busy = 3; } // a failed probe is the conservative side
  if (!Number.isInteger(busy) || busy < 0) busy = 3; // so is an answer that is not a count
  if (busy >= 3) return no("busy", "codex-slots-full");
  state.capacity_available = true;
  let reading = null;
  try { reading = lib.latestReading(now); } catch { return no("unknown", "codex-quota-read-failed"); } // like a failed slot probe: block
  const u = usageStatus(reading, { now, busySlots: busy, lib, model: cfg.codex.model });
  state.usage_status = u.status;
  if (u.blocks) return no(u.status === "exhausted" ? "exhausted" : "unknown", u.why);
  const w = worktreeCheck();
  if (!w.ok) return no("conflict", w.reason);
  if (!allowance.reserve(attemptId)) return no("busy", "codex-own-cap");
  state.active_jobs = allowance.active();
  return { ok: true, state, bin };
}

/** What to do when the gate said no: {action: queue | claude | refuse | clarify, reason}. */
export function fallbackFor(kind, cfg, { isNewWorker, queueLength }) {
  if (kind === "conflict") return { action: "clarify", reason: "workspace conflict" };
  if (kind === "busy") return queueLength < cfg.codex.queue_max ? { action: "queue", reason: "Codex busy" } : policy();
  if (!isNewWorker) return { action: "refuse", reason: "an existing Codex worker is not moved to another provider" };
  return policy();
  function policy() {
    if (!isNewWorker) return { action: "refuse", reason: "Codex queue full" };
    if (cfg.codex.fallback === "refuse") return { action: "refuse", reason: "fallback policy: refuse" };
    return { action: "claude", reason: "fallback policy: Claude worker" };
  }
}

/** CodexResourceState {active_jobs, max_parallel_jobs, available, capacity_available, usage_status} from the last gate result. */
export function resourceState({ cfg, allowance, gate = null }) {
  const s = gate?.state ?? {};
  return {
    active_jobs: allowance.active(),
    max_parallel_jobs: cfg.codex.max_parallel_jobs,
    available: s.available ?? false,
    capacity_available: s.capacity_available ?? false,
    usage_status: s.usage_status ?? "unknown",
  };
}
