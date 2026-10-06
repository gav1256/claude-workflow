# Batch B: usage pacing, one pause protocol, broadcast, power-aware pause: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallel sessions pace themselves against the 5-hour AND the weekly Claude window (B1: a status-line usage
recorder, a pure pacer, `pace.json` for Claude and Codex, a global `Agent` gate that also nudges a controller past the
250k / 400k context rules), pause through one protocol whose
sources are a manual `/broadcast pause`, the pace (`hold`/`exhausted`) and a low battery (B2, B3), and resume on their
own - all in deterministic code that costs zero tokens until a state changes.

**Architecture:** Two new pure modules hold the decisions: `pace-lib.mjs` (the pacer, the status-line text, the gate's
decision, the context nudge) and `pause-lib.mjs` (pause sources and scope, the pause close, the resume plan with its probe, the manifest).
Two small I/O modules read and write their files: `pace-io.mjs` (`usage/`, `pace.json`) and `pause-io.mjs` (the pause
source files, the watcher's lock, the power cache). `hooks/coord.mjs` gains the global `statusline` and `agent-gate`
entries, `pace`, `pause`/`resume`, `watch` and `power`; the lane Stop hook writes `{paused}`; `goal-gate.mjs` lets a
paused session stop. The tick (`recover.mjs`) recomputes `pace.json`, closes paused lanes in both recovery modes,
relaunches them through a new `launch.mjs resume --paused` branch, keeps the manifest and starts the watcher.
`power.mjs` (B3) probes the battery. A `/broadcast` skill drives the manual source.

**Tech Stack:** Node >= 18 ESM (`node:fs`, `node:child_process`, `node:test`), Windows PowerShell 5.1 for process and
battery probes, the Claude Code status line and hooks. No dependencies.

**Spec:** `docs/specs/2026-10-06-batchB-pause-pacing-design.md` (Fable-approved 2026-10-06, commit `a7015cd`; Part 8
"controller context discipline" and the `pane/` prune were added by the coordinator afterwards, user-approved). Read it
with this plan: the plan argues from it. It builds on batch A (`docs/specs/2026-10-05-batchA-lane-hygiene-priority-design.md`,
plan `docs/plans/2026-10-05-batchA-lane-hygiene-priority.md`), which is live.

## Global Constraints

- **Three releases, each useful alone:** B1 (pacer, recorder, `pace.json`, `slow` enforcement, the context discipline,
  the carried fixes),
  then B2 (the one pause protocol, `/broadcast`, `hold`/`exhausted` acting through it), then B3 (the power source). B1
  must be releasable alone: the codex-dual lane's Codex switch (deadline ~2026-10-09) reads `pace.json`.
- **The codex-dual contract is binding:** readings `<coord>/usage/<session_id>.json` (Claude) and
  `usage/codex-<run-id>.json` (Codex), each `{ts, provider, pct, resets_at, week_pct, week_resets_at}`; `ts` epoch ms;
  `provider` absent = `"claude"`; `pct`/`week_pct` 0-100 or `null`; `resets_at`/`week_resets_at` epoch seconds or
  `null`. Output `<coord>/pace.json` = `{updated, <provider>: {state, pct, ahead, resets_at, week_pct, week_ahead,
  week_resets_at, since}}`, written atomically (`writeAtomic`); `state` is `ok | slow | hold | exhausted`; a reader
  treats a `pace.json` older than 15 min as absent; `updated` is a reserved key, never a provider; `week_ahead`,
  `since` and `windows` are additive. The pacer has no Claude-specific code.
- **Zero tokens to track:** only a state change costs one notice line per affected session. The status line's output
  never enters the model's context.
- **Fail safe:** the status line prints the plain line (or nothing) and exits 0 on any error; every new hook exits 0
  with no output on any error (the Agent gate allows). Liveness `unknown` is never acted on (no close, kill or
  relaunch is decided from it).
- **Thresholds** (`<coord>/config.json`; missing = default): `pace` = `{pace_target 95, pace_floor 10, week_grace_min
  720, slow_enter 10, slow_leave 5, hold_enter 20, hold_leave 15, exhausted_pct 95, week_slow_enter 5, week_slow_leave
  2, week_slow_pct 90, week_hold_enter 10, week_hold_leave 7, week_exhausted_pct 97, fresh_min 10, week_fresh_min 360,
  stale_min 15, recompute_s 30, unchanged_s 60}`; flat keys `relay_ctx` 250000, `hard_ctx` 400000 (B1, Part 8),
  `max_resumes_per_tick` 3, `min_pause_min` 15, `probe_wait_min` 10 (B2), `battery_pct` 20 (B3).
- **The status line's layout** (the user's, 2026-10-06): `◆ <model> · <window> │ effort <e> │ ctx <10-part bar> <n>% [relay|RELAY
  NOW] │ 5h <n>% │ wk <n>% │ pace <state> +<ahead> │ ◇ <n> agents`, only from documented stdin fields
  (code.claude.com/docs/en/statusline); a missing field drops its segment (no subscription segment: no such field is
  documented); `pace` only when not `ok`; at most ~110 characters (`pace`, then `wk`, go first).
- **Context discipline (Part 8) never blocks:** it only shows (`ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay` in the status line) and nudges (one
  `additionalContext` line on a main-thread `Agent` dispatch); a subagent's call (`agent_id`) is skipped; errors show
  nothing.
- **No other session is affected.** The files a hook or the status line writes, all under `<coord>`:
  `sessions/<sid>.json` (batch A); `usage/<sid>.json` (the recorder: this session's reading); `pace.json` (the
  recorder's recompute: a whole-file atomic rename, the same computation in every writer); `pace-seen/<sid>` and its
  once-claims `pace-seen/<sid>.p<since>`, `.relay`, `.hard-<n>` (the Agent gate); `pause/seen/<sid>.json` (a paused
  hand-opened session); its own `{paused}` registry line (the lane Stop); and the machine-wide trigger claims `tick.json`
  and `power-claim.json`. `coord.mjs pause|resume` write `pause/manual.json` (deleting the old `pause.json`); the power
  refresh writes `power.json` and `pause/battery.json`. The tick is the only writer of `paused.json`,
  `pause/tick-state.json` (an unrestricted tick only) and the registry lines it decides.
- **No visible windows in tests, probes or live checks:** the sandbox (`tests/helpers.mjs`: `HL_REGISTRY_DIR`, a temp
  `CLAUDE_CONFIG_DIR`, `HL_AGENTS_JSON`, `HL_FAKE_PROCS`, `HL_NO_SPAWN=1`, `HL_FAKE_CLAUDE=1`, and from B3
  `HL_FAKE_POWER=none`); identities `test@example.com`; never the real registry. The watcher in tests runs `--once`
  with a fake start time; nothing is ever spawned detached in a test.
- **The repo is PUBLIC:** no personal paths, user names, email addresses or private project names in any committed
  file. The secret-scan pattern lives in the controller's private handoff and is never written into a committed file.
- Node >= 18 ESM, no dependencies, LF line endings. Every change lands in the repo copy and reaches live (`~/.claude`)
  only at a release checkpoint, after review; the copies stay identical.
- **Proving check:** `timeout 1800 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` (baseline at `a7015cd`,
  unchanged at `0fdbb7a` for every file this plan touches:
  `ℹ tests 346`, about 4-5 min). Report the real `ℹ tests / ℹ pass / ℹ fail` lines. Each task also names its focused
  command.
- Large-org variant (document only): a central quota service per account with per-team budgets instead of per-machine
  status-line readings, and a fleet scheduler that drains work on quota or power events.

## Decisions beyond the spec's text (rulings)

Each is the plan's reading where the spec is silent or open; the cost if wrong is named. The controller confirms or
rules otherwise before Task 1 starts.

1. **`updated` and `since` in `pace.json` are epoch ms** (the contract names their keys, not their unit; `ts` is ms).
   Cost if wrong: a reader that `Date.parse`s them gets NaN and treats `pace.json` as absent - default routing, safe.
2. **A chained status line lives in `<coord>/statusline-chain.json` `{command}`**, not in `statusLine.chain` inside
   `settings.json` (an unknown key there may fail Claude Code's settings validation). The install writes it (Task 2,
   INSTALL_PROMPT.md); the spec's Part 1 is amended to match (fix round 1, m7). Cost: only the file name differs;
   nothing is chained today.
3. **`exhausted` is entered on any reading of the current window**, fresh or stale (`pct` never falls inside a window);
   only `slow`/`hold` entry needs a fresh reading. Cost: none in practice; a stale 95 % is still 95 %.
4. **A reading stamped more than 1 min in the future is skipped** (a clock moved back would otherwise make it the
   "newest" reading forever). Review Focus 1.
5. **Each window in `pace.json` carries `basis`** (`fresh | stale | none`) next to its `state` (additive): the probe
   resume needs to know whether a pause ended on a stale reading. A 5-hour `basis: none` (no current reading) is the
   window that reset.
6. **The Agent gate's matcher is `^(Agent|Task)$`** (`Task` is the tool's older name, as `WORK_TOOLS` already treats
   it). Anchored (fix round 1, M1): Claude Code reads a matcher as a regex, so a bare `Agent|Task` also fires on
   `TaskUpdate`, `TaskCreate` and every other `Task*` tool. `agentGate` checks the same rule on `tool_name` first, so a
   hand-merged settings entry without anchors still judges only dispatches; probe P1 logs whether the hook fires for a
   `TaskCreate`.
7. **`paceTick` runs first in every unrestricted tick** (before the pause and resume decisions), so `updated` stays
   fresh while any tick runs and the tick decides on the newest pace.
8. **`pace-seen/<session_id>` is JSON `{since, ctx: {relay, hard_at}}`** - the pace notice's and Part 8's once-markers in
   one file, as the spec says ("the same file, a `ctx` field"); the spec's Part 3 is amended to match (fix round 1, m7).
   Each notice is also claimed with an exclusive create (`pace-seen/<sid>.p<since>`, `.relay`, `.hard-<previous
   hard_at>`, fix round 1, m2), so of two dispatches of one session at once only the winner speaks; the claims are
   pruned with the markers (8 days by mtime). Part 8's nudge needs a plain session id like the notice. "Past 250k" is
   `> relay_ctx`; `relay_ctx`/`hard_ctx` are flat config keys.
9. **Part 8 reads the context from the status line's `context_window.current_usage` when present**, else from the
   transcript's last 64 KB (the last main-thread assistant record's usage). Task 0's probe P2 confirms the field name;
   if it differs, only `pace-lib contextOfStatus` changes.
10. **The `tick.lock` fix** (carried): the lock already records `start` (`recover.mjs:37`) and compares it, with a 10 s
    tolerance and no image check (`recover.mjs:44-48`). The fix tightens the identity to "node and a start within 2 s"
    (the hung-tick rule's), so a pid reused within seconds reads as dead; a failed probe still holds the lock.
11. **`launch.mjs sessions` after the carried fix lists only non-gone lanes**: a lane whose only open entry is gone
    (unclosed) is no longer printed as `gone` (the tick closes or reports it). Cost: one less line for a dead entry.
12. **Hooks never write `paused.json`.** A hand-opened session seen paused writes its own `pause/seen/<sid>.json`; the
    tick folds them in. The manifest has one writer (the tick), like the pause sources.
13. **`coord.mjs resume` does not archive the manifest at once** (spec: "or when the user runs resume"): the tick
    derives what to relaunch from the registry and marks `resumed_at` in the manifest; the normal archive rule then
    fires within a tick or two. Cost: `paused.json` lingers a few minutes after a resume.
14. **`min_pause_min` applies to lanes closed for `pace` only** - a manual `/broadcast resume` must not wait 15 min.
15. **Probe resume** takes the oldest pause among equal priorities, the first window lane; with no window lane, the
    first lane (one per `probe_wait_min`).
16. **"A resume is pending" for a still-open `{paused}` lane** = it did nothing after its `{paused}` line (1 min slack).
    A lane the user typed into after its pause lifted is left alone.
17. **The battery source is on only while `pause/battery.json` is under 10 min old** (the refresh rewrites it every
    60 s while low), so a file left by a reboot never pauses forever.
18. **A relaunch that fails twice is given up with one alert** (spec silent), instead of a relaunch every tick.
19. **`launch.mjs resume --paused` needs a selector** (`--all`, `--id`, `--lane`, `--group` or `--repo`; the KNOWN_FLAGS
    test requires every flag to be read), and a cap refusal exits 3 with the cap's line, which the tick's `capRefusal`
    reads.
20. **Power refresh cadence:** 60 s with a battery, 1 h without one. Hooks claim it in `power-claim.json`
    (machine-wide, like `tick.json`); post-tool may now write that file too, so the isolation test's list gains it.
21. **The skip alert** counts a lane's skipped pause closes until it closes; busy and waiting-for-permission never count.
22. **The sandbox sets `HL_FAKE_POWER=none`**, so no test probes the machine's battery (only `power.test.mjs`'s
    read-only real-probe case does).
23. **`coord.mjs pace` writes nothing** (it computes from the files); the recorder and the tick write `pace.json`.
24. **The secret-scan pattern is never written into this public repo** (the dispatch gave it literally; it names the
    user and a private project). Release checkpoints run "the secret scan (pattern from the private handoff)".
25. **The status line follows the user's layout, from documented fields only** (coordinator, fix round 1): the
    subscription segment is never shown (no plan or auth field is documented; never guessed); `effort` falls back to the
    settings' `modelSettings[<model id>].effortLevel`, then `effortLevel`; `◇ N agents` counts a `tasks` array only if the
    real stdin has one (undocumented: probe P2 records the stdin to settle it). The spec's Part 1 step 4 and Part 8 are
    amended to the layout.
26. **The pause close, the resume, the manifest and `pause/tick-state.json` belong to unrestricted ticks only** (fix
    round 1, MAJOR 1 and minor 8: gating, not scoping, is the simpler choice). A `--repo` tick (`launch.mjs watchdog
    --repo`) runs the stage-2 scans for its repo and leaves the machine-wide pause state alone.
27. **The tick relaunches a paused lane itself** (`freshLaunchArgs` with `--resume-note`, spawned under its
    `tick.lock`), and `launch.mjs resume --paused` by hand takes the same lock (fix round 1, MAJOR 2): the two can never
    relaunch one lane twice. A lane with a launch in flight (a `{starting}` line newer than its newest entry, under
    5 min old) is left out by both. This differs from the spec's "through a new `launch.mjs resume --paused` branch":
    the branch exists for the hand path; the tick does not shell out to it (it holds the lock the branch takes).
28. **The watcher steps** (fix round 1, MAJOR 3 and 4): every step drops live.mjs's liveness memos
    (`forgetLiveness()`); lanes the tick gave up on (`alerted`, `failed >= 2`) trigger nothing; after a watcher tick that
    closed and relaunched nothing, the next tick waits 5 min.
29. **Small resume rules** (fix round 1): the probe is recorded only when its relaunch worked (minor 5); a lane writes a
    new `{paused}` line when its newest predates the source that pauses it now (`pausedLineDue`, minor 6; the battery
    source keeps its `since` across refreshes); a lane the pace pauses again within 6 h of its last pace relaunch waits
    `min_pause_min` x 2, then x 4 at most (`repauseCount`, tick state `repause`, minor 7); `pause-io`'s reader is
    `pauseForNow` (minor 10); `alerted`/`failed` entries of lanes that are gone are pruned (minor 10).

## Fix round 1 (2026-10-07: Fable's B1 and B2/B3 plan reviews, the coordinator's rulings)

| Finding | Where it lands |
|---|---|
| M1 the gate fires on every `Task*` tool | ruling 6; Task 2 (`^(Agent\|Task)$` matcher, `agentGate`'s first line, the TaskUpdate and fragment tests); probe P1 (TaskCreate) |
| m1 Task 2's reviewer | sizing table: Fable |
| m2 concurrent notices | ruling 8; Task 2 (`claim()`, the six-at-once test); Task 3's prune covers the claims |
| m3 / m4 / m5 / m6 | Task 7 Step 5; Task 3's test (`/^(would set )?pace:/m`); probe P1's stdin log; Global Constraints (the hook-written files) |
| m7 the spec | spec Part 1 (the chain file) and Part 3 (the JSON marker and claims), amended in this commit |
| MAJOR 1 restricted ticks | ruling 26; Task 11 (the tick wiring), Task 13 (the restricted-tick test) |
| MAJOR 2 hand resume vs the tick | ruling 27; Task 12 (`tick.lock`, the race test), Task 8 (`pausedLanes` skips a launch in flight), Task 13 (the tick launches itself), Task 16 (`restart`) |
| MAJOR 3 / MAJOR 4 the watcher | ruling 28; Task 14 (`watchStep`: exclusions, back-off, `forgetLiveness()`; three tests) |
| minor 5-11 | ruling 29; Tasks 8, 10, 11, 13, 20 (each with its test); minor 8: gating chosen; minor 9: `refreshPower`'s comment; minor 11: the one-file contention test (Task 9), the battery/manual contention test (Task 20), the Stop dedupe by `at` (Task 10) |
| The user's status-line layout | ruling 25; Global Constraints; Task 1 (`statusLineText`), Task 2 (`statusline`, `settingsEffort`), probe P2 (records the real stdin); spec Part 1 step 4 and Part 8 amended |

## Spec statements the code contradicts (checked at `a7015cd`)

- Carried fix 2 says "record and compare the holder's start time in `tick.lock`, as b2c2b2f did": `acquireTickLock`
  already writes `start: V.selfStart()` (`recover.mjs:37`) and compares it (`recover.mjs:45-48`). The flake comes from
  the 10 s reuse tolerance and the missing image check; Task 5 fixes those (ruling 10).
- `coordinator.md:135-136` and `SKILL.md` section 5 "Pausing" say `{paused}` is never written by code; the spec changes
  that (Part 4) and Task 17 updates both.
- "Thresholds in `<coord>/config.json` under `pace`": `loadConfig` rejects any non-number value
  (`recover-lib.mjs:25-29`), so Task 1 extends it (a `pace` object).
- Every other anchor the spec cites matches the code: `pausedLine` `recover.mjs:27`, `closeCase` `recover.mjs:597-603`,
  `killTree` `live.mjs:457-470`, `resume` `launch.mjs:518-530`, `freshLaunchArgs` `recover-lib.mjs:289-301` (it pushes
  `--recovery` unconditionally at `:294`), the tick triggers `coord.mjs:73` and `goal-gate.mjs:105`, `laneTable`
  `recover.mjs:715-734`, `sessions` `launch.mjs:592-597`.

## Review Focus

1. **A reading stamped in the future** (the clock moved back, or a Codex file written with a wrong clock): it must not
   become the "newest" reading and shadow every real one. (Test: Task 1, "a reading stamped in the future ...".)
2. **A corrupt Codex reading** (`{`, strings for numbers, a JSON list) in `usage/`: skipped, the pacer still answers for
   every other file. (Test: Task 2, the `coord.mjs pace` case.)
3. **The status line's real stdin** (`resets_at` as epoch s, ms or ISO; one window missing; no model, effort or
   context field; a model without effort support): recorded in the contract's units, and every absent field drops its
   segment, never an error. (Tests: Task 1 `readingFromStatus` and the layout test, Task 2 "one window missing" and the
   full-stdin test; probe P2 records the real stdin.)
4. **A reboot while paused** (windows gone, never closed; the watcher gone): `launch.mjs resume --paused --all`
   relaunches the gone lanes too. (Test: Task 12, lane Z.)
5. **The user's own session is paused too** (manual, battery, or pace `exhausted`): its Agent dispatches are denied and
   its stop is allowed with `paused: <reason>`, and it is listed for `claude --resume`, never closed. (Tests: Task 10,
   the hand-opened cases.)

Also watch, by review: the watcher probes liveness of paused lanes every 60 s (one PowerShell probe per step while
anything is paused); a tick from the watcher and one from a hook share `tick.lock`; PreToolUse `additionalContext` must
reach the model (Task 0, probe P1).

## File structure

| File | Responsibility |
|---|---|
| `claude/skills/handoff-launch/pace-lib.mjs` (new, Task 1) | Pure: `PACE_DEFAULTS`, `paceConfig`, `toEpochS`, `pctOf`, `readingFromStatus`, `sameReading`, `paceState`, `isEntry`, `providersOf`, `paceFresh`, `statusLineText`, `ctxBar`, `windowText`, `runningAgents`, `worse`, `aheadText`, `statusText`, `paceTable`, `paceHeader`, `SLOW_DENY_TEXT`, `SLOW_NOTICE_TEXT`, `PAUSE_TEXT`, `gateDecision`; Part 8: `CTX_DEFAULTS`, `ctxConfig`, `contextOfEntries`, `contextOfStatus`, `ctxText`, `CTX_RELAY_TEXT`, `CTX_HARD_TEXT`, `ctxNudge`. |
| `claude/skills/handoff-launch/pace-io.mjs` (new, Task 2) | `USAGE_DIR`, `PACE_FILE`, `SEEN_DIR`, `readReadings`, `recordReading`, `recomputePace`, `staleUsageFiles`. |
| `claude/skills/handoff-launch/pause-lib.mjs` (new, Task 8) | Pure: `activeSources`, `pauseFor`, `pausedLineOf`, `pausedLineDue`, `pauseCloseDue`, `pausedLanes`, `lanePauseKey`, `needsProbe`, `repauseCount`, `minPauseFor`, `resumePlan`, `laneRow`, `handRow`, `upsertRows`, `markResumed`, `archiveDue`, `archiveName`, `HOW_TO_RESUME`, `HAND_RESUME_TEXT`, `CLOSE_SKIPPED_TEXT`, `parseUntil`. |
| `claude/skills/handoff-launch/pause-io.mjs` (new, Tasks 9, 14, 20) | The source files: `readSources`, `pauseActive`, `pauseForNow`, `writeManual`, `clearManual`, `recordSeen`, `readSeen`; the watcher's `watchHolder`, `takeWatchLock`, `releaseWatchLock`, `watchNeeded`, `ensureWatcher` (14); power `powerStale`, `refreshPower`, `triggerPowerRefresh`, `powerText` (20). |
| `claude/skills/handoff-launch/power.mjs` (new, Task 19) | `parseWinBattery`, `parsePmset`, `parseSysfs`, `fakePower`, `lowBattery`, `probePower`, `NO_BATTERY`. |
| `claude/hooks/coord.mjs` (Tasks 2, 9, 10, 14, 20) | `statusline`, `pace`, `agent-gate` (2); `pause`/`resume` (9); `stop`'s `markPaused`, `pauseNow`, the gate's pause (10); `watch` (14); `power`, `maybePowerRefresh` (20). |
| `claude/hooks/goal-gate.mjs` (Task 10) | A paused session's stop is allowed with `paused: <reason>`. |
| `claude/skills/handoff-launch/recover-lib.mjs` (Tasks 1, 8, 12, 20) | `loadConfig`'s `pace` object and `relay_ctx`/`hard_ctx` (1); the resume keys (8); `freshLaunchArgs`' `resumeNote`, `PAUSE_RESUME_LINE` (12); `battery_pct` (20). |
| `claude/skills/handoff-launch/recover.mjs` (Tasks 3, 4, 5, 11, 13, 14, 20) | `paceTick`, the prune (3); `laneTable` (4); `acquireTickLock` (5); `pauseActive` over the sources, `guardedCloseResult`, `closeCase`, `pauseScan`, `readTickState` (11); `resumeScan`, `manifestTick` (13); `watcherTick` (14); `powerTick` (20). |
| `claude/skills/handoff-launch/launch.mjs` (Tasks 4, 12, 15) | `sessions` (4); `resume --paused`, `--resume-note` (12); the paused note and the pace header (15). |
| `claude/settings.fragment.json`, `INSTALL_PROMPT.md` (Task 2) | The global `statusLine` and `PreToolUse` `Agent|Task` entries; the install rules. |
| `claude/skills/broadcast/SKILL.md` (new, Task 16) | `/broadcast`. |
| `coordinator.md`, `SKILL.md`, `README.md` (Tasks 6, 17, 20) | Docs. |
| `tests/*.test.mjs` under `claude/skills/handoff-launch/` | New: `pace-lib`, `pace`, `agent-gate`, `pace-tick` (B1); `pause-lib`, `pause`, `pause-hooks`, `pause-close`, `pause-resume`, `pause-resume-tick`, `watch`, `pause-status`, `broadcast-skill` (B2); `power`, `power-pause` (B3). Changed: `lanes`, `recover`, `coord-hook`, `helpers`. |

## Execution notes for the controller

- **Branch and worktrees.** Land the spec and this plan on `main` first (the main checkout stays on its branch). Cut the
  integration branch `batchB-pause-pacing` from that `main` in `<main repo>/.claude/worktrees/batchB`; every release is a
  fast-forward of `main` to it. A parallel lane (below) gets its own branch and worktree
  (`.claude/worktrees/batchB-<lane>`) cut from the integration branch's tip at the lane's start, and is merged back into
  `batchB-pause-pacing` in the order given. Two lanes never touch the same file.
- **Execution:** subagent-driven. A task's implementer works in its lane's worktree and commits per task; the task's
  reviewer reviews that commit before the next task of the lane starts.
- **The edit blocks are exact.** Each `**Replace** in <file>` block quotes text that occurs exactly once in that file
  once the tasks before it (in task-number order) are applied; `**Create**` gives a whole new file. They were proven by
  applying them in task order to a clean copy of `0fdbb7a` (the files they touch are as at `a7015cd`) with a script,
  running each task's focused command at its
  end and the full suite at each release: B1 `ℹ tests 388`, B2 `ℹ tests 438`, B3 `ℹ tests 447`, each with
  `ℹ fail 0`. That proves the plan consistent, not correct: the reviews still judge it. A lane applies its tasks' blocks
  in task-number order; blocks of a task that runs before a lower-numbered one of another lane (e.g. Task 19 before
  Task 9) touch only their own new files.
- Line numbers in the prose are at `a7015cd`; anchor on the quoted code. Windows-only tests (real hidden processes) are
  `skip`ped elsewhere, as before.
- **Proving check per task:** the task's focused command (its Step 4). **Per release:** the full suite,
  `timeout 1800 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` (about 4-6 min), quoting `ℹ tests/pass/fail`.

### Dispatch sizing (`sizing-dispatches`)

All code is written by sonnet (the code is in this plan; the implementer applies it, runs the steps and fixes what the
run shows). Reviewers: opus `worker-high`; Fable `worker-high` for the correctness-critical tasks - the pacer's math,
the pause sources and their concurrency, the close and resume path, the watcher.

| Task | Implementer | Reviewer |
|---|---|---|
| 0 probes | controller | - |
| 1 `pace-lib.mjs`: the pacer, texts, gate decision, Part 8 decisions; `loadConfig` | `worker-high` + sonnet | `worker-high` + **fable** |
| 2 recorder, `pace`, Agent gate (pace + Part 8), settings, install | `worker-high` + sonnet | `worker-high` + **fable** |
| 3 the tick: `pace.json`, prune (usage, pace-seen, pane) | `worker-medium` + sonnet | `worker-high` + opus |
| 4 carried: liveness before newest (`laneTable`, `sessions`) | `worker-medium` + sonnet | `worker-high` + opus |
| 5 carried: `tick.lock` holder identity | `worker-medium` + sonnet | `worker-high` + opus |
| 6 B1 docs | `worker-medium` + sonnet | `worker-high` + opus |
| 7 B1 release | controller; whole-release review `worker-high` + **fable** | - |
| 8 `pause-lib.mjs` | `worker-high` + sonnet | `worker-high` + **fable** |
| 9 `pause-io.mjs` sources, `coord.mjs pause`/`resume` | `worker-high` + sonnet | `worker-high` + **fable** |
| 10 hooks: gate pause, Stop `{paused}`, goal-gate | `worker-high` + sonnet | `worker-high` + **fable** |
| 11 the pause close | `worker-high` + sonnet | `worker-high` + **fable** |
| 12 `launch.mjs resume --paused` | `worker-high` + sonnet | `worker-high` + **fable** |
| 13 resuming, probe, manifest | `worker-high` + sonnet | `worker-high` + **fable** |
| 14 the watcher | `worker-high` + sonnet | `worker-high` + **fable** |
| 15 status and sessions notes, pace header | `worker-medium` + sonnet | `worker-high` + opus |
| 16 `/broadcast` | `worker-medium` + sonnet | `worker-high` + opus |
| 17 B2 docs | `worker-medium` + sonnet | `worker-high` + opus |
| 18 B2 release | controller; whole-release review `worker-high` + **fable** | - |
| 19 `power.mjs` | `worker-medium` + sonnet | `worker-high` + opus |
| 20 power wiring, B3 docs | `worker-high` + sonnet | `worker-high` + **fable** |
| 21 B3 release | controller; review `worker-high` + **fable** | - |

None needs `worker-xhigh`: the hard parts (pacer math, resume plan) are pure functions given in full with their tests.
Redo a failed task one rung up the ladder (`worker-xhigh` + sonnet).

### Parallel lanes

Lanes run at the same time in separate worktrees; their file sets are disjoint and their interfaces are fixed by this
plan (each task's **Interfaces** block). Everything not in a lane runs serially on `batchB-pause-pacing`.

| Lane | Tasks (in order) | Exact file set | Base | Merge |
|---|---|---|---|---|
| `b1-pace` | 1 → 2 | `pace-lib.mjs`, `pace-io.mjs`, `recover-lib.mjs`, `hooks/coord.mjs`, `settings.fragment.json`, `INSTALL_PROMPT.md`, tests `pace-lib`, `pace`, `agent-gate` | integration tip after the plan lands | 1st |
| `b1-fixes` | 4 → 5 | `recover.mjs`, `launch.mjs`, tests `lanes`, `recover` | the same tip | 2nd |
| serial | 3, then 6, then 7 | `recover.mjs`, test `pace-tick`; docs | after both B1 lanes merged | - |
| `b3-power` | 19 | `power.mjs`, test `power` (new files only) | any tip after B1's release | before Task 20 |
| serial | 8 → 9 | `pause-lib.mjs`, `recover-lib.mjs`, `pause-io.mjs`, `hooks/coord.mjs`, tests `pause-lib`, `pause` | integration tip after B1's release | - |
| `b2-hooks` | 10 | `hooks/coord.mjs`, `hooks/goal-gate.mjs`, test `pause-hooks` | tip after Task 9 | 1st of the three |
| `b2-close` | 11 | `recover.mjs`, tests `recover`, `pause-close` | tip after Task 9 | 2nd |
| `b2-launch` | 12 → 15 | `launch.mjs`, `recover-lib.mjs`, tests `pause-resume`, `pause-status` | tip after Task 9 | 3rd (Task 15 may merge later) |
| serial | 13 → 14 | `recover.mjs`, `pause-io.mjs`, `hooks/coord.mjs`, tests `pause-resume-tick`, `watch` | after `b2-hooks`, `b2-close` and Task 12 merged (Task 13's manifest test runs the Task 10 gate; its relaunch passes Task 12's `--resume-note`) | - |
| `b2-broadcast` | 16 | `skills/broadcast/SKILL.md`, test `broadcast-skill` (new files) | tip after Task 12 merged (its test runs `resume --paused`) | before Task 17 |
| serial | 17, then 18 | docs | after every B2 lane | - |
| serial | 20, then 21 | `pause-io.mjs`, `recover-lib.mjs`, `hooks/coord.mjs`, `recover.mjs`, tests `helpers`, `coord-hook`, `power-pause`; docs | after B2's release and `b3-power` | - |

Why the rest is serial: `recover.mjs` is touched by Tasks 3, 4, 5, 11, 13, 14 and 20; `hooks/coord.mjs` by 2, 9, 10, 14
and 20; `launch.mjs` by 4, 12 and 15; `recover-lib.mjs` by 1, 8, 12 and 20; `settings.fragment.json` by 2 only. Within a
release, a merge of a lane runs that lane's focused commands again on the integration branch.

---

## Release B1: usage pacing, the Agent gate, the context discipline, the carried fixes

### Task 0 (controller): live probes

Read-only probes, headless or against fake input; no visible window. Record each result in this table (pass / fail +
evidence) before Task 2's review; a failed probe takes its fallback, which the named task applies.

| # | Probe | How | Fallback if it fails |
|---|---|---|---|
| P1 | A PreToolUse hook on `Agent` can deny with a reason and can add `additionalContext` (no `permissionDecision`) that the model sees; the anchored matcher does not fire for `TaskCreate` | In a temp folder `D`: `claude -p "Create one task with TaskCreate, then dispatch one Agent of type explorer to list this folder, then quote any hook context you received" --settings <tmp file: PreToolUse matcher "^(Agent\|Task)$" -> a node script that first appends its stdin to $D/hook-<n>.json (n: a counter), then prints {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"PROBE-CTX-1"}}> --allowedTools Agent,TaskCreate`; then the same with a deny. Pass: one `hook-<n>.json` per Agent dispatch and none with `tool_name` `TaskCreate`; the model quotes PROBE-CTX-1 | Task 2: the notice is printed as `{"systemMessage": ...}` (the user sees it, the model does not); the deny is kept. |
| P2 | The status line's stdin carries the documented fields the code reads: `session_id`, `transcript_path`, `model.{id, display_name}`, `context_window.{context_window_size, used_percentage, current_usage}`, `effort.level`, `rate_limits.five_hour/seven_day.{used_percentage, resets_at}`; and whether it has a plan/subscription field or a `tasks` array (both undocumented) | Not headless (the status line does not run in `-p`). Before Task 2's review, in this controller's interactive session: a one-off `statusLine` command that appends its stdin to `$D/statusline-stdin.jsonl` and prints nothing, kept for three assistant messages, then the previous `statusLine` restored (the settings backed up first); record the field names found. At Task 7 Step 6: the usage file against `/usage` and the `ctx` segment against `/context` | Task 2: a field under another name changes the one read in `pace-lib readingFromStatus` / `contextOfStatus` / `statusLineText`; a real plan field adds the `◆ <plan>` segment first, a `tasks` array of another shape changes `runningAgents`; units are already normalised (s, ms or ISO). |
| P3 | A hand-opened session's `Agent` call carries no `agent_id`; a subagent's tool call does | From P1's `$D/hook-<n>.json` files: the main thread's dispatch, and (a second matcher `.*` logging to the same folder) the explorer's own calls | Task 2: Part 8 also skips calls whose `transcript_path` differs from the main session's (the subagent's own transcript). |

---

### Task 1: `pace-lib.mjs`: the pacer, the texts, the gate's decision, Part 8's decisions; `loadConfig` reads `pace`

**Files:**
- Create: `claude/skills/handoff-launch/pace-lib.mjs`
- Create: `claude/skills/handoff-launch/tests/pace-lib.test.mjs`
- Modify: `claude/skills/handoff-launch/recover-lib.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces (pure, no I/O): `PACE_DEFAULTS`; `paceConfig(v) -> {pace, errors}`; `toEpochS(v) -> s|null`;
  `pctOf(v)`; `readingFromStatus(input, now) -> {ts, provider: "claude", pct, resets_at, week_pct, week_resets_at}|null`;
  `sameReading(r, file, now, cfg) -> bool`; `paceState({readings, prev, now, cfg}) -> {<provider>: {state, pct, ahead,
  resets_at, week_pct, week_ahead, week_resets_at, since, windows: {five_hour, weekly: {state, basis}}}}`;
  `isEntry(v)`; `providersOf(pace) -> [[name, entry]]`; `paceFresh(pace, now, cfg) -> pace|null`; `worse(a, b)`;
  `aheadText(e)`; `statusLineText({input, reading, entry, tokens, cfg, effort, max}) -> line` (the user's layout),
  `ctxBar(pct)`, `windowText(size)`, `runningAgents(tasks)`; `paceTable(pace) -> lines`; `paceHeader(pace) -> line|null`;
  `SLOW_DENY_TEXT(e)`, `SLOW_NOTICE_TEXT(e)`, `PAUSE_TEXT(reason)`; `gateDecision({pace, priority, pause?}) -> {deny}
  | {notice, since} | null`; Part 8: `CTX_DEFAULTS`, `ctxConfig(o)`, `contextOfEntries(entries) -> tokens|null`,
  `contextOfStatus(input) -> tokens|null`, `ctxText(tokens, cfg) -> "ctx 263k relay"|null`, `CTX_RELAY_TEXT(t, c)`,
  `CTX_HARD_TEXT(t, c)`, `ctxNudge({tokens, seen, now, cfg}) -> {text, ctx}|null`.
- `recover-lib.mjs` `DEFAULTS` gains `relay_ctx`, `hard_ctx` and `pace` (an object); `loadConfig` validates `pace`
  through `paceConfig`. Deploy note: `recover-lib.mjs` imports `pace-lib.mjs`, so `pace-lib.mjs` is copied first.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pace-lib.test.mjs`:

````js
// Batch B, Parts 1-3: the pure pacer (pace-lib.mjs). No files, no clock: every case passes `now`.
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../pace-lib.mjs";
import { loadConfig } from "../recover-lib.mjs";

const MIN = 60000, NOW = Date.UTC(2026, 9, 6, 12, 0, 0), S = (ms) => Math.round(ms / 1000);
// 5-hour window half gone (resets in 150 min): allowed = 95 * 150 / 300 = 47.5. Weekly window half gone (resets in 5040
// min): allowedW = 95 * (5040 + 720) / 10080 = 54.29.
const R5 = S(NOW + 150 * MIN), RW = S(NOW + 5040 * MIN);
const rd = (o = {}) => ({ ts: NOW - MIN, pct: 30, resets_at: R5, week_pct: 40, week_resets_at: RW, ...o });
const stale = (o = {}) => rd({ ts: NOW - 11 * MIN, ...o });
// A previous pace.json whose claude entry has these per-window states.
const prevOf = (five, weekly, o = {}) => ({ updated: NOW - MIN, claude: { state: P.worse(five, weekly), since: NOW - 30 * MIN, resets_at: R5, week_resets_at: RW, windows: { five_hour: { state: five }, weekly: { state: weekly } }, ...o } });
const run = (readings, prev = null, now = NOW, cfg) => P.paceState({ readings, prev, now, cfg });
const five = (r, prev) => run([r], prev).claude.windows.five_hour.state;
const week = (r, prev) => run([r], prev).claude.windows.weekly.state;

test("5-hour bands: slow and hold enter above 10 / 20 ahead and leave below 5 / 15 (hysteresis both ways)", () => {
  assert.equal(five(rd({ pct: 57 })), "ok");                           // ahead 9.5
  assert.equal(five(rd({ pct: 60 })), "slow");                         // ahead 12.5
  assert.equal(five(rd({ pct: 57 }), prevOf("slow", "ok")), "slow");   // 9.5 >= 5: stays
  assert.equal(five(rd({ pct: 52 }), prevOf("slow", "ok")), "ok");     // 4.5 < 5: leaves
  assert.equal(five(rd({ pct: 70 })), "hold");                         // ahead 22.5
  assert.equal(five(rd({ pct: 63 }), prevOf("hold", "ok")), "hold");   // 15.5 >= 15: stays
  assert.equal(five(rd({ pct: 61 }), prevOf("hold", "ok")), "slow");   // 13.5: hold left, slow kept
  assert.equal(five(rd({ pct: 50 }), prevOf("hold", "ok")), "ok");     // 2.5: both left
  const e = run([rd({ pct: 60 })]).claude;
  assert.equal(e.ahead, 12.5); assert.equal(e.pct, 60); assert.equal(e.resets_at, R5);
});

test("5-hour exhausted at pct >= 95, kept until the window resets; the next window starts from ok", () => {
  assert.equal(five(rd({ pct: 95 })), "exhausted");
  assert.equal(five(stale({ pct: 96 })), "exhausted"); // pct never falls inside a window: a stale reading proves it
  assert.equal(five(rd({ pct: 40 }), prevOf("exhausted", "ok")), "exhausted");
  const reset = prevOf("exhausted", "ok", { resets_at: S(NOW - MIN) }); // the previous window reset a minute ago
  assert.equal(five(rd({ pct: 5, resets_at: S(NOW + 299 * MIN) }), reset), "ok");
});

test("entering slow or hold needs a fresh reading; staying and leaving use the newest one even when stale", () => {
  assert.equal(five(stale({ pct: 70 })), "ok");                         // stale: no entry
  assert.equal(five(stale({ pct: 70 }), prevOf("slow", "ok")), "slow"); // no escalation either
  assert.equal(five(stale({ pct: 70 }), prevOf("hold", "ok")), "hold");
  assert.equal(five(stale({ pct: 61 }), prevOf("hold", "ok")), "slow");
  assert.equal(five(stale({ pct: 52 }), prevOf("slow", "ok")), "ok");   // leaving slow on a stale reading
  assert.equal(run([stale({ pct: 70 })], prevOf("hold", "ok")).claude.windows.five_hour.basis, "stale");
  assert.equal(run([rd({ pct: 70 })]).claude.windows.five_hour.basis, "fresh");
  // the newest reading of the window wins, not the freshest-looking value
  assert.equal(five(rd({ pct: 70, ts: NOW - 2 * MIN })), "hold");
  assert.equal(run([rd({ pct: 70, ts: NOW - 2 * MIN }), rd({ pct: 40, ts: NOW - 3 * MIN })]).claude.pct, 70);
});

test("no reading for a window, or only readings of a window that reset: that window is ok (fail open)", () => {
  const e = run([rd({ pct: 99, resets_at: S(NOW - MIN), week_pct: 99, week_resets_at: S(NOW - MIN) })], prevOf("hold", "hold")).claude;
  assert.deepEqual([e.state, e.pct, e.ahead, e.week_pct, e.week_ahead], ["ok", null, null, null, null]);
  assert.deepEqual(e.windows, { five_hour: { state: "ok", basis: "none" }, weekly: { state: "ok", basis: "none" } });
  assert.deepEqual(run([]), {});
});

test("a reading stamped in the future (the clock moved back) never shadows the newer real ones: it is skipped", () => {
  const out = run([rd({ pct: 70, ts: NOW + 60 * MIN }), rd({ pct: 30, ts: NOW - 2 * MIN })]).claude;
  assert.deepEqual([out.pct, out.state], [30, "ok"]);
  assert.equal(run([rd({ pct: 70, ts: NOW + 30000 })]).claude.pct, 70); // under a minute ahead: clock jitter, kept
});

test("pace_floor spares the first minutes of a window", () => {
  const start = S(NOW + 300 * MIN); // the window just began: allowed = max(10, 0)
  assert.equal(run([rd({ pct: 15, resets_at: start })]).claude.ahead, 5);
  assert.equal(five(rd({ pct: 15, resets_at: start })), "ok");
  assert.equal(five(rd({ pct: 21, resets_at: start })), "slow");
  assert.equal(five(rd({ pct: 21, resets_at: start }), null), "slow");
  assert.equal(run([rd({ pct: 21, resets_at: start })], null, NOW, { ...P.PACE_DEFAULTS, pace_floor: 15 }).claude.windows.five_hour.state, "ok");
});

test("weekly: its own pace line with the grace head start, bands, the 90 % slow and 97 % exhausted", () => {
  assert.equal(week(rd({ week_pct: 56 })), "ok");     // ahead 1.7
  assert.equal(week(rd({ week_pct: 60 })), "slow");   // ahead 5.7
  assert.equal(week(rd({ week_pct: 65 })), "hold");   // ahead 10.7
  assert.equal(week(rd({ week_pct: 62 }), prevOf("ok", "hold")), "hold"); // 7.7 >= 7
  assert.equal(week(rd({ week_pct: 60 }), prevOf("ok", "hold")), "slow"); // 5.7 < 7, >= 2
  assert.equal(week(rd({ week_pct: 55 }), prevOf("ok", "slow")), "ok");   // 0.7 < 2 and < 90
  assert.equal(week(rd({ week_pct: 97 })), "exhausted");
  const wStart = S(NOW + 10080 * MIN); // the week just began: allowedW = 95 * 720 / 10080 = 6.8
  assert.equal(week(rd({ week_pct: 10, week_resets_at: wStart })), "ok");  // a normal first day is not throttled
  assert.equal(week(rd({ week_pct: 13, week_resets_at: wStart })), "slow");
  const late = S(NOW + 60 * MIN);      // an hour before the weekly reset: allowedW = 95, so 91 % is behind pace...
  assert.equal(week(rd({ week_pct: 91, week_resets_at: late })), "slow"); // ...but >= 90 % is slow all the same
  assert.equal(week(rd({ week_pct: 91, week_resets_at: late }), prevOf("ok", "slow")), "slow"); // >= 90 keeps it
  assert.equal(week(rd({ week_pct: 89, week_resets_at: late }), prevOf("ok", "slow")), "ok");
  assert.equal(week(rd({ week_pct: 65, ts: NOW - 5 * 60 * MIN })), "hold"); // 5 h old is fresh for the weekly window
  assert.equal(week(rd({ week_pct: 65, ts: NOW - 7 * 60 * MIN })), "ok");   // 7 h is not
});

test("hysteresis is per window: a weekly slow never holds the 5-hour window in slow", () => {
  const prev = prevOf("ok", "slow"); // merged state slow
  const e = run([rd({ pct: 55, week_pct: 58 })], prev).claude; // 5h ahead 7.5 (in the slow band's gap), weekly ahead 3.7
  assert.equal(e.windows.five_hour.state, "ok");
  assert.equal(e.windows.weekly.state, "slow");
  assert.equal(e.state, "slow");
  const e2 = run([rd({ pct: 55, week_pct: 50 })], { claude: { ...prev.claude, windows: undefined } }).claude; // no windows = ok
  assert.equal(e2.state, "ok");
});

test("the provider's state is the more severe window; since moves only when the state changes", () => {
  assert.equal(run([rd({ pct: 60, week_pct: 65 })]).claude.state, "hold");
  assert.equal(run([rd({ pct: 96, week_pct: 65 })]).claude.state, "exhausted");
  const prev = prevOf("slow", "ok");
  assert.equal(run([rd({ pct: 60 })], prev).claude.since, NOW - 30 * MIN);
  assert.equal(run([rd({ pct: 70 })], prev).claude.since, NOW);
  assert.equal(run([rd({ pct: 60 })]).claude.since, NOW); // no previous file: entered now
});

test("providers: provider absent = claude; a weekly-only provider (Codex) gets only the weekly bands and ahead null", () => {
  const codex = { ts: NOW - 3 * 3600e3, provider: "codex", pct: null, resets_at: null, week_pct: 60, week_resets_at: RW };
  const out = run([rd({ pct: 60, provider: undefined }), codex, { ts: "x", pct: 99 }, null]);
  assert.deepEqual(Object.keys(out).sort(), ["claude", "codex"]);
  assert.equal(out.claude.state, "slow");
  assert.deepEqual([out.codex.state, out.codex.ahead, out.codex.pct, out.codex.windows.five_hour.basis], ["slow", null, null, "none"]);
  const pace = { updated: NOW, ...out, note: "x", list: [1] };
  assert.deepEqual(P.providersOf(pace).map(([p]) => p), ["claude", "codex"]); // updated and other keys skipped
});

test("readingFromStatus: windows in epoch s, ms or ISO; a missing window is null; no rate_limits = no reading", () => {
  const iso = new Date(R5 * 1000).toISOString();
  for (const v of [R5, R5 * 1000, iso, String(R5)]) assert.equal(P.readingFromStatus({ rate_limits: { five_hour: { used_percentage: 42, resets_at: v } } }, NOW).resets_at, R5);
  assert.deepEqual(P.readingFromStatus({ session_id: "s", rate_limits: { five_hour: { used_percentage: 42, resets_at: R5 }, seven_day: { used_percentage: 31.5, resets_at: RW } } }, NOW),
    { ts: NOW, provider: "claude", pct: 42, resets_at: R5, week_pct: 31.5, week_resets_at: RW });
  assert.deepEqual(P.readingFromStatus({ rate_limits: { seven_day: { used_percentage: 31, resets_at: RW } } }, NOW),
    { ts: NOW, provider: "claude", pct: null, resets_at: null, week_pct: 31, week_resets_at: RW });
  assert.equal(P.readingFromStatus({ rate_limits: { five_hour: { used_percentage: 42 } } }, NOW), null); // no reset time
  for (const i of [{}, null, { rate_limits: null }, { rate_limits: [] }]) assert.equal(P.readingFromStatus(i, NOW), null);
});

test("sameReading: equal values under unchanged_s old are skipped; a change or an older file is written", () => {
  const r = rd({ ts: NOW });
  assert.equal(P.sameReading(r, { ...r, ts: NOW - 30000 }, NOW), true);
  assert.equal(P.sameReading(r, { ...r, ts: NOW - 61000 }, NOW), false);
  assert.equal(P.sameReading(r, { ...r, pct: 31, ts: NOW - 1000 }, NOW), false);
  assert.equal(P.sameReading(r, null, NOW), false);
});

test("paceFresh: pace.json older than stale_min, from the future, or without updated is absent", () => {
  assert.ok(P.paceFresh({ updated: NOW - 14 * MIN }, NOW));
  assert.equal(P.paceFresh({ updated: NOW - 16 * MIN }, NOW), null);
  assert.equal(P.paceFresh({ updated: NOW + 5 * MIN }, NOW), null);
  assert.equal(P.paceFresh({ claude: { state: "hold" } }, NOW), null);
  assert.ok(P.paceFresh({ updated: new Date(NOW - MIN).toISOString() }, NOW)); // an ISO updated is read too
});

test("gateDecision: low is denied at slow and above; normal and high get the notice with its since; a pause denies all", () => {
  const pace = (state) => ({ updated: NOW, claude: { state, ahead: 12.4, week_ahead: 6, since: NOW - MIN } });
  assert.equal(P.gateDecision({ pace: pace("ok"), priority: "low" }), null);
  assert.equal(P.gateDecision({ pace: null, priority: "low" }), null);
  assert.deepEqual(P.gateDecision({ pace: pace("slow"), priority: "low" }), { deny: P.SLOW_DENY_TEXT(pace("slow").claude) });
  assert.match(P.SLOW_DENY_TEXT(pace("slow").claude), /^Usage is ahead of pace \(5h \+12 \/ week \+6\)\. Low-priority lanes start no new agents now\./);
  for (const st of ["slow", "hold", "exhausted"]) assert.deepEqual(P.gateDecision({ pace: pace(st), priority: "normal" }), { notice: P.SLOW_NOTICE_TEXT(pace(st).claude), since: NOW - MIN });
  assert.match(P.SLOW_NOTICE_TEXT(pace("slow").claude), /^Usage ahead of pace \(5h \+12 \/ week \+6\): step effort down/);
  assert.deepEqual(P.gateDecision({ pace: pace("ok"), priority: "high", pause: { paused: true, reason: "manual" } }), { deny: P.PAUSE_TEXT("manual") });
  assert.equal(P.gateDecision({ pace: pace("ok"), priority: "high", pause: { paused: false, reason: null } }), null);
});

test("texts: the status line, the pace table and the status header", () => {
  const e = { state: "slow", ahead: 12.4, week_ahead: 3, pct: 42, week_pct: 31, resets_at: R5, week_resets_at: RW, since: NOW };
  assert.equal(P.statusLineText({ input: {}, reading: { pct: 42, week_pct: 31 }, entry: { ...e, state: "ok" } }), "5h 42% │ wk 31%"); // ok: no pace part
  assert.equal(P.statusLineText({ input: {}, reading: { pct: 42, week_pct: 31 }, entry: e }), "5h 42% │ wk 31% │ pace slow +12");
  assert.equal(P.statusLineText({ input: {}, reading: { pct: null, week_pct: 31 } }), "wk 31%");
  assert.equal(P.statusLineText({ input: {}, entry: e }), "pace slow +12");
  assert.equal(P.statusLineText({ input: {} }), "");
  const pace = { updated: NOW, claude: e, codex: { state: "ok", pct: null, ahead: null, resets_at: null, week_pct: 12, week_ahead: -20, week_resets_at: RW, since: NOW } };
  assert.equal(P.paceHeader(pace), "pace: claude 5h 42% wk 31% slow · codex wk 12% ok");
  assert.equal(P.paceHeader({ updated: NOW }), null);
  assert.deepEqual(P.paceTable(pace), [
    "claude: slow  5h 42% ahead +12 resets 2026-10-06T14:30Z  week 31% ahead +3 resets 2026-10-10T00:00Z  since 2026-10-06T12:00Z",
    "codex: ok  5h - ahead - resets -  week 12% ahead -20 resets 2026-10-10T00:00Z  since 2026-10-06T12:00Z"]);
  assert.deepEqual(P.paceTable({}), ["no usage readings"]);
});

test("the status line's layout: every documented field in order; a missing field drops its segment; the bar; the width cap", () => {
  const input = { model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, effort: { level: "medium" }, context_window: { context_window_size: 1000000, used_percentage: 26 }, tasks: [{ status: "running" }, { status: "completed" }] };
  const reading = { pct: 6, week_pct: 31 }, entry = { state: "slow", ahead: 12.4, week_ahead: 2 };
  assert.equal(P.statusLineText({ input, reading, entry }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(P.statusLineText({ input: { ...input, tasks: [] }, reading, entry: { ...entry, state: "ok" } }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ ◇ 0 agents");
  // each missing field drops its segment (and never throws)
  const drop = (patch, o = {}) => P.statusLineText({ input: { ...input, ...patch }, reading, entry, ...o });
  assert.equal(drop({ model: undefined }), "effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({ model: { display_name: "Opus 5.5" }, context_window: { used_percentage: 4 } }), "◆ Opus 5.5 │ effort medium │ ctx ▱▱▱▱▱▱▱▱▱▱ 4% │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents"); // no window size: no `· 1M`, and no token count for a marker
  assert.equal(drop({ effort: undefined }), "◆ Opus 5.5 · 1M │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({ effort: undefined }, { effort: "high" }), "◆ Opus 5.5 · 1M │ effort high │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents"); // the settings' effort
  assert.equal(drop({ context_window: undefined }), "◆ Opus 5.5 │ effort medium │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({ tasks: undefined }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12");
  assert.equal(drop({}, { reading: { pct: 6, week_pct: null } }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ pace slow +12 │ ◇ 1 agents");
  assert.equal(drop({}, { reading: null, entry: null }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ ◇ 1 agents");
  // the context: used tokens / window size when no percentage; the relay marks from the tokens (Part 8)
  assert.equal(drop({ context_window: { context_window_size: 200000 } }, { tokens: 50000, reading: null, entry: null }), "◆ Opus 5.5 · 200k │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 25% │ ◇ 1 agents");
  assert.equal(drop({ context_window: { context_window_size: 1000000, used_percentage: 41 } }, { tokens: 410000, reading: null, entry: null }), "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▰▱▱▱▱▱▱ 41% RELAY NOW │ ◇ 1 agents");
  assert.equal(drop({ context_window: undefined }, { tokens: 263000, reading: null, entry: null }), "◆ Opus 5.5 │ effort medium │ ctx 263k relay │ ◇ 1 agents"); // no size: the count
  // the bar rounds to the nearest 10 %
  assert.deepEqual([0, 5, 26, 100].map(P.ctxBar), ["▱▱▱▱▱▱▱▱▱▱", "▰▱▱▱▱▱▱▱▱▱", "▰▰▰▱▱▱▱▱▱▱", "▰▰▰▰▰▰▰▰▰▰"]);
  assert.deepEqual([1000000, 200000, 1500000].map(P.windowText), ["1M", "200k", "1.5M"]);
  // the width cap (~110): the pace part goes first, then wk
  const wide = { ...input, model: { display_name: "Opus 5.5 with a long name" } };
  const l = P.statusLineText({ input: wide, reading, entry });
  assert.ok(l.length <= 110, l);
  assert.doesNotMatch(l, /pace slow/); // 121 chars with it
  assert.match(l, / │ wk 31% │ ◇ 1 agents$/); // wk still fits
  assert.equal(P.runningAgents("x"), null);
});

test("paceConfig: overrides, unknown keys and bad values reported and ignored", () => {
  assert.deepEqual(P.paceConfig(undefined), { pace: { ...P.PACE_DEFAULTS }, errors: [] });
  const r = P.paceConfig({ slow_enter: 12, nope: 1, hold_enter: -1 });
  assert.equal(r.pace.slow_enter, 12); assert.equal(r.pace.hold_enter, 20);
  assert.deepEqual(r.errors, ["unknown key pace.nope", "pace.hold_enter must be a positive number"]);
  assert.deepEqual(P.paceConfig(5).errors, ["pace must be a JSON object"]);
});

test("loadConfig reads the pace object: defaults when missing, its keys validated like the flat ones", () => {
  assert.deepEqual(loadConfig(null).config.pace, P.PACE_DEFAULTS);
  const r = loadConfig('{"tick_min": 3, "pace": {"slow_enter": 12, "bogus": 1}}');
  assert.equal(r.config.tick_min, 3); assert.equal(r.config.pace.slow_enter, 12); assert.equal(r.config.pace.hold_enter, 20);
  assert.deepEqual(r.errors, ["unknown key pace.bogus"]);
  assert.deepEqual(loadConfig('{"pace": 3}').errors, ["pace must be a JSON object"]);
});

test("Part 8: the context of a main thread, its status-line part and the nudge (once past relay_ctx, every 10 min past hard_ctx)", () => {
  const a = (n, o = {}) => ({ type: "assistant", message: { usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, ...o });
  assert.equal(P.contextOfEntries([a(10), a(20), { type: "user" }, a(99, { isSidechain: true })]), 20);
  assert.equal(P.contextOfEntries([{ type: "user" }]), null);
  assert.equal(P.contextOfStatus({ context_window: { current_usage: { input_tokens: 5, cache_read_input_tokens: 7 } } }), 12);
  assert.equal(P.contextOfStatus({}), null);
  const c = P.CTX_DEFAULTS;
  assert.deepEqual([P.ctxText(12400, c), P.ctxText(263000, c), P.ctxText(402000, c), P.ctxText(250000, c), P.ctxText(null, c)], ["ctx 12k", "ctx 263k relay", "ctx 402k RELAY NOW", "ctx 250k", null]);
  assert.equal(P.ctxNudge({ tokens: 250000, now: NOW, cfg: c }), null); // "past" 250k
  assert.deepEqual(P.ctxNudge({ tokens: 263000, now: NOW, cfg: c }), { kind: "relay", text: P.CTX_RELAY_TEXT(263000, c), ctx: { relay: true } });
  assert.equal(P.ctxNudge({ tokens: 300000, seen: { relay: true }, now: NOW, cfg: c }), null);
  assert.deepEqual(P.ctxNudge({ tokens: 402000, seen: { relay: true }, now: NOW, cfg: c }).ctx, { relay: true, hard_at: NOW });
  assert.equal(P.ctxNudge({ tokens: 402000, seen: { relay: true, hard_at: NOW - 9 * MIN }, now: NOW, cfg: c }), null);
  assert.ok(P.ctxNudge({ tokens: 402000, seen: { relay: true, hard_at: NOW - 10 * MIN }, now: NOW, cfg: c }));
  assert.ok(P.ctxNudge({ tokens: 402000, seen: { hard_at: NOW + 60 * MIN }, now: NOW, cfg: c })); // a marker from the future is stale
  assert.deepEqual(P.ctxConfig({ relay_ctx: 100000, hard_ctx: -1 }), { relay_ctx: 100000, hard_ctx: 400000 });
  assert.deepEqual(loadConfig('{"relay_ctx": 200000}').errors, []);
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pace-lib.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: FAIL - `Cannot find module '.../pace-lib.mjs'`.

- [ ] **Step 3: Implement**

**Create** `claude/skills/handoff-launch/pace-lib.mjs`:

````js
// Usage pacing (batch B, Parts 1-3): the pure pacer, the status line's text, the Agent gate's decision and the texts.
// No fs, no clock, no processes: callers pass the readings, the previous pace.json and `now` in (tests/pace-lib.test.mjs).
// Units: a reading's ts and pace.json's updated/since are epoch ms; resets_at/week_resets_at are epoch seconds.
export const MIN = 60000;
export const STATES = Object.freeze(["ok", "slow", "hold", "exhausted"]);
const RANK = { ok: 0, slow: 1, hold: 2, exhausted: 3 };
// The more severe of two states (an unknown word counts as ok).
export const worse = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);
// <coord>/config.json "pace": {...}; every key a positive number. Thresholds of the spec's band table, the pace lines,
// the freshness rules and the recorder's timers.
export const PACE_DEFAULTS = Object.freeze({
  pace_target: 95, pace_floor: 10, week_grace_min: 720,
  slow_enter: 10, slow_leave: 5, hold_enter: 20, hold_leave: 15, exhausted_pct: 95,
  week_slow_enter: 5, week_slow_leave: 2, week_slow_pct: 90, week_hold_enter: 10, week_hold_leave: 7, week_exhausted_pct: 97,
  fresh_min: 10, week_fresh_min: 360, stale_min: 15, recompute_s: 30, unchanged_s: 60,
});
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// config.json's "pace" value -> {pace, errors}: unknown keys and bad values are reported and ignored (loadConfig's rule).
export function paceConfig(v) {
  const pace = { ...PACE_DEFAULTS }, errors = [];
  if (v === undefined || v === null) return { pace, errors };
  if (!isObj(v)) return { pace, errors: ["pace must be a JSON object"] };
  for (const [k, x] of Object.entries(v)) {
    if (!(k in PACE_DEFAULTS)) errors.push(`unknown key pace.${k}`);
    else if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) errors.push(`pace.${k} must be a positive number`);
    else pace[k] = x;
  }
  return { pace, errors };
}

// ---------- readings ----------
// A reset time in any of the shapes a source may give -> epoch seconds, or null. A number above 1e12 is epoch ms; a
// numeric string is read as a number; any other string as a date.
export function toEpochS(v) {
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); if (Number.isFinite(n)) return toEpochS(n); const t = Date.parse(v); return Number.isFinite(t) ? Math.round(t / 1000) : null; }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
}
// A used percentage -> 0-100, or null.
export function pctOf(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(100, n) : null;
}
// One window of the status line's rate_limits -> [pct, resets_at], both null when either is missing.
const windowOf = (w) => { const p = pctOf(w?.used_percentage), t = toEpochS(w?.resets_at); return p === null || t === null ? [null, null] : [p, t]; };
// The status line's stdin (rate_limits.five_hour / seven_day {used_percentage, resets_at}) -> a usage reading, or null
// when there is none to record: no rate_limits (not Pro/Max, or before the first API response), or neither window usable.
export function readingFromStatus(input, now) {
  const rl = input?.rate_limits;
  if (!isObj(rl)) return null;
  const [pct, resets_at] = windowOf(rl.five_hour), [week_pct, week_resets_at] = windowOf(rl.seven_day);
  if (pct === null && week_pct === null) return null;
  return { ts: now, provider: "claude", pct, resets_at, week_pct, week_resets_at };
}
// The recorder skips a write when the file holds the same values and is under unchanged_s old.
export function sameReading(r, file, now, cfg = PACE_DEFAULTS) {
  if (!r || !isObj(file) || !Number.isFinite(file.ts) || !(now - file.ts < cfg.unchanged_s * 1000)) return false;
  return ["pct", "resets_at", "week_pct", "week_resets_at"].every((k) => (r[k] ?? null) === (file[k] ?? null));
}

// ---------- the pacer ----------
const round1 = (x) => Math.round(x * 10) / 10;
// The newest reading whose window (its reset, epoch s, under tk) is still in the future, or null. A reading stamped more
// than a minute in the future (the clock moved back since it was written) is skipped: it would shadow every newer one.
function newest(rs, pk, tk, now) {
  let best = null;
  for (const r of rs) if (Number.isFinite(r[pk]) && Number.isFinite(r[tk]) && r[tk] * 1000 > now && r.ts <= now + MIN && (!best || r.ts > best.ts)) best = r;
  return best;
}
// One window's next state from its previous one (hysteresis per window). Entering slow or hold needs a fresh reading;
// staying, leaving and exhausted read the newest reading of the window even when stale (pct never falls inside a window).
function band(prev, fresh, t) {
  if (prev === "exhausted" || t.exhaust) return "exhausted";
  if (fresh && t.enterHold) return "hold";
  if (prev === "hold" && t.keepHold) return "hold";
  if (fresh && t.enterSlow) return "slow";
  if ((prev === "hold" || prev === "slow") && t.keepSlow) return "slow";
  return "ok";
}
// A pace.json provider entry (an object with a state word); `updated` and anything else is not one.
export const isEntry = (v) => isObj(v) && typeof v.state === "string";
// The previous state of one window: the previous pace.json's windows.<k>.state (missing = ok); a window whose reset has
// passed ends its state (it restarts from ok).
function prevState(prev, k, resetS, now) {
  const s = prev?.windows?.[k]?.state;
  if (Number.isFinite(resetS) && resetS * 1000 <= now) return "ok";
  return STATES.includes(s) ? s : "ok";
}
function providerState(rs, prev, now, c) {
  const r5 = newest(rs, "pct", "resets_at", now), rw = newest(rs, "week_pct", "week_resets_at", now);
  let five = { state: "ok", basis: "none" }, ahead = null;
  if (r5) {
    const fresh = now - r5.ts < c.fresh_min * MIN;
    const elapsed = Math.min(300, Math.max(0, 300 - (r5.resets_at * 1000 - now) / MIN));
    const a = r5.pct - Math.max(c.pace_floor, (c.pace_target * elapsed) / 300);
    five = { state: band(prevState(prev, "five_hour", prev?.resets_at, now), fresh, { exhaust: r5.pct >= c.exhausted_pct,
      enterHold: a > c.hold_enter, keepHold: a >= c.hold_leave, enterSlow: a > c.slow_enter, keepSlow: a >= c.slow_leave }), basis: fresh ? "fresh" : "stale" };
    ahead = round1(a);
  }
  let weekly = { state: "ok", basis: "none" }, weekAhead = null;
  if (rw) {
    const fresh = now - rw.ts < c.week_fresh_min * MIN;
    const elapsed = Math.min(10080, Math.max(0, 10080 - (rw.week_resets_at * 1000 - now) / MIN));
    const a = rw.week_pct - c.pace_target * Math.min(1, (elapsed + c.week_grace_min) / 10080), high = rw.week_pct >= c.week_slow_pct;
    weekly = { state: band(prevState(prev, "weekly", prev?.week_resets_at, now), fresh, { exhaust: rw.week_pct >= c.week_exhausted_pct,
      enterHold: a > c.week_hold_enter, keepHold: a >= c.week_hold_leave, enterSlow: a > c.week_slow_enter || high, keepSlow: a >= c.week_slow_leave || high }), basis: fresh ? "fresh" : "stale" };
    weekAhead = round1(a);
  }
  const state = worse(five.state, weekly.state);
  const since = prev && prev.state === state && Number.isFinite(prev.since) ? prev.since : now;
  return { state, pct: r5?.pct ?? null, ahead, resets_at: r5?.resets_at ?? null, week_pct: rw?.week_pct ?? null, week_ahead: weekAhead,
    week_resets_at: rw?.week_resets_at ?? null, since, windows: { five_hour: five, weekly } };
}
// readings: [{ts, provider?, pct, resets_at, week_pct, week_resets_at}] in any order (provider absent = "claude"; a
// reading without a numeric ts is skipped); prev: the previous pace.json or null; cfg: PACE_DEFAULTS' shape. -> {<provider>:
// {state, pct, ahead, resets_at, week_pct, week_ahead, week_resets_at, since, windows: {five_hour, weekly: {state, basis}}}}
// (basis: fresh | stale | none - none: no reading of a window that has not reset). The caller adds `updated`.
export function paceState({ readings, prev = null, now, cfg = PACE_DEFAULTS }) {
  const c = { ...PACE_DEFAULTS, ...cfg }, by = new Map();
  for (const r of readings || []) {
    if (!isObj(r) || !Number.isFinite(r.ts)) continue;
    const p = typeof r.provider === "string" && r.provider ? r.provider : "claude";
    if (!by.has(p)) by.set(p, []);
    by.get(p).push(r);
  }
  const out = {};
  for (const [p, rs] of by) out[p] = providerState(rs, isEntry(prev?.[p]) ? prev[p] : null, now, c);
  return out;
}
// The provider entries of a pace.json: [[name, entry]] (`updated` and any other non-entry key skipped).
export const providersOf = (pace) => (isObj(pace) ? Object.entries(pace).filter(([, v]) => isEntry(v)) : []);
// pace.json when it is no older than stale_min (and not from the future), else null: readers treat it as absent.
export function paceFresh(pace, now, cfg = PACE_DEFAULTS) {
  if (!isObj(pace)) return null;
  const u = typeof pace.updated === "number" ? pace.updated : Date.parse(pace.updated);
  return Number.isFinite(u) && now - u <= cfg.stale_min * MIN && u - now <= MIN ? pace : null;
}

// ---------- texts ----------
const signed = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${Math.round(v)}` : "-");
const pctText = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "-");
export const aheadText = (e) => `5h ${signed(e?.ahead)} / week ${signed(e?.week_ahead)}`;
// ---------- the status line (Part 1, Part 8; the user's layout, 2026-10-06) ----------
// `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 6% │ wk 31% │ pace slow +12 │ ◇ 0 agents`, from the
// status line's documented stdin fields (code.claude.com/docs/en/statusline). A field that is absent drops its segment,
// never an error: no plan or subscription field is documented, so that segment is never shown (never guessed).
const BAR = 10;
// The ctx bar: 10 segments, ▰ filled, ▱ empty; pct rounded to the nearest 10 % (5 % fills one).
export const ctxBar = (pct) => { const n = Math.max(0, Math.min(BAR, Math.round(pct / 10))); return "▰".repeat(n) + "▱".repeat(BAR - n); };
// A context window size: 1000000 -> "1M", 200000 -> "200k".
export const windowText = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const word = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
// The running subagents of an undocumented `tasks` array, if the real stdin has one (probe P2): entries whose status is
// running or pending (or that carry no status). Absent or not an array: null (the segment is dropped).
export function runningAgents(tasks) {
  if (!Array.isArray(tasks)) return null;
  return tasks.filter((t) => isObj(t) && (t.status == null || /^(running|pending|in_progress|active)$/i.test(String(t.status)))).length;
}
// input: the status line's stdin; reading: readingFromStatus's (or null); entry: a fresh pace.json's claude entry (or
// null); tokens: Part 8's context tokens (contextOfStatus, else the transcript's tail) or null; cfg: ctxConfig's;
// effort: the settings' effort when stdin has no effort.level (or null); max: the width cap - past it, the pace and then
// the wk segment go. -> the one line ("" when nothing is known)
export function statusLineText({ input, reading = null, entry = null, tokens = null, cfg = CTX_DEFAULTS, effort = null, max = 110 }) {
  const cw = isObj(input?.context_window) ? input.context_window : {}, size = num(cw.context_window_size);
  const model = word(input?.model?.display_name), eff = word(input?.effort?.level) ?? word(effort);
  const t = num(tokens) ?? (num(cw.used_percentage) !== null && size ? (cw.used_percentage * size) / 100 : null);
  const pct = num(cw.used_percentage) ?? (t !== null && size ? (100 * t) / size : null);
  const mark = t === null ? "" : t > cfg.hard_ctx ? " RELAY NOW" : t > cfg.relay_ctx ? " relay" : "";
  const head = [], tail = [];
  if (model) head.push(`◆ ${model}${size ? ` · ${windowText(size)}` : ""}`);
  if (eff) head.push(`effort ${eff}`);
  if (pct !== null) head.push(`ctx ${ctxBar(pct)} ${Math.round(pct)}%${mark}`);
  else if (t !== null) head.push(ctxText(t, cfg)); // a count but no window size: `ctx 263k relay`
  if (num(reading?.pct) !== null) head.push(`5h ${pctText(reading.pct)}`);
  const wk = num(reading?.week_pct) !== null ? `wk ${pctText(reading.week_pct)}` : null;
  let pace = null;
  if (entry && entry.state !== "ok") {
    const a = Math.max(-Infinity, ...[entry.ahead, entry.week_ahead].filter(Number.isFinite));
    pace = `pace ${entry.state}${(entry.state === "slow" || entry.state === "hold") && a > 0 ? ` +${Math.round(a)}` : ""}`;
  }
  const agents = runningAgents(input?.tasks);
  if (agents !== null) tail.push(`◇ ${agents} agents`);
  const line = (w, p) => [...head, ...(w ? [w] : []), ...(p ? [p] : []), ...tail].join(" │ ");
  for (const [w, p] of [[wk, pace], [wk, null], [null, null]]) { const l = line(w, p); if (l.length <= max) return l; }
  return line(null, null);
}
const ms = (s) => (Number.isFinite(s) ? s * 1000 : NaN);
const isoMin = (t) => (Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16)}Z` : "-");
// `coord.mjs pace`: one line per provider (times in UTC).
export function paceTable(pace) {
  const rows = providersOf(pace).map(([p, e]) => `${p}: ${e.state}  5h ${pctText(e.pct)} ahead ${signed(e.ahead)} resets ${isoMin(ms(e.resets_at))}`
    + `  week ${pctText(e.week_pct)} ahead ${signed(e.week_ahead)} resets ${isoMin(ms(e.week_resets_at))}  since ${isoMin(e.since)}`);
  return rows.length ? rows : ["no usage readings"];
}
// The status header of `launch.mjs status` and `sessions` (B2): `pace: claude 5h 42% wk 31% slow · codex wk 12% ok`.
export function paceHeader(pace) {
  const rows = providersOf(pace).map(([p, e]) => [p, ...(Number.isFinite(e.pct) ? [`5h ${pctText(e.pct)}`] : []), ...(Number.isFinite(e.week_pct) ? [`wk ${pctText(e.week_pct)}`] : []), e.state].join(" "));
  return rows.length ? `pace: ${rows.join(" · ")}` : null;
}
// ---------- Part 8: the controller's context discipline (never blocks: a status-line part and a nudge) ----------
export const CTX_DEFAULTS = Object.freeze({ relay_ctx: 250000, hard_ctx: 400000 });
// config.json's flat relay_ctx / hard_ctx (positive numbers; anything else: the default).
export function ctxConfig(o) {
  const c = { ...CTX_DEFAULTS };
  for (const k of Object.keys(CTX_DEFAULTS)) if (typeof o?.[k] === "number" && Number.isFinite(o[k]) && o[k] > 0) c[k] = o[k];
  return c;
}
// The current context of a main thread: its last assistant message's input + cache read + cache creation tokens (records
// of subagents, isSidechain, are skipped). entries: transcript records, oldest first. -> tokens, or null when none.
export function contextOfEntries(entries) {
  for (let i = (entries || []).length - 1; i >= 0; i--) {
    const x = entries[i], u = x?.type === "assistant" && !x.isSidechain ? x.message?.usage : null;
    if (u && typeof u === "object") return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return null;
}
// The status line's own context field when it has one (context_window.current_usage), else null (the caller reads the
// transcript tail).
export function contextOfStatus(input) {
  const u = input?.context_window?.current_usage;
  return isObj(u) ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
}
const kTok = (n) => `${Math.round(n / 1000)}k`;
// The status line's part: `ctx 263k`, past relay_ctx `ctx 263k relay`, past hard_ctx `ctx 402k RELAY NOW`; null without a count.
export function ctxText(tokens, cfg = CTX_DEFAULTS) {
  if (!Number.isFinite(tokens)) return null;
  return `ctx ${kTok(tokens)}${tokens > cfg.hard_ctx ? " RELAY NOW" : tokens > cfg.relay_ctx ? " relay" : ""}`;
}
export const CTX_RELAY_TEXT = (t, c) => `Context ${kTok(t)} is past the ${kTok(c.relay_ctx)} relay rule: this dispatch is your task boundary. Relay with handoff-launch after it (or finish before an idle gap; above ~200k an idle gap expires the cache).`;
export const CTX_HARD_TEXT = (t, c) => `Context ${kTok(t)} is past the ${kTok(c.hard_ctx)} hard cap: write the handoff and relay now.`;
// The Agent gate's nudge (main thread only - the caller skips a subagent's call). seen: the session's marker {relay,
// hard_at}. Past hard_ctx: one line, again at most every 10 min; past relay_ctx: one line, once. -> {kind: "relay" |
// "hard", text, ctx: the new marker} or null. The dispatch is always allowed.
export function ctxNudge({ tokens, seen = {}, now, cfg = CTX_DEFAULTS }) {
  if (!Number.isFinite(tokens)) return null;
  const s = isObj(seen) ? seen : {};
  if (tokens > cfg.hard_ctx) return Number.isFinite(s.hard_at) && s.hard_at <= now && now - s.hard_at < 10 * MIN ? null : { kind: "hard", text: CTX_HARD_TEXT(tokens, cfg), ctx: { ...s, relay: true, hard_at: now } };
  if (tokens > cfg.relay_ctx) return s.relay === true ? null : { kind: "relay", text: CTX_RELAY_TEXT(tokens, cfg), ctx: { ...s, relay: true } };
  return null;
}
export const SLOW_DENY_TEXT = (e) => `Usage is ahead of pace (${aheadText(e)}). Low-priority lanes start no new agents now. Do the step inline at lower effort, or save state and end your turn; dispatch resumes when the pace eases.`;
export const SLOW_NOTICE_TEXT = (e) => `Usage ahead of pace (${aheadText(e)}): step effort down (\`effort-medium\`/\`low\`) and keep work small.`;
export const PAUSE_TEXT = (reason) => `Paused (${reason}): start no new agents or tasks. Let running agents finish, save state (ledger/handoff), mark open GOAL items \`[!] paused — ${reason}\`, then end your turn. Work resumes automatically.`;
// The Agent gate (Part 3; Part 5 passes pause). pace: a fresh pace.json (paceFresh) or null; priority: the session's
// (high for a hand-opened one); pause: pauseFor's answer {paused, reason} or null (B1 has none: hold and exhausted then
// act as slow). -> {deny: text} | {notice: text, since} | null (allow, say nothing). The caller says a notice once per
// session per since.
export function gateDecision({ pace, priority, pause = null }) {
  if (pause?.paused) return { deny: PAUSE_TEXT(pause.reason) };
  const e = isEntry(pace?.claude) ? pace.claude : null;
  if (!e || !(RANK[e.state] > 0)) return null;
  if (priority === "low") return { deny: SLOW_DENY_TEXT(e) };
  return { notice: SLOW_NOTICE_TEXT(e), since: e.since };
}
````

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

````js
// clock, no processes: callers pass the registry lines, transcripts and `now` in (tests/recover-lib.test.mjs and
// tests/leaks.test.mjs cover each decision).
import crypto from "node:crypto";

export const MIN = 60000;
export const DEFAULTS = Object.freeze({ repeat_window: 20, repeat_count: 4, warn_streak: 3, stuck_min: 30, grace_min: 5,
  idle_close_min: 10, fresh_at_tokens: 400000, max_restarts: 2, tick_min: 5, alert_repeat_hours: 6,
  // batch A: background tasks (Part 2), dead starts (Part 3), checklists (Part 9)
  bg_task_max_min: 240, dead_close_min: 60, goal_missing_calls: 10, goal_stale_min: 40, goal_stale_changes: 5 });
export const REARM_MS = 60 * MIN; // the same signature within this of a cancel resumes at the grace step
// Probe 4 (plan Task 1): RESUME_WORKS = false if `claude --resume` failed on a killed transcript. Background lanes
// always restart fresh (controller ruling), whatever `claude --bg --resume` did in the probe.
````

**with:**

````js
// clock, no processes: callers pass the registry lines, transcripts and `now` in (tests/recover-lib.test.mjs and
// tests/leaks.test.mjs cover each decision).
import crypto from "node:crypto";
import { PACE_DEFAULTS, CTX_DEFAULTS, paceConfig } from "./pace-lib.mjs";

export const MIN = 60000;
export const DEFAULTS = Object.freeze({ repeat_window: 20, repeat_count: 4, warn_streak: 3, stuck_min: 30, grace_min: 5,
  idle_close_min: 10, fresh_at_tokens: 400000, max_restarts: 2, tick_min: 5, alert_repeat_hours: 6,
  // batch A: background tasks (Part 2), dead starts (Part 3), checklists (Part 9)
  bg_task_max_min: 240, dead_close_min: 60, goal_missing_calls: 10, goal_stale_min: 40, goal_stale_changes: 5,
  // batch B, Part 8: the controller's context discipline (pace-lib.mjs ctxConfig reads them for the hooks)
  ...CTX_DEFAULTS,
  // batch B: the pacer's thresholds, an object of its own (pace-lib.mjs PACE_DEFAULTS; config.json "pace": {...})
  pace: PACE_DEFAULTS });
export const REARM_MS = 60 * MIN; // the same signature within this of a cancel resumes at the grace step
// Probe 4 (plan Task 1): RESUME_WORKS = false if `claude --resume` failed on a killed transcript. Background lanes
// always restart fresh (controller ruling), whatever `claude --bg --resume` did in the probe.
````

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

````js
  let o; try { o = JSON.parse(text); } catch (e) { return { config, errors: [`config.json is not valid JSON: ${e.message}`] }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { config, errors: ["config.json must be a JSON object"] };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in DEFAULTS)) errors.push(`unknown key ${k}`);
    else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) errors.push(`${k} must be a positive number`);
    else config[k] = v;
````

**with:**

````js
  let o; try { o = JSON.parse(text); } catch (e) { return { config, errors: [`config.json is not valid JSON: ${e.message}`] }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { config, errors: ["config.json must be a JSON object"] };
  for (const [k, v] of Object.entries(o)) {
    if (k === "pace") { const p = paceConfig(v); config.pace = p.pace; errors.push(...p.errors); continue; }
    if (!(k in DEFAULTS)) errors.push(`unknown key ${k}`);
    else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) errors.push(`${k} must be a positive number`);
    else config[k] = v;
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pace-lib.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: PASS, `ℹ fail 0` (the old `recover-lib` loadConfig cases still pass: `pace` is in `DEFAULTS`).

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/pace-lib.mjs claude/skills/handoff-launch/recover-lib.mjs claude/skills/handoff-launch/tests/pace-lib.test.mjs
git commit -m "feat(pace): the pure pacer, status and gate texts, the context nudge (batch B, Parts 2, 3, 8)"
```

---

### Task 2: the recorder (`statusline`), `pace`, the Agent gate (pace + Part 8), the settings and the install

**Files:**
- Create: `claude/skills/handoff-launch/pace-io.mjs`
- Create: `claude/skills/handoff-launch/tests/pace.test.mjs`
- Create: `claude/skills/handoff-launch/tests/agent-gate.test.mjs`
- Modify: `claude/hooks/coord.mjs`
- Modify: `claude/settings.fragment.json`
- Modify: `INSTALL_PROMPT.md`

**Interfaces:**
- Consumes: Task 1's `pace-lib.mjs` (every name above); `live.mjs` `COORD`, `readJson`, `writeAtomic`,
  `readRegistry`; `lane-lib.mjs` `effectivePriority`.
- Produces: `pace-io.mjs` `USAGE_DIR`, `PACE_FILE`, `SEEN_DIR`, `KEEP_USAGE_MS`, `readReadings(dir?) -> [{...reading,
  file}]`, `recordReading(sid, reading, now, cfg) -> "written"|"unchanged"|"skipped"`, `recomputePace({now, cfg,
  minAgeMs, write}) -> {pace, prev, written}`, `staleUsageFiles(now) -> paths`. `coord.mjs` exports
  `statusline(input, raw) -> text`, `paceReport(json) -> text`, `agentGate(input, env) -> {deny}|{context}|null`; CLI
  `coord.mjs statusline | pace [--json] | agent-gate`. `statusline` prints `statusLineText`'s line with the tokens of
  Part 8 and the settings' effort (`settingsEffort`: `modelSettings[<model id>].effortLevel`, else `effortLevel`). `agentGate` returns at once unless `tool_name` matches
  `^(Agent|Task)$`. `pace-seen/<sid>` is `{since, ctx}` JSON; each notice is first claimed with an exclusive create of
  `pace-seen/<sid>.p<since>`, `.relay` or `.hard-<previous hard_at>` (only the creator speaks).
- If probe P1 failed: in `main`, print `{"systemMessage": r.context}` instead of the `additionalContext` object.
- `settings.fragment.json`: `statusLine` `{type: "command", command: "node \"__HOME__/.claude/hooks/coord.mjs\"
  statusline", padding: 0}` (no `refreshInterval`) and `hooks.PreToolUse` `[{matcher: "^(Agent|Task)$", hooks: [{...
  "coord.mjs\" agent-gate", timeout: 10}]}]` (anchored: never `TaskUpdate` or another `Task*` tool).

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pace.test.mjs`:

````js
// Batch B, Parts 1-2 on disk: the status-line recorder (`coord.mjs statusline`), pace.json and `coord.mjs pace`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sandbox, coordRun, COORD_MJS, tx } from "./helpers.mjs";

const MIN = 60000, SID = "11111111-2222-3333-4444-555555555555";
const S = (ms) => Math.round(ms / 1000);
// A status-line stdin: the 5-hour window half gone, the weekly one half gone (pace-lib.test.mjs's numbers).
const status = (o = {}) => ({ session_id: SID, model: { id: "claude-opus-5-5" }, rate_limits: {
  five_hour: { used_percentage: 42, resets_at: S(Date.now() + 150 * MIN) }, seven_day: { used_percentage: 31, resets_at: S(Date.now() + 5040 * MIN) } }, ...o });
const usageFile = (sb, sid = SID) => path.join(sb.coord, "usage", `${sid}.json`);
const paceFile = (sb) => path.join(sb.coord, "pace.json");
const readJ = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("statusline: records the reading, writes pace.json, prints one short line", () => {
  const sb = sandbox();
  try {
    const r = coordRun(sb, ["statusline"], { input: status() });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "5h 42% │ wk 31%\n"); // no model, effort or context fields in this stdin: their segments are dropped
    const u = readJ(usageFile(sb));
    assert.deepEqual([u.provider, u.pct, u.week_pct, typeof u.ts], ["claude", 42, 31, "number"]);
    const p = readJ(paceFile(sb));
    assert.equal(p.claude.state, "ok"); assert.equal(p.claude.pct, 42); assert.ok(Date.now() - p.updated < MIN);
  } finally { sb.cleanup(); }
});

test("statusline: no rate_limits writes nothing and prints only the pace part of a fresh pace.json", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["statusline"], { input: { session_id: SID } });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    assert.equal(fs.existsSync(path.join(sb.coord, "usage")), false); assert.equal(fs.existsSync(paceFile(sb)), false);
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(paceFile(sb), JSON.stringify({ updated: Date.now(), claude: { state: "slow", ahead: 12.4, week_ahead: 2, since: Date.now() } }));
    r = coordRun(sb, ["statusline"], { input: { session_id: SID } });
    assert.equal(r.out, "pace slow +12\n");
    fs.writeFileSync(paceFile(sb), JSON.stringify({ updated: Date.now() - 16 * MIN, claude: { state: "slow", since: 1 } })); // stale = absent
    assert.equal(coordRun(sb, ["statusline"], { input: { session_id: SID } }).out, "");
  } finally { sb.cleanup(); }
});

test("statusline: one window missing is recorded as null; the same values under 60 s old are not rewritten", () => {
  const sb = sandbox();
  try {
    const one = status({ rate_limits: { seven_day: { used_percentage: 31, resets_at: S(Date.now() + 5040 * MIN) } } });
    assert.equal(coordRun(sb, ["statusline"], { input: one }).out, "wk 31%\n");
    const u = readJ(usageFile(sb));
    assert.equal(u.pct, null); assert.equal(u.resets_at, null);
    fs.writeFileSync(usageFile(sb), JSON.stringify({ ...u, ts: u.ts - 30000 })); // the same values, 30 s old
    coordRun(sb, ["statusline"], { input: one });
    assert.equal(readJ(usageFile(sb)).ts, u.ts - 30000); // unchanged: not rewritten
    coordRun(sb, ["statusline"], { input: status() });
    assert.equal(readJ(usageFile(sb)).pct, 42); // changed: rewritten
  } finally { sb.cleanup(); }
});

test("statusline: pace.json is recomputed only when older than 30 s", () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(sb.coord, { recursive: true });
    const young = { updated: Date.now() - 10000, claude: { state: "slow", ahead: 11, week_ahead: 0, since: 5 } };
    fs.writeFileSync(paceFile(sb), JSON.stringify(young));
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "5h 42% │ wk 31% │ pace slow +11\n");
    assert.deepEqual(readJ(paceFile(sb)), young); // under 30 s old: kept
    fs.writeFileSync(paceFile(sb), JSON.stringify({ ...young, updated: Date.now() - 40000 }));
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "5h 42% │ wk 31%\n");
    assert.equal(readJ(paceFile(sb)).claude.state, "ok");
  } finally { sb.cleanup(); }
});

test("statusline: a status line the user had before runs first with the same stdin", () => {
  const sb = sandbox();
  try {
    const script = path.join(sb.tmp, "chain.cjs");
    fs.writeFileSync(script, "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => console.log('mine ' + JSON.parse(s).session_id.slice(0, 8)));\n");
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "statusline-chain.json"), JSON.stringify({ command: `"${process.execPath}" "${script}"` }));
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "mine 11111111\n5h 42% │ wk 31%\n");
    fs.writeFileSync(path.join(sb.coord, "statusline-chain.json"), JSON.stringify({ command: "exit 3" })); // a failing chain prints nothing of it
    assert.equal(coordRun(sb, ["statusline"], { input: status() }).out, "5h 42% │ wk 31%\n");
  } finally { sb.cleanup(); }
});

test("statusline fails safe: garbage stdin, an unwritable usage dir, a session id that is not a plain id", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["statusline"], { input: "{oops" });
    assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    fs.mkdirSync(sb.coord, { recursive: true }); fs.writeFileSync(path.join(sb.coord, "usage"), "a file, not a dir");
    r = coordRun(sb, ["statusline"], { input: status() });
    assert.equal(r.code, 0); assert.equal(r.err, "");
    fs.rmSync(path.join(sb.coord, "usage"));
    r = coordRun(sb, ["statusline"], { input: status({ session_id: "../x" }) });
    assert.equal(r.code, 0); assert.equal(fs.existsSync(path.join(sb.coord, "usage")), false);
  } finally { sb.cleanup(); }
});

test("two recorders at once leave valid JSON in usage/ and pace.json", async () => {
  const sb = sandbox();
  try {
    const one = (sid, pct) => new Promise((done) => {
      const p = spawn(process.execPath, [COORD_MJS, "statusline"], { env: sb.env, windowsHide: true });
      p.on("exit", done); p.stdin.end(JSON.stringify(status({ session_id: sid, rate_limits: { ...status().rate_limits, five_hour: { used_percentage: pct, resets_at: S(Date.now() + 150 * MIN) } } })));
    });
    for (let i = 0; i < 3; i++) await Promise.all([one("aaaa-1", 40 + i), one("bbbb-2", 50 + i), one("aaaa-1", 60 + i)]);
    for (const f of ["aaaa-1", "bbbb-2"]) assert.equal(typeof readJ(usageFile(sb, f)).pct, "number");
    const p = readJ(paceFile(sb));
    assert.equal(typeof p.claude.state, "string");
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "usage")).filter((f) => f.endsWith(".tmp")), []);
  } finally { sb.cleanup(); }
});

test("coord.mjs pace prints the table from the usage files (Codex included) and writes nothing; --json the object", () => {
  const sb = sandbox();
  try {
    assert.equal(coordRun(sb, ["pace"]).out, "no usage readings\n");
    fs.mkdirSync(path.join(sb.coord, "usage"), { recursive: true });
    const now = Date.now(), wk = S(now + 5040 * MIN);
    fs.writeFileSync(usageFile(sb), JSON.stringify({ ts: now - MIN, provider: "claude", pct: 60, resets_at: S(now + 150 * MIN), week_pct: 31, week_resets_at: wk }));
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-r1.json"), JSON.stringify({ ts: now - MIN, provider: "codex", pct: null, resets_at: null, week_pct: 12, week_resets_at: wk }));
    const r = coordRun(sb, ["pace"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^claude: slow {2}5h 60% ahead \+13 resets \S+Z {2}week 31% ahead -23 resets \S+Z {2}since \S+Z$/m);
    assert.match(r.out, /^codex: ok {2}5h - ahead - resets - {2}week 12% ahead -42 resets \S+Z {2}since \S+Z$/m);
    assert.equal(fs.existsSync(paceFile(sb)), false);
    // A corrupt Codex file, one with strings for numbers, and a list are skipped; the others still count.
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-bad.json"), "{");
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-str.json"), JSON.stringify({ ts: String(now), provider: "codex", week_pct: "99", week_resets_at: String(wk) }));
    fs.writeFileSync(path.join(sb.coord, "usage", "codex-list.json"), "[1, 2]");
    assert.equal(coordRun(sb, ["pace"]).out.replace(/since \S+/g, ""), r.out.replace(/since \S+/g, ""));
    const j = JSON.parse(coordRun(sb, ["pace", "--json"]).out);
    assert.deepEqual([j.claude.state, j.codex.state, typeof j.updated], ["slow", "ok", "number"]);
  } finally { sb.cleanup(); }
});

test("statusline: the user's layout from a full stdin; the context from context_window, else the transcript's tail; the settings' effort", () => {
  const sb = sandbox();
  try {
    const t = (tokens) => { const f = path.join(sb.tmp, `t-${tokens}.jsonl`); fs.writeFileSync(f, tx({ start: Date.now() - MIN }).tokens(tokens - 1000, 900, 100).user("go").call("Read", {}).entries().map((x) => JSON.stringify(x)).join("\n") + "\n"); return f; };
    const full = (o = {}) => status({ model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, effort: { level: "medium" },
      context_window: { context_window_size: 1000000, used_percentage: 26, current_usage: { input_tokens: 1000, cache_read_input_tokens: 255000, cache_creation_input_tokens: 4000 } }, ...o });
    let r = coordRun(sb, ["statusline"], { input: full() });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │ 5h 42% │ wk 31%\n");
    assert.ok(r.out.trim().length <= 110);
    // no context_window: Part 8's tokens from the transcript's tail, shown as a count (no window size to divide by)
    assert.equal(coordRun(sb, ["statusline"], { input: full({ context_window: undefined, transcript_path: t(402000) }) }).out, "◆ Opus 5.5 │ effort medium │ ctx 402k RELAY NOW │ 5h 42% │ wk 31%\n");
    // a window size and the tail's tokens, but no percentage: tokens / size
    assert.equal(coordRun(sb, ["statusline"], { input: full({ context_window: { context_window_size: 200000 }, transcript_path: t(12000) }) }).out, "◆ Opus 5.5 · 200k │ effort medium │ ctx ▰▱▱▱▱▱▱▱▱▱ 6% │ 5h 42% │ wk 31%\n");
    // no effort.level in stdin: the settings' (modelSettings for this model, else effortLevel); none: dropped
    fs.writeFileSync(path.join(sb.cfg, "settings.json"), JSON.stringify({ effortLevel: "high", modelSettings: { "claude-opus-5-5": { effortLevel: "low" } } }));
    assert.match(coordRun(sb, ["statusline"], { input: full({ effort: undefined }) }).out, /^◆ Opus 5\.5 · 1M │ effort low │ ctx /);
    fs.writeFileSync(path.join(sb.cfg, "settings.json"), JSON.stringify({ effortLevel: "high" }));
    assert.match(coordRun(sb, ["statusline"], { input: full({ effort: undefined }) }).out, /^◆ Opus 5\.5 · 1M │ effort high │ ctx /);
    fs.rmSync(path.join(sb.cfg, "settings.json"));
    assert.match(coordRun(sb, ["statusline"], { input: full({ effort: undefined }) }).out, /^◆ Opus 5\.5 · 1M │ ctx /);
    // no rate_limits: no 5h/wk part, nothing written
    assert.equal(coordRun(sb, ["statusline"], { input: { session_id: SID, model: { display_name: "Opus 5.5" } } }).out, "◆ Opus 5.5\n");
  } finally { sb.cleanup(); }
});
````

**Create** `claude/skills/handoff-launch/tests/agent-gate.test.mjs`:

````js
// Batch B, Part 3: the global Agent gate (`coord.mjs agent-gate`) and its settings entries.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { sandbox, coordRun, sessionLine, appendLine, tx, COORD_MJS } from "./helpers.mjs";
import { SLOW_DENY_TEXT, SLOW_NOTICE_TEXT, CTX_RELAY_TEXT, CTX_HARD_TEXT, CTX_DEFAULTS } from "../pace-lib.mjs";

const MIN = 60000, SID = "11111111-2222-3333-4444-555555555555";
const FRAGMENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "settings.fragment.json");
const ev = (o = {}) => ({ session_id: SID, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "x", prompt: "y" }, ...o });
const gate = (sb, env = {}, input = ev()) => coordRun(sb, ["agent-gate"], { input, env });
const out = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput : null);
const entry = (state, o = {}) => ({ state, pct: 60, ahead: 12.4, resets_at: 1, week_pct: 40, week_ahead: 6, week_resets_at: 2, since: 1000, ...o });
function setPace(sb, state, o = {}, updated = Date.now()) {
  fs.mkdirSync(sb.coord, { recursive: true });
  fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated, claude: entry(state, o) }));
}

test("agent gate: absent, stale or ok pace.json allows with no output, in any session", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null }); // a low-priority lane
    assert.deepEqual([gate(sb, { HL_SESSION_ID: "L@1" }).out, gate(sb).out], ["", ""]);
    setPace(sb, "slow", {}, Date.now() - 16 * MIN);
    assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }).out, "");
    setPace(sb, "ok");
    assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }).out, "");
  } finally { sb.cleanup(); }
});

test("agent gate at slow: a low-priority lane is denied every time; normal, high and hand-opened sessions get one notice per state entry", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null });          // derived low
    sessionLine(sb, { name: "N", id: "N@1", branch: "n", effort: "high", supersedes: null }); // normal
    setPace(sb, "slow");
    for (let i = 0; i < 2; i++) {
      const d = out(gate(sb, { HL_SESSION_ID: "L@1" }));
      assert.deepEqual(d, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SLOW_DENY_TEXT(entry("slow")) });
    }
    assert.deepEqual(out(gate(sb, { HL_SESSION_ID: "N@1" })), { hookEventName: "PreToolUse", additionalContext: SLOW_NOTICE_TEXT(entry("slow")) });
    assert.equal(gate(sb, { HL_SESSION_ID: "N@1" }).out, ""); // once per since
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace-seen", SID), "utf8")), { since: 1000 });
    const other = "22222222-3333-4444-5555-666666666666"; // a hand-opened session: high, its own marker
    assert.ok(out(gate(sb, {}, ev({ session_id: other }))).additionalContext);
    assert.equal(gate(sb, {}, ev({ session_id: other })).out, "");
    setPace(sb, "hold", { since: 2000 }); // a new state entry: told again
    assert.ok(out(gate(sb, {}, ev({ session_id: other }))).additionalContext);
    assert.equal(out(gate(sb, { HL_SESSION_ID: "L@1" })).permissionDecision, "deny"); // B1: hold acts as slow
  } finally { sb.cleanup(); }
});

test("agent gate: a hand-set priority wins over the derived one; an unknown HL_SESSION_ID counts as high", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null });
    appendLine(sb, { priority: "L", group: null, value: "normal", at: new Date().toISOString() });
    setPace(sb, "slow");
    assert.ok(out(gate(sb, { HL_SESSION_ID: "L@1" })).additionalContext); // normal now: a notice, no denial
    assert.ok(out(gate(sb, { HL_SESSION_ID: "nobody@1" }, ev({ session_id: "33333333-0000" }))).additionalContext);
  } finally { sb.cleanup(); }
});

test("agent gate fails open: garbage stdin, a corrupt pace.json, a non-plain session id, a missing skill folder", () => {
  const sb = sandbox();
  try {
    setPace(sb, "slow");
    for (const input of ["{oops", "", ev({ session_id: "../x" })]) {
      const r = gate(sb, {}, input);
      assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    }
    fs.writeFileSync(path.join(sb.coord, "pace.json"), "{not json");
    assert.equal(gate(sb).out, "");
    setPace(sb, "slow");
    const r = gate(sb, { HL_SKILL_DIR: path.join(sb.tmp, "missing") });
    assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
  } finally { sb.cleanup(); }
});

test("agent gate: only Agent and Task calls are judged - TaskUpdate, TaskCreate and the other Task* tools never (an unanchored matcher would fire on them)", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "L", id: "L@1", effort: "medium", supersedes: null });
    setPace(sb, "slow");
    for (const tool of ["TaskUpdate", "TaskCreate", "TaskStop", "TaskList", "Agentic"]) assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }, ev({ tool_name: tool })).out, "", tool);
    for (const tool of ["Agent", "Task"]) assert.equal(out(gate(sb, { HL_SESSION_ID: "L@1" }, ev({ tool_name: tool }))).permissionDecision, "deny", tool);
    assert.ok(new RegExp(JSON.parse(fs.readFileSync(FRAGMENT, "utf8")).hooks.PreToolUse[0].matcher).test("Task"));
    assert.ok(!new RegExp(JSON.parse(fs.readFileSync(FRAGMENT, "utf8")).hooks.PreToolUse[0].matcher).test("TaskUpdate")); // anchored
  } finally { sb.cleanup(); }
});

test("agent gate: two dispatches at once in one session say a notice once (the wx claim decides)", async () => {
  const sb = sandbox();
  try {
    setPace(sb, "slow");
    const one = () => new Promise((done) => {
      const p = spawn(process.execPath, [COORD_MJS, "agent-gate"], { env: sb.env, windowsHide: true });
      let o = ""; p.stdout.on("data", (x) => (o += x)); p.on("exit", () => done(o));
      p.stdin.end(JSON.stringify(ev()));
    });
    const outs = await Promise.all(Array.from({ length: 6 }, one));
    assert.equal(outs.filter((o) => o.includes("additionalContext")).length, 1);
    assert.ok(fs.existsSync(path.join(sb.coord, "pace-seen", `${SID}.p1000`)));
  } finally { sb.cleanup(); }
});

test("settings.fragment.json: the global statusLine and the PreToolUse Agent gate point at coord.mjs; the Stop hook is kept", () => {
  const f = JSON.parse(fs.readFileSync(FRAGMENT, "utf8"));
  assert.deepEqual(f.statusLine, { type: "command", command: 'node "__HOME__/.claude/hooks/coord.mjs" statusline', padding: 0 });
  assert.deepEqual(f.hooks.PreToolUse, [{ matcher: "^(Agent|Task)$", hooks: [{ type: "command", command: 'node "__HOME__/.claude/hooks/coord.mjs" agent-gate', timeout: 10 }] }]);
  assert.match(f.hooks.Stop[0].hooks[0].command, /goal-gate\.mjs/);
  assert.equal(f.statusLine.refreshInterval, undefined); // no timer: every run follows a real event
});

// Part 8: a transcript whose last main-thread assistant message used `tokens` of context.
const transcript = (sb, tokens) => { const f = path.join(sb.tmp, `t-${tokens}.jsonl`); fs.writeFileSync(f, tx({ start: Date.now() - MIN }).tokens(tokens - 1000, 900, 100).user("go").call("Read", { file_path: "x" }).entries().map((x) => JSON.stringify(x)).join("\n") + "\n"); return f; };
const ctxGate = (sb, tokens, o = {}, env = {}) => gate(sb, env, ev({ transcript_path: transcript(sb, tokens), ...o }));
const marker = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "pace-seen", SID), "utf8"));

test("context nudge: past relay_ctx one line, once; past hard_ctx at most every 10 min; under it nothing; a subagent's call never; never a denial", () => {
  const sb = sandbox();
  try {
    assert.equal(ctxGate(sb, 200000).out, "");
    assert.deepEqual(out(ctxGate(sb, 263000)), { hookEventName: "PreToolUse", additionalContext: CTX_RELAY_TEXT(263000, CTX_DEFAULTS) });
    assert.match(CTX_RELAY_TEXT(263000, CTX_DEFAULTS), /^Context 263k is past the 250k relay rule: this dispatch is your task boundary\. Relay with handoff-launch after it/);
    assert.equal(ctxGate(sb, 270000).out, ""); // once
    assert.equal(ctxGate(sb, 402000, { agent_id: "ag1" }).out, ""); // a subagent's call: skipped
    assert.deepEqual(out(ctxGate(sb, 402000)), { hookEventName: "PreToolUse", additionalContext: CTX_HARD_TEXT(402000, CTX_DEFAULTS) });
    assert.equal(CTX_HARD_TEXT(402000, CTX_DEFAULTS), "Context 402k is past the 400k hard cap: write the handoff and relay now.");
    assert.equal(ctxGate(sb, 405000).out, ""); // within 10 min
    const m = marker(sb);
    fs.writeFileSync(path.join(sb.coord, "pace-seen", SID), JSON.stringify({ ...m, ctx: { ...m.ctx, hard_at: Date.now() - 11 * MIN } }));
    assert.equal(out(ctxGate(sb, 410000)).additionalContext, CTX_HARD_TEXT(410000, CTX_DEFAULTS)); // 10 min later: again
    for (const r of [ctxGate(sb, 263000), ctxGate(sb, 500000)]) assert.equal(r.out ? out(r).permissionDecision : undefined, undefined);
  } finally { sb.cleanup(); }
});

test("context nudge with the pace notice: both lines, both markers; a pace denial wins; thresholds from config.json; errors allow", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "N", id: "N@1", effort: "high", sid: SID, supersedes: null });
    sessionLine(sb, { name: "L", id: "L@1", branch: "l", effort: "medium", supersedes: null });
    setPace(sb, "slow");
    assert.equal(out(ctxGate(sb, 263000, {}, { HL_SESSION_ID: "N@1" })).additionalContext, `${SLOW_NOTICE_TEXT(entry("slow"))}\n${CTX_RELAY_TEXT(263000, CTX_DEFAULTS)}`);
    assert.deepEqual(marker(sb), { since: 1000, ctx: { relay: true } });
    assert.equal(out(ctxGate(sb, 263000, {}, { HL_SESSION_ID: "L@1" })).permissionDecision, "deny"); // low at slow
    fs.rmSync(path.join(sb.coord, "pace.json")); fs.rmSync(path.join(sb.coord, "pace-seen"), { recursive: true }); // the markers and their claims
    fs.writeFileSync(path.join(sb.coord, "config.json"), JSON.stringify({ relay_ctx: 100000, hard_ctx: "x" }));
    assert.equal(out(ctxGate(sb, 120000)).additionalContext, CTX_RELAY_TEXT(120000, { ...CTX_DEFAULTS, relay_ctx: 100000 }));
    for (const tp of [path.join(sb.tmp, "missing.jsonl"), sb.tmp]) {
      const r = gate(sb, {}, ev({ transcript_path: tp }));
      assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    }
    const junk = path.join(sb.tmp, "junk.jsonl"); fs.writeFileSync(junk, "{oops\nnot json\n");
    assert.equal(gate(sb, {}, ev({ transcript_path: junk })).out, "");
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pace.test.mjs claude/skills/handoff-launch/tests/agent-gate.test.mjs claude/skills/handoff-launch/tests/coord-hook.test.mjs claude/skills/handoff-launch/tests/pace-lib.test.mjs`
Expected: FAIL - the `statusline`, `pace` and `agent-gate` subcommands print nothing; the fragment has no `statusLine`.

- [ ] **Step 3: Implement**

**Create** `claude/skills/handoff-launch/pace-io.mjs`:

````js
// Usage readings and pace.json on disk (batch B, Parts 1-2). The status-line recorder (hooks/coord.mjs statusline), the
// tick (recover.mjs) and `coord.mjs pace` call these; the decisions are pace-lib.mjs's. Files, all under <coord>:
//   usage/<session_id>.json   one Claude session's newest reading (its status line writes it)
//   usage/codex-<run-id>.json a Codex run's reading (the codex-dual adapter writes it; Codex keeps its newest 20)
//   pace.json                 {updated, <provider>: {...}} (writeAtomic: two writers at once leave one whole file)
//   pace-seen/<session_id>    the `since` of the pace state this session was last told about (the Agent gate)
import fs from "node:fs";
import path from "node:path";
import { COORD, readJson, writeAtomic } from "./live.mjs";
import { paceState, sameReading, PACE_DEFAULTS } from "./pace-lib.mjs";

export const USAGE_DIR = path.join(COORD, "usage");
export const PACE_FILE = path.join(COORD, "pace.json");
export const SEEN_DIR = path.join(COORD, "pace-seen");
export const KEEP_USAGE_MS = 8 * 24 * 3600e3; // Claude readings and pace-seen markers older than this are pruned
const plainId = (v) => typeof v === "string" && /^[\w-]+$/.test(v);

// Every reading in usage/ (an unreadable file, or one without a numeric ts, is skipped). -> [{...reading, file}]
export function readReadings(dir = USAGE_DIR) {
  let names = []; try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) { const r = readJson(path.join(dir, f), null); if (r && !Array.isArray(r) && Number.isFinite(r.ts)) out.push({ ...r, file: f }); }
  return out;
}
// Write one Claude session's reading, unless the file holds the same values and is under unchanged_s old.
// -> "written" | "unchanged" | "skipped" (the session id is not a plain id: it names a file)
export function recordReading(sid, reading, now, cfg = PACE_DEFAULTS) {
  if (!plainId(sid) || !reading) return "skipped";
  const f = path.join(USAGE_DIR, `${sid}.json`);
  if (sameReading(reading, readJson(f, null), now, cfg)) return "unchanged";
  writeAtomic(f, JSON.stringify(reading));
  return "written";
}
// pace.json recomputed from usage/ unless the current one is younger than minAgeMs (0: always). write false: compute
// only (a dry run, `coord.mjs pace`). -> {pace, prev, written}
export function recomputePace({ now = Date.now(), cfg = PACE_DEFAULTS, minAgeMs = 0, write = true } = {}) {
  const prev = readJson(PACE_FILE, null);
  const age = prev && Number.isFinite(prev.updated) ? now - prev.updated : Infinity;
  if (age >= 0 && age < minAgeMs) return { pace: prev, prev, written: false };
  const pace = { updated: now, ...paceState({ readings: readReadings(), prev, now, cfg }) };
  if (write) writeAtomic(PACE_FILE, JSON.stringify(pace, null, 2));
  return { pace, prev, written: write };
}
// Housekeeping (the tick's hourly prune): Claude readings (usage/<sid>.json, never codex-*) whose ts is older than 8
// days, and pace-seen markers whose mtime is. -> the paths
export function staleUsageFiles(now) {
  const old = (f) => { try { return now - fs.statSync(f).mtimeMs > KEEP_USAGE_MS; } catch { return false; } };
  const readings = readReadings().filter((r) => !r.file.startsWith("codex-") && now - r.ts > KEEP_USAGE_MS).map((r) => path.join(USAGE_DIR, r.file));
  let seen = []; try { seen = fs.readdirSync(SEEN_DIR).map((f) => path.join(SEEN_DIR, f)).filter(old); } catch {}
  return [...readings, ...seen];
}
````

**Replace** in `claude/hooks/coord.mjs`:

````js
//   tick [--dry-run]  one coordinator tick (recover.mjs); --dry-run prints what it would do and writes nothing.
//   relay        Stop-hook helper: on a fresh Stop of a non-launcher session, claim one alert and ask the session to push it
//   alert-sent <file> | alert-release <file>   mark a claimed alert sent, or put it back
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any hook error: exit 0
// and no output - a broken hook must never block a tool call. A failed tick exits 1 (its trigger never waits on it, so
// only a hand or scheduled run sees the code): an import failure is shown on stderr, a failure inside the tick is its
````

**with:**

````js
//   tick [--dry-run]  one coordinator tick (recover.mjs); --dry-run prints what it would do and writes nothing.
//   relay        Stop-hook helper: on a fresh Stop of a non-launcher session, claim one alert and ask the session to push it
//   alert-sent <file> | alert-release <file>   mark a claimed alert sent, or put it back
//   statusline   the GLOBAL statusLine command (batch B, Part 1): records this session's usage reading, refreshes pace.json
//                when older than 30 s, prints `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% │ 5h 6% │ wk 31%`
//   pace [--json]  the pacer's table (pace-lib.mjs), computed from the usage files now; writes nothing
//   agent-gate   the GLOBAL PreToolUse hook on Agent|Task (batch B, Part 3): denies a low-priority lane's dispatch while
//                the pace is slow or worse, and tells the others once per state entry to step effort down
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any hook error: exit 0
// and no output - a broken hook must never block a tool call. A failed tick exits 1 (its trigger never waits on it, so
// only a hand or scheduled run sees the code): an import failure is shown on stderr, a failure inside the tick is its
````

**Replace** in `claude/hooks/coord.mjs`:

````js
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// <config>/hooks/coord.mjs -> <config>/skills/handoff-launch (the repo has the same layout). HL_SKILL_DIR: tests.
````

**with:**

````js
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// <config>/hooks/coord.mjs -> <config>/skills/handoff-launch (the repo has the same layout). HL_SKILL_DIR: tests.
````

**Replace** in `claude/hooks/coord.mjs`:

````js
// Start a tick if tick_min has passed since the last one (live.mjs triggerTick: detached, fails closed). -> bool
export async function startTick(by) { const { V, cfg } = await context(); return V.triggerTick(by, cfg.tick_min); }

const stdin = () => { try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; } };
// Wait for the write before process.exit (a pipe may flush asynchronously); a closed pipe is ignored, not thrown.
const write = (text) => new Promise((done) => { process.stdout.on("error", done); process.stdout.write(text, done); });
async function main(argv) {
````

**with:**

````js
// Start a tick if tick_min has passed since the last one (live.mjs triggerTick: detached, fails closed). -> bool
export async function startTick(by) { const { V, cfg } = await context(); return V.triggerTick(by, cfg.tick_min); }

// ---------- batch B, Parts 1-3: the status-line recorder, `pace`, the Agent gate ----------
// The pacer's thresholds: config.json "pace" (pace-lib paceConfig; missing or bad = the defaults).
const paceCfg = (P) => P.paceConfig(readJson(path.join(COORD, "config.json"), {})?.pace).pace;
// A status line the user had before the install (<coord>/statusline-chain.json {command}, written by the install) runs
// first with the same stdin; its output is printed first. 5 s at most; a failure prints nothing of it.
function chainOutput(raw) {
  const c = readJson(path.join(COORD, "statusline-chain.json"), null);
  if (!str(c?.command)) return "";
  const r = spawnSync(c.command, { shell: true, input: raw, encoding: "utf8", timeout: 5000, windowsHide: true });
  return String(r.stdout || "").replace(/\s+$/, "");
}
// The effort the settings give this model when the status line's stdin has no effort.level: <config>/settings.json
// modelSettings[<model id>].effortLevel, else effortLevel. -> a word or null
function settingsEffort(input) {
  const s = readJson(path.join(CFG, "settings.json"), {}), id = input?.model?.id;
  const m = str(id) && isObj(s.modelSettings?.[id]) ? s.modelSettings[id].effortLevel : null;
  return str(m) ? m : str(s.effortLevel) ? s.effortLevel : null;
}
// Part 1. input: the status line's stdin (raw: its text, for the chained command). With rate_limits: this session's
// reading (usage/<session_id>.json, skipped when unchanged and under 60 s old), then pace.json when it is older than
// recompute_s (two sessions at once: the last atomic rename wins, harmless). Without: nothing is written. -> the text to
// print: the chained output, then pace-lib statusLineText's line (`◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26%
// relay │ 5h 6% │ wk 31% │ pace slow +12`; a missing field drops its segment). Never throws.
export async function statusline(input, raw = "") {
  const out = [];
  try { const c = chainOutput(raw); if (c) out.push(c); } catch {}
  try {
    const [P, IO] = await Promise.all([mod("pace-lib.mjs"), mod("pace-io.mjs")]);
    const cfg = paceCfg(P), now = Date.now(), reading = P.readingFromStatus(input, now);
    let pace = readJson(IO.PACE_FILE, null);
    if (reading) {
      IO.recordReading(input?.session_id, reading, now, cfg);
      pace = IO.recomputePace({ now, cfg, minAgeMs: cfg.recompute_s * 1000 }).pace;
    }
    // Part 8: the context of this session (the status line's own field, else its transcript's tail)
    const tokens = P.contextOfStatus(input) ?? contextOf(input?.transcript_path, P);
    const line = P.statusLineText({ input, reading, entry: P.paceFresh(pace, now, cfg)?.claude ?? null, tokens,
      cfg: P.ctxConfig(readJson(path.join(COORD, "config.json"), {})), effort: settingsEffort(input) });
    if (line) out.push(line);
  } catch {}
  return out.join("\n");
}
// `coord.mjs pace [--json]`: computed from the usage files now, written nowhere.
export async function paceReport(json) {
  const [P, IO] = await Promise.all([mod("pace-lib.mjs"), mod("pace-io.mjs")]);
  const { pace } = IO.recomputePace({ cfg: paceCfg(P), write: false });
  return json ? JSON.stringify(pace, null, 2) : P.paceTable(pace).join("\n");
}
// The session's priority for the gate: a launcher lane's effective priority (its registry entry, by HL_SESSION_ID); any
// other session - or a lane whose entry is not found - is high: the user is at it.
async function priorityOf(env) {
  if (!str(env.HL_SESSION_ID)) return "high";
  const [V, G] = await Promise.all([mod("live.mjs"), mod("lane-lib.mjs")]);
  const reg = V.readRegistry(), e = [...reg.entries].reverse().find((x) => x.id === env.HL_SESSION_ID);
  return e ? G.effectivePriority(reg.lines, e) : "high";
}
// Part 8: the last ~64 KB of a transcript -> its main thread's current context (pace-lib contextOfEntries), or null.
function contextOf(file, P) {
  if (!str(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, n = Math.min(size, 65536), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (n < size) lines.shift(); // a cut first line
    return P.contextOfEntries(lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
// A once-claim (exclusive create): of two gates of one session deciding the same notice at once, only the one that
// creates <marker>.<key> speaks. Claims are pruned with the markers (pace-seen/, 8 days by mtime). -> true for the winner
function claim(seenFile, key) {
  if (!seenFile) return false;
  try { fs.mkdirSync(path.dirname(seenFile), { recursive: true }); fs.writeFileSync(`${seenFile}.${key}`, "", { flag: "wx" }); return true; } catch { return false; }
}
// Part 3. Every session runs it (no early return without HL_SESSION_ID). A missing, stale (stale_min) or ok pace.json
// says nothing. slow and above (B1: hold and exhausted act as slow): a low-priority session is denied; any other gets one
// notice per state entry. Part 8: a main-thread call (a subagent's carries agent_id) past relay_ctx gets the context
// nudge (pace-lib ctxNudge) - never a denial. Both once-markers live in pace-seen/<session_id> ({since, ctx}); without a
// plain session id nothing is said. -> {deny} | {context} | null (allow, no output)
export async function agentGate(input, env = process.env) {
  if (!/^(Agent|Task)$/.test(String(input?.tool_name ?? ""))) return null; // the matcher's rule again: never TaskUpdate, TaskCreate, ...
  const P = await mod("pace-lib.mjs"), now = Date.now(), cfg = paceCfg(P);
  const sid = plainId(input?.session_id) ? input.session_id : null, notes = [];
  const seenFile = sid ? path.join(COORD, "pace-seen", sid) : null, seen = seenFile ? readJson(seenFile, {}) : {}, next = { ...seen };
  const pace = P.paceFresh(readJson(path.join(COORD, "pace.json"), null), now, cfg);
  if (pace && P.isEntry(pace.claude) && pace.claude.state !== "ok") {
    const d = P.gateDecision({ pace, priority: await priorityOf(env) });
    if (d?.deny) return { deny: d.deny };
    if (d?.notice && seen.since !== d.since && claim(seenFile, `p${d.since}`)) { notes.push(d.notice); next.since = d.since; }
  }
  try { // Part 8, main thread only; any error says nothing
    if (!input?.agent_id) {
      const n = P.ctxNudge({ tokens: contextOf(input?.transcript_path, P), seen: seen.ctx, now, cfg: P.ctxConfig(readJson(path.join(COORD, "config.json"), {})) });
      if (n && claim(seenFile, n.kind === "hard" ? `hard-${seen.ctx?.hard_at ?? 0}` : "relay")) { notes.push(n.text); next.ctx = n.ctx; }
    }
  } catch {}
  if (!notes.length || !seenFile) return null;
  fs.mkdirSync(path.dirname(seenFile), { recursive: true });
  fs.writeFileSync(seenFile, JSON.stringify(next));
  return { context: notes.join("\n") };
}

const stdinRaw = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
const stdin = () => { try { return JSON.parse(stdinRaw() || "{}"); } catch { return {}; } };
// Wait for the write before process.exit (a pipe may flush asynchronously); a closed pipe is ignored, not thrown.
const write = (text) => new Promise((done) => { process.stdout.on("error", done); process.stdout.write(text, done); });
async function main(argv) {
````

**Replace** in `claude/hooks/coord.mjs`:

````js
    if (msg) await write(JSON.stringify({ decision: "block", reason: msg }));
  } else if (sub === "alert-sent") await write(`${await alertSent(argv[1])}\n`);
  else if (sub === "alert-release") await write(`${await alertRelease(argv[1])}\n`);
  return 0;
}
const self = (p) => path.resolve(p || "").toLowerCase();
````

**with:**

````js
    if (msg) await write(JSON.stringify({ decision: "block", reason: msg }));
  } else if (sub === "alert-sent") await write(`${await alertSent(argv[1])}\n`);
  else if (sub === "alert-release") await write(`${await alertRelease(argv[1])}\n`);
  else if (sub === "statusline") {
    const raw = stdinRaw(); let input = {}; try { input = JSON.parse(raw || "{}"); } catch {}
    const line = await statusline(input, raw);
    if (line) await write(`${line}\n`);
  } else if (sub === "pace") await write(`${await paceReport(argv.includes("--json"))}\n`);
  else if (sub === "agent-gate") {
    const r = await agentGate(stdin());
    if (r?.deny) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.deny } }));
    else if (r?.context) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: r.context } }));
  }
  return 0;
}
const self = (p) => path.resolve(p || "").toLowerCase();
````

**Replace** in `claude/settings.fragment.json`:

````json
      "effortLevel": "medium"
    }
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
````

**with:**

````json
      "effortLevel": "medium"
    }
  },
  "statusLine": {
    "type": "command",
    "command": "node \"__HOME__/.claude/hooks/coord.mjs\" statusline",
    "padding": 0
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Agent|Task)$",
        "hooks": [
          {
            "type": "command",
            "command": "node \"__HOME__/.claude/hooks/coord.mjs\" agent-gate",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
````

**Replace** in `INSTALL_PROMPT.md`:

````markdown
   - In the hook command, replace the quoted path "__HOME__/.claude/hooks/goal-gate.mjs" with the absolute path of
     CONFIG/hooks/goal-gate.mjs, using forward slashes (e.g. "C:/Users/me/.claude/hooks/goal-gate.mjs"). Keep the
     double quotes; they protect paths with spaces.
     Check that `node --version` reports 18 or newer.
   - hooks.Stop: add the goal-gate entry unless one already points at goal-gate.mjs; keep my existing hooks.
````

**with:**

````markdown
   - In every hook command and in the statusLine command, replace the quoted "__HOME__/.claude/hooks/<file>" with the
     absolute path of CONFIG/hooks/<file>, using forward slashes (e.g. "C:/Users/me/.claude/hooks/goal-gate.mjs"). Keep
     the double quotes; they protect paths with spaces.
     Check that `node --version` reports 18 or newer.
   - hooks.Stop: add the goal-gate entry unless one already points at goal-gate.mjs; keep my existing hooks.
   - hooks.PreToolUse: add the `^(Agent|Task)$` entry (`coord.mjs agent-gate`, the usage-pacing gate; anchored, so it
     never runs for TaskUpdate and the other Task* tools) unless one already runs `coord.mjs agent-gate`; keep my
     existing hooks.
   - statusLine (the usage recorder, `coord.mjs statusline`): if I have no statusLine, set the fragment's. If I have
     one, keep its command: write `{"command": "<my command>"}` to CONFIG/state/coord/statusline-chain.json (the
     recorder runs it first with the same input and prints its output first), then set the fragment's statusLine, and
     tell me.
````

**Replace** in `INSTALL_PROMPT.md`:

````markdown
   - `echo {} | node "CONFIG/hooks/coord.mjs" post-tool` exits 0 with no output, and
     `node "CONFIG/hooks/coord.mjs" tick --dry-run` prints `tick: nothing to do` (or the lines of what it would do).
     coord.mjs is not added to settings.json: launch.mjs passes it to each session it starts.
````

**with:**

````markdown
   - `echo {} | node "CONFIG/hooks/coord.mjs" post-tool` exits 0 with no output, and
     `node "CONFIG/hooks/coord.mjs" tick --dry-run` prints `tick: nothing to do` (or the lines of what it would do).
     `echo {} | node "CONFIG/hooks/coord.mjs" agent-gate` and `echo {} | node "CONFIG/hooks/coord.mjs" statusline`
     exit 0 with no output. In settings.json coord.mjs is only the status line and the Agent gate; launch.mjs passes
     its session hooks to each session it starts.
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pace.test.mjs claude/skills/handoff-launch/tests/agent-gate.test.mjs claude/skills/handoff-launch/tests/coord-hook.test.mjs claude/skills/handoff-launch/tests/pace-lib.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/pace-io.mjs claude/hooks/coord.mjs claude/settings.fragment.json INSTALL_PROMPT.md claude/skills/handoff-launch/tests/pace.test.mjs claude/skills/handoff-launch/tests/agent-gate.test.mjs
git commit -m "feat(pace): status-line recorder, coord.mjs pace, the global Agent gate with the context nudge (batch B, Parts 1, 3, 8)"
```

---

### Task 3: the tick: `pace.json` first in every unrestricted tick; the hourly prune of `usage/`, `pace-seen/`, `pane/`

**Files:**
- Create: `claude/skills/handoff-launch/tests/pace-tick.test.mjs`
- Modify: `claude/skills/handoff-launch/recover.mjs`

**Interfaces:**
- Consumes: `pace-io.mjs` `recomputePace`, `staleUsageFiles`, `PACE_FILE`; `pace-lib.mjs` `providersOf`, `isEntry`,
  `aheadText`.
- Produces: `recover.mjs` imports `* as P from "./pace-lib.mjs"` and `* as IO from "./pace-io.mjs"` (Tasks 11, 13 use
  them); `paceTick({dryRun, cfg, now}) -> lines` runs right after `releaseStaleClaims` (Task 20 adds `powerTick` before
  it); the prune's extra summary line `prune: removed <n> old usage reading(s), pace-seen marker(s) and pane file(s)`.
  The stage-2 prune line keeps its exact shape (`tests/leaks.test.mjs:337`).

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pace-tick.test.mjs`:

````js
// Batch B, Part 2 in the tick: pace.json at every unrestricted tick, and the hourly prune of usage/, pace-seen/ and pane/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun } from "./helpers.mjs";

const MIN = 60000, DAY = 24 * 60 * MIN, S = (ms) => Math.round(ms / 1000);
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const fwd = (p) => p.split(path.sep).join("/");
const put = (f, o, mtimeMs) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); if (mtimeMs) fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs)); return f; };

test("the tick rewrites pace.json from the usage files and says a state change once; a dry run writes nothing", () => {
  const sb = sandbox();
  try {
    const now = Date.now(), u = path.join(sb.coord, "usage", "s-1.json");
    put(u, { ts: now - MIN, provider: "claude", pct: 60, resets_at: S(now + 150 * MIN), week_pct: 31, week_resets_at: S(now + 5040 * MIN) });
    const dry = tick(sb, "--dry-run");
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /^would set pace: claude ok -> slow \(5h \+13 \/ week -23\)$/m);
    assert.equal(fs.existsSync(path.join(sb.coord, "pace.json")), false);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pace: claude ok -> slow \(5h \+13 \/ week -23\)$/m);
    const p = JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8"));
    assert.equal(p.claude.state, "slow");
    r = tick(sb);
    assert.doesNotMatch(r.out, /^pace:/m); // unchanged: nothing said
    assert.ok(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8")).updated >= p.updated);
  } finally { sb.cleanup(); }
});

test("the tick without usage files writes {updated} and prints nothing about pace", () => {
  const sb = sandbox();
  try {
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /^(would set )?pace:/m);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8"))), ["updated"]);
  } finally { sb.cleanup(); }
});

test("hourly prune: Claude readings and pace-seen markers older than 8 days, pane files older than 1 day; Codex readings never", () => {
  const sb = sandbox();
  try {
    const now = Date.now(), c = (...p) => path.join(sb.coord, ...p);
    const oldReading = put(c("usage", "old-1.json"), { ts: now - 9 * DAY, pct: 1, resets_at: 1, week_pct: 1, week_resets_at: 1 });
    const newReading = put(c("usage", "new-1.json"), { ts: now - 7 * DAY, pct: 1, resets_at: 1, week_pct: 1, week_resets_at: 1 });
    const codex = put(c("usage", "codex-r1.json"), { ts: now - 30 * DAY, provider: "codex", pct: null, resets_at: null, week_pct: 1, week_resets_at: 1 });
    const oldSeen = put(c("pace-seen", "old-1"), "1", now - 9 * DAY), newSeen = put(c("pace-seen", "new-1"), "1", now - 7 * DAY);
    const oldPane = put(c("pane", "old-1.json"), {}, now - 25 * 3600e3), newPane = put(c("pane", "new-1.json"), {}, now - 23 * 3600e3);
    const otherPane = put(c("pane", "notes.txt"), "x", now - 30 * DAY);
    const dry = tick(sb, "--dry-run");
    assert.deepEqual(dry.out.split("\n").filter((l) => l.startsWith("would prune ")).sort(), [oldReading, oldSeen, oldPane].map((f) => `would prune ${fwd(f)}`).sort());
    const r = tick(sb);
    assert.match(r.out, /^prune: removed 3 old usage reading\(s\), pace-seen marker\(s\) and pane file\(s\)$/m);
    for (const f of [oldReading, oldSeen, oldPane]) assert.equal(fs.existsSync(f), false, f);
    for (const f of [newReading, codex, newSeen, newPane, otherPane]) assert.equal(fs.existsSync(f), true, f);
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pace-tick.test.mjs claude/skills/handoff-launch/tests/leaks.test.mjs`
Expected: FAIL - no `pace:` line, no `pace.json`, nothing pruned.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
import * as V from "./live.mjs";
import * as G from "./lane-lib.mjs";
import { fwd, stem, isMergeSession } from "./merge-lib.mjs";

// HL_LAUNCH_MJS: tests stand a fake launcher in for launch.mjs.
const LAUNCH = process.env.HL_LAUNCH_MJS || path.join(V.HERE, "launch.mjs");
````

**with:**

````js
import * as V from "./live.mjs";
import * as G from "./lane-lib.mjs";
import { fwd, stem, isMergeSession } from "./merge-lib.mjs";
import * as P from "./pace-lib.mjs";
import * as IO from "./pace-io.mjs";

// HL_LAUNCH_MJS: tests stand a fake launcher in for launch.mjs.
const LAUNCH = process.env.HL_LAUNCH_MJS || path.join(V.HERE, "launch.mjs");
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
  };
}
const entryWord = (n) => `entr${n === 1 ? "y" : "ies"}`;
// One summary line when anything went; --dry-run removes nothing and lists what would go.
function prune({ dryRun, cfg, now }) {
  const p = prunable(now, cfg);
  if (dryRun) return [...Object.values(p.files).flat().map((f) => `would prune ${fwd(f)}`), ...p.loops.map((sid) => `would prune looping.json entry ${sid} (its session is closed)`),
    ...p.alertKeys.map((k) => `would prune alerts/index.json entry ${k} (older than alert_repeat_hours)`)];
  const out = [], counts = {};
  let failed = 0;
  for (const [kind, files] of Object.entries(p.files)) counts[kind] = files.filter((f) => { try { fs.rmSync(f, { force: true }); return true; } catch { failed++; return false; } }).length;
````

**with:**

````js
  };
}
const entryWord = (n) => `entr${n === 1 ? "y" : "ies"}`;
// Batch B: Claude usage readings and pace-seen markers older than 8 days (pace-io.mjs), and the sessions-pane mod's
// <coord>/pane/*.json files older than 1 day. Their own summary line, so the stage-2 line keeps its shape.
const paceFiles = (now) => [...IO.staleUsageFiles(now), ...filesIn(C("pane")).filter((f) => f.endsWith(".json") && ageMs(f, now) > 24 * HOUR)];
// One summary line when anything went; --dry-run removes nothing and lists what would go.
function prune({ dryRun, cfg, now }) {
  const p = prunable(now, cfg), extra = paceFiles(now);
  if (dryRun) return [...Object.values(p.files).flat().map((f) => `would prune ${fwd(f)}`), ...p.loops.map((sid) => `would prune looping.json entry ${sid} (its session is closed)`),
    ...p.alertKeys.map((k) => `would prune alerts/index.json entry ${k} (older than alert_repeat_hours)`), ...extra.map((f) => `would prune ${fwd(f)}`)];
  const out = [], counts = {};
  let failed = 0;
  for (const [kind, files] of Object.entries(p.files)) counts[kind] = files.filter((f) => { try { fs.rmSync(f, { force: true }); return true; } catch { failed++; return false; } }).length;
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
  const removed = Object.values(counts).reduce((s, n) => s + n, 0);
  if (removed || dropped || droppedAlerts || failed) out.unshift(`prune: removed ${removed} file(s) (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}), `
    + `dropped ${dropped} looping.json ${entryWord(dropped)} and ${droppedAlerts} alerts/index.json ${entryWord(droppedAlerts)}${failed ? `, ${failed} file(s) could not be removed` : ""}`);
  return out;
}
// Report-only, never a kill: they may belong to anything, hand-opened sessions included. An unknown probe (failed,
````

**with:**

````js
  const removed = Object.values(counts).reduce((s, n) => s + n, 0);
  if (removed || dropped || droppedAlerts || failed) out.unshift(`prune: removed ${removed} file(s) (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}), `
    + `dropped ${dropped} looping.json ${entryWord(dropped)} and ${droppedAlerts} alerts/index.json ${entryWord(droppedAlerts)}${failed ? `, ${failed} file(s) could not be removed` : ""}`);
  const gone = extra.filter((f) => { try { fs.rmSync(f, { force: true }); return true; } catch { return false; } }).length;
  if (gone) out.push(`prune: removed ${gone} old usage reading(s), pace-seen marker(s) and pane file(s)`);
  return out;
}
// Report-only, never a kill: they may belong to anything, hand-opened sessions included. An unknown probe (failed,
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
  return writeState(f, { at: V.now(), repos }, "lanes.json");
}

// ---------- one tick ----------
// -> the lines it printed (also in last-tick.txt). A failure is one more line, never a throw past the lock release.
const writeLastTick = (out) => { try { V.writeAtomic(C("last-tick.txt"), `${V.now()}\n${out.join("\n")}\n`); } catch {} };
````

**with:**

````js
  return writeState(f, { at: V.now(), repos }, "lanes.json");
}

// ---------- batch B, Part 2: pace.json from the usage files, at every unrestricted tick ----------
// Keeps pace.json's `updated` fresh while no status line runs (readers treat one older than 15 min as absent). One line
// per provider whose state changed (a new provider at ok says nothing); a dry run writes nothing. A failure: one line.
function paceTick({ dryRun, cfg, now }) {
  try {
    const { pace, prev } = IO.recomputePace({ now, cfg: cfg.pace, write: !dryRun });
    return P.providersOf(pace).filter(([p, e]) => (P.isEntry(prev?.[p]) ? prev[p].state : "ok") !== e.state)
      .map(([p, e]) => `${dryRun ? "would set " : ""}pace: ${p} ${P.isEntry(prev?.[p]) ? prev[p].state : "ok"} -> ${e.state} (${P.aheadText(e)})`);
  } catch (err) { return [`error: pace.json not written (${err?.code || err?.message || err})`]; }
}

// ---------- one tick ----------
// -> the lines it printed (also in last-tick.txt). A failure is one more line, never a throw past the lock release.
const writeLastTick = (out) => { try { V.writeAtomic(C("last-tick.txt"), `${V.now()}\n${out.join("\n")}\n`); } catch {} };
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
    const tj = V.readJson(C("tick.json"), {}) || {}, prevRun = Date.parse(tj.last_run) || 0, now = Date.now();
    if (!dryRun) V.writeAtomic(C("tick.json"), JSON.stringify({ ...tj, at: V.now(), last_run: V.now() }));
    out.push(...releaseStaleClaims(now, { dryRun }));
    out.push(...resumePending({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
````

**with:**

````js
    const tj = V.readJson(C("tick.json"), {}) || {}, prevRun = Date.parse(tj.last_run) || 0, now = Date.now();
    if (!dryRun) V.writeAtomic(C("tick.json"), JSON.stringify({ ...tj, at: V.now(), last_run: V.now() }));
    out.push(...releaseStaleClaims(now, { dryRun }));
    // batch B: pace.json first (machine-wide: an unrestricted tick only), so this tick's pause and resume decisions read it
    if (!repoKey) out.push(...paceTick({ dryRun, cfg, now }));
    out.push(...resumePending({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pace-tick.test.mjs claude/skills/handoff-launch/tests/leaks.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/tests/pace-tick.test.mjs
git commit -m "feat(pace): pace.json at every tick; prune old usage readings, pace-seen markers and pane files"
```

---

### Task 4: carried fix: liveness before the newest pick (`laneTable`, `launch.mjs sessions`)

**Files:**
- Modify: `claude/skills/handoff-launch/tests/lanes.test.mjs`
- Modify: `claude/skills/handoff-launch/recover.mjs`
- Modify: `claude/skills/handoff-launch/launch.mjs`

**Interfaces:**
- Consumes: `live.mjs` `primeLiveness`, `liveness`.
- Produces: `laneTable(reg, repoKey, now)` (same signature and shape) and `sessions` judge every open entry's liveness
  first, drop `gone`, then pick the newest per lane (`recover.mjs:715-734`, `launch.mjs:592-598` at `a7015cd`).

- [ ] **Step 1: Write the failing test**

**Replace** in `claude/skills/handoff-launch/tests/lanes.test.mjs`:

````js
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, launchLane, commitIn, writeDone, writeTranscript, setAgents, tx, LAUNCH } from "./helpers.mjs";
import { projectKey } from "../live.mjs";

const lastLaunch = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name).at(-1);
````

**with:**

````js
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, launchLane, commitIn, writeDone, writeTranscript, setAgents, tx, LAUNCH, coordRun } from "./helpers.mjs";
import { projectKey } from "../live.mjs";

const lastLaunch = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name).at(-1);
````

**Replace** in `claude/skills/handoff-launch/tests/lanes.test.mjs`:

````js
    assert.match(sb.run("status", "--group", "g9").out, /^W .*  DEAD-START \(since 2026-10-05T10:00:00\.000Z\)$/m);
  } finally { sb.cleanup(); }
});
````

**with:**

````js
    assert.match(sb.run("status", "--group", "g9").out, /^W .*  DEAD-START \(since 2026-10-05T10:00:00\.000Z\)$/m);
  } finally { sb.cleanup(); }
});

test("sessions and lanes.json judge liveness before picking the newest: a gone, unclosed newest entry never hides an older running one (batch B carried fix)", () => {
  const sb = sandbox();
  try {
    const a1 = sessionLine(sb, { name: "A", id: "A@1", gen: 1, branch: "lane-a", sid: "a-s1", mode: "bg", bg_id: "bg-A1", supersedes: null });
    sessionLine(sb, { name: "A", id: "A@2", gen: 2, branch: "lane-a", sid: "a-s2", mode: "bg", bg_id: "bg-A2", supersedes: a1.id, launched_at: new Date(Date.now() - 3600e3).toISOString() });
    sessionLine(sb, { name: "G", id: "G@1", gen: 1, branch: "lane-g", sid: "g-s1", mode: "bg", bg_id: "bg-G1", supersedes: null }); // only entry, gone
    setAgents(sb, [{ id: "bg-A1", sessionId: "a-s1", name: "A", status: "running" }]); // A@2 and G@1 are not listed: gone, never closed
    const r = sb.run("sessions");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^A  .*@lane-a  group=-  gen 1  running  /m);
    assert.doesNotMatch(r.out, /gen 2|^G  /m);
    const t = coordRun(sb, ["tick"]);
    assert.equal(t.code, 0, t.err);
    const lanes = JSON.parse(fs.readFileSync(path.join(sb.coord, "lanes.json"), "utf8")).repos[a1.repo];
    assert.deepEqual(lanes.map((l) => `${l.id} ${l.liveness}`), ["A@1 running"]);
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/lanes.test.mjs`
Expected: FAIL - `sessions` prints `A ... gen 2  gone`, and `lanes.json` has no entry for lane A.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js

// ---------- batch A, Part 5: lanes.json, the live lanes the hooks read ----------
// Per repo: the newest open entry of each lane (repo + branch) whose liveness is running or unknown, with its registry
// id, name, branch, worktree, group, scope, effective priority and checklist note. repoKey: the key() form launch lines
// store (a --repo tick). A --repo tick rewrites only its key.
export function laneTable(reg, repoKey = null, now = Date.now()) {
  const newest = new Map();
  for (const e of reg.entries) {
    if (reg.closed.has(e.id) || (repoKey && e.repo !== repoKey)) continue;
    const key = `${e.repo}|${e.branch}`, cur = newest.get(key);
    if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(key, e);
  }
  V.primeLiveness([...newest.values()]);
  const repos = {};
  for (const e of newest.values()) {
    const lv = V.liveness(e, reg);
    if (lv.state === "gone") continue;
    const gp = e.session_id ? V.goalOf(e.session_id) : null;
    let goal = "no GOAL.md";
    if (gp) { try { goal = L.goalNote(L.parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, now); } catch {} }
````

**with:**

````js

// ---------- batch A, Part 5: lanes.json, the live lanes the hooks read ----------
// Per repo: the newest open entry of each lane (repo + branch) whose liveness is running or unknown, with its registry
// id, name, branch, worktree, group, scope, effective priority and checklist note. Liveness is judged before the newest
// is picked (batch B carried fix): a gone, unclosed newest entry never hides an older one that still runs. repoKey: the
// key() form launch lines store (a --repo tick). A --repo tick rewrites only its key.
export function laneTable(reg, repoKey = null, now = Date.now()) {
  const open = reg.entries.filter((e) => !reg.closed.has(e.id) && (!repoKey || e.repo === repoKey));
  V.primeLiveness(open); // one window probe for all of them
  const newest = new Map(), lvs = new Map();
  for (const e of open) {
    const lv = V.liveness(e, reg);
    if (lv.state === "gone") continue;
    lvs.set(e.id, lv);
    const key = `${e.repo}|${e.branch}`, cur = newest.get(key);
    if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(key, e);
  }
  const repos = {};
  for (const e of newest.values()) {
    const lv = lvs.get(e.id);
    const gp = e.session_id ? V.goalOf(e.session_id) : null;
    let goal = "no GOAL.md";
    if (gp) { try { goal = L.goalNote(L.parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, now); } catch {} }
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
  // batch A, Part 9: every open launcher session (all groups and lone sessions) and its checklist, then hand-opened
  // sessions with a GOAL.md modified in the last 24 hours. Read-only.
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null, nowMs = Date.now();
  const newest = new Map();
  for (const e of reg.entries) {
    if (reg.closed.has(e.id) || (repoKey && e.repo !== repoKey)) continue;
    const k = `${e.repo}|${e.name}`, cur = newest.get(k);
    if (!cur || cur.launched_at <= e.launched_at) newest.set(k, e);
  }
  const list = G.byPriority([...newest.values()].filter((e) => !reg.closed.has(e.id)), (e) => G.effectivePriority(reg.lines, e));
  primeLiveness(list);
  const goalText = (gp) => { try { return goalNote(parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, nowMs); } catch { return "GOAL.md unreadable"; } };
  for (const e of list) {
    const lv = liveness(e, reg);
````

**with:**

````js
  // batch A, Part 9: every open launcher session (all groups and lone sessions) and its checklist, then hand-opened
  // sessions with a GOAL.md modified in the last 24 hours. Read-only.
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null, nowMs = Date.now();
  // Liveness before the newest pick (batch B carried fix): a gone, unclosed newest entry never hides an older running one.
  const open = reg.entries.filter((e) => !reg.closed.has(e.id) && (!repoKey || e.repo === repoKey));
  primeLiveness(open); // one window probe for all of them
  const newest = new Map();
  for (const e of open) {
    if (liveness(e, reg).state === "gone") continue;
    const k = `${e.repo}|${e.name}`, cur = newest.get(k);
    if (!cur || cur.launched_at <= e.launched_at) newest.set(k, e);
  }
  const list = G.byPriority([...newest.values()], (e) => G.effectivePriority(reg.lines, e));
  const goalText = (gp) => { try { return goalNote(parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, nowMs); } catch { return "GOAL.md unreadable"; } };
  for (const e of list) {
    const lv = liveness(e, reg);
````

- [ ] **Step 4: Run it to verify it passes**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/lanes.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/launch.mjs claude/skills/handoff-launch/tests/lanes.test.mjs
git commit -m "fix(lanes): judge liveness before picking a lane's newest entry (laneTable, sessions)"
```

---

### Task 5: carried fix: `tick.lock`'s holder is "node, started within 2 s of the lock's start"

**Files:**
- Modify: `claude/skills/handoff-launch/tests/recover.test.mjs`
- Modify: `claude/skills/handoff-launch/recover.mjs`

**Interfaces:**
- Consumes: `live.mjs` `procInfo`, `pidAlive`.
- Produces: `acquireTickLock` reclaims a lock whose pid answers `DEAD`, another image, or a node process whose start
  differs from the lock's by more than 2 s; a failed probe or an unreadable start keeps it held; the hung-tick kill
  keeps its rule. Fixes the flaky `recover.test.mjs` "report-only: alerts/index.json ..." (a killed tick's pid reused by
  a parallel test file within 10 s read as a live tick).

- [ ] **Step 1: Write the failing test** (Windows-only, as the other lock tests)

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

````js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, sessionLine, appendLine, writeTranscript, writeSubagent, setAgents, coordRun, tx, host, alive, emptyHost } from "./helpers.mjs";
import { callKey, shortHash } from "../recover-lib.mjs";
````

**with:**

````js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, sessionLine, appendLine, writeTranscript, writeSubagent, setAgents, coordRun, tx, host, alive, emptyHost } from "./helpers.mjs";
import { callKey, shortHash } from "../recover-lib.mjs";
````

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

````js
  } finally { sb.cleanup(); }
});

test("tick.lock: a live holder blocks a second tick; a dead holder's lock is reclaimed", () => {
  const sb = sandbox();
  try {
````

**with:**

````js
  } finally { sb.cleanup(); }
});

test("tick.lock: a pid that runs another image now, or a node process started more than 2 s off the lock's start, is not the holder: reclaimed, never killed (batch B carried fix)", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const node = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  const h = host("Start-Sleep 120"); // a powershell process
  try {
    const ns = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${node.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8" }).stdout.trim();
    assert.ok(Date.parse(ns), "the node child's start time");
    const lock = (o) => { fs.mkdirSync(sb.coord, { recursive: true }); fs.writeFileSync(path.join(sb.coord, "tick.lock"), JSON.stringify({ at: new Date().toISOString(), ...o })); };
    lock({ pid: node.pid, start: ns }); // node, the same start: the holder, still held
    assert.equal(tick(sb).out, "tick: another tick holds tick.lock - skipped\n");
    lock({ pid: node.pid, start: new Date(Date.parse(ns) - 5000).toISOString() }); // node, 5 s off: a reused pid
    let r = tick(sb);
    assert.equal(r.code, 0, r.err); assert.doesNotMatch(r.out, /another tick holds/);
    lock({ pid: h.pid, start: h.start }); // powershell at that pid, its own start: not a tick
    r = tick(sb);
    assert.equal(r.code, 0, r.err); assert.doesNotMatch(r.out, /another tick holds/);
    assert.equal(alive(node.pid), true); assert.equal(alive(h.pid), true); // reclaimed only
  } finally { try { node.kill(); } catch {} h.kill(); sb.cleanup(); }
});

test("tick.lock: a live holder blocks a second tick; a dead holder's lock is reclaimed", () => {
  const sb = sandbox();
  try {
````

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/recover.test.mjs claude/skills/handoff-launch/tests/leaks.test.mjs`
Expected: FAIL - the 5-s-off node holder and the powershell holder read as "another tick holds tick.lock - skipped".

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
      let age = Infinity; try { age = Date.now() - fs.statSync(f).mtimeMs; } catch {}
      if (age < 10000) return false;
    }
    // A live pid whose process started well after the lock was taken is another process (PID reuse): the holder is dead.
    const p = held?.start && process.platform === "win32" ? V.procInfo([held.pid])?.get(held.pid) : null; // procStart, plus the name
    const st = p?.start ? Date.parse(p.start) : null, reused = st != null && st - Date.parse(held.start) > 10000;
    const alive = !!held && V.pidAlive(held.pid);
    if (alive && !reused && V.ago(held.at) < 10 * L.MIN) return false;
    // Older than 10 min (touchTickLock keeps a working tick's lock fresh) and still the process that took it - a node
    // process whose start time matches the lock's within 2 s (selfStart is the OS start time within well under a
    // second; the 10 s reclaim tolerance above is looser on purpose): a hung tick (~50-80 MB), killed before the
    // reclaim. Every condition is named here: a lock whose age does not parse, an unknown (failed probe) or a different
    // start time only reclaims - never a kill on a guess.
    const hung = alive && V.ago(held.at) >= 10 * L.MIN && st != null && Math.abs(st - Date.parse(held.start)) <= 2000 && /^node$/i.test(p.name) && held.pid !== process.pid;
    // Move aside only the lock judged dead here; if another tick replaced it meanwhile, put that one back.
    const aside = `${f}.reclaimed-${process.pid}`;
    try { fs.renameSync(f, aside); } catch { continue; }
````

**with:**

````js
      let age = Infinity; try { age = Date.now() - fs.statSync(f).mtimeMs; } catch {}
      if (age < 10000) return false;
    }
    // The holder is still the process that took the lock only while its pid runs node with a start time within 2 s of
    // the recorded one (selfStart is the OS start time within well under a second). The probe answering DEAD, another
    // image, or a start more than 2 s off: the pid was reused, the holder is dead (batch B carried fix: the old 10 s
    // tolerance let a pid reused within seconds - a full test-suite run - read as a live tick). A failed probe or an
    // unreadable start is no answer: the lock stays held, never reclaimed on a guess.
    const p = held?.start && process.platform === "win32" ? V.procInfo([held.pid])?.get(held.pid) : null; // procStart, plus the name
    const st = p?.start ? Date.parse(p.start) : null;
    const reused = !!p && (p.name === "DEAD" || !/^node$/i.test(p.name) || (st != null && Math.abs(st - Date.parse(held.start)) > 2000));
    const alive = !!held && V.pidAlive(held.pid);
    if (alive && !reused && V.ago(held.at) < 10 * L.MIN) return false;
    // Older than 10 min (touchTickLock keeps a working tick's lock fresh) and still the process that took it - a node
    // process whose start time was read and matches the lock's within 2 s (the rule above): a hung tick (~50-80 MB),
    // killed before the reclaim. Every condition is named here: a lock whose age does not parse, an unknown (failed probe) or a different
    // start time only reclaims - never a kill on a guess.
    const hung = alive && !reused && V.ago(held.at) >= 10 * L.MIN && st != null && held.pid !== process.pid;
    // Move aside only the lock judged dead here; if another tick replaced it meanwhile, put that one back.
    const aside = `${f}.reclaimed-${process.pid}`;
    try { fs.renameSync(f, aside); } catch { continue; }
````

- [ ] **Step 4: Run it to verify it passes**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/recover.test.mjs claude/skills/handoff-launch/tests/leaks.test.mjs`
Expected: PASS, `ℹ fail 0` (the L2 hung-tick tests in `leaks.test.mjs` still pass).

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/tests/recover.test.mjs
git commit -m "fix(tick): a tick.lock holder is node started within 2 s of the lock; a reused pid is reclaimed"
```

---

### Task 6: B1 docs (`coordinator.md`, `SKILL.md`, `README.md`)

**Files:**
- Modify: `claude/skills/handoff-launch/coordinator.md`
- Modify: `claude/skills/handoff-launch/SKILL.md`
- Modify: `README.md`

**Interfaces:** none (docs). SKILL.md stays under ~30 KB (it is loaded by every lane).

- [ ] **Step 1: Apply the doc blocks**

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
    `bg_task_max_min` 240, `dead_close_min` 60, `goal_missing_calls` 10, `goal_stale_min` 40, `goal_stale_changes` 5). An
    unknown key or a bad value is reported on the tick's output (`config: unknown key <k> (the default is used)`) and
    ignored.
````

**with:**

````markdown
    `bg_task_max_min` 240, `dead_close_min` 60, `goal_missing_calls` 10, `goal_stale_min` 40, `goal_stale_changes` 5),
    and (batch B) `pace`, an object of the pacer's thresholds (`pace_target` 95, `pace_floor` 10, `week_grace_min` 720,
    `slow_enter` 10, `slow_leave` 5, `hold_enter` 20, `hold_leave` 15, `exhausted_pct` 95, `week_slow_enter` 5,
    `week_slow_leave` 2, `week_slow_pct` 90, `week_hold_enter` 10, `week_hold_leave` 7, `week_exhausted_pct` 97,
    `fresh_min` 10, `week_fresh_min` 360, `stale_min` 15, `recompute_s` 30, `unchanged_s` 60), and the context
    discipline's `relay_ctx` 250000 and `hard_ctx` 400000. An unknown key or a bad value is reported on the tick's
    output (`config: unknown key <k> (the default is used)`; `pace.<k>` inside `pace`) and ignored.
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
  - `pause.json`: `{"until":"<ISO time>"}`, or `"until": null` for no end. While it is active, every session is exempt
    from flags and every restart waits.
````

**with:**

````markdown
  - `pause.json`: `{"until":"<ISO time>"}`, or `"until": null` for no end. While it is active, every session is exempt
    from flags and every restart waits.
  - Batch B, usage pacing: `usage/<session_id>.json` (one Claude session's newest reading, written by its status line)
    and `usage/codex-<run-id>.json` (written by the codex-dual adapter), each `{ts, provider, pct, resets_at, week_pct,
    week_resets_at}` (`ts` epoch ms, resets epoch s, a missing window `null`); `pace.json` (`{updated, <provider>:
    {state, pct, ahead, resets_at, week_pct, week_ahead, week_resets_at, since, windows}}`, `updated`/`since` epoch ms);
    `pace-seen/<session_id>` (`{since, ctx: {relay, hard_at}}`: the pace state and the context nudges that session was
    last told about) with its once-claims `<session_id>.p<since>`, `.relay` and `.hard-<previous hard_at>` (created
    exclusively: of two gates of one session at once, only the one that creates the claim speaks); and
    `statusline-chain.json` (`{command}`: a status line the user had before the install, run first).
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
  is killed (`tick: killed hung tick ...`). Any other old lock is only reclaimed (10 s PID-reuse tolerance).
````

**with:**

````markdown
  is killed (`tick: killed hung tick ...`). A lock whose pid now runs another image, or a node process started more
  than 2 s off the recorded start, belongs to a dead tick (a reused pid) and is reclaimed at once; a failed probe or an
  unreadable start keeps it held. Any other old lock is only reclaimed.
- An unrestricted tick first recomputes `pace.json` from `usage/` (so a reader never sees it older than one tick while
  the machine runs) and prints `pace: <provider> <old> -> <new> (5h <ahead> / week <ahead>)` when a state changed.
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
`alerts/index.json` entries older than `alert_repeat_hours`. Never pruned: incidents, unclaimed or claimed alerts, the
state of running or unknown sessions, a state file with no launch line.
````

**with:**

````markdown
`alerts/index.json` entries older than `alert_repeat_hours`. Never pruned: incidents, unclaimed or claimed alerts, the
state of running or unknown sessions, a state file with no launch line. Batch B: Claude usage readings (`usage/<sid>.json`
by their `ts`) and `pace-seen/` markers older than 8 days, and the sessions-pane mod's `pane/*.json` older than 1 day
(their claims too, by mtime; `prune: removed <n> old usage reading(s), pace-seen marker(s) and pane file(s)`); Codex readings never (Codex keeps
its newest 20).
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
## Merge internals (section 4)
````

**with:**

````markdown
## Usage pacing (batch B)
- **The recorder** is the global `statusLine` (`coord.mjs statusline`). With `rate_limits` in its input it writes
  `usage/<session_id>.json` (skipped when the values are unchanged and under `unchanged_s` old), recomputes `pace.json`
  when it is older than `recompute_s`, and prints one line, `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay │
  5h 6% │ wk 31% │ pace slow +12 │ ◇ 0 agents`, from the stdin's documented fields (`model.display_name`,
  `context_window.context_window_size` / `used_percentage`, `effort.level` - else the settings' `effortLevel` -,
  `rate_limits`); `pace` only when not `ok`, `agents` only if the stdin has a `tasks` array, no subscription segment
  (no such field is documented). A missing field drops its segment; past ~110 characters `pace`, then `wk`, go. No
  `rate_limits` (not Pro/Max, or before the first answer): no 5h/wk/pace from it, nothing written. No `refreshInterval`:
  every run follows a real event, so a reading's `ts` is its real age. It does not run in subagents.
- **The pacer** (`pace-lib.mjs paceState`, pure) per provider and window: the newest reading whose window has not reset.
  5-hour: `ahead = pct - max(pace_floor, pace_target * elapsed / 300)`; weekly: `week_ahead = week_pct - pace_target *
  min(1, (elapsedW + week_grace_min) / 10080)`. Bands with hysteresis per window (`windows.<k>.state`, never the merged
  state): 5-hour slow > 10 / < 5, hold > 20 / < 15, exhausted at 95 % until the reset; weekly slow > 5 or ≥ 90 % /
  < 2 and < 90 %, hold > 10 / < 7, exhausted at 97 % until the weekly reset. Entering slow or hold needs a fresh reading
  (5-hour: < 10 min, weekly: < 6 h); staying and leaving read the newest one even when stale (`windows.<k>.basis`:
  `fresh`, `stale` or `none`). No reading, or a reset window: `ok`. The provider's `state` is the worse window; `since`
  changes with it. A reader treats a `pace.json` older than 15 min as absent; `coord.mjs pace [--json]` prints the table.
- **The Agent gate** (`coord.mjs agent-gate`, a global PreToolUse hook matching `^(Agent|Task)$` - never TaskUpdate,
  TaskCreate or another Task* tool - in every session): `pace.json`
  absent, stale or `ok` allows at once. At `slow` and above a `low`-priority lane (its effective priority; a session
  without `HL_SESSION_ID` is `high`) is denied (`Usage is ahead of pace (5h +12 / week +6). Low-priority lanes start no
  new agents now. ...`); any other session gets one line per state entry (`Usage ahead of pace (...): step effort
  down ...`). Until B2, `hold` and `exhausted` act as `slow`. Any error allows.
- **Context discipline** (Part 8, never blocks): the current context is the last main-thread assistant message's input +
  cache read + cache creation tokens (the transcript's last 64 KB; the status line's own `context_window.current_usage`
  when present). The status line's ctx segment (a 10-part bar and the percentage) is marked `relay` past `relay_ctx`
  and `RELAY NOW` past `hard_ctx` (without a window size: `ctx 263k relay`). The Agent gate, on a main-thread call only (a subagent's input carries `agent_id`), adds once past
  `relay_ctx` "Context 263k is past the 250k relay rule: this dispatch is your task boundary. ..." and past `hard_ctx`
  "Context 402k is past the 400k hard cap: write the handoff and relay now." at most every 10 min. Its markers share
  `pace-seen/<session_id>`. Any error: nothing shown, the dispatch allowed.

## Merge internals (section 4)
````

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

````markdown
- **The ladder** (`auto` mode): warning → stop request → 5 min grace → incident file → kill → restart. Incidents:
````

**with:**

````markdown
- **Usage pacing** (every session, also hand-opened ones): the status line shows `... │ 5h 6% │ wk 31%` (and
  `│ pace slow +12` while usage runs ahead). While
  usage runs ahead of the 5-hour or weekly pace, an `Agent` dispatch of a low-priority lane is denied ("Usage is ahead of
  pace ...": do the step inline at lower effort, or save state and end your turn); other sessions get one line
  "Usage ahead of pace ...: step effort down (`effort-medium`/`low`) and keep work small". `coord.mjs pace` prints the
  table; details in `coordinator.md` "Usage pacing".
- **The ladder** (`auto` mode): warning → stop request → 5 min grace → incident file → kill → restart. Incidents:
````

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

````markdown
in context; never later than ~400k (split the task to force a boundary). Never mid-task, and never while background
agents are still running — wait for them, or record them in the handoff as "re-dispatch".
````

**with:**

````markdown
in context; never later than ~400k (split the task to force a boundary). Never mid-task, and never while background
agents are still running — wait for them, or record them in the handoff as "re-dispatch". The next dispatch after 250k
is the relay: the status line's ctx segment says `relay`, and the Agent gate says so once at that dispatch.
````

**Replace** in `README.md`:

````markdown
| `hooks/coord.mjs` | The loop coordinator's hook entry: the session hook that `launch.mjs` passes to every session it starts (`--settings`), the coordinator tick, and the alert relay that goal-gate uses. Not registered in `settings.json`. |
| `settings.fragment.json` | Settings to merge: the Stop hook, model/effort defaults, plugins, MCP timeouts. `__HOME__` is replaced at install. Opus 5.5 sessions deliberately start at `medium` effort and step up per turn with the `effort-*` skills, which is cheaper than starting high. |
````

**with:**

````markdown
| `hooks/coord.mjs` | The loop coordinator's hook entry: the session hook that `launch.mjs` passes to every session it starts (`--settings`), the coordinator tick, and the alert relay that goal-gate uses. Registered globally only as the status line (the usage recorder: `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% │ 5h 6% │ wk 31%`) and the `Agent` gate (usage pacing: low-priority lanes start no new agents while usage runs ahead of the 5-hour or weekly pace). |
| `settings.fragment.json` | Settings to merge: the Stop hook, the status line and the `Agent` PreToolUse gate (usage pacing), model/effort defaults, plugins, MCP timeouts. `__HOME__` is replaced at install. Opus 5.5 sessions deliberately start at `medium` effort and step up per turn with the `effort-*` skills, which is cheaper than starting high. |
````

- [ ] **Step 2: Check** - `grep -c "Usage pacing" claude/skills/handoff-launch/coordinator.md` prints `1`; the B1
  full suite still passes (docs only).

- [ ] **Step 3: Commit**

```bash
git add claude/skills/handoff-launch/coordinator.md claude/skills/handoff-launch/SKILL.md README.md
git commit -m "docs(pace): usage pacing, the Agent gate, the context discipline, the tick.lock rule, the prune"
```

---

### Task 7 (controller): B1 release checkpoint

- [ ] **Step 1: Whole-release review.** `worker-high` + **fable** on `git diff <plan commit>..batchB-pause-pacing` with
  this plan, the spec and the Review Focus list. Fixes through `worker-high` + sonnet, then a scoped re-review of those
  edits (the reviewer of the task that owns the file).
- [ ] **Step 2: Full suite.** `timeout 1800 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ tests
  388`, `ℹ fail 0` (quote the lines). Run it twice: the `tick.lock` flake must not recur.
- [ ] **Step 3: The dry-run gate (read-only, live registry, before anything is deployed), shown to the user.** From the
  integration worktree:

  ```bash
  D=$(mktemp -d); R="$HOME/.claude/skills/handoff-launch"
  snap() { sha1sum "$R/sessions.jsonl"; ls -la "$R/stops" "$R/pids" ~/.claude/state/coord 2>&1; }
  snap > "$D/before.txt"
  HL_NO_SPAWN=1 HL_REGISTRY_DIR="$R" node claude/hooks/coord.mjs tick --dry-run > "$D/tick-dry.txt"; cat "$D/tick-dry.txt"
  node claude/hooks/coord.mjs pace
  snap | diff "$D/before.txt" -
  ```

  It writes nothing (the `diff` prints nothing). Show the user the tick lines (a `would set pace:` line appears only
  once usage files exist), `would prune` lines for `pane/` files, and the two settings additions below. The user
  approves before anything is deployed.
- [ ] **Step 4: Deploy, in order** (a module imported before it exists would break running lanes):
  1. `pace-lib.mjs`, then `recover-lib.mjs`, `pace-io.mjs`, then `recover.mjs`, `launch.mjs` -> `~/.claude/skills/handoff-launch/`;
  2. `claude/hooks/coord.mjs` -> `~/.claude/hooks/coord.mjs`;
  3. `SKILL.md`, `coordinator.md`, `tests/` -> the skill folder;
  4. back up `~/.claude/settings.json` (`~/.claude/backups/settings-<stamp>.json`), then add `statusLine` and the
     `PreToolUse` `Agent|Task` entry with the absolute `coord.mjs` path (forward slashes, quoted), as INSTALL_PROMPT.md
     step 5 now says; parse the result with node before saving.
  Then `diff -r claude/skills/handoff-launch ~/.claude/skills/handoff-launch` -> only live runtime files differ
  (`pids`, `stops`, `profiles`, `sessions.jsonl`, `session-hooks.json`, `launch-config.json`);
  `diff claude/hooks/coord.mjs ~/.claude/hooks/coord.mjs` -> identical.
- [ ] **Step 5: Verify live** (no visible window): `echo {} | node ~/.claude/hooks/coord.mjs agent-gate` -> exit 0, no
  output; `echo {} | node ~/.claude/hooks/coord.mjs statusline` -> exit 0, no output or the pace part only (`pace ok`
  once a fresh `pace.json` exists); `node ~/.claude/hooks/coord.mjs pace` -> the table or `no usage readings`.
- [ ] **Step 6: Probe P2 in this session.** After this session's next assistant message,
  `~/.claude/state/coord/usage/<this session id>.json` exists with numeric `pct`/`week_pct` and epoch-second resets
  that match `/usage`; `pace.json` appears with a `claude` entry; the status line shows `5h ..% · wk ..% · pace .. · ctx
  ..k`. If the fields differ, apply Task 0's P2 fallback, re-run Task 1/2's focused commands, redeploy `pace-lib.mjs`.
  Headless check of the gate (P1 already proved the hook shape): none needed.
- [ ] **Step 7: Secret scan** (pattern from the private handoff) over `git grep -niE "<pattern>" HEAD` and over
  `git log -p origin/main..HEAD` -> prints nothing.
- [ ] **Step 8: Push.** Fast-forward `main` to `batchB-pause-pacing`, push `main`. Commit messages end with the
  session's attribution lines.
- [ ] **Step 9: The restart table to `coordinator`:** the status line and the Agent gate are global and load only in
  sessions started after the deploy (relaunch the low-priority lanes first; hand-opened sessions get them at their next
  start); `coord.mjs` and the tick changes are live at once for every lane; `pace.json` is live for the codex-dual
  lane's routing; old sessions must not write `usage/` or `pace-seen/` by hand. Then stop and ask before B2.

---

## Release B2: the one pause protocol, `hold`/`exhausted`, `/broadcast`

### Task 8: `pause-lib.mjs`: sources and scope, the pause close, the resume plan and probe, the manifest

**Files:**
- Create: `claude/skills/handoff-launch/pause-lib.mjs`
- Create: `claude/skills/handoff-launch/tests/pause-lib.test.mjs`
- Modify: `claude/skills/handoff-launch/recover-lib.mjs`

**Interfaces:**
- Consumes: `pace-lib.mjs` `PAUSE_TEXT`, `aheadText`, `isEntry`; `lane-lib.mjs` `byPriority`; `recover-lib.mjs`
  `DEFAULTS` (tests).
- Produces (pure): `activeSources({manual, legacy, battery, pace}, now) -> [{source: "manual"|"battery"|"pace", reason,
  scope: "all"|"normal-low", since, windows}]` (a battery source's `since` is the file's `since`, else its `at`);
  `pauseFor(priority, sources) -> {paused, reason, source, windows, since}`; `pausedLineOf(lines, e) -> line|null`;
  `pausedLineDue(prev, pause) -> bool` (a new `{paused}` line: none yet, or the newest predates `pause.since`);
  `pauseCloseDue({pausedAt, pause, lastAt, now}) -> {close, why}`; `pausedLanes({entries, lines, closed, gone, now}) ->
  [{e, line, closedAt}]` (a lane with a `{starting}` line newer than its newest entry and under 5 min old is left out);
  `lanePauseKey(e)`; `needsProbe(entry, causes)`; `repauseCount(prior, pausedAt) -> n`, `minPauseFor(n, cfg) -> min`
  (`min_pause_min` x min(4, 2^(n-1))); `resumePlan({pending, pauseOf, pace, now, cfg, probe}) -> {relaunch, wait, probe,
  mode}` (a pending item's `minPause` overrides `min_pause_min`); `laneRow(e, {priority,
  reason})`, `handRow(s)`, `upsertRows(m, rows, now, how)`, `markResumed(m, newestOf)`, `archiveDue(m, active)`,
  `archiveName(m)`, `HOW_TO_RESUME(launchMjs)`, `HAND_RESUME_TEXT(rows)`, `CLOSE_SKIPPED_TEXT({name, why})`,
  `parseUntil(args, now) -> {until}|{error}`, `BATTERY_FRESH_MS`, re-exported `PAUSE_TEXT`.
- `recover-lib.mjs` `DEFAULTS` gains `max_resumes_per_tick` 3, `min_pause_min` 15, `probe_wait_min` 10.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pause-lib.test.mjs`:

````js
// Batch B, Parts 4-5: the pure pause protocol (pause-lib.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as Q from "../pause-lib.mjs";
import { DEFAULTS } from "../recover-lib.mjs";

const MIN = 60000, NOW = Date.UTC(2026, 9, 6, 12, 0, 0), iso = (ms) => new Date(ms).toISOString();
const pace = (state, o = {}) => ({ updated: NOW, claude: { state, ahead: 22, week_ahead: 3, since: NOW - 5 * MIN, windows: { five_hour: { state, basis: "fresh" }, weekly: { state: "ok", basis: "fresh" } }, ...o } });
const cfg = { ...DEFAULTS };

test("sources: manual (until or none), the legacy pause.json, a fresh battery file, pace hold/exhausted; expired ones are off", () => {
  assert.deepEqual(Q.activeSources({}, NOW), []);
  assert.deepEqual(Q.activeSources({ manual: { until: null, by: "user", at: iso(NOW) } }, NOW).map((s) => [s.source, s.reason, s.scope]), [["manual", "manual pause", "all"]]);
  assert.equal(Q.activeSources({ manual: { until: iso(NOW + 30 * MIN) } }, NOW)[0].reason, "manual pause until 2026-10-06T12:30Z");
  assert.deepEqual(Q.activeSources({ manual: { until: iso(NOW - MIN) } }, NOW), []);
  assert.deepEqual(Q.activeSources({ legacy: { until: null } }, NOW).map((s) => s.source), ["manual"]); // the old shape is read
  assert.equal(Q.activeSources({ manual: { until: null }, legacy: { until: null } }, NOW).length, 1);
  assert.deepEqual(Q.activeSources({ battery: { at: iso(NOW - 2 * MIN), pct: 19, ac: false } }, NOW).map((s) => [s.source, s.reason, s.scope]), [["battery", "battery 19%", "all"]]);
  assert.deepEqual(Q.activeSources({ battery: { at: iso(NOW - 11 * MIN), pct: 19 } }, NOW), []); // not refreshed: off
  const h = Q.activeSources({ pace: pace("hold") }, NOW)[0];
  assert.deepEqual([h.source, h.reason, h.scope, h.windows], ["pace", "pace hold (5h +22 / week +3)", "normal-low", ["five_hour"]]);
  assert.equal(Q.activeSources({ pace: pace("exhausted") }, NOW)[0].scope, "all");
  for (const st of ["ok", "slow"]) assert.deepEqual(Q.activeSources({ pace: pace(st) }, NOW), []);
});

test("pauseFor scope by priority: manual and battery pause everyone; pace hold normal and low only; exhausted everyone", () => {
  const S = (o) => Q.activeSources(o, NOW);
  const table = (o) => ["high", "normal", "low"].map((p) => Q.pauseFor(p, S(o)).paused);
  assert.deepEqual(table({ manual: { until: null } }), [true, true, true]);
  assert.deepEqual(table({ battery: { at: iso(NOW), pct: 15 } }), [true, true, true]);
  assert.deepEqual(table({ pace: pace("hold") }), [false, true, true]);
  assert.deepEqual(table({ pace: pace("exhausted") }), [true, true, true]);
  assert.deepEqual(table({}), [false, false, false]);
  assert.deepEqual(Q.pauseFor("high", S({ pace: pace("hold") })), { paused: false, reason: null, source: null, windows: [], since: null });
  assert.equal(Q.pauseFor("low", S({ manual: { until: null }, pace: pace("hold") })).source, "manual"); // the first source that covers it
  assert.equal(Q.pauseFor("low", S({ manual: { until: null, at: iso(NOW - MIN) } })).since, iso(NOW - MIN));
  assert.equal(Q.pauseFor("low", S({ battery: { at: iso(NOW), since: iso(NOW - 30 * MIN), pct: 15 } })).since, iso(NOW - 30 * MIN)); // the low battery's start, not its last refresh
});

test("pausedLineDue: a first {paused} line, or a new one when the newest predates the source that pauses the lane now", () => {
  const p = { paused: true, reason: "manual pause", since: iso(NOW - 10 * MIN) };
  assert.equal(Q.pausedLineDue(null, p), true);
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 5 * MIN) }, p), false); // written under this pause
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 60 * MIN) }, p), true); // written under an earlier one
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 60 * MIN) }, { ...p, since: null }), false);
});

test("pausedLineOf: the newest {paused} line naming the launch (id, or its name by hand) at or after its launch", () => {
  const e = { id: "A@2", name: "A", launched_at: iso(NOW - 60 * MIN) };
  const lines = [{ paused: "A", at: iso(NOW - 90 * MIN) }, { paused: "A@2", at: iso(NOW - 10 * MIN), reason: "r1" }, { paused: "A", at: iso(NOW - 5 * MIN), reason: "r2" }, { paused: "B@1", at: iso(NOW) }];
  assert.equal(Q.pausedLineOf(lines, e).reason, "r2");
  assert.equal(Q.pausedLineOf(lines.slice(0, 1), e), null); // before its launch
});

test("pauseCloseDue: 1 min old first; close while paused; once lifted, only a lane that did nothing after its {paused} line", () => {
  const p = { paused: true, reason: "manual pause" }, off = { paused: false, reason: null };
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 30000, pause: p, lastAt: NaN, now: NOW }).close, false);
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 2 * MIN, pause: p, lastAt: NOW, now: NOW }), { close: true, why: "paused (manual pause)" });
  assert.equal(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: off, lastAt: NOW - 5 * MIN + 20000, now: NOW }).close, true); // still open, idle since
  assert.equal(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: off, lastAt: NaN, now: NOW }).close, true);
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: off, lastAt: NOW - MIN, now: NOW }).close, false); // typed into by hand
});

test("pausedLanes: the newest entry per lane with a {paused} line that is closed or gone; an older generation or an open running one is not", () => {
  const mk = (name, gen, o = {}) => ({ id: `${name}@${gen}`, name, repo: "r", group: "g", generation: gen, launched_at: iso(NOW - (10 - gen) * 60 * MIN), mode: "window", ...o });
  const a1 = mk("A", 1), a2 = mk("A", 2), b1 = mk("B", 1), c1 = mk("C", 1), d1 = mk("D", 1), d2 = mk("D", 2);
  const lines = [{ paused: "A@1", at: iso(NOW - 8 * 60 * MIN) }, { paused: "A@2", at: iso(NOW - 20 * MIN) }, { closed: "A", id: "A@2", at: iso(NOW - 10 * MIN) },
    { paused: "B@1", at: iso(NOW - 20 * MIN) }, { paused: "C@1", at: iso(NOW - 20 * MIN) }, { paused: "D@1", at: iso(NOW - 20 * MIN) }, { closed: "D", id: "D@1", at: iso(NOW - 15 * MIN) }];
  const closed = new Set(["A@2", "D@1"]);
  const out = Q.pausedLanes({ entries: [a1, a2, b1, c1, d1, d2], lines, closed, gone: (e) => e.id === "B@1", now: NOW });
  assert.deepEqual(out.map((p) => [p.e.id, p.closedAt]), [["A@2", NOW - 10 * MIN], ["B@1", NOW - 20 * MIN]]); // C running; D relaunched (D@2 is newer)
  // a launch of A in flight ({starting} newer than A@2, under 5 min old): left out; a 6-min-old one (a dead launcher) is not
  const starting = (m) => [...lines, { starting: null, name: "A", group: "g", pid_file: null, at: iso(NOW - m * MIN) }];
  assert.deepEqual(Q.pausedLanes({ entries: [a2, b1], lines: starting(1), closed, gone: (e) => e.id === "B@1", now: NOW }).map((p) => p.e.id), ["B@1"]);
  assert.deepEqual(Q.pausedLanes({ entries: [a2, b1], lines: starting(6), closed, gone: (e) => e.id === "B@1", now: NOW }).map((p) => p.e.id), ["A@2", "B@1"]);
});

const item = (id, o = {}) => ({ e: { id, name: id, mode: "window" }, priority: "normal", source: "manual", windows: [], pausedAt: NOW - 30 * MIN, closedAt: NOW - 20 * MIN, ...o });
const none = () => ({ paused: false, reason: null });

test("resumePlan: high first, then the oldest pause; capped at max_resumes_per_tick; a still-paused lane waits; min_pause_min for pace closes", () => {
  const pending = [item("L1", { priority: "low", pausedAt: NOW - 50 * MIN }), item("N2", { pausedAt: NOW - 20 * MIN }), item("N1", { pausedAt: NOW - 40 * MIN }), item("H1", { priority: "high" }), item("N3", { pausedAt: NOW - 10 * MIN })];
  let r = Q.resumePlan({ pending, pauseOf: none, pace: null, now: NOW, cfg });
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["H1", "N1", "N2"]);
  assert.deepEqual(r.wait.map((w) => [w.item.e.id, w.why]), [["N3", "max_resumes_per_tick 3: next tick"], ["L1", "max_resumes_per_tick 3: next tick"]]);
  assert.equal(r.mode, "full");
  r = Q.resumePlan({ pending, pauseOf: (p) => ({ paused: p !== "high", reason: "pace hold (x)" }), pace: null, now: NOW, cfg });
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["H1"]);
  assert.match(r.wait[0].why, /^its pause still applies \(pace hold \(x\)\)$/);
  const fresh = pace("ok", { windows: { five_hour: { state: "ok", basis: "fresh" }, weekly: { state: "ok", basis: "fresh" } } }).claude;
  r = Q.resumePlan({ pending: [item("P", { source: "pace", windows: ["five_hour"], closedAt: NOW - 10 * MIN })], pauseOf: none, pace: fresh, now: NOW, cfg });
  assert.deepEqual(r.relaunch, []); assert.match(r.wait[0].why, /minimum pause 15 min/);
  r = Q.resumePlan({ pending: [item("M", { closedAt: NOW - MIN })], pauseOf: none, pace: null, now: NOW, cfg }); // manual: no minimum
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["M"]);
  assert.deepEqual(Q.resumePlan({ pending: [], pauseOf: none, pace: null, now: NOW, cfg }), { relaunch: [], wait: [], probe: null, mode: "none" });
});

test("repause back-off: a lane the pace pauses again within 6 h of its last pace relaunch waits 2x, then 4x (the cap)", () => {
  const cfg15 = { ...cfg, min_pause_min: 15 };
  assert.equal(Q.repauseCount(null, NOW), 1);
  assert.equal(Q.repauseCount({ n: 1, at: NOW - 60 * MIN }, NOW - 10 * MIN), 2);
  assert.equal(Q.repauseCount({ n: 2, at: NOW - 60 * MIN }, NOW - 10 * MIN), 3);
  assert.equal(Q.repauseCount({ n: 3, at: NOW - 7 * 60 * MIN }, NOW), 1); // over 6 h: a new series
  assert.equal(Q.repauseCount({ n: 3, at: NOW }, NOW - MIN), 1); // paused before that relaunch: not a re-pause
  assert.deepEqual([1, 2, 3, 4].map((n) => Q.minPauseFor(n, cfg15)), [15, 30, 60, 60]);
  const fresh = { state: "ok", windows: { five_hour: { state: "ok", basis: "fresh" } } };
  const p = item("P", { source: "pace", windows: ["five_hour"], closedAt: NOW - 20 * MIN, minPause: 30 });
  assert.deepEqual(Q.resumePlan({ pending: [p], pauseOf: none, pace: fresh, now: NOW, cfg: cfg15 }).relaunch, []);
  assert.match(Q.resumePlan({ pending: [p], pauseOf: none, pace: fresh, now: NOW, cfg: cfg15 }).wait[0].why, /minimum pause 30 min/);
  assert.equal(Q.resumePlan({ pending: [{ ...p, closedAt: NOW - 31 * MIN }], pauseOf: none, pace: fresh, now: NOW, cfg: cfg15 }).relaunch.length, 1);
});

test("probe resume: a pace pause that ended on a stale 5-hour reading relaunches one window lane, then waits probe_wait_min for a fresh reading", () => {
  const stale = { state: "slow", windows: { five_hour: { state: "slow", basis: "stale" }, weekly: { state: "ok", basis: "fresh" } } };
  const pending = [item("B", { source: "pace", windows: ["five_hour"], priority: "high", closedAt: NOW - 30 * MIN, e: { id: "B", name: "B", mode: "bg" } }),
    item("W", { source: "pace", windows: ["five_hour"], closedAt: NOW - 30 * MIN }), item("X", { source: "pace", windows: ["five_hour"], closedAt: NOW - 30 * MIN })];
  let r = Q.resumePlan({ pending, pauseOf: none, pace: stale, now: NOW, cfg });
  assert.deepEqual([r.mode, r.relaunch.map((p) => p.e.id), r.probe], ["probe", ["W"], { id: "W", at: NOW }]); // the high bg lane writes no reading
  r = Q.resumePlan({ pending: pending.filter((p) => p.e.id !== "W"), pauseOf: none, pace: stale, now: NOW + 5 * MIN, cfg, probe: { id: "W", at: NOW } });
  assert.deepEqual([r.relaunch, r.probe], [[], { id: "W", at: NOW }]);
  r = Q.resumePlan({ pending: pending.filter((p) => p.e.id !== "W"), pauseOf: none, pace: stale, now: NOW + 11 * MIN, cfg, probe: { id: "W", at: NOW } });
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["X"]); // no fresh reading in 10 min: the next lane is probed
  const freshNow = { state: "ok", windows: { five_hour: { state: "ok", basis: "fresh" }, weekly: { state: "ok", basis: "stale" } } };
  r = Q.resumePlan({ pending, pauseOf: none, pace: freshNow, now: NOW, cfg, probe: { id: "W", at: NOW - MIN } });
  assert.deepEqual([r.mode, r.relaunch.length, r.probe], ["full", 3, null]); // a fresh reading confirmed: a full resume
});

test("needsProbe: a 5-hour reset ends a 5-hour pause in full; a weekly reset with the 5-hour reading stale or unknown is a probe", () => {
  const w = (b5) => ({ windows: { five_hour: { basis: b5 }, weekly: { basis: "none" } } });
  assert.equal(Q.needsProbe(w("fresh"), ["weekly"]), false);
  assert.equal(Q.needsProbe(w("none"), ["five_hour"]), false);
  assert.equal(Q.needsProbe(w("none"), ["weekly"]), true);
  assert.equal(Q.needsProbe(w("stale"), ["five_hour"]), true);
  assert.equal(Q.needsProbe(null, ["weekly"]), true);
});

test("the manifest: upsert keeps the newest generation, resumed rows, archive once no source is active and every closed row resumed", () => {
  const e = (gen) => ({ id: `A@${gen}`, name: "A", repo: "r", group: "g", generation: gen, session_id: `s${gen}`, worktree: "/w/a", branch: "a", handoff: "/h.md", launched_at: iso(NOW + gen) });
  let m = Q.upsertRows(null, [Q.laneRow(e(2), { priority: "normal", reason: "manual pause" })], NOW, "how");
  assert.deepEqual([m.paused_at, m.how_to_resume, m.sessions.length], [iso(NOW), "how", 1]);
  m = Q.upsertRows(m, [Q.laneRow(e(1), { priority: "normal", reason: "x" })], NOW); // an older generation never replaces it
  assert.equal(m.sessions[0].generation, 2);
  m = Q.upsertRows(m, [Q.handRow({ session_id: "hand-1234-5678", cwd: "/p", reason: "manual pause" })], NOW);
  assert.deepEqual(m.sessions.map((r) => [r.key, r.closed]), [["lane:r|g|A", true], ["hand:hand-1234-5678", false]]);
  assert.equal(Q.archiveDue(m, false), false);
  m = Q.markResumed(m, () => e(3));
  assert.equal(m.sessions[0].resumed_at, iso(NOW + 3));
  assert.equal(Q.archiveDue(m, true), false);
  assert.equal(Q.archiveDue(m, false), true);
  assert.equal(Q.archiveName(m), "paused-2026-10-06-1200.json");
  assert.match(Q.HAND_RESUME_TEXT([m.sessions[1]]), /claude --resume hand-1234-5678 \(in \/p\)/);
});

test("parseUntil: no end, minutes, hours, until HH:MM (today, or tomorrow when past); garbage is an error", () => {
  assert.deepEqual(Q.parseUntil([], NOW), { until: null });
  assert.deepEqual(Q.parseUntil(["30m"], NOW), { until: iso(NOW + 30 * MIN) });
  assert.deepEqual(Q.parseUntil(["2h"], NOW), { until: iso(NOW + 120 * MIN) });
  const at = (h, m, plusDay) => { const x = new Date(NOW); x.setHours(h, m, 0, 0); if (plusDay) x.setDate(x.getDate() + 1); return x.toISOString(); };
  const later = new Date(NOW + 90 * MIN), earlier = new Date(NOW - 90 * MIN);
  assert.deepEqual(Q.parseUntil(["until", `${later.getHours()}:${String(later.getMinutes()).padStart(2, "0")}`], NOW), { until: at(later.getHours(), later.getMinutes(), false) });
  assert.deepEqual(Q.parseUntil(["until", `${earlier.getHours()}:${String(earlier.getMinutes()).padStart(2, "0")}`], NOW), { until: at(earlier.getHours(), earlier.getMinutes(), true) });
  for (const bad of [["x"], ["0m"], ["until"], ["until", "25:00"], ["30m", "x"]]) assert.ok(Q.parseUntil(bad, NOW).error, bad.join(" "));
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-lib.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: FAIL - `Cannot find module '.../pause-lib.mjs'`.

- [ ] **Step 3: Implement**

**Create** `claude/skills/handoff-launch/pause-lib.mjs`:

````js
// The one pause protocol (batch B, Parts 4-5): pause sources, the scope by priority, the pause close, the resume plan
// (cap, min_pause_min, probe resume) and the paused-session manifest. Pure: no fs, no clock, no processes; pause-io.mjs
// reads the files, recover.mjs and launch.mjs act (tests/pause-lib.test.mjs).
import { PAUSE_TEXT, aheadText, isEntry } from "./pace-lib.mjs";
import { byPriority } from "./lane-lib.mjs";

export { PAUSE_TEXT };
export const MIN = 60000;
export const BATTERY_FRESH_MS = 10 * MIN; // a battery source the power refresh has not rewritten for this long is off
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isoMin = (t) => `${new Date(t).toISOString().slice(0, 16)}Z`;
// An `until` (ISO, or null = no end) still in the future.
const running = (o, now) => o.until == null || Date.parse(o.until) > now;

// ---------- sources ----------
// files: {manual: pause/manual.json, legacy: the old pause.json {until}, battery: pause/battery.json, pace: a FRESH
// pace.json (pace-lib paceFresh) or null}, each the parsed object or null. -> the active sources, [{source, reason,
// scope, since, windows}]; scope "all" pauses every lane, "normal-low" all but high. A manual or legacy file with an
// until in the past is inactive; a battery file older than 10 min is off (the refresh rewrites it while the battery is
// low); pace hold pauses normal and low lanes, exhausted every lane.
export function activeSources({ manual = null, legacy = null, battery = null, pace = null }, now) {
  const out = [];
  if (isObj(manual) && running(manual, now)) out.push({ source: "manual", reason: manual.until ? `manual pause until ${isoMin(Date.parse(manual.until))}` : "manual pause", scope: "all", since: manual.at ?? null, windows: [] });
  else if (isObj(legacy) && running(legacy, now)) out.push({ source: "manual", reason: legacy.until ? `manual pause until ${isoMin(Date.parse(legacy.until))}` : "manual pause", scope: "all", since: legacy.at ?? null, windows: [] });
  if (isObj(battery) && now - Date.parse(battery.at) <= BATTERY_FRESH_MS) out.push({ source: "battery", reason: `battery ${battery.pct ?? "?"}%`, scope: "all", since: battery.since ?? battery.at, windows: [] });
  const e = isEntry(pace?.claude) ? pace.claude : null;
  if (e && (e.state === "hold" || e.state === "exhausted")) {
    const windows = ["five_hour", "weekly"].filter((k) => ["hold", "exhausted"].includes(e.windows?.[k]?.state));
    out.push({ source: "pace", reason: `pace ${e.state} (${aheadText(e)})`, scope: e.state === "exhausted" ? "all" : "normal-low", since: Number.isFinite(e.since) ? new Date(e.since).toISOString() : null, windows });
  }
  return out;
}
// The one answer every hook uses: is a session of this priority paused now? A hand-opened session is "high".
// -> {paused, reason, source, windows, since} (since: when that source began, ISO or null)
export function pauseFor(priority, sources) {
  const s = (sources || []).find((x) => x.scope === "all" || (x.scope === "normal-low" && priority !== "high"));
  return s ? { paused: true, reason: s.reason, source: s.source, windows: s.windows, since: s.since ?? null } : { paused: false, reason: null, source: null, windows: [], since: null };
}
// A lane writes a new {paused} line when it has none for this launch, or when its newest one predates the source that
// pauses it now (a second pause after a lifted one, the lane never closed meanwhile). prev: pausedLineOf's line or null.
export const pausedLineDue = (prev, pause) => !prev || (!!pause?.since && Date.parse(prev.at) < Date.parse(pause.since));

// ---------- {paused} lines, the pause close ----------
// The newest {paused} line of launch e: names its id (or, written by hand, its name) and is at or after its launch.
export function pausedLineOf(lines, e) {
  const t = Date.parse(e?.launched_at) || 0;
  let found = null;
  for (const o of lines || []) if (o && o.paused && (o.paused === e.id || o.paused === e.name) && (Date.parse(o.at) || 0) >= t) found = o;
  return found;
}
// Close a lane that wrote {paused} at pausedAt (ms)? pause: pauseFor's answer for its priority now; lastAt: its
// transcript's last record (ms; NaN: none). The {paused} line must be 1 min old. While its pause is active: close. Once
// it lifted: close (to relaunch it) only when the lane did nothing after its {paused} line (a minute's slack) - one the
// user typed into is left alone. -> {close, why}
export function pauseCloseDue({ pausedAt, pause, lastAt, now }) {
  if (!(now - pausedAt >= MIN)) return { close: false, why: "its {paused} line is under 1 min old" };
  if (pause?.paused) return { close: true, why: `paused (${pause.reason})` };
  if (!Number.isFinite(lastAt) || lastAt <= pausedAt + MIN) return { close: true, why: "paused, and its pause lifted: closed to relaunch" };
  return { close: false, why: "it worked after its {paused} line (resumed by hand)" };
}

// ---------- resuming ----------
const laneKey = (e) => `${e.repo}|${e.group ?? ""}|${e.name}`;
// The lanes waiting for a pause resume: per lane (repo, group, name) its newest launch entry, when that entry has a
// {paused} line and is closed, or gone (gone(e): liveness, asked only for such open entries). A lane with a launch in
// flight - a {starting} line of its name and group newer than that entry, under 5 min old (now: epoch ms) - is left
// out: a second relaunch would put two sessions in one worktree. closedAt: its {closed} line's time, else the {paused}
// line's. -> [{e, line, closedAt}] in registry order
export const lanePauseKey = laneKey;
export function pausedLanes({ entries, lines, closed, gone = () => false, now }) {
  const newest = new Map();
  for (const e of entries || []) { const k = laneKey(e), cur = newest.get(k); if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(k, e); }
  const out = [];
  for (const e of newest.values()) {
    const line = pausedLineOf(lines, e);
    if (!line || !(closed.has(e.id) || gone(e))) continue;
    const t = Date.parse(e.launched_at) || 0;
    if ((lines || []).some((o) => o && "starting" in o && o.name === e.name && (o.group ?? null) === (e.group ?? null) && Date.parse(o.at) > t && now - Date.parse(o.at) < 5 * MIN)) continue;
    const c = [...(lines || [])].reverse().find((o) => o.closed && o.id === e.id);
    out.push({ e, line, closedAt: Date.parse(c?.at) || Date.parse(line.at) || 0 });
  }
  return out;
}
// Probe resume (Part 4): a pace pause that ended on a stale 5-hour reading resumes one lane at a time until a fresh
// reading confirms. entry: pace.json's claude entry (or null); causes: the windows the pace pauses were for. A fresh
// 5-hour reading confirms; a 5-hour window that reset (no current reading) ends a pause caused by it alone.
export function needsProbe(entry, causes) {
  const basis = entry?.windows?.five_hour?.basis ?? "none";
  if (basis === "fresh") return false;
  return !(basis === "none" && causes.length > 0 && causes.every((c) => c === "five_hour"));
}
// Back-off for a lane the pace keeps pausing: prior = the tick state's {n, at} of its last pace relaunch (or null).
// A {paused} line after that relaunch and within 6 h of it is a consecutive re-pause: n + 1; otherwise 1. The wait is
// min_pause_min x min(4, 2^(n-1)). -> n
export function repauseCount(prior, pausedAt) {
  const at = Number(prior?.at), n = Number(prior?.n);
  return Number.isFinite(at) && Number.isFinite(n) && pausedAt > at && pausedAt - at <= 6 * 60 * MIN ? n + 1 : 1;
}
export const minPauseFor = (n, cfg) => cfg.min_pause_min * Math.min(4, 2 ** (Math.max(1, n) - 1));
// The tick's resume step. pending: [{e, priority, source, windows, pausedAt, closedAt, minPause?}] (pausedLanes plus the
// lane's priority, its {paused} line's source and windows, and for a pace close its minutes of minimum pause, minPauseFor);
// pauseOf(priority): pauseFor now; pace: pace.json's claude entry or null; probe: the last probe {id, at} or null. cfg:
// max_resumes_per_tick, min_pause_min, probe_wait_min. Order: high -> normal -> low, then the oldest pause first.
// -> {relaunch: [item], wait: [{item, why}], probe, mode}
export function resumePlan({ pending, pauseOf, pace, now, cfg, probe = null }) {
  const wait = [], ready = [];
  for (const p of pending || []) {
    const q = pauseOf(p.priority), min = p.minPause ?? cfg.min_pause_min;
    if (q.paused) wait.push({ item: p, why: `its pause still applies (${q.reason})` });
    else if (p.source === "pace" && now - p.closedAt < min * MIN) wait.push({ item: p, why: `closed for pace ${Math.round((now - p.closedAt) / MIN)} min ago (minimum pause ${min} min)` });
    else ready.push(p);
  }
  const order = byPriority(ready, (p) => p.priority, (a, b) => a.pausedAt - b.pausedAt);
  const causes = [...new Set(order.filter((p) => p.source === "pace").flatMap((p) => p.windows || []))];
  if (!order.some((p) => p.source === "pace") || !needsProbe(pace, causes)) {
    const n = cfg.max_resumes_per_tick;
    return { relaunch: order.slice(0, n), wait: [...wait, ...order.slice(n).map((item) => ({ item, why: `max_resumes_per_tick ${n}: next tick` }))], probe: null, mode: order.length ? "full" : "none" };
  }
  if (probe && now - probe.at < cfg.probe_wait_min * MIN) return { relaunch: [], wait: [...wait, ...order.map((item) => ({ item, why: `probe resume: waiting for a fresh reading after ${probe.id}` }))], probe, mode: "probe" };
  // One lane: the highest-priority window-mode lane (a bg session writes no status-line reading), else the first.
  const first = order.find((p) => p.e.mode !== "bg") ?? order[0];
  return { relaunch: [first], wait: [...wait, ...order.filter((p) => p !== first).map((item) => ({ item, why: "probe resume: one lane until a fresh reading confirms" }))], probe: { id: first.e.id, at: now }, mode: "probe" };
}

// ---------- the paused-session manifest (<coord>/paused.json; the tick is its only writer) ----------
export const HOW_TO_RESUME = (launchMjs) => `Automatic: the coordinator relaunches closed lanes when their pause ends. By hand: node ${launchMjs} resume --paused. Hand-opened sessions: claude --resume <session_id>.`;
// A lane's row (closed by the pause) or a hand-opened session's row (seen by the hooks while paused).
export const laneRow = (e, { priority, reason }) => ({ key: `lane:${laneKey(e)}`, name: e.name, repo: e.repo ?? null, group: e.group ?? null, generation: e.generation ?? null,
  session_id: e.session_id ?? null, cwd: e.worktree ?? null, branch: e.branch ?? null, handoff: e.handoff ?? null, priority, reason, closed: true });
export const handRow = (s) => ({ key: `hand:${s.session_id}`, name: `hand-opened ${String(s.session_id).slice(0, 8)}`, repo: null, group: null, generation: null,
  session_id: s.session_id, cwd: s.cwd ?? null, branch: null, handoff: null, priority: "high", reason: s.reason ?? null, closed: false });
// Upsert rows by key; a lane keeps only its newest generation (two sessions never share a worktree). manifest null: a
// new one, paused_at = now. -> the new manifest (the input is not changed)
export function upsertRows(manifest, rows, now, howToResume) {
  const m = isObj(manifest) && Array.isArray(manifest.sessions) ? { ...manifest, sessions: [...manifest.sessions] } : { paused_at: new Date(now).toISOString(), how_to_resume: howToResume, sessions: [] };
  for (const r of rows) {
    const i = m.sessions.findIndex((x) => x.key === r.key);
    if (i < 0) m.sessions.push(r);
    else if ((r.generation ?? 0) >= (m.sessions[i].generation ?? 0)) m.sessions[i] = { ...r, ...(m.sessions[i].generation === r.generation && m.sessions[i].resumed_at ? { resumed_at: m.sessions[i].resumed_at } : {}) };
  }
  return m;
}
// A closed lane row is resumed once its lane has a launch entry newer than the row's generation (the tick's relaunch,
// or one by hand). newestOf(row) -> that lane's newest entry or null. -> the new manifest
export function markResumed(manifest, newestOf) {
  if (!isObj(manifest) || !Array.isArray(manifest.sessions)) return manifest;
  return { ...manifest, sessions: manifest.sessions.map((r) => {
    if (!r.closed || r.resumed_at) return r;
    const n = newestOf(r);
    return n && (n.generation ?? 0) > (r.generation ?? 0) ? { ...r, resumed_at: n.launched_at } : r;
  }) };
}
// Archived when no source is active and every closed row has resumed_at (hand-opened rows go with it: their alert went out).
export const archiveDue = (manifest, active) => isObj(manifest) && !active && (manifest.sessions || []).filter((r) => r.closed).every((r) => r.resumed_at);
// paused-<paused_at date>-<HHMM>.json (UTC)
export const archiveName = (manifest) => { const t = new Date(Date.parse(manifest?.paused_at) || 0).toISOString(); return `paused-${t.slice(0, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}.json`; };
// The phone alert for hand-opened sessions once the pause ends: they are never closed, so the user resumes them.
export const HAND_RESUME_TEXT = (rows) => `The pause ended. Hand-opened sessions to resume yourself: ${rows.map((r) => `claude --resume ${r.session_id}${r.cwd ? ` (in ${r.cwd})` : ""}`).join("; ")}`;
// The skip alert: a paused lane whose close was skipped for a reason other than "busy" on two ticks.
export const CLOSE_SKIPPED_TEXT = ({ name, why }) => `Paused lane ${name} could not be closed for two ticks: ${why}. Close it by hand once it has saved its state, or resume the pause.`;

// ---------- `coord.mjs pause` ----------
// [] -> null (no end); ["30m"] / ["2h"] -> now + that; ["until", "HH:MM"] -> the next local HH:MM (today, else tomorrow).
// -> {until: ISO|null} or {error}
export function parseUntil(args, now) {
  const a = (args || []).filter(Boolean);
  if (!a.length) return { until: null };
  const d = /^(\d+)(m|h)$/.exec(a[0]);
  if (d && a.length === 1 && Number(d[1]) > 0) return { until: new Date(now + Number(d[1]) * (d[2] === "h" ? 60 : 1) * MIN).toISOString() };
  const t = a[0] === "until" && a.length === 2 ? /^(\d{1,2}):(\d{2})$/.exec(a[1]) : null;
  if (t && Number(t[1]) < 24 && Number(t[2]) < 60) {
    const x = new Date(now); x.setHours(Number(t[1]), Number(t[2]), 0, 0);
    if (x.getTime() <= now) x.setDate(x.getDate() + 1);
    return { until: x.toISOString() };
  }
  return { error: "pause takes nothing (no end), <n>m, <n>h, or until HH:MM" };
}
````

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

````js
  // batch B, Part 8: the controller's context discipline (pace-lib.mjs ctxConfig reads them for the hooks)
````

**with:**

````js
  // batch B: the pause protocol's resume side (Part 4)
  max_resumes_per_tick: 3, min_pause_min: 15, probe_wait_min: 10,
  // batch B, Part 8: the controller's context discipline (pace-lib.mjs ctxConfig reads them for the hooks)
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-lib.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/pause-lib.mjs claude/skills/handoff-launch/recover-lib.mjs claude/skills/handoff-launch/tests/pause-lib.test.mjs
git commit -m "feat(pause): the pure pause protocol: sources, scope, close, resume plan, probe, manifest (batch B, Parts 4-5)"
```

---

### Task 9: `pause-io.mjs` (the source files) and `coord.mjs pause | resume`

**Files:**
- Create: `claude/skills/handoff-launch/pause-io.mjs`
- Create: `claude/skills/handoff-launch/tests/pause.test.mjs`
- Modify: `claude/hooks/coord.mjs`

**Interfaces:**
- Consumes: Task 8; `live.mjs` `COORD`, `readJson`, `writeAtomic`, `triggerTick`; `recover-lib.mjs` `loadConfig`;
  `pace-lib.mjs` `paceFresh`.
- Produces: `pause-io.mjs` `PAUSE_DIR`, `MANUAL`, `BATTERY`, `LEGACY`, `SEEN_DIR`, `TICK_STATE`, `MANIFEST`,
  `readSources(now)`, `pauseActive(now)`, `pauseForNow(priority, now)` (named apart from pause-lib's pure `pauseFor`),
  `writeManual({until, by}, now)`, `clearManual() ->
  removed paths`, `recordSeen({session_id, cwd, reason}, now)`, `readSeen() -> [{session_id, cwd, reason, at, file}]`.
  `coord.mjs` `pauseCmd(args, env) -> {code, text}`, `resumeCmd() -> {code, text}`; CLI `coord.mjs pause [30m | 2h |
  until HH:MM]` (exit 2 on bad arguments) and `coord.mjs resume`; both claim a tick at once (`triggerTick(by, 0)`).
  Every source file has one writer and is written atomically.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pause.test.mjs`:

````js
// Batch B, Part 4 on disk: the pause source files (pause-io.mjs) and `coord.mjs pause | resume`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, coordRun, COORD_MJS } from "./helpers.mjs";
import { PAUSE_TEXT } from "../pace-lib.mjs";

const MIN = 60000;
const PIO = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pause-io.mjs")).href;
// pause-io's pauseForNow/pauseActive in a child with the sandbox env (pause-io reads CLAUDE_CONFIG_DIR at import).
const ask = (sb, expr) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", `const PI = await import(${JSON.stringify(PIO)}); process.stdout.write(JSON.stringify(${expr}));`], { env: sb.env, encoding: "utf8" }).stdout);
const manual = (sb) => path.join(sb.coord, "pause", "manual.json");
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

test("coord.mjs pause: no end, 30m, until HH:MM; the pause text to broadcast; a tick claimed at once; bad arguments exit 2", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["pause"], { env: { HL_SESSION_ID: "M@1" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `paused: manual pause\nBroadcast: ${PAUSE_TEXT("manual pause")}\n`);
    const m = JSON.parse(fs.readFileSync(manual(sb), "utf8"));
    assert.deepEqual([m.until, m.by, typeof m.at], [null, "M@1", "string"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "pause"); // HL_NO_SPAWN: claimed, not started
    r = coordRun(sb, ["pause", "30m"]);
    const until = Date.parse(JSON.parse(fs.readFileSync(manual(sb), "utf8")).until);
    assert.ok(Math.abs(until - (Date.now() + 30 * MIN)) < MIN);
    assert.match(r.out, /^paused: manual pause until \d{4}-\d\d-\d\dT\d\d:\d\dZ$/m);
    r = coordRun(sb, ["pause", "until", "23:59"]);
    assert.equal(r.code, 0); assert.equal(new Date(JSON.parse(fs.readFileSync(manual(sb), "utf8")).until).getMinutes(), 59);
    for (const bad of [["soon"], ["until", "7pm"]]) { r = coordRun(sb, ["pause", ...bad]); assert.equal(r.code, 2, bad.join(" ")); assert.match(r.out, /^pause takes /); }
  } finally { sb.cleanup(); }
});

test("coord.mjs resume removes the manual source and the legacy pause.json; another source still active is named", () => {
  const sb = sandbox();
  try {
    coordRun(sb, ["pause"]);
    put(path.join(sb.coord, "pause.json"), { until: null });
    let r = coordRun(sb, ["resume"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^resumed: removed manual\.json, pause\.json$/m);
    assert.match(r.out, /^Broadcast: resume your saved work\.$/m);
    assert.equal(fs.existsSync(manual(sb)), false); assert.equal(fs.existsSync(path.join(sb.coord, "pause.json")), false);
    put(path.join(sb.coord, "pause", "battery.json"), { at: new Date().toISOString(), pct: 15, ac: false });
    r = coordRun(sb, ["resume"]);
    assert.match(r.out, /^resumed: no manual pause was set$/m);
    assert.match(r.out, /^still paused by: battery 15%$/m);
  } finally { sb.cleanup(); }
});

test("pause-io: pauseActive and pauseForNow over every source; the old pause.json shape counts; an expired until does not", () => {
  const sb = sandbox();
  try {
    assert.equal(ask(sb, "PI.pauseActive()"), false);
    put(path.join(sb.coord, "pause.json"), { until: new Date(Date.now() + MIN).toISOString() });
    assert.equal(ask(sb, "PI.pauseActive()"), true);
    put(path.join(sb.coord, "pause.json"), { until: new Date(Date.now() - MIN).toISOString() });
    assert.equal(ask(sb, "PI.pauseActive()"), false);
    put(path.join(sb.coord, "pace.json"), { updated: Date.now(), claude: { state: "hold", ahead: 22, week_ahead: 1, since: Date.now(), windows: { five_hour: { state: "hold" }, weekly: { state: "ok" } } } });
    assert.deepEqual(ask(sb, `["high", "normal", "low"].map((p) => PI.pauseForNow(p).paused)`), [false, true, true]);
    assert.equal(ask(sb, `PI.pauseForNow("low").reason`), "pace hold (5h +22 / week +1)");
  } finally { sb.cleanup(); }
});

test("contention on one source file: eight pause commands at once leave one whole manual.json (one of theirs), no temp file", async () => {
  const sb = sandbox();
  try {
    const run = (args) => new Promise((done) => spawn(process.execPath, [COORD_MJS, ...args], { env: sb.env, windowsHide: true, stdio: "ignore" }).on("exit", done));
    const argsList = [[], ["30m"], ["2h"], ["5m"], ["45m"], ["3h"], ["10m"], ["until", "23:59"]];
    for (let round = 0; round < 3; round++) {
      await Promise.all(argsList.map((a) => run(["pause", ...a])));
      const m = JSON.parse(fs.readFileSync(manual(sb), "utf8")); // parses: never a torn file
      assert.deepEqual(Object.keys(m).sort(), ["at", "by", "until"]);
      assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause")).filter((f) => f.endsWith(".tmp")), []);
    }
    // The sources never share a file (one writer each), so a manual write cannot lose a battery write: pause-io names them.
    const PIO2 = await import(PIO);
    assert.equal(new Set([PIO2.MANUAL, PIO2.BATTERY, PIO2.LEGACY]).size, 3);
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause.test.mjs`
Expected: FAIL - `coord.mjs pause` prints nothing; `pause-io.mjs` is missing.

- [ ] **Step 3: Implement**

**Create** `claude/skills/handoff-launch/pause-io.mjs`:

````js
// The pause sources on disk (batch B, Part 4). One file per source, each with a single writer, each written atomically:
//   <coord>/pause/manual.json  {until, by, at}  coord.mjs pause writes it, coord.mjs resume deletes it
//   <coord>/pause/battery.json {at, pct, ac}    only the power refresh (B3) writes or deletes it
//   pace                       not stored: derived from a fresh pace.json (Claude hold or exhausted)
//   <coord>/pause.json         the old {until} shape, still read as a manual source; coord.mjs resume deletes it
// Also: pause/seen/<session_id>.json (a hand-opened session the hooks saw while paused; that session writes its own),
// pause/tick-state.json (the tick's skip counts and probe; the tick writes it) and paused.json (the manifest; the tick
// is its only writer). The decisions are pause-lib.mjs's.
import fs from "node:fs";
import path from "node:path";
import { COORD, readJson, writeAtomic } from "./live.mjs";
import { loadConfig } from "./recover-lib.mjs";
import { paceFresh } from "./pace-lib.mjs";
import { activeSources, pauseFor as pauseForSources } from "./pause-lib.mjs";

export const PAUSE_DIR = path.join(COORD, "pause");
export const MANUAL = path.join(PAUSE_DIR, "manual.json");
export const BATTERY = path.join(PAUSE_DIR, "battery.json");
export const LEGACY = path.join(COORD, "pause.json");
export const SEEN_DIR = path.join(PAUSE_DIR, "seen");
export const TICK_STATE = path.join(PAUSE_DIR, "tick-state.json");
export const MANIFEST = path.join(COORD, "paused.json");
const plainId = (v) => typeof v === "string" && /^[\w-]+$/.test(v);
const paceCfg = () => { let t = null; try { t = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} return loadConfig(t).config.pace; };

// The active sources now (pause-lib activeSources over the files). -> [{source, reason, scope, since, windows}]
export function readSources(now = Date.now()) {
  return activeSources({ manual: readJson(MANUAL, null), legacy: readJson(LEGACY, null), battery: readJson(BATTERY, null),
    pace: paceFresh(readJson(path.join(COORD, "pace.json"), null), now, paceCfg()) }, now);
}
// Any source active (the stage-2 meaning of pauseActive, now over every source).
export const pauseActive = (now = Date.now()) => readSources(now).length > 0;
// Is a session of this priority paused now (the files read now; pause-lib pauseFor decides)? -> {paused, reason, source,
// windows, since}
export const pauseForNow = (priority, now = Date.now()) => pauseForSources(priority, readSources(now));
// coord.mjs pause: the manual source (its one writer). -> the file
export function writeManual({ until, by }, now = Date.now()) {
  writeAtomic(MANUAL, JSON.stringify({ until, by, at: new Date(now).toISOString() }, null, 2));
  return MANUAL;
}
// coord.mjs resume: the manual source and the legacy pause.json go. -> the paths removed
export function clearManual() {
  return [MANUAL, LEGACY].filter((f) => { if (!fs.existsSync(f)) return false; fs.rmSync(f, { force: true }); return true; });
}
// A hand-opened session seen paused by a hook: its own file, so writers never race. -> the file, or null
export function recordSeen({ session_id, cwd = null, reason }, now = Date.now()) {
  if (!plainId(session_id)) return null;
  const f = path.join(SEEN_DIR, `${session_id}.json`);
  if (fs.existsSync(f)) return f;
  writeAtomic(f, JSON.stringify({ session_id, cwd, reason, at: new Date(now).toISOString() }));
  return f;
}
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
export function readSeen() {
  let names = []; try { names = fs.readdirSync(SEEN_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  return names.map((f) => ({ ...readJson(path.join(SEEN_DIR, f), {}), file: path.join(SEEN_DIR, f) })).filter((s) => plainId(s.session_id));
}
````

**Replace** in `claude/hooks/coord.mjs`:

````js
//   agent-gate   the GLOBAL PreToolUse hook on Agent|Task (batch B, Part 3): denies a low-priority lane's dispatch while
//                the pace is slow or worse, and tells the others once per state entry to step effort down
````

**with:**

````js
//   agent-gate   the GLOBAL PreToolUse hook on Agent|Task (batch B, Part 3): denies a low-priority lane's dispatch while
//                the pace is slow or worse, and tells the others once per state entry to step effort down
//   pause [30m | 2h | until HH:MM] | resume   the manual pause source (batch B, Part 4; /broadcast runs them)
````

**Replace** in `claude/hooks/coord.mjs`:

````js
// Probe 2 recorded the type field: a permission prompt, not an idle prompt, makes the session "waiting for the user".
````

**with:**

````js
// ---------- Part 4: the manual pause source (/broadcast runs these) ----------
// `pause [30m | 2h | until HH:MM]` (nothing: no end): pause/manual.json, its one writer; then a tick at once (it starts
// the watcher). -> {code, text}: the pause text for the broadcast.
export async function pauseCmd(args, env = process.env) {
  const [Q, PI, { V }] = await Promise.all([mod("pause-lib.mjs"), mod("pause-io.mjs"), context()]);
  const u = Q.parseUntil(args, Date.now());
  if (u.error) return { code: 2, text: u.error };
  const by = str(env.HL_SESSION_ID) ? env.HL_SESSION_ID : str(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : "user";
  PI.writeManual({ until: u.until, by });
  V.triggerTick("pause", 0);
  const reason = PI.readSources().find((s) => s.source === "manual")?.reason ?? "manual pause";
  return { code: 0, text: `paused: ${reason}\nBroadcast: ${Q.PAUSE_TEXT(reason)}` };
}
// `resume`: deletes pause/manual.json and the legacy pause.json, then a tick at once: it relaunches the closed lanes whose
// pause no longer applies (the manifest is archived once they are all back). -> {code, text}
export async function resumeCmd() {
  const [PI, { V }] = await Promise.all([mod("pause-io.mjs"), context()]);
  const gone = PI.clearManual();
  V.triggerTick("resume", 0);
  const left = PI.readSources();
  return { code: 0, text: [gone.length ? `resumed: removed ${gone.map((f) => path.basename(f)).join(", ")}` : "resumed: no manual pause was set",
    ...(left.length ? [`still paused by: ${left.map((s) => s.reason).join("; ")}`] : []),
    "The coordinator relaunches the closed lanes (this tick, or the watcher within a minute).", "Broadcast: resume your saved work."].join("\n") };
}
// Probe 2 recorded the type field: a permission prompt, not an idle prompt, makes the session "waiting for the user".
````

**Replace** in `claude/hooks/coord.mjs`:

````js
    else if (r?.context) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: r.context } }));
  }
  return 0;
````

**with:**

````js
    else if (r?.context) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: r.context } }));
  } else if (sub === "pause" || sub === "resume") {
    const r = sub === "pause" ? await pauseCmd(argv.slice(1)) : await resumeCmd();
    await write(`${r.text}
`);
    return r.code;
  }
  return 0;
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/pause-io.mjs claude/hooks/coord.mjs claude/skills/handoff-launch/tests/pause.test.mjs
git commit -m "feat(pause): one file per pause source; coord.mjs pause and resume"
```

---

### Task 10: the hooks: the Agent gate's pause (Part 5), the lane Stop's `{paused}` line, goal-gate's paused stop

**Files:**
- Create: `claude/skills/handoff-launch/tests/pause-hooks.test.mjs`
- Modify: `claude/hooks/coord.mjs`
- Modify: `claude/hooks/goal-gate.mjs`

**Interfaces:**
- Consumes: Task 9 `pause-io.mjs` `readSources`, `pauseForNow`, `recordSeen`; Task 8 `pauseFor`, `pausedLineOf`,
  `pausedLineDue`.
- Produces: `coord.mjs` `markPaused(regId) -> line|null` (appends `{paused: <id>, name, group, at, reason, source,
  windows}` once per pause while a source covers the lane: again only when its newest line predates that source's
  `since`), `pauseNow(input, env) -> {paused, reason}` (goal-gate
  calls it; records a paused hand-opened session in `pause/seen/`); `stopCheck` runs `markPaused` on every Stop that does
  not block (fresh or continuation); `agentGate` denies with `PAUSE_TEXT(reason)` whenever a source covers the session
  (hand-opened = `high`), keeps the slow rules and Part 8. `goal-gate.mjs` allows a paused session's stop with
  `{"systemMessage": "paused: <reason>"}` after the relay.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pause-hooks.test.mjs`:

````js
// Batch B, Parts 4-5 in the hooks: the Agent gate's pause denial, the lane Stop's {paused} line, goal-gate's paused stop.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun, sessionLine } from "./helpers.mjs";
import { PAUSE_TEXT } from "../pace-lib.mjs";

const SID = "11111111-2222-3333-4444-555555555555", HAND = "99999999-8888-7777-6666-555555555555";
const GOAL_GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "goal-gate.mjs");
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const gate = (sb, env, sid = SID) => coordRun(sb, ["agent-gate"], { input: { session_id: sid, cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {} }, env });
const out = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput : null);
const stop = (sb, env, o = {}) => coordRun(sb, ["stop"], { input: { session_id: SID, hook_event_name: "Stop", stop_hook_active: false, ...o }, env });
const paceHold = (sb, state = "hold") => put(path.join(sb.coord, "pace.json"), { updated: Date.now(), claude: { state, ahead: 22, week_ahead: 3, since: 5, windows: { five_hour: { state }, weekly: { state: "ok" } } } });
function lanes(sb) {
  sessionLine(sb, { name: "H", id: "H@1", branch: "h", effort: "xhigh", sid: "h-s1", supersedes: null }); // derived high
  sessionLine(sb, { name: "N", id: "N@1", branch: "n", effort: "high", sid: SID, supersedes: null });    // normal
  sessionLine(sb, { name: "L", id: "L@1", branch: "l", effort: "medium", sid: "l-s1", supersedes: null }); // low
}

test("agent gate under a manual pause: every lane and a hand-opened session are denied with the pause text; the hand-opened one is recorded", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    coordRun(sb, ["pause"]);
    for (const id of ["H@1", "N@1", "L@1"]) assert.deepEqual(out(gate(sb, { HL_SESSION_ID: id })), { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PAUSE_TEXT("manual pause") }, id);
    assert.equal(out(gate(sb, {}, HAND)).permissionDecision, "deny");
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause", "seen")), [`${HAND}.json`]); // lanes are never recorded there
    coordRun(sb, ["resume"]);
    assert.equal(gate(sb, { HL_SESSION_ID: "L@1" }).out, "");
  } finally { sb.cleanup(); }
});

test("agent gate under pace hold: normal and low lanes paused; high lanes and hand-opened sessions get the notice; exhausted pauses everyone", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    paceHold(sb);
    assert.equal(out(gate(sb, { HL_SESSION_ID: "N@1" })).permissionDecisionReason, PAUSE_TEXT("pace hold (5h +22 / week +3)"));
    assert.equal(out(gate(sb, { HL_SESSION_ID: "L@1" })).permissionDecision, "deny");
    assert.match(out(gate(sb, { HL_SESSION_ID: "H@1" }, "h-s1")).additionalContext, /^Usage ahead of pace/);
    assert.match(out(gate(sb, {}, HAND)).additionalContext, /^Usage ahead of pace/);
    assert.equal(fs.existsSync(path.join(sb.coord, "pause", "seen")), false); // not paused: not recorded
    paceHold(sb, "exhausted");
    assert.equal(out(gate(sb, {}, "77777777-0000")).permissionDecision, "deny"); // the user's own session too, by design
  } finally { sb.cleanup(); }
});

test("lane Stop while paused appends one {paused} line per launch (a continuation Stop adds none); not paused: none", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, "");
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    coordRun(sb, ["pause"]);
    const t0 = Date.now();
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, ""); // the stop itself is never blocked for a pause
    const t1 = Date.now();
    stop(sb, { HL_SESSION_ID: "N@1" }, { stop_hook_active: true }); // the goal gate's continuation: no second line
    const p = sb.registry().filter((o) => o.paused);
    assert.equal(p.length, 1);
    assert.ok(Date.parse(p[0].at) >= t0 - 1000 && Date.parse(p[0].at) <= t1, "the line is the first Stop's");
    assert.deepEqual([p[0].paused, p[0].name, p[0].group, p[0].reason, p[0].source, p[0].windows], ["N@1", "N", null, "manual pause", "manual", []]);
    paceHold(sb); coordRun(sb, ["resume"]); // hold only: a high lane is not paused
    stop(sb, { HL_SESSION_ID: "H@1" }, { session_id: "h-s1" });
    assert.equal(sb.registry().filter((o) => o.paused === "H@1").length, 0);
  } finally { sb.cleanup(); }
});

test("lane Stop: a new pause after a lifted one writes a new {paused} line (the newest predates the source's since)", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() - 60 * 60000).toISOString() });
    stop(sb, { HL_SESSION_ID: "N@1" });
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 1);
    stop(sb, { HL_SESSION_ID: "N@1" }); // the same pause: still one
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 1);
    coordRun(sb, ["resume"]);
    put(path.join(sb.coord, "pause", "manual.json"), { until: null, by: "t", at: new Date(Date.now() + 1000).toISOString() }); // a later pause
    stop(sb, { HL_SESSION_ID: "N@1" });
    assert.equal(sb.registry().filter((o) => o.paused === "N@1").length, 2);
  } finally { sb.cleanup(); }
});

test("lane Stop: a claude-in-chrome block goes first and writes no {paused} line on that Stop", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    coordRun(sb, ["pause"]);
    put(path.join(sb.coord, "sessions", `${SID}.json`), { chrome_turn: true, chrome_tabs: [7] });
    assert.match(JSON.parse(stop(sb, { HL_SESSION_ID: "N@1" }).out).reason, /claude-in-chrome tab/);
    assert.equal(sb.registry().filter((o) => o.paused).length, 0);
    assert.equal(stop(sb, { HL_SESSION_ID: "N@1" }).out, ""); // the next Stop ends the turn
    assert.equal(sb.registry().filter((o) => o.paused).length, 1);
  } finally { sb.cleanup(); }
});

test("goal-gate: a paused session with open GOAL items stops at once with `paused: <reason>`; unpaused it is blocked as before", () => {
  const sb = sandbox();
  try {
    const tp = path.join(sb.cfg, "projects", "proj", `${HAND}.jsonl`);
    const goal = path.join(sb.temp, "claude", "proj", HAND, "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(goal), { recursive: true }); fs.writeFileSync(goal, "# g\n- [ ] open item\n");
    const run = () => spawnSync(process.execPath, [GOAL_GATE], { env: sb.env, input: JSON.stringify({ session_id: HAND, transcript_path: tp, cwd: "/p", stop_hook_active: false, last_assistant_message: "done." }), encoding: "utf8" });
    assert.equal(JSON.parse(run().stdout).decision, "block");
    coordRun(sb, ["pause"]);
    const r = run();
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: "paused: manual pause" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "seen", `${HAND}.json`), "utf8")).cwd, "/p");
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-hooks.test.mjs claude/skills/handoff-launch/tests/agent-gate.test.mjs claude/skills/handoff-launch/tests/lane-hooks.test.mjs`
Expected: FAIL - no denial under a manual pause; no `{paused}` line; goal-gate blocks.

- [ ] **Step 3: Implement**

**Replace** in `claude/hooks/coord.mjs`:

````js
//   agent-gate   the GLOBAL PreToolUse hook on Agent|Task (batch B, Part 3): denies a low-priority lane's dispatch while
//                the pace is slow or worse, and tells the others once per state entry to step effort down
````

**with:**

````js
//   agent-gate   the GLOBAL PreToolUse hook on Agent|Task (batch B, Part 3): denies a low-priority lane's dispatch while
//                the pace is slow or worse, and tells the others once per state entry to step effort down; denies every
//                session a pause source covers (Part 5)
````

**Replace** in `claude/hooks/coord.mjs`:

````js
// reminds once, then clears it. -> the block reason, or null.
export async function stopCheck(input, env = process.env) {
  const sid = input?.session_id;
  if (!env.HL_SESSION_ID || !plainId(sid) || input.stop_hook_active) return null;
  const { V, L } = await context();
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
  if (state.chrome_turn !== true) return null;
  // Re-read before the write (as fence and laneNote do): a background subagent's post-tool may have written meanwhile.
  V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), chrome_turn: false }));
  const tabs = Array.isArray(state.chrome_tabs) ? state.chrome_tabs.filter(Number.isInteger) : [];
  return tabs.length ? L.CHROME_TABS_TEXT(tabs.length) : null;
}
````

**with:**

````js
// reminds once, then clears it. Batch B, Part 4: a Stop that does not block (fresh or continuation) records the lane's
// {paused} line while it is paused (markPaused). -> the block reason, or null.
export async function stopCheck(input, env = process.env) {
  const sid = input?.session_id;
  if (!env.HL_SESSION_ID || !plainId(sid)) return null;
  const { V, L } = await context();
  if (!input.stop_hook_active) {
    const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
    if (state.chrome_turn === true) {
      // Re-read before the write (as fence and laneNote do): a background subagent's post-tool may have written meanwhile.
      V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), chrome_turn: false }));
      const tabs = Array.isArray(state.chrome_tabs) ? state.chrome_tabs.filter(Number.isInteger) : [];
      if (tabs.length) return L.CHROME_TABS_TEXT(tabs.length); // the turn goes on: not the paused end of it
    }
  }
  try { await markPaused(env.HL_SESSION_ID); } catch {}
  return null;
}
// Part 4, step 2: a launcher lane that ends its turn while a pause source covers its priority appends {paused: <id>,
// name, group, at, reason, source, windows} - once per pause (a goal-gate continuation runs Stop twice): a new line only
// when it has none for this launch or its newest one predates the source that pauses it now (pause-lib
// pausedLineDue). recover.mjs and pause-lib pausedLineOf read it. Nothing paused: no registry read. -> the line, or null
export async function markPaused(regId) {
  const [PI, Q] = await Promise.all([mod("pause-io.mjs"), mod("pause-lib.mjs")]);
  const sources = PI.readSources();
  if (!sources.length) return null;
  const [V, G] = await Promise.all([mod("live.mjs"), mod("lane-lib.mjs")]);
  const reg = V.readRegistry(), e = [...reg.entries].reverse().find((x) => x.id === regId);
  if (!e) return null;
  const p = Q.pauseFor(G.effectivePriority(reg.lines, e), sources);
  if (!p.paused || !Q.pausedLineDue(Q.pausedLineOf(reg.lines, e), p)) return null;
  const line = { paused: e.id, name: e.name, group: e.group ?? null, at: V.now(), reason: p.reason, source: p.source, windows: p.windows };
  V.append(line);
  return line;
}
// Part 4, for goal-gate (every session's Stop): is this session paused? A launcher lane by its effective priority, any
// other session as high. A paused hand-opened session is recorded (pause/seen/<sid>.json) for the manifest. Never throws.
// -> {paused, reason}
export async function pauseNow(input, env = process.env) {
  try {
    const [PI, Q] = await Promise.all([mod("pause-io.mjs"), mod("pause-lib.mjs")]);
    const sources = PI.readSources();
    if (!sources.length) return { paused: false, reason: null };
    const p = Q.pauseFor(await priorityOf(env), sources);
    if (p.paused && !str(env.HL_SESSION_ID)) PI.recordSeen({ session_id: input?.session_id, cwd: input?.cwd ?? null, reason: p.reason });
    return p;
  } catch { return { paused: false, reason: null }; }
}
````

**Replace** in `claude/hooks/coord.mjs`:

````js
// Part 3. Every session runs it (no early return without HL_SESSION_ID). A missing, stale (stale_min) or ok pace.json
// says nothing. slow and above (B1: hold and exhausted act as slow): a low-priority session is denied; any other gets one
// notice per state entry. Part 8: a main-thread call (a subagent's carries agent_id) past relay_ctx gets the context
// nudge (pace-lib ctxNudge) - never a denial. Both once-markers live in pace-seen/<session_id> ({since, ctx}); without a
// plain session id nothing is said. -> {deny} | {context} | null (allow, no output)
export async function agentGate(input, env = process.env) {
  if (!/^(Agent|Task)$/.test(String(input?.tool_name ?? ""))) return null; // the matcher's rule again: never TaskUpdate, TaskCreate, ...
  const P = await mod("pace-lib.mjs"), now = Date.now(), cfg = paceCfg(P);
  const sid = plainId(input?.session_id) ? input.session_id : null, notes = [];
  const seenFile = sid ? path.join(COORD, "pace-seen", sid) : null, seen = seenFile ? readJson(seenFile, {}) : {}, next = { ...seen };
  const pace = P.paceFresh(readJson(path.join(COORD, "pace.json"), null), now, cfg);
  if (pace && P.isEntry(pace.claude) && pace.claude.state !== "ok") {
    const d = P.gateDecision({ pace, priority: await priorityOf(env) });
    if (d?.deny) return { deny: d.deny };
    if (d?.notice && seen.since !== d.since && claim(seenFile, `p${d.since}`)) { notes.push(d.notice); next.since = d.since; }
  }
````

**with:**

````js
// Part 3. Every session runs it (no early return without HL_SESSION_ID). A missing, stale (stale_min) or ok pace.json
// with no pause source file reads nothing more. Part 5: a pause source that covers the session's priority (pause-io
// pauseForNow) denies with the pause text. slow and above: a low-priority session is denied; any other gets one notice per
// state entry. Part 8: a main-thread call (a subagent's carries agent_id) past relay_ctx gets the context nudge
// (pace-lib ctxNudge) - never a denial. Both once-markers live in pace-seen/<session_id> ({since, ctx}); without a plain
// session id nothing is said. -> {deny} | {context} | null (allow, no output)
export async function agentGate(input, env = process.env) {
  if (!/^(Agent|Task)$/.test(String(input?.tool_name ?? ""))) return null; // the matcher's rule again: never TaskUpdate, TaskCreate, ...
  const P = await mod("pace-lib.mjs"), now = Date.now(), cfg = paceCfg(P);
  const sid = plainId(input?.session_id) ? input.session_id : null, notes = [];
  const seenFile = sid ? path.join(COORD, "pace-seen", sid) : null, seen = seenFile ? readJson(seenFile, {}) : {}, next = { ...seen };
  const pace = P.paceFresh(readJson(path.join(COORD, "pace.json"), null), now, cfg);
  const paceOn = !!pace && P.isEntry(pace.claude) && pace.claude.state !== "ok";
  // Part 5: a pause source file (manual, battery, the legacy pause.json) is checked by existence first: cheap.
  const files = ["pause/manual.json", "pause/battery.json", "pause.json"].some((f) => fs.existsSync(path.join(COORD, f)));
  if (paceOn || files) {
    const priority = await priorityOf(env), PI = await mod("pause-io.mjs"), pause = PI.pauseForNow(priority, now);
    // A hand-opened session told it is paused is listed in the manifest (it is never closed: the user resumes it).
    if (pause.paused && !str(env.HL_SESSION_ID)) { try { PI.recordSeen({ session_id: input?.session_id, cwd: input?.cwd ?? null, reason: pause.reason }, now); } catch {} }
    const d = P.gateDecision({ pace: paceOn ? pace : null, priority, pause });
    if (d?.deny) return { deny: d.deny };
    if (d?.notice && seen.since !== d.since && claim(seenFile, `p${d.since}`)) { notes.push(d.notice); next.since = d.since; }
  }
````

**Replace** in `claude/hooks/goal-gate.mjs`:

````js
// Coordinator (handoff-launch stage 2): each Stop may start its tick, and a session the launcher did not start relays
// at most one coordinator alert per user turn (the block asks it to push the alert to the phone).
````

**with:**

````js
// Coordinator (handoff-launch stage 2): each Stop may start its tick, and a session the launcher did not start relays
// at most one coordinator alert per user turn (the block asks it to push the alert to the phone). Batch B: while a pause
// source covers the session, the stop is allowed with `paused: <reason>` (coord.mjs pauseNow).
````

**Replace** in `claude/hooks/goal-gate.mjs`:

````js
  if (msg) { try { if (goalPath) fs.rmSync(path.join(path.dirname(goalPath), `.goal-gate-${sid}.json`), { force: true }); } catch {} block(msg); }
````

**with:**

````js
  if (msg) { try { if (goalPath) fs.rmSync(path.join(path.dirname(goalPath), `.goal-gate-${sid}.json`), { force: true }); } catch {} block(msg); }
  // Batch B, Part 4: a paused session (coord.mjs pauseNow: a pause source covers its priority; a hand-opened session counts
  // as high) may stop at once - it saved its state and marked its open items `[!] paused`. One system line says why.
  let paused = null; try { paused = (await coord?.pauseNow?.(input)) || null; } catch {}
  if (paused?.paused) allow(`paused: ${paused.reason}`);
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-hooks.test.mjs claude/skills/handoff-launch/tests/agent-gate.test.mjs claude/skills/handoff-launch/tests/lane-hooks.test.mjs`
Expected: PASS, `ℹ fail 0` (`lane-hooks.test.mjs`'s Stop tab check still passes).

- [ ] **Step 5: Commit**

```bash
git add claude/hooks/coord.mjs claude/hooks/goal-gate.mjs claude/skills/handoff-launch/tests/pause-hooks.test.mjs
git commit -m "feat(pause): the Agent gate obeys every pause source; a paused lane's Stop writes {paused}; goal-gate lets it stop"
```

---

### Task 11: the tick's pause close (both recovery modes, windows and bg lanes, the skip alert)

**Files:**
- Create: `claude/skills/handoff-launch/tests/pause-close.test.mjs`
- Modify: `claude/skills/handoff-launch/tests/recover.test.mjs`
- Modify: `claude/skills/handoff-launch/recover.mjs`

**Interfaces:**
- Consumes: Task 8 (`pausedLineOf`, `pauseFor`, `pauseCloseDue`, `CLOSE_SKIPPED_TEXT`), Task 9 (`readSources`,
  `pauseActive`, `TICK_STATE`).
- Produces: `recover.mjs` `pauseActive(now)` now means any source (the loop exemption and `afterKillPlan` read it);
  `guardedCloseResult(e, why, {dryRun, noClaude}) -> {line, closed, busy, skipped}` with `guardedClose` its `.line`
  (launch.mjs keeps calling `guardedClose`); `closeCase` returns `{succ}` (superseded only); `readTickState() -> {skips,
  alerted, probe, failed, repause}`; `pauseScan({dryRun, cfg, now, ts}) -> {lines, closed: [{e, priority, reason}]}`
  runs after `supersededScan` in unrestricted ticks only (a `--repo` tick runs none of the pause state: it is
  machine-wide); it drops the `skips` and `alerted` of lanes no longer open and paused; `pause/tick-state.json` is
  written only when it changed. Lines: `closed <name> (gen N):
  paused (<reason>)[: idle <n> min]`, `... paused, and its pause lifted: closed to relaunch`, `skip close of ...`,
  `paused lane <name> not closed for 2 ticks - alert <file>`. Two existing tests change: a paused close now needs an
  active source and a `{paused}` line at least 1 min old, and applies to report-only lanes too.

- [ ] **Step 1: Write the failing tests (and adapt the two existing ones)**

**Create** `claude/skills/handoff-launch/tests/pause-close.test.mjs`:

````js
// Batch B, Part 4 in the tick: the pause close (pauseScan) - bg lanes by bg_id, the still-open lane once the pause lifts,
// busy lanes, the skip count and its one alert. Background lanes need no window host, so these run on every OS.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun, sessionLine, appendLine, writeTranscript, setAgents, tx } from "./helpers.mjs";

const MIN = 60000, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const manual = (sb) => { fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true }); fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "test", at: ago(5) })); };
// A bg lane whose turn ended `idleMin` ago (transcript) and that claude agents lists as idle; {paused} line `pausedMin` ago.
function bgLane(sb, name, { pausedMin = 3, idleMin = 4, bgId = `bg-${name}`, busy = false, effort = "high" } = {}) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, mode: "bg", bg_id: bgId, effort, supersedes: null });
  const t = tx({ start: Date.now() - (idleMin + 1) * MIN, step: 1000 }).user("go");
  writeTranscript(sb, sb.repo, e.session_id, (busy ? t.call("mcp__x__slow", {}, { result: false }) : t.say("state saved").turnDone()).entries());
  if (pausedMin != null) appendLine(sb, { paused: e.id, name, group: null, at: ago(pausedMin), reason: "manual pause", source: "manual", windows: [] });
  return e;
}
const list = (sb, names) => setAgents(sb, names.map((n) => ({ id: `bg-${n}`, sessionId: `${n}-s1`, name: n, status: "idle" })));

test("pause close: an idle paused bg lane is stopped by its bg_id while its pause applies; a {paused} line under 1 min old waits; a busy lane is left for the next tick", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const a = bgLane(sb, "A"), y = bgLane(sb, "Y", { pausedMin: 0 }), b = bgLane(sb, "B", { busy: true });
    list(sb, ["A", "Y", "B"]);
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would close A \(gen 1\): paused \(manual pause\)$/m);
    assert.equal(sb.registry().filter((o) => o.kill_intent).length, 0);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m);
    assert.doesNotMatch(r.out, /close[ds]? [YB] |skip close of [YB] /);
    assert.ok(sb.registry().some((o) => o.kill_intent === a.id && o.kind === "close"));
    assert.ok(sb.registry().some((o) => o.closed && o.id === a.id));
    for (const e of [y, b]) assert.equal(sb.registry().filter((o) => o.kill_intent === e.id).length, 0, e.id);
  } finally { sb.cleanup(); }
});

test("pause close once the pause lifted: a lane idle since its {paused} line is closed to be relaunched; one the user typed into is left alone", () => {
  const sb = sandbox();
  try {
    const s = bgLane(sb, "S", { pausedMin: 5, idleMin: 6 }); // idle since before its {paused} line
    const u = bgLane(sb, "U", { pausedMin: 5, idleMin: 1 }); // worked a minute ago, after its {paused} line
    list(sb, ["S", "U"]);
    const r = tick(sb); // no source is active
    assert.match(r.out, /^closed S \(gen 1\): paused, and its pause lifted: closed to relaunch$/m);
    assert.doesNotMatch(r.out, /close[ds]? U /);
    assert.ok(sb.registry().some((o) => o.closed && o.id === s.id));
    assert.equal(sb.registry().filter((o) => o.kill_intent === u.id).length, 0);
  } finally { sb.cleanup(); }
});

test("pause close in both recovery modes: a pre-stage-2 (report-only) paused lane is closed too", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const e = sessionLine(sb, { name: "R", id: "R@1", branch: "r", sid: "R-s1", mode: "bg", bg_id: "bg-R", coord: undefined, model: undefined, effort: undefined });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    appendLine(sb, { paused: "R", at: ago(3) }); // written by hand, by name: still read
    list(sb, ["R"]);
    assert.match(tick(sb).out, /^closed R \(gen 1\): paused \(manual pause\)$/m);
  } finally { sb.cleanup(); }
});

test("pause close skips: a bg lane without a bg_id, or liveness unknown, is skipped and alerted once at the second tick", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const n = bgLane(sb, "N", { bgId: null });
    list(sb, ["N"]);
    let r = tick(sb);
    assert.match(r.out, /^skip close of N \(gen 1\): a background lane without a recorded bg_id cannot be stopped$/m);
    assert.doesNotMatch(r.out, /not closed for/);
    r = tick(sb);
    assert.match(r.out, /^paused lane N not closed for 2 ticks - alert .*\.json$/m);
    const alerts = fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => /-N\.json$/.test(f));
    assert.equal(alerts.length, 1);
    assert.match(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", alerts[0]), "utf8")).text, /^Paused lane N could not be closed for two ticks: a background lane without a recorded bg_id cannot be stopped\./);
    r = tick(sb);
    assert.doesNotMatch(r.out, /not closed for/); // alerted once
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "tick-state.json"), "utf8")).skips[n.id], 3);
    const k = bgLane(sb, "K");
    r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail" } }); // claude agents fails: liveness unknown
    assert.match(r.out, /^skip close of K \(gen 1\): liveness unknown \(.*\)$/m);
    assert.equal(sb.registry().filter((o) => o.kill_intent === k.id).length, 0);
  } finally { sb.cleanup(); }
});

test("pause close under pace hold: a normal lane is closed, a high lane's old {paused} line is not acted on while hold does not cover it", () => {
  const sb = sandbox();
  try {
    // a fresh reading 22.5 ahead of the 5-hour pace (the tick recomputes pace.json from usage/ first): hold
    fs.mkdirSync(path.join(sb.coord, "usage"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "usage", "s-1.json"), JSON.stringify({ ts: Date.now() - MIN, provider: "claude", pct: 70, resets_at: Math.round((Date.now() + 150 * MIN) / 1000), week_pct: 20, week_resets_at: Math.round((Date.now() + 5040 * MIN) / 1000) }));
    bgLane(sb, "N");
    bgLane(sb, "H", { effort: "xhigh", idleMin: 1 }); // high, worked after its old {paused} line
    list(sb, ["N", "H"]);
    const r = tick(sb);
    assert.match(r.out, /^closed N \(gen 1\): paused \(pace hold \(5h \+23 \/ week -34\)\)$/m);
    assert.doesNotMatch(r.out, /close[ds]? H /);
  } finally { sb.cleanup(); }
});
````

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

````js
test("superseded N-1 and paused windows close when idle; busy or waiting ones stay", { skip: process.platform !== "win32" }, () => {
````

**with:**

````js
test("superseded N-1 and paused windows close when idle, paused ones in both recovery modes; busy or waiting ones and a {paused} line under 1 min old stay", { skip: process.platform !== "win32" }, () => {
````

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

````js
    const p1 = mk("P", "p", 6, idleT, 1);                                // paused and idle: closed
    appendLine(sb, { paused: "P", at: new Date().toISOString() });
    // a report-only session (pre-stage-2 line) with an incident, paused, and a newer gen 3 that is not running (a bg
    // session claude agents does not list): kept. In auto mode the paused close would take it; a running gen 3 would
    // supersede it in every mode.
    const q1 = sessionLine(sb, { name: "Q", id: "Q@1", branch: "q", gen: 1, sid: "Q-s1", host: hosts[7], coord: undefined });
    writeTranscript(sb, sb.repo, q1.session_id, idleT);
    sessionLine(sb, { name: "Q", id: "Q@3", branch: "q", gen: 3, sid: "Q-s3", mode: "bg", bg_id: "bg-Q", coord: undefined });
    appendLine(sb, { incident: q1.id, name: "Q", n: 1, path: "x/Q-1.md", signature: "a:main:x", mode: "report", at: new Date().toISOString() });
    appendLine(sb, { paused: q1.id, at: new Date().toISOString() });
    // a paused, idle window of a report-only session: kept (only the superseded close applies to report-only groups)
    const r1 = sessionLine(sb, { name: "R", id: "R@1", branch: "r", gen: 1, sid: "R-s1", host: hosts[8], coord: undefined });
    writeTranscript(sb, sb.repo, r1.session_id, idleT);
    appendLine(sb, { paused: "R", at: new Date().toISOString() });
````

**with:**

````js
    const twoMinAgo = new Date(Date.now() - 2 * MIN).toISOString();
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true }); // batch B: the pause close needs an active source...
    fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "test", at: twoMinAgo }));
    const p1 = mk("P", "p", 6, idleT, 1);                                // paused and idle: closed
    appendLine(sb, { paused: "P", at: twoMinAgo });                      // ...and a {paused} line at least 1 min old
    // a report-only session (pre-stage-2 line) with an incident, paused under a minute ago, and a newer gen 3 that is not
    // running (a bg session claude agents does not list): kept until its {paused} line is 1 min old.
    const q1 = sessionLine(sb, { name: "Q", id: "Q@1", branch: "q", gen: 1, sid: "Q-s1", host: hosts[7], coord: undefined });
    writeTranscript(sb, sb.repo, q1.session_id, idleT);
    sessionLine(sb, { name: "Q", id: "Q@3", branch: "q", gen: 3, sid: "Q-s3", mode: "bg", bg_id: "bg-Q", coord: undefined });
    appendLine(sb, { incident: q1.id, name: "Q", n: 1, path: "x/Q-1.md", signature: "a:main:x", mode: "report", at: new Date().toISOString() });
    appendLine(sb, { paused: q1.id, at: new Date().toISOString() });
    // a paused, idle window of a report-only session: closed too (batch B: the pause close applies in both modes)
    const r1 = sessionLine(sb, { name: "R", id: "R@1", branch: "r", gen: 1, sid: "R-s1", host: hosts[8], coord: undefined });
    writeTranscript(sb, sb.repo, r1.session_id, idleT);
    appendLine(sb, { paused: "R", at: twoMinAgo });
````

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

````js
    assert.match(r.out, /^closed P \(gen 1\): paused: idle \d+ min$/m);
    assert.doesNotMatch(r.out, /close[ds]? [YZQR] /);
    assert.equal(alive(hosts[0].pid), false); assert.equal(alive(hosts[6].pid), false);
    for (const i of [1, 2, 3, 4, 5, 7, 8]) assert.equal(alive(hosts[i].pid), true, `host ${i}`);
    for (const e of [q1, r1]) assert.equal(sb.registry().filter((o) => o.kill_intent === e.id).length, 0, e.id);
    const lines = sb.registry();
    for (const e of [x1, p1]) {
````

**with:**

````js
    assert.match(r.out, /^closed P \(gen 1\): paused \(manual pause\): idle \d+ min$/m);
    assert.match(r.out, /^closed R \(gen 1\): paused \(manual pause\): idle \d+ min$/m);
    assert.doesNotMatch(r.out, /close[ds]? [YZQ] /);
    for (const i of [0, 6, 8]) assert.equal(alive(hosts[i].pid), false, `host ${i}`);
    for (const i of [1, 2, 3, 4, 5, 7]) assert.equal(alive(hosts[i].pid), true, `host ${i}`);
    assert.equal(sb.registry().filter((o) => o.kill_intent === q1.id).length, 0);
    const lines = sb.registry();
    for (const e of [x1, p1, r1]) {
````

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

````js
    win("F", 5, idleT);                             // paused, idle, with a pending auto ladder: the ladder is cancelled first, then closed
    appendLine(sb, { paused: "F", at });
````

**with:**

````js
    win("F", 5, idleT);                             // paused, idle, with a pending auto ladder: the ladder is cancelled first, then closed
    const twoMinAgo = new Date(Date.now() - 2 * MIN).toISOString(); // batch B: an active source and a {paused} line >= 1 min old
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "test", at: twoMinAgo }));
    appendLine(sb, { paused: "F", at: twoMinAgo });
````

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

````js
    assert.match(r.out, /^closed F \(gen 1\): paused: idle \d+ min$/m);
    assert.doesNotMatch(r.out, /close[ds]? [CDE] /);
````

**with:**

````js
    assert.match(r.out, /^closed F \(gen 1\): paused \(manual pause\): idle \d+ min$/m);
    assert.doesNotMatch(r.out, /close[ds]? [CDE] /);
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-close.test.mjs claude/skills/handoff-launch/tests/recover.test.mjs claude/skills/handoff-launch/tests/hygiene.test.mjs`
Expected: FAIL - no bg lane is closed, report-only paused lanes are kept, the pause reason is missing from the lines.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
import * as IO from "./pace-io.mjs";
````

**with:**

````js
import * as IO from "./pace-io.mjs";
import * as Q from "./pause-lib.mjs";
import * as PI from "./pause-io.mjs";
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
export const pauseActive = (now = Date.now()) => { const p = V.readJson(C("pause.json"), null); return !!p && (p.until == null || Date.parse(p.until) > now); };
const pausedLine = (lines, e) => lines.some((o) => o.paused && (o.paused === e.name || o.paused === e.id) && (Date.parse(o.at) || 0) >= (Date.parse(e.launched_at) || 0));
````

**with:**

````js
// Any pause source active (batch B, Part 4: manual, battery, pace, or the old pause.json): every session is exempt from
// loop flags and every restart waits, as with the stage-2 pause file.
export const pauseActive = (now = Date.now()) => PI.pauseActive(now);
const pausedLine = (lines, e) => !!Q.pausedLineOf(lines, e);
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
// no-claude form - the turn state is not required (no claude is left to finish a turn); the host must be EMPTY,
// re-checked right before the kill. -> its one line
export function guardedClose(e, why, { dryRun, noClaude = false }) {
  const w = V.readPidFile(e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
  if (!w.host_pid || !w.host_start) return `skip close of ${tag}: no recorded host pid and start time`;
  // checkHost is the same check once the pid file recorded the start time (required above): the name powershell and the
  // start within 2 s, a failed probe or an unreadable start unknown. Probed directly, never from the liveness memo.
  const h = V.checkHost(w, V.procInfo([w.host_pid]));
  if (h.state === "unknown") return `skip close of ${tag}: liveness unknown (${h.why})`;
  if (h.state !== "running") return `skip close of ${tag}: host pid ${w.host_pid} is not the recorded window (${h.why})`;
  // Its own fresh probe (not the gone scan's shared one). hostBelow of a value that is not a pid is null without a probe
  // (no probeWhy): named here.
  const b = V.hostBelow(w.host_pid);
  if (!b) return `skip close of ${tag}: the process probe below its window failed (${V.probeWhy() || `host pid ${w.host_pid} is not a pid`})`;
  if (noClaude) {
    if (!b.empty) return `skip close of ${tag}: its window is not empty (${b.names.join(", ")})`;
  } else {
    if (!b.empty && !b.claude) return `skip close of ${tag}: its window runs ${b.names.join(", ")}, no claude`;
    const s = V.sessionState(e);
    if (s.found && (!s.idle || !s.bgKnown)) return `skip close of ${tag}: its turn is not done (${s.busy.join(", ") || "pending background agents unknown"})`;
  }
  if (dryRun) return `would close ${tag}: ${why}`;
  const k = V.killTree(e, why, "close");
  return `${k.closed ? "closed" : "not closed"} ${tag}: ${why}${k.line === "closed" ? "" : ` - ${k.line}`}`;
}
// Why window e may be closed, from the registry alone (liveness is judged after): -> {succ, older, paused} or null.
// succ: the open entries that supersede e (batch A, Part 1: launched after e with e in their chain - a new line follows
// its supersedes links, a legacy line keeps the generation rule), so an unrelated session that landed on the same checkout
// never closes it. older: there is one. The superseded close applies to every group (approved for all groups: an older
// generation handed its stage on, so its state is saved by construction); a paused window closes in auto mode only. A
// window with an incident and a successor is superseded, so the superseded close covers it in every mode.
function closeCase(reg, e) {
  if (e.mode !== "window" || reg.closed.has(e.id)) return null;
  const succ = G.supersedersOf(e, reg.entries, reg.closed);
  const older = succ.length > 0;
  const paused = L.recoveryMode(reg.lines, e) === "auto" && pausedLine(reg.lines, e);
  return older || paused ? { succ, older, paused } : null;
}
````

**with:**

````js
// no-claude form - the turn state is not required (no claude is left to finish a turn); the host must be EMPTY,
// re-checked right before the kill. -> {line, closed, busy, skipped}: busy - its turn is not done (re-checked next tick);
// skipped - any other reason it was not closed (batch B's pause close counts those).
export function guardedCloseResult(e, why, { dryRun, noClaude = false }) {
  const w = V.readPidFile(e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
  const skip = (line, busy = false) => ({ line, closed: false, busy, skipped: !busy });
  if (!w.host_pid || !w.host_start) return skip(`skip close of ${tag}: no recorded host pid and start time`);
  // checkHost is the same check once the pid file recorded the start time (required above): the name powershell and the
  // start within 2 s, a failed probe or an unreadable start unknown. Probed directly, never from the liveness memo.
  const h = V.checkHost(w, V.procInfo([w.host_pid]));
  if (h.state === "unknown") return skip(`skip close of ${tag}: liveness unknown (${h.why})`);
  if (h.state !== "running") return skip(`skip close of ${tag}: host pid ${w.host_pid} is not the recorded window (${h.why})`);
  // Its own fresh probe (not the gone scan's shared one). hostBelow of a value that is not a pid is null without a probe
  // (no probeWhy): named here.
  const b = V.hostBelow(w.host_pid);
  if (!b) return skip(`skip close of ${tag}: the process probe below its window failed (${V.probeWhy() || `host pid ${w.host_pid} is not a pid`})`);
  if (noClaude) {
    if (!b.empty) return skip(`skip close of ${tag}: its window is not empty (${b.names.join(", ")})`);
  } else {
    if (!b.empty && !b.claude) return skip(`skip close of ${tag}: its window runs ${b.names.join(", ")}, no claude`);
    const s = V.sessionState(e);
    if (s.found && (!s.idle || !s.bgKnown)) return skip(`skip close of ${tag}: its turn is not done (${s.busy.join(", ") || "pending background agents unknown"})`, true);
  }
  if (dryRun) return { line: `would close ${tag}: ${why}`, closed: false, busy: false, skipped: false };
  const k = V.killTree(e, why, "close");
  return { line: `${k.closed ? "closed" : "not closed"} ${tag}: ${why}${k.line === "closed" ? "" : ` - ${k.line}`}`, closed: k.closed, busy: false, skipped: !k.closed };
}
export const guardedClose = (e, why, o) => guardedCloseResult(e, why, o).line;
// Why window e may be closed, from the registry alone (liveness is judged after): -> {succ} or null. succ: the open
// entries that supersede e (batch A, Part 1: launched after e with e in their chain - a new line follows its supersedes
// links, a legacy line keeps the generation rule), so an unrelated session that landed on the same checkout never closes
// it. The superseded close applies to every group (approved for all groups: an older generation handed its stage on, so
// its state is saved by construction). A window with an incident and a successor is superseded, so the superseded close
// covers it in every mode. A paused window is the pause close's (batch B, pauseScan), in both recovery modes.
function closeCase(reg, e) {
  if (e.mode !== "window" || reg.closed.has(e.id)) return null;
  const succ = G.supersedersOf(e, reg.entries, reg.closed);
  return succ.length ? { succ } : null;
}
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
      const by = [...k.succ].reverse().find((n) => V.liveness(n, reg).state === "running"), superseded = !!by; // the newest running successor
      if (!superseded && !k.paused) continue;
      // A pending loop ladder owns its session: it kills, cancels or ends it (resumePending runs first in the tick). A close
      // here with no running successor would let the next tick restart the closed session (afterKill); with one, the
      // ladder ends as superseded.
      if (!superseded && L.pendingLadders(reg.lines).some((p) => p.id === e.id)) { out.push(`skip close of ${tag}: its loop ladder is pending - the ladder ends first`); continue; }
      const lv = V.liveness(e, reg);
````

**with:**

````js
      const by = [...k.succ].reverse().find((n) => V.liveness(n, reg).state === "running"); // the newest running successor
      if (!by) continue; // a pending loop ladder with a running successor ends as superseded: no ladder check here
      const lv = V.liveness(e, reg);
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
      const reason = superseded ? `superseded by generation ${by.generation}` : "paused";
````

**with:**

````js
      const reason = `superseded by generation ${by.generation}`;
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
// ---------- batch A, Part 3: windows whose claude is gone (dead start, exited) ----------
// Window entries only, every group.
````

**with:**

````js
// ---------- batch B, Part 4: the pause close ----------
// The tick's own pause state (pause/tick-state.json, written only by an unrestricted tick): {skips: {<id>: n}, alerted:
// [<id>], probe: {id, at} | null, failed: {<id>: n}, repause: {<lane key>: {n, at}}}.
export const readTickState = () => { const t = V.readJson(PI.TICK_STATE, {}) || {}; return { skips: t.skips || {}, alerted: Array.isArray(t.alerted) ? t.alerted : [], probe: t.probe ?? null, failed: t.failed || {}, repause: t.repause || {} }; };
// One more skipped close of a paused lane; at the second, one alert naming it (CLOSE_SKIPPED_TEXT). -> lines
function countSkip(e, why, { dryRun, ts }) {
  if (dryRun) return [];
  const n = (ts.skips[e.id] || 0) + 1;
  ts.skips[e.id] = n;
  if (n < 2 || ts.alerted.includes(e.id)) return [];
  ts.alerted.push(e.id);
  return [`paused lane ${e.name} not closed for ${n} ticks - alert ${fwd(raiseAlert({ name: e.name, text: Q.CLOSE_SKIPPED_TEXT({ name: e.name, why }), incident: null }))}`];
}
// Every open lane with a {paused} line after its launch, window or bg, in both recovery modes (batch B: the stage-2
// paused close was auto mode only): closed while its pause applies, or once it lifted when the lane did nothing since
// (pause-lib pauseCloseDue; the line must be 1 min old). A window goes through the guarded close with idle_close_min
// waived (the lane saved its state before writing {paused}); the pid-reuse, host and idle-now checks stay. A bg lane is
// stopped by its bg_id (killTree); one without a bg_id cannot be stopped. A busy lane (or one waiting on a permission
// prompt) is re-checked next tick; any other skip is counted, and alerted once at the second tick (countSkip). Hand-opened
// sessions have no registry entry: never closed. An unrestricted tick only (like the resume and the manifest: the tick
// state is machine-wide). -> {lines, closed: [{e, priority, reason}]}
function pauseScan({ dryRun, cfg, now, ts }) {
  const out = [], closed = [], first = V.readRegistry(), sources = PI.readSources(now);
  const cands = first.entries.filter((e) => !first.closed.has(e.id) && Q.pausedLineOf(first.lines, e));
  // Closed, gone or relaunched since: their skip counts and alert marks go.
  for (const id of Object.keys(ts.skips)) if (!cands.some((e) => e.id === id)) delete ts.skips[id];
  ts.alerted = ts.alerted.filter((id) => cands.some((e) => e.id === id));
  if (!cands.length) return { lines: out, closed };
  for (const e of cands) V.forgetLiveness(e.id, { agents: V.usesAgents(e) ? AGENTS_FRESH_MS : false });
  V.primeLiveness(cands);
  for (const c of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === c.id);
      if (!e || reg.closed.has(e.id)) continue;
      const line = Q.pausedLineOf(reg.lines, e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
      const priority = G.effectivePriority(reg.lines, e), pause = Q.pauseFor(priority, sources);
      const lv = V.liveness(e, reg);
      if (lv.state === "gone") continue; // the resume side takes a gone paused lane
      if (lv.state === "unknown") { out.push(`skip close of ${tag}: liveness unknown (${lv.why})`, ...countSkip(e, `liveness unknown (${lv.why})`, { dryRun, ts })); continue; }
      const st = V.sessionState(e);
      const due = Q.pauseCloseDue({ pausedAt: Date.parse(line.at) || 0, pause, lastAt: Date.parse(st.last), now });
      if (!due.close) continue;
      if (L.pendingLadders(reg.lines).some((p) => p.id === e.id)) { out.push(`skip close of ${tag}: its loop ladder is pending - the ladder ends first`); continue; }
      let r;
      if (e.mode === "bg") {
        if (!e.bg_id) { const why = "a background lane without a recorded bg_id cannot be stopped"; out.push(`skip close of ${tag}: ${why}`, ...countSkip(e, why, { dryRun, ts })); continue; }
        if (!st.idle) continue; // busy: re-checked next tick
        if (dryRun) r = { line: `would close ${tag}: ${due.why}`, closed: false, skipped: false };
        else { const k = V.killTree(e, due.why, "close"); r = { line: `${k.closed ? "closed" : "not closed"} ${tag}: ${due.why}${k.line === "closed" ? "" : ` - ${k.line}`}`, closed: k.closed, skipped: !k.closed }; }
      } else {
        const hf = plainId(e.session_id) ? C("sessions", `${e.session_id}.json`) : null, hook = hf ? V.readJson(hf, null) : {};
        if (!hook && fs.existsSync(hf)) { out.push(`skip close of ${tag}: hook state unreadable`, ...countSkip(e, "hook state unreadable", { dryRun, ts })); continue; }
        const below = st.found ? null : V.hostBelow(V.readPidFile(e).host_pid), emptyHost = st.found ? null : below ? below.empty : null;
        const d = L.closeDecision({ state: st, waitingSince: hook?.waiting_since || null, emptyHost, now, cfg: { ...cfg, idle_close_min: 0 }, reason: due.why, launchedAt: e.launched_at });
        if (!d.close) { if (!st.found) out.push(...countSkip(e, d.why, { dryRun, ts })); continue; } // busy or waiting: next tick
        r = guardedCloseResult(e, d.why, { dryRun, noClaude: !st.found });
      }
      out.push(r.line);
      if (r.skipped) out.push(...countSkip(e, r.line.replace(/^(?:skip close of |not closed )[^:]+: /, ""), { dryRun, ts }));
      if (r.closed) closed.push({ e, priority, reason: line.reason ?? due.why });
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
  }
  return { lines: out, closed };
}

// ---------- batch A, Part 3: windows whose claude is gone (dead start, exited) ----------
// Window entries only, every group.
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
    out.push(...goneScan({ dryRun, cfg, now: Date.now(), repoKey }));
````

**with:**

````js
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
    // batch B, Part 4: the pause close, the resume and the manifest are machine-wide, like their state in
    // pause/tick-state.json (written only when it changed): an unrestricted tick only - a --repo tick would prune and
    // overwrite the state of other repos' lanes.
    const ts = repoKey ? null : readTickState(), tsBefore = JSON.stringify(ts);
    const pz = ts ? pauseScan({ dryRun, cfg, now: Date.now(), ts }) : { lines: [], closed: [] };
    out.push(...pz.lines);
    out.push(...goneScan({ dryRun, cfg, now: Date.now(), repoKey }));
    if (ts && !dryRun && JSON.stringify(ts) !== tsBefore) out.push(...writeState(PI.TICK_STATE, ts, "pause/tick-state.json"));
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-close.test.mjs claude/skills/handoff-launch/tests/recover.test.mjs claude/skills/handoff-launch/tests/hygiene.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/tests/recover.test.mjs claude/skills/handoff-launch/tests/pause-close.test.mjs
git commit -m "feat(pause): the tick closes paused lanes in both modes, bg lanes by bg_id, and alerts a lane it cannot close"
```

---

### Task 12: `launch.mjs resume --paused` and the `--resume-note` first line

**Files:**
- Create: `claude/skills/handoff-launch/tests/pause-resume.test.mjs`
- Modify: `claude/skills/handoff-launch/recover-lib.mjs`
- Modify: `claude/skills/handoff-launch/launch.mjs`

**Interfaces:**
- Consumes: Task 8 `pausedLanes` (with `now`); Task 9 `pause-io.mjs` `pauseForNow`; `recover.mjs` `acquireTickLock`,
  `releaseTickLock` (already exported).
- Produces: `launch.mjs resume --paused (--all | --id <registry id> | --lane <name> | --group <id> | --repo <dir>)
  [--dry-run]` (exit 0; 1 when a lane was not relaunched or a tick holds `tick.lock`; 2 without a selector; 3 with a
  `CAP_REFUSED` line on a cap refusal). A real run takes `tick.lock` for its whole run (the tick relaunches the same lanes
  under it) and reads the registry again under it; a dry run takes no lock. Lines `relaunched <name> fresh after its
  pause (<reason>)`, `not relaunched: <name> - its pause still applies (<reason>)`, `not relaunched: a coordinator tick
  runs (it relaunches paused lanes itself) - retry in a minute`, `would relaunch ...`, `no paused lanes to relaunch`;
  `--resume-note <reason>` puts
  `PAUSE_RESUME_LINE(reason)` first in the prompt (never in `prompt_file`). `recover-lib.mjs` `freshLaunchArgs(e, {model,
  effort, recovery = null, resumeNote = null, priority, supersedes})` (no `--recovery` when null) and
  `PAUSE_RESUME_LINE(why)`. KNOWN_FLAGS gains `all`, `paused`, `resume-note`.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pause-resume.test.mjs`:

````js
// Batch B, Part 4: `launch.mjs resume --paused` (the relaunch of lanes a pause closed) and the --resume-note prompt line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun, sessionLine, appendLine, setAgents } from "./helpers.mjs";
import { freshLaunchArgs, PAUSE_RESUME_LINE, CAP_REFUSED } from "../recover-lib.mjs";
import { selfStart } from "../live.mjs";

const MIN = 60000, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const launches = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name);
// A window lane the pause closed: {paused} then {closed} (or, closed: false, a window that is gone: no pid recorded).
function pausedLane(sb, name, { group = null, closed = true, effort = "high", reason = "manual pause", source = "manual", at = ago(20) } = {}) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, group, effort, supersedes: null });
  appendLine(sb, { paused: e.id, name, group, at, reason, source, windows: [] });
  if (closed) appendLine(sb, { closed: name, id: e.id, at: ago(15), why: "paused" });
  return e;
}

test("resume --paused needs a selector; with none to relaunch it says so", () => {
  const sb = sandbox();
  try {
    let r = sb.run("resume", "--paused");
    assert.equal(r.code, 2); assert.match(r.err, /^resume --paused needs --all/);
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "no paused lanes to relaunch\n");
  } finally { sb.cleanup(); }
});

test("resume --paused waits while the pause applies, then relaunches fresh: high first, a lone lane, the gone one too, replacing the closed entry", () => {
  const sb = sandbox();
  try {
    const a = pausedLane(sb, "A", { group: "g1" }), h = pausedLane(sb, "H", { effort: "xhigh" }), z = pausedLane(sb, "Z", { closed: false });
    coordRun(sb, ["pause"]);
    let r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 1);
    assert.match(r.out, /^not relaunched: H - its pause still applies \(manual pause\)$/m);
    assert.equal(launches(sb, "A").length, 1);
    coordRun(sb, ["resume"]);
    r = sb.run("resume", "--paused", "--all", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.trim().split("\n").map((l) => l.split(" ")[2]), ["H", "A", "Z"]); // high first, then the oldest pause
    assert.equal(launches(sb, "H").length, 1); // a dry run launches nothing
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^relaunched H fresh after its pause \(manual pause\)$/m);
    for (const [e, n] of [[a, "A"], [h, "H"], [z, "Z"]]) {
      const l = launches(sb, n);
      assert.equal(l.length, 2, n);
      assert.equal(l[1].supersedes, e.id, n);
      assert.equal(l[1].group ?? null, e.group ?? null, n);
    }
    assert.equal(launches(sb, "H")[1].priority, "high");
    r = sb.run("resume", "--paused", "--all"); // their newest entries are the new ones: nothing left
    assert.equal(r.out, "no paused lanes to relaunch\n");
  } finally { sb.cleanup(); }
});

test("resume --paused --id relaunches that lane only; pace hold keeps normal lanes but lets a high one go", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "N", { source: "pace", reason: "pace hold (x)" });
    const h = pausedLane(sb, "H", { effort: "xhigh", source: "pace", reason: "pace hold (x)" });
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated: Date.now(), claude: { state: "hold", ahead: 21, week_ahead: 0, since: 1, windows: { five_hour: { state: "hold" }, weekly: { state: "ok" } } } }));
    let r = sb.run("resume", "--paused", "--id", "N@1");
    assert.match(r.out, /^not relaunched: N - its pause still applies \(pace hold/m);
    r = sb.run("resume", "--paused", "--id", h.id);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "relaunched H fresh after its pause (pace hold (x))\n");
    assert.equal(launches(sb, "N").length, 1);
  } finally { sb.cleanup(); }
});

test("resume --paused by hand never races the tick: refused while a tick holds tick.lock; a lane with a launch in flight is left out", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "A");
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "tick.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: selfStart(), at: new Date().toISOString() })); // a live node holder: this test runner
    let r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 1);
    assert.match(r.out, /^not relaunched: a coordinator tick runs \(it relaunches paused lanes itself\) - retry in a minute$/m);
    assert.equal(launches(sb, "A").length, 1);
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid); // the tick's lock is left alone
    fs.rmSync(lock);
    appendLine(sb, { starting: null, name: "A", pid_file: null, at: new Date().toISOString() }); // a launch of A in flight
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "no paused lanes to relaunch\n");
    assert.equal(fs.existsSync(lock), false); // its own lock released
    assert.equal(sb.run("resume", "--paused", "--all", "--dry-run").code, 0); // a dry run takes no lock
  } finally { sb.cleanup(); }
});

test("resume --paused: a session-cap refusal stops the run with exit 3 and the cap's line", () => {
  const sb = sandbox();
  try {
    pausedLane(sb, "A"); pausedLane(sb, "B");
    sessionLine(sb, { name: "R", id: "R@1", branch: "r", sid: "r-s1", mode: "bg", bg_id: "bg-R", supersedes: null });
    setAgents(sb, [{ id: "bg-R", sessionId: "r-s1", name: "R", status: "running" }]);
    fs.writeFileSync(path.join(sb.reg, "launch-config.json"), JSON.stringify({ max_sessions: 1 }));
    const r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 3);
    assert.match(r.out, /^not relaunched: A - session cap \(1 sessions running, max_sessions 1\); the rest wait too$/m);
    assert.ok(r.err.split("\n").some((l) => l.startsWith(CAP_REFUSED)));
    assert.equal(launches(sb, "B").length, 1);
  } finally { sb.cleanup(); }
});

test("--resume-note puts PAUSE_RESUME_LINE first in the prompt, never in prompt_file; freshLaunchArgs passes it without --recovery", () => {
  const sb = sandbox();
  try {
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "W", "--model", "opus", "--effort", "high", "--resume-note", "pace hold (5h +21)", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(r.out).prompt.startsWith(`${PAUSE_RESUME_LINE("pace hold (5h +21)")} Continue from the handoff`));
    const e = { worktree: "C:/r", repo: "c:/r", handoff: "C:/h.md", name: "A", group: null, branch: "a", mode: "window", session_id: "s1" };
    const a = freshLaunchArgs(e, { model: "opus", effort: "high", resumeNote: "manual pause", priority: "normal", supersedes: "A@1" });
    assert.ok(!a.includes("--recovery"));
    assert.deepEqual(a.slice(a.indexOf("--resume-note"), a.indexOf("--resume-note") + 2), ["--resume-note", "manual pause"]);
    assert.doesNotMatch(PAUSE_RESUME_LINE('a "b"; c'), /[";]/);
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-resume.test.mjs claude/skills/handoff-launch/tests/provenance.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: FAIL - `resume --paused` answers "resume needs --group"; `--resume-note` is an unknown flag.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

````js
// Batch A: priority (the lane's effective priority: a restart is not a relay, so a hand-set priority survives) and
// supersedes (the entry this restart replaces) are passed when given.
export function freshLaunchArgs(e, { model, effort, recovery, priority = null, supersedes = null }) {
  const a = ["--repo", e.worktree, "--handoff", e.handoff, "--name", e.name];
  if (e.group) a.push("--group", e.group);
  if (e.worktree && e.repo && e.worktree.toLowerCase() !== e.repo) a.push("--worktree", e.branch);
  a.push("--profile", typeof e.profile === "string" && e.profile ? e.profile : "full");
  a.push("--model", model, "--effort", effort, "--mode", e.mode || "window", "--no-close", "--recovery", recovery);
````

**with:**

````js
// Batch A: priority (the lane's effective priority: a restart is not a relay, so a hand-set priority survives) and
// supersedes (the entry this restart replaces) are passed when given. Batch B: a relaunch after a pause passes no
// incident (recovery null) but resumeNote, the pause's reason (launch.mjs --resume-note: PAUSE_RESUME_LINE).
export function freshLaunchArgs(e, { model, effort, recovery = null, resumeNote = null, priority = null, supersedes = null }) {
  const a = ["--repo", e.worktree, "--handoff", e.handoff, "--name", e.name];
  if (e.group) a.push("--group", e.group);
  if (e.worktree && e.repo && e.worktree.toLowerCase() !== e.repo) a.push("--worktree", e.branch);
  a.push("--profile", typeof e.profile === "string" && e.profile ? e.profile : "full");
  a.push("--model", model, "--effort", effort, "--mode", e.mode || "window", "--no-close");
  if (recovery) a.push("--recovery", recovery);
  if (resumeNote) a.push("--resume-note", resumeNote);
````

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

````js
export const RECOVERY_LINE = (incidentRef) => `RECOVERY: you were stopped for a loop. Read ${incidentRef}. Find and fix the cause (systematic-debugging), record it in the incident's Cause section and the lane ledger, then continue.`;
````

**with:**

````js
export const RECOVERY_LINE = (incidentRef) => `RECOVERY: you were stopped for a loop. Read ${incidentRef}. Find and fix the cause (systematic-debugging), record it in the incident's Cause section and the lane ledger, then continue.`;
// Batch B: the first line of a lane relaunched after a pause (same rules: no double quotes or semicolons).
export const PAUSE_RESUME_LINE = (why) => `RESUMED after a pause (${String(why).replace(/["]/g, "'").replace(/;/g, ",")}): read your ledger or handoff and GOAL.md, reopen the items you marked [!] paused, then continue.`;
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
const KNOWN_FLAGS = new Set(["after-merge", "base", "dry-run", "effort", "force", "from", "goal-from", "group", "handoff",
  "integration", "lane", "mode", "model", "name", "no-close", "no-merge", "priority", "profile", "prompt-file", "recovery", "reopen", "repo",
  "resume", "scope", "session", "set", "skip", "stop-looping", "supersedes", "target", "test", "test-timeout-min", "text", "text-file", "to",
  "why", "worktree", "id"]);
````

**with:**

````js
const KNOWN_FLAGS = new Set(["after-merge", "all", "base", "dry-run", "effort", "force", "from", "goal-from", "group", "handoff",
  "integration", "lane", "mode", "model", "name", "no-close", "no-merge", "paused", "priority", "profile", "prompt-file", "recovery", "reopen", "repo",
  "resume", "resume-note", "scope", "session", "set", "skip", "stop-looping", "supersedes", "target", "test", "test-timeout-min", "text", "text-file", "to",
  "why", "worktree", "id"]);
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
//   node launch.mjs resume --group <id> [--lane <name>]                     (relaunch blocked lanes fresh)
````

**with:**

````js
//   node launch.mjs resume --group <id> [--lane <name>]                     (relaunch blocked lanes fresh)
//   node launch.mjs resume --paused (--all | --id <registry id> | --lane <name> | --group <id> | --repo <dir>) [--dry-run]
//                   (relaunch the lanes a pause closed, once their pause no longer applies; batch B)
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine, parseGoal, goalNote } from "./recover-lib.mjs";
````

**with:**

````js
import { RECOVERY_LINE, PAUSE_RESUME_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine, parseGoal, goalNote } from "./recover-lib.mjs";
import { pausedLanes } from "./pause-lib.mjs";
import { pauseForNow } from "./pause-io.mjs";
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
import { guardedClose } from "./recover.mjs";
````

**with:**

````js
import { guardedClose, acquireTickLock, releaseTickLock } from "./recover.mjs";
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
if (sub === "resume") {
  const g = opt("group") && slug(opt("group")), lane = opt("lane") && slug(opt("lane"));
````

**with:**

````js
if (sub === "resume" && flag("paused")) {
  // Batch B, Part 4: relaunch the lanes a pause closed (pause-lib pausedLanes: a lane's newest entry with a {paused} line,
  // closed or gone) whose pause no longer applies: fresh, from the handoff, with a non-incident first line (--resume-note,
  // PAUSE_RESUME_LINE), its GOAL.md and its effective priority, replacing its newest entry. A lone lane too (no group).
  // Select with --id <registry id>, --lane, --group, --repo, or --all. High priority first, then the oldest pause. A
  // real run holds tick.lock (the tick relaunches the same lanes under it): while a tick runs it refuses (exit 1, retry),
  // and a lane with a launch in flight (a newer {starting} line) is left out. A cap refusal ends the run with exit 3 and
  // the cap's line (capRefusal reads it).
  const id = opt("id"), lane = opt("lane") && slug(opt("lane")), g = opt("group") ? slug(opt("group")) : undefined;
  if (!id && !lane && g === undefined && !opt("repo") && !flag("all")) { console.error("resume --paused needs --all, --id <registry id>, --lane <name>, --group <id> or --repo <dir>"); process.exit(2); }
  if (!dry) {
    const held = [];
    if (!acquireTickLock(held)) { for (const l of held) console.log(l); console.log("not relaunched: a coordinator tick runs (it relaunches paused lanes itself) - retry in a minute"); process.exit(1); }
    process.on("exit", releaseTickLock);
  }
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null, fresh = readRegistry(); // read again under the lock
  const items = pausedLanes({ entries: fresh.entries, lines: fresh.lines, closed: fresh.closed, gone: (e) => liveness(e, fresh).state === "gone", now: Date.now() })
    .filter(({ e }) => (!id || e.id === id) && (!lane || e.name === lane) && (g === undefined || (e.group ?? null) === g) && (!repoKey || e.repo === repoKey));
  if (!items.length) { console.log(`no paused lanes to relaunch${id ? ` (id ${id})` : lane ? ` named ${lane}` : ""}`); process.exit(0); }
  const prio = (x) => G.effectivePriority(fresh.lines, x.e);
  let code = 0;
  for (const it of G.byPriority(items, prio, (a, b) => (Date.parse(a.line.at) || 0) - (Date.parse(b.line.at) || 0))) {
    const { e, line } = it, priority = prio(it), q = pauseForNow(priority), why = line.reason || "paused";
    if (q.paused) { console.log(`not relaunched: ${e.name} - its pause still applies (${q.reason})`); code = 1; continue; }
    warnUntracked(e.name);
    if (dry) { console.log(`would relaunch ${e.name} fresh from ${e.handoff} after its pause (${why})`); continue; }
    const fa = freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", resumeNote: why, priority, supersedes: e.id });
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...fa], { encoding: "utf8", timeout: 3 * MIN, env: launcherEnv() });
    const capWhy = capRefusal(r.status, `${r.stderr || ""}\n${r.stdout || ""}`);
    if (r.status === 0) console.log(`relaunched ${e.name} fresh after its pause (${why})`);
    else if (capWhy) { console.log(`not relaunched: ${e.name} - session cap (${capWhy}); the rest wait too`); console.error(`${CAP_REFUSED} ${capWhy}`); process.exit(3); }
    else { code = 1; console.log(`ERROR relaunching ${e.name}: ${`${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-5).join(" | ") || `the launcher exited ${r.status ?? r.signal ?? r.error?.code}`}`); }
  }
  process.exit(code);
}
if (sub === "resume") {
  const g = opt("group") && slug(opt("group")), lane = opt("lane") && slug(opt("lane"));
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
const recovery = opt("recovery") ? `${RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))} ` : "";
````

**with:**

````js
const recovery = opt("recovery") ? `${RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))} ` : "";
// --resume-note <reason> (batch B: a relaunch after a pause): the same, its own first line.
const resumeNote = opt("resume-note") ? `${PAUSE_RESUME_LINE(opt("resume-note"))} ` : "";
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
const prompt = clean(recovery + basePrompt + (taken ? G.INBOX_SENTENCE(qs(fwd(taken))) : ""));
````

**with:**

````js
const prompt = clean(recovery + resumeNote + basePrompt + (taken ? G.INBOX_SENTENCE(qs(fwd(taken))) : ""));
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-resume.test.mjs claude/skills/handoff-launch/tests/provenance.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: PASS, `ℹ fail 0` (`provenance.test.mjs` pins KNOWN_FLAGS to the code).

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/launch.mjs claude/skills/handoff-launch/recover-lib.mjs claude/skills/handoff-launch/tests/pause-resume.test.mjs
git commit -m "feat(pause): launch.mjs resume --paused relaunches lanes a pause closed, with a RESUMED first line"
```

---

### Task 13: the tick resumes (order, cap, `min_pause_min`, probe resume, failures) and keeps the manifest

**Files:**
- Create: `claude/skills/handoff-launch/tests/pause-resume-tick.test.mjs`
- Modify: `claude/skills/handoff-launch/recover.mjs`

**Interfaces:**
- Consumes: Task 8 (`pausedLanes`, `lanePauseKey`, `repauseCount`, `minPauseFor`, `resumePlan`, `laneRow`, `handRow`,
  `upsertRows`, `markResumed`, `archiveDue`, `archiveName`, `HOW_TO_RESUME`, `HAND_RESUME_TEXT`), Task 9
  (`readSources`, `readSeen`, `MANIFEST`), Task 11 (`pauseScan`'s `closed`, the tick state), Task 12's
  `freshLaunchArgs({..., resumeNote})`. The tick spawns the fresh launch itself through `spawnLaunch` under its own
  `tick.lock` (the lock `resume --paused` by hand takes; tests stand a fake launcher in with `HL_LAUNCH_MJS`).
- Produces: `resumeScan({dryRun, cfg, now, ts}) -> lines` and `manifestTick({dryRun, now, closed}) -> lines`
  (unrestricted ticks only), after `goneScan`. `ts.probe` is set only when the probe lane's relaunch worked; `ts.repause`
  `{<lane key>: {n, at}}` records each pace relaunch (a series ends after 6 h); `ts.failed` entries of lanes no longer
  waiting are dropped. Lines: `relaunched <name> after its pause (<reason>)[ - a probe resume]`,
  `would relaunch ...`, `relaunch of <name> after its pause deferred: session cap (...) - the next tick retries`, `...
  failed: ...`, `gave up relaunching <name> - alert ...`, `the pause ended: <n> hand-opened session(s) to resume by
  hand - alert ...`, `pause manifest archived: <file>`.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pause-resume-tick.test.mjs`:

````js
// Batch B, Part 4 in the tick: resuming (order, cap, min_pause_min, probe resume, cap refusal, failures) and the manifest.
// A fake launcher (HL_LAUNCH_MJS) stands in for the fresh launch the tick spawns (freshLaunchArgs: --supersedes <the
// closed entry>, --resume-note <reason>): it logs them and appends the lane's next launch line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun, sessionLine, appendLine, writeTranscript, setAgents, tx } from "./helpers.mjs";

const MIN = 60000, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const FAKE = `const fs = require("fs"), path = require("path");
const a = process.argv.slice(2), id = a[a.indexOf("--supersedes") + 1], note = a.includes("--resume-note") ? a[a.indexOf("--resume-note") + 1] : "-";
fs.appendFileSync(path.join(process.env.HL_SANDBOX_TMP, "launches.txt"), id + "|" + note + "|" + a.includes("--recovery") + "\\n");
const mode = process.env.HL_FAKE_RESUME || "ok";
if (mode === "cap") { console.error("refused - session cap: 6 sessions running, max_sessions 6 (config x)"); process.exit(3); }
if (mode === "fail") { console.error("boom"); process.exit(1); }
const reg = path.join(process.env.HL_REGISTRY_DIR, "sessions.jsonl");
const e = fs.readFileSync(reg, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.id === id && o.launched_at);
fs.appendFileSync(reg, JSON.stringify({ ...e, id: e.name + "@r" + Date.now(), generation: (e.generation || 1) + 1, launched_at: new Date().toISOString(), supersedes: e.id, no_spawn: true }) + "\\n");
`;
function fake(sb) { const f = path.join(sb.tmp, "fake-launch.cjs"); fs.writeFileSync(f, FAKE); return f; }
const tick = (sb, env = {}, ...a) => coordRun(sb, ["tick", ...a], { env: { HL_LAUNCH_MJS: fake(sb), HL_SANDBOX_TMP: sb.tmp, ...env } });
const launchLog = (sb) => { try { return fs.readFileSync(path.join(sb.tmp, "launches.txt"), "utf8").trim().split("\n").map((l) => l.split("|")); } catch { return []; } };
const launched = (sb) => launchLog(sb).map(([id]) => id);
// A window lane a pause closed `closedMin` ago.
function closedLane(sb, name, { effort = "high", source = "manual", reason = "manual pause", closedMin = 20, windows = [] } = {}) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, effort, supersedes: null });
  appendLine(sb, { paused: e.id, name, group: null, at: ago(closedMin + 1), reason, source, windows });
  appendLine(sb, { closed: name, id: e.id, at: ago(closedMin), why: "paused" });
  return e;
}
// The newest Claude reading (the tick recomputes pace.json from usage/ first): a 5-hour window under pace, read minAgo ago.
const setUsage = (sb, minAgo) => { fs.mkdirSync(path.join(sb.coord, "usage"), { recursive: true }); fs.writeFileSync(path.join(sb.coord, "usage", "s-1.json"), JSON.stringify({ ts: Date.now() - minAgo * MIN, provider: "claude", pct: 20, resets_at: Math.round((Date.now() + 150 * MIN) / 1000), week_pct: 20, week_resets_at: Math.round((Date.now() + 5040 * MIN) / 1000) })); };
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "tick-state.json"), "utf8"));

test("resume: high first, then the oldest pause, max_resumes_per_tick per tick; a still-active source keeps them; a dry run relaunches nothing", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "L", { effort: "medium", closedMin: 50 }); closedLane(sb, "N1", { closedMin: 40 }); closedLane(sb, "N2", { closedMin: 30 }); closedLane(sb, "H", { effort: "xhigh", closedMin: 10 });
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "t", at: ago(60) }));
    let r = tick(sb);
    assert.doesNotMatch(r.out, /relaunch/); assert.deepEqual(launched(sb), []);
    fs.rmSync(path.join(sb.coord, "pause", "manual.json"));
    r = tick(sb, {}, "--dry-run");
    assert.deepEqual(r.out.split("\n").filter((l) => l.startsWith("would relaunch")), ["would relaunch H after its pause (manual pause)", "would relaunch N1 after its pause (manual pause)", "would relaunch N2 after its pause (manual pause)"]);
    assert.deepEqual(launched(sb), []);
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(launched(sb), ["H@1", "N1@1", "N2@1"]);
    assert.deepEqual(launchLog(sb)[0], ["H@1", "manual pause", "false"]); // fresh, the pause's reason as its first line, no incident
    assert.match(r.out, /^relaunched H after its pause \(manual pause\)$/m);
    tick(sb);
    assert.deepEqual(launched(sb), ["H@1", "N1@1", "N2@1", "L@1"]);
    tick(sb);
    assert.equal(launched(sb).length, 4); // all back: nothing pending
  } finally { sb.cleanup(); }
});

test("resume: a lane closed for pace waits min_pause_min; then a fresh 5-hour reading resumes it in full", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "P", { source: "pace", reason: "pace hold (x)", closedMin: 5, windows: ["five_hour"] });
    setUsage(sb, 1); // fresh
    tick(sb);
    assert.deepEqual(launched(sb), []);
    const reg = path.join(sb.reg, "sessions.jsonl"); // the close is 20 min old now
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(/"closed":"P","id":"P@1","at":"[^"]+"/, `"closed":"P","id":"P@1","at":"${ago(20)}"`));
    let r = tick(sb);
    assert.match(r.out, /^relaunched P after its pause \(pace hold \(x\)\)$/m);
    const key = Object.keys(state(sb).repause)[0];
    assert.equal(state(sb).repause[key].n, 1);
    // The pace pauses its relaunch again within 6 h of it: the second minimum pause is 2 x 15 min.
    const f = path.join(sb.coord, "pause", "tick-state.json");
    fs.writeFileSync(f, JSON.stringify({ ...state(sb), repause: { [key]: { n: 1, at: Date.now() - 60 * MIN } } }));
    const p2 = sb.registry().filter((o) => o.launched_at && o.name === "P").at(-1);
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(`"launched_at":"${p2.launched_at}"`, `"launched_at":"${ago(30)}"`)); // it ran 30 min ago
    appendLine(sb, { paused: p2.id, name: "P", group: null, at: ago(26), reason: "pace hold (y)", source: "pace", windows: ["five_hour"] });
    appendLine(sb, { closed: "P", id: p2.id, at: ago(25), why: "paused" });
    r = tick(sb);
    assert.doesNotMatch(r.out, /relaunched P/); // 25 min < 30
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(new RegExp(`"closed":"P","id":"${p2.id}","at":"[^"]+"`), `"closed":"P","id":"${p2.id}","at":"${ago(31)}"`));
    r = tick(sb);
    assert.match(r.out, /^relaunched P after its pause \(pace hold \(y\)\)$/m);
    assert.equal(state(sb).repause[key].n, 2);
  } finally { sb.cleanup(); }
});

test("probe resume: a pace pause that ended on a stale 5-hour reading relaunches one window lane, waits probe_wait_min, then the next", () => {
  const sb = sandbox();
  try {
    for (const n of ["A", "B", "C"]) closedLane(sb, n, { source: "pace", reason: "pace hold (x)", closedMin: 30 + n.charCodeAt(0), windows: ["five_hour"] });
    setUsage(sb, 20); // the newest 5-hour reading is stale
    let r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.match(r.out, /^relaunch of C after its pause failed/m);
    assert.equal(state(sb).probe ?? null, null); // a failed probe relaunch records no probe: the next tick tries again
    fs.rmSync(path.join(sb.tmp, "launches.txt"));
    r = tick(sb);
    assert.match(r.out, /^relaunched C after its pause \(pace hold \(x\)\) - a probe resume$/m); // the oldest pause first
    assert.deepEqual(launched(sb), ["C@1"]);
    assert.equal(state(sb).probe.id, "C@1");
    tick(sb);
    assert.deepEqual(launched(sb), ["C@1"]); // waiting for a fresh reading
    const f = path.join(sb.coord, "pause", "tick-state.json");
    fs.writeFileSync(f, JSON.stringify({ ...state(sb), probe: { id: "C@1", at: Date.now() - 11 * MIN } }));
    tick(sb);
    assert.deepEqual(launched(sb), ["C@1", "B@1"]); // none in 10 min: the next lane is probed
    setUsage(sb, 1);
    tick(sb);
    assert.deepEqual(launched(sb), ["C@1", "B@1", "A@1"]); // a fresh reading confirmed: the rest in full
    assert.equal(state(sb).probe, null);
  } finally { sb.cleanup(); }
});

test("a restricted tick (launch.mjs watchdog --repo) leaves the machine-wide pause state alone: no prune, no resume, the probe kept", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "A", { source: "pace", reason: "pace hold (x)", closedMin: 40, windows: ["five_hour"] });
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true });
    const ts = { skips: { "gone@1": 1 }, alerted: ["gone@1"], probe: { id: "X@1", at: Date.now() - 2 * MIN }, failed: { "gone@2": 1 }, repause: {} };
    fs.writeFileSync(path.join(sb.coord, "pause", "tick-state.json"), JSON.stringify(ts));
    const r = sb.run("watchdog", "--repo", sb.repo, "--stop-looping");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /relaunch/);
    assert.deepEqual(state(sb), ts); // untouched: an unrestricted tick owns it
    assert.equal(sb.registry().filter((o) => o.launched_at && o.name === "A").length, 1);
  } finally { sb.cleanup(); }
});

test("resume: a cap refusal defers the rest of the tick; a relaunch that fails twice is alerted once and left to the user", () => {
  const sb = sandbox();
  try {
    closedLane(sb, "A", { closedMin: 30 }); closedLane(sb, "B", { closedMin: 20 });
    let r = tick(sb, { HL_FAKE_RESUME: "cap" });
    assert.match(r.out, /^relaunch of A after its pause deferred: session cap \(6 sessions running, max_sessions 6\) - the next tick retries$/m);
    assert.deepEqual(launched(sb), ["A@1"]); // B not tried this tick
    r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.match(r.out, /^relaunch of A after its pause failed: the launcher exited 1: boom \(log .*\) - the next tick retries$/m);
    r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.match(r.out, /^gave up relaunching A - alert .*\.json$/m);
    const before = launched(sb).length;
    r = tick(sb, { HL_FAKE_RESUME: "fail" });
    assert.ok(!launched(sb).slice(before).includes("A@1")); // given up: only B is tried
  } finally { sb.cleanup(); }
});

test("the manifest: a pause close adds its lane, a paused hand-opened session its row; once resumed, one alert for the hand-opened ones and the archive", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", mode: "bg", bg_id: "bg-A", supersedes: null });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    setAgents(sb, [{ id: "bg-A", sessionId: "A-s1", name: "A", status: "idle" }]);
    appendLine(sb, { paused: e.id, name: "A", group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
    coordRun(sb, ["pause"]);
    const hand = "99999999-8888-7777-6666-555555555555";
    coordRun(sb, ["agent-gate"], { input: { session_id: hand, cwd: "/p", tool_name: "Agent", tool_input: {} } }); // the hook records it
    let r = tick(sb);
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m);
    const m = JSON.parse(fs.readFileSync(path.join(sb.coord, "paused.json"), "utf8"));
    assert.deepEqual(m.sessions.map((x) => [x.name, x.closed, x.session_id]), [["A", true, "A-s1"], [`hand-opened ${hand.slice(0, 8)}`, false, hand]]);
    assert.match(m.how_to_resume, /resume --paused/);
    coordRun(sb, ["resume"]);
    r = tick(sb);
    assert.match(r.out, /^relaunched A after its pause \(manual pause\)$/m);
    assert.match(r.out, /^the pause ended: 1 hand-opened session\(s\) to resume by hand - alert .*\.json$/m);
    assert.match(r.out, /^pause manifest archived: .*\/paused-\d{4}-\d\d-\d\d-\d{4}\.json$/m);
    assert.equal(fs.existsSync(path.join(sb.coord, "paused.json")), false);
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause", "seen")), []);
    const alert = fs.readdirSync(path.join(sb.coord, "alerts")).find((f) => /-paused\.json$/.test(f));
    assert.match(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", alert), "utf8")).text, new RegExp(`claude --resume ${hand} \\(in /p\\)`));
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-resume-tick.test.mjs`
Expected: FAIL - nothing is relaunched; no `paused.json`.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
// ---------- batch A, Part 3: windows whose claude is gone (dead start, exited) ----------
// Window entries only, every group.
````

**with:**

````js
// ---------- batch B, Part 4: resuming, and the paused-session manifest ----------
// The lanes a pause closed (pause-lib pausedLanes: a lane's newest entry with a {paused} line, closed or gone, no launch
// in flight) whose pause no longer applies are relaunched fresh from their handoff - the arguments `launch.mjs resume
// --paused` uses (freshLaunchArgs with the pause's reason as --resume-note), spawned under this tick's tick.lock, which
// `resume --paused` by hand also takes, so the two never relaunch one lane twice. In pause-lib resumePlan's order and
// number: high first, max_resumes_per_tick, a pace close not before its minimum pause (min_pause_min, doubled per
// consecutive pace re-pause of the lane, 4x at most: tick state `repause`), one window lane at a time while a probe
// resume waits for a fresh reading (the probe is recorded only when that lane's relaunch worked). A cap refusal ends this
// tick's relaunches (the next tick retries); a lane whose relaunch failed twice is alerted once and left to `launch.mjs
// resume --paused` by hand. An unrestricted tick only. -> lines
function resumeScan({ dryRun, cfg, now, ts }) {
  const out = [], reg = V.readRegistry(), sources = PI.readSources(now);
  const lanes = Q.pausedLanes({ entries: reg.entries, lines: reg.lines, closed: reg.closed, gone: (e) => V.liveness(e, reg).state === "gone", now });
  for (const id of Object.keys(ts.failed)) if (!lanes.some(({ e }) => e.id === id)) delete ts.failed[id]; // resumed or gone since
  for (const [k, v] of Object.entries(ts.repause)) if (!(now - v?.at <= 6 * 60 * L.MIN)) delete ts.repause[k]; // a series ends after 6 h
  const pending = lanes.filter(({ e }) => (ts.failed[e.id] || 0) < 2).map(({ e, line, closedAt }) => {
    const source = line.source ?? "manual", pausedAt = Date.parse(line.at) || 0, key = Q.lanePauseKey(e);
    const n = source === "pace" ? Q.repauseCount(ts.repause[key], pausedAt) : 1;
    return { e, key, n, priority: G.effectivePriority(reg.lines, e), source, windows: Array.isArray(line.windows) ? line.windows : [], reason: line.reason ?? "paused", pausedAt, closedAt, ...(source === "pace" ? { minPause: Q.minPauseFor(n, cfg) } : {}) };
  });
  if (!pending.length) { if (!dryRun) ts.probe = null; return out; }
  const pace = P.paceFresh(V.readJson(IO.PACE_FILE, null), now, cfg.pace)?.claude ?? null;
  const plan = Q.resumePlan({ pending, pauseOf: (p) => Q.pauseFor(p, sources), pace, now, cfg, probe: ts.probe });
  const ok = new Set();
  for (const p of plan.relaunch) {
    const e = p.e, what = `${e.name} after its pause (${p.reason})${plan.mode === "probe" ? " - a probe resume" : ""}`;
    if (dryRun) { out.push(`would relaunch ${what}`); continue; }
    touchTickLock();
    const r = spawnLaunch(e.name, L.freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", resumeNote: p.reason, priority: p.priority, supersedes: e.id }));
    if (r.cap) { out.push(`relaunch of ${e.name} after its pause deferred: session cap (${r.cap}) - the next tick retries`); break; }
    if (r.ok) {
      ok.add(e.id);
      if (p.source === "pace") ts.repause[p.key] = { n: p.n, at: now };
      out.push(`relaunched ${what}`);
      continue;
    }
    const n = (ts.failed[e.id] || 0) + 1;
    ts.failed[e.id] = n;
    out.push(`relaunch of ${e.name} after its pause failed: ${r.why} (log ${r.log})${n < 2 ? " - the next tick retries" : ""}`);
    if (n >= 2) out.push(`gave up relaunching ${e.name} - alert ${fwd(raiseAlert({ name: e.name, text: `Relaunch of ${e.name} after its pause failed twice: ${r.why} (log ${r.log}). Fix it, then: node ${fwd(LAUNCH)} resume --paused --id ${e.id}`, incident: null }))}`);
  }
  if (!dryRun) {
    if (plan.mode !== "probe") ts.probe = null;
    else if (!plan.relaunch.length || ok.has(plan.probe?.id)) ts.probe = plan.probe; // waiting, or this probe started
  }
  return out;
}
// The manifest, <coord>/paused.json (the tick is its only writer): a row per lane the pause close took this tick (the
// newest generation of a lane only) and per hand-opened session the hooks recorded while paused (pause/seen); a closed
// row gets resumed_at once its lane has a newer launch. When no source is active: one phone alert listing the
// hand-opened sessions' `claude --resume <id>` commands, and the archive (paused-<date>-<HHMM>.json) once every closed
// row is resumed. An unrestricted tick only (the manifest is machine-wide). -> lines
function manifestTick({ dryRun, now, closed }) {
  if (dryRun) return [];
  const active = PI.readSources(now).length > 0, reg = V.readRegistry();
  let m = V.readJson(PI.MANIFEST, null);
  const rows = closed.map(({ e, priority, reason }) => Q.laneRow(e, { priority, reason }));
  if (active) rows.push(...PI.readSeen().map((s) => Q.handRow(s)));
  if (!m && !rows.length) return [];
  const before = JSON.stringify(m), out = [];
  if (rows.length) m = Q.upsertRows(m, rows, now, Q.HOW_TO_RESUME(fwd(LAUNCH)));
  m = Q.markResumed(m, (r) => [...reg.entries].reverse().find((x) => x.repo === r.repo && x.name === r.name && (x.group ?? null) === (r.group ?? null)) ?? null);
  const hands = m.sessions.filter((r) => !r.closed);
  if (!active && hands.length && !m.hand_alerted) {
    m = { ...m, hand_alerted: V.now() };
    out.push(`the pause ended: ${hands.length} hand-opened session(s) to resume by hand - alert ${fwd(raiseAlert({ name: "paused", text: Q.HAND_RESUME_TEXT(hands), incident: null }))}`);
  }
  if (Q.archiveDue(m, active)) {
    const to = C(Q.archiveName(m));
    try {
      V.writeAtomic(to, JSON.stringify(m, null, 2));
      fs.rmSync(PI.MANIFEST, { force: true });
      for (const s of PI.readSeen()) fs.rmSync(s.file, { force: true });
      out.push(`pause manifest archived: ${fwd(to)}`);
    } catch (err) { out.push(`error: paused.json not archived (${err?.code || err?.message || err})`); }
    return out;
  }
  if (JSON.stringify(m) !== before) out.push(...writeState(PI.MANIFEST, m, "paused.json"));
  return out;
}

// ---------- batch A, Part 3: windows whose claude is gone (dead start, exited) ----------
// Window entries only, every group.
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
    out.push(...goneScan({ dryRun, cfg, now: Date.now(), repoKey }));
    if (ts && !dryRun && JSON.stringify(ts) !== tsBefore) out.push(...writeState(PI.TICK_STATE, ts, "pause/tick-state.json"));
````

**with:**

````js
    out.push(...goneScan({ dryRun, cfg, now: Date.now(), repoKey }));
    if (ts) out.push(...resumeScan({ dryRun, cfg, now: Date.now(), ts }), ...manifestTick({ dryRun, now: Date.now(), closed: pz.closed }));
    if (ts && !dryRun && JSON.stringify(ts) !== tsBefore) out.push(...writeState(PI.TICK_STATE, ts, "pause/tick-state.json"));
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-resume-tick.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/tests/pause-resume-tick.test.mjs
git commit -m "feat(pause): the tick relaunches paused lanes (cap, min pause, probe resume) and keeps the paused-session manifest"
```

---

### Task 14: the watcher (`coord.mjs watch`), started by the tick

**Files:**
- Create: `claude/skills/handoff-launch/tests/watch.test.mjs`
- Modify: `claude/skills/handoff-launch/pause-io.mjs`
- Modify: `claude/hooks/coord.mjs`
- Modify: `claude/skills/handoff-launch/recover.mjs`

**Interfaces:**
- Consumes: Tasks 8, 9, 11, 13; `live.mjs` `COORD_MJS`, `pidAlive`, `procInfo`, `selfStart`, `launcherEnv`, `killPidTree`,
  `forgetLiveness` (no argument: every id and the agents list - it exists).
- Produces: `pause-io.mjs` `WATCH_LOCK`, `WATCH_START`, `watchHolder()`, `takeWatchLock()`, `releaseWatchLock()`,
  `watchNeeded({active, openLanes, pending})`, `ensureWatcher(by, now) -> "running"|"recent"|"started"|"recorded"|
  "failed"`; `coord.mjs` `watchStep({now, started, last}) -> {stop} | {lines, ticked, last: {at, acted}}` (fresh
  liveness every step; the tick state's `alerted` and `failed >= 2` lanes trigger nothing; after a tick that closed and
  relaunched nothing, the next one waits 5 min), `watch({once, started, intervalMs}) -> lines`, `watchStop()`; CLI
  `coord.mjs watch [--once] [--started <ms>]` and `watch --stop`; `recover.mjs` `watcherTick({dryRun, now})` after
  `writeLanes` (unrestricted ticks): `watcher started (a pause is active | lanes wait for their pause resume)` /
  `would start the watcher (...)`.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/watch.test.mjs`:

````js
// Batch B, Part 4: the watcher (`coord.mjs watch`): single instance, its one step (--once), its stop rule (a fake start
// time stands in for the clock), the tick starting it. HL_NO_SPAWN: nothing is ever started detached here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sandbox, coordRun, sessionLine, appendLine, writeTranscript, setAgents, tx, alive, COORD_MJS } from "./helpers.mjs";
import { sleep } from "../live.mjs";

const MIN = 60000, DAY = 24 * 60 * MIN, ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const watch = (sb, ...a) => coordRun(sb, ["watch", ...a]);
const manual = (sb) => { fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true }); fs.writeFileSync(path.join(sb.coord, "pause", "manual.json"), JSON.stringify({ until: null, by: "t", at: ago(5) })); };
function bgLane(sb, name, pausedMin) {
  const e = sessionLine(sb, { name, id: `${name}@1`, branch: name.toLowerCase(), sid: `${name}-s1`, mode: "bg", bg_id: `bg-${name}`, supersedes: null });
  writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
  setAgents(sb, [{ id: `bg-${name}`, sessionId: `${name}-s1`, name, status: "idle" }]);
  if (pausedMin != null) appendLine(sb, { paused: e.id, name, group: null, at: ago(pausedMin), reason: "manual pause", source: "manual", windows: [] });
  return e;
}
const startOf = (pid) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8" }).stdout.trim();

test("watch --once: nothing paused stops it at once and releases its lock", () => {
  const sb = sandbox();
  try {
    const r = watch(sb, "--once");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "watch: stopped - nothing is paused or waiting to resume\n");
    assert.equal(fs.existsSync(path.join(sb.coord, "watch.lock")), false);
  } finally { sb.cleanup(); }
});

test("watch --once: an open paused lane makes it run a tick (which closes it); a source with nothing to act on runs none", () => {
  const sb = sandbox();
  try {
    manual(sb);
    let r = watch(sb, "--once");
    assert.equal(r.out, "watch: one step done\n"); // a source, no lane: it waits, no tick
    assert.equal(fs.existsSync(path.join(sb.coord, "last-tick.txt")), false);
    bgLane(sb, "A", 3);
    r = watch(sb, "--once");
    assert.match(r.out, /^closed A \(gen 1\): paused \(manual pause\)$/m);
    assert.match(r.out, /^watch: one step done \(a tick ran\)$/m);
  } finally { sb.cleanup(); }
});

test("watch --once leaves out lanes the tick gave up on: a relaunch failed twice, a close alerted - no tick for them", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", supersedes: null }); // closed by a pause, relaunch failed twice
    appendLine(sb, { paused: a.id, name: "A", group: null, at: ago(30), reason: "manual pause", source: "manual", windows: [] });
    appendLine(sb, { closed: "A", id: a.id, at: ago(29), why: "paused" });
    fs.mkdirSync(path.join(sb.coord, "pause"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "pause", "tick-state.json"), JSON.stringify({ failed: { [a.id]: 2 }, alerted: ["B@1"] }));
    let r = watch(sb, "--once");
    assert.equal(r.out, "watch: stopped - nothing is paused or waiting to resume\n");
    manual(sb);
    bgLane(sb, "B", 3); // open, paused, its close alerted
    setAgents(sb, [{ id: "bg-B", sessionId: "B-s1", name: "B", status: "idle" }]);
    r = watch(sb, "--once");
    assert.equal(r.out, "watch: one step done\n"); // nothing it can act on: no tick
    assert.equal(fs.existsSync(path.join(sb.coord, "last-tick.txt")), false);
  } finally { sb.cleanup(); }
});

test("watch steps in one process: fresh liveness every step (no memo across steps), and a 5-min back-off after a tick that did nothing", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const e = sessionLine(sb, { name: "A", id: "A@1", branch: "a", sid: "A-s1", mode: "bg", bg_id: "bg-A", supersedes: null });
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: Date.now() - 10 * MIN }).user("go").say("saved").turnDone().entries());
    appendLine(sb, { paused: e.id, name: "A", group: null, at: ago(3), reason: "manual pause", source: "manual", windows: [] });
    const running = JSON.stringify([{ id: "bg-A", sessionId: "A-s1", name: "A", status: "working" }]); // busy: never closed
    const agents = path.join(sb.tmp, "agents.json");
    fs.writeFileSync(agents, running);
    const script = `const fs = await import("node:fs"), C = await import(${JSON.stringify(pathToFileURL(COORD_MJS).href)});
const step = (last) => C.watchStep({ now: Date.now(), started: Date.now(), last });
const out = [], a = await step(null); out.push(a.ticked, a.last?.acted);
fs.writeFileSync(${JSON.stringify(agents)}, "[]"); // A's background session is gone now
out.push((await step(null)).ticked);
fs.writeFileSync(${JSON.stringify(agents)}, ${JSON.stringify(running)});
out.push((await step({ at: Date.now() - 60000, acted: false })).ticked, (await step({ at: Date.now() - 6 * 60000, acted: false })).ticked);
console.log(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: sb.env, encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    // ticked (busy: nothing acted); then gone - seen at once, so no tick; then running again but backing off; 6 min later a tick
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)), [true, false, false, false, true]);
  } finally { sb.cleanup(); }
});

test("watch stops itself 8 days after its start even while a source is active", () => {
  const sb = sandbox();
  try {
    manual(sb);
    const r = watch(sb, "--once", "--started", String(Date.now() - 8 * DAY - MIN));
    assert.equal(r.out, "watch: stopped - 8 days since its start - the next tick restarts it if it is still needed\n");
  } finally { sb.cleanup(); }
});

test("the tick starts the watcher while a source is active over an open lane, or a lane waits for its resume; at most once a minute", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "R", id: "R@1", branch: "r", sid: "R-s1", mode: "bg", bg_id: "bg-R", supersedes: null });
    setAgents(sb, [{ id: "bg-R", sessionId: "R-s1", name: "R", status: "running" }]);
    assert.doesNotMatch(coordRun(sb, ["tick"]).out, /watcher/); // no source: not needed
    manual(sb);
    assert.match(coordRun(sb, ["tick", "--dry-run"]).out, /^would start the watcher \(a pause is active\)$/m);
    assert.equal(fs.existsSync(path.join(sb.coord, "watch-start.json")), false);
    assert.match(coordRun(sb, ["tick"]).out, /^watcher started \(a pause is active\)$/m); // HL_NO_SPAWN: recorded only
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "watch-start.json"), "utf8")).by, "tick");
    assert.doesNotMatch(coordRun(sb, ["tick"]).out, /watcher/); // started under a minute ago
  } finally { sb.cleanup(); }
});

test("one watcher at a time: a live holder keeps the lock; a dead holder's lock is taken; --stop with none running says so", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  try {
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "watch.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, start: startOf(holder.pid), at: new Date().toISOString() }));
    assert.equal(watch(sb, "--once").out, "watch: another watcher runs\n");
    const r = watch(sb, "--stop");
    assert.equal(r.out, `watch: stopped ${holder.pid}\n`);
    for (let i = 0; i < 50 && alive(holder.pid); i++) sleep(100);
    assert.equal(alive(holder.pid), false);
    fs.writeFileSync(lock, JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid, start: new Date().toISOString(), at: new Date().toISOString() }));
    assert.equal(watch(sb, "--once").out, "watch: stopped - nothing is paused or waiting to resume\n"); // the dead holder's lock was taken
    assert.equal(watch(sb, "--stop").out, "watch: no watcher running\n");
  } finally { try { holder.kill(); } catch {} sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/watch.test.mjs`
Expected: FAIL - `coord.mjs watch` prints nothing; no `watch-start.json`.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/pause-io.mjs`:

````js
import fs from "node:fs";
import path from "node:path";
import { COORD, readJson, writeAtomic } from "./live.mjs";
````

**with:**

````js
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { COORD, COORD_MJS, readJson, writeAtomic, pidAlive, procInfo, selfStart, launcherEnv } from "./live.mjs";
````

**Replace** in `claude/skills/handoff-launch/pause-io.mjs`:

````js
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
````

**with:**

````js
// ---------- the watcher's lock and start (coord.mjs watch; the tick starts it) ----------
export const WATCH_LOCK = path.join(COORD, "watch.lock");
export const WATCH_START = path.join(COORD, "watch-start.json");
// The watcher holding watch.lock while it still runs: its pid is alive and, on Windows, a node process that started
// within 2 s of the lock's start (a reused pid is not it). A failed probe is no answer: the holder counts as running
// (never two watchers on a guess). -> the lock {pid, start, at}, or null
export function watchHolder() {
  const h = readJson(WATCH_LOCK, null);
  if (!h || !Number.isInteger(h.pid) || !pidAlive(h.pid)) return null;
  if (process.platform !== "win32" || !h.start) return h;
  const p = procInfo([h.pid])?.get(h.pid);
  if (!p) return h;
  return p.name !== "DEAD" && /^node$/i.test(p.name) && !!p.start && Math.abs(Date.parse(p.start) - Date.parse(h.start)) <= 2000 ? h : null;
}
// Exclusive create (wx, as tick.lock), so exactly one watcher wins. A lock whose holder is gone is moved aside and
// removed - only the one judged dead here: if another watcher replaced it meanwhile, it is put back. -> bool
export function takeWatchLock() {
  fs.mkdirSync(COORD, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(WATCH_LOCK, JSON.stringify({ pid: process.pid, start: selfStart(), at: new Date().toISOString() }), { flag: "wx" }); return true; }
    catch (e) { if (e.code !== "EEXIST") return false; }
    const held = readJson(WATCH_LOCK, null);
    if (watchHolder()) return false;
    const aside = `${WATCH_LOCK}.reclaimed-${process.pid}`;
    try { fs.renameSync(WATCH_LOCK, aside); } catch { continue; }
    if (JSON.stringify(readJson(aside, null)) === JSON.stringify(held)) fs.rmSync(aside, { force: true });
    else { try { fs.renameSync(aside, WATCH_LOCK); } catch {} return false; }
  }
  return false;
}
export const releaseWatchLock = () => { try { if (readJson(WATCH_LOCK, {})?.pid === process.pid) fs.rmSync(WATCH_LOCK, { force: true }); } catch {} };
// Needed while a source is active over an open lane, or while a lane waits for its pause resume (nothing else wakes an
// idle machine: ticks come from hooks).
export const watchNeeded = ({ active, openLanes, pending }) => (active && openLanes > 0) || pending > 0;
// Start the hidden, detached watcher (`coord.mjs watch`) unless one runs, or one was started in the last minute (a
// watcher that dies at its start is not respawned more than once a minute). HL_NO_SPAWN records the start, spawns
// nothing. -> "running" | "recent" | "started" | "recorded" | "failed"
export function ensureWatcher(by, now = Date.now()) {
  if (watchHolder()) return "running";
  const last = Date.parse(readJson(WATCH_START, {})?.at);
  if (last <= now && now - last < 60000) return "recent";
  try {
    writeAtomic(WATCH_START, JSON.stringify({ at: new Date(now).toISOString(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return "recorded";
    spawn(process.execPath, [COORD_MJS, "watch"], { detached: true, stdio: "ignore", windowsHide: true, env: launcherEnv() }).on("error", () => {}).unref();
    return "started";
  } catch { return "failed"; }
}
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
````

**Replace** in `claude/hooks/coord.mjs`:

````js
//   pause [30m | 2h | until HH:MM] | resume   the manual pause source (batch B, Part 4; /broadcast runs them)
````

**with:**

````js
//   pause [30m | 2h | until HH:MM] | resume   the manual pause source (batch B, Part 4; /broadcast runs them)
//   watch [--once] [--started <ms>] | watch --stop   the hidden single-instance watcher (Part 4): a step every 60 s while
//                anything is paused; the tick starts it, it stops itself
````

**Replace** in `claude/hooks/coord.mjs`:

````js
const stdinRaw = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
````

**with:**

````js
// ---------- Part 4: the watcher (who wakes an idle machine) ----------
const WEEK_MS = 8 * 24 * 3600e3;
// One step: pace.json from the usage files, the sources, the open lanes that wrote {paused} and the lanes waiting for
// their resume - leaving out the ones the tick gave up on (alerted: a close skipped twice; failed: a relaunch failed
// twice), which nothing can act on until the user does. Every step starts from fresh liveness: the watcher lives for
// days and live.mjs memoizes liveness and the agents list per process. Stops when no source is active and nothing is
// paused or waiting, or 8 days after its start (a weekly window; the next tick restarts it if still needed). Runs a tick
// only when it can act - a paused lane is open (to close it), or a waiting lane's pause no longer applies (to relaunch
// it) - and, after a tick that closed and relaunched nothing, at most every 5 min. last: the previous tick {at, acted}.
// -> {stop: why} | {lines, ticked, last}
export async function watchStep({ now, started, last = null }) {
  const [{ V, cfg }, IO, PI, Q, G] = await Promise.all([context(), mod("pace-io.mjs"), mod("pause-io.mjs"), mod("pause-lib.mjs"), mod("lane-lib.mjs")]);
  V.forgetLiveness(); // every id, and the agents list
  IO.recomputePace({ now, cfg: cfg.pace });
  const sources = PI.readSources(now), reg = V.readRegistry(), ts = readJson(PI.TICK_STATE, {});
  const alerted = new Set(Array.isArray(ts.alerted) ? ts.alerted : []), failed = isObj(ts.failed) ? ts.failed : {};
  const openPaused = reg.entries.filter((e) => !reg.closed.has(e.id) && !alerted.has(e.id) && Q.pausedLineOf(reg.lines, e) && V.liveness(e, reg).state !== "gone");
  const pending = Q.pausedLanes({ entries: reg.entries, lines: reg.lines, closed: reg.closed, gone: (e) => V.liveness(e, reg).state === "gone", now })
    .filter(({ e }) => !((failed[e.id] || 0) >= 2));
  if (!sources.length && !openPaused.length && !pending.length) return { stop: "nothing is paused or waiting to resume" };
  if (now - started >= WEEK_MS) return { stop: "8 days since its start - the next tick restarts it if it is still needed" };
  const canResume = pending.some(({ e }) => !Q.pauseFor(G.effectivePriority(reg.lines, e), sources).paused);
  if (!openPaused.length && !canResume) return { lines: [], ticked: false, last };
  if (last && !last.acted && now - last.at < 5 * 60000) return { lines: [], ticked: false, last }; // backing off
  const lines = (await mod("recover.mjs")).tick();
  return { lines, ticked: true, last: { at: now, acted: lines.some((l) => /^(closed|relaunched) /.test(l)) } };
}
// `coord.mjs watch [--once] [--started <epoch ms>]`: the single-instance loop (watch.lock), a step every 60 s; its last
// step's lines in <coord>/watch-last.txt. --once (tests) runs one step; --started (tests) stands in for its start. -> lines
export async function watch({ once = false, started = Date.now(), intervalMs = 60000 } = {}) {
  const PI = await mod("pause-io.mjs");
  if (!PI.takeWatchLock()) return ["watch: another watcher runs"];
  const out = [];
  let last = null;
  try {
    for (;;) {
      let s; try { s = await watchStep({ now: Date.now(), started, last }); } catch (err) { s = { lines: [`watch: step failed (${err?.message || err})`], last }; }
      if (s.stop) { out.push(`watch: stopped - ${s.stop}`); break; }
      last = s.last ?? last;
      if (once) { out.push(...s.lines, s.ticked ? "watch: one step done (a tick ran)" : "watch: one step done"); break; }
      if (s.lines.length) { try { fs.writeFileSync(path.join(COORD, "watch-last.txt"), `${new Date().toISOString()}\n${s.lines.join("\n")}\n`); } catch {} }
      await new Promise((done) => setTimeout(done, intervalMs));
    }
  } finally { PI.releaseWatchLock(); }
  return out;
}
// `coord.mjs watch --stop`: the running watcher's tree is killed (only the process the lock names: watchHolder's check).
export async function watchStop() {
  const [PI, V] = await Promise.all([mod("pause-io.mjs"), mod("live.mjs")]);
  const h = PI.watchHolder();
  if (!h) { try { fs.rmSync(PI.WATCH_LOCK, { force: true }); } catch {} return "watch: no watcher running"; }
  const k = V.killPidTree(h.pid);
  if (k.ok) { try { fs.rmSync(PI.WATCH_LOCK, { force: true }); } catch {} }
  return k.ok ? `watch: stopped ${h.pid}` : `watch: ${h.pid} not stopped (${k.why})`;
}

const stdinRaw = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
````

**Replace** in `claude/hooks/coord.mjs`:

````js
  } else if (sub === "pause" || sub === "resume") {
````

**with:**

````js
  } else if (sub === "watch") {
    if (argv.includes("--stop")) await write(`${await watchStop()}\n`);
    else {
      const i = argv.indexOf("--started"), started = i > 0 ? Number(argv[i + 1]) : Date.now();
      await write(`${(await watch({ once: argv.includes("--once"), started: Number.isFinite(started) ? started : Date.now() })).join("\n")}\n`);
    }
  } else if (sub === "pause" || sub === "resume") {
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
// ---------- one tick ----------
````

**with:**

````js
// ---------- batch B, Part 4: the watcher wakes an idle machine ----------
// Ticks come only from hooks, so a fully paused machine gets none: start the watcher while a source is active over an
// open lane, or while a lane waits for its pause resume (pause-io watchNeeded). An unrestricted tick only. -> lines
function watcherTick({ dryRun, now }) {
  const reg = V.readRegistry(), active = PI.readSources(now).length > 0;
  const openLanes = reg.entries.filter((e) => !reg.closed.has(e.id) && V.liveness(e, reg).state !== "gone").length;
  const pending = Q.pausedLanes({ entries: reg.entries, lines: reg.lines, closed: reg.closed, gone: (e) => V.liveness(e, reg).state === "gone", now }).length;
  if (!PI.watchNeeded({ active, openLanes, pending })) return [];
  const why = active ? "a pause is active" : "lanes wait for their pause resume";
  if (dryRun) return PI.watchHolder() ? [] : [`would start the watcher (${why})`];
  const r = PI.ensureWatcher("tick", now);
  return r === "started" || r === "recorded" ? [`watcher started (${why})`] : r === "failed" ? ["error: the watcher could not be started"] : [];
}

// ---------- one tick ----------
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
    out.push(...writeLanes({ dryRun, repoKey, now: Date.now() }));
````

**with:**

````js
    out.push(...writeLanes({ dryRun, repoKey, now: Date.now() }));
    if (!repoKey) out.push(...watcherTick({ dryRun, now: Date.now() }));
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/watch.test.mjs`
Expected: PASS, `ℹ fail 0`. No test starts a detached process (`HL_NO_SPAWN=1`; `--once`).

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/pause-io.mjs claude/hooks/coord.mjs claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/tests/watch.test.mjs
git commit -m "feat(pause): a single-instance watcher wakes an idle machine while anything is paused, and stops itself"
```

---

### Task 15: `status` and `sessions`: `paused (<reason>, since HH:MM)` and the pace header

**Files:**
- Create: `claude/skills/handoff-launch/tests/pause-status.test.mjs`
- Modify: `claude/skills/handoff-launch/launch.mjs`

**Interfaces:**
- Consumes: Task 8 `pausedLineOf`; Task 1 `paceHeader`, `paceFresh`; `live.mjs` `coordConfig`.
- Produces: a `paused (...)` lane note (status: any lane whose newest launch wrote `{paused}`; sessions: open lanes);
  a first line `pace: claude 5h 42% wk 31% slow · codex wk 12% ok` from a fresh `pace.json` only (none: the output is
  byte-identical to before).

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/pause-status.test.mjs`:

````js
// Batch B, Part 4 "Status": `paused (<reason>, since HH:MM)` per lane and the pace header in status and sessions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, sessionLine, appendLine, setAgents } from "./helpers.mjs";

const MIN = 60000, at = new Date(Date.now() - 20 * MIN).toISOString(), hhmm = new Date(at).toTimeString().slice(0, 5);
const pace = (sb, updated = Date.now()) => { fs.mkdirSync(sb.coord, { recursive: true }); fs.writeFileSync(path.join(sb.coord, "pace.json"), JSON.stringify({ updated,
  claude: { state: "slow", pct: 42, week_pct: 31, ahead: 11, week_ahead: 0, since: 1 }, codex: { state: "ok", pct: null, week_pct: 12, ahead: null, week_ahead: -30, since: 1 } })); };

test("status: a lane closed by a pause shows `paused (<reason>, since HH:MM)`; a relaunched one does not", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", group: "g1", branch: "a", sid: "a-s1", supersedes: null });
    appendLine(sb, { paused: a.id, name: "A", group: "g1", at, reason: "pace hold (5h +22 / week +1)", source: "pace", windows: ["five_hour"] });
    appendLine(sb, { closed: "A", id: a.id, at, why: "paused" });
    let r = sb.run("status", "--group", "g1");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^A .*\\(window closed\\)  paused \\(pace hold \\(5h \\+22 / week \\+1\\), since ${hhmm}\\)$`, "m"));
    sessionLine(sb, { name: "A", id: "A@2", gen: 2, group: "g1", branch: "a", sid: "a-s2", supersedes: a.id, launched_at: new Date().toISOString() });
    r = sb.run("status", "--group", "g1");
    assert.doesNotMatch(r.out, /paused \(/);
  } finally { sb.cleanup(); }
});

test("sessions: an open paused lane shows the note; status and sessions print the pace header from a fresh pace.json only", () => {
  const sb = sandbox();
  try {
    const b = sessionLine(sb, { name: "B", id: "B@1", group: "g1", branch: "b", sid: "b-s1", mode: "bg", bg_id: "bg-B", supersedes: null });
    setAgents(sb, [{ id: "bg-B", sessionId: "b-s1", name: "B", status: "idle" }]);
    appendLine(sb, { paused: b.id, name: "B", group: "g1", at, reason: "manual pause", source: "manual", windows: [] });
    let r = sb.run("sessions");
    assert.match(r.out, new RegExp(`^B  .*  paused \\(manual pause, since ${hhmm}\\)$`, "m"));
    assert.doesNotMatch(r.out, /^pace:/m);
    const before = sb.run("status", "--group", "g1").out;
    pace(sb);
    r = sb.run("sessions");
    assert.equal(r.out.split("\n")[0], "pace: claude 5h 42% wk 31% slow · codex wk 12% ok");
    assert.equal(sb.run("status", "--group", "g1").out, `pace: claude 5h 42% wk 31% slow · codex wk 12% ok\n${before}`);
    pace(sb, Date.now() - 16 * MIN); // stale: absent
    assert.equal(sb.run("status", "--group", "g1").out, before);
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-status.test.mjs claude/skills/handoff-launch/tests/lanes.test.mjs`
Expected: FAIL - no `paused (` note, no `pace:` header.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
import { pausedLanes } from "./pause-lib.mjs";
````

**with:**

````js
import { pausedLanes, pausedLineOf } from "./pause-lib.mjs";
import { paceHeader, paceFresh } from "./pace-lib.mjs";
import { coordConfig } from "./live.mjs";
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
  return [ds ? `DEAD-START (since ${ds.at})` : "", n ? `inbox=${n}` : "", goal].filter(Boolean).map((x) => `  ${x}`).join("");
}
````

**with:**

````js
  return [ds ? `DEAD-START (since ${ds.at})` : "", n ? `inbox=${n}` : "", goal, pausedNote(e)].filter(Boolean).map((x) => `  ${x}`).join("");
}
// Batch B, Part 4: `paused (<reason>, since HH:MM)` (local time) for a lane whose newest launch wrote a {paused} line -
// open and paused, or closed by the pause and waiting for its resume. "" otherwise.
const pausedNote = (e) => { const p = pausedLineOf(reg.lines, e); return p ? `paused (${p.reason || "paused"}, since ${new Date(p.at).toTimeString().slice(0, 5)})` : ""; };
// Batch B: the pace header of status and sessions, `pace: claude 5h 42% wk 31% slow · codex wk 12% ok`, from a fresh
// pace.json only (none: nothing printed, so the output stays as it was).
function paceHeaderLine() { const h = paceHeader(paceFresh(readJson(path.join(COORD, "pace.json"), null), Date.now(), coordConfig().pace)); if (h) console.log(h); }
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
  if (!group) { console.error("status needs --group <id>"); process.exit(2); }
````

**with:**

````js
  if (!group) { console.error("status needs --group <id>"); process.exit(2); }
  paceHeaderLine();
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null, nowMs = Date.now();
  // Liveness before the newest pick
````

**with:**

````js
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null, nowMs = Date.now();
  paceHeaderLine();
  // Liveness before the newest pick
````

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

````js
    console.log(`${e.name}  ${e.repo}@${e.branch}  group=${e.group ?? "-"}  gen ${e.generation ?? "?"}  ${lv.state}  ${turn}  priority=${G.effectivePriority(reg.lines, e)}  ${gp ? goalText(gp) : "no GOAL.md"}`);
````

**with:**

````js
    const pz = pausedNote(e);
    console.log(`${e.name}  ${e.repo}@${e.branch}  group=${e.group ?? "-"}  gen ${e.generation ?? "?"}  ${lv.state}  ${turn}  priority=${G.effectivePriority(reg.lines, e)}  ${gp ? goalText(gp) : "no GOAL.md"}${pz ? `  ${pz}` : ""}`);
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/pause-status.test.mjs claude/skills/handoff-launch/tests/lanes.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/launch.mjs claude/skills/handoff-launch/tests/pause-status.test.mjs
git commit -m "feat(pause): status and sessions show paused lanes and the pace header"
```

---

### Task 16: the `/broadcast` skill

**Files:**
- Create: `claude/skills/broadcast/SKILL.md`
- Create: `claude/skills/handoff-launch/tests/broadcast-skill.test.mjs`

**Interfaces:**
- Consumes: the CLIs of Tasks 9, 12 and the tick (`coord.mjs pause | resume | tick`, `launch.mjs resume --paused --all`),
  `paused.json` (Task 13); the session tools `ListAgents` and `SendMessage`.
- Produces: `claude/skills/broadcast/SKILL.md` (verbs `pause [30m | until HH:MM]`, `resume`, `restart`, anything else
  relayed). `restart` runs `coord.mjs resume`, then `coord.mjs tick` in the foreground (the tick relaunches under its
  lock; a held lock means one is already doing it), never a parallel `resume --paused`. Deploy:
  `~/.claude/skills/broadcast/`.

- [ ] **Step 1: Write the failing test**

**Create** `claude/skills/handoff-launch/tests/broadcast-skill.test.mjs`:

````js
// Batch B, Part 6: the /broadcast skill is text; this pins its frontmatter and that every command it tells a session to
// run exists with that shape (coord.mjs pause/resume/tick, launch.mjs resume --paused --all).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun } from "./helpers.mjs";

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "broadcast", "SKILL.md");

test("broadcast SKILL.md: frontmatter, the four verbs, and the commands it names", () => {
  const t = fs.readFileSync(SKILL, "utf8");
  assert.match(t, /^---\nname: broadcast\ndescription: Use when .+\n---\n/);
  for (const s of ["`ListAgents`", "`SendMessage`", 'node "COORD" pause <args>', 'node "COORD" resume', 'node "COORD" tick', 'node "LAUNCH" resume --paused --all', "claude --resume <session_id> -n <name>"]) assert.ok(t.includes(s), s);
  assert.doesNotMatch(t, /[A-Z]:[\\/]Users[\\/]|\b[\w.-]+@(?!example\.com\b)[\w-]+\.[a-z]{2,}\b/i); // a public repo: no personal paths or addresses
});

test("the commands /broadcast runs answer as the skill says", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["pause", "30m"]);
    assert.equal(r.code, 0); assert.match(r.out, /^Broadcast: Paused \(manual pause until .*\): start no new agents or tasks\./m);
    r = coordRun(sb, ["resume"]);
    assert.equal(r.code, 0); assert.match(r.out, /^Broadcast: resume your saved work\.$/m);
    r = coordRun(sb, ["tick"]);
    assert.equal(r.code, 0, r.err);
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "no paused lanes to relaunch\n");
  } finally { sb.cleanup(); }
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/broadcast-skill.test.mjs`
Expected: FAIL - `ENOENT ... broadcast/SKILL.md`.

- [ ] **Step 3: Write the skill**

**Create** `claude/skills/broadcast/SKILL.md`:

````markdown
---
name: broadcast
description: Use when the user wants to tell every running Claude Code session something at once - pause all sessions (now, for 30m, or until HH:MM), resume them, reopen the sessions a pause closed, or relay any other message to every peer session ("/broadcast pause 30m", "tell all sessions to ...").
---

# Broadcast

Send one message to every live peer session from this one (the "master"), and drive the one pause protocol of the
handoff-launch coordinator. `<coord>` is `<config>/state/coord`; `<config>` is `CLAUDE_CONFIG_DIR` if set, otherwise
`~/.claude`. `COORD` below is `<config>/hooks/coord.mjs`, `LAUNCH` is `<config>/skills/handoff-launch/launch.mjs`.
Write every path with forward slashes and in double quotes.

## 1. Find the peers
Call `ListAgents`. The peers are every row that is live (interactive or background) and is not this session. Skip
offline Remote Control rows. Keep the list: you report on it at the end.

## 2. The verb
The first word of the user's message picks the verb:

- **`pause [30m | 2h | until HH:MM]`** (nothing after it: no end). Run `node "COORD" pause <args>` first. It writes the
  manual pause source and prints a `Broadcast:` line. Send that line's text, word for word, to every peer.
  A timed pause needs no reminder: its `until` expires on its own and the coordinator's watcher resumes the lanes
  (CronCreate one-shots fire only while this session is open and idle, so they are not used).
- **`resume`**. Run `node "COORD" resume`. It removes the manual pause (and an old `pause.json`) and wakes a tick that
  relaunches the lanes the pause closed. If it prints `still paused by: ...`, tell the user which source still holds
  (a low battery, the usage pace) - only that source ending lifts it. Send every peer: "resume your saved work".
- **`restart`**: reopen everything the pause closed. Run `node "COORD" resume`, then `node "COORD" tick` in the
  foreground (it relaunches up to three lanes, high priority first, under the coordinator's lock; the watcher or the
  next tick takes the rest), and show its lines. If it prints `tick: another tick holds tick.lock - skipped`, a tick is
  already relaunching them: wait a minute and run `node "COORD" tick` again. (By hand, after a reboot with no tick
  running, `node "LAUNCH" resume --paused --all` does the same in one go.) Then read `<coord>/paused.json` (or the newest
  `<coord>/paused-*.json` when it was already archived): for every row with `"closed": false` (a session you opened by
  hand), print `claude --resume <session_id> -n <name>` and the folder (`cwd`) to run it in. You never start those
  sessions yourself: the user does.
- **Anything else** is relayed verbatim to every peer.

## 3. Send and report
For each peer, `SendMessage` with the text. Then report to the user in one short list: who received it, who did not
(and the error), and the coordinator's own lines from step 2. Never send to yourself; never send a pause to a session
the user named as an exception.

## Notes
- Paused lanes end their turns on their own (their Agent dispatches are denied with the pause text, and their Stop
  records `{paused}` in the launcher registry); the coordinator closes them and relaunches them when the pause ends.
  Hand-opened sessions are never closed; they are listed for `claude --resume`.
- Check the state any time: `node "LAUNCH" status --group <id>` (`paused (<reason>, since HH:MM)` per lane) or
  `node "LAUNCH" sessions` (a `pace:` header line when the usage pace is known).
- Large-org variant: a fleet scheduler drains work on a quota or power event; this skill is for one machine.
````

- [ ] **Step 4: Run it to verify it passes**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/broadcast-skill.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/broadcast/SKILL.md claude/skills/handoff-launch/tests/broadcast-skill.test.mjs
git commit -m "feat(broadcast): /broadcast pause | resume | restart | <text> to every live peer session"
```

---

### Task 17: B2 docs

**Files:**
- Modify: `claude/skills/handoff-launch/coordinator.md`
- Modify: `claude/skills/handoff-launch/SKILL.md`
- Modify: `README.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Apply the doc blocks**

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
    `bg_task_max_min` 240, `dead_close_min` 60, `goal_missing_calls` 10, `goal_stale_min` 40, `goal_stale_changes` 5),
    and (batch B) `pace`, an object of the pacer's thresholds (`pace_target` 95, `pace_floor` 10, `week_grace_min` 720,
````

**with:**

````markdown
    `bg_task_max_min` 240, `dead_close_min` 60, `goal_missing_calls` 10, `goal_stale_min` 40, `goal_stale_changes` 5,
    `max_resumes_per_tick` 3, `min_pause_min` 15, `probe_wait_min` 10),
    and (batch B) `pace`, an object of the pacer's thresholds (`pace_target` 95, `pace_floor` 10, `week_grace_min` 720,
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
  - `pause.json`: `{"until":"<ISO time>"}`, or `"until": null` for no end. While it is active, every session is exempt
    from flags and every restart waits.
````

**with:**

````markdown
  - The pause sources (batch B, one file each, each with one writer): `pause/manual.json` (`{until, by, at}`, `until`
    null = no end; `coord.mjs pause` writes it, `coord.mjs resume` deletes it), `pause/battery.json` (`{at, pct, ac}`,
    the power refresh's), and the old `pause.json` (`{"until": ...}`, still read as a manual pause; `resume` deletes
    it). The pace source is not stored: it is derived from a fresh `pace.json`. While any source is active every
    session is exempt from loop flags and every restart waits. Also: `pause/seen/<session_id>.json` (a hand-opened
    session the hooks saw paused), `pause/tick-state.json` (the tick's skip counts, failures and probe), `paused.json`
    (the manifest; archived as `paused-<date>-<HHMM>.json`), `watch.lock`, `watch-start.json`, `watch-last.txt`.
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
  modes; this covers a window with an incident once its successor runs). In auto mode only: a window that recorded
  `{paused}`. Reason text: `superseded by generation <N>` (the newest running successor).
````

**with:**

````markdown
  modes; this covers a window with an incident once its successor runs). Reason text: `superseded by generation <N>`
  (the newest running successor). A lane that recorded `{paused}` is the pause close's (see "Pausing", both modes).
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
- A paused window with a pending ladder: the real tick cancels the ladder (paused is exempt) and closes the window in
  one tick. A dry run records no cancel, so it shows `skip close ...: its loop ladder is pending`.
- `{paused}` is never written by the code. A session that saved its state appends
  `{"paused":"<its --name or registry id>","at":"<ISO time>"}`; it covers launches started before `at`.
````

**with:**

````markdown
- A paused window with a pending ladder: the real tick cancels the ladder (paused is exempt) and closes the window in
  one tick. A dry run records no cancel, so it shows `skip close ...: its loop ladder is pending`.

## Pausing (batch B)
- **Sources and scope** (`pause-io.mjs pauseFor(priority)`, the one answer every hook uses): manual and battery pause
  every lane; pace `hold` pauses `normal` and `low` lanes; pace `exhausted` every lane. A hand-opened session counts as
  `high`.
- **A paused lane**: its Agent dispatches are denied with "Paused (<reason>): start no new agents or tasks. ...". Its
  Stop (`coord.mjs stop`) appends `{paused: <id>, name, group, at, reason, source, windows}` once per pause: again only
  when its newest line predates the source that pauses it now (written by hand as `{"paused":"<name or id>","at":...}`
  it is read too; it covers the launch started before `at`). goal-gate allows a paused session's stop with `paused:
  <reason>`. Running agents are never killed.
- **The pause close** (every tick, both recovery modes): an open lane with a `{paused}` line at least 1 min old, while
  its pause applies, or once it lifted when the lane did nothing since (`paused, and its pause lifted: closed to
  relaunch`). A window: the guarded close with `idle_close_min` waived (`closed <name> (gen N): paused (<reason>): idle
  <n> min`); a bg lane: `claude stop <bg_id>` (none recorded: never stopped). Busy or waiting on a permission: next
  tick. Any other skip is counted; at the second, one alert (`paused lane <name> not closed for 2 ticks - alert ...`).
- **Resuming**: the lanes a pause closed (a lane's newest entry with `{paused}`, closed or gone, no launch in flight: a
  newer `{starting}` line under 5 min old leaves it out) whose pause no longer applies are relaunched fresh from the
  handoff (its GOAL.md, first line `RESUMED after a pause (<reason>): ...`), by the tick under `tick.lock`, or by hand
  with `launch.mjs resume --paused`, which takes the same lock (while a tick runs: `not relaunched: a coordinator tick
  runs ... - retry in a minute`). High first, then the oldest pause; `max_resumes_per_tick`; a pace close not before
  `min_pause_min`, doubled for each consecutive pace re-pause of the lane within 6 h (4x at most). **Probe resume**: when
  a pace pause ended on a stale 5-hour reading (not a 5-hour reset), one window lane at a time until a fresh reading
  confirms (recorded only when that relaunch worked); none within `probe_wait_min`: the next lane. A cap refusal defers
  the rest to the next tick; a relaunch that fails twice is alerted once and left to the user. The pause close, the
  resume and the manifest run in unrestricted ticks only (a `--repo` tick leaves `pause/tick-state.json` alone).
- **The manifest** `paused.json` (`{paused_at, how_to_resume, sessions: [{key, name, repo, group, generation,
  session_id, cwd, branch, handoff, priority, reason, closed, resumed_at?}]}`, the tick its only writer): a row per
  closed lane (its newest generation) and per hand-opened session seen paused. When the pause ends: one phone alert with
  the hand-opened sessions' `claude --resume <id>` commands; archived once every closed row has `resumed_at`.
- **The watcher** (`coord.mjs watch`, hidden, detached, one instance under `watch.lock`): the tick starts it while a
  source is active over an open lane, or while a lane waits for its resume (`watcher started (...)`, at most once a
  minute). Every 60 s it drops its liveness memos, recomputes `pace.json` and runs a tick when a paused lane is open or a
  waiting lane can resume - leaving out lanes the tick gave up on (a close alerted, a relaunch failed twice) - and, after
  a tick that closed and relaunched nothing, at most every 5 min. It stops itself when nothing is paused or waiting, or
  after 8 days; `coord.mjs watch --stop` stops it. After a reboot
  it is gone: `launch.mjs status` shows `paused (<reason>, since HH:MM)`, `launch.mjs resume --paused --all` relaunches.
- Large-org variant: a fleet scheduler drains work on quota or power events; not needed per machine.
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
  down ...`). Until B2, `hold` and `exhausted` act as `slow`. Any error allows.
````

**with:**

````markdown
  down ...`). A pause source that covers the session denies with the pause text (see "Pausing": `hold` pauses normal and
  low lanes, `exhausted` every session, the user's own too). Any error allows.
````

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

````markdown
  session on the same checkout never closes it), in every group and lone session; and, in `auto` mode only, a window
  that recorded `{paused}`. A window whose claude exited is closed once quiet 10 min; a **dead start** (claude
````

**with:**

````markdown
  session on the same checkout never closes it), in every group and lone session; and a window that recorded
  `{paused}` (both modes, see Pausing). A window whose claude exited is closed once quiet 10 min; a **dead start** (claude
````

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

````markdown
- **Pausing:** a session that saved its state and wants to be left alone appends
  `{"paused":"<its --name>","at":"<ISO time>"}` to the registry (`sessions.jsonl`). `<config>/state/coord/pause.json`
  (`{"until":"<ISO time>"}`, `"until": null` for no end) pauses all flags and restarts.
````

**with:**

````markdown
- **Pausing** (one protocol; its sources: `/broadcast pause` or `coord.mjs pause [30m | until HH:MM]`, the usage pace at
  `hold` (normal and low lanes) or `exhausted` (every session), a low battery). When you get "Paused (<reason>): start
  no new agents or tasks ...": let running agents finish, save your state (ledger or handoff), mark open GOAL items
  `[!] paused — <reason>`, and end your turn. Your Stop records `{paused}`; the coordinator closes your window and
  relaunches you from your handoff when the pause ends (first line `RESUMED after a pause ...`: reopen those items).
  Hand-opened sessions are never closed; their `claude --resume` commands come as a phone alert. `coord.mjs resume` (or
  `/broadcast resume`) ends a manual pause; `launch.mjs resume --paused --all` relaunches by hand (after a reboot).
````

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

````markdown
  `DEAD-START (since ...)`, `inbox=<n>`, `goal=...`; lanes are listed high → normal → low priority; after any
````

**with:**

````markdown
  `DEAD-START (since ...)`, `inbox=<n>`, `goal=...`, `paused (<reason>, since HH:MM)`; a fresh `pace.json` adds a first
  line `pace: claude 5h 42% wk 31% slow · codex wk 12% ok` (also in `sessions`); lanes are listed high → normal → low priority; after any
````

**Replace** in `README.md`:

````markdown
| `skills/switching-effort/` + `skills/effort-{low,medium,high,xhigh,max}/` |
````

**with:**

````markdown
| `skills/broadcast/` | `/broadcast pause [30m \| until HH:MM] \| resume \| restart \| <text>`: one message to every live peer session (`ListAgents` + `SendMessage`), driving the one pause protocol: a manual pause source that every lane obeys (they save state and end their turn; the coordinator closes them and relaunches them when the pause ends). |
| `skills/switching-effort/` + `skills/effort-{low,medium,high,xhigh,max}/` |
````

- [ ] **Step 2: Check** - `grep -c "never written by the code" claude/skills/handoff-launch/coordinator.md` prints `0`;
  `grep -c "## Pausing (batch B)" claude/skills/handoff-launch/coordinator.md` prints `1`.

- [ ] **Step 3: Commit**

```bash
git add claude/skills/handoff-launch/coordinator.md claude/skills/handoff-launch/SKILL.md README.md
git commit -m "docs(pause): the one pause protocol, the manifest, the watcher, /broadcast"
```

---

### Task 18 (controller): B2 release checkpoint

- [ ] **Step 1: Whole-release review.** `worker-high` + **fable** on `git diff <B1 release>..batchB-pause-pacing` with
  this plan, the spec and the Review Focus list. Fixes, then a scoped re-review of those edits.
- [ ] **Step 2: Full suite** -> `ℹ tests 438`, `ℹ fail 0` (quote the lines).
- [ ] **Step 3: The dry-run gate, shown to the user (read-only, live registry).** With the B1 live state, from the
  integration worktree: run `HL_NO_SPAWN=1 HL_REGISTRY_DIR="$HOME/.claude/skills/handoff-launch" node
  claude/hooks/coord.mjs tick --dry-run` twice: as is, and with an injected source in a COPY of the coordinator state
  (`CLAUDE_CONFIG_DIR=<tmp>` whose `state/coord` is a copy of `~/.claude/state/coord` plus `pause/manual.json` =
  `{"until": null, "by": "dry-run", "at": "<now>"}`, and `HL_PROJECTS_DIR="$HOME/.claude/projects"` so transcripts are
  still read), so the user sees which lanes it would close
  (`would close ...: paused (manual pause)`), which `{paused}` lines exist, what it would relaunch after a resume
  (`would relaunch ...`) and `would start the watcher`. The `snap | diff` of Task 7 prints nothing. The user approves.
- [ ] **Step 4: Deploy, in order:** `pause-lib.mjs`, `recover-lib.mjs`, `pause-io.mjs`, then `recover.mjs`, `launch.mjs`
  -> the skill folder; `coord.mjs`, then `goal-gate.mjs` -> `~/.claude/hooks/`; `skills/broadcast/` ->
  `~/.claude/skills/broadcast/`; docs and tests. `diff -r` as in Task 7; the hooks identical.
- [ ] **Step 5: Verify live:** `echo {} | node ~/.claude/hooks/coord.mjs stop`, `... agent-gate` -> exit 0, no output;
  `echo {} | node ~/.claude/hooks/goal-gate.mjs` -> exit 0, no output; `node ~/.claude/skills/handoff-launch/launch.mjs
  resume --paused --all --dry-run` -> `no paused lanes to relaunch` (or the expected list); no `watch.lock` while nothing
  is paused. A real pause is NOT exercised on live lanes without the user.
- [ ] **Step 6: Secret scan** (pattern from the private handoff, over `HEAD` and `git log -p origin/main..HEAD`) ->
  nothing. **Step 7: Push** (fast-forward `main`).
- [ ] **Step 8: The restart table to `coordinator`:** `coord.mjs stop` runs from the live file, so running lanes write
  `{paused}` from the deploy on; the Agent gate's pause denial is in the global hook (live for sessions started after
  B1); `/broadcast` loads in new sessions only; the watcher starts on the first tick that needs it. Then stop and ask
  before B3.

---

## Release B3: the power-aware pause

### Task 19: `power.mjs`: the user-level probes and their parsers

**Files:**
- Create: `claude/skills/handoff-launch/power.mjs`
- Create: `claude/skills/handoff-launch/tests/power.test.mjs`

**Interfaces:**
- Consumes: nothing (Node built-ins only). New files only: this lane can run any time after B1's release.
- Produces: `NO_BATTERY`; `parseWinBattery(text)`, `parsePmset(text)`, `parseSysfs(supplies)`, `fakePower(v)` ->
  `{battery, pct, ac}` (`ac` null = unknown); `lowBattery(p, pct) -> bool` (a battery, `ac === false`, `pct <= pct`);
  `probePower(env) -> {battery, pct, ac}` (`HL_FAKE_POWER=<pct>,battery|<pct>,ac|none`; Windows `Get-CimInstance
  Win32_Battery`, hidden, 10 s; macOS `pmset -g batt`; Linux `/sys/class/power_supply/*`; a failed probe = no battery).

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/power.test.mjs`:

````js
// Batch B, Part 7: the power probes' parsers, HL_FAKE_POWER and the low-battery rule (power.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as W from "../power.mjs";

test("Windows: BatteryStatus 1/4/5 is off AC, every other value on AC (2, 3, the charging states 6-9); none = no battery; no status = unknown", () => {
  assert.deepEqual(W.parseWinBattery("NONE\r\n"), { battery: false, pct: null, ac: null });
  assert.deepEqual(W.parseWinBattery(""), { battery: false, pct: null, ac: null });
  for (const s of [1, 4, 5]) assert.deepEqual(W.parseWinBattery(`19|${s}`), { battery: true, pct: 19, ac: false }, String(s));
  for (const s of [2, 3, 6, 7, 8, 9, 11]) assert.equal(W.parseWinBattery(`19|${s}`).ac, true, String(s));
  assert.deepEqual(W.parseWinBattery("19|"), { battery: true, pct: 19, ac: null });
  assert.deepEqual(W.parseWinBattery("40|2\n20|1"), { battery: true, pct: 30, ac: false }); // two batteries: the mean; one discharging
});

test("macOS pmset and Linux sysfs", () => {
  assert.deepEqual(W.parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t18%; discharging; 0:40 remaining present: true\n"), { battery: true, pct: 18, ac: false });
  assert.deepEqual(W.parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t79%; charging; present: true\n"), { battery: true, pct: 79, ac: true });
  assert.deepEqual(W.parsePmset("Now drawing from 'AC Power'\n"), { battery: false, pct: null, ac: null }); // a desktop Mac
  assert.deepEqual(W.parseSysfs([{ type: "Battery\n", capacity: "17\n", status: "Discharging\n" }, { type: "Mains\n", online: "0\n" }]), { battery: true, pct: 17, ac: false });
  assert.deepEqual(W.parseSysfs([{ type: "Battery", capacity: "17", status: "Charging" }]), { battery: true, pct: 17, ac: true });
  assert.deepEqual(W.parseSysfs([{ type: "Mains", online: "1" }]), { battery: false, pct: null, ac: null });
});

test("HL_FAKE_POWER and the low-battery rule: at or under battery_pct and not on AC; charging at 19 % (status 6) is on AC", () => {
  assert.deepEqual(W.fakePower("19,battery"), { battery: true, pct: 19, ac: false });
  assert.deepEqual(W.fakePower("80,ac"), { battery: true, pct: 80, ac: true });
  assert.deepEqual(W.fakePower("none"), { battery: false, pct: null, ac: null });
  assert.equal(W.fakePower("x"), null);
  assert.equal(W.lowBattery(W.fakePower("19,battery"), 20), true);
  assert.equal(W.lowBattery(W.fakePower("20,battery"), 20), true);
  assert.equal(W.lowBattery(W.fakePower("21,battery"), 20), false);
  assert.equal(W.lowBattery(W.parseWinBattery("19|6"), 20), false);
  assert.equal(W.lowBattery(W.parseWinBattery("19|"), 20), false); // unknown AC: never
  assert.equal(W.lowBattery(W.fakePower("none"), 20), false);
  assert.deepEqual(W.probePower({ HL_FAKE_POWER: "12,battery" }), { battery: true, pct: 12, ac: false });
});

test("the real probe answers in its shape (read-only, hidden)", () => {
  const p = W.probePower({});
  assert.equal(typeof p.battery, "boolean");
  assert.ok(p.pct === null || (p.pct >= 0 && p.pct <= 100));
  assert.ok(p.ac === null || typeof p.ac === "boolean");
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/power.test.mjs`
Expected: FAIL - `Cannot find module '.../power.mjs'`.

- [ ] **Step 3: Implement**

**Create** `claude/skills/handoff-launch/power.mjs`:

````js
// Power probes (batch B, Part 7): user-level only, no admin. -> {battery, pct, ac}: battery false = no battery (a
// desktop): never pauses; ac null = unknown (a null/absent BatteryStatus): never pauses. The parsers are pure; probePower
// runs the platform's probe (spawnSync, hidden, 10 s). HL_FAKE_POWER=<pct>,battery | <pct>,ac | none injects a reading.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const NO_BATTERY = Object.freeze({ battery: false, pct: null, ac: null });
// Win32_Battery BatteryStatus: 1 (other: discharging), 4 (low), 5 (critical) = not on AC; any other value (2 unknown =
// on AC, 3 fully charged, 6-9 charging, 10, 11) = on AC.
const OFF_AC = new Set([1, 4, 5]);
// The Windows probe's output: NONE, or one <EstimatedChargeRemaining>|<BatteryStatus> line per battery. Several
// batteries: the mean charge; on AC unless one of them reports discharging; a battery without a status makes ac unknown.
export function parseWinBattery(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines[0] === "NONE") return { ...NO_BATTERY };
  const rows = lines.map((l) => l.split("|")).map(([p, s]) => ({ pct: p === "" ? NaN : Number(p), status: s === "" || s == null ? NaN : Number(s) }));
  const pcts = rows.map((r) => r.pct).filter(Number.isFinite);
  const ac = rows.some((r) => !Number.isFinite(r.status)) ? null : !rows.some((r) => OFF_AC.has(r.status));
  return { battery: true, pct: pcts.length ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null, ac };
}
// macOS `pmset -g batt`: "Now drawing from 'AC Power'" or "'Battery Power'", then " -InternalBattery-0 ... 79%; ...".
export function parsePmset(text) {
  const t = String(text ?? "");
  const m = /InternalBattery[^\n]*?(\d+)%/.exec(t);
  if (!m) return { ...NO_BATTERY };
  return { battery: true, pct: Number(m[1]), ac: /'AC Power'/.test(t) ? true : /'Battery Power'/.test(t) ? false : null };
}
// Linux /sys/class/power_supply/*: [{type, capacity, status, online}] (strings as read). On AC: a Mains supply online,
// or a battery not discharging.
export function parseSysfs(supplies) {
  const bats = (supplies || []).filter((s) => String(s.type).trim() === "Battery");
  if (!bats.length) return { ...NO_BATTERY };
  const mains = (supplies || []).filter((s) => String(s.type).trim() === "Mains");
  const pcts = bats.map((b) => Number(String(b.capacity ?? "").trim())).filter(Number.isFinite);
  const discharging = bats.some((b) => String(b.status ?? "").trim() === "Discharging");
  const ac = mains.some((s) => String(s.online ?? "").trim() === "1") ? true : discharging ? false : bats.every((b) => String(b.status ?? "").trim() !== "") ? true : null;
  return { battery: true, pct: pcts.length ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null, ac };
}
// HL_FAKE_POWER: "19,battery" (19 %, not on AC), "80,ac", "none" (a desktop). Anything else: null (no fake).
export function fakePower(v) {
  if (v === "none") return { ...NO_BATTERY };
  const m = /^(\d{1,3}),(battery|ac)$/.exec(String(v ?? ""));
  return m ? { battery: true, pct: Number(m[1]), ac: m[2] === "ac" } : null;
}
// Low battery: a battery, not on AC, at or under battery_pct. Unknown AC or charge: never.
export const lowBattery = (p, pct) => !!p?.battery && p.ac === false && Number.isFinite(p.pct) && p.pct <= pct;
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
// The platform probe. A failed probe reads as no battery: it never pauses (fail open).
export function probePower(env = process.env) {
  const fake = fakePower(env.HL_FAKE_POWER);
  if (fake) return fake;
  try {
    if (process.platform === "win32") {
      const ps = "$b=@(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue); if(-not $b.Count){'NONE'} else { $b | ForEach-Object { '{0}|{1}' -f $_.EstimatedChargeRemaining,$_.BatteryStatus } }";
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 10000, windowsHide: true });
      return r.status === 0 ? parseWinBattery(r.stdout) : { ...NO_BATTERY };
    }
    if (process.platform === "darwin") {
      const r = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 10000 });
      return r.status === 0 ? parsePmset(r.stdout) : { ...NO_BATTERY };
    }
    const dir = "/sys/class/power_supply";
    let names = []; try { names = fs.readdirSync(dir); } catch { return { ...NO_BATTERY }; }
    return parseSysfs(names.map((n) => ({ type: read(path.join(dir, n, "type")), capacity: read(path.join(dir, n, "capacity")), status: read(path.join(dir, n, "status")), online: read(path.join(dir, n, "online")) })));
  } catch { return { ...NO_BATTERY }; }
}
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/power.test.mjs`
Expected: PASS, `ℹ fail 0` (on this machine the real probe reads a battery on AC).

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/power.mjs claude/skills/handoff-launch/tests/power.test.mjs
git commit -m "feat(power): user-level battery probes and parsers (batch B, Part 7)"
```

---

### Task 20: the battery source wired in: the cache, its refresh by hooks, the tick and the watcher; B3 docs

**Files:**
- Create: `claude/skills/handoff-launch/tests/power-pause.test.mjs`
- Modify: `claude/skills/handoff-launch/tests/coord-hook.test.mjs`
- Modify: `claude/skills/handoff-launch/tests/helpers.mjs`
- Modify: `claude/skills/handoff-launch/recover-lib.mjs`
- Modify: `claude/skills/handoff-launch/pause-io.mjs`
- Modify: `claude/hooks/coord.mjs`
- Modify: `claude/skills/handoff-launch/recover.mjs`
- Modify: `claude/skills/handoff-launch/coordinator.md`

**Interfaces:**
- Consumes: Task 19; Task 9's `BATTERY`, `readSources` (the battery source is already read there, with its 10-min
  freshness); Task 14's `watchStep`.
- Produces: `pause-io.mjs` `POWER`, `POWER_CLAIM`, `powerStale(now)` (60 s; 1 h without a battery),
  `refreshPower(now) -> {power, low, changed}` (the one code path that writes `power.json` and `pause/battery.json`
  `{at, since, pct, ac}`, `since` kept while the battery stays low; its three callers - the hooks' detached trigger, the
  tick, the watcher - write whole files atomically, so they never mix: its comment says so),
  `triggerPowerRefresh(by, now) -> bool`, `powerText(p)`; `coord.mjs` `powerCmd(refresh)`, CLI `coord.mjs power
  [--refresh]`, `maybePowerRefresh(by)` at the start of the Agent gate and the end of post-tool; `recover.mjs`
  `powerTick({dryRun, now})` before `paceTick` (line `power: <text> - low battery: every lane pauses` / `- the battery
  pause ended`); the watcher refreshes every step. `recover-lib.mjs` `DEFAULTS.battery_pct` 20. The sandbox
  (`tests/helpers.mjs`) sets `HL_FAKE_POWER=none`; the isolation test allows post-tool's `power-claim.json`.

- [ ] **Step 1: Write the failing tests (and adapt the helpers and the isolation test)**

**Create** `claude/skills/handoff-launch/tests/power-pause.test.mjs`:

````js
// Batch B, Part 7 wired in: `coord.mjs power`, the battery pause source, the cache and its refresh by hooks and the tick.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sandbox, coordRun, sessionLine, setAgents, COORD_MJS } from "./helpers.mjs";
import { PAUSE_TEXT } from "../pace-lib.mjs";

const MIN = 60000;
const battery = (sb) => path.join(sb.coord, "pause", "battery.json");
const power = (sb) => path.join(sb.coord, "power.json");
const putPower = (sb, o, minAgo) => { fs.mkdirSync(sb.coord, { recursive: true }); fs.writeFileSync(power(sb), JSON.stringify({ at: new Date(Date.now() - minAgo * MIN).toISOString(), ...o })); };

test("coord.mjs power --refresh: low battery writes the battery source, AC or a desktop removes it; plain power writes nothing", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["power"], { env: { HL_FAKE_POWER: "19,battery" } });
    assert.equal(r.out, "power: battery 19% on battery\n");
    assert.equal(fs.existsSync(power(sb)), false);
    r = coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "19,battery" } });
    assert.equal(r.out, "power: battery 19% on battery - low: every lane pauses\n");
    assert.deepEqual([JSON.parse(fs.readFileSync(battery(sb), "utf8")).pct, JSON.parse(fs.readFileSync(power(sb), "utf8")).ac], [19, false]);
    const since = JSON.parse(fs.readFileSync(battery(sb), "utf8")).since;
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "18,battery" } });
    assert.equal(JSON.parse(fs.readFileSync(battery(sb), "utf8")).since, since); // still the same low-battery spell
    r = coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "19,ac" } }); // charging at 19 %: on AC
    assert.equal(r.out, "power: battery 19% on AC\n");
    assert.equal(fs.existsSync(battery(sb)), false);
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "5,battery" } });
    r = coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "none" } });
    assert.equal(r.out, "power: no battery (never pauses)\n");
    assert.equal(fs.existsSync(battery(sb)), false);
    fs.writeFileSync(path.join(sb.coord, "config.json"), JSON.stringify({ battery_pct: 30 }));
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "25,battery" } });
    assert.equal(fs.existsSync(battery(sb)), true); // battery_pct from config.json
  } finally { sb.cleanup(); }
});

test("the battery and manual sources never share a file: refreshes and pause commands at once leave both whole", async () => {
  const sb = sandbox();
  try {
    const run = (args, env = {}) => new Promise((done) => spawn(process.execPath, [COORD_MJS, ...args], { env: { ...sb.env, ...env }, windowsHide: true, stdio: "ignore" }).on("exit", done));
    await Promise.all([...[[], ["30m"], ["2h"], ["5m"]].map((a) => run(["pause", ...a])), ...[1, 2, 3, 4].map(() => run(["power", "--refresh"], { HL_FAKE_POWER: "12,battery" }))]);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "manual.json"), "utf8"))).sort(), ["at", "by", "until"]);
    assert.equal(JSON.parse(fs.readFileSync(battery(sb), "utf8")).pct, 12);
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause")).filter((f) => f.endsWith(".tmp")), []);
  } finally { sb.cleanup(); }
});

test("battery source: every lane and hand-opened session is paused while it is fresh; one not refreshed for 10 min is off", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "H", id: "H@1", effort: "xhigh", sid: "h-s1", supersedes: null });
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "15,battery" } });
    const gate = (env) => coordRun(sb, ["agent-gate"], { input: { session_id: "h-s1", tool_name: "Agent", tool_input: {} }, env });
    assert.equal(JSON.parse(gate({ HL_SESSION_ID: "H@1" }).out).hookSpecificOutput.permissionDecisionReason, PAUSE_TEXT("battery 15%"));
    fs.writeFileSync(battery(sb), JSON.stringify({ at: new Date(Date.now() - 11 * MIN).toISOString(), pct: 15, ac: false }));
    putPower(sb, { battery: true, pct: 15, ac: false }, 0); // a fresh cache: the gate triggers no refresh
    assert.equal(gate({ HL_SESSION_ID: "H@1" }).out, "");
  } finally { sb.cleanup(); }
});

test("the cache: hooks claim a detached refresh when power.json is stale (an hour without a battery), at most once a minute", () => {
  const sb = sandbox();
  try {
    const claim = path.join(sb.coord, "power-claim.json"), gate = () => coordRun(sb, ["agent-gate"], { input: { session_id: "s1", tool_name: "Agent", tool_input: {} } });
    putPower(sb, { battery: true, pct: 80, ac: true }, 0.5);
    gate(); assert.equal(fs.existsSync(claim), false); // fresh
    putPower(sb, { battery: true, pct: 80, ac: true }, 2);
    gate(); assert.equal(JSON.parse(fs.readFileSync(claim, "utf8")).by, "agent-gate"); // HL_NO_SPAWN: claimed, not started
    const at = fs.readFileSync(claim, "utf8");
    gate(); assert.equal(fs.readFileSync(claim, "utf8"), at); // claimed under a minute ago
    fs.rmSync(claim);
    putPower(sb, { battery: false, pct: null, ac: null }, 30);
    gate(); assert.equal(fs.existsSync(claim), false); // a desktop: an hour
  } finally { sb.cleanup(); }
});

test("the tick refreshes a stale cache: low battery pauses (one line, the watcher starts over an open lane), AC back ends it", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "R", id: "R@1", sid: "r-s1", mode: "bg", bg_id: "bg-R", supersedes: null });
    setAgents(sb, [{ id: "bg-R", sessionId: "r-s1", name: "R", status: "running" }]);
    let r = coordRun(sb, ["tick"], { env: { HL_FAKE_POWER: "15,battery" } });
    assert.match(r.out, /^power: battery 15% on battery - low battery: every lane pauses$/m);
    assert.match(r.out, /^watcher started \(a pause is active\)$/m);
    r = coordRun(sb, ["tick"], { env: { HL_FAKE_POWER: "90,ac" } });
    assert.doesNotMatch(r.out, /^power:/m); // the cache is fresh: no probe
    putPower(sb, { battery: true, pct: 15, ac: false }, 2);
    r = coordRun(sb, ["tick"], { env: { HL_FAKE_POWER: "90,ac" } });
    assert.match(r.out, /^power: battery 90% on AC - the battery pause ended$/m);
    assert.equal(fs.existsSync(battery(sb)), false);
  } finally { sb.cleanup(); }
});
````

**Replace** in `claude/skills/handoff-launch/tests/coord-hook.test.mjs`:

````js
    const mine = [`state/coord/sessions/${SID}.json`, "state/coord/tick.json"];
````

**with:**

````js
    // batch B, Part 7: the power refresh's claim is machine-wide, like tick.json (HL_NO_SPAWN: claimed, nothing started)
    const mine = [`state/coord/sessions/${SID}.json`, "state/coord/tick.json", "state/coord/power-claim.json"];
````

**Replace** in `claude/skills/handoff-launch/tests/helpers.mjs`:

````js
    HL_FREE_GB: "64", HL_CLAUDE_JSON: path.join(tmp, "claude.json"),
  };
````

**with:**

````js
    HL_FREE_GB: "64", HL_CLAUDE_JSON: path.join(tmp, "claude.json"),
    // batch B, Part 7: no battery (the tick's power refresh never probes the machine; power tests set their own)
    HL_FAKE_POWER: "none",
  };
````

**Replace** in `claude/skills/handoff-launch/tests/helpers.mjs`:

````js
  for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG", "HL_PROFILES_JSON",
````

**with:**

````js
  for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_FAKE_POWER", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG", "HL_PROFILES_JSON",
````

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/power-pause.test.mjs claude/skills/handoff-launch/tests/pause-hooks.test.mjs claude/skills/handoff-launch/tests/coord-hook.test.mjs`
Expected: FAIL - `coord.mjs power` prints nothing; no battery source.

- [ ] **Step 3: Implement (and the docs)**

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

````js
  max_resumes_per_tick: 3, min_pause_min: 15, probe_wait_min: 10,
````

**with:**

````js
  max_resumes_per_tick: 3, min_pause_min: 15, probe_wait_min: 10,
  // batch B, Part 7: the battery source pauses every lane at or under this charge, off AC
  battery_pct: 20,
````

**Replace** in `claude/skills/handoff-launch/pause-io.mjs`:

````js
import { activeSources, pauseFor as pauseForSources } from "./pause-lib.mjs";
````

**with:**

````js
import { activeSources, pauseFor as pauseForSources } from "./pause-lib.mjs";
import { probePower, lowBattery } from "./power.mjs";
````

**Replace** in `claude/skills/handoff-launch/pause-io.mjs`:

````js
const paceCfg = () => { let t = null; try { t = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} return loadConfig(t).config.pace; };
````

**with:**

````js
const coordCfg = () => { let t = null; try { t = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} return loadConfig(t).config; };
const paceCfg = () => coordCfg().pace;
````

**Replace** in `claude/skills/handoff-launch/pause-io.mjs`:

````js
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
````

**with:**

````js
// ---------- Part 7 (B3): the power refresh, the battery source's one writer ----------
export const POWER = path.join(COORD, "power.json");
export const POWER_CLAIM = path.join(COORD, "power-claim.json");
// power.json is stale after 60 s - an hour on a machine without a battery (a battery never appears mid-session).
export function powerStale(now = Date.now()) {
  const j = readJson(POWER, null), at = Date.parse(j?.at);
  return !(now - at < (j?.battery === false ? 3600e3 : 60000) && at <= now);
}
// The probe (power.mjs), cached in power.json {at, battery, pct, ac}; a low battery (battery_pct, not on AC) writes the
// battery source {at, since, pct, ac} (since: when the battery first read low, kept across refreshes), anything else
// removes it. Three callers run it - `coord.mjs power --refresh` (the hooks' detached trigger), the tick and the
// watcher - but it is one code path and its writes are idempotent: each is a whole-file atomic rename of what the probe
// read just then, so two refreshes at once leave one valid file (the later reading), never a mix; the battery source
// keeps one logical writer. -> {power, low, changed}: changed - the battery source appeared or went
export function refreshPower(now = Date.now()) {
  const p = probePower(), low = lowBattery(p, coordCfg().battery_pct), prev = readJson(BATTERY, null), had = !!prev, at = new Date(now).toISOString();
  writeAtomic(POWER, JSON.stringify({ at, ...p }));
  if (low) writeAtomic(BATTERY, JSON.stringify({ at, since: prev?.since ?? prev?.at ?? at, pct: p.pct, ac: p.ac }));
  else fs.rmSync(BATTERY, { force: true });
  return { power: p, low, changed: had !== low };
}
// The hooks only read the cache: when it is stale, claim the refresh in power-claim.json (once a minute at most) and
// start `coord.mjs power --refresh` hidden and detached (the triggerTick pattern; HL_NO_SPAWN: the claim only). Never
// throws. -> true when a refresh was claimed
export function triggerPowerRefresh(by, now = Date.now()) {
  try {
    if (!powerStale(now)) return false;
    const last = Date.parse(readJson(POWER_CLAIM, {})?.at);
    if (last <= now && now - last < 60000) return false;
    writeAtomic(POWER_CLAIM, JSON.stringify({ at: new Date(now).toISOString(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return true;
    spawn(process.execPath, [COORD_MJS, "power", "--refresh"], { detached: true, stdio: "ignore", windowsHide: true, env: launcherEnv() }).on("error", () => {}).unref();
    return true;
  } catch { return false; }
}
export const powerText = (p) => (!p.battery ? "no battery (never pauses)" : `battery ${p.pct ?? "?"}% ${p.ac === true ? "on AC" : p.ac === false ? "on battery" : "AC unknown"}`);
// The hand-opened sessions seen while paused. -> [{session_id, cwd, reason, at, file}]
````

**Replace** in `claude/hooks/coord.mjs`:

````js
//   watch [--once] [--started <ms>] | watch --stop   the hidden single-instance watcher (Part 4): a step every 60 s while
````

**with:**

````js
//   power [--refresh]   the power probe (batch B, Part 7); --refresh writes power.json and the battery pause source
//   watch [--once] [--started <ms>] | watch --stop   the hidden single-instance watcher (Part 4): a step every 60 s while
````

**Replace** in `claude/hooks/coord.mjs`:

````js
// ---------- Part 4: the watcher (who wakes an idle machine) ----------
````

**with:**

````js
// ---------- Part 7 (B3): power ----------
// The hooks' cheap check: power.json read here (no import) and, when stale (60 s; an hour without a battery), the
// detached refresh triggered through pause-io (once a minute at most). Never throws.
async function maybePowerRefresh(by) {
  try {
    const j = readJson(path.join(COORD, "power.json"), null), age = Date.now() - Date.parse(j?.at);
    if (age >= 0 && age < (j?.battery === false ? 3600e3 : 60000)) return;
    (await mod("pause-io.mjs")).triggerPowerRefresh(by);
  } catch {}
}
// `coord.mjs power [--refresh]`: the probe now; --refresh also writes power.json and the battery source (pause-io
// refreshPower, their one writer). -> its line
export async function powerCmd(refresh) {
  const [PI, W] = await Promise.all([mod("pause-io.mjs"), mod("power.mjs")]);
  if (!refresh) return `power: ${PI.powerText(W.probePower())}`;
  const r = PI.refreshPower();
  return `power: ${PI.powerText(r.power)}${r.low ? " - low: every lane pauses" : ""}`;
}

// ---------- Part 4: the watcher (who wakes an idle machine) ----------
````

**Replace** in `claude/hooks/coord.mjs`:

````js
  IO.recomputePace({ now, cfg: cfg.pace });
  const sources = PI.readSources(now), reg = V.readRegistry(), ts = readJson(PI.TICK_STATE, {});
````

**with:**

````js
  IO.recomputePace({ now, cfg: cfg.pace });
  try { PI.refreshPower(now); } catch {} // B3: every step (60 s) - the battery source goes as soon as AC is back
  const sources = PI.readSources(now), reg = V.readRegistry(), ts = readJson(PI.TICK_STATE, {});
````

**Replace** in `claude/hooks/coord.mjs`:

````js
  if (!/^(Agent|Task)$/.test(String(input?.tool_name ?? ""))) return null; // the matcher's rule again: never TaskUpdate, TaskCreate, ...
  const P = await mod("pace-lib.mjs"), now = Date.now(), cfg = paceCfg(P);
````

**with:**

````js
  if (!/^(Agent|Task)$/.test(String(input?.tool_name ?? ""))) return null; // the matcher's rule again: never TaskUpdate, TaskCreate, ...
  await maybePowerRefresh("agent-gate"); // B3: the battery source stays current while sessions work
  const P = await mod("pace-lib.mjs"), now = Date.now(), cfg = paceCfg(P);
````

**Replace** in `claude/hooks/coord.mjs`:

````js
  V.writeAtomic(stateFile, JSON.stringify(state));
  V.triggerTick("post-tool", cfg.tick_min);
  return said;
````

**with:**

````js
  V.writeAtomic(stateFile, JSON.stringify(state));
  V.triggerTick("post-tool", cfg.tick_min);
  await maybePowerRefresh("post-tool");
  return said;
````

**Replace** in `claude/hooks/coord.mjs`:

````js
  } else if (sub === "watch") {
````

**with:**

````js
  } else if (sub === "power") await write(`${await powerCmd(argv.includes("--refresh"))}\n`);
  else if (sub === "watch") {
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
// ---------- batch B, Part 4: the watcher wakes an idle machine ----------
````

**with:**

````js
// ---------- batch B, Part 7: the power refresh at a tick ----------
// When power.json is stale (pause-io powerStale), the probe runs here (the tick is detached already). One line when the
// battery source appears or goes. A dry run never probes. -> lines
function powerTick({ dryRun, now }) {
  if (dryRun || !PI.powerStale(now)) return [];
  try {
    const r = PI.refreshPower(now);
    return r.changed ? [`power: ${PI.powerText(r.power)} - ${r.low ? "low battery: every lane pauses" : "the battery pause ended"}`] : [];
  } catch (err) { return [`error: power not refreshed (${err?.message || err})`]; }
}

// ---------- batch B, Part 4: the watcher wakes an idle machine ----------
````

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

````js
    // batch B: pace.json first (machine-wide: an unrestricted tick only), so this tick's pause and resume decisions read it
    if (!repoKey) out.push(...paceTick({ dryRun, cfg, now }));
````

**with:**

````js
    // batch B: pace.json first (machine-wide: an unrestricted tick only), so this tick's pause and resume decisions read it
    if (!repoKey) out.push(...powerTick({ dryRun, now }), ...paceTick({ dryRun, cfg, now }));
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
    `max_resumes_per_tick` 3, `min_pause_min` 15, `probe_wait_min` 10),
````

**with:**

````markdown
    `max_resumes_per_tick` 3, `min_pause_min` 15, `probe_wait_min` 10, `battery_pct` 20),
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
- Large-org variant: a fleet scheduler drains work on quota or power events; not needed per machine.
````

**with:**

````markdown
- **Power** (B3): `coord.mjs power [--refresh]` probes user-level only (Windows `Win32_Battery`: `BatteryStatus` 1, 4, 5
  = off AC, every other value on AC; macOS `pmset -g batt`; Linux `/sys/class/power_supply`). No battery, or an
  unknown status, never pauses. `--refresh` writes `power.json` (`{at, battery, pct, ac}`) and, at or under
  `battery_pct` off AC, `pause/battery.json` (`{at, since, pct, ac}`, `since` kept while it stays low; else removes it):
  the battery source pauses every lane while that file is under 10 min old. The refresh is its one code path; its
  callers (the hooks' detached trigger, the tick, the watcher) write whole files atomically, so they never mix. Hooks (post-tool, the Agent gate) only read `power.json` and, when it is stale (60 s; an hour
  without a battery), claim `power-claim.json` and start the refresh hidden and detached; the tick refreshes a stale
  cache itself (`power: battery 15% on battery - low battery: every lane pauses` / `- the battery pause ended`), the
  watcher every 60 s.
- Large-org variant: a fleet scheduler drains work on quota or power events; not needed per machine.
````

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

````markdown
`HL_FAKE_GIT_TIMEOUT`, `HL_LAUNCH_MJS`, `HL_SKILL_DIR`. Their meanings are in the header comments of `launch.mjs`,
````

**with:**

````markdown
`HL_FAKE_GIT_TIMEOUT`, `HL_LAUNCH_MJS`, `HL_SKILL_DIR`, `HL_FAKE_POWER=<pct>,battery|<pct>,ac|none` (batch B: the power
probe's reading; the sandbox sets `none`). Their meanings are in the header comments of `launch.mjs`,
````

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 900 node --test claude/skills/handoff-launch/tests/power-pause.test.mjs claude/skills/handoff-launch/tests/pause-hooks.test.mjs claude/skills/handoff-launch/tests/coord-hook.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add claude/skills/handoff-launch/pause-io.mjs claude/skills/handoff-launch/recover-lib.mjs claude/skills/handoff-launch/recover.mjs claude/hooks/coord.mjs claude/skills/handoff-launch/coordinator.md claude/skills/handoff-launch/tests/helpers.mjs claude/skills/handoff-launch/tests/coord-hook.test.mjs claude/skills/handoff-launch/tests/power-pause.test.mjs
git commit -m "feat(power): a low battery pauses every lane; AC back resumes them (batch B, Part 7)"
```

---

### Task 21 (controller): B3 release checkpoint

- [ ] **Step 1: Review.** `worker-high` + **fable** on `git diff <B2 release>..batchB-pause-pacing`; fixes, scoped re-review.
- [ ] **Step 2: Full suite** -> `ℹ tests 447`, `ℹ fail 0`.
- [ ] **Step 3: Dry-run gate, shown to the user:** `node claude/hooks/coord.mjs power` (the real reading, nothing
  written), then the Task 18 Step 3 dry run with `HL_FAKE_POWER=15,battery` in the copied state after
  `coord.mjs power --refresh` there: the lanes it would close for `battery 15%`; then `HL_FAKE_POWER=90,ac`: the
  battery pause ended.
- [ ] **Step 4: Deploy:** `power.mjs` first, then `recover-lib.mjs`, `pause-io.mjs`, `recover.mjs`; `coord.mjs`; docs and
  tests. `diff -r` as before.
- [ ] **Step 5: Verify live:** `node ~/.claude/hooks/coord.mjs power` -> `power: battery <n>% on AC` on this machine;
  after the next tick, `~/.claude/state/coord/power.json` exists and no `pause/battery.json` while on AC.
- [ ] **Step 6: Secret scan** (pattern from the private handoff) -> nothing. **Step 7: Push.**
- [ ] **Step 8: Restart table to `coordinator`:** everything in B3 is in `coord.mjs` and the tick (live at once); the
  hooks start refreshing the power cache at their next call. Report the batch done to the user.

---

## Self-review (against the spec)

**Spec coverage.**

| Spec | Task(s) |
|---|---|
| Contract with codex-dual (readings, `pace.json`, 15-min staleness, `updated` reserved, additive fields) | 1 (`paceState`, `providersOf`, `paceFresh`), 2 (`pace-io`), 3 (the tick keeps it fresh) |
| Part 1: the recorder (stdin fields, null windows, skip-unchanged under 60 s, recompute when > 30 s, the line in the user's layout with its dropped segments and width cap, no `refreshInterval`, chained status line, fail safe) | 1 (`readingFromStatus`, `sameReading`, `statusText`), 2 (`statusline`, settings, install) |
| Part 2: the pacer (selection, freshness 10 min / 6 h, enter needs fresh, leave on stale, reset ends a state, the two pace lines, `pace_floor`, `week_grace_min`, bands, per-window hysteresis, severity merge, `since`, weekly-only provider) | 1; `coord.mjs pace` in 2; the tick in 3 |
| Part 3: `slow` enforcement (global Agent hook, priority, deny/notice texts, once per `since`, B1 hold/exhausted as slow, errors allow, `pace-seen` prune) | 1 (`gateDecision`), 2 (`agentGate`), 3 (prune) |
| Part 4: sources (one file each, `pauseActive`, legacy `pause.json`, scope by priority, `pauseFor`) | 8, 9 |
| Part 4: what a paused lane does (deny text, Stop `{paused}` once per launch, goal gate's allow + system message, agents never killed) | 10 |
| Part 4: closing (both modes, `idle_close_min` waived, 1-min `{paused}`, bg by `bg_id`, no `bg_id`, busy next tick, two-tick alert) | 11 |
| Part 4: the manifest (rows, newest generation, hand-opened rows, archive rule) | 13 (rulings 12, 13) |
| Part 4: resuming (still-open lane, `launch.mjs resume --paused`, priority order, cap, `max_resumes_per_tick`, `min_pause_min`, probe resume, reset rules, hand-opened alert) | 12, 13 (rulings 14-16, 18) |
| Part 4: the watcher (single instance, start rule, 60 s, self-stop, 8 days, `--stop`, after a reboot) | 14 |
| Part 4: status (`paused (...)`, the pace header) | 15 |
| Part 5: `hold`/`exhausted` through the pause source | 8 (`activeSources`), 10 (the gate), 11, 13 |
| Part 6: `/broadcast` (peers, verbs, timed pause without reminders) | 16 |
| Part 7: power (probes, `BatteryStatus` rule, no battery, cache 60 s, detached refresh, `HL_FAKE_POWER`, threshold) | 19, 20 |
| Part 8: context discipline (context from the tail or the status line field, `ctx` part, nudges, `agent_id` skip, markers, thresholds, errors, SKILL.md line) | 1, 2, 6 |
| Carried fixes (liveness before newest; `tick.lock`; `pane/` prune) | 4, 5, 3 |
| Testing list (every bullet) | the test files of 1-5, 8-16, 19-20; the live verifies in 7, 18, 21 |
| Deploy notes (dry-run gate, ordered copy, `diff -r`, secret scan, push, restart table; settings backup; headless hooks; status line in an interactive session) | 7, 18, 21 (and Task 0) |

**Placeholders.** None: every code step is a `Create` or `Replace` block that was applied and tested; the only
`<...>` in steps are run-time values (a temp dir, the private scan pattern, a timestamp).

**Type consistency.** The names in each task's Interfaces block are the ones the blocks define and the later blocks
call (checked by applying the blocks in order and running every focused command and the full suite per release).

**Review Focus.** Each of the five has its test in the owning task (1: Task 1; 2: Task 2; 3: Tasks 1-2; 4: Task 12; 5:
Task 10).
