// The command lines codex-run builds. Pure functions: no I/O.
// Exact shapes are fixed by the plan (Task 3) and the spec (Part 2 step 3); the sandbox flags
// here are the safety boundary, so tests pin the arrays exactly.

export const MODEL_SLUGS = { luna: "gpt-6-luna", sol: "gpt-6.1-sol", astra: "gpt-6-astra" };
export const DEFAULT_MODEL = { write: "sol", review: "sol", diagnose: "astra", research: "sol" };
export const DEFAULT_EFFORT = { write: "medium", review: "medium", diagnose: "high", research: "medium" };
export const SANDBOX_OF = {
  write: "workspace-write", review: "read-only", diagnose: "read-only", research: "read-only",
};

const CMD_EXE = "C:\\Windows\\System32\\cmd.exe";
const SANDBOX_PROFILES = new Set([":workspace", ":read-only"]);

function need(opts, ...keys) {
  for (const k of keys) {
    if (typeof opts[k] !== "string" || opts[k] === "") throw new Error(`execArgs: ${k} is required`);
  }
}

const trimSep = (p) => p.replace(/[\\/]+$/, "");

// TEMP/TMP for everything Codex runs: a folder inside the worktree, so %TEMP% is not writable.
const tmpArgs = (cwd) => {
  const t = trimSep(cwd) + "\\.codex-tmp";
  return ["-c", "shell_environment_policy.set.TEMP=" + t, "-c", "shell_environment_policy.set.TMP=" + t];
};

// CODEX_API_KEY goes to the `codex exec` spawn env (codex-run execEnv) but must never reach a command Codex runs in
// the sandbox. Codex 0.160 applies NO default excludes (a live probe showed it), so this `exclude` list (patterns, matched
// ignoring case) is the only filter: it names the key and the *KEY*, *SECRET*, *TOKEN* patterns itself. `exclude` and
// `ignore_default_excludes` are its policy keys. Host-side checks (--check-host, hostCheck in
// codex-run.mjs) keep the full environment BY DESIGN: they run on the host, not in the sandbox, and sandboxArgs
// (sandbox checks) already run on the allowlisted env without the key.
const EXCLUDE_ENV = 'shell_environment_policy.exclude=["CODEX_API_KEY","*KEY*","*SECRET*","*TOKEN*"]';

/**
 * Arguments for `codex exec` (the caller prepends nothing: first element is `--search` for
 * research, else `-a`). `model` is an alias (luna|sol|astra) or a raw slug; `model` and
 * `effort` default per mode. `network` only has an effect in write mode.
 * Research runs in `<cwd>\.codex-tmp\<runId>\research`, an empty folder inside the worktree.
 */
export function execArgs(opts) {
  const { mode, network } = opts;
  if (!Object.hasOwn(SANDBOX_OF, mode)) throw new Error(`execArgs: unknown mode ${JSON.stringify(mode)}`);
  need(opts, "cwd", "runDirPath", "schemaPath");
  if (mode === "research") need(opts, "runId");
  const cwd = trimSep(opts.cwd);
  const model = opts.model || DEFAULT_MODEL[mode];
  const slug = Object.hasOwn(MODEL_SLUGS, model) ? MODEL_SLUGS[model] : model;
  const effort = opts.effort || DEFAULT_EFFORT[mode];
  const workDir = mode === "research" ? `${cwd}\\.codex-tmp\\${opts.runId}\\research` : cwd;
  return [
    ...(mode === "research" ? ["--search"] : []),
    "-a", "never", "exec", "-m", slug, "-C", workDir, "-s", SANDBOX_OF[mode],
    "--ignore-user-config", "--ignore-rules",
    "-c", "windows.sandbox=elevated",
    ...tmpArgs(cwd),
    "-c", EXCLUDE_ENV,
    "-c", "model_reasoning_effort=" + effort,
    ...(network && mode === "write" ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
    "--disable", "plugins", "--disable", "apps", "--disable", "browser_use", "--disable", "in_app_browser",
    "--disable", "computer_use",
    "--output-schema", opts.schemaPath, "-o", opts.runDirPath + "\\last.json", "--json", "-",
  ];
}

/** Arguments for `codex sandbox`: runs `cmdFile` (a .cmd) inside the same sandbox, no model call. */
export function sandboxArgs({ profile, cwd, cmdFile }) {
  if (!SANDBOX_PROFILES.has(profile)) throw new Error(`sandboxArgs: unknown profile ${JSON.stringify(profile)}`);
  return [
    "sandbox", "-P", profile, "-C", cwd, "-c", "windows.sandbox=elevated", ...tmpArgs(cwd),
    "--", CMD_EXE, "/d", "/c", cmdFile,
  ];
}

/** Text of a generated check file (the caller writes it as is; CRLF line endings). */
export function cmdFileText(cmd) {
  return "@echo off\r\n" + cmd + "\r\nexit /b %ERRORLEVEL%\r\n";
}
