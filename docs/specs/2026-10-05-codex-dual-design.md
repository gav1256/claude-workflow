# Codex dual-brain profile: Claude and OpenAI Codex as two developers on one project: design

Status: draft for the Fable spec review (2026-10-05). Not yet approved by the user.

## Goal

The user is moving from Claude Max $200 to Claude Max $100 + ChatGPT Pro $100 ("Pro Lite") at the next renewal. By
**2026-10-09** the workflow must:

- produce the same or better code (cleaner, reviewed the same way or harder),
- spend **fewer Claude tokens per unit of work than today**, measured (see Efficiency proof),
- never hit a Claude 5-hour or weekly limit because of work Codex could have done, and never exhaust both providers,
- keep Claude ↔ Codex messages short: briefs and summaries are files and fixed-shape JSON, never transcripts.

The model: **two developers on one project.** Each task has exactly one owner. They work on disjoint files in separate
worktrees and meet at commits. Both work on the same problem only when the Claude reviewer (Fable) is stuck.

## User decisions (2026-10-05)

| Decision | Choice |
|---|---|
| Packaging | Optional `codex` profile in the public repo, off by default. The default install stays Claude-only. |
| Switch date | At the next renewal. Live and measurably cheaper by 2026-10-09. |
| Hand-off mechanism | Approach A: a script + skill (`codex exec` in the background). Rejected: Codex as an MCP server (tool schema in every context, call timeouts, unbounded results) and a Claude subagent wrapping Codex (15-30k Claude tokens per task cancel the saving). |
| Sandbox | Codex always runs in its Windows sandbox (`elevated`), with the user's Codex config ignored. Unsandboxed Codex was rejected (it could reach `~/.claude`, `~/.codex/auth.json`, other lanes, the network). |
| Tests | Codex must run every test it can. The user granted the sandbox group read/execute on the per-user toolchains (Python, Rust, npm, uv, .NET tools, Playwright). Docker stays outside the sandbox (Docker access is host-equivalent). |
| Roles | Fable = review and advisor only. Astra = Fable's backup when Fable's weekly share runs low or a second opinion is needed. All code writing leaves Claude-Opus/Fable (the 2026-10-05 "writing = sonnet" rule; Codex is now a second writer). |

## Verified facts (probes 2026-10-05; details in `machine-notes.md` on the user's machine)

| Fact | Evidence |
|---|---|
| Codex CLI 0.160.0 from npm `@openai/codex`, on PATH, ships its own `codex-windows-sandbox-setup.exe`. Older copies (desktop app 0.140, `~/.codex/.sandbox-bin` 0.142) cannot use the GPT-6 models. | `npm install -g @openai/codex@0.160.0`; `codex --version` |
| Working command: `codex -a never exec -m <slug> -C <dir> -s workspace-write --ignore-user-config -c 'windows.sandbox="elevated"' -c 'model_reasoning_effort="<e>"' --output-schema <schema> -o <out> -` with the brief on stdin. | Luna probe fixed `add.py` + `add.js`, exit 0, 121 s |
| Without `-c windows.sandbox="elevated"`, `--ignore-user-config` silently downgrades `workspace-write` to read-only. | probe 2: rollout `sandbox_policy: read-only` |
| A prompt given as an argument with a non-TTY stdin makes `codex exec` wait on stdin (hang). | probe 1 |
| `-a` must come before `exec`. | `codex exec -a never` → "unexpected argument" |
| `--output-schema` (strict JSON Schema, `additionalProperties:false`) is honoured. | probes 2-4 |
| `--json` events: `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed` (with `usage`), `error`, `turn.failed`. No rate limits in that stream. | probe events |
| Rate limits appear only in the rollout `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, in `token_count` events: `rate_limits.primary/secondary {used_percent, window_minutes, resets_at}`, `plan_type`. On Pro Lite `primary` is the 10080-minute weekly window and `secondary` is null: **no 5-hour window**. | rollout of probe 4 |
| Codex's own fixed overhead is about 35-105k input tokens per run (mostly cached). It is billed to the ChatGPT plan, not Claude. A Luna fix run showed 0% of the weekly window used. | `turn.completed.usage`, rollout |
| Codex reported `status: "done"` although the Python test never ran. Codex's self-report is not proof. | probe 4 `last.json` |
| The sandbox user sees Program Files tools (node, git) but not per-user installs until the ACL grant. | probes 3-4 |
| git HTTPS push/fetch fails inside the native sandbox. | OpenAI issue #31073 |
| Models (OpenAI docs, read 2026-10-05): `gpt-6-luna` (about 1/20 of Sol's credit cost), `gpt-6.1-sol` (CLI default), `gpt-6-astra` (about 5x Sol). `gpt-5.5` leaves Codex on 2026-10-14. | research report |
| Benchmarks: Opus 5.5 leads every coding benchmark both vendors report (independent Terminal-Bench 4.0: Opus 59.6, Sol 43.9). Astra roughly ties Fable 5.1 at about 1/3 the output tokens. Mostly vendor-reported. | research report |

## Part 1: Roles and routing

### Who owns what

| Work | Owner | Model / effort | Why |
|---|---|---|---|
| Design talk with the user, rulings, orchestration | Main session (Opus) | as today | Unchanged |
| Writing specs and plans | Opus subagent or main | `worker-high` opus | User: Fable only reviews |
| Spec, plan and correctness-critical code review; advisor | **Fable** | `worker-xhigh` fable | Best reviews (fewest generic findings) |
| Same, when Fable is unavailable (see Part 4) or a second opinion is wanted | **Codex Astra**, read-only | `review` mode, effort high | Ties Fable on independent indices, separate quota |
| Root-cause debugging, first attempt | Opus | `worker-high` opus | Leads the coding benchmarks |
| Routine implementation, tests, refactors, suite runs | **Codex Sol** | `write` mode, effort medium (high for real logic) | Separate quota with no 5-hour window |
| Mechanical edits, boilerplate, renames, tests from a given spec, doc/i18n churn | **Codex Luna** | `write` mode, effort low-medium | About 1/20 of Sol's cost |
| Hard implementation (concurrency, security, migrations, auth, math) | Opus designs the exact behaviour and tests; **Codex Sol (high)** writes; Fable reviews | | Thinking stays on Claude, typing moves off it |
| Work that needs Docker, git network, Claude-only tools (MCP, browser, Agent), or `~/.claude` | Sonnet | `worker-*` sonnet per the sizing table | Cannot run inside the sandbox |
| Ordinary review (non-mechanical, single task or multi-file section) | Opus | `worker-high` opus | Unchanged: the reviewer is never the writer's family alone |
| Second opinion on correctness-critical diffs | Codex Sol `review` mode, read-only, in parallel with Fable | | A different model family finds different bugs |

Rules:

1. **The writer is never the only reviewer family.** Codex-written code is reviewed by Claude (opus/fable). Sonnet
   code on correctness-critical slices also gets a Codex `review`. The review floors from `sizing-dispatches` apply
   whoever wrote the code.
2. **One owner per task, disjoint files.** The plan assigns every task an owner and a file set. Codex and Claude
   never edit the same file in the same wave. A task that builds on another's output names the commit it builds on.
3. **Both brains on one problem only when stuck**: Fable (or the Opus debugger) failed twice on the same issue →
   one Astra `diagnose` run (read-only) that gets the problem, the failed attempts and the ruled-out hypotheses, and
   returns ranked hypotheses with a check for each. Claude decides; a writer applies the fix.
4. **Codex failed twice on a task → sonnet** (`worker-high`) with Codex's two summaries. Sonnet failed twice → the
   existing escalation ladder.

### Routing by headroom

Codex Pro Lite has no 5-hour window, so Codex is the elastic buffer for Claude's 5-hour window:

| Signal | Action |
|---|---|
| Default | Every Codex-eligible task goes to Codex (the table above). |
| Claude pace `slow` or `hold` (batch B `pace.json`) | Also send borderline tasks to Codex (sonnet-default tasks that do not need Docker/MCP/git network). |
| Codex `week_pct` ≥ 85 | Luna only for new Codex work; Sol/Astra only for review. |
| Codex `week_pct` ≥ 95 or `rate_limit_reached_type` set | Codex off: its tasks go to sonnet until `resets_at`. |
| Fable weekly share high (see Part 4) | Fable reviews only correctness-critical slices; Astra takes plan/spec reviews and second opinions. |

Before batch B ships `pace.json`, the Claude side has no live reading. The router then uses the default row only,
which already moves most writing off Claude. That is enough for 2026-10-09.

## Part 2: `dispatching-codex` skill and `codex-run.mjs`

Lives in the optional profile: `optional/codex/skills/dispatching-codex/{SKILL.md, codex-run.mjs, schemas/,
templates/brief.md, tests/}`.

### Brief (Claude → Codex): one file, at most about 60 lines

Written by the controller to `<worktree>/.codex-briefs/<task-id>.md` (git-ignored via `.git/info/exclude`, never
committed):

```
# Task <id>: <one line>
Goal: <2-4 lines: the behaviour wanted, not how>
Files you own: <paths/globs>. Do not edit anything else.
Read first: <path:line anchors, at most 10>
Builds on: <commit sha or "none">
Done when: <the check commands, one per line>
Constraints: <only the ones that matter: style, no new deps, fake data ...@example.com>
Worker rules: (fixed block from templates/brief.md, about 10 lines: stay in the owned files; no git commit/push;
  no network unless granted; write tests first when the task adds behaviour; keep the diff minimal; report honestly:
  a check you could not run is "blocked", not "done")
```

No secrets ever go in a brief. `codex-run.mjs` refuses a brief that matches the secret-scan patterns
(`sk-`, `sk-ant`, `gho_`, `ghp_`, `AKIA`, `-----BEGIN`, `auth.json`) and exits `blocked`.

Context sharing rule: Codex reads code itself (free to Claude). The brief carries anchors, not code. Claude reads only
the result JSON and, when reviewing, the diff. Never Codex's events, rollout or reasoning.

### `codex-run.mjs` (Node 18+, no dependencies)

```
node codex-run.mjs --brief <file> --cwd <worktree> --mode write|review|diagnose
                   [--model luna|sol|astra] [--effort low|medium|high|xhigh] [--base <ref>]
                   [--check "<cmd>"]... [--network] [--timeout-min 30] [--task <id>]
```

Steps:

1. **Guards** (exit `blocked` with one reason line):
   - `--cwd` is a linked git worktree (`git rev-parse --git-dir` ≠ `--git-common-dir`), never the main checkout.
   - When the handoff-launch lane registry exists, `--cwd` belongs to the calling session's own lane.
   - `write` mode: the worktree is clean (no uncommitted changes), so the diff is Codex's alone.
   - At most 3 Codex runs at once machine-wide (lock files under `~/.claude/state/codex/running/`; a stale lock older
     than its timeout is removed).
   - The brief passes the secret scan.
2. **Resolve the binary**: `codex` on PATH with version ≥ 0.159.1, else exit `blocked` ("update: npm install -g
   @openai/codex@latest").
3. **Run**: `codex -a never exec -m <slug> -C <cwd> -s <workspace-write|read-only> --ignore-user-config
   -c windows.sandbox="elevated" -c model_reasoning_effort=<e> [-c sandbox_workspace_write.network_access=true]
   --output-schema <schema for mode> -o <run-dir>/last.json --json -` with the brief on stdin, stdout to
   `<run-dir>/events.jsonl`, stderr to `<run-dir>/stderr.txt`, killed at `--timeout-min`. `write` uses
   workspace-write; `review` and `diagnose` use read-only. Model defaults: write → sol, review → sol, diagnose → astra.
   `<run-dir>` = `~/.claude/state/codex/runs/<run-id>/`.
4. **Verify independently** (`write` mode): the script itself runs every `--check` command in `--cwd`, outside the
   sandbox, as the user, with a 10-minute timeout each. Status is decided here, not by Codex:
   - `done` = Codex exited 0, `last.json` is valid, every check exited 0, and the diff touches only owned files
     (when the brief lists them).
   - `failed` = a check failed or Codex errored. `blocked` = guards, timeout, missing tools, or Codex said blocked.
   - Running checks outside the sandbox is also what lets Docker-based and per-user-tool tests count.
5. **Record usage**: read the newest `token_count.rate_limits` in this run's rollout (found via `thread_id` from the
   events) and write `~/.claude/state/coord/usage/codex-<run-id>.json` in batch B's shape:
   `{ts, provider:"codex", pct, resets_at, week_pct, week_resets_at}`. Window mapping: `window_minutes` 300 → `pct`/
   `resets_at`; 10080 → `week_pct`/`week_resets_at`; a missing window → `null`. Keep only the newest 20 codex files.
6. **Ledger**: append one line to `~/.claude/state/codex/runs.jsonl`: `{ts, run_id, task, mode, model, effort,
   status, checks_passed, secs, codex_tokens:{in, cached, out}, files, week_pct}`.
7. **Print the result** (the only thing Claude reads), one JSON object, at most 2,000 characters:

```json
{"run":"<id>","status":"done|failed|blocked","mode":"write","model":"gpt-6.1-sol","secs":121,
 "files":["src/a.ts (+12 -3)"],"checks":[{"cmd":"npm test","exit":0,"tail":"<=300 chars"}],
 "codex_note":"<=300 chars from last.json open_issues/summary","week_pct":4,
 "review":null}
```

For `review`/`diagnose` the result carries `findings` (at most 8, each `{sev, file, line, claim, scenario}`, ≤ 200
chars each) or `hypotheses` (at most 5, each `{claim, check}`), truncated to fit 2,000 characters.

Codex writes no commits. On `done`, the controller has the diff reviewed per the review floors and then commits it
(owner = the task's lane).

### How a session uses it

The skill tells the controller (or any subagent) to:

1. Write the brief.
2. Run `node codex-run.mjs ...` via Bash with `run_in_background: true`, then keep working on other tasks. The
   completion notification brings the one JSON line.
3. Act on `status`: `done` → review the diff (opus/fable per floors), record the verdict; `failed` → redo once with
   the result attached (same model, effort one rung up), then Part 1 rule 4; `blocked` → fix the cause or reroute.
4. Record the review verdict: `node codex-run.mjs --verdict <run-id> approve|rework|reject "<one line>"` (appends to
   the ledger).

`sizing-dispatches` gains one line: "If the `dispatching-codex` skill is installed, check it first: Codex-eligible
tasks go there." The Codex rows live in the optional skill so the default install is unchanged.

## Part 3: Shared protocol file

Batch A moves the workflow protocol to `claude/AGENTS.md` (provider-neutral), with `CLAUDE.md` importing it. Codex
runs here use `--ignore-user-config`, but Codex still reads `AGENTS.md` files from the project tree. The controller
rules (dispatch, goal gate, handoffs) must not steer a Codex worker. Decision: Codex workers get their rules from the
brief's fixed **Worker rules** block only; the profile does not wire `~/.codex/AGENTS.md`. When batch A's AGENTS.md
grows a marked worker-rules section, the brief template quotes it instead (one source). Coordinated with
`cw-batchA-impl2` on 2026-10-05.

## Part 4: Readers

- **Codex reader**: `codex-run.mjs` writes the usage file after every run (Part 2 step 5). Zero tokens. Freshness: a
  reading older than 24 h, or with `resets_at` in the past, counts as "unknown, assume normal" for routing.
- **Claude reader**: batch B's `coord.mjs statusline` + pacer (not built here). The router reads only batch B's
  `~/.claude/state/coord/pace.json` `{provider: {state, pct, ahead, resets_at, week_pct}}`. Absent → default routing.
- **One view for the user**: `node codex-run.mjs --status` prints one line, e.g.
  `codex week 12% (resets Sat 14:46) · claude 5h 42% week 31% · fable n/a`, from the same files. Zero tokens.
- **Fable share**: Anthropic does not expose a per-model reading. Until it does, the proxy is the weekly
  `week_pct` from batch B: at ≥ 60% Fable reviews only correctness-critical slices and Astra takes the rest
  (the Fable cap is 50% of the weekly limit). If Fable returns a usage-limit error, Astra takes the review at once.

## Part 5: Quality gate and tracking

- Review floors unchanged (opus for non-mechanical, fable for correctness-critical), applied regardless of writer.
- The ledger tracks per writer (`codex-luna`, `codex-sol`, `sonnet`): tasks, first-pass `done` rate, review verdicts
  (`approve`/`rework`/`reject`), redo count. `node codex-run.mjs --report` prints a 10-line table.
  Sonnet tasks are recorded by the controller with `--verdict` too (writer `sonnet`, no run).
- Degradation rule: over the last 10 reviewed tasks of a writer, rework + reject > 30%, or 10 points above the other
  writer → the skill tells the controller to route that writer's class to the other writer and tell the user.

## Part 6: Efficiency proof (the 2026-10-09 gate)

A fixed set of 4 tasks from this repo's real backlog (picked in the plan: 1 mechanical, 2 routine logic, 1 test-writing),
run twice on throwaway branches:

- **Before**: today's path: a sonnet `worker-*` subagent writes, opus reviews. Claude tokens = the subagent's
  reported `subagent_tokens` + the reviewer's + the controller's brief and reading.
- **After**: `codex-run.mjs` writes, opus reviews. Claude tokens = the controller's brief + result line (counted from
  the transcript) + the reviewer's.
- Also recorded: wall time, review verdicts, Codex `week_pct` delta.

Pass = after ≤ 60% of before in Claude tokens, with equal or better review verdicts. This doubles as the dry run the
user OKs before deploy. Later, the tracking wave's `metrics-snapshot.mjs` compares whole-week Claude usage.

## Part 7: Packaging

- New folder `optional/codex/` (not under `claude/`, so the default installer glob skips it):
  `optional/codex/skills/dispatching-codex/...` and `optional/codex/README.md` (requirements: ChatGPT plan with
  Codex, `npm i -g @openai/codex@latest`, `codex login`, the one-time ACL grant, Windows elevated sandbox setup).
- `INSTALL_PROMPT.md` gets one step: "Ask me whether to install the optional Codex profile. If yes, copy
  `optional/codex/skills/*` to `CONFIG/skills/` and show me `optional/codex/README.md`'s setup steps."
- README: one row in the What's-inside table.
- The repo's `claude/skills/sizing-dispatches/SKILL.md` is stale relative to the live file (the 2026-10-05
  writing = sonnet row). The plan syncs the repo from live first, then adds the one Codex line.
- The public-repo secret scan gains `sk-`, `ghp_`, `AKIA` and `auth.json` patterns.
- No secrets, no user paths, no account names in the profile; paths come from `os.homedir()`.

## Part 8: Safety

- Codex always runs sandboxed (`workspace-write` for writes, `read-only` otherwise), with `-a never`, in the task's
  own linked worktree. Never the main checkout, never another lane's worktree, never `~/.claude` or `~/.codex`.
- Network off by default; `--network` only when the brief needs package installs.
- No git network from Codex (it fails in the sandbox anyway); Claude commits and pushes.
- Checks run outside the sandbox execute code Codex wrote. This is the same trust as running tests on any reviewed
  diff, but it happens before review. Mitigation: the brief's owned-files rule plus the diff-scope check in step 4
  (an edit outside owned files → `blocked`, checks not run). Large-org variant: run checks in a disposable container.
- Test data: fake addresses only (`...@example.com`), in the worker rules.
- One-time ACL grant (user-run): `CodexSandboxUsers` gets read/execute on per-user toolchain folders only. Docker is
  not granted.

## Testing

- `codex-run.mjs` unit tests (node:test) with a fake `codex` executable on PATH that writes canned events, a rollout
  and `last.json`: guards (main checkout, dirty tree, lock limit, secret scan, old version), status decision (Codex
  says done but a check fails → `failed`; edit outside owned files → `blocked`), window mapping (weekly-only, both,
  none), result length ≤ 2,000 chars, ledger and verdict lines, `--status`, `--report`.
- One live smoke test per mode (write with Luna on a throwaway repo, review, diagnose), sonnet-run.
- The efficiency proof (Part 6).

## Deploy notes

Order: tests green → Fable review of the code → efficiency proof (dry run) shown to the user → user OK → copy the skill
to `~/.claude/skills/dispatching-codex/` and the one sizing line → push the repo after the secret scan. No settings,
hooks or running lanes change. Rollback: delete the skill folder and the sizing line.

## Token accounting

| Item | Claude tokens |
|---|---|
| A Codex dispatch | the brief (~0.5-1.5k) + one result line (≤ ~0.6k) + review as before |
| The same task by a sonnet subagent today | subagent start-up and work: typically 15-60k |
| Readers, ledger, status | 0 (scripts) |
| Skill load | ~2k once per session that dispatches Codex |

## Large-org variant

Separate service accounts per provider, checks in disposable containers, a central usage dashboard, and per-team
quotas instead of a per-machine lock.

## Out of scope

- The Claude usage reader and pacer (batch B).
- Codex cloud tasks (`codex cloud exec`): about 5x the local cost, and the local machine is not the bottleneck.
- Codex's own multi-agent mode: one Codex run per task keeps ownership simple.
- Wiring `~/.codex/AGENTS.md`.
