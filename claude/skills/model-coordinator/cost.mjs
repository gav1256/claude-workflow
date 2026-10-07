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
export const callCost = (p, { input, cached, output }) =>
  ((Math.max(0, input - cached)) * p.input_per_mtok + cached * p.cached_input_per_mtok + output * p.output_per_mtok) / 1e6;
export const worstCase = (p, estInput, maxOut) => (estInput * p.input_per_mtok + maxOut * p.output_per_mtok) / 1e6;
export const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7); // UTC month
export const monthSpend = (lines, now) => lines.filter((u) => u.month === monthKey(now)).reduce((s, u) => s + (Number(u.cost_usd) || 0), 0);

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

/** `store` needs readJsonl(name) and appendJsonl(name, obj) (store.mjs). */
export function createMeter({ cfg, store, now = Date.now }) {
  const p = priceOf(cfg, cfg.openai.model);
  const spent = () => monthSpend(store.readJsonl("usage"), now());
  const noPrice = () => new SpendBlocked("no price table: set pricing in config.json");
  return {
    check(estInputTokens) { // before EVERY attempt, retries included
      if (!p) throw noPrice();
      if (!Number.isInteger(cfg.openai.max_output_tokens) || cfg.openai.max_output_tokens < 1) throw new SpendBlocked("openai.max_output_tokens must be a positive integer");
      const g = spendGate({ spent: spent(), worst: worstCase(p, estInputTokens, cfg.openai.max_output_tokens), limits: cfg.limits });
      if (!g.allow) throw new SpendBlocked(g.reason);
      return g;
    },
    // usage missing (timeout, network error after send, malformed body): charge the worst case, never 0
    record({ requestId, attempt, usage, estInputTokens, latencyMs, retries, outcome }) {
      if (!p) throw noPrice();
      const u = usage ?? null;
      const cost = u ? callCost(p, { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0 })
        : worstCase(p, estInputTokens, cfg.openai.max_output_tokens);
      store.appendJsonl("usage", { at: new Date(now()).toISOString(), month: monthKey(now()), model: cfg.openai.model, request_id: requestId,
        attempt, input_tokens: u?.input_tokens ?? null, cached_input_tokens: u?.input_tokens_details?.cached_tokens ?? null,
        output_tokens: u?.output_tokens ?? null, latency_ms: latencyMs, retries, cost_usd: cost, estimated: !u, outcome });
    },
    state() {
      const s = spent();
      return { spent_usd: s, soft: cfg.limits.monthly_soft_usd, hard: cfg.limits.monthly_hard_usd,
        state: s >= cfg.limits.monthly_hard_usd ? "hard" : s >= cfg.limits.monthly_soft_usd ? "soft" : "ok" };
    },
  };
}
