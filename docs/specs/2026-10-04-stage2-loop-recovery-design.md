# Stage 2: loop prevention and recovery: design

Status: approved by the user (2026-10-04), after the Fable spec review. It details stage 2 of `docs/specs/2026-10-02-parallel-sessions-design.md`, whose
outline it replaces. Approval of this file covers stage 2 only.

## Goal
Looping or stuck sessions and subagents are caught early and told to change course. If that fails, they are stopped,
cleaned up and reset to finish the task they were launched for. **No other concurrent session is affected.**
Decisions come from deterministic code and cost zero tokens until something fires. Busy-but-progressing work is never
killed.

## User decisions (2026-10-04)
- **Automatic recovery for new groups only.** Groups and sessions launched after stage 2 deploys get the full ladder.
  Those launched earlier are **report-only** (incident + alert, no stop request, no kill) until the user opts them in.
- **Alerts reach the user twice:** a desktop notification, and a phone push relayed by a live non-lane Claude session.
- **Scope:** sessions in the launcher registry only. Sessions the user opened by hand are never watched.
- **Restart method:** the first restart resumes the session (`claude --resume`). The second is a fresh session.
- **Large context:** a session looping with **≥ 400k tokens** of context restarts fresh at once, with its original
  launch prompt and its GOAL.md. If it loops again, it is **paused** (`blocked`) and the user is notified.
- **Prevention:** an early warning runs after every tool call, in launcher sessions only. Other sessions pay nothing.
- Earlier directives that still apply:
  - Kill only looping or broken work. Restart it correctly, and fix the cause.
  - Never kill an agent that can't save its state and restart from the middle.
  - Pauses close only idle sessions that saved their state.

## Foundations (fixes stage 2 builds on)
These come from the Fable triage of the stage-1 known issues. Each one is a precondition for safe kills.

- **Liveness has three states: `running` / `gone` / `unknown`.**
  - `procInfo`, `hasClaudeBelow` and `agentsList` each get a timeout (10 s, 10 s, 30 s).
  - A failed probe, a timeout or empty output returns `unknown`, never "dead" or "absent".
  - `unknown` never writes `{closed}`, never reports STALE, never kills, and makes `--force`/`--skip` refuse.
  - Today a PowerShell failure can make `closeOld` `taskkill` a live window (`launch.mjs:86,95,219,224`).
  - `sessionGone` is true for a background session only when it has a usable id **and** the `claude agents` call
    succeeded. Otherwise the existing 2-minute rule decides.
- **Reliable background ids.**
  - At a background launch, the launcher diffs `claude agents --json` before and after the spawn and matches the new
    entry by name. That gives `bg_id` and `session_id`.
  - Without a match, the entry is recorded with `bg_id: null`. A null-id session is never stopped (no more
    `claude stop ""`), and its liveness is `unknown` once the 2-minute rule no longer applies.
- **Launch identity.**
  - Task 0 fixes M5: the pid-file stem is `${name}-${stamp}`, with no 60-character truncation.
  - The pid file is deleted before the spawn, and the pid wait accepts only a file whose mtime is ≥ the spawn time.
  - Every launch line also records `model`, `effort`, `coord: 1` (written by a stage-2 launcher) and `prompt_file`
    (the exact pointer prompt, saved next to the pid file).
- **Fresh reads.** The tick re-reads the registry before each decision. It never acts on a start-of-run snapshot.
- **Config dir.**
  - `CFG = $CLAUDE_CONFIG_DIR || ~/.claude` is resolved once, in `launch.mjs`, `merge.mjs`, `coord.mjs` and
    `goal-gate.mjs`.
  - The child-env strip keeps `CLAUDE_CONFIG_DIR`, so children use the same config dir and their transcripts are found.
- **Startup window.** A session lock whose holder has no registry entry yet and is < 3 min old counts as `starting`.
  `--force`/`--skip` refuse it (triage T4e).
- **Drain-lock PID reuse.** The drain lock records the process start time and `lockStateOf` compares it (triage M8).

## Components
- `claude/skills/handoff-launch/recover-lib.mjs` (new, pure, unit-tested):
  - transcript → tool-call list;
  - loop rules a, b and d, the "never flagged" exemptions, and the re-arming "done" test;
  - the progress test, the context-token count, the ladder's next step, the restart kind and cap;
  - the superseded-close decision and the incident text.
- `claude/skills/handoff-launch/recover.mjs` (new, side effects):
  - the tick: scan, incident, stop request, kill, restart, block;
  - alert files and the desktop notification;
  - the guarded close.
- `~/.claude/hooks/coord.mjs` (new; the repo copy lives under `claude/hooks/`): a thin entry for hooks.
  - Subcommands: `post-tool`, `notify`, `tick`, `relay`, `alert-sent`, `alert-release`.
  - It reads small state files, answers in milliseconds, and spawns anything slow detached.
- `launch.mjs` changes:
  - the foundations above;
  - `--resume <session id>`;
  - passing the session hooks with `--settings`;
  - the `recover` and `resume` subcommands;
  - `watchdog` becomes a report of the tick's decisions;
  - `status` shows incidents, blocked lanes and report-only groups.
- `goal-gate.mjs` changes: start the tick, relay alerts, use `CFG`. It still fails open on any error.
- `merge.mjs` changes:
  - the merge drain and `status` skip lanes with a `{lane_blocked}` line;
  - the drain lock records the process start time (M8);
  - a `starting` session lock refuses `--force` and `--skip` (T4e);
  - overlap results go to a sidecar file (M3).
- `SKILL.md`: lane rules for warnings, stop requests and restarts, plus the new commands.

### State
- `CFG/state/coord/`:
  - `config.json`, the thresholds below. Missing means defaults.
  - `tick.json` (`{at}`) and `tick.lock`.
  - `sessions/<session id>.json`, the hook state.
  - `looping.json`, the flagged subagents.
  - `alerts/`.
  - `incidents/`, for sessions without a group.
- `<main repo>/.superpowers/sessions/<group>/incidents/<lane>-<n>.md`, the incident files for grouped sessions.
- New registry lines, each with an `at` timestamp:
  - `{stop_delivered: id}`;
  - `{incident: id, name, n, path, signature, tokens}`;
  - `{restart: name, n, kind: "resume"|"fresh", from: id, handoff}`;
  - `{lane_blocked: name, group, handoff, incident}`;
  - `{recovery_mode: <group or session name>, mode: "auto"|"report"}`.
- **The tick never writes done markers.** A blocked lane is a registry line, and `status` and the merge drain read it.
  This keeps stage 2 out of the done-marker race (triage M3), which is fixed separately (see "Carried triage items").

### Thresholds (`config.json`, defaults)
| Key | Default | Meaning |
|---|---|---|
| `repeat_window` / `repeat_count` | 20 / 4 | rule (a): the same call ≥ 4 times since the last change, within the last 20 tool calls (amended 2026-10-04 by user decision after the final review) |
| `warn_streak` | 3 | early warning: the same call 3 times in a row |
| `stuck_min` | 30 | rules (b) and (d) |
| `grace_min` | 5 | from a delivered stop request to the kill |
| `idle_close_min` | 10 | superseded-window close |
| `fresh_at_tokens` | 400000 | at or above this, the first restart is fresh and the cap is 1 |
| `max_restarts` | 2 | per lane per handoff file, below `fresh_at_tokens` |
| `tick_min` | 5 | minimum gap between ticks |
| `alert_repeat_hours` | 6 | report-only re-alert interval for an unchanged loop |

## Recovery mode
- A group is `auto` when its earliest registry launch line has `coord: 1`; otherwise it is `report`. A session
  without a group is judged the same way from its own launch line.
- `launch.mjs recover --group <id> --mode auto|report` (or `--name <session>`) appends a `{recovery_mode}` line. The
  latest such line wins.
- In `report` mode the tick still writes `looping.json`, so hook steps 2–4 still send their notices in sessions that
  have the hook (new generations in old groups). Those notices are non-destructive.
- In `report` mode the tick still detects, writes the incident and alerts. It sends no stop request, kills nothing and
  restarts nothing. The incident and the alert are written once per loop signature per session. The same signature
  alerts again only after `alert_repeat_hours`; a new signature alerts at once.
- **The superseded-window close applies in both modes.** That window handed its stage to generation N, so its state is
  saved by construction. The duplicate generations of 2026-10-03 happened in pre-stage-2 groups (user decision
  2026-10-04: all groups).

## Detection
### When it runs
`coord.mjs tick` starts detached, at most once per `tick_min`, from three triggers. Each trigger checks `tick.json`
first and fails open.
1. The goal-gate Stop hook, in every session.
2. The session PostToolUse hook, in every launcher session. This catches a session looping inside one long turn, which
   never reaches a Stop hook. It also catches a looping background agent, because the agent's tool events fire the
   parent's hooks.
3. Every launch, which replaces today's launch-time watchdog call (triage T1c).

The tick takes `tick.lock` (exclusive create, holding pid + start time; a lock whose holder is dead or older than
10 min is reclaimed), so two ticks never act at once.

### What it reads, per live registry session
- **The main transcript** (`CFG/projects/*/<session id>.jsonl`), its last 2 MB.
- **Subagent transcripts:** every `<session id>/subagents/agent-*.jsonl` whose mtime is after the previous tick.
- **The context size:** `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the last assistant
  `usage`. It drops after a compaction, which is correct: the session really is smaller then.
- **The hook state** `sessions/<session id>.json`: warnings given, and `waiting_since`.

### Loop rules (each yields a signature: the rule plus the repeated call's key, or the stuck tool)
- **(a) Repetition:** the same tool+input (key `name + JSON(input)`) ≥ `repeat_count` times **since the last
  change**, within the last `repeat_window` **tool calls** (today's code counts entries). Applies to main and subagent
  transcripts. (Amended 2026-10-04 by user decision after the final review.)
  - A **change** is a call that (1) is write-capable: `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`,
    `PowerShell`; (2) is new: its key has not already been a change in the window, so a write counts as new until it
    has once succeeded in the window; and (3) did not fail: its `tool_result` is not `is_error: true`, and a call with
    no result yet is not a change. A change resets every key's count.
  - So edit → run the test → edit → run it again is progress and never flagged, and so is an edit that fails, a re-read
    and the identical edit retried successfully. The same test run 4 times with nothing edited between, an A,B,A,B of
    calls already in the window, a flip-flop between two writes, or the same failing edit retried still fires.
- **(b) Stuck call:** a tool call has been outstanding with no activity for ≥ `stuck_min`.
  - Activity means a newer main-transcript entry, or growth of any subagent transcript of this session. So a long
    foreground `Agent` call whose subagent is still working is not stuck (today it is flagged).
  - A foreground Bash call cannot run past 10 min, so (b) in practice catches hung MCP or tool calls.
  - The exemption does not apply to a subagent that is itself in `looping.json`. Its growth is the loop, not activity.
- **Today's nudge rule ("≥ 5 goal-gate nudges in 60 entries") is dropped.** It flags two normal turns. It also cannot
  catch a real problem in a lane: a lane has one user prompt, so the gate reaches its cap at most once, and then the
  session goes idle. `status` shows that case as "idle with open GOAL items". It is not a loop and nothing is killed.
- **(d) Parent waiting on a looping subagent:** a subagent of this session is in `looping.json` and has made no
  progress since its notice was delivered (hook step 2). This covers both cases:
  - a background agent whose parent sits idle ≥ `stuck_min`;
  - a foreground `Agent` call that blocks the parent.

  In both cases the session is stuck, and the ladder applies to it.

### Never flagged, and when a loop is done
- **Waiting on a usage limit:** the transcript tail shows "limit · resets".
- **Waiting for the user:**
  - an outstanding `AskUserQuestion`; or
  - `waiting_since` is set by the `Notification` hook for a **permission** prompt only, and no tool call has followed.
    An idle prompt (the turn ended and no input came) does not count as waiting. Otherwise an idle parent of a looping
    agent would be exempt from rule (d).
- **Paused:** a `{paused}` registry line, or the pause file is active.
- **Liveness `unknown`.**
- **Done:** the loop no longer fires.
  - A ladder for a signature is **cancelled** only when its rule stops firing: for (a), the repeated key's count since
    the last change falls below `repeat_count` in the window; for (b), the stuck call completes; for (d), the subagent
    completes or is stopped.
  - A distinct new tool call **pauses** the grace timer but does not cancel the ladder (for (a), a change does: it
    resets the count, so the rule stops firing). A distinct call's key did not appear among the last `repeat_window`
    calls before the stop request.
  - If the same signature fires again within 60 min of a cancel, the ladder resumes at step 3, with no new warning or
    stop request. So an A,B,A,B loop with a stray C now and then still escalates.

## Prevention: the session hook
`launch.mjs` passes `--settings <REG_DIR>/session-hooks.json` to **every session it launches**: lanes, single handoff
sessions and merge sessions. That covers exactly the registry scope. The file holds two hooks.

- **PostToolUse (matcher `*`) → `coord.mjs post-tool`.** It reads its input, updates `sessions/<sid>.json`, writes at
  most one line of `additionalContext`, and exits. Steps, in order:
  1. **Stop delivery, parent events only** (no `agent_id`). If a stop request for this session is pending and not yet
     delivered, it injects the stop text and appends `{stop_delivered}`. This fixes today's print-only stop requests.
     A subagent's event never takes the session-level stop. A subagent gets step 2.
  2. **Looping subagent.** If the event comes from a subagent (`agent_id` present) flagged in `looping.json`, it tells
     that subagent: "You are repeating `<call>`. Stop, return what you have and the suspected cause." This goes out
     once per agent.
  3. **Fast path for the parent.** If a subagent of this session is flagged and the event is the parent's own,
     it says: "Agent `<type>` `<id>` is looping (`<reason>`). TaskStop it, diagnose the cause from `<agent transcript>`,
     fix the brief or the code, then re-dispatch per sizing-dispatches." This goes out once per agent.
  4. **Early warning.** If the same call has been made `warn_streak` times in a row (tracked per `agent_id`, so a
     subagent's calls and the parent's are not mixed), it says: "You have repeated `<call>` 3 times. Stop, find the
     cause, change approach. If this is intentional waiting, use Monitor or ScheduleWakeup instead of polling." This
     goes out once per signature.
  5. **Tick trigger,** as in "When it runs".
- **Notification → `coord.mjs notify`:** records `waiting_since` for **permission** prompts only, checked by the
  notification type field. The next PostToolUse clears it.
- **Hook cost:** about 50 ms of node start per tool call, in launcher sessions only. The hook spends zero tokens until
  it injects a line.
- **Fail-safe:** any error exits 0 with no output. A broken hook must never block a tool call.

## The ladder (`auto` mode)
For one flagged signature in one session:
1. **Warning.** Sent by the hook. It is not counted as a step: it may have happened earlier, or never.
2. **Stop request.**
   - The tick writes `stops/<stem>.stop.json`. The hook delivers it at the session's next tool call.
   - The text says: "The coordinator flagged a loop (`<signature>`). Finish or cancel the current call. Save your
     state (ledger or handoff, GOAL `[!] loop-stopped`). End your turn. If the repetition is intentional waiting,
     switch to Monitor or ScheduleWakeup instead. The loop is cleared when you change something (a new successful
     edit, write or shell command) or stop repeating the call; a different read alone does not clear it."
   - **Rule (d):** a parent that is blocked or idle makes no tool calls, so the looping subagent gets its stop through
     its own tool events (hook step 2). The agent's completion then wakes the parent.
   - **Dedupe** is keyed by (session, reason class: `ladder` / `close` / `manual`). A `closeOld` stop no longer
     suppresses a ladder stop, which today keeps the kill clock from starting.
3. **Grace.** Wait `grace_min` after delivery. A session that never runs a tool (rules b, d) gets `grace_min` from
   the request instead. A distinct call pauses the timer. The rule ceasing to fire cancels the ladder ("Done" above).
4. **Incident.** Written to `incidents/<lane>-<n>.md` before any kill:
   - the signature and the rule;
   - the last 20 tool calls;
   - the main and subagent transcript paths;
   - the context tokens;
   - the lane, branch, worktree and handoff;
   - the session's **other** background agents, listed as "re-dispatch";
   - a `Cause:` section left for the restarted session.

   Also appended: an `{incident}` registry line.
5. **Kill**, only if liveness is `running`.
   - Window sessions: `taskkill /T /F` of the recorded host pid, after checking its pid and start time.
   - Background sessions: `claude stop <bg_id>`.
   - `kill_intent` is written first. A process that is gone after the kill counts as closed (as in `guardclose.cjs`).
   - Only that session's own process tree is touched.
6. **Restart.** Kinds and cap are below. The new session gets the next generation, with the same name, group, worktree
   and handoff. Exceptions:
   - While the pause file is active, the restart is deferred until the pause lifts.
   - A lane whose done marker already exists is killed but **not restarted**. Its work now belongs to the merge drain,
     and the launcher would refuse it without `--reopen`.
7. **At the cap:** append `{lane_blocked}`, notify (desktop + phone, with the incident path), and leave everything
   else as it is: worktree, ledger, incident.

**The ladder resumes from registry state.** The tick may run inside the very lane it kills, and it can die between
the kill and the restart. Every tick starts by finding each `kill_intent` with no later `{closed}` or `{restart}` for
the same id, then re-checks that session's liveness:
- `gone`: write `{closed}`, then run step 6 or 7.
- `running`: treat it as a failed kill, and retry the kill once per tick.
- `unknown`: do nothing.

An `{incident}` with no `kill_intent` resumes at step 5. The restart itself is spawned detached, before the tick
records `{restart}`.

### Restart kind and cap
- The cap is counted per lane per handoff file, from `{restart}` lines. A new handoff (the next stage) starts again
  from zero.

| Context at the loop | 1st loop | 2nd loop | 3rd loop |
|---|---|---|---|
| < `fresh_at_tokens` | **resume** | **fresh** | blocked + notify |
| ≥ `fresh_at_tokens` | **fresh** | blocked + notify | — |

- The context is measured at each incident. A resumed session that grows past the threshold and loops again gets the
  ≥ row from then on.
- **Resume:** `launch.mjs --resume <session id>`. It reuses `resume-manifest.cjs` logic: the newest generation only,
  `claude --resume <id> -n <name>`, a launch line with `resumed_from`, and the same session id.
  - The prompt: "RECOVERY: you were stopped for a loop. Read `<incident>`. Find and fix the cause (systematic-debugging),
    record it in the incident's Cause section and the lane ledger, then continue."
  - The hook state for that session id is reset, so its early warnings fire again.
- **Fresh:** a normal launch from `prompt_file`, with the same model and effort, the same `--worktree` and a new
  session id.
  - The prompt starts with the same RECOVERY line, then the original pointer prompt.
  - The old session's GOAL.md is copied into the new session's scratchpad path. The id is known in advance (window
    mode passes `--session-id`), so goal-gate finds it.
- **Sizing:** same model and effort. One rung up the sizing ladder only on the second restart, and only when the first
  restart left the incident's Cause section empty.
- **Background-mode lanes** restart fresh only, unless the probes show that `--resume` works with `--bg`.
- **Lines from before stage 2** without `model`/`effort` restart as opus/high. That case only arises after a manual
  opt-in.
- **`launch.mjs resume --group <id> [--lane <name>]`** relaunches blocked lanes fresh, from their handoff and last
  incident, and gives them a new restart budget. Stage 5 and 6 reuse this command.

### Merge sessions
- `<group>-merge-<lane>` goes through the same ladder.
- A restart keeps its name, so the session lock in `merge.lock` stays valid. A resume also keeps the merge state in
  `_merge-<group>`.
- At the cap, the session is dead and still holds the lock, so `status` shows stage 1's STALE line. The alert spells
  out the next step: "`git merge --abort` in `.claude/worktrees/_merge-<group>`, then `launch.mjs merge --group <id>
  --force` (or `--skip <lane> --why ...`)."
- The ladder never deletes a lock, so other lanes' merges continue as soon as the user acts.

## Isolation guarantees
Each guarantee gets its own test.
- A kill touches only the target's own recorded process tree, after the pid and start-time check, and only when
  liveness is `running`.
- A restart reuses only the target's own worktree, and only after the old process is confirmed gone. Two sessions
  never share a worktree.
- The tick writes only:
  - the target's registry lines, stop file, incident and hook state;
  - `looping.json`;
  - `alerts/`.

  It never writes done markers, other lanes' files, `merge.lock` or another worktree.
- A session hook writes only its own `sessions/<sid>.json`. Its only output is the additional context for its own
  session.
- A looping lane holding `merge.lock` keeps it. Release goes through stage 1's existing paths only.
- Unknown liveness or a failed probe means no action and a `status` line. It is never a guess.

## Closing superseded and paused windows
- A window session of generation N-1 is closed through the guarded path when all of these hold:
  - generation N of the same lane (repo + branch) is `running`;
  - N-1 is idle for ≥ `idle_close_min`, with no outstanding call, no pending background agents and no
    `waiting_since`.
- The same applies to an idle window that recorded `{paused}`, and to one that has an incident and whose successor is
  running. These are the outline's exemptions from "never close N-1".
- **The guarded close** (the logic of `guardclose.cjs`, moved into `recover.mjs`):
  - the host is the recorded powershell, with a start time within 2 s;
  - the transcript turn is done;
  - write `kill_intent` → `taskkill /T` → `{closed}`. A process that is gone afterwards counts as closed.
- `closeOld`'s generation ≤ N-2 rule stays, with tri-state liveness.

## Alerts
- **The desktop notification** is a balloon tip from `System.Windows.Forms.NotifyIcon`, through built-in PowerShell
  5.1. It needs no install. The WinRT toast API needs a registered AppUserModelID or it fails silently, so it is not
  used.
  - macOS: `osascript display notification`. Linux: `notify-send`, if present.
  - It is best effort, and a failure is logged in the alert file.
- **The phone push.** The tick writes `alerts/<stamp>-<name>.json`: `{text, incident, created}`.
  - In a session that is **not** a launcher session (it has no `HL_SESSION_ID` in its env, which the launcher sets
    for its children), goal-gate claims one alert per Stop by renaming it to `claimed-<sid>-…`.
  - It then blocks once with: "Send this with PushNotification: `<text>`. Then run `node coord.mjs alert-sent <file>`.
    If you can't, run `alert-release <file>`."
  - If a claim is not marked sent within 15 min, the tick renames it back, so an alert never dies silently.
  - Cost: one short continuation in one non-lane session per alert.
- **What triggers an alert:** a `blocked` lane, a report-only incident (once per signature, see above), or a merge
  session at the cap.

## Commands (summary)
| Command | Effect |
|---|---|
| `launch.mjs recover --group <id> \| --name <s> --mode auto\|report` | sets the recovery mode |
| `launch.mjs resume --group <id> [--lane <n>]` | relaunches blocked lanes fresh, with a new restart budget |
| `launch.mjs --resume <session id> ...` | resume launch, used by the ladder |
| `launch.mjs watchdog [--repo <path>]` | prints what the tick would do now (dry run). `--stop-looping` stays as an alias that runs the tick |
| `launch.mjs status` | also shows incidents, `blocked`, `report-only` and liveness `unknown` |
| `coord.mjs tick [--dry-run]` | one tick, as described above |

## Carried triage items (Fable triage 2026-10-04, at c36a7de)
- **Task 0, a stage-1 fix PR, committed and pushed separately before the stage-2 tasks:**
  - **M5**, the slug-truncated pid-file stem. Important, because relaunches depend on it.
  - Unquoted paths with spaces, in the lane prompt and in `conflictHandoff`.
  - The drain-lock refresh records the current lane.
  - The `linkCreate` error wording.
  - A NaN `at` in a lock.
  - Unknown config keys and flags are rejected.
  - A newline in `--why` is collapsed.
  - Three missing merge tests.
- **Stage 2, in this design:**
  - tri-state liveness (bg `sessionGone`, empty `procInfo`, `hasClaudeBelow` failure, probe timeouts);
  - a reliable bg id;
  - progress-aware kills;
  - the nudge rule dropped (it never fires usefully in a lane);
  - the pid-file wait (N4);
  - fresh registry reads;
  - the launch-time watchdog moved to the tick;
  - `CLAUDE_CONFIG_DIR`;
  - drain-lock start time (M8);
  - the `starting` session lock (T4e);
  - liveness memoized per run (one PowerShell spawn per status);
  - **M3:** overlap results move to a sidecar `<lane>.overlap.json`, so `overlap` never rewrites a done marker.
- **Later stages:** the merge-queue `at` sort goes to stage 4 (priority ordering). Blocked lanes' `next_after_merge`
  tagging goes to stage 3.
- **Accepted:** the rest, listed with reasons in the private triage file.

## Testing
- **`node --test` units on `recover-lib.mjs`**, with fixture transcripts covering:
  - rules a, b and d, main and subagent, including a looping foreground subagent;
  - each "never flagged" case (usage limit, AskUserQuestion, `waiting_since`, paused, permission vs idle notification);
  - legitimate polling that switches to Monitor;
  - the token count;
  - the restart kind and cap table, including a 400k crossing;
  - an A,B,A,B loop with a stray distinct call still escalates (re-arming);
  - a resumed tick after `kill_intent` with no `{closed}` finishes the restart;
  - a done lane is killed but not restarted;
  - a new handoff resetting the cap;
  - report-only alert dedupe.
- **Hook scripts with fake stdin:** post-tool steps 1–5 in order; once-per-signature; per-`agent_id` streaks; any error
  → exit 0 with no output.
- **Liveness failure injection** (`HL_FAKE_PROBE=fail|timeout`):
  - status prints `unknown`;
  - no `{closed}` is written and nothing is killed;
  - `--force` refuses.
- **The isolation test:**
  - two lanes in temp repos with fake hosts (`HL_FAKE_CLAUDE`), one with a looping fixture transcript;
  - the tick kills and restarts only that one;
  - the other lane's registry lines, files, worktree and process are byte- and pid-identical before and after.
- **The merge-session test:** a looping merge session at the cap leaves `merge.lock` held, and the alert names the
  abort-then-force step.
- **The superseded-close test:** N-1 idle with N running is closed; N-1 busy or `waiting_since` is not.
- **All tests use** `HL_REGISTRY_DIR`, `HL_AGENTS_JSON=<file containing []>`, `HL_PROJECTS_DIR`, a temp `CFG`,
  `HL_FAKE_CLAUDE=1` and `HL_NO_SPAWN=1`. They never touch the real registry.
- **Live headless probes, run first in the plan.** The design changes if one fails.
  1. PostToolUse `additionalContext` fired inside a **subagent** reaches that subagent's model (so far verified only
     for the parent).
  2. The `Notification` hook input for a permission prompt and for an idle prompt (record the type field that tells
     them apart), and the main-session Stop hook input keys.
  3. The `claude agents --json` fields, and the before/after diff that captures a background id.
  4. `claude --resume <id> -n <name> <prompt>` on a transcript that was killed mid-tool-call (a `tool_use` with no
     result) resumes cleanly. Also whether `--resume` works with `--bg`.
  5. A `--settings` file with hooks layers onto the user's settings, so global hooks such as goal-gate still run.
  6. The NotifyIcon balloon shows from a detached, windowless node spawn.
  7. A detached node process spawned from inside a lane (a child of its powershell host) survives `taskkill /T` on
     that host. Whether or not it does, the ladder resumes from registry state, so this only settles how often the
     resume path runs.

## Token accounting
| Piece | Tokens |
|---|---|
| Tick, rules, liveness, kill, close, desktop notification | 0 |
| Session hook | 0 until it injects; then one line per signature or stop |
| Subagent fast path | one line to the agent, plus one to the parent |
| Restart | a resumed or fresh session, at most 2 per lane per handoff (1 at ≥ 400k) |
| Phone relay | one short continuation in one non-lane session per alert |

## Large-org variant
A central supervisor service with an audit log, per-session credentials for stop and kill (instead of a
self-declared `--session`), and policy-gated kills. On one developer machine, the registry and the guarded paths are
enough.

## Out of scope
- Hand-opened sessions, cross-machine coordination, usage pacing (stage 7), battery (stage 5) and the broadcast pause
  (stage 6).
- This stage only honours an existing pause file and `{paused}` lines.
