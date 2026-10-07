import { test } from "node:test";
import assert from "node:assert/strict";
import { withEnv } from "./mc-helpers.mjs";
import { launchEnv, childEnv, CREDENTIAL_ENV } from "../env.mjs";

const base = () => ({
  PATH: process.env.PATH ?? "/bin", Openai_Api_Key: "k1", codex_api_key: "k2", CODEX_RUN_ENV_ALLOW: "x",
  HL_REGISTRY_DIR: "/r", HL_NO_SPAWN: "1", HL_SESSION_ID: "s", CLAUDE_CODE_SESSION_ID: "c",
  CLAUDE_CONFIG_DIR: "/cfg", CLAUDECODE: "1", AI_AGENT: "a", OTHER: "o",
});
const lower = (e) => Object.keys(e).map((k) => k.toLowerCase());

test("CREDENTIAL_ENV names", () => {
  assert.deepEqual(CREDENTIAL_ENV, ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_RUN_ENV_ALLOW"]);
});

test("M9 launchEnv keeps HL_REGISTRY_DIR and HL_NO_SPAWN, drops credentials (any case) and session ids", async () => {
  await withEnv(base(), () => {
    const e = launchEnv();
    assert.equal(e.HL_REGISTRY_DIR, "/r");
    assert.equal(e.HL_NO_SPAWN, "1");
    assert.equal(e.CLAUDE_CONFIG_DIR, "/cfg");
    assert.equal(e.OTHER, "o");
    for (const k of ["openai_api_key", "codex_api_key", "codex_run_env_allow", "hl_session_id", "claude_code_session_id"]) {
      assert.ok(!lower(e).includes(k), k);
    }
  });
});

test("M9 childEnv drops credentials, every HL_*, CLAUDE* except CLAUDE_CONFIG_DIR, AI_AGENT; keeps PATH", async () => {
  await withEnv(base(), () => {
    const e = childEnv();
    assert.equal(e.CLAUDE_CONFIG_DIR, "/cfg");
    assert.equal(e.PATH, process.env.PATH);
    assert.equal(e.OTHER, "o");
    for (const k of lower(e)) {
      assert.ok(!/^hl_/.test(k), k);
      assert.ok(!(k.startsWith("claude") && k !== "claude_config_dir"), k);
    }
    for (const k of ["openai_api_key", "codex_api_key", "codex_run_env_allow", "ai_agent", "hl_session_id", "claude_code_session_id", "claudecode"]) {
      assert.ok(!lower(e).includes(k), k);
    }
  });
});

test("M9 extra is added last in both (it may re-add a name)", async () => {
  await withEnv(base(), () => {
    const x = { HL_NO_SPAWN: "0", NEW_ONE: "n", HL_FAKE_CLAUDE: "1" };
    const l = launchEnv({ extra: x }), c = childEnv({ extra: x });
    assert.equal(l.HL_NO_SPAWN, "0");
    assert.equal(l.NEW_ONE, "n");
    assert.equal(c.HL_NO_SPAWN, "0");
    assert.equal(c.HL_FAKE_CLAUDE, "1");
    assert.equal(c.NEW_ONE, "n");
    assert.equal(Object.keys(c).at(-1), "HL_FAKE_CLAUDE");
  });
});

test("neither builder mutates process.env", async () => {
  await withEnv(base(), () => {
    launchEnv(); childEnv();
    assert.equal(process.env.Openai_Api_Key, "k1");
    assert.equal(process.env.HL_NO_SPAWN, "1");
  });
});
