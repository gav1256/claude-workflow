# Codex dual-brain profile: Claude and OpenAI Codex as two developers on one project: design

Status: Fable spec review 2026-10-05 (APPROVE WITH AMENDMENTS), a Fable confirmation (F1-F7), an independent Codex
Astra review (REVISE, A1-A8), Astra re-reviews 2-5 (REVISE). All are applied. The user asked to continue once Astra approves.

## Goal

The user is moving from Claude Max $200 to Claude Max $100 + ChatGPT Pro $100 ("Pro Lite") at the next renewal. By
**2026-10-09** the workflow must:

- produce the same or better code (cleaner, reviewed the same way or harder),
- spend **fewer Claude tokens per unit of work than today**, measured cost-weighted (Part 7),
- never hit a Claude 5-hour or weekly limit because of work Codex could have done, and never exhaust both providers,
- keep Claude ↔ Codex messages short: briefs and results are files and fixed-shape JSON, never transcripts.

The model is **two developers on one project.** Each task has exactly one owner. They work on disjoint files in
separate worktrees and meet at commits. Both work on the same problem only when the Claude reviewer is stuck.

## User decisions (2026-10-05)

| Decision | Choice |
|---|---|
| Packaging | An optional `codex` profile in the public repo, off by default. The default install stays Claude-only. |
| Switch date | At the next renewal. Live and measurably cheaper by 2026-10-09. |
| Hand-off mechanism | Approach A: a script plus a skill (`codex exec` in the background). Rejected: Codex as an MCP server (tool schema in every context, call timeouts, unbounded results) and a Claude subagent wrapping Codex (15-60k Claude tokens per task cancel the saving). |
| Sandbox | Codex and every command it causes always run in its Windows sandbox (`elevated`), with the user's Codex config ignored. Unsandboxed Codex is rejected: it could reach `~/.claude`, `~/.codex/auth.json`, other lanes and the network. |
| Worktrees | Codex works only in the task's own linked worktree and must respect the others (user: "ensure that codex also works and respects the worktrees"). Verified by probe (facts table). |
| Tests | Codex must run every test it can. The user granted the sandbox group read/execute on the per-user toolchains (Python, Rust, npm, uv, .NET tools, Playwright browsers). Docker is not granted, because Docker access is host-equivalent. |
| Browser | Browser tests and in-browser tasks go to Codex to save Claude usage. Sonnet keeps only browser work that needs the user's real logged-in Chrome or Claude-only tools. |
| Roles | Fable = review and advisor only. Astra = Fable's backup when Fable is unavailable or a second opinion is needed. No code writing on Opus or Fable (the 2026-10-05 "writing = sonnet" rule; Codex is now the main writer). |
| Fable effort | Fable runs at `worker-high`. `worker-xhigh` only for genuinely hard questions: what counts is difficulty, not importance or topic (all sessions, 2026-10-05). |

## Verified facts (probes 2026-10-05; details in `machine-notes.md` on the user's machine)

| Fact | Evidence |
|---|---|
| Codex CLI 0.160.0 comes from npm `@openai/codex`. `codex` on PATH is a `.cmd`/`.ps1` shim → `node bin/codex.js` → native `codex.exe` at `<npm root -g>/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`, with its own sandbox helpers. Older copies (desktop app 0.140, `~/.codex/.sandbox-bin` 0.142) cannot use the GPT-6 models. | `npm install -g`, `codex --version`, Fable review |
| Working command: `codex -a never exec -m <slug> -C <dir> -s workspace-write --ignore-user-config -c windows.sandbox=elevated -c shell_environment_policy.set.TEMP=<dir>\.codex-tmp ... --output-schema <schema> -o <out> -`, with the brief on stdin. | Luna probes fixed `add.py` + `add.js` |
| Without `-c windows.sandbox=elevated`, `--ignore-user-config` silently downgrades `workspace-write` to read-only. | rollout `sandbox_policy: read-only` |
| A non-TTY stdin left open makes `codex exec` wait forever. `-a` must come before `exec`. | probes |
| **Worktree isolation holds.** From `<repo>/.claude/worktrees/lane1`, both `codex exec` (Codex's own shell commands) and `codex sandbox` were allowed to write only in lane1. Writes to the main checkout, the sibling `lane2` and the main `.git` were denied. Python ran. | probes 5-7 |
| **Reads are not restricted.** The sandbox blocks writes outside the worktree, but a sandboxed command could read `~/.codex/auth.json`, `~/.claude/`, `%TEMP%\claude\` and the main checkout (canary probe after the Astra review). Fixed by deny-read ACEs (Part 9). | canary probe |
| **TEMP hole.** By default the user's `%TEMP%`, which holds Claude's session scratchpads, is writable from the sandbox, even with `exclude_tmpdir_env_var`. Setting `shell_environment_policy.set.TEMP`/`TMP` to a folder inside the worktree closes it: writes to `%TEMP%` were then denied. | probes 6-7 |
| `codex sandbox -P :workspace -C <dir> -c windows.sandbox=elevated -- C:\Windows\System32\cmd.exe /d /s /c "<cmd>"` runs any check inside the same sandbox, with no model call and no tokens. Network is off there. It does not search PATH, hence the full path to `cmd.exe`. | probe 5 |
| `--output-schema` (strict JSON Schema) is honoured. `--json` events: `thread.started{thread_id}`, `turn.started`, `item.*`, `turn.completed{usage}`, `error`, `turn.failed`. No rate limits appear in that stream. | probes |
| Rate limits appear only in the rollout `${CODEX_HOME}/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` (UTC-dated folders), as `event_msg.payload.rate_limits.{primary,secondary,plan_type,rate_limit_reached_type}`. On Pro Lite, `primary` is the 10080-minute weekly window and `secondary` is null: **there is no 5-hour window**. | rollouts |
| Codex's own overhead is about 35-105k input tokens per run, mostly cached, billed to ChatGPT. A Luna run moved the weekly window by about 0%. | `turn.completed.usage` |
| Codex said `status: "done"` although the Python test never ran. Codex's self-report is not proof. | probe 4 |
| Codex's "browser" plugin drives only the desktop app's in-app browser (named pipe, needs a live app session). It does not work from `codex exec`. "Computer use" controls the real desktop. MCP servers that Codex launches run **outside** the sandbox, as the user. | explorer report, openai/codex #26820, shell-tool-mcp README |
| Models (OpenAI docs, read 2026-10-05): `gpt-6-luna` (about 1/20 of Sol's credit cost), `gpt-6.1-sol` (CLI default), `gpt-6-astra` (about 5x Sol). `gpt-5.5` leaves Codex on 2026-10-14. | research report |
| Benchmarks (mostly vendor-reported): Opus 5.5 leads every coding benchmark both vendors report (independent Terminal-Bench 4.0: Opus 59.6 vs Sol 43.9). Astra roughly ties Fable 5.1 with about 1/3 of the output tokens. | research report |

## Part 1: Roles and routing

### Who owns what

| Work | Owner | How |
|---|---|---|
| Design talk with the user, rulings, orchestration | Main session (Opus) | as today |
| Writing specs and plans | Opus | `worker-high` opus, or the main session |
| Spec, plan and correctness-critical code review; advisor | **Fable** | `worker-high` fable (`worker-xhigh` only for genuinely hard questions) |
| The same, when Fable is unavailable (Part 5) or a second opinion is wanted | **Codex Astra** | `review` mode |
| Root-cause debugging, first attempt | Opus | `worker-high` opus |
| Routine implementation, tests, refactors, running suites | **Codex Sol** | `write` mode, effort medium (high for real logic) |
| Mechanical edits, boilerplate, renames, tests from a given spec, doc/i18n churn | **Codex Luna** | `write` mode, effort low or medium |
| Hard implementation (concurrency, security, migrations, auth, math) | Opus designs the exact behaviour and tests. **Codex Sol (high)** writes. Fable reviews. | |
| Browser tests and in-browser tasks on the project's app | **Codex** (Part 4) | `write` mode, Sol or Luna |
| Work needing Docker inside the task, git network, the user's real Chrome, Claude-only tools (MCP, Agent), or `~/.claude` | Sonnet | `worker-*` sonnet per the sizing table |
| Ordinary review | Opus | `worker-high` opus |
| Second opinion on correctness-critical diffs | Codex Sol `review` (read-only), in parallel with Fable | |

Rules:

1. **The writer's model family never reviews alone.** Claude (Opus or Fable) reviews Codex-written code. Sonnet code on
   correctness-critical slices also gets a Codex `review`. The review floors from `sizing-dispatches` apply whoever
   wrote the code.
2. **One owner per task, disjoint files.** The plan assigns every task an owner and a file set. Codex and Claude never
   edit the same file in the same wave. A task that builds on another task's output names the commit it builds on.
3. **Both brains on one problem only when stuck.** When Fable (or the Opus debugger) has failed twice on the same
   issue, one Astra `diagnose` run (read-only) gets the problem, the failed attempts and the ruled-out hypotheses. It
   returns ranked hypotheses, each with a check. Claude decides, and a writer applies the fix.
4. **Codex failed twice on a task → sonnet** (`worker-high`) gets Codex's two results. A sonnet failure then follows the
   existing escalation ladder.

### Routing by headroom

Codex Pro Lite has no 5-hour window, so Codex is the elastic buffer for Claude's 5-hour window.

| Signal | Who applies it | Action |
|---|---|---|
| Default | skill text | Every Codex-eligible task goes to Codex (table above). |
| Claude pace `slow`/`hold` in batch B `pace.json` | controller, via the skill text | Borderline tasks go to Codex too: sonnet-default tasks that do not need Docker, MCP or git network. |
| Codex `week_pct` ≥ 85 | `codex-run.mjs`, zero tokens | A `write` on Sol is downgraded to Luna; the result says `model_downgraded:true`. |
| Codex `week_pct` ≥ 95, or `rate_limit_reached_type` non-null with `resets_at` in the future | `codex-run.mjs` | Exit `blocked`, reason `codex-quota <resets_at>`. The controller sends the task to sonnet if Claude has headroom, otherwise parks it (Part 5). |
| Fable unavailable (Part 5) | controller | Astra takes plan, spec and second-opinion reviews. Fable keeps correctness-critical code. |

Before batch B ships `pace.json`, the Claude side has no live reading. Routing then uses the default row only, which
already moves most writing off Claude. That is enough for 2026-10-09.

## Part 2: `dispatching-codex` skill and `codex-run.mjs`

The skill lives in the optional profile: `optional/codex/skills/dispatching-codex/` with `SKILL.md`, `codex-run.mjs`,
`schemas/{write,review,diagnose}.json`, `templates/{write,review,diagnose}.md` and `tests/`.

### Brief (Claude → Codex): one file, at most about 60 lines

The controller writes it to `<run-dir>/brief.md` (`<run-dir>` = `~/.claude/state/codex/runs/<run-id>/`). The only
thing written into the worktree is the scratch folder `.codex-tmp/` (TEMP, check scripts, MCP output), which every
guard and scope check ignores and which is deleted after the run. The template for each mode has these fields:

```
# Task <id>: <one line>
Goal: <2-4 lines: the behaviour wanted, not how>
Files you own: <paths/globs>. Do not create or edit anything else.
Read first: <path:line anchors, at most 10>
Builds on: <commit sha or "none">
Done when: <the check commands, one per line>
Constraints: <only the ones that matter: style, no new deps, fake data ...@example.com>
Worker rules: (fixed block from the template, about 10 lines: stay in the owned files; no git commit/push; no network
  unless granted; write tests first when the task adds behaviour; keep the diff minimal; report honestly: a check you
  could not run is "blocked", not "done")
```

The `review` template adds a **review input** prepared by the script, never a bare range:
- `--review-of <run-id>` (pre-commit review of a write run): the script saves that run's final diff to
  `<run-dir>/review.patch` and passes it to the reviewer. The diff covers tracked changes against the run's recorded
  baseline commit, plus the untracked owned files as new-file hunks. The verdict is bound to the patch's sha256. An
  empty patch → `blocked`. A worktree that changed since the run (hash mismatch) → `blocked`.
- `--base <ref>` (committed-range review): `git diff <base>...HEAD`; an empty range → `blocked`.

The `diagnose` template adds `Failed attempts:` and `Ruled out:`.

No secrets ever go in a brief. `codex-run.mjs` refuses a brief that matches any of these and exits `blocked`:
`\bsk-(ant-)?[A-Za-z0-9_-]{8,}`, `\bgh[pous]_[A-Za-z0-9]{20,}`, `\bAKIA[0-9A-Z]{16}\b`, `-----BEGIN`, `auth\.json`.

Context sharing rule: Codex reads the code itself, which costs Claude nothing. The brief carries anchors, not code.
Claude reads only the result JSON, plus the diff when reviewing. It never reads Codex's events, rollout or reasoning.

### `codex-run.mjs` (Node 18+, no dependencies)

```
node codex-run.mjs --brief <file> --cwd <worktree> --mode write|review|diagnose
                   [--model luna|sol|astra] [--effort low|medium|high|xhigh]
                   [--review-of <run-id> | --base <ref>] [--continue <run-id>]
                   [--check "<cmd>"]... [--check-host "<cmd>"]... [--network]
                   [--timeout-min 30] [--task <id>]
node codex-run.mjs --verdict <run-id> approve|rework|reject "<one line>"
node codex-run.mjs --status
```

1. **Guards.** Any failure exits `blocked` with one reason line.
   - `--cwd` is a linked git worktree (`git rev-parse --git-dir` ≠ `--git-common-dir`), never a main checkout.
   - Lane check:
     - When `HL_SESSION_ID` is set, `--cwd` must equal that registry entry's `worktree` (paths normalized, compared
       case-insensitively).
     - When it is unset (a hand-opened session), `--cwd` must not be the `worktree` of any other lane whose newest
       generation is live.
   - **Locks are OS mutexes: Windows named pipes.** A `net.createServer().listen('\\.\pipe\<name>')` succeeds for
     exactly one process (others get `EADDRINUSE`), and Windows frees the name the moment that process exits or is
     killed. There is no stale-lock reclamation and so no reclamation race. Verified 2026-10-05 from PowerShell and
     from Bash: second holder refused, freed after normal exit and after `Stop-Process -Force`.
   - **Worktree lock first**, before any cleanup or cleanliness check: hold the pipe
     `codex-run-wt-<sha1 of the canonical lower-case worktree path>` for the whole run, through verification and
     process cleanup. Busy → `blocked` (`worktree-busy`).
     - Next to it, the script keeps a record file `~/.claude/state/codex/worktree-locks/<sha1>.json` =
       `{run_id, state, owner_pid, owner_start_time, child_pids}`.
     - **Write-ahead state.** Before the first spawn, the record is written (atomically: temp file + rename) with
       `state:"active"`. Only after the whole process tree has been verified gone at the end of the run is it
       rewritten to `state:"clean"`. `child_pids` is filled in as processes start; it is a hint, not the safety
       mechanism.
     - **Every directly spawned process carries the run id on its command line**: `codex.exe` via
       `-o <run-dir>\last.json`; `codex sandbox` and host checks via `<cwd>\.codex-tmp\<run-id>\check-N.cmd`; probes
       via `<cwd>\.codex-tmp\<run-id>\readcheck.cmd`.
     - **Why not containment:** a Windows Job Object with kill-on-close does **not** contain sandboxed processes.
       Probe 2026-10-05: the launcher was in the job (`AssignProcessToJobObject` returned true) and was killed, yet
       `codex.exe` and the sandboxed grandchildren (`CodexSandboxOffline` → `codex-command-runner` → `cmd` → `ping`)
       survived. So recovery cannot rely on containment, and it cannot rely on a by-id search either, because a
       tagged parent may exit after spawning untagged children.
     - **Quarantine after a crash, conservative.** After acquiring the pipe, read the previous record. If its `state`
       is not `clean` (or the record is unreadable or incomplete), the worktree is quarantined. The script clears it
       automatically only when all of these hold:
       - (a) no process runs as `CodexSandboxOffline` or `CodexSandboxOnline` (every sandboxed descendant runs as one of
         these users, so their absence proves that no sandboxed child survived);
       - (b) no process command line contains the run id or run-dir;
       - (c) the record shows no host check was started (`host_started` is written ahead, before the first
         `--check-host` spawn).
       Otherwise the status is `blocked` (`worktree-quarantined`, listing what was found), and the pipe is released.
       - (a) can also be true of the user's interactive Codex, so a busy machine may hold quarantine longer. That is
         the accepted cost of being conservative.
       - `--clear-quarantine <worktree>` lists every candidate (sandbox-user processes, tagged processes) and, after the
         user confirms, ends them with `taskkill /T /F`. It re-checks (a)-(c) and only then writes `clean`.
       - It never auto-kills: the controller tells the user.
     - At the end of a normal run, `state:"clean"` is written only after (b) holds for this run, and after the
       script's own sandbox and host-check children have exited (their pids are known while the script is alive).
     - Tests, with fault injection:
       - kill the controller right after spawn, before any pid is recorded (the next run is quarantined via (a)/(b));
       - a tagged parent exits leaving an untagged sandboxed grandchild (quarantined via (a));
       - a host check started and then the controller is killed (quarantined via (c) until cleared);
       - two runs racing for one worktree (exactly one wins);
       - a stale `active` record with no survivors (auto-cleared);
       - a clean record (no search).
   - `write` mode:
     - `git status --porcelain --untracked-files=all` must be empty, ignoring `.codex-tmp/`, so the change set is
       Codex's alone. A leftover `.codex-tmp/` from a crashed run is removed first (safe under the worktree lock).
     - The script records the baseline commit (`HEAD`).
     - Exception, `--continue <run-id>`: the worktree may hold exactly that earlier run's residual edits. Its baseline
       commit is unchanged, and the current diff hash equals the hash recorded at the end of that run. The baseline and
       owned paths carry over, and scope checking stays cumulative against the original baseline. Any other change →
       `blocked`. This is what makes "redo once" and pre-commit rework possible without a manual clean-up.
   - Concurrency, at most 3 runs machine-wide: try the pipes `codex-run-slot-1`, `-2`, `-3` in order and hold the first
     free one for the run. All busy → `blocked` (`codex-slots-full`). Same record and quarantine rules as the worktree
     lock (`~/.claude/state/codex/slot-locks/<n>.json`).
   - Version: native `codex.exe` reports ≥ 0.159.1. The README states the newest version tested.
   - New-version gate: when `codex.exe --version` differs from `~/.claude/state/codex/tested-version`, run three
     checks before the first task:
     - the TEMP-denied probe: a `codex sandbox` write to the real `%TEMP%` must fail;
     - the outside-worktree probe: a write to the worktree's parent folder must fail;
     - every `--disable` feature name used must appear in `codex features list`;
     - the read-boundary check below passes.
     If one fails, exit `blocked` (`codex-version-untested`); if all pass, record the version.
   - **Read-boundary check, every run** (Part 9), at zero tokens, in one `codex sandbox -P :read-only` call:
     - The script writes `.codex-tmp\<run-id>\readcheck.cmd`, which prints only markers, never contents. For each target `<n>` it
       runs `type "<file>" >nul 2>nul && echo R:<n> || echo D:<n>`, and it ends with `echo END`.
     - The targets are **files**, because listing a folder proves nothing about a file inside it whose inheritance is
       disabled:
       - a fixed list of known credential files, where present: `${CODEX_HOME}\auth.json`,
         `~/.claude/.credentials.json`, `~/.git-credentials`, `~/.config/gh/hosts.yml`, `~/.docker/config.json`,
         `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/.aws/credentials`, `~/.ssh/id_*`;
       - a fresh, uniquely named sentinel file (`codex-read-sentinel-<run-id>.txt`, deleted after the check) in
         **every** protected folder: `~/.claude`, `${CODEX_HOME}`, `%TEMP%\claude` and each present credential-store
         folder (`~/.ssh`, `~/.config/gh`, `~/.docker`, `~/.aws`, `~/.azure`). This proves the inherited folder deny
         applies to new files, as after a token refresh.
     - The expected marker set is complete: every target prints exactly one `D:`. Any `R:` → `blocked`
       (`read-boundary-open: <targets>`). A missing or extra marker, a missing `END` or a launch error → `blocked`
       (`read-check-failed`).
     - **ACL scan, host side, ACLs only** (`icacls /T`, no contents): any file in the protected folders whose ACL
       lacks the `CodexSandboxUsers` deny (for example because inheritance is disabled) is listed, and the run is
       `blocked` until it is fixed. A scan error is also `blocked`.
       - A full scan of `~/.claude` took **over 5 minutes** on this machine (measured 2026-10-05; stopped
         unfinished), so it cannot run every run.
       - It runs at `--setup`, at the new-version gate, and at the first run after 24 h have passed since the last
         complete scan. That run waits for the scan.
       - Every run still probes the fixed credential-file list and the fresh sentinels.
       - **Residual risk, accepted and documented:** an unlisted file with inheritance disabled, created inside a
         protected folder within the 24 h since the last full scan, is not caught until the next scan. Disabling
         inheritance needs a deliberate ACL operation, and the known credential files are probed every run.
       - Large-org variant: a per-lane OS account with no read access to the user's profile at all.
       - Test: such a file added after a scan is caught by the next full scan.
   - Quota: the Codex rows of the headroom table (Part 1).
   - The brief passes the secret scan.
2. **Resolve the binary.** Locate the global `@openai/codex` package (`<npm root -g>/@openai/codex`). Then resolve the
   platform package with `createRequire(<that package>/bin/codex.js).resolve('@openai/codex-win32-x64/package.json')`,
   as the launcher does. Resolving from `npm root -g` itself fails (`MODULE_NOT_FOUND`, verified by Astra), because
   the platform package is nested under `@openai/codex/node_modules`. A unit test covers that nested layout. Spawn it with an args array and no
   shell; the `.cmd` shim is not spawnable without a shell on Node ≥ 18.20. `-c windows.sandbox=elevated` is passed
   unquoted; a non-TOML value is taken literally. Keep the quoted form only if the smoke test rejects the bare one.
3. **Run Codex.**
   `codex -a never exec -m <slug> -C <cwd> -s <workspace-write|read-only> --ignore-user-config --ignore-rules
   -c windows.sandbox=elevated -c shell_environment_policy.set.TEMP=<cwd>\.codex-tmp
   -c shell_environment_policy.set.TMP=<cwd>\.codex-tmp -c model_reasoning_effort=<e>
   [-c sandbox_workspace_write.network_access=true] --disable plugins --disable apps --disable browser_use
   --disable in_app_browser --disable computer_use
   --output-schema <schemas/mode.json> -o <run-dir>/last.json --json -`
   - Write the brief to stdin, then call `stdin.end()`.
   - stdout goes to `<run-dir>/events.jsonl` and stderr to `<run-dir>/stderr.txt`.
   - `.codex-tmp` is created before the run and deleted after it.
   - Mode settings: `write` uses workspace-write; `review` and `diagnose` use read-only.
   - Default models: write → sol, review → sol, diagnose → astra.
   - Never pass `--ephemeral`: it writes no rollout, so no usage reading.
   - Timeout: `taskkill /T /F /PID <codex.exe pid>`. Then list survivors (`codex.exe`, `codex-command-runner.exe` and
     their children) as `orphans:[pid]` in the result and in stderr.
4. **Scope check and verification** (`write` mode). Status is decided here, not by Codex.
   - Scope: every path in `git status --porcelain --untracked-files=all`, tracked and untracked, ignoring
     `.codex-tmp/`, must match an owned glob. Otherwise the status is `blocked` (`out-of-scope: <paths>`) and no
     check runs.
   - Each `--check` runs **inside the sandbox**, with no model call:
     - The script writes it to `<cwd>\.codex-tmp\<run-id>\check-N.cmd`, so quotes and `&` survive.
     - It then runs `codex sandbox -P :workspace -C <cwd> -c windows.sandbox=elevated
       -c shell_environment_policy.set.TEMP=... -- C:\Windows\System32\cmd.exe /d /c <that file>`.
     - Network is off, with a 10-minute timeout per check. A timeout runs `taskkill /T /F` on the `codex sandbox` pid.
   - `--check-host "<cmd>"` is the explicit opt-in for checks that need Docker or the host. They run outside the
     sandbox, only after the scope check passes, and the result carries `host_checks:true`. Prefer reviewing before
     merging such work; the skill says so.
   - **Final scope check:** after all checks and process cleanup, rescan tracked and untracked changes against the
     baseline. Every path must still match an owned glob, because checks such as codegen or snapshot updates can
     write files. The result's `files`, the recorded diff hash and the review patch all come from this final state.
   - The status:
     - `done` = Codex exited 0, `last.json` is valid, both scope checks passed and every check exited 0.
     - `failed` = a check failed, or Codex errored.
     - `blocked` = guards, scope, timeout, missing tools, or Codex itself said blocked.
5. **Record usage.**
   - Find the rollout by globbing `${CODEX_HOME||~/.codex}/sessions/**/rollout-*-<thread_id>.jsonl` (today and
     yesterday, UTC) and take the last `token_count` `rate_limits`.
   - Write `~/.claude/state/coord/usage/codex-<run-id>.json` =
     `{ts, provider:"codex", pct, resets_at, week_pct, week_resets_at}`.
   - Window mapping: `window_minutes` 300 → `pct`/`resets_at`; 10080 → `week_pct`/`week_resets_at`; a missing window
     → `null`.
   - Keep the newest 20 codex files.
   - Also write `~/.claude/state/codex/last-usage.json` with the full `rate_limits` object, including
     `rate_limit_reached_type`. The quota guard (step 1) reads this file.
   - Freshness and selection follow Part 5, the single source.
   - A missing or unreadable rollout means usage `null`, with one stderr line; the status is unaffected.
   - The batch-B owner confirmed (2026-10-05) that the pacer and statusline select files by `provider` (absent =
     claude) with numeric `pct`. A weekly-only provider gets the weekly guard only.
6. **Ledger.** Append one line to `~/.claude/state/codex/runs.jsonl`: `{ts, run_id, task, mode, model, effort, status,
   checks_passed, host_checks, secs, codex_tokens:{in, cached, out}, files, week_pct}`. `--verdict` appends
   `{ts, run_id, verdict, note}`. Sonnet tasks are recorded with `--verdict sonnet:<task> ...`, with no run.
7. **Print the result.** This is the only thing Claude reads: one JSON object of at most 2,000 characters.

```json
{"run":"<id>","status":"done|failed|blocked","reason":null,"mode":"write","model":"gpt-6.1-sol",
 "model_downgraded":false,"secs":121,"files":["src/a.ts (+12 -3)"],
 "checks":[{"cmd":"npm test","exit":0,"tail":"<=300 chars"}],"host_checks":false,
 "codex_note":"<=300 chars from last.json","week_pct":4,"orphans":[]}
```

For `review` the result carries `findings` (at most 8, each `{sev, file, line, claim, scenario}`, ≤ 200 chars each).
For `diagnose` it carries `hypotheses` (at most 5, each `{claim, check}`). Both are truncated to fit.

Codex writes no commits. On `done`, the controller has the diff reviewed per the floors and then commits it. The
task's lane owns the commit.

### How a session uses it

1. Write the brief.
2. Run `node codex-run.mjs ...` via Bash with `run_in_background: true`, and keep working on other tasks. The
   completion notification brings the one JSON line.
3. Act on `status`:
   - `done` → review the diff and record the verdict.
   - `failed` → redo once with `--continue <run-id>` and the result attached (same model, effort one rung up), then
     Part 1 rule 4. Pre-commit review findings ("rework") are fixed the same way, with `--continue`.
   - `blocked` → fix the cause, or reroute.

`sizing-dispatches` gains one line: "If the `dispatching-codex` skill is installed, check it first: Codex-eligible
tasks go there." The Codex rows live in the optional skill, so the default install is unchanged.

## Part 3: Shared protocol file

Batch A made `~/.claude/AGENTS.md` (repo `claude/AGENTS.md`) the provider-neutral protocol on 2026-10-05. Its marked
`## Worker rules` section is self-contained and meant to be handed to workers alone.

- **Briefs quote that section verbatim.** `codex-run.mjs` extracts `## Worker rules`, up to the next `## ` heading,
  from `~/.claude/AGENTS.md` at run time and puts it in the brief's Worker rules block, so there is one source. The
  template's own fixed block is only a fallback, used if the section cannot be found; the result then notes
  `worker-rules: fallback`.
- `~/.codex/AGENTS.md` is loaded by every Codex run, even with `--ignore-user-config`. Batch A's README tells users
  to copy the protocol there. To keep controller rules (dispatch, goal gate, handoffs) from steering a Codex worker,
  batch A adds this line at the very top of `claude/AGENTS.md` (agreed by `cw-batchA-impl2` on 2026-10-05):
  "If you were dispatched as a worker (a subagent, or a Codex run given a task brief), follow only `## Worker rules`
  and the brief; ignore the rest of this file."
- The brief template repeats that sentence.
- Plan check: the line is live before the profile is deployed.

## Part 4: Codex tool profile (browser and tools)

The user wants Codex to cover the full range of tasks, including browser tests, while staying sandboxed.

| Tool | For Codex | How |
|---|---|---|
| Shell, file edits, code search (`rg`) | yes | built in, sandboxed |
| All test runners (Python, node, uv, Rust, .NET, Playwright test) | yes | sandboxed, via the toolchain ACL grant |
| **Browser tests and in-browser tasks** | yes, **primary path** | Codex writes and runs Playwright scripts/tests (`@playwright/test` or a `node` script with `chromium.launch({headless:true})`) **inside the sandbox**, against the app it starts on localhost. Nothing runs outside the sandbox. |
| Browser MCPs (Playwright, Chrome DevTools) | **not in this release** (Astra review) | Their origin filters do not stop redirects and are not a security boundary, and MCP servers run outside the sandbox. `codex-run.mjs` has no `--browser` flag and never passes `mcp_servers`. A future design ships them only behind an OS-enforced filesystem and network boundary, with redirect and file-tool tests. The user's own entries in `~/.codex/config.toml` (Playwright `--extension`, chrome-devtools, brave-devtools) are for interactive Codex use only. Unattended runs ignore that config. |
| Web search | opt-in, `--network` | Codex's built-in search |
| Codex's own "browser" plugin, "computer use", "chrome" plugin | no | They need the desktop app, control the real desktop, or use the user's real logged-in Chrome. Disabled per run: `--disable plugins --disable apps --disable browser_use --disable in_app_browser --disable computer_use`. |
| repomix, claude-in-chrome, Docker, git push, `~/.claude` | no | Unsandboxed file access, the user's real browser, host-equivalent access, a public action, or Claude's control plane. Docker-based checks still count via `--check-host`. |

Plan probes (before deploy):

1a. Loopback inside `codex sandbox` with network off: can a process bind a localhost port and another connect to it?
1b. Does a headless Chromium launch (from `%LOCALAPPDATA%\ms-playwright`) work inside the sandbox?
Gates:
- If 1a fails, browser app tests go to sonnet, or run against a host-started server via `--check-host`.
- If 1b fails, browser tasks go to sonnet until it is fixed. There is no MCP fallback before the deferred MCP work.
- The `--browser` flag is not built for 2026-10-09 (see the deferred row above and Out of scope).

## Part 5: Readers

- **Codex reader:** `codex-run.mjs` writes the usage file after every run (Part 2 step 5), at zero tokens.
  - **Selection.** Before each run, the quota guard takes the **latest-timestamped valid `rate_limits` event** across all
    rollouts modified in the last 8 days under `${CODEX_HOME}/sessions`, not only its own runs, because interactive
    Codex use spends the same allowance. It scans tail-first, so this is cheap. A rollout without quota events is
    skipped. The previous valid reading (`last-usage.json`) is kept when nothing newer is valid.
  - It adds 2 points per run currently holding a machine lock.
  - **Freshness, the single rule:**
    - after a window's `resets_at`, that window counts as 0% used;
    - before it, a reading older than 6 h adds a `codex-quota-stale` note to the result (the run proceeds; the
      controller prefers Luna);
    - a null `resets_at`, or no valid reading at all, means "unknown": the run proceeds, with the note.
- **Both providers short of headroom** (Codex `blocked` on quota and Claude pace `hold` or `exhausted`): the controller
  does not fall back. It parks the task in the handoff/ledger and resumes it after the earlier `resets_at`.
  Exhaustion avoidance is best effort: neither provider exposes a live remaining-quota API.
- **Claude reader:** batch B's `coord.mjs statusline` and pacer, not built here. The controller reads only batch B's
  `~/.claude/state/coord/pace.json` `{provider: {state, pct, ahead, resets_at, week_pct}}`. When it is absent, the
  default routing applies.
- **One view for the user:** `node codex-run.mjs --status` prints one line from the same files, at zero tokens, e.g.
  `codex week 12% (resets Sat 14:46) · claude 5h 42% week 31%`.
- **Fable availability:** Anthropic exposes no per-model reading. Mechanism: when a Fable dispatch returns a
  usage-limit error, Astra takes that review at once and for the rest of the session. Assumption, unverified: Fable
  may be capped at 50% of the weekly limit. As a soft proxy, at batch B `week_pct` ≥ 60 the controller keeps Fable for
  correctness-critical code only.

## Part 6: Quality gate and tracking

- The review floors are unchanged (Opus for non-mechanical work, Fable for correctness-critical work) and apply
  whoever wrote the code.
- The ledger records the writer (`codex-luna`, `codex-sol`, `sonnet`), the status and the review verdict per task.
  This is enough for the efficiency proof.
- Deferred to the tracking wave (owner: the tracking lane): a `--report` table, and the degradation rule (over the
  last 10 reviewed tasks, rework + reject above 30%, or 10 points above the other writer → reroute and tell the user).

## Part 7: Efficiency proof (the 2026-10-09 gate)

The plan names a fixed set of 4 tasks from this repo's real backlog before the first run: 1 mechanical, 2 routine
logic, 1 test-writing. Each is run twice on throwaway branches:

- **Before** (today's path): a sonnet `worker-*` subagent writes and Opus reviews.
- **After:** `codex-run.mjs` writes and Opus reviews.

Metric: **Claude tokens per task** = the sum over every Claude turn in the cycle (brief, dispatch, redo rounds, review,
rework) of input + cache_creation + output + 0.1 × cache_read, per model, from the transcript `usage` fields (the
session-report skill reads them). Report both raw and cost-weighted (API list prices per model) tables. The gate
passes on the **cost-weighted** figure: after ≤ 60% of before, with review verdicts equal or better. Also recorded:
wall time, verdicts and the Codex `week_pct` delta.

This run doubles as the dry run the user OKs before deploy. Later, the tracking wave's `metrics-snapshot.mjs` compares
whole-week Claude usage.

## Part 8: Packaging

- New folder `optional/codex/`, outside `claude/`, so the default installer glob skips it. It holds
  `optional/codex/skills/dispatching-codex/...` and `optional/codex/README.md`. The README covers:
  - requirements: a ChatGPT plan with Codex, `npm i -g @openai/codex@latest`, `codex login`, Windows elevated sandbox
    setup;
  - the one-time ACL grant for the toolchains;
  - the TEMP note;
  - the `~/.codex/AGENTS.md` warning;
  - the newest tested Codex version.
- `INSTALL_PROMPT.md` gets one step: "Ask me whether to install the optional Codex profile. If yes, copy
  `optional/codex/skills/*` to `CONFIG/skills/` and show me `optional/codex/README.md`'s setup steps."
- README: one row in the What's-inside table.
- The repo's `claude/skills/sizing-dispatches/SKILL.md` is stale relative to the live file (the writing = sonnet row
  and the Fable-effort row of 2026-10-05). The plan first syncs the repo from live, then adds the one Codex line.
- The public-repo secret scan gains the Part 2 brief patterns.
- No secrets, user paths or account names in the profile. Paths come from `os.homedir()`, `CODEX_HOME` and
  `npm root -g`.

## Part 9: Safety

- Codex and its checks always run sandboxed (`workspace-write` for writes, `read-only` otherwise), with `-a never`,
  `--ignore-rules`, in the task's own linked worktree.
  - Probes show it cannot write to the main checkout, sibling worktrees or the main `.git`.
  - TEMP is redirected into the worktree, so Claude's scratchpads under `%TEMP%` cannot be written.
- **Read boundary (Astra review, verified by probe 2026-10-05).** The sandbox restricts writes, not reads. With
  harmless canary files, a sandboxed `type` read `~/.codex/` (including `auth.json`), `~/.claude/`, `%TEMP%\claude\`
  and the main checkout. Only the bare profile root was denied. Shell network is off, but injected instructions could
  pull credentials into the model's context. Fix, OS-enforced:
  - A one-time **deny-read ACE** for `CodexSandboxUsers`, inheritable on folders (`(OI)(CI)(R)`), run by the user.
    `node codex-run.mjs --setup` prints the exact `icacls /deny` lines for this machine; the user runs them. A deny ACE
    overrides any allow. It covers:
    - `~/.claude` and `%TEMP%\claude` (folders);
    - the common credential stores, where present: `~/.ssh`, `~/.git-credentials`, `~/.config/gh`, `~/.docker`,
      `~/.aws`, `~/.azure`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`;
    - Codex's own login: the whole `${CODEX_HOME}` folder, inheritable, so a refreshed `auth.json` (Codex rewrites it
      on token refresh, also during a run) is born denied. **There is no file-only fallback.** A file ACE is lost on
      replacement mid-run. The first plan task is a probe that applies the folder deny (user-run) and confirms that
      sandboxed `exec` and `codex sandbox` runs still work, with a forced token refresh during an active run. If
      Codex cannot run with `${CODEX_HOME}` denied, or Codex 0.160's native readable-root restriction cannot replace
      it, **deploy is blocked** and the user is told. Unsandboxed or unprotected operation is never the fallback.
    The Codex parent process runs as the user, so its login still works.
  - **Verification uses the real targets** (Part 2 step 1, the read-boundary check), every run. Deploy is blocked
    until every target reads as denied.
  - Reading the main checkout and sibling worktrees stays allowed. It is the same repo's code, and Codex needs to
    read shared history. Large-org variant: per-lane OS accounts.
  - A plan probe checks whether Codex 0.160's permission profiles (`[permissions]`, `--sandbox-state-readable-root`)
    can restrict readable roots natively. If so, it replaces the ACEs (the canaries stay).
- The only unsandboxed execution is opt-in and visible in the result: `--check-host` (Docker or host checks). One
  sequence applies everywhere: initial scope check → sandbox checks and host checks → process cleanup → final scope
  check → patch, hash and result capture. No check runs after the final scan. The browser MCPs are deferred (Part 4).
- Network is off by default. `--network` is for package installs or web search only.
- Codex does no git network (it fails in the sandbox anyway). Claude commits and pushes.
- Test data uses fake addresses only (`...@example.com`), per the worker rules.
- The one-time ACL grant (user-run) gives `CodexSandboxUsers` read/execute on the per-user toolchain folders only.
  Docker is not granted. Codex's own setup left a `CodexSandboxUsers:(M)` ACE on `%LOCALAPPDATA%\Temp`. The TEMP
  redirect makes it unused. The README tells the user it exists and how to remove it.
- Large-org variant: checks in disposable containers, a separate OS account per lane.

## Testing

- `codex-run.mjs` unit tests (node:test) with a fake `codex.exe` stand-in: a node script, injected as command plus args
  (`CODEX_RUN_BIN`, `CODEX_RUN_BIN_ARGS`), because a script cannot be spawned with no shell. The tests also run a
  check containing quotes and `&`. The fake writes canned events, a rollout named with the thread id, and `last.json`. The tests cover:
  - guards: main checkout, dirty tree, untracked file, other lane's worktree, lock limit and stale lock, secret scan,
    old version, quota;
  - the status decision: Codex says done but a check fails → `failed`; a new untracked file outside owned globs →
    `blocked`, no checks run;
  - window mapping (weekly-only, both windows, none, missing rollout);
  - the usage file has `provider:"codex"` and the `codex-` prefix;
  - a result of at most 2,000 characters;
  - ledger and verdict lines, `--status`;
  - timeout kills the tree: a fake that sleeps, `--timeout-min` with a test override, and no orphan left.
- Live smoke tests, all in a real **linked worktree**, sonnet-run:
  - `write` with Luna;
  - `review`;
  - a check via `codex sandbox`;
  - the TEMP-denied check;
  - the read-denial canaries, after the user's deny-read step, for both `codex exec` (Codex's own shell) and
    `codex sandbox` checks;
  - two runs on one worktree: the second is `blocked`;
  - `--continue` after a failed run, and a pre-commit `--review-of` that sees the full diff, untracked files
    included;
  - `git status` inside the sandbox;
  - a server started inside a check does not outlive it;
  - the new-version gate;
  - browser probes 1a and 1b.
- The efficiency proof (Part 7).

## Deploy notes

Order:
1. Tests green.
2. Fable review of the code (`worker-high`).
3. Live smoke tests.
4. Efficiency proof (dry run) shown to the user.
5. User OK.
6. Copy the skill to `~/.claude/skills/dispatching-codex/` and add the one sizing line.
7. Push the repo after the secret scan.

No settings, hooks or running lanes change. Rollback: delete the skill folder and the sizing line.

## Token accounting

| Item | Claude tokens |
|---|---|
| A Codex dispatch | the brief (~0.5-1.5k) + one result line (≤ ~0.6k) + review as before |
| The same task by a sonnet subagent today | subagent start-up and work: typically 15-60k |
| Readers, ledger, status | 0 (scripts) |
| Skill load | ~2k once per session that dispatches Codex |

## Large-org variant

Separate service accounts per provider, checks in disposable containers, a central usage dashboard, and per-team quotas
instead of a per-machine lock.

## Out of scope

- The Claude usage reader and pacer (batch B).
- Codex cloud tasks (`codex cloud exec`): about 5x the local cost, and the local machine is not the bottleneck.
- Codex's own multi-agent mode: one Codex run per task keeps ownership simple.
- Wiring `~/.codex/AGENTS.md`.
- Browser MCPs for unattended runs (`--browser`): they need an OS-enforced filesystem and network boundary and redirect
  tests first (Astra review). Owner: the next Codex-profile wave. Sandboxed Playwright scripting covers browser tests
  until then.
- The `--report` table and the degradation rule (tracking wave).
