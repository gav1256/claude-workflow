# Parallel-session coordination: design

Status: draft for review (2026-10-02). **Approval covers stage 1 only.** Stages 2–7 are outlines, and each gets its
own detailed spec before planning. It extends `handoff-launch` (lanes, groups, done markers, watchdog) so parallel
sessions stay clean, finished work merges early and cheaply, and loops are recovered with their cause fixed.

## Goals and constraints (from the user)
- Finish high-priority work first and split work sensibly, at **negligible extra token cost**: decisions come from
  deterministic code, never a model call.
- **No cross-contamination between parallel lanes.** A message meant for another lane is redirected or queued, never
  half-applied. A lane never writes into another lane's worktree.
- **Merge finished lanes while others still run**, without affecting running lanes.
- **Looping or broken sessions and agents may be killed.** They are restarted correctly, and the loop's cause is fixed.
- Busy-but-progressing work is never killed.

## Components
- `~/.claude/skills/handoff-launch/launch.mjs`: the CLI (launch, status, stop, watchdog, and new: merge, overlap,
  queue, resume, pause). Run by sessions and by the user.
- `~/.claude/hooks/coord.mjs`: invoked only by hooks and by the detached tick/watcher. It reads small state files,
  answers in milliseconds, and spawns anything slow detached.
- State: `~/.claude/state/coord/` (power cache, pause file, looping list, usage samples) and
  `<main repo>/.superpowers/sessions/<group>/` (done markers, inbox, incidents, merge.lock).
- New global hooks: **only** PreToolUse on `Agent` (fires rarely). The existing Stop hook (`goal-gate.mjs`) also starts
  `coord.mjs tick` detached when the last tick is >5 min old. Lane-only hooks are passed by `launch.mjs --settings`.

## Verified platform facts (headless probes, Claude Code 2.1.287, 2026-10-02)
- A `SubagentStart` hook exists, with input `agent_id` and `agent_type`. `SubagentStop` adds `agent_transcript_path`
  (`<project>/<session>/subagents/agent-<id>.jsonl`).
- Hook events fired inside a subagent carry the **parent's** `session_id`, plus their own `agent_id`/`agent_type`.
- `PostToolUse` → `hookSpecificOutput.additionalContext` reaches the parent model; it quoted a test code back.
- `UserPromptSubmit` → `additionalContext` **and** plain stdout both reach the model; both test codes were quoted back.
- `autoContinueAtUsageLimit` is a real settings key in this build.
- Power probe on Windows: `Get-CimInstance Win32_Battery` → `{"EstimatedChargeRemaining":79,"BatteryStatus":2}`.
- Effort skills (`effort:` frontmatter) switch effort until the turn ends, in sessions and in subagents
  (PreToolUse `effort.level` log).
- `settings.json` `effortLevel` is read only at session start. The model cannot run `/effort`.

## Concurrency cap
**No self-imposed cap.** This was researched 2026-10-02 against the Claude Code docs (sub-agents.md, env-vars.md, agent-view.md, errors.md, costs.md) and the Max plan articles.
- The only hard limit is **20 concurrently running subagents per session**. Spawning beyond it fails with
  `Concurrent subagent limit reached` (the error says not to retry). `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` adjusts
  it but cannot disable it. Within a session at most 10 subagents/read-only tools execute in parallel
  (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`).
- There is no documented limit on concurrent sessions per account.
- The real constraint is the Max **5-hour and weekly usage**. Subagents draw on it like the main conversation, and
  parallelism spends it proportionally faster. A cap would delay work, not save tokens.
- So no allocator is built. `sizing-dispatches` keeps a session under 20 running agents (resumes skip the check).
  `autoContinueAtUsageLimit: true` lets interactive sessions wait out a usage reset and continue on their own.

## Build order
Each stage gets its own plan → build → review → push and is useful on its own.

### Stage 1: rolling deterministic merges + overlap check (no new hooks)
- `launch.mjs merge --group <id> --lane <name> [--test "<cmd>"]`. It is run by a lane right after it writes its done
  marker, and by `status` for any finished, unmerged lane.
  1. Take `merge.lock` for the integration branch (exclusive create). A held lock means another merge is running:
     exit 0 with "queued". The lock holder re-runs `status` when it finishes and picks up the next finished lane, so
     merges are serialized and nothing waits on a person.
  2. In a scratch worktree of the integration branch (`.claude/worktrees/_merge-<group>`, never a lane's), run
     `git merge --no-ff <lane branch>`.
  3. **No conflicts, and the test command (if given) passes:** commit, append `{merged: lane, sha}` to the registry,
     release the lock. Zero tokens.
  4. **Conflict or test failure:** `git merge --abort`. Launch a merge *session* for that lane only
     (`<group>-merge-<lane>`, opus/high), with `--worktree <integration branch>` so it **reuses** the same
     `_merge-<group>` worktree (the launcher reuses a worktree by branch). Its pointer prompt lists the conflicting files and the test output. The lock
     stays held until that session writes its result.
- **Overlap check** (`launch.mjs overlap --group <id>`): for each pair of (finished lane, running lane), list the files
  both changed (`git diff --name-only <base>...<branch>`). The list is written into the done marker and shown by
  `status`, so the later merge knows what to expect. Running lanes are never touched.
- The final merge to the target branch stays a human-approved step. It happens once every lane is merged or blocked.
  It never pushes without asking.
- **Large-org variant:** merge queue / CI-gated PRs per lane instead of local merges.

### Stage 2: loop recovery
- **Detection:** the existing watchdog rules (same tool call ×4 in the last 20 entries; a tool call outstanding with no
  activity ≥30 min; ≥5 goal-gate nudges in 60 entries), now also applied to **subagent transcripts**. The watchdog
  runs as `coord.mjs tick`: at most once every 5 min, started detached by the existing Stop hook, and at every
  launch.
- **Looping subagent:** recorded in `~/.claude/state/coord/looping.json`.
  - **Parent idle** (its turn ended while it waits on the agent, which never completes): the parent is a **stuck
    session**, and the session ladder below applies (stop request → incident → kill tree → relaunch).
  - **Parent still active (fast path):** a lane-only PostToolUse hook injects one line through `additionalContext`: "Agent <type> <id> is looping (<reason>). TaskStop it,
  diagnose the cause from <agent transcript>, fix the brief or code, re-dispatch per sizing-dispatches." Delivered
  once per agent.
- **Looping session:** stop request, then a kill after a 5-min grace period (existing ladder). Before the kill an
  incident file `.superpowers/sessions/<group>/incidents/<lane>-<n>.md` records the loop signature, the last 20 tool
  calls, the transcript path, the lane, the branch and the handoff. Then the lane is relaunched (same name, group and
  worktree). The pointer prompt's first instruction: read the incident, find and fix the cause (systematic-debugging),
  record the cause in the lane ledger, then continue the handoff.
- **Window close:** a relaunch may close the old window even if it is generation N-1, when it recorded `{paused}` or an
  incident and is idle. This is an exemption to the "never close N-1" rule.
- **Sizing on restart:** same tier when the incident shows a cause to fix. One rung up only when no cause is
  identifiable.
- **Restart cap:** 2 automatic restarts per lane per stage. On a third loop the lane is marked `blocked`: `status`
  shows it and rolling merges skip it, and the user gets a push notification with the incident path.
- Never killed: work that is busy but progressing, i.e. new, non-repeating tool calls in its transcript.

### Stage 3: lane hygiene (lane sessions only)
- `launch.mjs` passes these hooks to **lane sessions only** (`claude --settings <lane-hooks.json>`), so non-lane
  sessions pay nothing.
- **Write fence:** a PreToolUse hook on `Edit|Write|NotebookEdit`. It allows writes inside the lane's worktree, the
  session scratchpad, `~/.claude`, and `<main root>/.superpowers/**` (done markers, inbox, incidents; a lane must be
  able to finish). It denies writes into another lane's worktree or the main checkout, with the
  reason "this path belongs to lane X / the main checkout. Queue it: `launch.mjs queue --to X --text ...`". Bash
  writes cannot be fenced reliably; the lane rules forbid them outside the worktree (known gap).
- **Lane note:** a UserPromptSubmit hook (`additionalContext`, verified). It injects a short note only on the first prompt and whenever the hash of the
  live-lane set changes: "You are lane X (branch, scope). Live lanes: Y (scope), Z (scope)." The lane rules in
  `handoff-launch` then say:
  - A message for another lane → reply "this is for lane **Y** (window *Y*)" and offer to queue it in Y's inbox.
  - New work that would touch files a running lane owns → `launch.mjs queue --after-merge` instead of doing it now.
  - Otherwise do it.
- **Inbox:** `.superpowers/sessions/<group>/inbox/<lane>.md`. Read at the lane's next stage launch and by its merge
  session, never delivered mid-task. Items queued `--after-merge` go into the group's `next_after_merge` list.

### Stage 4: priority ordering (no cap, so priority only orders work)
- Each lane's registry entry gets `priority` (high | normal | low). It is derived from its sizing at launch
  (`xhigh`/fable → high, `high` → normal, `medium`/`low` → low), and `launch.mjs --priority` overrides it.
- It is used deterministically for three things:
  - the order `status` lists lanes in;
  - the order the rolling-merge queue takes finished lanes;
  - the order paused lanes are resumed in (stage 5).
- Zero tokens.

### Stage 5: power-aware pause and resume (laptops; every OS, nothing installed)
- **Power probe** (`coord.mjs power`): user-level commands only, no admin, services or scheduled tasks.
  - Windows: `Get-CimInstance Win32_Battery` (charge %, BatteryStatus 2 = on AC).
  - macOS: `pmset -g batt`.
  - Linux: `/sys/class/power_supply/*/{capacity,status,online}`.
  - No battery found (a desktop) → never pauses.
  - The result is cached in `~/.claude/state/coord/power.json` for 60 s. A stale cache is refreshed by a detached
    process, so hooks only read a file and add no latency.
- **Low battery = ≤20 % and not on AC** (threshold configurable). Then:
  - A global PreToolUse hook on `Agent` denies new dispatches: "Low battery (19 %, unplugged): do not start new agents
    or tasks. Let running agents finish, save state (ledger/handoff), mark GOAL items `[!] paused — low battery`,
    then end your turn. Work resumes automatically when plugged in."
  - Sessions learn of it through the Agent denial, and through the Stop hook's `systemMessage` ("paused: low
    battery") when they end a turn. No new global PostToolUse hook; a session that isn't dispatching stops soon anyway.
  - The goal gate allows the stop while the battery is low, instead of forcing continuations.
  - Lane sessions record `{paused: lane, at, battery}` in the registry when they end their turn.
  - Running agents are never killed for battery; they finish (busy ≠ broken). If the battery is critical, the OS's own
    sleep takes over.
- **Resume on AC:** when the first pause happens, `coord.mjs` starts one detached user-level watcher. It polls the
  power probe every 60 s and exits once there is nothing left to resume.
  - When the machine is on AC again, it relaunches each paused **lane** from its saved handoff via `launch.mjs`
    (same name, group and worktree; priority order; the pointer says "resume after low-battery pause"). The idle,
    saved old window is then closed.
  - The relaunch closes the idle, saved old window (the `paused` exemption, stage 2).
  - After a shutdown or reboot the watcher is gone: `launch.mjs status` lists paused lanes, and
    `launch.mjs resume --group <id>` relaunches them by hand.
  - Non-lane interactive sessions cannot be messaged by a program. The watcher sends the user a notification instead
    ("plugged in: N lanes resumed; resume these sessions: …").
- **Large-org variant:** a fleet scheduler that drains work on power or maintenance events. Not needed per machine.

### Stage 6: master broadcast command
- `/broadcast <message>` is a skill run from any Claude session (the "master"). It sends one message to **every live
  session** at once.
  - It runs `ListAgents`, then `SendMessage` to each interactive or background peer (not itself, not offline
    Remote Control rows).
  - It reports who received the message and who couldn't.
  - It's a few tool calls; the receivers spend tokens only on reading the message.
  - Why a skill: a plain CLI program cannot type into an interactive session (the `claude` CLI can't message one),
    but a Claude session can, with `SendMessage`.
- **Built-in verbs** (anything else is relayed verbatim):
  - `pause`: writes `~/.claude/state/coord/pause.json` `{until: null}` and broadcasts the pause protocol: finish or
    cancel the in-flight tool call, start nothing new, save state (ledger/handoff, GOAL `[!] paused`), end the
    turn. The Agent PreToolUse hook enforces it deterministically by denying dispatches while the pause file is
    active.
  - `pause 30m` / `pause until 14:00`: the same, with `until` set. The master schedules its own one-shot reminder
    (CronCreate) to broadcast `resume` at that time. If the master is closed, the pause simply lapses at `until`.
    The hook ignores an expired file, and paused lanes are relaunched by the coordinator watcher, as for a battery
    pause.
  - `resume`: deletes the pause file and broadcasts "resume your saved work". Paused lanes with no live session are
    relaunched by `launch.mjs resume`.
- Low battery (stage 5) and usage pacing (stage 7) use the same pause protocol, so it exists once.

### Stage 7: 5-hour usage pacing
- **Signal (documented, zero tokens):** the statusLine command's stdin carries `rate_limits.five_hour.used_percentage`
  (0–100) and `rate_limits.five_hour.resets_at` (epoch s), plus the same for `seven_day`. They are account-wide (shared
  by every session and claude.ai) and arrive with each assistant message on Pro/Max. Status-line output never enters
  the model's context.
- **Recorder:** `coord.mjs statusline` is installed as the `statusLine` command.
  - It prints a short line (`5h 42% ↗ reset 14:20 · pace ok`) and writes `{ts, session_id, pct, resets_at}` to
    `~/.claude/state/coord/usage.json` (latest per session, plus a ring of the last 60 readings).
  - If the user already has a status line, the installer keeps it: coord runs that command with the same stdin and
    prints its output, then does its own recording.
- **Pacer (deterministic, in the Agent PreToolUse hook and `coord.mjs tick`):**
  - Use only readings in the current window (same `resets_at`) newer than 10 min. Without one, pacing is off
    (fail open).
  - Burn rate = slope of pct over the readings in the last 30 min, smoothed (EWMA).
  - Projected at reset = pct + rate × time left.
  - Target: stay **just under** the limit, at ≤ 95 % at reset (`pace_target`, configurable).

  | State | Condition | Action |
  |---|---|---|
  | ok | projected ≤ 95 % | nothing |
  | slow | projected 95–110 % | Low-priority lanes' dispatches are denied. Others get one line: "Usage pace: projected 104 % by 14:20. Step effort down (`effort-medium`/`low`) and do small work inline." |
  | hold | projected > 110 % or pct ≥ 95 | The pause protocol (stage 6) for all but high-priority lanes, auto-resumed at `resets_at` by the watcher. High-priority lanes continue at reduced effort. |

  - Weekly guard: `seven_day` ≥ 90 % → `slow` for every lane until the weekly reset.
  - `autoContinueAtUsageLimit` stays as the backstop if a hard limit is still hit.
- **Cost:** zero tokens to track (status-line output stays out of the model's context; reads are file reads). Only a
  `slow`/`hold` transition costs one notice line per affected session.
- **Limits:** the value is only as fresh as the latest API response in any session, and an idle machine has no
  fresh reading (pacing then does nothing, which is correct: nothing is spending). The burn rate counts claude.ai
  chat use too, because the limit is shared.

## Token accounting
| Piece | Tokens |
|---|---|
| Deterministic merge, overlap, watchdog, fence check, priority, power probe/watcher, usage recorder + pacer | 0 (code only) |
| Low-battery / pause / pacing notice | one line per session, only on the event |
| `/broadcast` | a few tool calls in the master, plus one short message read per receiving session |
| Resume after a pause | a fresh lane session per paused lane, which replaces the paused one |
| Lane note | ~60 tokens on the first prompt + when the lane set changes |
| Fence denial, loop notice | one line each, only when triggered |
| Conflict merge session | a full session, only on a real conflict or test failure |
| Loop restart | a session, at most 2 per lane per stage |

## Testing
- `node --test` units for the pure functions: overlap, fence decision, loop detection on fixture transcripts,
  restart-cap state.
- Hook scripts with fake stdin JSON.
- Live headless probes, as in the platform-facts section:
  - two lanes in temp repos; one finishes and is merged while the other still runs;
  - a conflicting pair produces a merge session pointer listing the conflicts;
  - a synthetic looping transcript triggers an incident and a relaunch command (dry-run);
  - a power probe with an injected reading (`HL_FAKE_POWER=19,battery`) denies dispatches, then the watcher resumes a
    paused lane (dry-run) when the reading flips to AC.

## Out of scope
Pushing to remotes; cross-machine coordination; fencing Bash writes.
