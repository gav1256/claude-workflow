import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_SLUGS, DEFAULT_MODEL, DEFAULT_EFFORT, SANDBOX_OF, execArgs, sandboxArgs, cmdFileText,
} from "../lib/argv.mjs";

const CWD = "C:\\Work\\wt one";
const T = CWD + "\\.codex-tmp";
const base = { cwd: CWD, runId: "run1", runDirPath: "R:\\runs\\run1", schemaPath: "S:\\schemas\\x.json" };

// The common middle of every exec command, after "-s <sandbox>".
const middle = (effort, network) => [
  "--ignore-user-config", "--ignore-rules",
  "-c", "windows.sandbox=elevated",
  "-c", "shell_environment_policy.set.TEMP=" + T,
  "-c", "shell_environment_policy.set.TMP=" + T,
  "-c", "model_reasoning_effort=" + effort,
  ...(network ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
  "--disable", "plugins", "--disable", "apps", "--disable", "browser_use", "--disable", "in_app_browser",
  "--disable", "computer_use",
  "--output-schema", "S:\\schemas\\x.json", "-o", "R:\\runs\\run1\\last.json", "--json", "-",
];

test("constants: slugs, defaults, sandbox per mode", () => {
  assert.deepEqual(MODEL_SLUGS, { luna: "gpt-6-luna", sol: "gpt-6.1-sol", astra: "gpt-6-astra" });
  assert.deepEqual(DEFAULT_MODEL, { write: "sol", review: "sol", diagnose: "astra", research: "sol" });
  assert.deepEqual(DEFAULT_EFFORT, { write: "medium", review: "medium", diagnose: "high", research: "medium" });
  assert.deepEqual(SANDBOX_OF, {
    write: "workspace-write", review: "read-only", diagnose: "read-only", research: "read-only",
  });
});

test("execArgs write: exact array (no network)", () => {
  assert.deepEqual(execArgs({ ...base, mode: "write", model: "sol", effort: "medium" }), [
    "-a", "never", "exec", "-m", "gpt-6.1-sol", "-C", CWD, "-s", "workspace-write", ...middle("medium", false),
  ]);
});

test("execArgs write with network adds the network flag after model_reasoning_effort", () => {
  assert.deepEqual(execArgs({ ...base, mode: "write", model: "luna", effort: "low", network: true }), [
    "-a", "never", "exec", "-m", "gpt-6-luna", "-C", CWD, "-s", "workspace-write", ...middle("low", true),
  ]);
});

test("execArgs review: read-only, exact array", () => {
  assert.deepEqual(execArgs({ ...base, mode: "review", model: "sol", effort: "medium" }), [
    "-a", "never", "exec", "-m", "gpt-6.1-sol", "-C", CWD, "-s", "read-only", ...middle("medium", false),
  ]);
});

test("execArgs diagnose: read-only, exact array", () => {
  assert.deepEqual(execArgs({ ...base, mode: "diagnose", model: "astra", effort: "high" }), [
    "-a", "never", "exec", "-m", "gpt-6-astra", "-C", CWD, "-s", "read-only", ...middle("high", false),
  ]);
});

test("execArgs research: --search first, -C is the empty folder under .codex-tmp, TEMP stays .codex-tmp", () => {
  assert.deepEqual(execArgs({ ...base, mode: "research", model: "sol", effort: "medium" }), [
    "--search", "-a", "never", "exec", "-m", "gpt-6.1-sol", "-C", T + "\\run1\\research", "-s", "read-only",
    ...middle("medium", false),
  ]);
});

test("model and effort default per mode; a raw slug passes through; a trailing separator on cwd is dropped", () => {
  const w = execArgs({ ...base, mode: "write", cwd: CWD + "\\" });
  assert.equal(w[w.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.equal(w[w.indexOf("-C") + 1], CWD);
  assert.ok(w.includes("model_reasoning_effort=medium"));
  const d = execArgs({ ...base, mode: "diagnose" });
  assert.equal(d[d.indexOf("-m") + 1], "gpt-6-astra");
  assert.ok(d.includes("model_reasoning_effort=high"));
  const raw = execArgs({ ...base, mode: "review", model: "gpt-9-custom" });
  assert.equal(raw[raw.indexOf("-m") + 1], "gpt-9-custom");
});

test("--search comes before exec only for research; -a comes before exec in every mode", () => {
  for (const mode of ["write", "review", "diagnose", "research"]) {
    const a = execArgs({ ...base, mode });
    const search = a.indexOf("--search");
    const exec = a.indexOf("exec");
    if (mode === "research") {
      assert.ok(search === 0 && search < exec, mode);
      assert.equal(a.filter((x) => x === "--search").length, 1);
    } else {
      assert.equal(search, -1, mode);
    }
    assert.ok(a.indexOf("-a") >= 0 && a.indexOf("-a") < exec, mode);
    assert.equal(a[a.indexOf("-a") + 1], "never");
  }
});

test("forbidden flags never appear in any mode", () => {
  for (const mode of ["write", "review", "diagnose", "research"]) {
    for (const network of [false, true]) {
      const a = execArgs({ ...base, mode, network });
      const text = a.join(" ");
      for (const bad of ["--ephemeral", "mcp_servers", "--dangerously", "--browser", "--skip-git-repo-check"]) {
        assert.ok(!text.includes(bad), `${mode}: ${bad}`);
      }
    }
  }
});

test("the network flag appears only for write", () => {
  for (const mode of ["write", "review", "diagnose", "research"]) {
    const on = execArgs({ ...base, mode, network: true }).includes("sandbox_workspace_write.network_access=true");
    const off = execArgs({ ...base, mode }).includes("sandbox_workspace_write.network_access=true");
    assert.equal(on, mode === "write", mode);
    assert.equal(off, false, mode);
  }
});

test("execArgs rejects an unknown mode and missing required fields", () => {
  assert.throws(() => execArgs({ ...base, mode: "nope" }), /mode/);
  assert.throws(() => execArgs({ ...base, mode: "write", cwd: undefined }), /cwd/);
  assert.throws(() => execArgs({ ...base, mode: "write", schemaPath: undefined }), /schemaPath/);
  assert.throws(() => execArgs({ ...base, mode: "write", runDirPath: undefined }), /runDirPath/);
  assert.throws(() => execArgs({ ...base, mode: "research", runId: undefined }), /runId/);
});

test("sandboxArgs: exact array for both profiles", () => {
  for (const profile of [":workspace", ":read-only"]) {
    assert.deepEqual(sandboxArgs({ profile, cwd: CWD, cmdFile: "C:\\f x\\check.cmd" }), [
      "sandbox", "-P", profile, "-C", CWD, "-c", "windows.sandbox=elevated",
      "-c", "shell_environment_policy.set.TEMP=" + T, "-c", "shell_environment_policy.set.TMP=" + T,
      "--", "C:\\Windows\\System32\\cmd.exe", "/d", "/c", "C:\\f x\\check.cmd",
    ]);
  }
  assert.throws(() => sandboxArgs({ profile: ":full", cwd: CWD, cmdFile: "x.cmd" }), /profile/);
});

test("cmdFileText wraps the command with CRLF and exit propagation", () => {
  assert.equal(cmdFileText("echo hi"), "@echo off\r\necho hi\r\nexit /b %ERRORLEVEL%\r\n");
  assert.equal(cmdFileText('echo "a b" & echo c'), '@echo off\r\necho "a b" & echo c\r\nexit /b %ERRORLEVEL%\r\n');
});
