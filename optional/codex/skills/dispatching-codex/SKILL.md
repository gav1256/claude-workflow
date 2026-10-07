---
name: dispatching-codex
description: Use when about to dispatch an implementation, test-writing, browser-test, second-opinion review, stuck-debugging or web-research task, before sizing it for a Claude worker. Routes Codex-eligible work to codex-run.mjs and says how to brief, run, read and verify it.
---

# Dispatching Codex

Codex (sandboxed `codex exec`, driven by `codex-run.mjs`) writes and checks code at no cost to Claude's window. Check this
skill BEFORE `sizing-dispatches`; whatever is not Codex-eligible falls through to that table.
`CR` below = `node <this skill dir>/codex-run.mjs`.

## Routing by task class

| Task | Owner | Mode, model |
|---|---|---|
| Routine implementation, tests, refactors, suite runs | Codex Sol | `write`, `--effort medium` (`high` for real logic) |
| Mechanical edits, renames, boilerplate, tests from a given spec, doc/i18n churn | Codex Luna | `write`, effort low or medium |
| Hard code (concurrency, security, migrations, auth, math) | Opus designs behaviour and tests, Codex Sol high writes, Fable reviews | `write` |
| Browser tests / in-browser tasks on the project's app | Codex | `write`, Sol or Luna: Playwright run inside the sandbox on localhost. If the plan's P3 probe failed (no loopback or no headless Chromium), sonnet instead. No browser MCPs, no `--browser` flag. |
| Needs Docker, git network, the user's real Chrome, MCP/Agent tools or `~/.claude` | Sonnet | sizing table (Docker checks may run via `--check-host`) |
| Second opinion on a correctness-critical diff | Codex Sol, read-only, parallel with Fable | `review` |
| Spec/plan review when Fable is unavailable (usage-limit error) | Codex Astra, for the rest of the session | `review` |
| Stuck: Fable or the Opus debugger failed twice | one Astra run with failed attempts and ruled-out hypotheses; Claude decides, a writer fixes | `diagnose` |
| Web research feeding a design (needs `--network`) | Codex Sol (Astra if hard); Opus judges the cited summary | `research` |
| Root-cause debugging first attempt, design, rulings, ordinary review | Claude (opus), not Codex | n/a |

Modes: `write` is live. `review`, `diagnose`, `research` are available when the script accepts the mode (schema present
in `schemas/`; otherwise it exits `blocked` `schema-missing: <mode>`, then use the Claude row).

Rules: one owner and disjoint files per task (Codex and Claude never edit the same file in one wave); a task that builds
on another names the commit. Codex-written code is never reviewed by Codex alone. Pace `slow`/`hold` in
`~/.claude/state/coord/pace.json` (read only when the file exists) widens Codex to borderline sonnet tasks without
Docker/MCP/git network. Codex short on quota and Claude `hold`/`exhausted`: park the task in the handoff, do not fall back.

## Fallback, silent

Never ask the user. `blocked` with a quota, host or sandbox reason, or any Codex failure: send the task to sonnet at once
per the sizing table (`worker-medium`/`worker-high`). Codex `failed` twice on one task: sonnet `worker-high` gets the
brief plus both result lines. Fix a plain `blocked` cause (bad flag, secret in brief, busy worktree) first if cheap.

## Brief: `templates/write.md`

Copy it, fill the fields, save it OUTSIDE the worktree (scratchpad), at most 80 lines (the script rejects more).
- Goal as behaviour, not method (2-4 lines); `Files you own`; at most 10 `path:line` read-first anchors; `Builds on`; one
  check command per line in `Done when`.
- Anchors, not code: Codex reads the repo itself, which costs Claude nothing. Never paste file bodies.
- No secrets or tokens (the script refuses `sk-`, `ghp_`, `AKIA`, `-----BEGIN`, `auth.json`); fake data uses `...@example.com`.
- Leave `{{WORKER_RULES}}` as the template has it; the script fills it.

## Run

1. Lane with its own worktree: `--cwd` must be a LINKED worktree (never the main checkout) that this lane owns. The lane
   may create one for Codex, so runs go in parallel; one run per worktree at a time (lock, `worktree-busy` otherwise).
2. From `Bash` with `run_in_background: true`:
   `CR --brief <file> --cwd <worktree> --mode write --model sol --effort medium --task <id> --check "<cmd>"`
   Each `--check` runs in the sandbox (no network); `--check-host "<cmd>"` runs on the host (Docker, network). Add
   `--network` only for research or when the task needs the web. `--timeout-min` defaults to 30. Keep working meanwhile.
3. Read ONLY the one JSON line on stdout (`run`, `status`, `reason`, `files`, `checks`, `model_downgraded`, `codex_note`,
   `week_pct`, `orphans`). Never read Codex's events, rollout or reasoning, and do not re-read its files to "see what
   it did" beyond the diff review below.
4. A `week_pct` near 85 downgrades Sol writes to Luna (`model_downgraded:true`); at 95 the run is `blocked`
   `codex-quota <resets_at>`.

## Status is the script's, not Codex's

Codex saying `done` is not proof (it once reported done with the test never run). Trust only the script's `status`:
`done` (scope, secret scan and your `--check`s passed), `failed`, `blocked`. `--check-host` results are not
sandbox-verified: review before merge.

## After `done`: review, then commit

Codex never commits. The lane reviews the diff (`git diff` plus untracked files in the worktree) per the
`sizing-dispatches` floors: mechanical work sonnet `worker-medium`, one non-mechanical task or multi-file section opus
`worker-high`, correctness-critical code Fable `worker-high` (plus a Codex `review` once that mode is live). Fix findings
with `--continue`, then commit. Record the outcome: `CR --verdict <run-id> approve|rework|reject "<one line>"`.

## Retry and recovery

- `failed`: redo once with `--continue <run-id>` (same model, effort one rung up, same brief plus the failure line).
  `--continue` needs the worktree to hold exactly that run's residue; otherwise it is `blocked`. A second failure: fallback
  above. "rework" review findings also go through `--continue`.
- `blocked` `worktree-quarantined` (a crashed run may have left sandbox processes): never delete locks by hand. Tell the
  user, and after they confirm run `CR --clear-quarantine <worktree|slot-N>` (lists candidates; `--yes` ends them, `--except
  <pid>,...` spares some). It never auto-kills.
- `CR --setup` prints the one-time ACL and deny-read lines; give them to the user, do not run them yourself.

## Status line

`CR --status` prints one zero-token line (Codex week %, reset time, Claude pace). Use it before a large batch and when
the user asks about Codex headroom. Until Task 16 lands it prints a stub (`codex-run status: not built`).
