// OpenAIDecisionsProvider: one call to the OpenAI Decisions API per ask(), no tools, bounded retries, every attempt metered
// (api "decisions": input tokens only). Fails closed: without provider "openai", decisions.enabled, a key and a Decisions
// price it will not start. The key is sent only in the Authorization header and never appears in an error, record or log.
// It returns normalised answers and nothing else: no module here interprets them (decisions.mjs does) or runs model output.
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { ProviderError, ConfigError } from "./provider.mjs";
import { decisionsPriceOf } from "./cost.mjs";
import { loadKey } from "./openai-provider.mjs";

export { ConfigError };

const URL_DECISIONS = "https://api.openai.com/v1/decisions";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_AFTER_CAP_MS = 20000;
const FRAMING_BYTES = 1024;
const SUM_LIMIT = 1.02; // a truncated list (sum below 1) is fine; a sum above this is not a probability distribution
const EPS = 1e-9;

const retryAfterMs = (res, n) => {
  const raw = res.headers?.get?.("retry-after");
  const s = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, RETRY_AFTER_CAP_MS) : 500 * 2 ** n;
};

/** Usage is trusted only with a finite input_tokens (Decisions returns no output tokens); otherwise the meter charges the worst case. */
const usageOf = (body) => {
  const u = body?.usage;
  return u && typeof u === "object" && Number.isFinite(u.input_tokens) ? u : null;
};

const unusable = (why) => new ProviderError("unusable", `the Decisions answer is unusable: ${why}`);

/** Each probability entry is `{value, probability}` with a finite probability in [0,1]; the sum may not exceed 1.02. Returns the entries. */
function checkedEntries(a) {
  if (!Array.isArray(a?.probabilities)) throw unusable("no probabilities list");
  let sum = 0;
  for (const e of a.probabilities) {
    const p = e?.probability;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw unusable("a probability is not a number from 0 to 1");
    sum += p;
  }
  if (sum > SUM_LIMIT + EPS) throw unusable("the probabilities sum to more than 1");
  return a.probabilities;
}

function readChoice(q, a) {
  const offered = new Set((q.choices ?? []).map((c) => c.value));
  if (typeof a.choice !== "string" || !offered.has(a.choice)) throw unusable(`the choice for ${q.name} is not one of the offered values`);
  const probs = new Map();
  for (const e of checkedEntries(a)) {
    if (typeof e.value !== "string" || !offered.has(e.value)) throw unusable(`a probability for ${q.name} names a value that was not offered`);
    if (probs.has(e.value)) throw unusable(`a value of ${q.name} has two probabilities`);
    probs.set(e.value, e.probability);
  }
  if (!probs.has(a.choice)) throw unusable(`the chosen value of ${q.name} has no probability`);
  return { type: "choice", choice: a.choice, probs };
}

/** pTrue = the probability whose value is true / "true"; with only the false entry, 1 - p(false); otherwise unusable. */
function readPredicate(q, a) {
  const flag = (v) => {
    if (v === true || v === false) return v;
    if (typeof v === "string") { const s = v.toLowerCase(); if (s === "true") return true; if (s === "false") return false; }
    return null;
  };
  let t = null, f = null;
  for (const e of checkedEntries(a)) {
    const v = flag(e.value);
    if (v === true) { if (t !== null) throw unusable(`${q.name} has two true probabilities`); t = e.probability; }
    else if (v === false) { if (f !== null) throw unusable(`${q.name} has two false probabilities`); f = e.probability; }
  }
  if (t !== null) return { type: "predicate", pTrue: t };
  if (f !== null) return { type: "predicate", pTrue: 1 - f };
  throw unusable(`${q.name} has no readable true probability`);
}

function readAnswer(q, entries) {
  if (entries.length !== 1) throw unusable(entries.length ? `${q.name} was answered twice` : `no answer for ${q.name}`);
  const a = entries[0];
  if (a.type !== q.type) throw unusable(`the answer to ${q.name} has the wrong type`);
  if (q.type === "choice") return readChoice(q, a);
  if (q.type === "predicate") return readPredicate(q, a);
  throw unusable(`question type ${q.type} is not supported`);
}

/**
 * Answers -> `byName`. Refusal precedence: if ANY asked question was refused, every other shape check is skipped (an answer that
 * does not read cleanly is left out), so the interpreter clarifies instead of falling back to a route that could dispatch.
 */
function normalise(questions, answers) {
  const of = (q) => answers.filter((a) => a && typeof a === "object" && a.name === q.name);
  const refused = questions.filter((q) => of(q).some((a) => a.type === "refusal"));
  const byName = {};
  if (refused.length) {
    for (const q of questions) {
      if (refused.includes(q)) { byName[q.name] = { type: "refusal" }; continue; }
      try { byName[q.name] = readAnswer(q, of(q)); } catch (e) { if (!(e instanceof ProviderError)) throw e; }
    }
    return byName;
  }
  for (const q of questions) byName[q.name] = readAnswer(q, of(q));
  return byName;
}

export function createOpenAIDecisionsProvider({ cfg, meter, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), apiKey } = {}) {
  if (!cfg || cfg.provider !== "openai") throw new ConfigError('Decisions provider needs provider: "openai" in config.json');
  const d = cfg.decisions;
  if (!d || typeof d !== "object" || d.enabled !== true) throw new ConfigError("decisions.enabled is not true in config.json");
  if (d.model !== "gpt-6-luna") throw new ConfigError('decisions.model must be "gpt-6-luna"');
  if (decisionsPriceOf(cfg) === null) throw new ConfigError("no Decisions price: set pricing.gpt-6-luna.decisions_input_per_mtok in config.json");
  if (!meter) throw new ConfigError("Decisions provider needs a cost meter");
  if (!Number.isInteger(d.max_retries) || d.max_retries < 0) throw new ConfigError("decisions.max_retries must be an integer >= 0");
  if (typeof d.timeout_ms !== "number" || !Number.isFinite(d.timeout_ms) || d.timeout_ms <= 0) throw new ConfigError("decisions.timeout_ms must be a positive number");
  const key = loadKey(cfg, apiKey);

  return {
    async ask(req) {
      const questions = Array.isArray(req?.questions) ? req.questions : [];
      const body = JSON.stringify({ model: d.model, input: req?.input, questions });
      // Upper bound: a token is at least one byte of UTF-8, so bytes plus a framing allowance cannot be too low.
      const est = Buffer.byteLength(body) + FRAMING_BYTES;
      const requestId = crypto.randomUUID();
      const attempts = 1 + d.max_retries;
      let last = null;

      for (let n = 0; n < attempts; n++) {
        meter.check(est); // SpendBlocked before EVERY attempt, retries included; nothing is sent when it throws
        const t0 = performance.now();
        const ac = new AbortController();
        let timedOut = false, timer;
        const aborted = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; ac.abort(); reject(new Error("timeout")); }, d.timeout_ms); });
        aborted.catch(() => {});
        const record = (usage, outcome) => meter.record({ requestId, attempt: n + 1, usage, estInputTokens: est, latencyMs: Math.round(performance.now() - t0), retries: n, outcome });
        let res, text;
        try {
          res = await Promise.race([fetch(URL_DECISIONS, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: ac.signal }), aborted]);
          text = await Promise.race([res.text(), aborted]);
        } catch {
          clearTimeout(timer);
          record(null, timedOut ? "timeout" : "network");
          last = timedOut ? new ProviderError("timeout", `Decisions did not answer within ${d.timeout_ms} ms`) : new ProviderError("network", "network error calling Decisions");
          if (n < attempts - 1) { await sleep(500 * 2 ** n); continue; }
          throw last;
        }
        clearTimeout(timer);

        if (res.status !== 200) {
          record(null, `http-${res.status}`);
          last = new ProviderError(`http-${res.status}`, `Decisions returned HTTP ${res.status}`);
          if (RETRYABLE.has(res.status) && n < attempts - 1) { await sleep(res.status === 429 ? retryAfterMs(res, n) : 500 * 2 ** n); continue; }
          throw last;
        }

        let parsed;
        try { parsed = JSON.parse(text); } catch {
          record(null, "bad-response");
          throw new ProviderError("bad-response", "Decisions returned a body that is not JSON");
        }
        const usage = usageOf(parsed);
        const fail = (e) => { record(usage, e.code); return e; }; // billed tokens are real; the outcome says why it failed
        if (!Array.isArray(parsed?.answers)) throw fail(new ProviderError("bad-response", "Decisions response has no answers list"));
        let byName;
        try { byName = normalise(questions, parsed.answers); } catch (e) {
          if (e instanceof ProviderError) throw fail(e);
          throw e;
        }
        record(usage, "ok");
        return { byName, usage };
      }
      throw last ?? new ProviderError("network", "no attempt was made"); // not reachable with max_retries >= 0
    },
  };
}
