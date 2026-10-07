import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as V from "../live.mjs";

const NAMES = ["Openai_Api_Key", "codex_api_key", "CODEX_RUN_ENV_ALLOW"]; // mixed case on purpose
test("cleanEnv drops the credential names in any case", () => {
  for (const k of NAMES) process.env[k] = "x";
  process.env.HL_MODEL_COORDINATOR = "1";
  try {
    const env = V.cleanEnv();
    for (const k of Object.keys(env)) assert.ok(!V.SECRET_ENV.some((n) => n.toLowerCase() === k.toLowerCase()), k);
    assert.equal(env.HL_MODEL_COORDINATOR, undefined);
    assert.ok("PATH" in env || "Path" in env);
  } finally { for (const k of [...NAMES, "HL_MODEL_COORDINATOR"]) delete process.env[k]; }
});
test("the windowScript strip line removes them (run hidden)", () => {
  const ps = V.windowScript({ pidFile: "p", name: "n", workDir: ".", banner: "b", regId: "r", claudeLine: "x" });
  const strip = ps.split("\r\n").find((l) => l.startsWith("Get-ChildItem env:"));
  const env = { ...process.env, OPENAI_API_KEY: "x", Codex_Api_Key: "x", CODEX_RUN_ENV_ALLOW: "x", KEEP_ME: "1",
    CLAUDE_CODE_X: "1", AI_AGENT: "a", HL_FOO: "1", CLAUDE_CONFIG_DIR: "cfg-kept" };
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${strip}; Get-ChildItem env: | % { $_.Name + '=' + $_.Value }`],
    { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(r.error, undefined, `powershell did not run: ${r.error?.message}`);
  assert.equal(r.status, 0, `powershell exited ${r.status}: ${r.stderr}`);
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const names = lines.map((s) => s.split("=")[0].toLowerCase());
  for (const n of V.SECRET_ENV) assert.ok(!names.includes(n.toLowerCase()), n);
  for (const n of ["claude_code_x", "ai_agent", "hl_foo"]) assert.ok(!names.includes(n), `${n} must be removed`);
  assert.ok(!names.some((n) => n.startsWith("hl_") || (n.startsWith("claude") && n !== "claude_config_dir")), "no CLAUDE*/HL_* left but CLAUDE_CONFIG_DIR");
  assert.ok(names.includes("keep_me"));
  assert.ok(lines.includes("CLAUDE_CONFIG_DIR=cfg-kept"), "CLAUDE_CONFIG_DIR is kept");
});
test("existing strip behaviour unchanged (CLAUDE*, AI_AGENT, HL_*)", () => {
  const set = { CLAUDE_CODE_X: "1", CLAUDE_CONFIG_DIR: "cfg", AI_AGENT: "a", HL_FOO: "1" };
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]])); // a prior value is restored, not deleted
  Object.assign(process.env, set);
  try {
    const env = V.cleanEnv();
    assert.equal(env.CLAUDE_CODE_X, undefined);
    assert.equal(env.AI_AGENT, undefined);
    assert.equal(env.HL_FOO, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, "cfg");
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
