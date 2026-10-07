# Codex dual-brain profile: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional, off-by-default `codex` profile in which `codex-run.mjs` hands one bounded task at a time to a
sandboxed `codex exec` (write, review, diagnose, research), decides the status itself, and prints one JSON line, so
Claude spends measurably fewer tokens per task. It is live by **2026-10-09**, after a dry run the user OKs.

**Architecture:** One skill folder, `optional/codex/skills/dispatching-codex/`. `codex-run.mjs` is a thin orchestrator
over small, single-purpose modules in `lib/` (paths, binary, argv, brief, locks, procs, readcheck, scope, checks,
usage, ledger, result, guards, review-input, status, verdict). Tests are `node:test` against a fake `codex` (a node
script injected through `CODEX_RUN_BIN`). The safety core (locks, quarantine, the read-boundary check, the secret scan,
the sandbox flags) is written by sonnet and reviewed by Fable. Once write mode passes its tests and the live smoke test
(gate **G1**), Codex writes the remaining tasks through the script itself. The 4 efficiency-proof tasks are real tasks of
this plan, each run twice (sonnet arm, Codex arm).

**Tech Stack:** Node >= 18 ESM (`node:fs`, `node:net`, `node:child_process`, `node:crypto`, `node:module`,
`node:test`), no dependencies. Windows: `cmd.exe`, `icacls`, `taskkill`, PowerShell 5.1 for process listing. Codex CLI
0.160.0 (npm `@openai/codex`), git worktrees.

**Spec:** `docs/specs/2026-10-05-codex-dual-design.md` (user-approved, commit `85d3d23`). Read it with this plan: the plan
argues from it and cites it as `spec:<line>`.

## User rulings 2026-10-06

Fable's plan review (APPROVE WITH AMENDMENTS A1-A15) is folded in below. The user ruled on the open questions:

- **(a)** A lane may give Codex its own self-created linked worktree, so Codex runs go in parallel (each run still locks
  its worktree). This supersedes the serial rule of Decision 11 and gap 7.
- **(b)** Codex runs may write runtime state under `~/.claude/state/{codex,coord/usage}` before deploy (real paths in the
  dry run).
- **(c)** Plan Tasks 15-18 are the G2 proof's real backlog (half Codex, half sonnet).
- **(d)** Auto-clear a crash quarantine only when BOTH can be proven: (1) the process lister positively verifies that no process from that run is alive (no sandbox-user process and no process tagged with the run id; the lister must actually be able to see sandbox-user processes, as P4 shows), and (2) nothing is damaged: the worktree's tracked and untracked state matches the record's last known state (the baseline, or the recorded diff hash of the run's final state), and no lock or record file is half-written. If either check cannot be done or fails, the worktree stays quarantined until the user runs `--clear-quarantine`. If P4 shows sandbox-user processes cannot be listed without elevation, auto-clear is never possible.

## Global Constraints

- All profile files live under `optional/codex/`. The default install (`claude/`) gains only the one sizing line
  (spec:340) and the AGENTS.md worker-only line (spec:355).
- Node >= 18 ESM, no dependencies, LF line endings in the repo. Generated `.cmd` files are written with CRLF at run time.
- Paths come from `os.homedir()`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `npm root -g`, never hard-coded user paths.
- Test overrides (every test sets them; no test touches the real `~/.claude`, `~/.codex`, real pipes or real Codex):
  `CLAUDE_CONFIG_DIR=<temp>`, `CODEX_HOME=<temp>`, `HL_REGISTRY_DIR=<temp>`, `HL_SKILL_DIR=<temp copy or absent>`,
  `CODEX_RUN_BIN=<node.exe>` + `CODEX_RUN_BIN_ARGS='["<abs>/tests/fake-codex.mjs"]'`, `FAKE_CODEX_SCENARIO=<json file>`,
  `CODEX_RUN_PIPE_PREFIX=codex-run-test-<pid>-`, `CODEX_RUN_PROCS=<json file>` (fake process list),
  `CODEX_RUN_TIMEOUT_MS`, `CODEX_RUN_NPM_ROOT`, `CODEX_RUN_TEMP=<temp>` (stands in for the real `%TEMP%`).
- Fake secrets in tests are built at run time by concatenation (`"sk-" + "ant-" + "x".repeat(12)`), never as a literal,
  so the repo secret scan stays clean.
- Test data uses `...@example.com` only. Tests and probes open no visible windows (spawn with `windowsHidden: true`).
- Proving check for every code task: `timeout 900 node --test "optional/codex/skills/dispatching-codex/tests/*.test.mjs"`.
  Report the real `ℹ tests / ℹ pass / ℹ fail` lines.
- Commit by file name only, never `git add -A`. The repo is PUBLIC: no user paths, emails, account names, private
  project names. Probe outputs with paths go to the lane's private ledger, not the repo.
- Never read, print or copy `auth.json` (or any credential file's contents). ACL listings (`icacls`) and existence
  checks are allowed.
- Nothing under `~/.claude` (config) or `~/.codex` is edited before Task 19, except runtime state the script itself
  writes under `~/.claude/state/` once Codex runs start (G1 onward; ruling (b): also `~/.claude/state/coord/usage`, real paths in the dry run). The user
  runs every `icacls` deny line by hand.
- Large-org variant (document only, README): a per-lane OS account with no profile read access, checks in disposable
  containers, per-team quotas.

## Decisions beyond the spec's text

1. **Codex-written safety stays out of the safety core.** After G1 Codex writes the leaf tasks (review input, schemas,
   templates, SKILL.md, status, verdict, docs, contract tests). Fix rounds on `lib/{argv,brief,locks,procs,readcheck}.mjs`
   and `codex-run.mjs` stay with sonnet, so a sandboxed agent never edits the guards that contain it.
2. **Later modules start as stubs.** Task 9 creates `lib/review-input.mjs`, `lib/status.mjs`, `lib/verdict.mjs` as stubs
   with the final signatures; their owning tasks replace the whole file. `codex-run.mjs` imports them statically and is
   not edited again by Codex tasks.
3. **The brief file is the controller's, the run copy is the script's.** `--brief <any file>`; the script copies it to
   `<run-dir>/brief.md`, replacing the line `Worker rules: {{WORKER_RULES}}` with the extracted `## Worker rules`
   section (spec:348). A brief over 80 lines, or with no `Files you own:` line in write mode, is `blocked`
   (`brief-invalid: <why>`).
4. **Files Codex must read go to `.codex-tmp`, never to the run dir.** The run dir is under `~/.claude`, which the deny
   ACE makes unreadable to the sandbox. So the review patch is copied to `<cwd>\.codex-tmp\<run-id>\review.patch` (the
   canonical copy and its sha256 stay in the run dir), and research runs with `-C <cwd>\.codex-tmp\<run-id>\research`
   (an empty folder inside the git worktree, so no `--skip-git-repo-check` is needed). See gaps 1-2.
5. **`--network` and web search are separate.** `--network` adds `sandbox_workspace_write.network_access=true` (write
   mode only: package installs). Web search is research mode's top-level `--search`; any other mode ignores it. Part 4's
   "web search: `--network`" row is superseded by the 2026-10-06 research decision (gap 3).
6. **Default efforts:** write/review/research `medium`, diagnose `high`. Model slugs: `luna=gpt-6-luna`,
   `sol=gpt-6.1-sol`, `astra=gpt-6-astra`.
7. **The ledger carries `writer`** (`codex-luna|codex-sol|codex-astra`, or `sonnet` on `--verdict sonnet:<task>` lines)
   for Part 6 (spec:413).
8. **The review result adds `verdict`** (`approve|rework|reject` from the Codex reviewer) next to `findings`.
9. **The lane check reuses handoff-launch.** `lib/guards.mjs` imports `readRegistry`, `liveness` from
   `${HL_SKILL_DIR || CFG/skills/handoff-launch}/live.mjs` and `normPath` from `lane-lib.mjs` there. A lane counts as
   live unless `liveness().state === "gone"` (`unknown` blocks: the conservative side). If the folder is absent, the
   lane check is skipped with the note `lane-check: handoff-launch absent`.
10. **Efficiency proof = 4 tasks of this plan** (Tasks 15-18), each written once by a sonnet arm and once by a Codex arm
    on throwaway branches, each arm in its own background session so its transcripts are its whole cycle. The arm with
    the better review verdict is cherry-picked onto `codex-dual` (tie: Codex), so no work is wasted. A null session (a
    no-op handoff) is measured once and subtracted from every arm as fixed start-up cost.
11. **Each Codex run locks its own worktree.** With `HL_SESSION_ID` set, `--cwd` must be the lane's worktree or a
    linked worktree the lane created itself (ruling (a)), so Codex runs go in parallel across worktrees. Write mode
    needs a clean tree: the controller commits before each Codex write run and runs no Claude writer in the same
    worktree meanwhile.

## Review Focus

1. **The same worktree spelled differently** (`C:\X\wt`, `c:/x/wt/`, a `\\?\` prefix, an 8.3 short name) must map to one
   lock pipe and one record. Test in Task 5.
2. **Paths git quotes or renames** (spaces, non-ASCII, `R old -> new`) must neither slip past nor wrongly fail the
   scope check. Test in Task 7 (`-z` porcelain).
3. **Spaces and `&` in the worktree path or a check command** must survive the `.cmd` file, `-C` and `icacls`. Tests in
   Tasks 6 and 7.
4. **A CRLF `AGENTS.md`**, or a `### ` sub-heading inside Worker rules, must still extract the whole section, not fall
   back. Test in Task 4.
5. **Codex crashes**: a non-zero exit, a missing or invalid `last.json`, or no `thread.started` event gives `failed`
   with a reason, and cleanup, the ledger line and `state:"clean"` still happen. Test in Task 9.

---

## Wave 0: branch prep and live probes

### Task 0 (controller): branch prep and Part 3/8 checks

**Files:** none edited except by the merge.

- [ ] **Step 1:** Run `ListAgents`; if a batch-B lane owns `claude/AGENTS.md` or `claude/skills/sizing-dispatches/`,
  agree by message that this lane adds one line to each.
- [ ] **Step 2:** `git merge main` into `codex-dual` (brings `claude/AGENTS.md` and the live-synced sizing skill,
  `7d0786d`). Expected: no conflicts (this branch only added docs).
- [ ] **Step 3 (Part 8 sync):** `diff --strip-trailing-cr ~/.claude/skills/sizing-dispatches/SKILL.md
  claude/skills/sizing-dispatches/SKILL.md` → empty (verified 2026-10-06 against `main`). If it is not empty, copy
  live → repo and commit `chore(skills): mirror live sizing-dispatches` before Task 14.
- [ ] **Step 4 (Part 3 check):** `grep -c "dispatched as a worker" ~/.claude/AGENTS.md claude/AGENTS.md` → `1` and `1`
  (the worker-only line is already on `main` since `98fd6a7` and live). Task 4 only pins the sentence in a test; no
  deploy step for AGENTS.md. `diff --strip-trailing-cr ~/.claude/AGENTS.md claude/AGENTS.md` → empty.
- [ ] **Step 5:** Record in the private ledger: merge sha, both checks. `~/.claude/state/coord/pace.json` is absent
  today (verified 2026-10-06), so routing uses the default row (spec:99).

### Task 1: Live probes (user-assisted)

**Owner:** sonnet `worker-medium` (live run). **Reviewer:** opus `worker-high` reads the report. **Files:** none in
the repo; a throwaway worktree `.claude/worktrees/cdx-probe` (removed at the end). Results go to the controller, who
records them in the private ledger and in the fixtures named below.

Each probe states the command, the real output and pass/fail. All in the throwaway linked worktree, hidden processes.

- [ ] **P1 flags:** the bare `-c windows.sandbox=elevated` is accepted by `exec` and `sandbox` (rollout shows
  `workspace-write`); `-a never` and `--search` both before `exec`; `codex sandbox --help` has no
  `--ignore-user-config` (seen 2026-10-06): does `codex sandbox` honour `~/.codex/config.toml`, and does `-P :workspace`
  / `:read-only` resolve to the built-ins regardless of it? A check's exit code propagates (`exit /b 3` → 3).
- [ ] **P2 research:** `codex --search -a never exec -m gpt-6.1-sol -C <wt>\.codex-tmp\r1 -s read-only
  --ignore-user-config --ignore-rules -c windows.sandbox=elevated ... -` answers a question needing the web; the
  sandbox shell still has no network.
- [ ] **P3 browser (spec 1a, 1b):** inside `codex sandbox -P :workspace` with network off: a node server binds
  `127.0.0.1:<port>` and a second process connects; headless Chromium from `%LOCALAPPDATA%\ms-playwright` launches and
  loads that page. The server is gone after the check returns.
- [ ] **P4 processes:** from the user's non-elevated shell, while a sandboxed `ping -n 30 127.0.0.1` runs: which call
  lists processes running as `CodexSandboxOffline`/`CodexSandboxOnline` (try `tasklist /V /FO CSV /NH`,
  `Get-Process -IncludeUserName`, `Get-CimInstance Win32_Process` + `GetOwner`), how long it takes, and whether command
  lines of the user's own processes are visible via `Get-CimInstance Win32_Process`. For the sandboxed `ping`, one of
  the user's own processes and one service, record `SessionId`, whether `GetOwner` returns 0, and whether `CommandLine`
  is null, from `Get-CimInstance Win32_Process` and `tasklist /V`. Task 2's candidate rule: "owner unreadable AND
  SessionId == the script's session" ≈ sandboxed (services are session 0).
- [ ] **P5 deny-read (user runs the lines; spec:472):** the probe prints, the user runs, for each present target:
  `icacls "<folder>" /deny "CodexSandboxUsers:(OI)(CI)(R)"` for `~/.claude`, `%TEMP%\claude`, `${CODEX_HOME}`, `~/.ssh`,
  `~/.config/gh`, `~/.docker`, `~/.aws`, `~/.azure`; `icacls "<file>" /deny "CodexSandboxUsers:(R)"` for
  `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`. Then: a Luna `exec` write run and a `codex sandbox` check
  still work; canary files and fresh sentinels in each folder read as denied from both `exec` (Codex's own shell) and
  `codex sandbox`. **Token refresh:** while a long Luna run is active, the user runs `codex login` in another terminal;
  afterwards `icacls "${CODEX_HOME}\auth.json"` (ACL only) shows an inherited `(DENY)` ACE and the run finished.
- [ ] **P6 native readable roots (spec:481):** can `[permissions]` / `--sandbox-state-readable-root` restrict reads so
  `~/.claude` is unreadable without ACEs? Record yes/no with the evidence.
- [ ] **P7 fixtures:** save, sanitized (user and machine names → `USER`, `HOST`), (a) `icacls` output for one denied
  folder `/T` with one file lacking the deny, (b) one `event_msg` `token_count` line's `rate_limits` object, (c) one
  `turn.completed` event's `usage`. Seen 2026-10-06: `rate_limits = {primary:{used_percent, window_minutes:10080,
  resets_at:<epoch s>}, secondary:null, plan_type:"prolite", rate_limit_reached_type:null, ...}`.
- [ ] **Gates:** P5 fails (Codex cannot run with `${CODEX_HOME}` denied, or the refreshed `auth.json` is readable) and
  P6 is no → stop; the controller tells the user that deploy is blocked (spec:474). P6 yes → record as deferred (owner:
  next Codex-profile wave); the ACEs stay for 10-09. P6 never blocks. P3 fails → Task 14 writes the
  spec:379 fallback routing. P4 decides Task 2's process lister.

## Wave 1: design of the process-dependent safety code

### Task 2: Quarantine and process design (opus)

**Owner:** opus `worker-high`. **Reviewer:** fable `worker-high` (correctness-critical). **Files:** Create
`docs/plans/2026-10-06-codex-dual-addendum.md` (the design addendum: processes and quarantine; Task 5 implements it).

The addendum fixes, from P4's evidence:
- [ ] `listProcs()`: the exact command, its output parse, its cost; how `user` is filled for sandbox users when the
  owner cannot be read (for example "a process whose owner cannot be read and whose ancestor chain reaches a
  `codex.exe`/`codex-command-runner.exe` counts as sandboxed").
- [ ] Conditions (a)-(c) (spec:184-188) as a pure function over `{prev, procs}`, every branch with its result.
- [ ] `owner_start_time` source and the pid-reuse rule for `child_pids`.
- [ ] `--clear-quarantine`: the listing format, the confirm mechanism (`--yes` after the user said yes in chat), the
  `taskkill /T /F` order, the re-check.
- [ ] For Task 9, an opus "held-resources × failure-step" matrix in the addendum: which pipes, records and `.codex-tmp`
  are released at each step of the run sequence.
- [ ] Ruling (d), the auto-clear rule: Auto-clear a crash quarantine only when BOTH can be proven: (1) the process lister positively verifies that no process from that run is alive (no sandbox-user process and no process tagged with the run id; the lister must actually be able to see sandbox-user processes, as P4 shows), and (2) nothing is damaged: the worktree's tracked and untracked state matches the record's last known state (the baseline, or the recorded diff hash of the run's final state), and no lock or record file is half-written. If either check cannot be done or fails, the worktree stays quarantined until the user runs `--clear-quarantine`. If P4 shows sandbox-user processes cannot be listed without elevation, auto-clear is never possible.
- [ ] The fault-injection tests of spec:197-203 as concrete `CODEX_RUN_PROCS` fixtures plus how the "controller killed
  after spawn" case is produced (a child node process killed with `process.kill`).

## Wave 2: the core (sonnet, Fable/Opus reviewed)

Order: Tasks 3, 4, 8 in parallel; then Tasks 5 (needs Task 2), 6, 7 in parallel; then Task 9. All files below are
under `optional/codex/skills/dispatching-codex/` unless the path starts with `claude/`.

### Task 3: paths, binary resolution, argv, the fake codex

**Owner:** sonnet `worker-high`. **Reviewer:** fable `worker-high` (sandbox flags).
**Files:** Create `lib/paths.mjs`, `lib/binary.mjs`, `lib/argv.mjs`, `tests/helpers.mjs`, `tests/fake-codex.mjs`,
`tests/argv.test.mjs`, `tests/binary.test.mjs`, `tests/fake-codex.test.mjs`.

**Produces:**
```js
// paths.mjs
export const CFG, CODEX_HOME, STATE /* CFG/state/codex */, USAGE_DIR /* CFG/state/coord/usage */, PACE, LEDGER,
  LAST_USAGE, TESTED_VERSION, ACL_STATE /* STATE/acl-scan.json */, WT_LOCKS, SLOT_LOCKS, PIPE_PREFIX, HL_DIR, REAL_TEMP;
export function runDir(runId): string;            // STATE/runs/<runId>, created
export function newRunId(): string;               // "20261006T101500Z-a1b2c3"
export function canonPath(p): string;             // throws on a missing path; realpathSync.native, \\?\ stripped, "\" separators, no trailing sep, lower-case
export function atomicWriteJson(file, obj): void; // temp file in the same folder + renameSync
// binary.mjs
export function resolveCodex(): { cmd: string, args: string[] };   // CODEX_RUN_BIN wins; else spec:253 createRequire path
export function codexVersion(bin): string;        // "0.160.0" from `--version`
export function versionAtLeast(v, min = "0.159.1"): boolean;
// argv.mjs
export const MODEL_SLUGS, DEFAULT_MODEL, DEFAULT_EFFORT, SANDBOX_OF; // Decision 6; write→workspace-write, else read-only
export function execArgs({ mode, model, effort, cwd, runId, runDirPath, schemaPath, network }): string[];
export function sandboxArgs({ profile /* ":workspace"|":read-only" */, cwd, cmdFile }): string[];
export function cmdFileText(cmd: string): string; // "@echo off\r\n" + cmd + "\r\nexit /b %ERRORLEVEL%\r\n"
```

Exact `execArgs` for a write run (T = `<cwd>\.codex-tmp`):
`["-a","never","exec","-m",slug,"-C",cwd,"-s","workspace-write","--ignore-user-config","--ignore-rules","-c",
"windows.sandbox=elevated","-c","shell_environment_policy.set.TEMP="+T,"-c","shell_environment_policy.set.TMP="+T,"-c",
"model_reasoning_effort="+effort,("-c","sandbox_workspace_write.network_access=true" only if network && write),
"--disable","plugins","--disable","apps","--disable","browser_use","--disable","in_app_browser","--disable",
"computer_use","--output-schema",schemaPath,"-o",runDirPath+"\\last.json","--json","-"]`.
Review/diagnose: `-s read-only`. Research: `"--search"` prepended before `"-a"`, `-s read-only`, and `-C` =
`<cwd>\.codex-tmp\<runId>\research`. `sandboxArgs` = `["sandbox","-P",profile,"-C",cwd,"-c","windows.sandbox=elevated",
"-c","shell_environment_policy.set.TEMP="+T,"-c","shell_environment_policy.set.TMP="+T,"--",
"C:\\Windows\\System32\\cmd.exe","/d","/c",cmdFile]`. Adjust only where Task 1 P1 says otherwise (record it).

`tests/fake-codex.mjs` reads `FAKE_CODEX_SCENARIO` (JSON) and handles: `--version` (prints `codex-cli <version>`),
`features list` (prints `features` lines), `sandbox ... -- cmd.exe /d /c <file>`: if the file contains `echo R:` lines it
prints `D:<n>` for each target except indexes in `scenario.readOpen` (`R:<n>`), then `END` (`scenario.readGarbage`:
drops `END`); if the file contains `codex-gate-`, exits 1 unless `scenario.gateOpen`; otherwise runs the file with the
real `cmd.exe` and propagates its exit code. `exec`: reads stdin to EOF (fails if stdin never closes), writes
`thread.started{thread_id}`, `turn.completed{usage}` events to stdout, writes `scenario.writes[]` into `-C`, writes a
rollout `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl` (UTC date, `scenario.rolloutDay` override) with
`scenario.rateLimits`, writes `scenario.lastJson` (string, may be invalid) to `-o`, sleeps `scenario.sleepMs` with a
spawned grandchild `node -e "setTimeout(()=>{},1e9)"` when `scenario.grandchild`, exits `scenario.exit` (default 0).
`tests/helpers.mjs`: `tmpEnv()` (temp CFG/CODEX_HOME/registry/TEMP, returns env), `makeRepo()` (git repo with one
commit, `test@example.com`), `addWorktree(repo, name)` (linked worktree, path with a space), `scenario(obj)`.

- [ ] **Step 1:** Write failing tests: `canonPath` of a missing path throws; exact `execArgs` arrays for all 4 modes; `--search` index < `exec` index only for
  research; `-a` before `exec`; no `--ephemeral`, `mcp_servers`, `--dangerously`, `--browser`, `--skip-git-repo-check`
  in any mode; network flag only for write; `cmdFileText('echo "a b" & echo c')` round-trips through the fake
  sandbox with exit propagation; `resolveCodex()` against a temp npm root with the nested layout
  `<root>/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe` (and the flat
  layout resolving from `<root>` fails with `MODULE_NOT_FOUND`, spec:255); `versionAtLeast`; `canonPath` gives one
  value for the Review Focus 1 spellings.
- [ ] **Step 2:** Run the proving check → the new tests fail.
- [ ] **Step 3:** Implement the three modules, `helpers.mjs` and `fake-codex.mjs`.
- [ ] **Step 4:** Run the proving check → all pass.
- [ ] **Step 5:** Commit the 8 files by name: `feat(codex): paths, binary resolution, argv, fake codex`.

### Task 4: the brief, the secret scan, the worker-rules quote, write schema and template

**Owner:** sonnet `worker-medium`. **Reviewer:** fable `worker-high` (secret scan).
**Files:** Create `lib/brief.mjs`, `schemas/write.json`, `templates/write.md`, `tests/brief.test.mjs`.
(`claude/AGENTS.md` is not edited: the worker-only line is already merged, A1.)

**Produces:**
```js
export const SECRET_PATTERNS;   // exactly spec:136, as named RegExps: sk, gh, akia, pem, authjson
export const WORKER_ONLY;       // equals the merged `claude/AGENTS.md:3-4` text joined across the wrap: "If you were dispatched as a worker (a subagent, or a Codex run given a task brief), follow only `## Worker rules` and the brief; ignore the rest of this file."
export const FALLBACK_RULES;    // the spec:121-123 block, about 10 lines
export function secretScan(text): string[];                 // names of matching patterns, never the match
export function workerRules(agentsText): { text: string, fallback: boolean };
export function finalizeBrief(text, agentsText): { text: string, workerRules: "agents"|"fallback" };
export function parseBrief(text, mode): { ok: true, owned: string[], task: string } | { ok: false, reason: string };
```
`workerRules`: the section starts at the line `## Worker rules` (CRLF tolerated) and ends before the next line that
starts with `## ` (`### ` does not end it); empty or missing → fallback. `finalizeBrief` replaces the line
`Worker rules: {{WORKER_RULES}}` with `Worker rules:\n` + section, or appends it when the placeholder is absent, and
puts `WORKER_ONLY` on the line before. The 80-line limit applies to the controller's brief before the worker-rules
insertion; `secretScan` runs on the finalized text. `parseBrief`: > 80 lines → `brief-invalid: too long`; write mode without
`Files you own:` → `brief-invalid: no owned files`; owned = the rest of the `Files you own:` line, split on commas or
whitespace, backticks stripped, one trailing `.` per token dropped (a token with spaces is backtick-quoted). `schemas/write.json` (strict: every object `additionalProperties:false`, all keys required):
`{status: enum done|failed|blocked, note: string, checks_run: [{cmd: string, exit: integer|null}]}`.
`templates/write.md`: spec:113-124 fields in order, with `Worker rules: {{WORKER_RULES}}` and the `WORKER_ONLY`
sentence; "Do not create or edit anything else." sits on its own line after the `Files you own:` line.

- [ ] **Step 1:** Failing tests: each pattern hits a runtime-built fake and misses near-misses (`sk-short`, `ghp_` + 19
  chars, `akia` lower-case, `BEGIN` without dashes); `auth.json` hits, `authXjson` misses (the spec pattern is
  case-sensitive; keep it so); the returned list never contains the matched text; extraction from LF and CRLF copies of
  `claude/AGENTS.md`, with a `### ` inside the section, and fallback when the heading is missing; `parseBrief` cases,
  incl. the template's own `Files you own:` line parsing to the expected globs and `lib/**/*.mjs` keeping its dots.
- [ ] **Step 2:** Proving check → fail. **Step 3:** Implement. A test asserts `WORKER_ONLY` equals the merged
  `claude/AGENTS.md:3-4` text (joined across the wrap), and extracts the rules from that file; another asserts an HTML
  comment before `## Worker rules` (live `~/.claude/AGENTS.md` has one, plus a controller line) is not included in the
  extraction (it runs from `## Worker rules` to the next `## ` heading).
- [ ] **Step 4:** Proving check → pass; `grep -c "dispatched as a worker" claude/AGENTS.md` → 1 (unchanged by this task).
- [ ] **Step 5:** Commit the 4 files by name: `feat(codex): brief checks, worker-rules quote, write schema`.

### Task 5: locks, records, processes, quarantine

**Owner:** sonnet `worker-high`, after Task 2. **Reviewer:** fable `worker-high` (lock, quarantine).
**Files:** Create `lib/locks.mjs`, `lib/procs.mjs`, `tests/locks.test.mjs`, `tests/procs.test.mjs`.

**Produces:**
```js
// procs.mjs (lister per the Task 2 addendum; CODEX_RUN_PROCS file replaces it in tests)
export function listProcs(): Array<{ pid, ppid, name, user: string|null, cmd: string|null }>;
export function killTree(pid): { ok: boolean, out: string };       // taskkill /T /F /PID
export function startTime(pid): string|null;
// locks.mjs
export async function acquirePipe(name): Promise<net.Server|null>;  // listen('\\\\.\\pipe\\'+PIPE_PREFIX+name); EADDRINUSE → null
export function releasePipe(server): Promise<void>;
export async function acquireWorktree(cwd): Promise<{ server, recordPath, prev } | { busy: true } | { blocked: "cwd-missing" }>; // name wt-<sha1(canonPath)>; a missing cwd is blocked before any pipe
export async function acquireSlot(): Promise<{ server, n, recordPath, prev } | { busy: true }>;     // slot-1..3 in order
export function busySlots(): Promise<number>;                       // other slots held now (Part 5 +2 points each)
export function quarantine(prev, procs): { clear: boolean, found: string[] };  // pure; the Task 2 rules
export function writeActive(recordPath, rec): void;   // {run_id, run_dir, state:"active", owner_pid, owner_start_time, child_pids:[], host_started:false}
export function addChild(recordPath, pid): void;
export function markHostStarted(recordPath): void;    // written BEFORE the first --check-host spawn
export function writeClean(recordPath, runId): void;
export async function clearQuarantine(cwd, { yes }): Promise<{ listed: string[], cleared: boolean }>;
```
Rules (spec:160-214): the worktree pipe is taken first, before any cleanup or cleanliness check, and held to the end;
`prev` missing → clear; `prev.state==="clean"` → clear without listing processes; otherwise (a) no sandbox-user process,
(b) no process command line containing the run id or run dir, (c) `host_started` false; all hold → clear (auto), else
`blocked: worktree-quarantined: <found>` and the pipe is released. Slots use the same record and quarantine rules. A quarantined slot is skipped (its pipe released, the next tried); all
three busy or quarantined → `blocked: codex-slots-full` listing the quarantined ones; `--status` (Task 16) prints
quarantined slots. Ruling (d): auto-clear only when both proofs hold: the lister positively verifies no process from
the run is alive (it must be able to see sandbox-user processes), and the worktree's tracked and untracked state
matches the record's last known state (baseline, or the recorded diff hash of the run's final state) with no
half-written lock or record file; otherwise the worktree stays quarantined until `--clear-quarantine`. A blind lister
never auto-clears.

- [ ] **Step 1:** Failing tests: slot-1 quarantined → the run takes slot-2; `acquireWorktree` on a missing path →
  `blocked: cwd-missing` before any pipe; auto-clear when both proofs pass; stays quarantined when the lister is blind;
  stays quarantined when the tree differs from the record; two `acquirePipe` on one name in two child processes → exactly one wins; the name is
  free after the holder exits and after `process.kill(pid)`; Review Focus 1 spellings → one pipe; 4 racing runs → 3
  slots, one `busy`; the six fault-injection cases of spec:197-203 per the Task 2 addendum; record writes are atomic
  (a reader never sees a half file: rename-based); `clearQuarantine` without `yes` lists only.
- [ ] **Step 2:** Proving check → fail. **Step 3:** Implement. **Step 4:** Proving check → pass.
- [ ] **Step 5:** Commit the 4 files by name: `feat(codex): pipe locks, write-ahead records, quarantine`.

### Task 6: the read-boundary check, the ACL scan, `--setup`, the new-version gate

**Owner:** sonnet `worker-high`. **Reviewer:** fable `worker-high` (read boundary).
**Files:** Create `lib/readcheck.mjs`, `tests/readcheck.test.mjs`, `tests/fixtures/icacls-denied.txt`,
`tests/fixtures/icacls-missing.txt` (from Task 1 P7a).

**Consumes:** `sandboxArgs`, `cmdFileText`, `resolveCodex` (Task 3); `REAL_TEMP`, `CFG`, `CODEX_HOME`, `ACL_STATE`.
**Produces:**
```js
export function readTargets({ runId }): { files: Array<{ n, path }>, sentinels: Array<{ n, dir, path }> };
export function readcheckCmd(targets): string;   // "@echo off", per target: type "<path>" >nul 2>nul && echo R:<n> || echo D:<n>, then "echo END"; CRLF
export function parseMarkers(stdout, count): { ok: true } | { ok: false, reason: string };
export async function runReadCheck({ bin, cwd, runId }): Promise<{ ok, reason? }>;
export function parseIcacls(text): { missing: string[], error: boolean };
export async function aclScan(): Promise<{ ok, missing: string[], error?: string }>;  // icacls "<dir>" /T /C per protected folder
export function aclScanDue(now): boolean;          // no complete scan, or >= 24 h since ACL_STATE.last_complete
export function setupLines(): string[];            // the P5 icacls lines for present targets
export async function versionGate({ bin, cwd, runId }): Promise<{ ok, reason? }>;
```
Targets (spec:228-234): files `${CODEX_HOME}\auth.json`, `CFG\.credentials.json`, `~\.git-credentials`,
`~\.config\gh\hosts.yml`, `~\.docker\config.json`, `~\.npmrc`, `~\.pypirc`, `~\.netrc`, `~\.aws\credentials`,
`~\.ssh\id_*` (expanded), each only where present (existence only, never opened by the script); sentinels
`codex-read-sentinel-<runId>.txt` in `CFG`, `CODEX_HOME`, `REAL_TEMP\claude` and each present credential folder,
created by the script, always deleted in `finally`. Sentinels are only placed in folders that exist; `--setup`
creates `%TEMP%\claude` before printing its deny line. A run never creates a protected folder. `parseMarkers`: every index 0..count-1 exactly once as `R:` or `D:`,
`END` present after them; any `R:` → `read-boundary-open: <~-relative paths>`; missing, extra or duplicate marker, no
`END`, or launch error → `read-check-failed`. `parseIcacls`: an entry lacks protection when none of its ACE lines names
`CodexSandboxUsers` with `(DENY)` and a right list containing `R`; the summary line's "Failed processing N" with N > 0 →
`error`. `versionGate` (spec:216-222): the TEMP probe (`echo x> "<REAL_TEMP>\codex-gate-<runId>.txt"` must fail and
leave no file), the outside-worktree probe (same into the worktree's parent), every `--disable` name present in
`codex features list`, `runReadCheck` ok, `aclScan` ok; all pass → write `TESTED_VERSION`; a probe file that did get
created is deleted and reported.

- [ ] **Step 1:** Failing tests (fake codex): all denied → ok; `readOpen:[2]` → `read-boundary-open` naming target 2;
  `readGarbage` → `read-check-failed`; sentinels deleted after ok, open and launch error; a target path with a space;
  both icacls fixtures; `aclScanDue` at 23 h 59 m and 24 h; `versionGate` with `gateOpen` → `codex-version-untested`
  and the probe file removed; spec:250: a file without the deny added after a scan is caught by the next scan.
- [ ] **Step 2:** Proving check → fail. **Step 3:** Implement. **Step 4:** Proving check → pass.
- [ ] **Step 5:** Commit the 4 files by name: `feat(codex): read-boundary check, ACL scan, version gate`.

### Task 7: scope check, diff hash, sandbox and host checks

**Owner:** sonnet `worker-high`. **Reviewer:** opus `worker-high`.
**Files:** Create `lib/scope.mjs`, `lib/checks.mjs`, `tests/scope.test.mjs`, `tests/checks.test.mjs`.

**Produces:**
```js
// scope.mjs (every path forward-slash, relative to cwd; ".codex-tmp/" always ignored)
export function changes(cwd): Array<{ xy: string, path: string, orig?: string }>; // git status --porcelain=v1 -z --untracked-files=all
export function globMatch(path, glob): boolean;   // "**", "*", "?", exact file, "dir/" prefix; case-insensitive
export function scopeCheck(list, globs): { ok: boolean, out: string[] };          // a rename needs both ends owned
export function baseline(cwd): string;            // git rev-parse HEAD
export function diffHash(cwd, base): string;      // sha256 of `git -c core.quotepath=false -c color.ui=never diff --binary --no-ext-diff --no-color --no-renames <base>` + per untracked file (sorted): path \0 bytes; numstat uses the same flags
export function fileStats(cwd, base, list): string[];  // "src/a.ts (+12 -3)" from --numstat; untracked: (+lines -0)
export function isClean(cwd): boolean;            // changes(cwd) empty
// checks.mjs
export async function sandboxCheck({ bin, cwd, runId, n, cmd, timeoutMs = 600000, onPid }): Promise<{ cmd, exit, tail, timeout?: true }>;
export async function hostCheck({ cwd, runId, n, cmd, timeoutMs = 600000, onStart, onPid }): Promise<{ cmd, exit, tail, host: true }>;
```
Both checks write `<cwd>\.codex-tmp\<runId>\check-<n>.cmd` with `cmdFileText`; `tail` = last 300 chars of stdout+stderr;
a timeout runs `killTree` on the spawned pid and returns `exit: null, timeout: true`. `hostCheck` calls `onStart()`
before spawning `cmd.exe /d /c <file>`.

- [ ] **Step 1:** Failing tests on a temp repo: Review Focus 2 paths (space, `ü`, rename into and out of scope); an
  untracked file outside the globs → `out`; `.codex-tmp/x` ignored; `diffHash` equal for an unchanged tree, different
  after one byte changes in an untracked file and after `git add`, and unchanged with `diff.noprefix=true` and
  `color.ui=always` in the test repo config; `globMatch` table; a check `echo "a b" & exit /b 4`
  → exit 4; a check that sleeps past a 2 s test timeout → `timeout`, its process gone; a worktree path with a space.
- [ ] **Step 2:** Proving check → fail. **Step 3:** Implement. **Step 4:** Proving check → pass.
- [ ] **Step 5:** Commit the 4 files by name: `feat(codex): scope check, diff hash, checks`.

### Task 8: usage reader, quota decision, ledger, result

**Owner:** sonnet `worker-medium`. **Reviewer:** opus `worker-high`.
**Files:** Create `lib/usage.mjs`, `lib/ledger.mjs`, `lib/result.mjs`, `tests/usage.test.mjs`,
`tests/ledger-result.test.mjs`, `tests/fixtures/rollout-weekly.jsonl`, `tests/fixtures/rollout-both.jsonl`.

**Produces:**
```js
// usage.mjs
export function findRollout(threadId, now): string|null;   // CODEX_HOME/sessions/YYYY/MM/DD (UTC today, yesterday)/rollout-*-<threadId>.jsonl
export function lastRateLimits(file): { ts: number /* epoch ms of the event */, rl: object }|null;  // tail-first; event_msg payload.type "token_count" with rate_limits
export function mapWindows(rl): { pct: number|null, resets_at: number|null /* epoch s */, week_pct, week_resets_at /* epoch s */ }; // window_minutes 300 / 10080; the `codex-quota <ISO>` reason formats separately
export function recordUsage(runId, reading): void;   // USAGE_DIR/codex-<runId>.json {ts, provider:"codex", ...mapWindows}; keep newest 20 codex-*; LAST_USAGE = {ts, rate_limits}
export function latestReading(now): { ts, rl }|null; // Part 5: rollouts modified in the last 8 days, newest valid event; else LAST_USAGE
export function quotaDecision({ reading, now, busySlots, mode, model }): { action: "run"|"downgrade"|"block", reason?: string, notes: string[] };
export function codexTokens(eventsFile): { in, cached, out };   // sum of turn.completed.usage
// ledger.mjs
export function appendRun(o): void;   // LEDGER line {ts, run_id, task, mode, model, writer, effort, status, checks_passed, host_checks, secs, codex_tokens, files, week_pct}
// result.mjs
export function buildResult(r): string;   // one JSON line, <= 2000 chars; review results carry `patch_sha256`, passed through
```
`pct` is `null` for a weekly-only provider. Agreed with the pacer lane cw-batchB 2026-10-06 (pace.json contract:
`usage/codex-<run-id>.json` `{ts epoch ms, provider:"codex", pct, resets_at epoch s, week_pct, week_resets_at}`; newest
20 kept; readings > 10 min old are ignored by the pacer, so codex shows absent between runs = default routing).
`quotaDecision` (spec:95-96, 386-395): a window past its `resets_at` counts 0; effective week = `week_pct + 2*busySlots`;
`rate_limit_reached_type` non-null with `resets_at` in the future, or effective >= 95 → `block`, reason
`codex-quota <resets_at ISO>`; >= 85 and `mode==="write"` and `model==="sol"` → `downgrade`; reading older than 6 h →
note `codex-quota-stale`; no reading or null `resets_at` → note `codex-quota-unknown`, `run`. `buildResult` truncates in
this order until it fits: check tails 300, `codex_note` 300, findings 8 × 200 per field, hypotheses 5, `answer` 1500,
then `files` to the first N plus `"+k more"`, then check tails to 80.

- [ ] **Step 1:** Failing tests: the written usage file's numeric fields are numbers and `ts` is 13 digits (epoch ms);
  weekly-only, both windows, none, missing rollout (usage null, status untouched); a
  rollout in yesterday's UTC folder at 00:30 UTC; the usage file has `provider:"codex"` and the `codex-` prefix; 21 runs
  keep 20 files; each `quotaDecision` branch incl. +2 points per busy slot crossing 85 and 95; `buildResult` with
  10 KB inputs → <= 2000 chars and valid JSON; ledger line keys exactly as above.
- [ ] **Step 2:** Proving check → fail. **Step 3:** Implement. **Step 4:** Proving check → pass.
- [ ] **Step 5:** Commit the 7 files by name: `feat(codex): usage reader, quota decision, ledger, result`.

### Task 9: guards and the orchestrator

**Owner:** sonnet `worker-high`, after Tasks 3-8. **Reviewer:** fable `worker-high` (lock order, the check sequence).
**Files:** Create `codex-run.mjs`, `lib/guards.mjs`, stubs `lib/review-input.mjs`, `lib/status.mjs`, `lib/verdict.mjs`,
`tests/guards.test.mjs`, `tests/run.test.mjs`.

**Produces:**
```js
// guards.mjs
export function isLinkedWorktree(cwd): boolean;        // git rev-parse --git-dir !== --git-common-dir (resolved)
export function laneCheck(cwd): { ok: true, note?: string } | { ok: false, reason: string };  // Decision 9
export function continueCheck(prevMeta, cwd): { ok: true } | { ok: false, reason: string };   // same baseline, diffHash equal
// stubs (final signatures; Tasks 12, 16, 17 replace the files)
export async function reviewInput({ cwd, runId, reviewOf, base }): Promise<{ ok: false, reason: "review-input-not-built" }>;
export function statusLine(): string;                  // "codex-run status: not built"
export function verdictCmd(argv): { ok: false, reason: "verdict-not-built" };
```
CLI per spec:144-150, plus `--setup` and `--clear-quarantine <worktree> [--yes]`. One fixed run sequence (spec:153-312,
484): (1) args, brief read, `secretScan`, `parseBrief`; (2) `isLinkedWorktree`, `laneCheck`; (3) worktree pipe →
quarantine; (4) slot pipe → quarantine; (5) remove a leftover `.codex-tmp`, `writeActive` on both records; (6) write
mode: `isClean` or `continueCheck`, record `baseline`; (7) `quotaDecision` on `latestReading` (a quota block costs no version gate or ACL scan);
(8) version >= 0.159.1, `versionGate` when the version differs from `TESTED_VERSION`, `aclScan` when due; (9)
`runReadCheck`; (10) write
`<run-dir>/brief.md` (`finalizeBrief`), `meta.json` `{run_id, cwd, mode, baseline, owned, task}`, spawn Codex with
`execArgs` (no shell, `windowsHidden`), brief on stdin then `stdin.end()`, stdout → `events.jsonl`, stderr →
`stderr.txt`, timeout (`--timeout-min`, `CODEX_RUN_TIMEOUT_MS`) → `killTree`, survivors → `orphans`; (11) write mode:
initial scope → `--check` sandbox checks → `--check-host` (after `markHostStarted`) → cleanup → final scope →
`diffHash`, `fileStats`, saved in `meta.json`; status per spec:291-294 (Codex's `blocked` in `last.json` → `blocked`);
(12) `recordUsage`, `appendRun`; (13) delete `.codex-tmp`, confirm no tagged process, `writeClean` both records,
release pipes; (14) print `buildResult`. Any guard failure prints a `blocked` result with one reason and exits 0 after
releasing what it holds. On any guard failure after `writeActive`, the script first confirms step 13(b) (no tagged
process) for its own run id, writes `clean` on both records, appends the ledger line with `status:"blocked"`, then
releases the pipes. At the end of a run it lists sandbox-user processes (rule (a)) absent from a pre-run snapshot and
reports them as `orphans`, leaving the record `active` (quarantine next run) instead of `clean`. The false positive (the
user's interactive Codex started mid-run) is the accepted conservative side (spec:190). `--status` → `statusLine()`; `--verdict` → `verdictCmd`; `--setup` → `setupLines()` plus an
ACL scan.

- [ ] **Step 1:** Failing tests: a missing `--cwd` → `blocked: cwd-missing` with no pipe taken; main checkout → `blocked`; dirty tracked file and untracked file → `blocked`; another
  live lane's worktree (temp registry, `HL_SESSION_ID` set and unset; `unknown` liveness blocks); secret in brief →
  `blocked` with no Codex spawn; a guard failure after `writeActive` (the read-check-open case) → ledger line
  `blocked`, both records `clean`, pipes released; a sandbox-user process absent from the pre-run snapshot → `orphans`
  and the record stays `active`; version 0.150.0 → `blocked`; quota block and Sol→Luna downgrade with
  `model_downgraded:true`; Codex `done` but a check fails → `failed`; an untracked out-of-scope file → `blocked`, no
  check ran (check writes a marker file that must be absent); a check that writes an out-of-scope file → final scope
  `blocked`; `--continue` with the run's residue → runs, with an extra edit → `blocked`; timeout with a grandchild →
  `orphans` empty and both processes gone; Review Focus 5 (exit 1; invalid `last.json`; no `thread.started`) → `failed`,
  ledger line written, records `clean`; a second run on the same worktree while one sleeps → `worktree-busy`; the
  brief run copy contains the AGENTS.md section, `worker-rules: fallback` noted when absent.
- [ ] **Step 2:** Proving check → fail. **Step 3:** Implement. **Step 4:** Proving check → pass.
- [ ] **Step 5:** Commit the 7 files by name: `feat(codex): guards and the codex-run orchestrator`.

### Task 10: Core review gate

**Owner:** fable `worker-high` (whole core, spec:528) on the range Task 3..Task 9. Fix rounds: sonnet
`worker-high` (Decision 1), scoped Fable re-review of the edits.
- [ ] The reviewer checks spec:153-312 and the spec:484 sequence item by item against `codex-run.mjs`.
- [ ] The controller rules every finding in the private ledger; fixes land; the proving check is green.

### Task 11: Live smoke, write mode (gate G1)

**Owner:** sonnet `worker-medium` (live). **Reviewer:** opus `worker-high` reads the report. **Files:** none in the
repo; throwaway linked worktree `.claude/worktrees/cdx-smoke` on a throwaway branch (removed at the end).

Run from the repo copy: `node optional/codex/skills/dispatching-codex/codex-run.mjs ...`.
- [ ] `--setup` prints the deny lines; the user has run them (Task 1 P5); the ACL scan passes.
- [ ] `write` with Luna on a tiny Python + JS task, `--check` via `codex sandbox` → `done`; the checks really ran.
- [ ] TEMP-denied and outside-worktree probes, and the new-version gate (delete `tested-version` once).
- [ ] Read canaries denied from Codex's own shell (`exec`, ask Codex to `type` a sentinel) and from `codex sandbox`.
- [ ] Two runs on one worktree → the second `worktree-busy`; `--continue` after a deliberately failing check.
- [ ] `git status` inside the sandbox; a server started inside a check does not outlive it.
- [ ] Result line <= 2000 chars; ledger and usage files written; `--status` prints the stub line.
- [ ] **G1 passes** when every item passes. Then Codex writes Tasks 12-14 and the Codex arm of Tasks 15-18. Before G1,
  every task is written by sonnet.

## Wave 3: the remaining modes and the skill (Codex writes)

Each Codex task: the controller writes a brief from `templates/<mode>.md` (<= 60 lines, anchors not code), commits, and
runs `codex-run.mjs --mode write --task <n> --cwd <lane worktree> --check "<proving check>"` in the background. On
`done`: Opus reviews the diff, the controller records `--verdict` (stub until Task 17: note it in the private ledger),
commits by name. `failed` → once with `--continue`, effort one rung up; a second failure → sonnet `worker-high` with
both results (Part 1 rule 4).

### Task 12: review mode input

**Owner:** Codex Sol, effort high (fallback sonnet `worker-high`). **Reviewer:** opus `worker-high`.
**Files:** Replace `lib/review-input.mjs`; create `schemas/review.json`, `templates/review.md`,
`tests/review-input.test.mjs`.

`reviewInput` (spec:126-131, Decision 4): `--review-of <run-id>`: read that run's `meta.json`; current `diffHash` must
equal the recorded one (else `blocked: worktree-changed`); patch = `git diff --binary <baseline>` + each untracked owned
file as a new-file hunk (`git diff --no-index --binary -- /dev/null <relpath>` run from `cwd` with the relative path, exit 1 is normal; the
patch uses the pinned flags of Task 7 `diffHash`); empty → `blocked:
empty-patch`; write `<run-dir>/review.patch` + its sha256 to the review run's `meta.json`, copy to
`<cwd>\.codex-tmp\<runId>\review.patch`; return `{ok, patchPath, sha256}`. `--base <ref>`: `git diff <ref>...HEAD`,
empty → `blocked: empty-range`. `schemas/review.json` (strict): `{verdict: enum approve|rework|reject, findings:
[{sev: enum critical|important|minor, file: string, line: integer|null, claim: string, scenario: string}], note:
string}`. `templates/review.md` adds `Review input: .codex-tmp/<run-id>/review.patch (sha256 <hash>)`.

- [ ] **Step 1:** Failing tests: untracked files appear in the patch; a changed worktree → `worktree-changed`; empty
  patch and empty range → `blocked`; the result carries `patch_sha256` (bound to the patch). **Step 2:** fail. **Step 3:** implement.
- [ ] **Step 4:** Proving check → pass. **Step 5:** Commit the 4 files by name.

### Task 13: diagnose and research modes

**Owner:** Codex Luna, effort medium. **Reviewer:** opus `worker-high`.
**Files:** Create `schemas/diagnose.json`, `schemas/research.json`, `templates/diagnose.md`, `templates/research.md`.

Strict schemas: diagnose `{hypotheses: [{claim: string, check: string}], note: string}`; research `{answer: string,
findings: [{claim: string, source_url: string, confidence: enum high|medium|low}], note: string}`. The diagnose template
adds `Failed attempts:` and `Ruled out:` (spec:133); the research template says the brief holds no repo secrets or
private project names because queries leave the machine (spec:323), and asks for cited sources.

- [ ] **Step 1:** Each schema parses (`node -e` + `JSON.parse` per file) and is strict (every object
  `additionalProperties:false`, `required` = its keys); Task 18's contract tests pin this permanently. Proving check
  stays green.
- [ ] **Step 2:** Commit the 4 files by name.

### Task 14: SKILL.md (Part 1 routing) and the sizing line

**Owner:** Codex Sol, effort medium. **Reviewer:** opus `worker-high`.
**Files:** Create `SKILL.md`. Modify `claude/skills/sizing-dispatches/SKILL.md` (one line after the table:
"If the `dispatching-codex` skill is installed, check it first: Codex-eligible tasks go there.").

`SKILL.md` frontmatter `name: dispatching-codex`, a description that triggers before any implementation, test,
browser-test, review-second-opinion, stuck-debugging or web-research dispatch. Body, compact: the Part 1 owner table and
rules 1-4 (spec:58-85); routing by headroom (spec:89-100, `pace.json` read only when present); the CLI (spec:144-150);
"How a session uses it" (spec:331-338); browser routing with the Task 1 P3 outcome and the spec:379-381 gates;
research privacy; the context-sharing rule (spec:138-139); "Codex's `done` is not proof; the script's status is"
(spec:49, 276); `--check-host` = review before merge; both providers short → park (spec:396); Fable unavailable →
Astra (spec:404-407); the Codex rows never go below the review floors.

- [ ] **Step 1:** Proving check stays green; `grep -c "dispatching-codex" claude/skills/sizing-dispatches/SKILL.md` → 1.
- [ ] **Step 2:** Commit the 2 files by name.

### Task 14b: Live smoke, review, diagnose, research

**Owner:** sonnet `worker-medium` (live). **Reviewer:** opus reads the report. In `cdx-smoke` again:
- [ ] A pre-commit `--review-of` that sees the full diff, untracked files included; a `--base` review.
- [ ] One `diagnose` (Astra) on a planted bug; one `research` (Sol) with `--search`: findings carry `source_url`.
- [ ] Every result <= 2000 chars, the read check passed in each run.

## Wave 4: efficiency proof (spec Part 7, the dry run)

The proof set (1 mechanical, 2 routine logic, 1 test-writing), all real remaining work of this profile:

| Task | Class | Files |
|---|---|---|
| 15 Packaging docs | mechanical | `optional/codex/README.md`, `README.md`, `INSTALL_PROMPT.md` |
| 16 `--status` view | routine logic | `lib/status.mjs`, `tests/status.test.mjs` |
| 17 `--verdict` | routine logic | `lib/verdict.mjs`, `tests/verdict.test.mjs` |
| 18 Contract tests | test-writing | `tests/contract.test.mjs` |

### Task 15-18 arm protocol (controller)

- [ ] **Step 1:** One brief per task (the same text for both arms). Sonnet arm: a background session (handoff-launch
  `--mode bg`, its own worktree on branch `proof-<n>-sonnet`) dispatches one sonnet worker (Task-specific effort below),
  then one Opus `worker-high` reviewer, fix rounds as needed. Codex arm: same, on `proof-<n>-codex`, but the writer is
  `codex-run.mjs` (Sol medium; Luna for Task 15). Same base commit for both.
- [ ] **Step 2:** One null session (handoff: "reply done") for the fixed start-up cost.
- [ ] **Step 3:** At most 4 sessions at once (session cap 6), at most 3 Codex runs (slots).
- [ ] **Step 4:** Cherry-pick the winning arm per task onto `codex-dual` (better Opus verdict; tie → Codex); delete
  the proof branches and worktrees.

### Task 15: packaging docs

Sonnet arm `worker-medium`. `optional/codex/README.md` (spec:438-444, 489-492): requirements, `npm i -g
@openai/codex@latest`, `codex login`, elevated sandbox setup, the one-time toolchain ACL grant, `--setup` and the deny
lines, the TEMP note and the leftover `CodexSandboxUsers:(M)` ACE on `%LOCALAPPDATA%\Temp` with its removal command, the
`~/.codex/AGENTS.md` warning, the newest tested Codex version (the `tested-version` value), the accepted residual risk
(spec:246-249), browser MCPs deferred, the large-org variant, rollback. `README.md`: one What's-inside row.
`INSTALL_PROMPT.md`: the spec:445-446 step. **Check:** no user path, email or account name (`grep -nE "Users[\\/]|@" `
on the 3 files shows only `@example.com` or none); proving check green.

### Task 16: `--status`

Sonnet arm `worker-medium`. `statusLine()` reads `LAST_USAGE` (via `mapWindows`) and, when present, `PACE`'s `claude`
entry; prints one line like `codex week 12% (resets Sat 14:46) · claude 5h 42% week 31%`; missing pieces print
`codex: no reading` / `claude: no reading`; past `resets_at` → 0%. **Tests:** both present, each missing, past reset,
corrupt JSON → "no reading", never throws.

### Task 17: `--verdict`

Sonnet arm `worker-medium`. `verdictCmd(argv)`: `--verdict <run-id> approve|rework|reject "<note>"` appends
`{ts, run_id, verdict, note}` to `LEDGER` when `run_id` has a run line there (else `blocked: unknown-run`);
`--verdict sonnet:<task> <verdict> "<note>"` appends `{ts, run_id:null, task, writer:"sonnet", verdict, note}`; a bad
verdict word → `blocked: bad-verdict`; note trimmed to 200 chars; prints one JSON line. **Tests:** each path, a note with
quotes, a missing ledger.

### Task 18: contract tests

Sonnet arm `worker-medium`. `tests/contract.test.mjs`: every `schemas/*.json` is strict (each object
`additionalProperties:false`, `required` equals its property keys); each template has every spec:113-124 field, the
`{{WORKER_RULES}}` placeholder and the `WORKER_ONLY` sentence; diagnose/research templates carry their extra fields;
`buildResult` keeps a review result with 20 findings and a research result with a 5 KB answer under 2000 chars; an
end-to-end fake run per mode (review via a prior fake write run) returns its mode's fields.

### Task 18b: measurement and the user's OK (gate G2)

**Owner:** sonnet `worker-medium` (tally), opus `worker-high` reviews the numbers.
- [ ] Per arm: sum over every Claude turn of the arm's session and its subagent transcripts of `input + cache_creation
  + output + 0.1 × cache_read`, per model (spec:426-428), minus the null session. Raw and cost-weighted (API list
  price per model; record the prices used) tables, verdicts, wall time, Codex `week_pct` delta. The tally script lives
  in the lane scratchpad, not the repo.
- [ ] Gate: cost-weighted Codex arm <= 60% of the sonnet arm, verdicts equal or better (spec:429).
- [ ] The controller shows the tables to the user and asks for the deploy OK. **G2 = the user's OK.** A failed gate is
  reported as is, with the per-task breakdown; deploy waits for the user's ruling.

## Wave 5: release

### Task 19 (controller, after G2): deploy, verify, push

- [ ] **Step 1:** Full proving check on the release head; any file edited after its review has had a scoped re-review
  (Fable for `lib/{argv,brief,locks,procs,readcheck}.mjs`, `codex-run.mjs`; Opus otherwise).
- [ ] **Step 2:** Secret scan: the private handoff's pattern plus the brief token patterns `\bsk-(ant-)?[A-Za-z0-9_-]{8,}`,
  `\bgh[pous]_[A-Za-z0-9]{20,}`, `\bAKIA[0-9A-Z]{16}\b`, `-----BEGIN [A-Z ]*PRIVATE KEY-----` over the tree and the
  branch log → prints nothing (gap 4). Add those 4 to the private handoff's scan for later pushes.
- [ ] **Step 3:** Backups of the 1 live file that changes (`sizing-dispatches/SKILL.md`; the AGENTS.md worker-only line
  is already live, A1). In this order: the skill folder (without `tests/`) to `~/.claude/skills/dispatching-codex/`,
  then `claude/skills/sizing-dispatches/SKILL.md`; the live copy only after `diff --strip-trailing-cr` shows just the
  one added line.
- [ ] **Step 4:** Live verify: `node ~/.claude/skills/dispatching-codex/codex-run.mjs --status`; one Luna `write` smoke in
  a throwaway linked worktree from the live copy; `grep -c "dispatched as a worker" ~/.claude/AGENTS.md` → 1. No
  settings, hooks or running lanes change (spec:535).
- [ ] **Step 5:** Merge `codex-dual` into `main` (fast-forward or merge commit), push `main` after Step 2 again on the
  merged head.
- [ ] **Step 6:** Rollback note in the private ledger: delete the skill folder, the sizing line and the AGENTS.md line.
- [ ] **Step 7:** Carry deferred items with owners: `--report` and the degradation rule (tracking wave, spec:415), the
  browser MCPs (next Codex-profile wave), anything the reviews deferred.

## Build waves

All paths under `optional/codex/skills/dispatching-codex/` unless noted.

- **Wave A:** T1 probes (user-assisted, no repo files) ‖ T2 opus design (addendum file) ‖ T3a `lib/paths.mjs`,
  `tests/helpers.mjs` (commit first), then T3b `lib/binary.mjs`, `lib/argv.mjs`, `tests/fake-codex.mjs`,
  `tests/{argv,binary,fake-codex}.test.mjs` ‖ T4 `lib/brief.mjs`, `schemas/write.json`, `templates/write.md`,
  `tests/brief.test.mjs` ‖ T8 (after T3a) `lib/{usage,ledger,result}.mjs`, `tests/{usage,ledger-result}.test.mjs`,
  `tests/fixtures/rollout-*.jsonl`.
- **Wave B (after T3b):** T5 `lib/{locks,procs}.mjs` + tests (needs T2 + P4) ‖ T6 `lib/readcheck.mjs` + tests +
  `tests/fixtures/icacls-*.txt` ‖ T7 `lib/{scope,checks}.mjs` + tests. Fable reviews T5 and T6 as each lands.
- **Wave C:** T9 `codex-run.mjs`, `lib/guards.mjs`, `tests/{guards,run}.test.mjs` → T10 Fable → T11 G1 live.
- **Wave D:** Codex serial: T12 → T13 → T14 (+ T14b after T13); sonnet arms of T15-T17 in parallel from G1 (T18 after
  T13).
- **Wave E:** Codex arms T15-T18, T18b tally, T19.

Sizing: T3, T5, T6, T7, T9 sonnet high; T4, T8, T15-T18 sonnet medium; T1, T11, T14b sonnet medium live; T2 opus high;
T10 fable high.

## Schedule (deadline 2026-10-09)

| Day | Work |
|---|---|
| 10-06 | Tasks 0-2; Tasks 3, 4, 8 |
| 10-07 | Tasks 5-7, 9, 10, 11 (G1) |
| 10-08 | Tasks 12-14, 14b; proof arms 15-18 |
| 10-09 | 18b (G2: the user's OK), 19 |

## Spec gaps found while planning

Each is resolved in the plan; the controller confirms or rules otherwise.

1. **The run dir is unreadable to the sandbox** (spec:109 puts it under `~/.claude`; spec:466 denies `~/.claude`), yet
   spec:127-128 passes `review.patch` there to the reviewer and spec:271 runs research "under the run dir". Resolution:
   Decision 4 (`.codex-tmp` copies; research `-C` inside the worktree's `.codex-tmp`).
2. **Research outside a git repo needs `--skip-git-repo-check`** (`codex exec --help`, 0.160.0). Resolution: research
   runs inside the worktree's `.codex-tmp`, so the flag is not needed and the linked-worktree guard still applies.
   Research therefore needs a linked worktree and holds its lock; acceptable.
3. **Web search is named two ways:** Part 4 (spec:370) "opt-in, `--network`", Part 2 (spec:269-271) research's
   `--search` with sandbox network off. Resolution: Decision 5.
4. **The repo secret scan cannot take the brief patterns as written** (spec:450): `auth\.json` and `-----BEGIN` occur in
   the profile's own code and docs. Resolution: the repo scan adds the 3 token patterns and
   `-----BEGIN [A-Z ]*PRIVATE KEY-----`; `auth\.json` stays brief-only; test secrets are built at run time.
5. **The AGENTS.md worker-only line** (spec:354). **Resolved upstream by `98fd6a7`** (on `main` and live); Task 4 only
   pins the sentence.
6. **`codex sandbox` has no `--ignore-user-config`** (`codex sandbox --help`, 0.160.0), so the user's config may shape
   check runs. Resolution: Task 1 P1 measures it; Task 3 adjusts `sandboxArgs` if needed and records why.
7. **Lane rule vs separate worktrees:** with `HL_SESSION_ID` set, `--cwd` must be the lane's own worktree (spec:156), so
   a lane could not give Codex a sibling worktree. Resolution: ruling (a) and Decision 11 (a lane may give Codex its own
   self-created linked worktree; each run locks its worktree); the proof arms get their own sessions and worktrees.
8. **Part 6 needs a writer field** that the spec:309 ledger line lacks. Resolution: Decision 7.
9. **Part 7 measures arms inside long-lived sessions** only if turns can be attributed. Resolution: Decision 10 (one
   background session per arm, minus a null session).
