# Handoff: Luna coordinator (plan + sonnet implementation)

Written 2026-10-07 by the session "build coordinator". You are the new controller for this work.

## Repo state
- Repo: the CaludeWorkflow repo. You run in its worktree on branch `jev-coordinator`.
  - This branch is based on `stage2-loop-recovery` (= the code deployed in `~/.claude`). `main` is 105 commits
    behind, so never base on main.
- Commits on this branch:
  - `docs/specs/2026-10-07-model-coordinator-design.md`: the OLD DeepSeek/Claude-CLI design.
  - `docs/plans/2026-10-07-model-coordinator.md`: the OLD plan, reviewed twice by fable.
  - `docs/specs/2026-10-07-luna-coordinator-request.md`: **the user's current request, verbatim. It is the spec.**
- Peers: `cw-codex-dual` (busy) owns the Codex infrastructure (`optional/codex/skills/dispatching-codex/`, deployed
  at `~/.claude/skills/dispatching-codex/`). `cw-batchB` (busy) owns handoff-launch batch B. Before editing any
  file under those areas, `ListAgents` and agree ownership with that session by `SendMessage`. Queue work for them
  with `launch.mjs queue` rather than editing their files.

## What the user decided (this session)
- The coordinator is a cheap-model router. It never codes. It routes to running sessions or opens new ones, and it
  remembers sessions across its own restarts.
- "Restart the closed sessions" must reopen the sessions that closed unfinished (crashed, paused, window closed),
  not the finished ones. It asks yes/no first.
- It is launched by typing `coordinator` in any terminal, in any folder. It always uses its own fixed state folder.
  Only one instance runs; a second call reports the open one.
- The model is swappable later (no hard-coding). The user's latest request names OpenAI `gpt-6-luna`, used with a
  mock provider until the key is supplied.
- The coordinator may write only its own record file (`coordinator_records.md`), enforced in code.
- The user wants **sonnet to write all code** and wants **Codex used for design and implementation review**.

## Reusable from the old plan (verified by two fable reviews; adapt, do not copy blindly)
- **Task 1, env strip.** `PROVIDER_ENV` in `claude/skills/handoff-launch/live.mjs` `cleanEnv` (:591) and
  `windowScript` (:600). Children must never inherit provider keys. For Luna, also strip `OPENAI_API_KEY` from
  Claude and Codex workers unless a paid-API fallback is explicitly enabled.
- **Task 2, `status-lib.mjs`.** The lane classifier (open / unknown / finished / paused / closed_unfinished) and
  `coord.mjs status --json`. Classifier order matters. Every real close writes `{kill_intent, kind:"close"}`
  first, so a kill_intent never means finished on its own. `{closed}` with `pause:true` means paused. A why matching
  `/^claude exited/` or a `{dead_start}` line means closed_unfinished. Liveness `unknown` is its own state.
- **Task 3, `launch.mjs resume --closed`.** Place it before the generic resume branch (:576). Use the
  `e.model || "opus"` / `e.effort || "high"` fallbacks.
- Test helper facts:
  - `sb.run` / `coordRun` return `{code, out, err}`.
  - `launchLane(sb, group, name)` returns a path and needs a real group.
  - `sb.registry()` returns a plain array of lines: find ids with
    `.find(x => x.name === n && x.launched_at).id`.
- Launch facts:
  - `launch.mjs` takes the brief as a file (`--handoff`); `--model` and `--effort` are required.
  - New flags go in `KNOWN_FLAGS` (:98-101).
  - Use `claudeSpawn(args)` (live.mjs:118), not `claudeCli()`, to run claude.
- Hooks: the goal-gate (`claude/hooks/goal-gate.mjs:53`) and the `coord.mjs relay` path would nag or block a
  non-lane coordinator process. Give them an `HL_*` opt-out marker; `HL_*` is stripped from children automatically.
- Obsolete for Luna: the old Task 4 (Claude CLI + DeepSeek + permission-rule lock). Luna has **no tools**. It only
  returns a `CoordinatorDecision`; the dispatcher alone writes `coordinator_records.md`. That code-level lock is
  simpler and stronger than CLI permission rules. Keep the old plan's lessons:
  - Provider config and key live outside every writable path.
  - A key file must stay inside a secrets folder (an exfiltration guard).
  - Generated config is overwritten on every launch.
  - Keys are redacted from logs.

## Inputs you must read first
1. `docs/specs/2026-10-07-luna-coordinator-request.md` (the spec).
2. `t10-review-notes.md`, at `~/.claude/experiments/2026-10-02-parallel-sessions/codex-dual-gen2/t10-review-notes.md`.
   A scratchpad copy also exists under the codex-dual session's temp folder. Do only the OpenAI/Codex items the
   coordinator needs.
3. The Codex infrastructure: the `dispatching-codex` skill (`~/.claude/skills/dispatching-codex/SKILL.md`,
   `codex-run.mjs`, `lib/usage.mjs`, `lib/locks.mjs`, `lib/status.mjs`), and
   `docs/specs/2026-10-05-codex-dual-design.md`.
   - It already has worktree locks (one run per worktree), `week_pct` quota reading, Sol→Luna downgrade at 85 %,
     `blocked codex-quota` at 95 %, and `--status`.
   - The Codex resource manager must REUSE these, not duplicate them.
4. Session infrastructure: `~/.claude/skills/handoff-launch/SKILL.md`, `coordinator.md`, `live.mjs` (registry,
   liveness, sessionState, goalOf), and `recover.mjs`.

## What is next, in order
1. Ask the user nothing that the spec answers. Write `GOAL.md` from the spec's test list.
2. Survey: one `explorer` + opus run over the inputs above. It returns anchors only.
3. **Codex architecture review.** Run `codex-run.mjs` in `--mode review` (or `research`) on a short brief describing
   the intended integration: Codex sessions, subscription usage, concurrency, worktree isolation, fallback, and
   coexistence with Claude sessions. Codex is the authority on its own tooling. Check its claims against the code.
4. Write the plan (writing-plans skill) to `docs/plans/2026-10-07-luna-coordinator.md`. Tasks are small and TDD,
   with a mock provider first. Have **fable** (`worker-high`) review the plan, and fix Critical/Important findings.
5. Implement task by task (subagent-driven-development).
   - Implementers: **sonnet** `worker-medium`/`worker-high` (user directive: sonnet writes all code).
   - Reviewers: opus `worker-high` per task. Fable for correctness-critical parts: the dispatcher validation,
     the file-write lock, the Codex resource manager and the cost hard limit.
   - Add a Codex `review` run on Codex-specific diffs.
6. Run the spec's full test list against the mock provider, plus the existing handoff-launch and dispatching-codex
   suites. Check that existing Claude and Codex sessions still work.
7. Report to the user. The live OpenAI run waits for the user's key.

## Traps (prohibitions)
- Never base on `main`, and never switch the shared main checkout's branch. Work only in this worktree.
- Never build a second Codex integration. Never edit `cw-codex-dual`'s or `cw-batchB`'s files without agreeing
  ownership first.
- Never give Luna a tool, shell or file API. Never execute free-form model output. Validate every id and action.
- Never create paid OpenAI API spend by default. The fallback to a paid API worker is off unless configured.
- Never commit keys, personal paths or emails (public repo). Stage files by name; never `git add -A`.
- Tests open no visible windows and make no real API or Codex calls, except the explicit Codex review runs.
- Usage pacing has been running ahead of pace. Keep dispatches lean, and step effort down for mechanical steps.

## THE PROMPT
Read `docs/handoffs/2026-10-07-luna-coordinator.md` in this worktree, then
`docs/specs/2026-10-07-luna-coordinator-request.md`. Follow "What is next, in order" from step 1. Sonnet writes all
code; Codex reviews the architecture and the Codex-specific changes; fable reviews the plan and the
correctness-critical code. Report to the user when the mock-provider test list passes.
