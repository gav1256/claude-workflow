# Codex dual-brain profile: Claude and OpenAI Codex as two developers on one project: design

Status: Fable spec review 2026-10-05: APPROVE WITH AMENDMENTS. All amendments are applied here (H1-H3, M1-M6,
L1-L4), plus the user's same-day decisions on browsers, worktrees and Fable effort. Waiting for the user's approval.

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
| Codex `week_pct` ≥ 95, or `rate_limit_reached_type` non-null with `resets_at` in the future | `codex-run.mjs` | Exit `blocked`, reason `codex-quota <resets_at>`. The controller sends the task to sonnet. |
| Fable unavailable (Part 5) | controller | Astra takes plan, spec and second-opinion reviews. Fable keeps correctness-critical code. |

Before batch B ships `pace.json`, the Claude side has no live reading. Routing then uses the default row only, which
already moves most writing off Claude. That is enough for 2026-10-09.

## Part 2: `dispatching-codex` skill and `codex-run.mjs`

The skill lives in the optional profile: `optional/codex/skills/dispatching-codex/` with `SKILL.md`, `codex-run.mjs`,
`schemas/{write,review,diagnose}.json`, `templates/{write,review,diagnose}.md` and `tests/`.

### Brief (Claude → Codex): one file, at most about 60 lines

The controller writes it to `<run-dir>/brief.md` (`<run-dir>` = `~/.claude/state/codex/runs/<run-id>/`). Nothing is
written into the worktree. The template for each mode has these fields:

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

The `review` template adds `Review range: git diff <base>...HEAD` (from `--base`). The `diagnose` template adds
`Failed attempts:` and `Ruled out:`.

No secrets ever go in a brief. `codex-run.mjs` refuses a brief that matches any of these and exits `blocked`:
`\bsk-(ant-)?[A-Za-z0-9_-]{8,}`, `\bgh[pous]_[A-Za-z0-9]{20,}`, `\bAKIA[0-9A-Z]{16}\b`, `-----BEGIN`, `auth\.json`.

Context sharing rule: Codex reads the code itself, which costs Claude nothing. The brief carries anchors, not code.
Claude reads only the result JSON, plus the diff when reviewing. It never reads Codex's events, rollout or reasoning.

### `codex-run.mjs` (Node 18+, no dependencies)

```
node codex-run.mjs --brief <file> --cwd <worktree> --mode write|review|diagnose
                   [--model luna|sol|astra] [--effort low|medium|high|xhigh] [--base <ref>]
                   [--check "<cmd>"]... [--check-host "<cmd>"]... [--network] [--browser]
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
   - `write` mode: `git status --porcelain --untracked-files=all` is empty, so the change set is Codex's alone.
   - Concurrency, at most 3 runs machine-wide:
     - Create a lock `~/.claude/state/codex/running/<run-id>` with flag `wx`, body `{pid, expires_at}`, where
       `expires_at` = now + timeout + 10 min × number of checks.
     - Then count the locks. If there are more than 3, remove our own and exit `blocked`.
     - A lock is stale when `expires_at` has passed or its pid is not alive. Stale locks are removed before counting.
   - Version: native `codex.exe` reports ≥ 0.159.1. The README states the newest version tested.
   - Quota: the Codex rows of the headroom table (Part 1).
   - The brief passes the secret scan.
2. **Resolve the binary.** Use the native `codex.exe` from the global npm root, via
   `require.resolve('@openai/codex-win32-x64/package.json')` from `npm root -g`. Spawn it with an args array and no
   shell; the `.cmd` shim is not spawnable without a shell on Node ≥ 18.20. `-c windows.sandbox=elevated` is passed
   unquoted; a non-TOML value is taken literally. Keep the quoted form only if the smoke test rejects the bare one.
3. **Run Codex.**
   `codex -a never exec -m <slug> -C <cwd> -s <workspace-write|read-only> --ignore-user-config --ignore-rules
   -c windows.sandbox=elevated -c shell_environment_policy.set.TEMP=<cwd>\.codex-tmp
   -c shell_environment_policy.set.TMP=<cwd>\.codex-tmp -c model_reasoning_effort=<e>
   [-c sandbox_workspace_write.network_access=true] [browser flags, Part 4]
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
     `codex sandbox -P :workspace -C <cwd> -c windows.sandbox=elevated -c shell_environment_policy.set.TEMP=...
     -- C:\Windows\System32\cmd.exe /d /s /c "<cmd>"`, network off, 10-minute timeout each.
   - `--check-host "<cmd>"` is the explicit opt-in for checks that need Docker or the host. They run outside the
     sandbox, only after the scope check passes, and the result carries `host_checks:true`. Prefer reviewing before
     merging such work; the skill says so.
   - The status:
     - `done` = Codex exited 0, `last.json` is valid, the scope check passed and every check exited 0.
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
   - `failed` → redo once with the result attached (same model, effort one rung up), then Part 1 rule 4.
   - `blocked` → fix the cause, or reroute.

`sizing-dispatches` gains one line: "If the `dispatching-codex` skill is installed, check it first: Codex-eligible
tasks go there." The Codex rows live in the optional skill, so the default install is unchanged.

## Part 3: Shared protocol file

If batch A adds `claude/AGENTS.md` as the provider-neutral protocol (announced by `cw-batchA-impl2` on 2026-10-05; not
yet in a repo spec), its controller rules (dispatch, goal gate, handoffs) must not steer a Codex worker. Codex workers
therefore get their rules from the brief's fixed **Worker rules** block only, and this profile does not wire
`~/.codex/AGENTS.md`. Note that `--ignore-user-config` does not skip `~/.codex/AGENTS.md` (empty on this machine). The
README warns that filling it steers every Codex worker. When a marked worker-rules section exists in AGENTS.md, the
templates quote it instead, so there is one source.

## Part 4: Codex tool profile (browser and tools)

The user wants Codex to cover the full range of tasks, including browser tests, while staying sandboxed.

| Tool | For Codex | How |
|---|---|---|
| Shell, file edits, code search (`rg`) | yes | built in, sandboxed |
| All test runners (Python, node, uv, Rust, .NET, Playwright test) | yes | sandboxed, via the toolchain ACL grant |
| **Browser tests and in-browser tasks** | yes, **primary path** | Codex writes and runs Playwright scripts/tests (`@playwright/test` or a `node` script with `chromium.launch({headless:true})`) **inside the sandbox**, against the app it starts on localhost. Nothing runs outside the sandbox. |
| Browser MCPs: **Playwright** (page driving) and **Chrome DevTools** (console, network, performance traces) | opt-in, `--browser` | The user added both to `~/.codex/config.toml` on 2026-10-05, for interactive Codex use. Those entries attach to real browsers: Playwright `--extension` uses the user's real Chrome, `brave-devtools --autoConnect` attaches to the running Brave, and chrome-devtools opens a visible window. Unattended runs ignore that config. `codex-run.mjs` passes its own definitions via `-c mcp_servers.*`: `@playwright/mcp@<pinned> --headless --isolated --allowed-origins <localhost>` and `chrome-devtools-mcp@<pinned> --headless --isolated`, pre-installed (no `npx -y` download per run), `default_tools_approval_mode="auto"`, output dirs inside the worktree. They run **outside** the sandbox, so they are used only when sandboxed scripting cannot do the task. Brave and the extension modes are never used. |
| Web search | opt-in, `--network` | Codex's built-in search |
| Codex's own "browser" plugin, "computer use", "chrome" plugin | no | They need the desktop app, control the real desktop, or use the user's real logged-in Chrome. Disabled per run: `--disable plugins --disable apps --disable browser_use --disable in_app_browser --disable computer_use`. |
| repomix, claude-in-chrome, Docker, git push, `~/.claude` | no | Unsandboxed file access, the user's real browser, host-equivalent access, a public action, or Claude's control plane. Docker-based checks still count via `--check-host`. |

Plan probes (before deploy):

1. Does a headless Playwright launch work inside the sandbox (Chromium from `%LOCALAPPDATA%\ms-playwright`, a localhost
   server started in the same sandboxed command)? Is localhost reachable with network off?
2. Do `-c mcp_servers.*` overrides load under `--ignore-user-config`, and do MCP calls go through under `-a never`?
   Are the headless/isolated flags right for the pinned versions of both servers, and do they open no window?

If probe 1 fails, the browser row falls back to the MCP path, or to sonnet for that task class until it is fixed.

## Part 5: Readers

- **Codex reader:** `codex-run.mjs` writes the usage file after every run (Part 2 step 5), at zero tokens. A reading
  older than 24 h, or with `resets_at` in the past, counts as "unknown, assume normal" for routing.
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
  - TEMP is redirected into the worktree, so Claude's scratchpads under `%TEMP%` stay out of reach.
- The only unsandboxed execution is opt-in and visible in the result: `--check-host` (Docker or host checks, run after
  the scope check) and `--browser` (a pinned, isolated, headless browser MCP with a localhost allow-list).
- Network is off by default. `--network` is for package installs or web search only.
- Codex does no git network (it fails in the sandbox anyway). Claude commits and pushes.
- Test data uses fake addresses only (`...@example.com`), per the worker rules.
- The one-time ACL grant (user-run) gives `CodexSandboxUsers` read/execute on the per-user toolchain folders only.
  Docker is not granted. Codex's own setup left a `CodexSandboxUsers:(M)` ACE on `%LOCALAPPDATA%\Temp`. The TEMP
  redirect makes it unused. The README tells the user it exists and how to remove it.
- Large-org variant: checks in disposable containers, a separate OS account per lane.

## Testing

- `codex-run.mjs` unit tests (node:test) with a fake `codex.exe` stand-in (a node script) resolved through an injectable
  binary path. The fake writes canned events, a rollout named with the thread id, and `last.json`. The tests cover:
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
  - `git status` inside the sandbox;
  - browser probe 1 (and probe 2 if `--browser` ships by Oct 9).
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
- The `--report` table and the degradation rule (tracking wave).
