// Cost ledger, soft and hard monthly limits. Pure functions plus a meter over the store's "usage" ledger.
// The ledger holds token counts and cost only: never a key, a prompt or a reply.
import { ProviderError } from "./provider.mjs";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** The price table of a model, or null when any of the three prices is missing or not a non-negative number. */
export function priceOf(cfg, model) {
  const p = cfg?.pricing?.[model];
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return p && ok(p.input_per_mtok) && ok(p.cached_input_per_mtok) && ok(p.output_per_mtok) ? p : null;
}
/** The Decisions price: `pricing[decisions.model].decisions_input_per_mtok`, or null when it is not a non-negative number. */
export function decisionsPriceOf(cfg) {
  const r = cfg?.pricing?.[cfg?.decisions?.model]?.decisions_input_per_mtok;
  return typeof r === "number" && Number.isFinite(r) && r >= 0 ? { input_per_mtok: r } : null;
}
export const callCost = (p, { input, cached, output }) =>
  ((Math.max(0, input - cached)) * p.input_per_mtok + cached * p.cached_input_per_mtok + output * p.output_per_mtok) / 1e6;
export const worstCase = (p, estInput, maxOut) => (estInput * p.input_per_mtok + maxOut * p.output_per_mtok) / 1e6;
export const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7); // UTC month
const apiOf = (u) => (u.api === "decisions" ? "decisions" : "responses"); // a line without `api` is a responses line
const inMonth = (lines, now) => lines.filter((u) => u.month === monthKey(now));
export const monthSpend = (lines, now) => inMonth(lines, now).reduce((s, u) => s + (Number(u.cost_usd) || 0), 0);
export const monthSpendByApi = (lines, now) => inMonth(lines, now).reduce((o, u) => { o[apiOf(u)] += Number(u.cost_usd) || 0; return o; }, { decisions: 0, responses: 0 });

export class SpendBlocked extends ProviderError {
  constructor(reason) { super("hard-limit", reason, { retryable: false }); this.name = "SpendBlocked"; }
}

export function spendGate({ spent, worst, limits }) {
  // Fail closed on a limit or an amount that is not a number: a broken config must never open the gate.
  if (!finite(limits?.monthly_hard_usd) || !finite(limits?.monthly_soft_usd) || !finite(spent) || !finite(worst)) {
    return { allow: false, state: "hard", reason: "spend limits or amounts are not numbers: fix limits in config.json" };
  }
  if (spent >= limits.monthly_hard_usd) return { allow: false, state: "hard", reason: `monthly hard limit $${limits.monthly_hard_usd} reached ($${spent.toFixed(2)})` };
  if (spent + worst > limits.monthly_hard_usd) return { allow: false, state: "hard", reason: `this call could pass the hard limit ($${spent.toFixed(2)} + up to $${worst.toFixed(4)})` };
  return { allow: true, state: spent >= limits.monthly_soft_usd ? "soft" : "ok" };
}

/**
 * `store` needs readJsonl(name) and appendJsonl(name, obj) (store.mjs). `api` is "responses" (the Luna writer, default)
 * or "decisions" (input-only price). The monthly gate and state() always use the COMBINED spend of both apis.
 */
export function createMeter({ cfg, store, now = Date.now, api = "responses" }) {
  const dec = api === "decisions";
  const p = dec ? decisionsPriceOf(cfg) : priceOf(cfg, cfg.openai.model);
  const model = dec ? cfg.decisions?.model : cfg.openai.model;
  const worst = (est) => (dec ? (est * p.input_per_mtok) / 1e6 : worstCase(p, est, cfg.openai.max_output_tokens));
  const spent = () => monthSpend(store.readJsonl("usage"), now());
  const noPrice = () => new SpendBlocked(dec ? "no decisions price: set pricing.<model>.decisions_input_per_mtok in config.json" : "no price table: set pricing in config.json");
  return {
    check(estInputTokens) { // before EVERY attempt, retries included
      if (!p) throw noPrice();
      if (!dec && (!Number.isInteger(cfg.openai.max_output_tokens) || cfg.openai.max_output_tokens < 1)) throw new SpendBlocked("openai.max_output_tokens must be a positive integer");
      const g = spendGate({ spent: spent(), worst: worst(estInputTokens), limits: cfg.limits });
      if (!g.allow) throw new SpendBlocked(g.reason);
      return g;
    },
    // usage missing (timeout, network error after send, malformed body): charge the worst case, never 0
    record({ requestId, attempt, usage, estInputTokens, latencyMs, retries, outcome }) {
      if (!p) throw noPrice();
      const at = new Date(now()).toISOString(), month = monthKey(now());
      if (dec) {
        // Decisions returns no output_tokens: only a finite input_tokens counts as usage, anything else is the worst case
        const known = Number.isFinite(usage?.input_tokens);
        store.appendJsonl("usage", { at, month, api, model, request_id: requestId, attempt,
          input_tokens: known ? usage.input_tokens : null, cached_input_tokens: null, output_tokens: null, latency_ms: latencyMs, retries,
          cost_usd: known ? (usage.input_tokens * p.input_per_mtok) / 1e6 : worst(estInputTokens), estimated: !known, outcome });
        return;
      }
      const u = usage ?? null;
      const cost = u ? callCost(p, { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0 })
        : worst(estInputTokens);
      store.appendJsonl("usage", { at, month, api, model, request_id: requestId,
        attempt, input_tokens: u?.input_tokens ?? null, cached_input_tokens: u?.input_tokens_details?.cached_tokens ?? null,
        output_tokens: u?.output_tokens ?? null, latency_ms: latencyMs, retries, cost_usd: cost, estimated: !u, outcome });
    },
    byApi() { return monthSpendByApi(store.readJsonl("usage"), now()); },
    state() {
      const s = spent();
      return { spent_usd: s, soft: cfg.limits.monthly_soft_usd, hard: cfg.limits.monthly_hard_usd,
        state: s >= cfg.limits.monthly_hard_usd ? "hard" : s >= cfg.limits.monthly_soft_usd ? "soft" : "ok" };
    },
  };
}
