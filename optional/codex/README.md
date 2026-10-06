# Optional Codex profile (Windows)

An optional second brain: Claude plans, rules and reviews, and `codex-run.mjs` hands bounded tasks (writing, review,
diagnosis, research, browser tests) to OpenAI Codex, which runs in its own OS sandbox in the task's linked git
worktree. It is not installed by default: the installer skips `optional/`, and only the steps below turn it on.

Tested with Codex **0.160.0**. The runner records the version in `~/.claude/state/codex/tested-version` and, when
`codex --version` differs, runs a gate (control write, TEMP and outside-worktree probes, feature names, the read check,
the ACL scan) before the next run. A failing gate blocks runs; it never falls back to unsandboxed operation.

Models used: `gpt-6-luna` (small, mechanical), `gpt-6.1-sol` (default writer), `gpt-6-astra` (hard reviews).

Evaluated and not used: OpenAI's `codex-plugin-cc`, because it has no per-run sandbox hardening and relays full
output into Claude's context. Its review output schema (Apache-2.0) inspired this profile's schemas and is credited in
the NOTICE file shipped with it.

## Requirements

- Windows 10/11 with an **English display language**. The ACL scan parses `icacls` output; on a non-English locale it
  fails closed (runs are blocked), never open.
- A ChatGPT plan that includes Codex.
- Node 18 or newer, git, and this repo's `claude/` setup installed (the profile uses its `handoff-launch` locks and
  state folder).

## Setup

1. Install and log in:

   ```
   npm i -g @openai/codex@latest
   codex login
   ```

2. Elevated sandbox setup. Run Codex once with the Windows sandbox set to `elevated` (Codex's own setup creates the
   `CodexSandboxOffline` and `CodexSandboxOnline` accounts and the `CodexSandboxUsers` group; approve the UAC prompt).
3. Copy the skill: `optional/codex/skills/dispatching-codex` into `~/.claude/skills/` (the installer step does this).
4. **One-time toolchain grant** (run by you, once). The sandbox user must be able to read and execute the per-user
   toolchains Codex needs for tests (for example Python, Rust/cargo, npm global, uv, .NET tools, Playwright browsers
   under `%LOCALAPPDATA%\ms-playwright`). Grant only the folders you use:

   ```
   icacls "<toolchain folder>" /grant "CodexSandboxUsers:(OI)(CI)(RX)"
   ```

   Undo: `icacls "<toolchain folder>" /remove:g CodexSandboxUsers`. Docker is deliberately not granted (access to
   Docker is host-equivalent).
5. **Deny-read lines.** The sandbox restricts writes, not reads, so by default it can read your `~/.claude`,
   `~/.codex` (including the login), `%TEMP%\claude` and credential stores. Print the exact lines for your machine:

   ```
   node "%USERPROFILE%\.claude\skills\dispatching-codex\codex-run.mjs" --setup
   ```

   It prints one `icacls` deny line per folder or file that exists, for example:

   ```
   icacls "%USERPROFILE%\.claude" /deny "CodexSandboxUsers:(OI)(CI)(R)"
   icacls "%USERPROFILE%\.ssh" /deny "CodexSandboxUsers:(OI)(CI)(R)"
   icacls "%USERPROFILE%\.npmrc" /deny "CodexSandboxUsers:(R)"
   ```

   Targets: `~/.claude`, `%TEMP%\claude`, the whole `CODEX_HOME` folder (default `~/.codex`, so a refreshed
   `auth.json` is born denied), and where present `~/.ssh`, `~/.config/gh`, `~/.docker`, `~/.aws`, `~/.azure`,
   `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`. Run them yourself in a normal shell. A deny entry
   overrides any allow. Codex itself runs as you, so its login keeps working.

   Each line has an undo: `icacls "<same path>" /remove:d CodexSandboxUsers`.
6. Every run re-checks this: the read check tries real canary reads of those targets, confirms that both
   `CodexSandboxOffline` and `CodexSandboxOnline` are in `CodexSandboxUsers`, and a host-side ACL scan (at most every
   24 h) looks for unlisted files under the protected folders. Any target that reads as allowed blocks the run.

## Notes you should know

- **TEMP.** Codex's setup leaves a `CodexSandboxUsers:(M)` entry on `%LOCALAPPDATA%\Temp`. Runs redirect TEMP into the
  worktree, so it is unused, but it exists. To remove it:

  ```
  icacls "%LOCALAPPDATA%\Temp" /remove:g CodexSandboxUsers
  ```

- **`~/.codex/AGENTS.md` warning.** Unattended runs ignore your Codex config, but an interactive `codex` session
  reads `~/.codex/AGENTS.md`. Do not put secrets or instructions you would not want a sandboxed worker to see there.
- **Browser MCPs are deferred.** Browser tests run as Playwright scripts inside the sandbox against a localhost app.
  `codex-run.mjs` never passes `mcp_servers`, because MCP servers run outside the sandbox and their origin filters are
  not a security boundary.
- **Network is off** by default; `--network` is for package installs or web search only. `--check-host` is the one
  opt-in unsandboxed step and is shown in the result. Codex does no git network; Claude commits and pushes.

## Accepted residual risk

An unlisted file with inheritance disabled, created inside a protected folder within the 24 h since the last full ACL
scan, is not caught until the next scan. Disabling inheritance takes a deliberate ACL operation, and the known
credential files are probed on every run.

## Large-org variant

Use a separate OS account per lane with no read access to the user's profile at all, and run checks in disposable
containers, instead of deny ACEs on a shared user.

## Usage

```
node codex-run.mjs --brief <file> --cwd <worktree> --mode write|review|diagnose|research
node codex-run.mjs --status
node codex-run.mjs --verdict <run-id> approve|rework|reject "<one line>"
```

## Rollback

1. Run the undo line for each deny line from step 5 (`/remove:d CodexSandboxUsers`) and for each grant from step 4
   (`/remove:g CodexSandboxUsers`), plus the TEMP removal above.
2. Delete `~/.claude/skills/dispatching-codex` and `~/.claude/state/codex`.
3. Optionally `npm uninstall -g @openai/codex`.
