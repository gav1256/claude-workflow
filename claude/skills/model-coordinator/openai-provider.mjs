// OpenAILunaProvider: one strict-schema call to the OpenAI Responses API per decide(), no tools, bounded retries,
// every attempt metered. Fails closed: without provider "openai", a key and a complete price table it will not start.
// The key is read once, sent only in the Authorization header, and never logged, recorded or put in an error.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { ProviderError, ConfigError } from "./provider.mjs";
import { DECISION_SCHEMA } from "./schema.mjs";
import { priceOf } from "./cost.mjs";
import { secretsDir } from "./paths.mjs";

export { ConfigError };

const URL_RESPONSES = "https://api.openai.com/v1/responses";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_AFTER_CAP_MS = 20000;
const win = process.platform === "win32";

/** The key file must resolve (links followed) to a file inside secretsDir(). */
function readKeyFile(keyFile) {
  const base = realpathSync(secretsDir());
  const real = realpathSync(path.resolve(secretsDir(), keyFile));
  const a = win ? real.toLowerCase() : real, b = win ? base.toLowerCase() : base;
  if (!a.startsWith(b + path.sep)) throw new ConfigError("openai.key_file must be inside the secrets folder");
  return readFileSync(real, "utf8");
}

export function loadKey(cfg, apiKey) {
  const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v : null); // an empty variable counts as unset
  let key = nonEmpty(apiKey) ?? nonEmpty(process.env.OPENAI_API_KEY);
  if (key === null && cfg.openai?.key_file) {
    try { key = readKeyFile(cfg.openai.key_file); } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError("openai.key_file could not be read from the secrets folder");
    }
  }
  key = typeof key === "string" ? key.trim() : "";
  if (!key) throw new ConfigError("no OpenAI key: set OPENAI_API_KEY or openai.key_file (a file in the secrets folder)");
  return key;
}

const retryAfterMs = (res, n) => {
  const raw = res.headers?.get?.("retry-after");
  const s = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, RETRY_AFTER_CAP_MS) : 500 * 2 ** n;
};

/** Usage is trusted only when it has numeric token counts; otherwise the meter charges the worst case. */
const usageOf = (body) => {
  const u = body?.usage;
  return u && typeof u === "object" && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens) ? u : null;
};

export function createOpenAILunaProvider({ cfg, meter, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), apiKey } = {}) {
  if (!cfg || cfg.provider !== "openai") throw new ConfigError('OpenAI provider needs provider: "openai" in config.json');
  if (!cfg.openai || typeof cfg.openai.model !== "string") throw new ConfigError("openai.model is not set in config.json");
  if (!meter) throw new ConfigError("OpenAI provider needs a cost meter");
  if (priceOf(cfg, cfg.openai.model) === null) throw new ConfigError(`no complete price table for ${cfg.openai.model}: set pricing in config.json (input_per_mtok, cached_input_per_mtok, output_per_mtok)`);
  const o = cfg.openai;
  // A missing cap would make the worst-case pre-check 0 and the request uncapped: refuse to start instead.
  if (!Number.isInteger(o.max_output_tokens) || o.max_output_tokens < 1) throw new ConfigError("openai.max_output_tokens must be a positive integer");
  if (!Number.isInteger(o.max_retries) || o.max_retries < 0) throw new ConfigError("openai.max_retries must be an integer >= 0");
  if (typeof o.timeout_ms !== "number" || !Number.isFinite(o.timeout_ms) || o.timeout_ms <= 0) throw new ConfigError("openai.timeout_ms must be a positive number");
  const key = loadKey(cfg, apiKey);

  return {
    async decide(input) {
      const { instructions, ...rest } = input;
      const body = JSON.stringify({
        model: o.model, store: false, max_output_tokens: o.max_output_tokens,
        ...(o.reasoning_effort === null ? {} : { reasoning: { effort: o.reasoning_effort } }),
        input: [{ role: "developer", content: String(instructions ?? "") }, { role: "user", content: JSON.stringify(rest) }],
        text: { format: { type: "json_schema", name: "coordinator_decision", strict: true, schema: DECISION_SCHEMA } },
      });
      // An estimate (bytes / 3, more than the usual 4 chars per token). If it is low, the overshoot is bounded to this
      // one call: the real usage is recorded afterwards and counts toward the next check.
      const est = Math.ceil(Buffer.byteLength(body) / 3);
      const requestId = crypto.randomUUID();
      const attempts = 1 + o.max_retries;
      let last = null;

      for (let n = 0; n < attempts; n++) {
        meter.check(est); // SpendBlocked before EVERY attempt, retries included; nothing is sent when it throws
        const t0 = performance.now();
        const ac = new AbortController();
        let timedOut = false, timer;
        const aborted = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; ac.abort(); reject(new Error("timeout")); }, o.timeout_ms); });
        aborted.catch(() => {});
        const record = (usage, outcome) => meter.record({ requestId, attempt: n + 1, usage, estInputTokens: est, latencyMs: Math.round(performance.now() - t0), retries: n, outcome });
        let res, text;
        try {
          res = await Promise.race([fetch(URL_RESPONSES, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: ac.signal }), aborted]);
          text = await Promise.race([res.text(), aborted]);
        } catch {
          clearTimeout(timer);
          record(null, timedOut ? "timeout" : "network");
          last = timedOut ? new ProviderError("timeout", `OpenAI did not answer within ${o.timeout_ms} ms`) : new ProviderError("network", "network error calling OpenAI");
          if (n < attempts - 1) { await sleep(500 * 2 ** n); continue; }
          throw last;
        }
        clearTimeout(timer);

        if (res.status !== 200) {
          record(null, `http-${res.status}`);
          if (res.status === 400 && /reasoning/i.test(text)) {
            throw new ProviderError("reasoning-unsupported", `the model rejected reasoning.effort=${o.reasoning_effort}: set openai.reasoning_effort in config.json (null omits it)`);
          }
          last = new ProviderError(`http-${res.status}`, `OpenAI returned HTTP ${res.status}`);
          if (RETRYABLE.has(res.status) && n < attempts - 1) { await sleep(res.status === 429 ? retryAfterMs(res, n) : 500 * 2 ** n); continue; }
          throw last;
        }

        let parsed;
        try { parsed = JSON.parse(text); } catch {
          record(null, "bad-response");
          throw new ProviderError("bad-response", "OpenAI returned a body that is not JSON");
        }
        const fail = (code, message) => { record(usageOf(parsed), code); return new ProviderError(code, message); }; // billed tokens are real; the outcome says why it failed
        if (parsed?.status !== "completed") throw fail("incomplete", `OpenAI response is ${JSON.stringify(parsed?.status ?? null)}, not completed`);
        const msg = Array.isArray(parsed.output) ? parsed.output.find((x) => x?.type === "message") : null;
        const item = Array.isArray(msg?.content) ? msg.content[0] : null;
        if (!item) throw fail("bad-response", "OpenAI response has no message content");
        if (item.type === "refusal") throw fail("refusal", "the model refused to answer");
        if (item.type !== "output_text" || typeof item.text !== "string") throw fail("bad-response", "OpenAI response has no output_text");
        let decision;
        try { decision = JSON.parse(item.text); } catch { throw fail("not-json", "the model's output is not JSON"); }
        record(usageOf(parsed), "ok");
        return decision;
      }
      throw last ?? new ProviderError("network", "no attempt was made"); // not reachable with max_retries >= 0
    },
  };
}
