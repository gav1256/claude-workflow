import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mcEnv, withEnv, mkJunction, rmJunction, rmrf } from "./mc-helpers.mjs";
import { loadConfig, DEFAULTS } from "../config.mjs";
import { stateDir, secretsDir } from "../paths.mjs";

/** Writes <state>/config.json (when `cfgObj` is given) and runs loadConfig under the temp env. */
async function load(cfgObj, setup) {
  const env = mcEnv();
  try {
    return await withEnv(env, () => {
      if (cfgObj !== undefined) {
        fs.mkdirSync(stateDir(), { recursive: true });
        fs.writeFileSync(path.join(stateDir(), "config.json"), typeof cfgObj === "string" ? cfgObj : JSON.stringify(cfgObj));
      }
      setup?.(env);
      return loadConfig();
    });
  } finally { env.cleanup(); }
}

test("defaults: no config file gives DEFAULTS and no errors", async () => {
  const { config, errors } = await load(undefined);
  assert.deepEqual(errors, []);
  assert.deepEqual(config, DEFAULTS);
  assert.equal(config.provider, "none");
  assert.equal(config.codex.max_parallel_jobs, 2);
  assert.equal(config.claude.model, "opus");
  assert.notEqual(config.codex, DEFAULTS.codex, "the result is a copy; DEFAULTS cannot be mutated through it");
});

test("a partial config merges key by key over DEFAULTS", async () => {
  const { config, errors } = await load({ provider: "openai", codex: { max_parallel_jobs: 3 }, limits: { monthly_hard_usd: 12 }, pricing: { "gpt-6-luna": { in: 1 } } });
  assert.deepEqual(errors, []);
  assert.equal(config.provider, "openai");
  assert.equal(config.codex.max_parallel_jobs, 3);
  assert.equal(config.codex.fallback, "claude");
  assert.equal(config.limits.monthly_soft_usd, 7);
  assert.equal(config.limits.monthly_hard_usd, 12);
  assert.deepEqual(config.pricing, { "gpt-6-luna": { in: 1 } });
});

test("M8 loadConfig refuses sonnet/haiku, bad parallel jobs, paid_api (naming V1), bad reasoning_effort", async () => {
  let r = await load({ claude: { model: "sonnet" } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /claude\.model/);
  assert.equal(r.config.claude.model, "opus", "the unsafe value is replaced by the default");
  assert.equal((await load({ claude: { model: "Claude-Haiku-4" } })).errors.length, 1);
  assert.deepEqual((await load({ claude: { model: "opus", effort: "high" } })).errors, []);

  for (const bad of [5, 0, 2.5, "2", null]) {
    r = await load({ codex: { max_parallel_jobs: bad } });
    assert.equal(r.errors.length, 1, String(bad));
    assert.match(r.errors[0], /max_parallel_jobs/);
    assert.equal(r.config.codex.max_parallel_jobs, 2);
  }
  for (const good of [1, 2, 3]) assert.deepEqual((await load({ codex: { max_parallel_jobs: good } })).errors, []);

  r = await load({ codex: { fallback: "paid_api" } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /paid_api fallback is not supported in V1/);
  assert.equal(r.config.codex.fallback, "claude");
  r = await load({ codex: { fallback: "queue" } });
  assert.equal(r.errors.length, 1);
  assert.deepEqual((await load({ codex: { fallback: "refuse" } })).errors, []);

  r = await load({ openai: { reasoning_effort: 3 } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /reasoning_effort/);
  assert.equal((await load({ openai: { reasoning_effort: "" } })).errors.length, 1);
  r = await load({ openai: { reasoning_effort: null } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.openai.reasoning_effort, null);
  assert.deepEqual((await load({ openai: { reasoning_effort: "low" } })).errors, []);
});

test("M8 openai.key_file must resolve inside secrets/: a .. path and a junction are refused", async () => {
  // inside: relative, absolute, and not yet created
  let r = await load({ openai: { key_file: "openai.key" } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.openai.key_file, "openai.key");
  const env = mcEnv();
  try {
    await withEnv(env, () => {
      fs.mkdirSync(secretsDir(), { recursive: true });
      const write = (o) => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(path.join(stateDir(), "config.json"), JSON.stringify(o)); return loadConfig(); };
      fs.writeFileSync(path.join(secretsDir(), "ok.key"), "k");
      assert.deepEqual(write({ openai: { key_file: path.join(secretsDir(), "ok.key") } }).errors, []);
      // a .. path (relative and absolute) that leaves secrets/
      for (const bad of ["../escape.key", path.join(secretsDir(), "..", "escape.key"), path.join(env.root, "elsewhere.key"), secretsDir(), "..\\escape.key"]) {
        const out = write({ openai: { key_file: bad } });
        assert.equal(out.errors.length, 1, bad);
        assert.match(out.errors[0], /key_file/);
        assert.equal(out.config.openai.key_file, null);
      }
      // a junction inside secrets/ that points outside
      const outside = path.join(env.root, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "stolen.key"), "k");
      const link = path.join(secretsDir(), "link");
      mkJunction(link, outside);
      try {
        const out = write({ openai: { key_file: "link/stolen.key" } });
        assert.equal(out.errors.length, 1);
        assert.match(out.errors[0], /key_file/);
        // a junction that points back inside is fine
        const inner = path.join(secretsDir(), "inner");
        fs.mkdirSync(inner);
        const link2 = path.join(secretsDir(), "link2");
        mkJunction(link2, inner);
        try { assert.deepEqual(write({ openai: { key_file: "link2/x.key" } }).errors, []); } finally { rmJunction(link2); }
      } finally { rmJunction(link); }
    });
  } finally { env.cleanup(); }
});

test("a malformed or non-object config.json is an error with defaults, not a throw", async () => {
  let r = await load("{ not json");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /config\.json/);
  assert.deepEqual(r.config, DEFAULTS);
  r = await load("[1,2]");
  assert.equal(r.errors.length, 1);
  r = await load({ codex: 5 });
  assert.ok(r.errors.some((e) => /^codex/.test(e)));
  assert.deepEqual(r.config.codex, DEFAULTS.codex);
});

test("loadConfig never writes: the state folder is not created", async () => {
  const env = mcEnv();
  try {
    await withEnv(env, () => { loadConfig(); assert.equal(fs.existsSync(stateDir()), false); });
  } finally { rmrf(env.root); }
});

test("V8 DEFAULTS is deep-frozen", () => {
  const frozen = (o) => Object.isFrozen(o) && Object.values(o).every((v) => v === null || typeof v !== "object" || frozen(v));
  assert.ok(frozen(DEFAULTS));
  assert.throws(() => { "use strict"; DEFAULTS.codex.max_parallel_jobs = 9; }, TypeError);
  assert.throws(() => { "use strict"; DEFAULTS.openai.max_retries = 9; }, TypeError);
});

// ---- Decisions block (Decisions-routing Task 1, M1) ----
const DEC_PROBS = ["min_route_probability", "min_margin", "concern_high", "concern_low", "needs_text_threshold", "risky_min_probability", "fallback_min_confidence"];

test("D1 decisions defaults are present and a partial block merges over them", async () => {
  const { config, errors } = await load({ decisions: { timeout_ms: 5000 } });
  assert.deepEqual(errors, []);
  assert.deepEqual(DEFAULTS.decisions, {
    enabled: true, model: "gpt-6-luna", timeout_ms: 10000, max_retries: 1, min_route_probability: 0.8, min_margin: 0.2,
    concern_high: 0.8, concern_low: 0.3, needs_text_threshold: 0.5, risky_min_probability: 0.9, fallback_min_confidence: 0.8,
    max_input_chars: 16000, max_message_chars: 6000,
  });
  assert.equal(config.decisions.timeout_ms, 5000);
  assert.equal(config.decisions.max_retries, 1);
});

test("D1 decisions.enabled must be a boolean", async () => {
  for (const v of ["yes", 1, null]) {
    const r = await load({ decisions: { enabled: v } });
    assert.equal(r.errors.length, 1, `enabled=${JSON.stringify(v)}`);
    assert.match(r.errors[0], /decisions\.enabled/);
    assert.equal(r.config.decisions.enabled, true);
  }
  assert.deepEqual((await load({ decisions: { enabled: false } })).errors, []);
});

test("D1 decisions.model must be gpt-6-luna", async () => {
  const r = await load({ decisions: { model: "gpt-5" } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /decisions\.model/);
  assert.equal(r.config.decisions.model, "gpt-6-luna");
});

test("D1 the seven decisions probabilities are finite numbers in [0,1]", async () => {
  for (const k of DEC_PROBS) {
    for (const v of [-0.1, 1.1, "0.5", null]) {
      const r = await load({ decisions: { [k]: v } });
      assert.ok(r.errors.some((e) => e.startsWith(`decisions.${k}:`)), `${k}=${v}`);
      assert.equal(r.config.decisions[k], DEFAULTS.decisions[k]);
    }
    // concern_low / concern_high are bounded by each other, so the pair-free fields carry the 0 and 1 edges
    if (k === "concern_low" || k === "concern_high") continue;
    for (const v of [0, 1]) assert.deepEqual((await load({ decisions: { [k]: v } })).errors, [], `${k}=${v}`);
  }
  assert.deepEqual((await load({ decisions: { concern_low: 0, concern_high: 1 } })).errors, []);
});

test("D1 concern_low must be below concern_high", async () => {
  const r = await load({ decisions: { concern_low: 0.6, concern_high: 0.6 } });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /concern_low/);
  assert.equal(r.config.decisions.concern_low, 0.3);
  assert.equal(r.config.decisions.concern_high, 0.8);
  assert.deepEqual((await load({ decisions: { concern_low: 0.1, concern_high: 0.5 } })).errors, []);
  assert.equal((await load({ decisions: { concern_low: 0.9 } })).errors.length, 1, "0.9 is above the default high 0.8");
});

test("D1 decisions.timeout_ms > 0, max_retries integer 0-3", async () => {
  for (const v of [0, -1, "10", null]) {
    const r = await load({ decisions: { timeout_ms: v } });
    assert.match(r.errors.join("|"), /decisions\.timeout_ms/, `timeout_ms=${v}`);
    assert.equal(r.config.decisions.timeout_ms, 10000);
  }
  for (const v of [-1, 4, 1.5, "1", null]) {
    const r = await load({ decisions: { max_retries: v } });
    assert.match(r.errors.join("|"), /decisions\.max_retries/, `max_retries=${v}`);
    assert.equal(r.config.decisions.max_retries, 1);
  }
  assert.deepEqual((await load({ decisions: { max_retries: 0 } })).errors, []);
  assert.deepEqual((await load({ decisions: { max_retries: 3 } })).errors, []);
});

test("D1 decisions.max_input_chars integer 2000-20000; max_message_chars integer 500-12000 and below max_input_chars", async () => {
  for (const v of [1999, 20001, 2500.5, "16000", null]) {
    const r = await load({ decisions: { max_input_chars: v } });
    assert.match(r.errors.join("|"), /decisions\.max_input_chars/, `max_input_chars=${v}`);
    assert.equal(r.config.decisions.max_input_chars, 16000);
  }
  for (const v of [499, 12001, 600.5, "6000", null]) {
    const r = await load({ decisions: { max_message_chars: v } });
    assert.match(r.errors.join("|"), /decisions\.max_message_chars/, `max_message_chars=${v}`);
    assert.equal(r.config.decisions.max_message_chars, 6000);
  }
  const eq = await load({ decisions: { max_input_chars: 3000, max_message_chars: 3000 } });
  assert.match(eq.errors.join("|"), /decisions\.max_message_chars/, "equal is not below");
  assert.equal(eq.config.decisions.max_message_chars, 6000);
  assert.deepEqual((await load({ decisions: { max_input_chars: 2000, max_message_chars: 1999 } })).errors, []);
  assert.deepEqual((await load({ decisions: { max_input_chars: 20000, max_message_chars: 12000 } })).errors, []);
});

test("D1 decisions: null in the file gives the defaults, no crash", async () => {
  const r = await load({ decisions: null });
  assert.deepEqual(r.config.decisions, DEFAULTS.decisions);
  assert.ok(r.errors.some((e) => /^decisions:/.test(e)));
  const r2 = await load({ decisions: [1] });
  assert.deepEqual(r2.config.decisions, DEFAULTS.decisions);
});
