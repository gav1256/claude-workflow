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
