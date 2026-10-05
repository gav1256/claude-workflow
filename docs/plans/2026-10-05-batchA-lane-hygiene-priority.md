# Batch A: lane hygiene (stage 3) and priority ordering (stage 4): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallel launcher sessions stay clean and ordered: a window is closed only when its own successor replaces it,
the idle test sees background shell and Monitor tasks, windows whose claude is gone are found and closed, a lane writes
only into its own worktree and queues work meant for another lane, every session keeps a visible checklist, both
browser tools stay available but idle, and high-priority work is listed, merged and restarted first - all in
deterministic code that costs zero tokens until it fires.

**Architecture:** A new pure module, `lane-lib.mjs`, holds the decisions of Parts 1, 4, 5, 6 and 7 (the `supersedes`
choice and chains, the restart guard, the occupancy decision, the fence decision, the lane note, the inbox texts,
priority). `recover-lib.mjs` gains the pure decisions of Parts 2, 3, 8 and 9 (open background tasks, the dead-start
test and the restart match, the Playwright orphan signature and the claude-in-chrome tab set, the checklist parse and
lines). `live.mjs` gains the empty-host probe, the background-task scan inside `sessionState`, the command line in the
process list and the environment scrub. `recover.mjs` (the tick) closes by the chain relation, applies the union
restart guard, handles windows whose claude is gone, writes `lanes.json` and reaps Playwright orphans. `launch.mjs`
records provenance, refuses a launch onto a running session's checkout, closes by the chain, and gains `queue`,
`priority` and `sessions`. `merge-lib.mjs`/`merge.mjs` order merges by priority and tag FINAL_READY. `hooks/coord.mjs`
gains the `fence`, `lane-note` and `stop` hooks and the post-tool checklist lines; `goal-gate.mjs` nudges hand-opened
sessions without a GOAL.md. `profiles.json` gives every profile the pinned, headless Playwright server.

**Tech Stack:** Node >= 18 ESM (`node:fs`, `node:child_process`, `node:crypto`, `node:test`), Windows PowerShell 5.1 for
process probes, git worktrees. No repo dependencies; `@playwright/mcp` is installed at deploy under `<config>/mcp-servers`.

**Spec:** `docs/specs/2026-10-05-batchA-lane-hygiene-priority-design.md` (approved by the user 2026-10-05 after three
Fable review rounds; approval covers batch A only). Read it with this plan: the plan argues from it. It builds on
`docs/specs/2026-10-04-stage2-loop-recovery-design.md` and the stage-2 plan `docs/plans/2026-10-04-stage2-loop-recovery.md`.

## Global Constraints

- Decisions in deterministic code, zero tokens until something fires. Liveness `unknown` is never acted on: no close,
  kill, refusal or restart is decided from it (the occupancy check only warns on it).
- **No other concurrent session is affected.** The tick writes only its target's registry lines, stop file, incident
  and hook state, `looping.json`, `lanes.json` and `alerts/`. A session hook writes only its own `sessions/<sid>.json`
  (and its own `{stop_delivered}` line). The fence and the lane note never write outside that file.
- **No visible windows in tests, probes or live verification** (user correction 2026-10-05). Use the sandbox,
  `HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, `--dry-run` or headless `claude -p`; test hosts are hidden PowerShell processes.
  Only a step whose subject IS window launching may open one, and that step launches through the launcher's
  argument-array form (`spawnWindow`, never a `;`-joined `wt` string: a failed wt launch leaves an error tab with no
  process), records the host pid, closes it in the same step, and verifies it is gone. Browser checks close every tab
  or browser they open.
- Write fence: a write outside the lane is **denied** (`permissionDecision: "deny"`) with one line naming the queue
  command; never a permission prompt. Every new hook fails open (any error: exit 0, no output).
- Unknown launch flags only warn (`warning: unknown flag --<x> (ignored)`); they never refuse.
- Priority orders work only: it never bypasses the session cap (6 sessions, 3 GB free RAM).
- Old launchers ignore the new fields; a launch line without the `supersedes` key is a legacy line, and the legacy
  rules apply to it (generation order).
- New config keys in `<config>/state/coord/config.json` (missing = defaults): `bg_task_max_min` 240, `dead_close_min` 60,
  `goal_missing_calls` 10, `goal_stale_min` 40, `goal_stale_changes` 5. New alert key `deadstart|<id>`.
- Hook speed: about 100 ms including node start (probe 6: median 106 ms, p95 121 ms); no registry parse after a
  session's first fence call while it writes inside its own root, the config dir, the temp dir or `.superpowers`.
- Tests never touch the real registry or the live `~/.claude`: `HL_REGISTRY_DIR=<temp>`, `HL_AGENTS_JSON=<file with []>`,
  `HL_PROJECTS_DIR=<temp>`, a temp `CLAUDE_CONFIG_DIR`, `HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, `HL_FAKE_PROCS`; identities
  `test@example.com`. The sandbox drops the developer session's `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_CODE_SESSION_ATTENDED` and `CLAUDE_PID`.
- Every change lands in the repo copy (`claude/skills/handoff-launch/`, `claude/hooks/`) and reaches live
  (`~/.claude/...`) only in Task 13, after review; the copies stay identical.
- The repo is PUBLIC: no private project names, no user paths, no email. The secret scan (pattern from the private
  handoff) prints nothing before a push.
- Node >= 18 ESM, no dependencies, LF line endings. Proving check:
  `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` (the hook and goal-gate tests live in the
  same folder). Baseline at `c23aaf5`: `ℹ tests 252`, `ℹ pass 252`, `ℹ fail 0`, about 290 s. Report the real
  `ℹ tests / ℹ pass / ℹ fail` lines.
- Large-org variant (document only): a central lane registry service with per-lane credentials; writes outside a lane's
  sandbox refused by the filesystem (per-lane OS users or containers), and priority from a scheduler with quotas.

## Decisions beyond the spec's text

- **`lane-lib.mjs`** (new, pure) holds Parts 1, 4, 5, 6 and 7. `recover-lib.mjs` keeps Parts 2, 3 (as the spec places
  them), 8 and 9. `launch.mjs` is a CLI script, so `recover.mjs`, `merge*.mjs` and the hooks import these modules.
- **The occupancy check runs for every fresh launch, the refusal for rule 5 only.** Every fresh launch first closes the
  target checkout's windows whose host is empty (claude gone) - a relay's own launcher has claude below it and is never
  touched. Only a launch whose `supersedes` is null is refused by a running occupant. An empty host launched under
  2 min ago counts as running ("still starting"): claude starts a moment after the pid file.
- **"Launched after"** in the superseded relation: a legacy N needs no time test (its generation order says it); a new
  N's link counts when its launch time is at or after O's (equal milliseconds occur in hand-made and test lines).
- **The restart guard keeps the name check too.** `--resume` still refuses when its name has a newer launch line (stage
  2, closed or not), and also on the spec's union. The tick's `supersede()` uses the union only (open entries).
- **A co-tenant restart skip** writes `{restart_skipped: <id>, why: "an open newer launch <name> shares its checkout"}`
  and one alert.
- **Dead starts are recorded** as `{dead_start: <id>, name, group, at}` (see "Spec gaps" 2): status and the tick read
  the alert time from it; `dead_close_min` counts from it.
- **The Playwright reaper runs with the hourly orphan scan** (one process list; the spec says "the tick" - housekeeping
  is part of the tick). With `HL_FAKE_PROCS` it kills nothing. Command lines (now in the process list) never reach
  `orphans.json`. It also removes `%TEMP%/playwright_*dev_profile-*` dirs older than 24 h that no running process names
  (controller ruling after probe 7: `--isolated` leaves them).
- **`profiles.json` servers** may use `{config}` (the config dir) in their args and a `fallback` definition used when
  the first argument is a missing file: the pinned install is `node <config>/mcp-servers/node_modules/@playwright/mcp/cli.js
  --isolated --headless --idle-timeout 900000`, the fallback `npx @playwright/mcp@0.0.83` with the same arguments. A user
  server of the same name still wins (the stage-1 resolution order); Task 13 checks the live `~/.claude.json`.
- **The fence's registry reads:** at a session's first call (cached as `fence` in its hook state), and at any write
  outside its quick-allow set (own root without nested lane worktrees, config dir, temp dir, `<main>/.superpowers`), so
  a lane launched after the cache is still protected. The spec's "on a denial" is the common case of that. The owner
  of a path is judged from open registry entries (not `lanes.json`, which drops gone entries). An own root excludes
  another open entry's worktree nested inside it.
- **Status notes appear only when there is something to say** (stage-2 rule: a group without any stays byte-identical):
  `DEAD-START (since <at>)` with a `{dead_start}` line, `inbox=<n>` with items, `goal=...` when the session has a
  GOAL.md. Status prints no priority note; its lane order shows it (high -> normal -> low, then launch order).
- **`launch.mjs sessions`** prints one line per session:
  `<name>  <repo>@<branch>  group=<g|->  gen <n>  <liveness>  <busy|idle|waiting|no transcript|->  priority=<p>  <goal note>`,
  then `hand-opened <project folder> <sid 8>  <goal note>`.
- **`queue`**: `--dry-run` prints `would queue for <lane>: <path>`; an empty text exits 2.
- **The inbox goes back** when a bg launch failed and no new background session appeared (spawn error or non-zero
  exit), and when the window could not be spawned. A window with no pid file after 20 s keeps the take (it may still
  start and read it).
- **`--priority` with a bad value exits 2** (a known flag with a bad value, like `--mode`); unknown flags only warn.
  The warning covers the launch path and `--resume`; subcommands keep their own handling.
- **Test hosts:** `tests/helpers.mjs` `host()` runs a claude stand-in (a node child) below the hidden PowerShell host,
  as a live session's window has; `emptyHost()` (a window whose claude exited) and `jobHost()` (python below it) model
  Part 3.
- **`lanes.json`** entries also carry `liveness`; Part 3's "quiet" test uses the transcript file's mtime, so the tick
  reads a transcript tail only for a window that passed the registry and mtime tests.
- **The lane note's hash** covers its full text, so a change of the session's own priority re-sends it.
- **The claude-in-chrome Stop check** keys "the turn used claude-in-chrome" on a `chrome_turn` flag that post-tool sets
  and every Stop clears; it blocks once per such turn.
- **goal-gate's nudge** writes the gate's state file (`blocks: 1`) next to the GOAL.md it asks for, when that
  scratchpad exists, so the block counts toward the 3 continuations; the print-mode marker is
  `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (probe 2), with the single-prompt test kept as the fallback.
- **Work calls** for the staleness count include `Task` (an older name of `Agent`).
- **`freshLaunchArgs`** gains `priority` and `supersedes`; the tick's resume restart passes `--priority` too.
- **SKILL.md** grows by about 2.6 KB (to about 28 KB): the operator detail of `merge --skip/--force` moves to
  `coordinator.md`, and batch A's internals live there.

## Review Focus

1. **The first relay after the deploy** links a new line to a legacy line on a checkout that still holds older legacy
   generations: the chain must stop at the legacy entry, so those older windows are not pulled in (the 2026-10-04
   incident). (Test: Task 2, "chainOf: ... a legacy entry reached through a link ends the chain".)
2. **A session idling while its background shell task runs** (no turn_duration pending count covers it): never closed
   until the task's notification, TaskStop or the safety valve. (Tests: Task 4 "sessionState: an otherwise idle
   session with an open background shell task is busy ..."; Task 5 "an idle superseded window with a background shell
   task running is kept ...".)
3. **The user runs a job in a window whose claude exited** (python, git, npm test): the tick, the occupancy check and the
   launch-time close all keep it. (Tests: Task 4 "hostBelow: ... a user's job below it"; Task 5 "windows whose claude
   is gone: ... claude or a user's job keeps a window"; Task 6 "occupancy: ... a user's job below the host keeps it".)
4. **A hook meets garbage**: no `HL_SESSION_ID`, an entry it cannot find, unparsable stdin, a missing skill folder.
   It exits 0 with no output, so an Edit is never blocked by a broken hook. (Test: Task 9 "the write fence fails open
   ..." and the lane-note and stop garbage cases.)
5. **Another project's handoff passes a typo flag** (`--priorty high`): the launch goes on with one warning line, never a
   refusal, and the known set stays in step with the code. (Test: Task 6 "an unknown flag warns and is ignored ...".)

Also watch, by review rather than test: a failed inbox rename (Windows lets a rename of an open file succeed, so no
test can provoke it; the code path is one `try`); the tick probes every window whose transcript has been quiet for
10 min (one PowerShell probe each, every tick - a session idle for hours costs one probe per tick); concurrent
post-tool hooks of parallel tool calls may lose a counter update (worst case: one checklist line late).

## File structure

| File | Responsibility |
|---|---|
| `claude/skills/handoff-launch/lane-lib.mjs` (new, Task 2) | Pure: `normPath`, `isUnder`, `sameCheckout`, `chainOf`, `supersedes`, `supersedersOf`, `pickSupersedes`, `occupantAct`, `OCCUPIED`, `OCCUPANT_UNKNOWN`, `restartBlockers`, `isSuccessor`, `derivePriority`, `effectivePriority`, `byPriority`, `PRIORITIES`, `ownRoot`, `mainSessionOf`, `fenceDecision`, `fenceText`, `laneNoteText`, `textHash`, `otherLanes`, `openLanes`, `scopeOf`, `inboxBlock`, `inboxItems`, `INBOX_SENTENCE`, `takenName`. |
| `claude/skills/handoff-launch/recover-lib.mjs` (Task 3) | New config keys; `closeDecision`'s `emptyHost`; `freshLaunchArgs` priority/supersedes; `taskStart`, `taskEnds`, `openBgTasks`; `goneCandidate`, `goneKind`, `restartOf`, `DEAD_START_TEXT`; `isPlaywrightProc`, `playwrightOrphans`, `staleProfileDirs`, `tabIdsIn`, `chromeTabs`, `isChromeTool`, `CHROME_TABS_TEXT`; `parseGoal`, `goalNote`, `GOAL_MISSING_TEXT`, `GOAL_STALE_TEXT`, `WORK_TOOLS`, `goalSteps`. |
| `claude/skills/handoff-launch/live.mjs` (Tasks 4, 9) | `coordConfig`, `belowScript`, `hostBelow`, the process list's `cmd`, `sessionState`'s `bgTasks`, `launcherEnv`, the scrubbed `triggerTick`; `sessionHooks()` gains the three hooks (Task 9). |
| `claude/skills/handoff-launch/recover.mjs` (Task 5) | The union restart guard + co-tenant alert, `--priority`/`--supersedes` on restarts, deferred restarts high first, closes by the chain with the empty-host test, `guardedClose`'s no-claude form, `goneScan`/`deadStart` (Part 3), `laneTable`/`writeLanes` (`lanes.json`), `reapPlaywright`, the scrubbed `spawnLaunch`. |
| `claude/skills/handoff-launch/launch.mjs` (Tasks 6, 8, 10, 12) | Provenance fields, `--supersedes`, the occupancy check, `closeGone`, chain-based `closeOld`, the cap's `supersedes` exemption, `--resume --profile` and its union guard, unknown-flag warnings, `resume`'s priority/supersedes/scrub (Task 6); `queue`, `priority`, `sessions`, the inbox take, the GOAL sentence, status order and notes (Task 8); `builtinServer` (Task 10); the header (Task 12). |
| `claude/skills/handoff-launch/merge-lib.mjs`, `merge.mjs` (Tasks 6, 7) | The scrubbed merge-session spawn (Task 6); `mergeQueue` by priority and time (T2a), `finalReadyText` tags (T2f), `inboxDir`, `inboxInfo`, lanes' `priority`, the conflict handoff's inbox line (Task 7). |
| `claude/hooks/coord.mjs`, `claude/hooks/goal-gate.mjs` (Task 9) | `fence`, `laneNote`, `stopCheck`, post-tool's tab set and checklist lines; goal-gate's `missingNudge`. |
| `claude/skills/handoff-launch/profiles.json` (Task 10) | The pinned Playwright server in every profile (`lean` included), its fallback, the note. |
| `tests/lane-lib.test.mjs` (2), `tests/hygiene-lib.test.mjs` (3), `tests/hygiene.test.mjs` (5), `tests/provenance.test.mjs` (6), `tests/lanes.test.mjs` (8), `tests/lane-hooks.test.mjs` (9) (new, under `claude/skills/handoff-launch/`) | As named in each task. Existing test files change where a task says so. |
| `claude/skills/handoff-launch/tests/helpers.mjs` (Task 4) | The sandbox scrub, `sessionLine`'s new fields, `host()` with a claude stand-in, `emptyHost`, `jobHost`, `hasPython`. |
| `SKILL.md`, `coordinator.md`, the stage-2 spec (Task 12) | Docs. |

Run every test from the worktree root: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"`.

## Execution notes for the controller

- **Branch and worktree.** Push the spec and this plan first. Then cut `batchA-lane-hygiene-priority` from `main` in a
  worktree at `<main repo>/.claude/worktrees/batchA` (the main checkout stays on the controller's branch). Every
  implementer works in that worktree and commits per task there; Task 13 fast-forwards `main`.
- **Execution:** subagent-driven (the user's choice). Tasks run in order; two implementers never touch the same file at
  once, and each task builds on the merged work of the tasks before it (Task 6 needs Task 5's `guardedClose`, Task 8
  needs Task 6's provenance, Task 11 needs Tasks 5, 8 and 9).
- **Task 1 (probes) is done** (results below, all PASS); no fallback is in effect. The plan's code binds to those
  shapes; a step that depends on a probe names it.
- **Dispatch sizing** (`sizing-dispatches`), implementer / per-task reviewer. Correctness-critical tasks (the
  close/supersede logic, the fence decision, the reaper, the idle test) get `worker-xhigh` + a **fable** reviewer:

  | Task | Implementer | Reviewer |
  |---|---|---|
  | 1 probes | controller (done) | - |
  | 2 `lane-lib.mjs` (chains, supersedes, occupancy, fence decision, priority) | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 3 `recover-lib.mjs` (idle-test tasks, dead start, reaper signature, checklist) | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 4 `live.mjs` + helpers (the empty-host probe, the idle scan, the env scrub) | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 5 the tick (chain closes, restart guard, Part 3, lanes.json, reaper) | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 6 `launch.mjs` provenance, occupancy, chain close, resume guard, flags | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 7 merge queue priority, FINAL_READY | `worker-high` + opus | `worker-high` + opus |
  | 8 queue, inbox, priority, sessions, status | `worker-high` + opus | `worker-high` + opus |
  | 9 hooks: fence, lane note, stop, checklist lines, goal-gate | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 10 profiles: pinned Playwright, claude-in-chrome kept | `worker-high` + opus | `worker-high` + opus |
  | 11 the isolation test | `worker-high` + opus | `worker-high` + opus |
  | 12 docs | `worker-high` + opus | `worker-high` + opus |
  | 13 release | controller; whole-branch review `worker-xhigh` + **fable** | - |

- **The edit blocks are exact.** Each `**Replace** in <file>` block quotes text that occurs exactly once in that file
  after the previous tasks; `**Create**` gives a whole new file. They were proven by applying them in order to a
  scratch copy of `main` (`c23aaf5`) and running the full suite at every task boundary: `ℹ tests` 261, 270, 273, 280,
  290, 292, 299, 306, 307, 308, 308 after Tasks 2-12, each with `ℹ fail 0`. That proves the plan consistent, not
  correct: the reviews still judge it.
- Line numbers are at `c23aaf5`; anchor on the quoted code. Windows-only tests (real hidden PowerShell hosts) are
  `skip`ped elsewhere, as in stage 2.

### Probe results (filled by the controller in Task 1, 2026-10-05, Claude Code 2.1.289)

| # | Probe | Result (pass / fail + evidence) | Fallback taken |
|---|---|---|---|
| 1 | `PreToolUse` deny in `claude -p`; the reason reaches the model; hook stdin and env | PASS: `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` blocked a Write; the model quoted the reason. Stdin: `session_id, transcript_path, cwd, prompt_id, permission_mode, effort{level}, hook_event_name, tool_name, tool_input{file_path,...}, tool_use_id`. `HL_SESSION_ID` from the CLI's env reaches every hook; the hook env also has `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED`. An Edit on a missing file fails validation before PreToolUse fires. | None. Fallback had it failed: Task 9's fence prints `{"decision":"block","reason":...}` (the older PreToolUse form) instead. |
| 2 | `UserPromptSubmit` `additionalContext` from `--settings`; a print-mode marker | PASS: the model quoted the context. Stdin: `session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt`; no print-mode field in stdin. The print-mode marker is the env `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (with `CLAUDE_CODE_SESSION_ATTENDED=0`); interactive is `cli` / `1`. | None. Task 9's goal-gate nudge skips `CLAUDE_CODE_ENTRYPOINT === "sdk-cli"`, keeping the single-prompt test as the fallback. Had the context not arrived: the lane note would move into post-tool's first call. |
| 3 | `CLAUDE_CODE_SESSION_ID` in a tool call's env and in `launch.mjs`'s | PASS: equals the run's `session_id`. | None (Task 6 records it as `launched_by`). Fallback: `launched_by` from `HL_SESSION_ID`'s entry only. |
| 4 | Background task records in `claude -p` | PASS, shapes as the spec: start `toolUseResult.backgroundTaskId`; end = queue-operation `enqueue` content `<task-notification>...<task-id>T</task-id>...<status>completed</status>`, then an attachment `{type: "queued_command", prompt, commandMode: "task-notification"}`, then a queue-operation `remove` (no user record in `-p`); TaskStop's `toolUseResult` is `{"message":"Successfully stopped task: T (...)","task_id":"T","task_type":"local_bash",...}`. `claude -p` transcripts have NO `turn_duration` records, so fixtures of interactive sessions keep them. The Stop input has `background_tasks: [{id, type: "shell", status, description, command}]` (`[]` when none) and `session_crons`. | None. Task 3 reads the attachment as `{attachment: {type: "queued_command", prompt}}` (and the nested form). Fallback had the shapes differed: the Stop hook's `background_tasks` (launcher sessions only). |
| 5 | A window whose `claude` exits at once | PASS: `claude --settings <missing file>` in a `powershell -NoExit -File` host under wt printed "Error: Settings file not found" and exited 1; the host then had NO descendants (not even conhost: under Windows Terminal, OpenConsole hangs off WindowsTerminal.exe); no transcript. A host where the user then ran python had `python.exe` as its only child. wt treats `;` as its separator. | None: the empty-host test (`hostBelow().empty`) is confirmed. |
| 6 | The fence hook's latency | Node spawned directly, 60 KB JSONL + small JSON + deny JSON: median 106 ms, p95 121 ms. | Written as "about 100 ms; no registry parse after the first call" (Global Constraints). |
| 7 | Playwright pinned, isolated, headless, idle timeout; signature | PASS: `npm install --prefix <dir> @playwright/mcp@0.0.83` took 6.9 s, cli at `<dir>/node_modules/@playwright/mcp/cli.js`; `node <cli.js> --isolated --headless --idle-timeout 60000` connected at the default MCP timeout (15.5 s wall); two runs in one cwd both worked, each with its own `%TEMP%\playwright_chromiumdev_profile-XXXXXX`; the browser is the system `chrome.exe` with `--headless ... --user-data-dir=<TEMP>\playwright_chromiumdev_profile-XXXXXX --remote-debugging-pipe --no-startup-window`, parent chain `chrome.exe -> node.exe (cli.js) -> claude.exe`; `--idle-timeout` closed the browser (gone between t+65 and t+80 s) and the next navigate relaunched it. Seven profile dirs were left in %TEMP%. | Controller ruling: the reaper's hourly housekeeping also deletes `%TEMP%/playwright_*dev_profile-*` dirs older than 24 h that no running process names (Task 3 `staleProfileDirs`, Task 5 `reapPlaywright`). |
| 8 | claude-in-chrome result shapes | `tabs_context_mcp` input `{"createIfEmpty": true}`; its `content[0].text` is the JSON string `{"availableTabs":[{"tabId":N,"title","url"}],"tabGroupId":G}` (the same array in `toolUseResult`). A successful `tabs_create_mcp` result and a `tabs_close_mcp` input were not observed. | Task 3 parses tolerantly: every numeric `tabId` in the JSON text of a context/create result, minus `tabId`/`tabIds` of a close input; unparseable adds nothing (no reminder: fail open). |
| 9 | Probe hygiene | A plain `claude -p` needs `--allowedTools Bash` with the prompt BEFORE that variadic flag; `--settings` adds hooks; the user's global Stop hook still runs. | - |

---

### Task 1 (controller): Live probes

Done; results in the table above. Evidence lives in the controller's scratchpad (`probes-A/`). No step remains.

---

### Task 2: `lane-lib.mjs`: provenance, chains, the restart guard, occupancy, priority, the fence decision, lane note and inbox texts

All pure; no file or process access.

**Files:**
- Create: `claude/skills/handoff-launch/lane-lib.mjs`
- Test: `claude/skills/handoff-launch/tests/lane-lib.test.mjs` (new)

**Interfaces:**
- Consumes: nothing (node `path`, `crypto`).
- Produces:
  - `normPath(p, cwd?) -> string` (lowercase, `/`, no trailing `/`, `\\?\` stripped, relative resolved against cwd);
    `isUnder(p, root) -> bool`; `sameCheckout(a, b) -> bool` (same worktree path, or same repo + branch).
  - `hasSupersedesKey(e)`; `chainOf(n, entries) -> [entry]` (nearest first); `supersedes(n, o, entries) -> bool`;
    `supersedersOf(o, entries, closed) -> [entry]`.
  - `pickSupersedes({entries, closed, resumeOf, explicit, hlSessionId, launchedBy, target: {repo, branch, worktree}, name, isMerge}) -> {supersedes, rule: "resume"|"explicit"|"relay"|"merge"|"none", launcher, note}`.
  - `occupantAct({e, lv, below, ageMs}) -> {act: "ignore"|"warn"|"close"|"refuse", why}`; `OCCUPIED({repo, branch, e})`,
    `OCCUPANT_UNKNOWN({repo, branch, e, why})` (texts).
  - `restartBlockers(e, entries, closed) -> [entry]`; `isSuccessor(x, e, entries) -> bool`.
  - `PRIORITIES`; `derivePriority({model, effort})`; `effectivePriority(lines, e)`; `priorityRank(p)`;
    `byPriority(items, prio, then?) -> [item]` (stable).
  - `ownRoot(e) -> string`; `mainSessionOf(others, main)`; `fenceDecision(p, {cwd, own, main, config, tmp, others}) ->
    {allow} | {allow: false, owner: {name, branch}|null, mainCheckout}`; `fenceText({p, own, owner, mainCheckout, launchMjs, ownName})`.
  - `laneNoteText(me, others)`, `textHash(s)`, `otherLanes(lanes, me)`, `openLanes(entries, closed, repo)`, `scopeOf(text)`,
    `inboxBlock(at, from, text)`, `inboxItems(text)`, `INBOX_SENTENCE(path)`, `takenName(lane, stamp)`.

- [ ] **Step 1: Write the failing test**

**Create** `claude/skills/handoff-launch/tests/lane-lib.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../lane-lib.mjs";

const at = (m) => new Date(Date.UTC(2026, 9, 5, 10, m)).toISOString();
// A launch line: legacy unless `supersedes` is given (null included).
const ln = (id, o = {}) => ({ id, name: o.name ?? id.split("@")[0], repo: "c:/r", branch: "main", worktree: "C:/r", generation: 1, mode: "window", launched_at: at(0), ...o });

test("chainOf: a new line follows its links; a legacy entry reached through a link ends the chain; a legacy line keeps the generation rule", () => {
  const a = ln("A@1", { generation: 1, launched_at: at(1) });                         // legacy
  const b = ln("B@2", { generation: 2, launched_at: at(2), supersedes: "A@1" });       // new, links to legacy A
  const c = ln("C@3", { generation: 3, launched_at: at(3), supersedes: "B@2" });
  const x = ln("X@4", { generation: 4, launched_at: at(4) });                          // legacy, after the deploy boundary? no: legacy
  const entries = [a, b, c, x];
  assert.deepEqual(G.chainOf(c, entries).map((e) => e.id), ["B@2", "A@1"]);
  assert.deepEqual(G.chainOf(b, entries).map((e) => e.id), ["A@1"]);
  // Mixed boundary: legacy A has gen-1 predecessors on its checkout, but a chain that reaches A stops there.
  const old = ln("O@0", { generation: 0, launched_at: at(0) });
  assert.deepEqual(G.chainOf(c, [old, ...entries]).map((e) => e.id), ["B@2", "A@1"]);
  // A legacy N: every lower generation of its repo + branch (today's rule), whatever their keys.
  assert.deepEqual(G.chainOf(x, [old, ...entries]).map((e) => e.id).sort(), ["A@1", "B@2", "C@3", "O@0"]);
  // supersedes: null starts no chain; a cycle (hand-edited) ends; a missing link ends.
  assert.deepEqual(G.chainOf(ln("N@5", { supersedes: null }), entries), []);
  const p = ln("P@6", { supersedes: "Q@7" }), q = ln("Q@7", { supersedes: "P@6" });
  assert.deepEqual(G.chainOf(p, [p, q]).map((e) => e.id), ["Q@7"]);
  assert.deepEqual(G.chainOf(ln("M@8", { supersedes: "gone@1" }), entries), []);
});

test("supersedes: N after O and O in N's chain; chains pass through closed entries; a co-tenant is not a successor", () => {
  const o = ln("O@1", { launched_at: at(1), supersedes: null });
  const m = ln("M@2", { launched_at: at(2), supersedes: "O@1" });
  const n = ln("N@3", { launched_at: at(3), supersedes: "M@2" });
  const t = ln("T@4", { launched_at: at(4), supersedes: null }); // a --force'd co-tenant on the same checkout
  const all = [o, m, n, t];
  assert.equal(G.supersedes(n, o, all), true);
  assert.equal(G.supersedes(o, n, all), false);
  assert.equal(G.supersedes(t, o, all), false);
  assert.deepEqual(G.supersedersOf(o, all, new Set(["M@2"])).map((e) => e.id), ["N@3"]); // M is closed: N still supersedes O through it
  // Launch times equal to the millisecond (hand-made or test lines): a legacy N still supersedes its lower generation,
  // and a link still counts; a link from an OLDER line does not.
  const l1 = ln("L@1", { generation: 1, launched_at: at(9) }), l2 = ln("L@2", { generation: 2, launched_at: at(9) });
  assert.equal(G.supersedes(l2, l1, [l1, l2]), true);
  assert.equal(G.supersedes(ln("Q@2", { launched_at: at(1), supersedes: "O@1" }), o, all), true);
  assert.equal(G.supersedes(ln("Q@0", { launched_at: at(0), supersedes: "O@1" }), o, all), false);
});

test("pickSupersedes: resume, explicit, relay (same worktree path or same repo + branch), merge, none", () => {
  const L = ln("L@1", { session_id: "s-l", worktree: "C:/r/.claude/worktrees/lane-a", branch: "lane-a" });
  const other = ln("K@1", { branch: "lane-k", worktree: "C:/r/.claude/worktrees/lane-k" });
  const entries = [L, other];
  const target = { repo: "c:/r", branch: "lane-a", worktree: "c:\\r\\.claude\\worktrees\\lane-a\\" };
  assert.deepEqual(G.pickSupersedes({ entries, resumeOf: L, explicit: "K@1", hlSessionId: "L@1", target, name: "L" }), { supersedes: "L@1", rule: "resume", launcher: null, note: null });
  assert.equal(G.pickSupersedes({ entries, explicit: "K@1", hlSessionId: "L@1", target, name: "L" }).supersedes, "K@1");
  let r = G.pickSupersedes({ entries, hlSessionId: "L@1", target, name: "L" });
  assert.deepEqual([r.supersedes, r.rule, r.note], ["L@1", "relay", null]);
  // Found by launched_by (a launcher without HL_SESSION_ID), under another --name: a relay, with its note.
  r = G.pickSupersedes({ entries, launchedBy: "s-l", target, name: "L2" });
  assert.deepEqual([r.supersedes, r.note], ["L@1", "note: this launch replaces L (gen 1) as its relay"]);
  // L switched its checkout's branch after its own launch: the worktree path still makes it a relay.
  r = G.pickSupersedes({ entries, hlSessionId: "L@1", target: { ...target, branch: "lane-a2" }, name: "L" });
  assert.equal(r.rule, "relay");
  // A registry session launching onto another checkout: none (rule 5).
  r = G.pickSupersedes({ entries, hlSessionId: "L@1", target: { repo: "c:/r", branch: "lane-k", worktree: "C:/r/.claude/worktrees/lane-k" }, name: "X" });
  assert.deepEqual([r.supersedes, r.rule], [null, "none"]);
  // A merge session with no known launcher: the target's newest open entry; with a known launcher elsewhere: none.
  const m1 = ln("g-merge-a@1", { branch: "int", worktree: "C:/r/.claude/worktrees/_merge-g", launched_at: at(1) });
  const m2 = ln("g-merge-b@2", { branch: "int", worktree: "C:/r/.claude/worktrees/_merge-g", launched_at: at(2) });
  const mt = { repo: "c:/r", branch: "int", worktree: "C:/r/.claude/worktrees/_merge-g" };
  assert.equal(G.pickSupersedes({ entries: [m1, m2], target: mt, name: "g-merge-c", isMerge: true }).supersedes, "g-merge-b@2");
  assert.equal(G.pickSupersedes({ entries: [m1, m2], closed: new Set(["g-merge-b@2"]), target: mt, name: "g-merge-c", isMerge: true }).supersedes, "g-merge-a@1");
  assert.equal(G.pickSupersedes({ entries: [m1, m2, L], hlSessionId: "L@1", target: mt, name: "g-merge-c", isMerge: true }).supersedes, null);
  // A hand-opened session or a plain terminal: none.
  assert.equal(G.pickSupersedes({ entries, launchedBy: "s-unknown", target, name: "X" }).supersedes, null);
});

test("occupantAct: running refuses, unknown warns, an empty host closes (dead start or exited), a user's job below keeps it", () => {
  const w = ln("W@1"), b = ln("B@1", { mode: "bg" });
  const run = { state: "running", why: "host pid 1" };
  assert.equal(G.occupantAct({ e: w, lv: { state: "gone", why: "x" }, below: null, ageMs: 0 }).act, "ignore");
  assert.equal(G.occupantAct({ e: w, lv: { state: "unknown", why: "probe" }, below: null, ageMs: 0 }).act, "warn");
  assert.equal(G.occupantAct({ e: b, lv: run, below: null, ageMs: 0 }).act, "refuse");
  assert.equal(G.occupantAct({ e: w, lv: run, below: null, ageMs: 0 }).act, "warn");
  assert.equal(G.occupantAct({ e: w, lv: run, below: { claude: true, empty: false, names: ["claude.exe"] }, ageMs: 3600e3 }).act, "refuse");
  assert.deepEqual(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: false, names: ["python.exe"] }, ageMs: 3600e3 }), { act: "refuse", why: "its window runs python.exe" });
  assert.equal(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: true, names: [] }, ageMs: 3600e3 }).act, "close");
  assert.equal(G.occupantAct({ e: w, lv: run, below: { claude: false, empty: true, names: [] }, ageMs: 30000 }).act, "refuse"); // still starting
  assert.match(G.OCCUPIED({ repo: "C:/r", branch: "main", e: { ...w, generation: 3 } }), /^refused - C:\/r@main already has a running session W \(gen 3, id W@1\): two sessions must not share a worktree\. .* --supersedes W@1\. --force overrides \(ask the user first\)\.$/);
});

test("restartBlockers is the union: newer on the same repo + branch, or a successor on a switched branch; isSuccessor tells a co-tenant", () => {
  const e = ln("E@1", { generation: 1, launched_at: at(1), supersedes: null });
  const relay = ln("R@2", { generation: 1, branch: "other", launched_at: at(2), supersedes: "E@1" }); // relay that switched branch
  const co = ln("T@3", { generation: 2, launched_at: at(3), supersedes: null });                     // co-tenant, newer gen
  const all = [e, relay, co];
  assert.deepEqual(G.restartBlockers(e, all).map((x) => x.id), ["R@2", "T@3"]);
  assert.deepEqual(G.restartBlockers(e, all, new Set(["R@2", "T@3"])), []);
  assert.equal(G.isSuccessor(relay, e, all), true);
  assert.equal(G.isSuccessor(co, e, all), false);
  // A legacy newer generation is a successor (its chain is the generation rule).
  const leg = ln("L@4", { generation: 3, launched_at: at(4) });
  assert.equal(G.isSuccessor(leg, e, [...all, leg]), true);
});

test("priority: derived from the sizing, set by a later {priority} line, sorted high -> normal -> low then the given order", () => {
  assert.equal(G.derivePriority({ model: "fable", effort: "high" }), "high");
  assert.equal(G.derivePriority({ model: "opus", effort: "xhigh" }), "high");
  assert.equal(G.derivePriority({ model: "opus", effort: "max" }), "high");
  assert.equal(G.derivePriority({ model: "opus", effort: "high" }), "normal");
  assert.equal(G.derivePriority({ model: "opus", effort: "medium" }), "low");
  assert.equal(G.derivePriority({ model: "opus", effort: "low" }), "low");
  assert.equal(G.derivePriority({}), "normal");
  const e = ln("A@1", { group: "g", model: "opus", effort: "high", launched_at: at(5) });
  const lines = [e, { priority: "A", group: "g", value: "high", at: at(4) }]; // older than the launch: ignored
  assert.equal(G.effectivePriority(lines, e), "normal");
  lines.push({ priority: "A", group: "other", value: "low", at: at(6) });     // another group: ignored
  lines.push({ priority: "A", group: "g", value: "low", at: at(7) });
  assert.equal(G.effectivePriority(lines, e), "low");
  assert.equal(G.effectivePriority(lines, { ...e, priority: "high", launched_at: at(8) }), "high"); // a newer launch line wins
  const items = [{ n: "a", p: "low" }, { n: "b", p: "normal" }, { n: "c", p: "high" }, { n: "d", p: "normal" }, { n: "e", p: undefined }];
  assert.deepEqual(G.byPriority(items, (x) => x.p).map((x) => x.n), ["c", "b", "d", "e", "a"]);
});

test("fenceDecision: own root, config, temp, .superpowers, unowned agent worktrees allow; other lanes and the main checkout deny", () => {
  const main = "C:/Users/me/r";
  const mine = ln("A@1", { repo: "c:/users/me/r", worktree: `${main}/.claude/worktrees/lane-a`, branch: "lane-a" });
  const b = ln("B@1", { repo: "c:/users/me/r", worktree: `${main}/.claude/worktrees/lane-b`, branch: "lane-b" });
  const ext = ln("X@1", { repo: "c:/users/me/r", worktree: "D:/elsewhere/r-x", branch: "lane-x" });
  const onMain = ln("M@1", { repo: "c:/users/me/r", worktree: main, branch: "main", launched_at: at(3) });
  const ctx = { cwd: `${main}/.claude/worktrees/lane-a`, own: G.ownRoot(mine), main, config: "C:/Users/me/.claude", tmp: "C:/Users/me/AppData/Local/Temp", others: [b, ext, onMain] };
  const d = (p, c = ctx) => G.fenceDecision(p, c);
  assert.equal(d("src/a.js").allow, true);                                                  // relative, own worktree
  assert.equal(d("C:\\USERS\\ME\\R\\.claude\\worktrees\\LANE-A\\x.md").allow, true);           // case, backslashes
  assert.equal(d("\\\\?\\C:\\Users\\me\\r\\.claude\\worktrees\\lane-a\\y").allow, true);       // a long-path prefix
  assert.equal(d("C:/Users/me/.claude/experiments/ledger.md").allow, true);
  assert.equal(d("C:/Users/me/AppData/Local/Temp/claude/x/scratchpad/GOAL.md").allow, true);
  assert.equal(d(`${main}/.superpowers/sessions/g/A.done`).allow, true);
  assert.equal(d(`${main}/.claude/worktrees/agent-1234/f.js`).allow, true);                    // a subagent's own worktree
  assert.equal(d("D:/other-repo/f.js").allow, true);
  let r = d(`${main}/.claude/worktrees/lane-b/f.js`);
  assert.deepEqual([r.allow, r.owner.name, r.mainCheckout], [false, "B", false]);
  r = d("D:/elsewhere/r-x/sub/f.js");
  assert.deepEqual([r.allow, r.owner.name], [false, "X"]);
  r = d(`${main}/README.md`);
  assert.deepEqual([r.allow, r.owner, r.mainCheckout], [false, { name: "M", branch: "main" }, true]);
  assert.equal(d(`${main}/README.md`, { ...ctx, others: [b] }).owner, null);                  // the main checkout has no session
  // A session on the main checkout writes the main checkout, never another lane's worktree.
  const mctx = { ...ctx, cwd: main, own: G.ownRoot(onMain), others: [b, mine] };
  assert.equal(d(`${main}/README.md`, mctx).allow, true);
  assert.equal(d(`${main}/.claude/worktrees/lane-b/f.js`, mctx).allow, false);
  assert.equal(d(`${main}/.claude/worktrees/agent-9/f.js`, mctx).allow, true);
  // Nested: another lane's worktree inside this one's root is not this lane's.
  const nested = ln("N@1", { repo: "c:/users/me/r", worktree: `${main}/.claude/worktrees/lane-a/.claude/worktrees/n`, branch: "n" });
  assert.equal(d(`${main}/.claude/worktrees/lane-a/.claude/worktrees/n/f`, { ...ctx, others: [nested] }).allow, false);
  // A session launched on a subdirectory of the main checkout owns the main checkout.
  assert.equal(G.ownRoot(ln("S@1", { repo: "c:/users/me/r", worktree: `${main}/sub` })), "c:/users/me/r");
  assert.equal(G.ownRoot(ext), "d:/elsewhere/r-x");
  assert.match(G.fenceText({ p: "C:/x", own: "c:/w", owner: { name: "B", branch: "lane-b" }, mainCheckout: false, launchMjs: "L.mjs", ownName: "A" }),
    /^Write fence: C:\/x belongs to lane B \(lane-b\), not to this lane \(c:\/w\)\. Do not edit it from here\. Queue the change: node L\.mjs queue --to B --text "<what to change>" \[--after-merge\], or tell the user\.$/);
  assert.match(G.fenceText({ p: "C:/x", own: "c:/w", owner: null, mainCheckout: true, launchMjs: "L.mjs", ownName: "A" }), /belongs to the main checkout \(no session\): tell the user, or queue it --after-merge in your group/);
});

test("lane note text, its hash and the lane sets", () => {
  const me = { name: "A", branch: "lane-a", own: "c:/r/.claude/worktrees/lane-a", priority: "high" };
  const t = G.laneNoteText(me, [{ name: "B", branch: "lane-b", scope: "Batch B: merge" }]);
  assert.equal(t, "Lane note: you are lane A (branch lane-a, c:/r/.claude/worktrees/lane-a, priority high). Other live lanes in this repo: B (lane-b, Batch B: merge). "
    + "A request meant for another lane: say it belongs to that lane and offer launch.mjs queue --to <lane>. Work on files another live lane is changing: queue it with --after-merge.");
  assert.equal(G.laneNoteText(me, []), "Lane note: you are lane A (branch lane-a, c:/r/.claude/worktrees/lane-a, priority high). No other live lanes in this repo.");
  assert.notEqual(G.textHash(t), G.textHash(G.laneNoteText(me, [])));
  const lanes = [{ id: "A@1", branch: "lane-a", worktree: "C:/r/.claude/worktrees/lane-a" }, { id: "B@1", branch: "lane-b", worktree: "C:/r/.claude/worktrees/lane-b" }];
  assert.deepEqual(G.otherLanes(lanes, { id: "A@2", branch: "lane-a", worktree: "c:/r/.claude/worktrees/lane-a" }).map((l) => l.id), ["B@1"]);
  const e1 = ln("A@1", { branch: "a", launched_at: at(1) }), e2 = ln("A@2", { branch: "a", launched_at: at(2) }), e3 = ln("C@1", { repo: "c:/other", branch: "a" });
  assert.deepEqual(G.openLanes([e1, e2, e3], new Set(), "c:/r").map((e) => e.id), ["A@2"]);
  assert.deepEqual(G.openLanes([e1, e2], new Set(["A@2"]), "c:/r").map((e) => e.id), ["A@1"]);
});

test("scope and inbox helpers", () => {
  assert.equal(G.scopeOf("intro\n# Batch A: lane hygiene\n## x"), "Batch A: lane hygiene");
  assert.equal(G.scopeOf(`# ${"x".repeat(100)}`).length, 80);
  assert.equal(G.scopeOf("no heading"), null);
  const t = G.inboxBlock("2026-10-05T10:00:00.000Z", "B", "fix the parser\n") + G.inboxBlock("2026-10-05T10:01:00.000Z", "user", "and the docs");
  assert.equal(G.inboxItems(t), 2);
  assert.equal(G.inboxItems("## not an item\n"), 0);
  assert.equal(G.INBOX_SENTENCE("C:/r/x.md"), " Read your inbox first: C:/r/x.md - items other lanes queued for you.");
});
```


- [ ] **Step 2: Run it to verify it fails**

Run: `node --test claude/skills/handoff-launch/tests/lane-lib.test.mjs`
Expected: FAIL - `Cannot find module '.../lane-lib.mjs'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Implement**

**Create** `claude/skills/handoff-launch/lane-lib.mjs`:

```js
// Pure lane decisions of batch A (stages 3 and 4): launch provenance (`supersedes`, chains, the superseded relation, the
// restart guard), the occupancy check, priority, the write fence, the lane note and the inbox. No fs, no clock, no
// processes: callers pass registry entries, paths and `now` in (tests/lane-lib.test.mjs covers each decision).
import path from "node:path";
import crypto from "node:crypto";

export const MIN = 60000;

// ---------- paths: compared case-insensitively with forward slashes (as merge-lib key() does), no trailing slash ----------
// A long-path \\?\ prefix is stripped. Relative paths resolve against cwd.
export function normPath(p, cwd = null) {
  let s = String(p ?? "").replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  if (!s) return "";
  if (cwd && !path.isAbsolute(s)) s = path.resolve(String(cwd).replace(/^\\\\\?\\/, ""), s);
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
export const isUnder = (p, root) => !!p && !!root && (p === root || p.startsWith(`${root}/`));
const ts = (e) => Date.parse(e?.launched_at) || 0;
const gen = (e) => e?.generation || 0;

// ---------- Part 1: launch provenance ----------
// A line WITHOUT the key is a legacy line (written before batch A).
export const hasSupersedesKey = (e) => !!e && Object.hasOwn(e, "supersedes");
// Same checkout: same worktree path, or same repo + branch.
export const sameCheckout = (a, b) => !!a && !!b && ((!!a.worktree && normPath(a.worktree) === normPath(b.worktree)) || (a.repo === b.repo && a.branch === b.branch));
// The entries N supersedes, nearest first. N with the key: S = N.supersedes, plus S's chain when S also has the key; a
// legacy entry reached through a link ends the chain (it is in the chain, its predecessors are not). Chains pass through
// closed entries. N legacy: every entry of the same repo + branch with a lower generation (the stage-2 rule).
export function chainOf(n, entries) {
  if (!n) return [];
  if (!hasSupersedesKey(n)) return entries.filter((x) => x.id !== n.id && x.repo === n.repo && x.branch === n.branch && gen(x) < gen(n));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out = [], seen = new Set([n.id]);
  let s = n.supersedes ? byId.get(n.supersedes) : null;
  while (s && !seen.has(s.id)) {
    out.push(s); seen.add(s.id);
    if (!hasSupersedesKey(s)) break;
    s = s.supersedes ? byId.get(s.supersedes) : null;
  }
  return out;
}
// O is superseded by N: N was launched after O and O is in N's chain. A legacy N's chain is the generation order, which
// already says "after" (its launch time may equal O's to the millisecond in hand-made lines); a link of a new N is
// written by a later launch, so the same millisecond still counts as after.
export const supersedes = (n, o, entries) => !!n && !!o && n.id !== o.id && (!hasSupersedesKey(n) || ts(n) >= ts(o))
  && chainOf(n, entries).some((x) => x.id === o.id);
// The open entries that supersede o (the tick's close candidates' successors).
export const supersedersOf = (o, entries, closed) => entries.filter((n) => !closed.has(n.id) && supersedes(n, o, entries));
// What a launch line's `supersedes` is (first match wins):
//   1. resumeOf: the entry a --resume resumes; 2. explicit: --supersedes <id>; 3. a relay: the launcher L (by
//   HL_SESSION_ID = L.id, else launched_by = L.session_id) runs in the target checkout; 4. a merge session with no known
//   launcher: the target checkout's newest open entry; 5. anything else: null.
// target: {repo, branch, worktree}. -> {supersedes, rule, launcher, note}
export function pickSupersedes({ entries, closed = new Set(), resumeOf = null, explicit = null, hlSessionId = null, launchedBy = null, target, name, isMerge = false }) {
  if (resumeOf) return { supersedes: resumeOf.id, rule: "resume", launcher: null, note: null };
  if (explicit) return { supersedes: explicit, rule: "explicit", launcher: null, note: null };
  const newest = (f) => [...entries].reverse().find(f) ?? null;
  const L = (hlSessionId && newest((e) => e.id === hlSessionId)) || (launchedBy && newest((e) => e.session_id === launchedBy)) || null;
  if (L && sameCheckout(L, target))
    return { supersedes: L.id, rule: "relay", launcher: L, note: L.name !== name ? `note: this launch replaces ${L.name} (gen ${L.generation ?? "?"}) as its relay` : null };
  if (isMerge && !L) {
    const prev = newest((e) => !closed.has(e.id) && e.repo === target.repo && e.branch === target.branch);
    return { supersedes: prev?.id ?? null, rule: "merge", launcher: null, note: null };
  }
  return { supersedes: null, rule: "none", launcher: L, note: null };
}

// ---------- the occupancy check (rule-5 launches; gone windows are closed for every fresh launch) ----------
// One open entry on the target checkout. lv: its liveness {state, why}; below: hostBelow()'s answer for a window
// ({claude, empty, names}, null = the probe failed); ageMs: since its launch. -> {act: ignore|warn|close|refuse, why}
export function occupantAct({ e, lv, below, ageMs }) {
  if (lv.state === "gone") return { act: "ignore", why: lv.why };
  if (lv.state === "unknown") return { act: "warn", why: lv.why };
  if (e.mode === "bg") return { act: "refuse", why: "claude agents lists it as running" };
  if (!below) return { act: "warn", why: "the process probe below its window failed" };
  // An empty host (nothing below it but conhost): claude exited or never started. Within 2 min of the launch it may still
  // be starting, so it counts as running.
  if (below.empty) return ageMs >= 2 * MIN ? { act: "close", why: "claude exited (its window host is empty)" } : { act: "refuse", why: "its window is still starting" };
  return { act: "refuse", why: below.claude ? "claude runs in its window" : `its window runs ${below.names.join(", ")}` };
}
export const OCCUPIED = ({ repo, branch, e }) => `refused - ${repo}@${branch} already has a running session ${e.name} (gen ${e.generation ?? "?"}, id ${e.id}): `
  + "two sessions must not share a worktree. Launch a helper with --worktree <own branch>, or replace that session explicitly with "
  + `--supersedes ${e.id}. --force overrides (ask the user first).`;
export const OCCUPANT_UNKNOWN = ({ repo, branch, e, why }) => `warning: ${repo}@${branch} has an open session ${e.name} (gen ${e.generation ?? "?"}, id ${e.id}) whose liveness is unknown (${why}) - two sessions must not share a worktree: check it`;

// ---------- the restart guard (the union: the conservative direction) ----------
// Open entries that block a restart of e: newer on the same repo + branch, or with e in their chain.
export function restartBlockers(e, entries, closed = new Set()) {
  return entries.filter((x) => x.id !== e.id && !closed.has(x.id)
    && ((x.repo === e.repo && x.branch === e.branch && gen(x) > gen(e)) || supersedes(x, e, entries)));
}
// A blocker that is not e's successor is a co-tenant (a --force'd launch on e's checkout).
export const isSuccessor = (x, e, entries) => supersedes(x, e, entries);

// ---------- Part 7: priority ----------
export const PRIORITIES = ["high", "normal", "low"];
const RANK = { high: 0, normal: 1, low: 2 };
// From the sizing: model fable, or effort xhigh or max -> high; effort high -> normal; medium or low -> low; neither -> normal.
export function derivePriority({ model, effort } = {}) {
  if (/fable/i.test(String(model ?? "")) || effort === "xhigh" || effort === "max") return "high";
  if (effort === "medium" || effort === "low") return "low";
  return "normal";
}
// The latest of the newest launch line e of its name and any later {priority: <name>, group, value, at} line.
export function effectivePriority(lines, e) {
  if (!e) return "normal";
  let p = PRIORITIES.includes(e.priority) ? e.priority : derivePriority(e);
  const t = ts(e);
  for (const o of lines || []) {
    if (o && !o.launched_at && o.priority === e.name && PRIORITIES.includes(o.value) && (o.group ?? null) === (e.group ?? null) && (Date.parse(o.at) || 0) >= t) p = o.value;
  }
  return p;
}
export const priorityRank = (p) => RANK[p] ?? RANK.normal;
// The one shared sort: priority first, then `then` (default: the input order; Array.prototype.sort is stable).
export function byPriority(items, prio, then = () => 0) {
  return [...items].sort((a, b) => priorityRank(prio(a)) - priorityRank(prio(b)) || then(a, b));
}

// ---------- Part 4: the write fence ----------
// e: the session's own launch line; mainRoot: its main checkout root (e.repo is its key). -> the own root, normalised.
// The entry's worktree when it is under <main>/.claude/worktrees/ or outside the main checkout; else the main checkout.
export function ownRoot(e) {
  const main = normPath(e.repo), wt = normPath(e.worktree || e.repo);
  if (isUnder(wt, `${main}/.claude/worktrees`) || !isUnder(wt, main)) return wt;
  return main;
}
// The main checkout's open session for the denial text: the newest of `others` whose own root is the main checkout.
export const mainSessionOf = (others, main) => [...(others || [])].filter((o) => ownRoot(o) === normPath(main)).sort((a, b) => ts(a) - ts(b)).at(-1) ?? null;
// p: the tool's file path; ctx: {cwd, own, main, config, tmp, others: [launch lines] (the other open entries of the same
// repo, own excluded)}. -> {allow: true} | {allow: false, owner: {name, branch} | null, mainCheckout}
export function fenceDecision(p, ctx) {
  const P = normPath(p, ctx.cwd);
  if (!P) return { allow: true };
  const main = normPath(ctx.main), wts = `${main}/.claude/worktrees`;
  // Each other entry owns its own root; an entry on the main checkout owns no worktree (the main checkout is judged below).
  const others = (ctx.others || []).map((o) => ({ ...o, root: ownRoot(o) })).filter((o) => o.root && o.root !== main);
  const owner = others.filter((o) => isUnder(P, o.root)).sort((a, b) => b.root.length - a.root.length)[0] || null;
  const own = normPath(ctx.own);
  const inMainCheckout = (q) => isUnder(q, main) && !isUnder(q, wts);
  // 1. Own root (the main checkout means main minus .claude/worktrees/**); a deeper lane's worktree inside it is not own.
  const underOwn = own === main ? inMainCheckout(P) : isUnder(P, own);
  if (underOwn && !(owner && owner.root.length > own.length)) return { allow: true };
  // 2. Config, temp, <main>/.superpowers, an unowned <main>/.claude/worktrees/<x>.
  if ([ctx.config, ctx.tmp, `${main}/.superpowers`].some((r) => r && isUnder(P, normPath(r)))) return { allow: true };
  if (isUnder(P, wts) && !owner) return { allow: true };
  // 3. Another open entry's worktree of this repo, wherever it lives; the main checkout for a session not on it.
  if (owner) return { allow: false, owner, mainCheckout: false };
  if (own !== main && inMainCheckout(P)) {
    const s = mainSessionOf(ctx.others, main);
    return { allow: false, owner: s ? { name: s.name, branch: s.branch } : null, mainCheckout: true };
  }
  // 4. Everything else: other repos, files outside any checkout.
  return { allow: true };
}
export function fenceText({ p, own, owner, mainCheckout, launchMjs, ownName }) {
  const q = `node ${launchMjs} queue`;
  if (mainCheckout && !owner) return `Write fence: ${p} belongs to the main checkout (no session): tell the user, or queue it --after-merge in your group `
    + `(${q} --to ${ownName} --after-merge --text "<what to change>"). It does not belong to this lane (${own}): do not edit it from here.`;
  const who = mainCheckout ? `the main checkout (lane ${owner.name}, ${owner.branch})` : `lane ${owner.name} (${owner.branch})`;
  return `Write fence: ${p} belongs to ${who}, not to this lane (${own}). Do not edit it from here. `
    + `Queue the change: ${q} --to ${owner.name} --text "<what to change>" [--after-merge], or tell the user.`;
}

// ---------- Part 5: the lane note ----------
// me: {name, branch, own, priority}; others: [{name, branch, scope}]
export function laneNoteText(me, others) {
  const list = others.length ? `Other live lanes in this repo: ${others.map((o) => `${o.name} (${o.branch}${o.scope ? `, ${o.scope}` : ""})`).join("; ")}.`
    : "No other live lanes in this repo.";
  return `Lane note: you are lane ${me.name} (branch ${me.branch}, ${me.own}, priority ${me.priority}). ${list}`
    + (others.length ? " A request meant for another lane: say it belongs to that lane and offer launch.mjs queue --to <lane>. Work on files another live lane is changing: queue it with --after-merge." : "");
}
export const textHash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
// lanes.json lanes (or the registry fallback) of one repo minus the session's own lane (same id, or same repo + branch).
export const otherLanes = (lanes, me) => (lanes || []).filter((l) => l && l.id !== me.id && !(l.branch === me.branch && normPath(l.worktree) === normPath(me.worktree)));
// The registry fallback: open entries of repo, newest per lane (repo + branch), no liveness filter.
export function openLanes(entries, closed, repo) {
  const m = new Map();
  for (const e of entries) if (e.repo === repo && !closed.has(e.id)) { const k = e.branch; if (!m.has(k) || ts(m.get(k)) <= ts(e)) m.set(k, e); }
  return [...m.values()];
}

// ---------- Part 1: the scope of a launch ----------
// The handoff's first `# ` heading, trimmed to 80 characters; null without one.
export function scopeOf(text) {
  const m = /^# +(.+?)\s*$/m.exec(String(text ?? ""));
  return m ? m[1].slice(0, 80) : null;
}

// ---------- Part 6: the inbox ----------
export const inboxBlock = (at, from, text) => `## ${at} from ${from}\n\n${String(text).trim()}\n\n`;
export const inboxItems = (text) => (String(text ?? "").match(/^## \d{4}-\d\d-\d\dT\S+ from .*$/gm) || []).length;
export const INBOX_SENTENCE = (p) => ` Read your inbox first: ${p} - items other lanes queued for you.`;
export const takenName = (lane, stamp) => `${lane}.${stamp}.taken.md`;
```


- [ ] **Step 4: Run it to verify it passes**

Run: `node --test claude/skills/handoff-launch/tests/lane-lib.test.mjs`
Expected: `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/lane-lib.mjs claude/skills/handoff-launch/tests/lane-lib.test.mjs
git commit -m "lane-lib: provenance chains, restart guard, occupancy, priority, fence decision, lane note and inbox texts"
```

---

### Task 3: `recover-lib.mjs`: background tasks, windows whose claude is gone, the reaper signature, the tab set, checklists

**Files:**
- Modify: `claude/skills/handoff-launch/recover-lib.mjs` (`DEFAULTS` `:9-10`, `freshLaunchArgs` `:285-295`,
  `closeDecision` `:298-315`, new sections at the end)
- Modify: `claude/skills/handoff-launch/recover.mjs:569-572` (one-word bridge: the renamed `closeDecision` parameter;
  Task 5 replaces these lines)
- Test: `claude/skills/handoff-launch/tests/hygiene-lib.test.mjs` (new), `tests/recover-lib.test.mjs` (`closeDecision`)

**Interfaces:**
- Consumes: nothing new.
- Produces (all pure):
  - config keys `bg_task_max_min`, `dead_close_min`, `goal_missing_calls`, `goal_stale_min`, `goal_stale_changes`;
  - `closeDecision({state, waitingSince, emptyHost, now, cfg, reason, launchedAt})` (`noClaude` renamed `emptyHost`:
    true only for an EMPTY host);
  - `freshLaunchArgs(e, {model, effort, recovery, priority?, supersedes?})` (`--priority`, `--supersedes` when given);
  - `taskStart(record) -> {id, kind, timeoutMs}|null`, `taskEnds(record) -> [id]`,
    `openBgTasks(files, {sinceMs, nowMs, cfg}) -> [{id, kind, at}]` (probe 4 shapes);
  - `goneCandidate({launchedAt, lastAt, hasTranscript, now, cfg}) -> bool` (bound as `launchOld && (quiet || !transcript)`),
    `goneKind(entries, launchedAtMs) -> "dead-start"|"exited"`, `restartOf(lines, e) -> {restart line}|null`,
    `DEAD_START_TEXT({name, branch, launchedAt, closeAt})`;
  - `isPlaywrightProc(p)`, `playwrightOrphans(procs)`, `staleProfileDirs(dirs, procs, now)`;
  - `tabIdsIn(v)`, `chromeTabs(prev, {tool, input, response}) -> [id]`, `isChromeTool(tool)`, `CHROME_TABS_TEXT(n)`;
  - `parseGoal(text) -> {goal, items, done, open, blocked}`, `goalNote(g, mtimeMs, now)`, `GOAL_MISSING_TEXT(path)`,
    `GOAL_STALE_TEXT(min)`, `WORK_TOOLS`, `goalSteps(state, {agentId, tool}, {goal, goalPath, now, cfg}) -> {state, context}`.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/hygiene-lib.test.mjs`:

```js
// Batch A's pure decisions in recover-lib.mjs: background tasks (Part 2), windows whose claude is gone (Part 3), the
// Playwright reaper and the claude-in-chrome tab set (Part 8), checklists (Part 9). Record shapes copied from real
// transcripts (Claude Code 2.1.289, plan Task 1 probe 4).
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../recover-lib.mjs";

const MIN = 60000, cfg = R.DEFAULTS, t0 = Date.parse("2026-10-05T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const shellStart = (id, at) => ({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}` }] },
  toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: id } });
const monitorStart = (id, at, timeoutMs) => ({ type: "user", timestamp: iso(at), toolUseResult: { taskId: id, timeoutMs, persistent: false } });
const note = (id, inner) => `<task-notification>\n<task-id>${id}</task-id>\n<output-file>C:/t/${id}.output</output-file>\n${inner}\n</task-notification>`;
const enqueue = (id, at, inner = "<status>completed</status>\n<summary>Background command completed</summary>") => ({ type: "queue-operation", operation: "enqueue", timestamp: iso(at), content: note(id, inner) });
const attach = (id, at) => ({ type: "attachment", timestamp: iso(at), attachment: { type: "queued_command", prompt: note(id, "<status>completed</status>"), commandMode: "task-notification" } });
const remove = (id, at) => ({ type: "queue-operation", operation: "remove", timestamp: iso(at), content: note(id, "<status>completed</status>") });
const stopped = (id, at) => ({ type: "user", timestamp: iso(at), toolUseResult: { message: `Successfully stopped task: ${id} (node -e setTimeout)`, task_id: id, task_type: "local_bash" } });
const open = (files, o = {}) => R.openBgTasks(files, { sinceMs: t0, nowMs: t0 + 30 * MIN, cfg, ...o }).map((t) => t.id);

test("config: batch A's keys and their defaults", () => {
  assert.deepEqual([cfg.bg_task_max_min, cfg.dead_close_min, cfg.goal_missing_calls, cfg.goal_stale_min, cfg.goal_stale_changes], [240, 60, 10, 40, 5]);
  assert.equal(R.loadConfig('{"dead_close_min": 30}').config.dead_close_min, 30);
});

test("openBgTasks: a started shell task is open until its notification, TaskStop or the safety valve", () => {
  assert.deepEqual(open([[shellStart("b1", t0 + MIN)]]), ["b1"]);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), enqueue("b1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), attach("b1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), { type: "user", timestamp: iso(t0 + 2 * MIN), message: { role: "user", content: note("b1", "<status>failed</status>") } }]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), stopped("b1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), remove("b1", t0 + 2 * MIN)]]), ["b1"]);         // a remove record is no end
  assert.deepEqual(open([[shellStart("b1", t0 - MIN)]]), []);                                            // before the launch line: an earlier process
  assert.deepEqual(open([[shellStart("b1", t0 + MIN)]], { nowMs: t0 + MIN + 240 * MIN }), []);           // the safety valve
  assert.deepEqual(open([[shellStart("b1", t0 + MIN)]], { nowMs: t0 + MIN + 239 * MIN }), ["b1"]);
});

test("openBgTasks: Monitor events are no ends; an expired Monitor or its timeout + 5 min is; a subagent's task ends in the main file", () => {
  const m = monitorStart("m1", t0 + MIN, 10 * MIN);
  assert.deepEqual(open([[m, enqueue("m1", t0 + 2 * MIN, "<event>line 1</event>")]], { nowMs: t0 + 5 * MIN }), ["m1"]);
  assert.deepEqual(open([[m, enqueue("m1", t0 + 2 * MIN, "<event>[Monitor expired after 10m]</event>")]], { nowMs: t0 + 5 * MIN }), []);
  assert.deepEqual(open([[m]], { nowMs: t0 + MIN + 15 * MIN }), []);                                    // timeoutMs + 5 min passed
  assert.deepEqual(open([[m]], { nowMs: t0 + MIN + 14 * MIN }), ["m1"]);
  // A subagent starts the task; the notification arrives in the main transcript.
  assert.deepEqual(open([[enqueue("s1", t0 + 9 * MIN)], [shellStart("s1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[], [shellStart("s1", t0 + 2 * MIN)]]), ["s1"]);
});

test("Part 3: the candidate test (launchOld && (quiet || !transcript)), the kind, and the coordinator-restart match", () => {
  const c = (o) => R.goneCandidate({ launchedAt: iso(t0), lastAt: t0 + MIN, hasTranscript: true, now: t0 + 20 * MIN, cfg, ...o });
  assert.equal(c({}), true);
  assert.equal(c({ now: t0 + 9 * MIN, lastAt: t0 }), false);                    // launched under idle_close_min ago
  assert.equal(c({ lastAt: t0 + 15 * MIN }), false);                           // the transcript is not quiet
  assert.equal(c({ hasTranscript: false, lastAt: NaN }), true);                 // no transcript
  assert.equal(c({ hasTranscript: false, now: t0 + 5 * MIN }), false);
  const meta = [{ type: "mode", timestamp: iso(t0 + 1000) }, { type: "system", subtype: "bridge-session", timestamp: iso(t0 + 2000) }];
  assert.equal(R.goneKind(meta, t0), "dead-start");
  assert.equal(R.goneKind(null, t0), "dead-start");
  assert.equal(R.goneKind([...meta, { type: "assistant", timestamp: iso(t0 - MIN) }], t0), "dead-start"); // an older process's record
  assert.equal(R.goneKind([...meta, { type: "assistant", timestamp: iso(t0 + MIN) }], t0), "exited");
  const L = (o) => ({ name: "A", launched_at: iso(t0), ...o });
  const a1 = L({ id: "A@1" }), a2 = L({ id: "A@2" }), a3 = L({ id: "A@3" });
  const rs = { restart: "A", n: 1, kind: "fresh", from: "A@1", at: iso(t0) };
  const lines = [a1, { kill_intent: "A@1" }, { closed: "A", id: "A@1" }, { starting: null, name: "A" }, a2, rs, { lane_blocked: "A" }, a3, { lane_resumed: "A" }];
  assert.equal(R.restartOf(lines, a2), rs);       // the launch line the tick's {restart} followed
  assert.equal(R.restartOf(lines, a1), null);
  assert.equal(R.restartOf(lines, a3), null);     // a later `launch.mjs resume` relaunch is not a coordinator restart
  assert.equal(R.restartOf([a2, { restart: "B", from: "B@1" }], a2), null);
  assert.match(R.DEAD_START_TEXT({ name: "A", branch: "lane-a", launchedAt: t0, closeAt: t0 + 70 * MIN }),
    /^DEAD START: A \(lane-a\): its window is open but claude exited right after the launch at 2026-10-05 10:00 UTC\. Read the error in that window, fix it, relaunch\. The coordinator closes the window at 2026-10-05 11:10 UTC\.$/);
});

test("the Playwright reaper: only orphans with Playwright's signature; live-parent chains, other Playwright browsers and the user's Chrome are kept", () => {
  const c = (h) => t0 - h * 3600e3;
  const procs = [
    { pid: 10, ppid: 1, name: "claude.exe", created: c(5), cmd: "claude" },
    // the npx chain of a live session: claude -> cmd -> npx node -> cmd -> cli node -> chrome
    { pid: 11, ppid: 10, name: "cmd.exe", created: c(4), cmd: "C:\\WINDOWS\\system32\\cmd.exe /d /s /c npx @playwright/mcp@latest" },
    { pid: 12, ppid: 11, name: "node.exe", created: c(4), cmd: "node npx-cli.js @playwright/mcp@latest" },
    { pid: 13, ppid: 12, name: "node.exe", created: c(4), cmd: "node C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\x\\node_modules\\@playwright\\mcp\\cli.js" },
    { pid: 14, ppid: 13, name: "chrome.exe", created: c(3), cmd: "chrome.exe --headless --user-data-dir=C:\\Users\\u\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-AbC123 --remote-debugging-pipe --no-startup-window" },
    // the same chain whose claude is gone: its top is an orphan
    { pid: 21, ppid: 999, name: "cmd.exe", created: c(4), cmd: "cmd.exe /d /s /c npx @playwright/mcp@latest" },
    { pid: 22, ppid: 21, name: "node.exe", created: c(4), cmd: "node npx-cli.js @playwright/mcp@latest" },
    // a pinned direct server whose claude is gone, and its browser
    { pid: 31, ppid: 998, name: "node.exe", created: c(2), cmd: "node C:/Users/u/.claude/mcp-servers/node_modules/@playwright/mcp/cli.js --isolated --headless" },
    { pid: 32, ppid: 31, name: "chrome.exe", created: c(2), cmd: "chrome.exe --user-data-dir=C:\\T\\playwright_chromiumdev_profile-x --remote-debugging-pipe" },
    // a browser whose server died (parent gone)
    { pid: 41, ppid: 997, name: "chrome.exe", created: c(2), cmd: "\"chrome.exe\" --remote-debugging-pipe --user-data-dir=\"C:\\Users\\u\\AppData\\Local\\ms-playwright-mcp\\mcp-chrome-1a2b\"" },
    // `npx playwright test` from a live terminal: same flags, live parent - kept
    { pid: 50, ppid: 1, name: "node.exe", created: c(1), cmd: "node playwright test" },
    { pid: 51, ppid: 50, name: "chrome.exe", created: c(1), cmd: "chrome.exe --remote-debugging-pipe --user-data-dir=C:\\T\\playwright_chromiumdev_profile-y" },
    // the user's own Chrome and Brave, parents gone: neither flag - kept
    { pid: 60, ppid: 996, name: "chrome.exe", created: c(9), cmd: "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"" },
    { pid: 61, ppid: 995, name: "brave.exe", created: c(9), cmd: "brave.exe --remote-debugging-pipe" },
    // a pid-reused parent created after its child: an orphan
    { pid: 70, ppid: 71, name: "node.exe", created: c(3), cmd: "node .../@playwright/mcp/cli.js" },
    { pid: 71, ppid: 1, name: "notepad.exe", created: c(1), cmd: "notepad" },
  ];
  assert.deepEqual(R.playwrightOrphans(procs).map((p) => p.pid), [21, 31, 41, 70]);
  assert.equal(R.isPlaywrightProc(procs[13]), false);
  assert.deepEqual(R.playwrightOrphans(null), []);
});

test("stale --isolated profile dirs: older than 24 h and named by no running command line", () => {
  const T = "C:/Users/u/AppData/Local/Temp";
  const dirs = [{ path: `${T}/playwright_chromiumdev_profile-old`, mtimeMs: t0 - 30 * 3600e3 }, { path: `${T}/playwright_chromiumdev_profile-used`, mtimeMs: t0 - 30 * 3600e3 },
    { path: `${T}/playwright_chromiumdev_profile-new`, mtimeMs: t0 - 3600e3 }];
  const procs = [{ pid: 1, cmd: "chrome.exe --user-data-dir=C:\\Users\\u\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-used --remote-debugging-pipe" }];
  assert.deepEqual(R.staleProfileDirs(dirs, procs, t0).map((d) => d.path), [`${T}/playwright_chromiumdev_profile-old`]);
});

test("the claude-in-chrome tab set: ids from tabs_context_mcp / tabs_create_mcp results, minus tabs_close_mcp inputs; garbage adds nothing", () => {
  const ctx = { content: [{ type: "text", text: JSON.stringify({ availableTabs: [{ tabId: 101, title: "New Tab", url: "chrome://newtab/" }, { tabId: 102, title: "x", url: "http://127.0.0.1/" }], tabGroupId: 7 }) }] };
  let s = R.chromeTabs([], { tool: "mcp__claude-in-chrome__tabs_context_mcp", input: { createIfEmpty: true }, response: ctx });
  assert.deepEqual(s, [101, 102]);
  s = R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_create_mcp", input: {}, response: [{ type: "text", text: '{"tabId":103,"url":"about:blank"}' }] });
  assert.deepEqual(s, [101, 102, 103]);
  s = R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_close_mcp", input: { tabId: 102 }, response: "ok" });
  s = R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_close_mcp", input: { tabIds: [101] }, response: "ok" });
  assert.deepEqual(s, [103]);
  assert.deepEqual(R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_context_mcp", response: "Tab 5 is not in Claude's tab group {oops" }), [103]);
  assert.deepEqual(R.chromeTabs("bad", { tool: "Read", response: ctx }), []);
  assert.equal(R.isChromeTool("mcp__claude-in-chrome__navigate"), true);
  assert.equal(R.isChromeTool("mcp__playwright__browser_navigate"), false);
  assert.equal(R.CHROME_TABS_TEXT(2), "You left 2 claude-in-chrome tab(s) open: close them with tabs_close_mcp (only the ones this session opened).");
});

test("parseGoal and goalNote", () => {
  const g = R.parseGoal("# Ship batch A\n\n- [x] spec — evidence: 9b46f93\n- [ ] plan\n* [X] probes\n  - [!] deploy — reason: needs the user's OK\n- not an item\n");
  assert.deepEqual([g.goal, g.items.length, g.done, g.open, g.blocked], ["Ship batch A", 4, 2, 1, 1]);
  assert.equal(g.items[3].reason, "needs the user's OK");
  assert.equal(R.goalNote(g, t0 - 12 * MIN, t0), "goal 2/4 done, 1 blocked (reason: needs the user's OK), last ticked 12 min ago");
  assert.equal(R.goalNote(R.parseGoal("# g\n- [ ] a\n"), t0, t0), "goal 0/1 done, last ticked 0 min ago");
  assert.equal(R.goalNote(null, 0, t0), "no GOAL.md");
});

test("goalSteps: the missing line once after goal_missing_calls main calls; the stale line once per window, re-armed by a write", () => {
  let s = {}, r;
  const call = (o = {}, goal = null) => { r = R.goalSteps(s, { agentId: null, tool: "Read", ...o }, { goal, goalPath: "C:/t/GOAL.md", now: o.now ?? t0, cfg }); s = r.state; return r.context; };
  for (let i = 0; i < 9; i++) assert.equal(call(), null);
  assert.equal(call({ agentId: "ag1" }), null);                       // a subagent's call is not counted and never speaks
  assert.equal(call(), R.GOAL_MISSING_TEXT("C:/t/GOAL.md"));
  assert.equal(call(), null);                                         // once per session
  const goal = { mtimeMs: t0 - 50 * MIN, open: 2 };
  for (let i = 0; i < 4; i++) assert.equal(call({ tool: "Edit" }, goal), null);
  assert.equal(call({ tool: "Bash", agentId: "ag1" }, goal), null);   // a subagent's work counts, but only the main thread speaks
  assert.equal(call({ tool: "Read" }, goal), R.GOAL_STALE_TEXT(50));
  assert.equal(call({ tool: "Edit" }, goal), null);                   // one line per window
  const written = { mtimeMs: t0 - 41 * MIN, open: 2 };                // a GOAL.md write re-arms it
  for (let i = 0; i < 4; i++) assert.equal(call({ tool: "Write" }, written), null);
  assert.equal(call({ tool: "PowerShell" }, written), R.GOAL_STALE_TEXT(41));
  s = {}; assert.equal(call({ tool: "Edit" }, { mtimeMs: t0 - 90 * MIN, open: 0 }), null); // no open items: never stale
  for (let i = 0; i < 6; i++) call({ tool: "Edit" }, { mtimeMs: t0 - 90 * MIN, open: 0 });
  assert.equal(s.goal_stale_said, false);
});
```

**Replace** in `claude/skills/handoff-launch/tests/recover-lib.test.mjs`:

```js
test("closeDecision: idle long enough and not waiting closes; busy, waiting, young, a young window without a transcript or background agents unknown does not", () => {
  const st = (o) => ({ found: true, idle: true, busy: [], last: iso(t0), bgKnown: true, ...o });
  const d = (o) => R.closeDecision({ state: st({}), waitingSince: null, noClaude: null, now: t0 + 20 * MIN, cfg, reason: "superseded by generation 2", ...o });
  assert.deepEqual(d({}), { close: true, why: "superseded by generation 2: idle 20 min" });
  // Only a turn that ended with the CLI's turn_duration record says no background agents are pending (sessionState's bgKnown).
  assert.deepEqual(d({ state: st({ bgKnown: false }) }), { close: false, why: "pending background agents unknown (the turn ended without a turn_duration record)" });
  assert.equal(d({ state: st({ bgKnown: undefined }) }).close, false);
  assert.equal(d({ state: st({ idle: false, busy: ["1 tool call(s) outstanding"] }) }).close, false);
  assert.equal(d({ waitingSince: iso(t0) }).close, false);
  assert.equal(d({ now: t0 + 5 * MIN }).close, false);
  // No transcript: no idle measure, so the launch must be idle_close_min old (a window whose claude has not started yet is kept).
  assert.deepEqual(d({ state: { found: false }, noClaude: true, launchedAt: iso(t0) }), { close: true, why: "superseded by generation 2: no claude running in the window" });
  assert.deepEqual(d({ state: { found: false }, noClaude: true, launchedAt: iso(t0 + 15 * MIN) }), { close: false, why: "no transcript, launched only 5 min ago" });
  assert.equal(d({ state: { found: false }, noClaude: true }).close, false); // no launch time: never a positive age
  assert.equal(d({ state: { found: false }, noClaude: null, launchedAt: iso(t0) }).close, false);
});

```

**with**:

```js
test("closeDecision: idle long enough and not waiting closes; busy, waiting, young, a young window without a transcript or background agents unknown does not", () => {
  const st = (o) => ({ found: true, idle: true, busy: [], last: iso(t0), bgKnown: true, ...o });
  const d = (o) => R.closeDecision({ state: st({}), waitingSince: null, emptyHost: null, now: t0 + 20 * MIN, cfg, reason: "superseded by generation 2", ...o });
  assert.deepEqual(d({}), { close: true, why: "superseded by generation 2: idle 20 min" });
  // Only a turn that ended with the CLI's turn_duration record says no background agents are pending (sessionState's bgKnown).
  assert.deepEqual(d({ state: st({ bgKnown: false }) }), { close: false, why: "pending background agents unknown (the turn ended without a turn_duration record)" });
  assert.equal(d({ state: st({ bgKnown: undefined }) }).close, false);
  assert.equal(d({ state: st({ idle: false, busy: ["1 tool call(s) outstanding"] }) }).close, false);
  assert.equal(d({ waitingSince: iso(t0) }).close, false);
  assert.equal(d({ now: t0 + 5 * MIN }).close, false);
  // No transcript: no idle measure, so the launch must be idle_close_min old (a window whose claude has not started yet is kept).
  assert.deepEqual(d({ state: { found: false }, emptyHost: true, launchedAt: iso(t0) }), { close: true, why: "superseded by generation 2: no claude running in the window" });
  assert.deepEqual(d({ state: { found: false }, emptyHost: true, launchedAt: iso(t0 + 15 * MIN) }), { close: false, why: "no transcript, launched only 5 min ago" });
  assert.equal(d({ state: { found: false }, emptyHost: true }).close, false); // no launch time: never a positive age
  assert.equal(d({ state: { found: false }, emptyHost: null, launchedAt: iso(t0) }).close, false);
  // Batch A: the no-transcript close needs an EMPTY host - a job the user runs in the window after claude exited keeps it.
  assert.deepEqual(d({ state: { found: false }, emptyHost: false, launchedAt: iso(t0) }), { close: false, why: "no transcript, but its window is not empty" });
});

```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/hygiene-lib.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: FAIL - `R.openBgTasks is not a function` (and the other new exports); the config test's `bg_task_max_min` is
`undefined`; `closeDecision`'s no-transcript case does not close (`emptyHost` is not read yet).

- [ ] **Step 3: Implement**

The `recover.mjs` edit only renames the argument (`emptyHost: noClaude`), so the tick keeps closing a transcript-less
superseded window whose host has no claude until Task 5 switches it to the empty-host probe.

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

```js
export const MIN = 60000;
export const DEFAULTS = Object.freeze({ repeat_window: 20, repeat_count: 4, warn_streak: 3, stuck_min: 30, grace_min: 5,
  idle_close_min: 10, fresh_at_tokens: 400000, max_restarts: 2, tick_min: 5, alert_repeat_hours: 6 });
export const REARM_MS = 60 * MIN; // the same signature within this of a cancel resumes at the grace step
// Probe 4 (plan Task 1): RESUME_WORKS = false if `claude --resume` failed on a killed transcript. Background lanes
```

**with**:

```js
export const MIN = 60000;
export const DEFAULTS = Object.freeze({ repeat_window: 20, repeat_count: 4, warn_streak: 3, stuck_min: 30, grace_min: 5,
  idle_close_min: 10, fresh_at_tokens: 400000, max_restarts: 2, tick_min: 5, alert_repeat_hours: 6,
  // batch A: background tasks (Part 2), dead starts (Part 3), checklists (Part 9)
  bg_task_max_min: 240, dead_close_min: 60, goal_missing_calls: 10, goal_stale_min: 40, goal_stale_changes: 5 });
export const REARM_MS = 60 * MIN; // the same signature within this of a cancel resumes at the grace step
// Probe 4 (plan Task 1): RESUME_WORKS = false if `claude --resume` failed on a killed transcript. Background lanes
```

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

```js
// does) - a restart must not lose tools mid-task. Never --force for a lane: the session cap must be able to refuse a
// restart (the tick defers it); only a legacy <group>-merge session (cap-exempt) gets it, for its merge.lock.
export function freshLaunchArgs(e, { model, effort, recovery }) {
  const a = ["--repo", e.worktree, "--handoff", e.handoff, "--name", e.name];
  if (e.group) a.push("--group", e.group);
  if (e.worktree && e.repo && e.worktree.toLowerCase() !== e.repo) a.push("--worktree", e.branch);
  a.push("--profile", typeof e.profile === "string" && e.profile ? e.profile : "full");
  a.push("--model", model, "--effort", effort, "--mode", e.mode || "window", "--no-close", "--recovery", recovery);
  if (e.session_id) a.push("--goal-from", e.session_id);
  if (e.prompt_file) a.push("--prompt-file", e.prompt_file);
  if (e.group && e.name === `${e.group}-merge`) a.push("--force"); // a legacy merge session: its merge.lock exists
  return a;
}

// ---------- closes, modes, blocked lanes, alerts ----------
// noClaude: true when no claude (or node) process runs below the window host, false when one does, null when the probe
// failed. A close needs positive answers: background agents unknown (state.bgKnown not true) keeps the window.
// launchedAt: the entry's launched_at. Without a transcript there is no idle measure, so the launch itself must be
// idle_close_min old: a window whose claude has not started yet has no transcript and no claude below it either.
export function closeDecision({ state, waitingSince, noClaude, now, cfg, reason, launchedAt }) {
  if (!state.found) {
    if (noClaude !== true) return { close: false, why: noClaude === null ? "no transcript and the process probe failed" : "no transcript, but claude is running" };
    const age = now - Date.parse(launchedAt);
    if (!(age >= cfg.idle_close_min * MIN)) return { close: false, why: Number.isFinite(age) ? `no transcript, launched only ${Math.round(age / MIN)} min ago` : "no transcript and no launch time" };
```

**with**:

```js
// does) - a restart must not lose tools mid-task. Never --force for a lane: the session cap must be able to refuse a
// restart (the tick defers it); only a legacy <group>-merge session (cap-exempt) gets it, for its merge.lock.
// Batch A: priority (the lane's effective priority: a restart is not a relay, so a hand-set priority survives) and
// supersedes (the entry this restart replaces) are passed when given.
export function freshLaunchArgs(e, { model, effort, recovery, priority = null, supersedes = null }) {
  const a = ["--repo", e.worktree, "--handoff", e.handoff, "--name", e.name];
  if (e.group) a.push("--group", e.group);
  if (e.worktree && e.repo && e.worktree.toLowerCase() !== e.repo) a.push("--worktree", e.branch);
  a.push("--profile", typeof e.profile === "string" && e.profile ? e.profile : "full");
  a.push("--model", model, "--effort", effort, "--mode", e.mode || "window", "--no-close", "--recovery", recovery);
  if (e.session_id) a.push("--goal-from", e.session_id);
  if (e.prompt_file) a.push("--prompt-file", e.prompt_file);
  if (priority) a.push("--priority", priority);
  if (supersedes) a.push("--supersedes", supersedes);
  if (e.group && e.name === `${e.group}-merge`) a.push("--force"); // a legacy merge session: its merge.lock exists
  return a;
}

// ---------- closes, modes, blocked lanes, alerts ----------
// emptyHost: true when nothing runs below the window host (conhost aside: live.mjs hostBelow), false when anything does
// (claude, or a job the user runs there after claude exited), null when the probe failed. A close needs positive
// answers: background agents unknown (state.bgKnown not true) keeps the window. launchedAt: the entry's launched_at.
// Without a transcript there is no idle measure, so the launch itself must be idle_close_min old: a window whose claude
// has not started yet has no transcript and an empty host too.
export function closeDecision({ state, waitingSince, emptyHost, now, cfg, reason, launchedAt }) {
  if (!state.found) {
    if (emptyHost !== true) return { close: false, why: emptyHost === null ? "no transcript and the process probe failed" : "no transcript, but its window is not empty" };
    const age = now - Date.parse(launchedAt);
    if (!(age >= cfg.idle_close_min * MIN)) return { close: false, why: Number.isFinite(age) ? `no transcript, launched only ${Math.round(age / MIN)} min ago` : "no transcript and no launch time" };
```

**Replace** in `claude/skills/handoff-launch/recover-lib.mjs`:

```js
  orphans: (list, total) => `Orphaned processes hold ${total} MB: ${list.map((o) => `${o.name} ${o.pid} ${o.mb} MB`).join(", ")}`,
};
```

**with**:

```js
  orphans: (list, total) => `Orphaned processes hold ${total} MB: ${list.map((o) => `${o.name} ${o.pid} ${o.mb} MB`).join(", ")}`,
};

// ---------- batch A, Part 2: background shell and Monitor tasks ----------
const NOTE_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
// Where a task notification arrives: a queue-operation enqueue's content, a queued command attachment's prompt
// ({attachment: {type: "queued_command", prompt, commandMode: "task-notification"}}, probe 4), or a user record's
// content. A `remove` queue record repeats its enqueue and is ignored.
function noteTexts(x) {
  if (x?.type === "queue-operation") return x.operation === "enqueue" && typeof x.content === "string" ? [x.content] : [];
  const out = [], a = x?.attachment, q = a?.type === "queued_command" ? a.prompt : a?.queued_command?.prompt;
  if (typeof q === "string") out.push(q);
  if (x?.type === "user") out.push(textOf(x));
  return out;
}
// A record that starts a task: a run_in_background Bash or PowerShell result (toolUseResult.backgroundTaskId), or a
// Monitor result (toolUseResult.taskId with timeoutMs). -> {id, kind, timeoutMs} or null
export function taskStart(x) {
  const r = x?.toolUseResult;
  if (!r || typeof r !== "object") return null;
  if (typeof r.backgroundTaskId === "string" && r.backgroundTaskId) return { id: r.backgroundTaskId, kind: "shell", timeoutMs: null };
  if (typeof r.taskId === "string" && r.taskId && Number.isFinite(r.timeoutMs)) return { id: r.taskId, kind: "monitor", timeoutMs: r.timeoutMs };
  return null;
}
// The task ids a record ends: a notification with a <status> tag, a Monitor event "[Monitor expired", or a TaskStop
// result ("Successfully stopped task" with task_id). Monitor events without <status> are not ends.
export function taskEnds(x) {
  const ids = [];
  for (const t of noteTexts(x)) for (const m of t.matchAll(NOTE_RE)) {
    const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(m[1])?.[1];
    if (id && (/<status>/.test(m[1]) || /<event>\s*\[Monitor expired/.test(m[1]))) ids.push(id);
  }
  const r = x?.toolUseResult;
  if (r && typeof r === "object" && typeof r.task_id === "string" && /^Successfully stopped task/.test(String(r.message ?? ""))) ids.push(r.task_id);
  return ids;
}
// The tasks still open in one session. files: record arrays (the main transcript's tail and the subagent files modified
// within bg_task_max_min); a subagent's task notifies in the main file, so ends match starts across files by id. A task
// started before sinceMs (the registry entry's launched_at) belonged to an earlier process and is ignored. Safety valve:
// a task with no end counts until bg_task_max_min after its start, a Monitor until its timeoutMs + 5 min if sooner.
// -> [{id, kind, at}]
export function openBgTasks(files, { sinceMs = 0, nowMs, cfg }) {
  const starts = new Map(), ended = new Set();
  for (const entries of files || []) for (const x of entries || []) {
    const s = taskStart(x), at = Date.parse(x?.timestamp);
    if (s && Number.isFinite(at) && at >= sinceMs && !starts.has(s.id)) starts.set(s.id, { ...s, at });
    for (const id of taskEnds(x)) ended.add(id);
  }
  const max = cfg.bg_task_max_min * MIN;
  return [...starts.values()].filter((t) => !ended.has(t.id)
    && nowMs < (t.kind === "monitor" ? Math.min(t.at + max, t.at + t.timeoutMs + 5 * MIN) : t.at + max)).map(({ id, kind, at }) => ({ id, kind, at }));
}

// ---------- batch A, Part 3: windows whose claude is gone (dead start, exited) ----------
// Bound as the plan says: launchOld && (quiet || !transcript). Only such windows get the host probe.
export function goneCandidate({ launchedAt, lastAt, hasTranscript, now, cfg }) {
  const m = cfg.idle_close_min * MIN, launchOld = now - Date.parse(launchedAt) >= m;
  const quiet = hasTranscript && Number.isFinite(lastAt) && now - lastAt >= m;
  return launchOld && (quiet || !hasTranscript);
}
// dead-start: no assistant record stamped at or after the launch (no transcript counts too); exited: claude worked, then exited.
export const goneKind = (entries, launchedAtMs) => ((entries || []).some((x) => x?.type === "assistant" && Date.parse(x.timestamp) >= launchedAtMs) ? "exited" : "dead-start");
// The {restart} line that made e a coordinator restart, or null. The launcher writes its launch line, then the tick
// appends {restart} (from = the killed entry): so it is the first {restart} of e's name after e's launch line, before any
// other launch line or {lane_resumed} of that name (a `launch.mjs resume` relaunch is not a coordinator restart).
export function restartOf(lines, e) {
  const i = lines.findIndex((o) => o.id === e.id && o.launched_at);
  if (i < 0) return null;
  for (const o of lines.slice(i + 1)) {
    if ((o.name === e.name && o.launched_at) || o.lane_resumed === e.name) return null;
    if (o.restart === e.name && o.from !== e.id) return o;
  }
  return null;
}
const utc = (t) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
export const DEAD_START_TEXT = ({ name, branch, launchedAt, closeAt }) => `DEAD START: ${name} (${branch}): its window is open but claude exited right after the launch at ${utc(launchedAt)}. `
  + `Read the error in that window, fix it, relaunch. The coordinator closes the window at ${utc(closeAt)}.`;

// ---------- batch A, Part 8: the Playwright orphan reaper and the claude-in-chrome tab set ----------
const PW_BROWSER = /^(chrome|chromium|msedge)(\.exe)?$/i, PW_SERVER = /^(node|cmd)(\.exe)?$/i;
// Playwright's signature, never ancestor names: a browser with --remote-debugging-pipe and a Playwright --user-data-dir
// (a playwright_*dev_profile-* temp dir, or a dir under ms-playwright-mcp), or a node/cmd naming @playwright/mcp.
export function isPlaywrightProc(p) {
  const cmd = String(p?.cmd ?? ""), name = String(p?.name ?? "");
  if (PW_BROWSER.test(name)) return /--remote-debugging-pipe/.test(cmd) && /--user-data-dir=?"?[^"]*?(playwright_\w*dev_profile-|ms-playwright-mcp)/i.test(cmd);
  return PW_SERVER.test(name) && /@playwright[\\/]mcp/i.test(cmd);
}
// The orphan rule of orphans() (the direct parent is gone, or was created after the child), restricted to that signature.
// A browser of `npx playwright test`, a script or an IDE has the same flags but a live parent: never touched.
export function playwrightOrphans(procs) {
  const list = Array.isArray(procs) ? procs.filter((p) => p && Number.isFinite(p.pid)) : [];
  const byPid = new Map(list.map((p) => [p.pid, p]));
  return list.filter((p) => {
    if (!isPlaywrightProc(p)) return false;
    const parent = byPid.get(p.ppid);
    return !parent || (Number.isFinite(parent.created) && Number.isFinite(p.created) && parent.created > p.created);
  });
}
// `--isolated` leaves its playwright_*dev_profile-* dirs in the temp dir (probe 7). dirs: [{path, mtimeMs}]. -> the
// ones older than 24 h whose path no running process's command line names.
export function staleProfileDirs(dirs, procs, now) {
  const cmds = (Array.isArray(procs) ? procs : []).map((p) => String(p?.cmd ?? "").replace(/\\/g, "/").toLowerCase());
  return (dirs || []).filter((d) => now - d.mtimeMs > 24 * 60 * MIN && !cmds.some((c) => c.includes(String(d.path).replace(/\\/g, "/").toLowerCase())));
}
// Tab ids in a value: every numeric tabId (and tabIds entry), also inside JSON text (probe 8: a tabs_context_mcp result's
// content[0].text is {"availableTabs":[{"tabId":N,...}],"tabGroupId":G}). Anything unparseable adds nothing.
export function tabIdsIn(v, depth = 0) {
  const out = [];
  if (depth > 6 || v == null) return out;
  if (typeof v === "string") { const t = v.trim(); if (/^[[{]/.test(t)) { try { out.push(...tabIdsIn(JSON.parse(t), depth + 1)); } catch {} } return out; }
  if (Array.isArray(v)) { for (const x of v) out.push(...tabIdsIn(x, depth + 1)); return out; }
  if (typeof v === "object") for (const [k, x] of Object.entries(v)) {
    if (k === "tabId" && Number.isInteger(x)) out.push(x);
    else if (k === "tabIds" && Array.isArray(x)) out.push(...x.filter(Number.isInteger));
    else out.push(...tabIdsIn(x, depth + 1));
  }
  return out;
}
// The session's claude-in-chrome tab set: + every id in a tabs_context_mcp / tabs_create_mcp result, - every id in a
// tabs_close_mcp input (tabId or tabIds). -> the new set (an array)
export function chromeTabs(prev, { tool, input, response }) {
  const set = new Set(Array.isArray(prev) ? prev.filter(Number.isInteger) : []);
  const m = /^mcp__claude-in-chrome__(\w+)$/.exec(String(tool ?? ""));
  if (m?.[1] === "tabs_context_mcp" || m?.[1] === "tabs_create_mcp") for (const id of tabIdsIn(response)) set.add(id);
  else if (m?.[1] === "tabs_close_mcp") for (const id of tabIdsIn(input)) set.delete(id);
  return [...set];
}
export const isChromeTool = (tool) => /^mcp__claude-in-chrome__/.test(String(tool ?? ""));
export const CHROME_TABS_TEXT = (n) => `You left ${n} claude-in-chrome tab(s) open: close them with tabs_close_mcp (only the ones this session opened).`;

// ---------- batch A, Part 9: a checklist in every session ----------
// The goal is the first `# ` line; items are `- [x]`, `- [ ]`, `- [!]` lines (as goal-gate reads them); a [!] item's text
// after `reason:` is its reason.
export function parseGoal(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const goal = lines.find((l) => /^# /.test(l))?.slice(2).trim() ?? null;
  const items = lines.map((l) => /^\s*[-*]\s*\[( |x|X|!)\]\s*(.*)$/.exec(l)).filter(Boolean).map((m) => ({
    state: m[1] === " " ? "open" : m[1] === "!" ? "blocked" : "done", text: m[2].trim(),
    reason: m[1] === "!" ? (/reason:\s*(.*)$/i.exec(m[2])?.[1].trim() || null) : null,
  }));
  const n = (s) => items.filter((i) => i.state === s).length;
  return { goal, items, done: n("done"), open: n("open"), blocked: n("blocked") };
}
// `goal 5/9 done, 1 blocked (reason: ...), last ticked 12 min ago`, or `no GOAL.md` (g null).
export function goalNote(g, mtimeMs, now) {
  if (!g) return "no GOAL.md";
  const reasons = g.items.filter((i) => i.state === "blocked").map((i) => i.reason || "none given");
  return `goal ${g.done}/${g.items.length} done${g.blocked ? `, ${g.blocked} blocked (reason: ${display(reasons.join("; "), 120)})` : ""}, last ticked ${Math.round((now - mtimeMs) / MIN)} min ago`;
}
export const GOAL_MISSING_TEXT = (p) => `No GOAL.md yet: write ${p} now (one goal line, then checkable items) and tick each item as it finishes, in the same message as your next tool call.`;
export const GOAL_STALE_TEXT = (n) => `GOAL.md has not changed for ${n} min while work went on: tick the finished items now, with evidence, in the same message as your next tool call (never as an extra round trip). If you drifted, return to the next unticked item, or rewrite GOAL.md if the user changed direction.`;
// Work calls for the staleness count (is_error is not read: the hook cannot see it reliably). Agent counts once it returns.
export const WORK_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task"]);
// The post-tool hook's checklist step (launcher sessions). ev: {agentId, tool}; goal: {mtimeMs, open} when GOAL.md
// exists, else null; goalPath: where to write it. Only a main-thread call speaks (a subagent never writes GOAL.md); a
// subagent's work calls still count as work. -> {state, context}
export function goalSteps(state, ev, { goal, goalPath, now, cfg }) {
  const s = { ...(state && typeof state === "object" ? state : {}) }, main = !ev.agentId;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  if (main) s.main_calls = num(s.main_calls) + 1;
  if (goal) {
    if (s.goal_mtime !== goal.mtimeMs) { s.goal_mtime = goal.mtimeMs; s.goal_changes = 0; s.goal_stale_said = false; } // a write re-arms
    if (WORK_TOOLS.has(ev.tool)) s.goal_changes = num(s.goal_changes) + 1;
    if (main && goal.open > 0 && !s.goal_stale_said && now - goal.mtimeMs >= cfg.goal_stale_min * MIN && s.goal_changes >= cfg.goal_stale_changes) {
      s.goal_stale_said = true;
      return { state: s, context: GOAL_STALE_TEXT(Math.round((now - goal.mtimeMs) / MIN)) };
    }
    return { state: s, context: null };
  }
  if (main && !s.goal_missing_said && s.main_calls >= cfg.goal_missing_calls) { s.goal_missing_said = true; return { state: s, context: GOAL_MISSING_TEXT(goalPath) }; }
  return { state: s, context: null };
}
```

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
      if (!hook && fs.existsSync(hf)) { out.push(`skip close of ${tag}: hook state unreadable`); continue; }
      const st = V.sessionState(e);
      // hasClaudeBelow answers whether claude runs in the window; closeDecision's noClaude is the opposite (null: unknown).
      const below = st.found ? null : V.hasClaudeBelow(V.readPidFile(e).host_pid), noClaude = below === null ? null : !below;
      const reason = superseded ? `superseded by generation ${k.newest.generation}` : "paused";
      const d = L.closeDecision({ state: st, waitingSince: hook?.waiting_since || null, noClaude, now, cfg, reason, launchedAt: e.launched_at });
      if (d.close) out.push(guardedClose(e, d.why, { dryRun })); // a kept window prints nothing: every tick would repeat it
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
```

**with**:

```js
      if (!hook && fs.existsSync(hf)) { out.push(`skip close of ${tag}: hook state unreadable`); continue; }
      const st = V.sessionState(e);
      // hasClaudeBelow answers whether claude runs in the window; closeDecision's emptyHost is the opposite (null: unknown).
      const below = st.found ? null : V.hasClaudeBelow(V.readPidFile(e).host_pid), noClaude = below === null ? null : !below;
      const reason = superseded ? `superseded by generation ${k.newest.generation}` : "paused";
      const d = L.closeDecision({ state: st, waitingSince: hook?.waiting_since || null, emptyHost: noClaude, now, cfg, reason, launchedAt: e.launched_at });
      if (d.close) out.push(guardedClose(e, d.why, { dryRun })); // a kept window prints nothing: every tick would repeat it
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/hygiene-lib.test.mjs claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/recover-lib.mjs claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/tests
git commit -m "recover-lib: background tasks, dead starts, the Playwright signature, the tab set, checklists; closeDecision needs an empty host"
```

---

### Task 4: `live.mjs`: the empty-host probe, background tasks in `sessionState`, the environment scrub; test hosts

**Files:**
- Modify: `claude/skills/handoff-launch/live.mjs` (imports `:17`, `readJson` `:33`, after `hasClaudeBelow` `:140`,
  `processList` `:141-157`, `sessionState` `:319-347`, `triggerTick` `:465`, before the window launcher `:470`)
- Modify: `claude/skills/handoff-launch/tests/helpers.mjs` (`sandbox` `:37`, `sessionLine` `:126`, `host` `:147-155`)
- Modify: `claude/skills/handoff-launch/tests/recover.test.mjs:7`, `:907` (B's window becomes an empty host)
- Test: `claude/skills/handoff-launch/tests/liveness.test.mjs` (three new tests)

**Interfaces:**
- Consumes: Task 3 `openBgTasks`, `loadConfig`.
- Produces: `coordConfig() -> cfg` (memoized); `belowScript(pid)`; `hostBelow(pid) -> {names, claude, empty} | null`;
  `processList()` items gain `cmd`; `sessionState(e)` gains `bgTasks: [id]` (scanned only when otherwise idle; busy
  `N background task(s) running`); `launcherEnv(extra?) -> env` without `HL_SESSION_ID` and `CLAUDE_CODE_SESSION_ID`;
  `triggerTick` spawns with it. Helpers: `host()` (a claude stand-in below the host; returns once it runs),
  `emptyHost()`, `jobHost()`, `hasPython()`; `sessionLine` passes `supersedes` (when given, `null` included),
  `launched_by`, `priority`, `scope`; the sandbox drops `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`.

- [ ] **Step 1: Write the failing tests**

The guarded-close test's window B models "claude exited" and now needs an empty host, because the default test host
runs a claude stand-in (Task 3's `closeDecision` closes a transcript-less window only when its host is empty).

**Replace** in `claude/skills/handoff-launch/tests/helpers.mjs`:

```js
  // Nor its profiles file: launches read the repo's profiles.json unless a test sets HL_PROFILES_JSON.
  const base = { ...process.env };
  for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG", "HL_PROFILES_JSON"]) delete base[k];
  const env = {
    ...base, ...GIT_ENV, HL_REGISTRY_DIR: reg, HL_AGENTS_JSON: path.join(tmp, "agents.json"),
```

**with**:

```js
  // Nor its profiles file: launches read the repo's profiles.json unless a test sets HL_PROFILES_JSON.
  const base = { ...process.env };
  // Nor the developer session's identity (batch A: a launch records launched_by from CLAUDE_CODE_SESSION_ID, and
  // goal-gate reads CLAUDE_CODE_ENTRYPOINT): a test sets them itself.
  for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG", "HL_PROFILES_JSON",
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID"]) delete base[k];
  const env = {
    ...base, ...GIT_ENV, HL_REGISTRY_DIR: reg, HL_AGENTS_JSON: path.join(tmp, "agents.json"),
```

**Replace** in `claude/skills/handoff-launch/tests/helpers.mjs`:

```js
    model: "model" in o ? o.model : "opus", effort: "effort" in o ? o.effort : "high", coord: "coord" in o ? o.coord : 1, prompt_file: o.prompt_file ?? null,
    profile: o.profile, // a lane profile (main's launch lines carry one); none = a line from before profiles
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
```

**with**:

```js
    model: "model" in o ? o.model : "opus", effort: "effort" in o ? o.effort : "high", coord: "coord" in o ? o.coord : 1, prompt_file: o.prompt_file ?? null,
    profile: o.profile, // a lane profile (main's launch lines carry one); none = a line from before profiles
    // batch A: a line without the supersedes key is a legacy line; pass supersedes (null included) for a new one.
    ...("supersedes" in o ? { supersedes: o.supersedes } : {}),
    launched_by: o.launched_by, priority: o.priority, scope: o.scope,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
```

**Replace** in `claude/skills/handoff-launch/tests/helpers.mjs`:

```js
export const setAgents = (sb, list) => fs.writeFileSync(path.join(sb.tmp, "agents.json"), JSON.stringify(list));
// A window-host stand-in (Windows): a real powershell process and its start time, as the pid file records them.
// command: what the host runs (default: a 300 s sleep). kill() goes through the child's process handle, never a pid
// lookup, so a pid reused after the host died is never touched.
export function host(command = "Start-Sleep 300") {
  const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore", windowsHide: true });
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${p.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8" });
  return { pid: p.pid, start: r.stdout.trim(), kill: () => { try { p.kill(); } catch {} } };
}
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
```

**with**:

```js
export const setAgents = (sb, list) => fs.writeFileSync(path.join(sb.tmp, "agents.json"), JSON.stringify(list));
// A window-host stand-in (Windows): a real powershell process and its start time, as the pid file records them.
// By default the host runs a claude stand-in (a node process, which hostBelow counts as claude) and host() returns once it
// runs: a live session's window is never empty (batch A, Part 3 closes windows whose host is empty). command: what the
// host runs instead (emptyHost: a plain sleep, nothing below it - a window whose claude exited). kill() ends the host's
// tree while the child handle says the host still runs, so a pid reused after the host died is never touched.
const STANDIN = path.join(os.tmpdir(), `hl-claude-standin-${process.pid}.cjs`);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
export function host(command) {
  let ready = null;
  if (command === undefined) {
    if (!fs.existsSync(STANDIN)) fs.writeFileSync(STANDIN, "const pp = process.ppid; require('fs').writeFileSync(process.argv[2], String(process.pid));\n"
      + "setInterval(() => { try { process.kill(pp, 0); } catch { process.exit(0); } }, 500); setTimeout(() => process.exit(0), 300000);\n");
    ready = path.join(os.tmpdir(), `hl-standin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ready`);
    command = `& ${psq(process.execPath)} ${psq(STANDIN)} ${psq(ready)}`;
  }
  const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore", windowsHide: true });
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${p.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8" });
  if (ready) { for (let i = 0; i < 150 && !fs.existsSync(ready); i++) sleepMs(100); fs.rmSync(ready, { force: true }); }
  const kill = () => {
    if (p.exitCode !== null || p.signalCode !== null) return;
    spawnSync("taskkill", ["/T", "/F", "/PID", String(p.pid)], { stdio: "ignore", windowsHide: true });
    try { p.kill(); } catch {}
  };
  return { pid: p.pid, start: r.stdout.trim(), kill };
}
// A window whose claude exited: nothing below the host.
export const emptyHost = () => host("Start-Sleep 300");
// A window whose claude exited and where the user then runs a job (python): kept by every close that needs an empty host.
export const jobHost = () => { const h = host("python -c 'import time; time.sleep(300)'"); sleepMs(1500); return h; };
export const hasPython = () => spawnSync("python", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
```

**Replace** in `claude/skills/handoff-launch/tests/liveness.test.mjs`:

```js
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, writeTranscript, tx, host, LAUNCH, coordRun } from "./helpers.mjs";
import { checkHost, matchNewAgent, listedAgent, windowScript, projectKey, claudeBelowScript, procInfo, probeWhy } from "../live.mjs";

test("the sandbox never inherits the developer session's coordinator env", () => {
```

**with**:

```js
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sandbox, sessionLine, writeTranscript, writeSubagent, tx, host, emptyHost, jobHost, hasPython, LAUNCH, coordRun } from "./helpers.mjs";
import { checkHost, matchNewAgent, listedAgent, windowScript, projectKey, claudeBelowScript, procInfo, probeWhy, hostBelow, launcherEnv } from "../live.mjs";

test("the sandbox never inherits the developer session's coordinator env", () => {
```

**Replace** in `claude/skills/handoff-launch/tests/liveness.test.mjs`:

```js
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});
```

**with**:

```js
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

// batch A, Part 2: sessionState in a child process with the sandbox env (live.mjs reads its dirs at import).
const LIVE_URL = pathToFileURL(path.join(import.meta.dirname, "..", "live.mjs")).href;
const stateOf = (sb, e) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e",
  `import { sessionState } from ${JSON.stringify(LIVE_URL)}; const s = sessionState(${JSON.stringify(e)}); process.stdout.write(JSON.stringify({ idle: s.idle, busy: s.busy, bgTasks: s.bgTasks }));`],
  { env: sb.env, encoding: "utf8" }).stdout);

test("sessionState: an otherwise idle session with an open background shell task is busy until the task ends; older tasks and ended ones never count", () => {
  const sb = sandbox();
  try {
    const t0 = Date.now() - 30 * 60000, iso = (ms) => new Date(ms).toISOString();
    const e = { id: "A@1", name: "A", session_id: "a-s1", mode: "window", launched_at: iso(t0) };
    const t = tx({ start: t0 }).user("go").call("Bash", { command: "x" }).say("waiting").turnDone().entries();
    const res = t.findIndex((o) => Array.isArray(o.message?.content) && o.message.content[0]?.type === "tool_result");
    t[res].toolUseResult = { backgroundTaskId: "b1" };
    const f = writeTranscript(sb, sb.repo, e.session_id, [{ type: "user", timestamp: iso(t0 - 60000), toolUseResult: { backgroundTaskId: "old" } }, ...t]);
    assert.deepEqual(stateOf(sb, e), { idle: false, busy: ["1 background task(s) running"], bgTasks: ["b1"] });
    // A subagent's task notifies in the main file: started there, ended here.
    writeSubagent(sb, sb.repo, e.session_id, "ag1", [{ type: "user", timestamp: iso(t0 + 5000), toolUseResult: { backgroundTaskId: "s1" } }]);
    assert.deepEqual(stateOf(sb, e).bgTasks, ["b1", "s1"]);
    fs.appendFileSync(f, [`{"type":"queue-operation","operation":"enqueue","timestamp":"${iso(t0 + 9000)}","content":"<task-notification><task-id>b1</task-id><status>completed</status></task-notification>"}`,
      `{"type":"user","timestamp":"${iso(t0 + 9500)}","toolUseResult":{"message":"Successfully stopped task: s1 (x)","task_id":"s1"}}`,
      `{"type":"assistant","timestamp":"${iso(t0 + 9600)}","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}`,
      `{"type":"system","subtype":"turn_duration","timestamp":"${iso(t0 + 9700)}"}`].join("\n") + "\n");
    assert.deepEqual(stateOf(sb, e), { idle: true, busy: [], bgTasks: [] });
  } finally { sb.cleanup(); }
});

test("hostBelow: a claude stand-in, an empty host (claude exited) and a user's job below it", { skip: process.platform !== "win32" }, () => {
  const hosts = [host(), emptyHost(), ...(hasPython() ? [jobHost()] : [])];
  try {
    assert.deepEqual(hostBelow(hosts[0].pid), { names: ["node.exe"], claude: true, empty: false });
    assert.deepEqual(hostBelow(hosts[1].pid), { names: [], claude: false, empty: true });
    if (hosts[2]) assert.deepEqual(hostBelow(hosts[2].pid), { names: ["python.exe"], claude: false, empty: false });
  } finally { for (const h of hosts) h.kill(); }
});

test("launcherEnv drops HL_SESSION_ID and CLAUDE_CODE_SESSION_ID and keeps the rest", () => {
  const saved = { a: process.env.HL_SESSION_ID, b: process.env.CLAUDE_CODE_SESSION_ID };
  try {
    process.env.HL_SESSION_ID = "X@1"; process.env.CLAUDE_CODE_SESSION_ID = "s-x";
    const env = launcherEnv({ EXTRA: "1" });
    assert.equal(env.HL_SESSION_ID, undefined); assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.EXTRA, "1"); assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
  } finally {
    if (saved.a === undefined) delete process.env.HL_SESSION_ID; else process.env.HL_SESSION_ID = saved.a;
    if (saved.b === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved.b;
  }
});
```

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

```js
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, sessionLine, appendLine, writeTranscript, writeSubagent, setAgents, coordRun, tx, host, alive } from "./helpers.mjs";
import { callKey, shortHash } from "../recover-lib.mjs";
import { hasClaudeBelow, psq, sleep } from "../live.mjs";
```

**with**:

```js
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, sessionLine, appendLine, writeTranscript, writeSubagent, setAgents, coordRun, tx, host, alive, emptyHost } from "./helpers.mjs";
import { callKey, shortHash } from "../recover-lib.mjs";
import { hasClaudeBelow, psq, sleep } from "../live.mjs";
```

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

```js
  const kid = path.join(sb.tmp, "kid.cjs");
  fs.writeFileSync(kid, "const pp = process.ppid; setInterval(() => { try { process.kill(pp, 0); } catch { process.exit(0); } }, 500); setTimeout(() => process.exit(0), 180000);\n");
  const hosts = [host(), host(), host(`& ${psq(process.execPath)} ${psq(kid)}`), host(), host(), host()];
  try {
    for (let i = 0; i < 40 && hasClaudeBelow(hosts[2].pid) !== true; i++) sleep(500);
```

**with**:

```js
  const kid = path.join(sb.tmp, "kid.cjs");
  fs.writeFileSync(kid, "const pp = process.ppid; setInterval(() => { try { process.kill(pp, 0); } catch { process.exit(0); } }, 500); setTimeout(() => process.exit(0), 180000);\n");
  // B's window is empty (batch A: only an empty host closes without a transcript); the others run a claude stand-in.
  const hosts = [host(), emptyHost(), host(`& ${psq(process.execPath)} ${psq(kid)}`), host(), host(), host()];
  try {
    for (let i = 0; i < 40 && hasClaudeBelow(hosts[2].pid) !== true; i++) sleep(500);
```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/liveness.test.mjs`
Expected: FAIL - `The requested module '../live.mjs' does not provide an export named 'hostBelow'`.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/live.mjs`:

```js
import { spawn, spawnSync } from "node:child_process";
import { fwd, stem } from "./merge-lib.mjs";
import { loadConfig, startsWithoutLaunch } from "./recover-lib.mjs";

export { stem };
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CFG = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
export const REG_DIR = path.resolve(process.env.HL_REGISTRY_DIR || HERE);
export const REG = path.join(REG_DIR, "sessions.jsonl");
export const PID_DIR = path.join(REG_DIR, "pids");
export const STOP_DIR = path.join(REG_DIR, "stops");
export const PROJECTS = path.resolve(process.env.HL_PROJECTS_DIR || path.join(CFG, "projects"));
export const COORD = path.join(CFG, "state", "coord");
export const MIN = 60000;
export const now = () => new Date().toISOString();
export const ago = (t) => Date.now() - Date.parse(t);
export const mins = (ms) => `${Math.round(ms / MIN)} min`;
export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const readJson = (f, d = null) => { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return v && typeof v === "object" ? v : d; } catch { return d; } };
// A claimed alert, alerts/claimed-<sid>-<ms>-<orig> (coord.mjs claims, sends and releases; the tick returns stale ones):
// -> [, sid, ms, orig]. The sid is a plain id ([\w-]); the lazy match takes the first 13-digit stamp after it, so digits
```

**with**:

```js
import { spawn, spawnSync } from "node:child_process";
import { fwd, stem } from "./merge-lib.mjs";
import { loadConfig, startsWithoutLaunch, openBgTasks } from "./recover-lib.mjs";

export { stem };
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CFG = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
export const REG_DIR = path.resolve(process.env.HL_REGISTRY_DIR || HERE);
export const REG = path.join(REG_DIR, "sessions.jsonl");
export const PID_DIR = path.join(REG_DIR, "pids");
export const STOP_DIR = path.join(REG_DIR, "stops");
export const PROJECTS = path.resolve(process.env.HL_PROJECTS_DIR || path.join(CFG, "projects"));
export const COORD = path.join(CFG, "state", "coord");
export const MIN = 60000;
export const now = () => new Date().toISOString();
export const ago = (t) => Date.now() - Date.parse(t);
export const mins = (ms) => `${Math.round(ms / MIN)} min`;
export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const readJson = (f, d = null) => { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return v && typeof v === "object" ? v : d; } catch { return d; } };
// <coord>/config.json through loadConfig (missing or invalid = the defaults), read once per process.
let cfgMemo;
export function coordConfig() {
  if (!cfgMemo) { let t = null; try { t = fs.readFileSync(path.join(COORD, "config.json"), "utf8"); } catch {} cfgMemo = loadConfig(t).config; }
  return cfgMemo;
}
// A claimed alert, alerts/claimed-<sid>-<ms>-<orig> (coord.mjs claims, sends and releases; the tick returns stale ones):
// -> [, sid, ms, orig]. The sid is a plain id ([\w-]); the lazy match takes the first 13-digit stamp after it, so digits
```

**Replace** in `claude/skills/handoff-launch/live.mjs`:

```js
  return t === "True" ? true : t === "False" ? false : (lastWhy = `unexpected probe output: ${t.slice(0, 80)}`, null);
}
// Every process, for the tick's orphan scan: [{pid, ppid, name, mb, created}] (mb: private bytes in MB; created: epoch
// ms or null). null = unknown: the probe failed, answered nothing, or this is not Windows. HL_FAKE_PROCS=<json file>
// stands in for the probe on any OS (tests); an unreadable or empty one is unknown too.
export function processList() {
  if (process.env.HL_FAKE_PROCS) { const v = readJson(process.env.HL_FAKE_PROCS, null); return Array.isArray(v) && v.length ? v : null; }
  if (process.platform !== "win32") return null;
  const script = psGuard(`$all=@(Get-CimInstance Win32_Process); if(-not $all.Count){ throw 'Get-CimInstance Win32_Process returned nothing' }; `
    + `foreach($p in $all){ $c=''; if($p.CreationDate){ $c=$p.CreationDate.ToUniversalTime().ToString('o') }; '{0}|{1}|{2}|{3}|{4}' -f $p.ProcessId,$p.ParentProcessId,$p.Name,$p.PrivatePageCount,$c }`);
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 10000);
  if (!r.ok) return null;
  const list = [];
  for (const l of r.out.split(/\r?\n/)) {
    const [pid, ppid, name, bytes, c] = l.trim().split("|");
    if (pid && name) list.push({ pid: Number(pid), ppid: Number(ppid), name, mb: Math.round(Number(bytes) / 1048576) || 0, created: Date.parse(c) || null });
  }
  return list.length ? list : null;
```

**with**:

```js
  return t === "True" ? true : t === "False" ? false : (lastWhy = `unexpected probe output: ${t.slice(0, 80)}`, null);
}
// The PowerShell script behind hostBelow: OK, then the name of every process below <pid> (any depth), one per line. A CIM
// error or an empty process list exits 1 (ERR). $seen guards against a cycle of reused pids.
export const belowScript = (pid) => psGuard(`$all=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name; `
  + `if(-not $all){ throw 'Get-CimInstance Win32_Process returned nothing' }; 'OK'; $q=@(${pid}); $seen=@{}; `
  + `while($q.Count){ $c=@($all | Where-Object { ($q -contains $_.ParentProcessId) -and -not $seen.ContainsKey($_.ProcessId) }); `
  + `foreach($x in $c){ $seen[$x.ProcessId]=1; $x.Name }; $q=@($c | ForEach-Object { $_.ProcessId }) }`);
// What runs below a window host: {names, claude, empty} - names: every descendant except conhost; claude: a claude or
// node process among them; empty: nothing at all (a dead start or a plain exit leaves an empty host; probe 5: under
// Windows Terminal not even conhost). null when the probe failed: never "empty".
export function hostBelow(pid) {
  // 20 s: a whole-table CIM query is slower than procInfo's Get-Process; a timeout is null (no action), never "empty".
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", belowScript(pid)], 20000);
  if (!r.ok) return null;
  const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "OK") { lastWhy = `unexpected probe output: ${lines.join(" ").slice(0, 80)}`; return null; }
  const names = lines.slice(1).filter((n) => !/^conhost(\.exe)?$/i.test(n));
  return { names, claude: names.some((n) => /^(claude|node)(\.exe)?$/i.test(n)), empty: names.length === 0 };
}
// Every process, for the tick's orphan scan and the Playwright reaper: [{pid, ppid, name, mb, created, cmd}] (mb: private
// bytes in MB; created: epoch ms or null; cmd: the command line, "" when unreadable). null = unknown: the probe failed, answered nothing, or this is not Windows. HL_FAKE_PROCS=<json file>
// stands in for the probe on any OS (tests); an unreadable or empty one is unknown too.
export function processList() {
  if (process.env.HL_FAKE_PROCS) { const v = readJson(process.env.HL_FAKE_PROCS, null); return Array.isArray(v) && v.length ? v : null; }
  if (process.platform !== "win32") return null;
  const script = psGuard(`$all=@(Get-CimInstance Win32_Process); if(-not $all.Count){ throw 'Get-CimInstance Win32_Process returned nothing' }; `
    + `foreach($p in $all){ $c=''; if($p.CreationDate){ $c=$p.CreationDate.ToUniversalTime().ToString('o') }; $l=([string]$p.CommandLine) -replace '[\\r\\n]+',' '; '{0}|{1}|{2}|{3}|{4}|{5}' -f $p.ProcessId,$p.ParentProcessId,$p.Name,$p.PrivatePageCount,$c,$l }`);
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 10000);
  if (!r.ok) return null;
  const list = [];
  for (const l of r.out.split(/\r?\n/)) {
    const [pid, ppid, name, bytes, c, ...cmd] = l.trim().split("|"); // the command line is last: it may hold a |
    if (pid && name) list.push({ pid: Number(pid), ppid: Number(ppid), name, mb: Math.round(Number(bytes) / 1048576) || 0, created: Date.parse(c) || null, cmd: cmd.join("|") });
  }
  return list.length ? list : null;
```

**Replace** in `claude/skills/handoff-launch/live.mjs`:

```js
  });
}
// {found, idle, busy:[reasons], last, pending, turnDone, bgAgents, bgKnown, liveStatus, file} - no loop judgement here.
export function sessionState(e) {
  // `claude agents --json` (a 100-200 MB CLI process) only for a background session: a window's state is its transcript.
  const list = usesAgents(e) ? agentsList() : null, a = list ? listedAgent(e, list) : null;
  const sid = e.session_id || a?.sessionId;
  const liveStatus = a ? String(a.status || a.state || "") : null;
  const file = transcriptOf(sid);
  if (!file) return { found: false, idle: false, busy: [], last: null, pending: 0, turnDone: false, bgAgents: 0, bgKnown: false, liveStatus, file: null };
  const L = tail(file).filter((x) => !x.isSidechain);
  const last = [...L].reverse().find((x) => x.timestamp)?.timestamp || fs.statSync(file).mtime.toISOString();
```

**with**:

```js
  });
}
// {found, idle, busy:[reasons], last, pending, turnDone, bgAgents, bgKnown, bgTasks, liveStatus, file} - no loop judgement here.
export function sessionState(e) {
  // `claude agents --json` (a 100-200 MB CLI process) only for a background session: a window's state is its transcript.
  const list = usesAgents(e) ? agentsList() : null, a = list ? listedAgent(e, list) : null;
  const sid = e.session_id || a?.sessionId;
  const liveStatus = a ? String(a.status || a.state || "") : null;
  const file = transcriptOf(sid);
  if (!file) return { found: false, idle: false, busy: [], last: null, pending: 0, turnDone: false, bgAgents: 0, bgKnown: false, bgTasks: [], liveStatus, file: null };
  const L = tail(file).filter((x) => !x.isSidechain);
  const last = [...L].reverse().find((x) => x.timestamp)?.timestamp || fs.statSync(file).mtime.toISOString();
```

**Replace** in `claude/skills/handoff-launch/live.mjs`:

```js
  if (bgAgents) busy.push(`${bgAgents} background agent(s) running`);
  if (liveStatus && /busy|running|working/i.test(liveStatus)) busy.push(`live status ${liveStatus}`);
  return { found: true, idle: busy.length === 0, busy, last, pending: pending.length, turnDone, bgAgents, bgKnown, liveStatus, file };
}

```

**with**:

```js
  if (bgAgents) busy.push(`${bgAgents} background agent(s) running`);
  if (liveStatus && /busy|running|working/i.test(liveStatus)) busy.push(`live status ${liveStatus}`);
  // Background shell and Monitor tasks (batch A, Part 2): turn_duration says nothing about them. Scanned only when the
  // session would otherwise be idle, so a busy session pays nothing: the main tail plus the subagent files modified
  // within bg_task_max_min; tasks from before this launch line belonged to an earlier process.
  let bgTasks = [];
  if (!busy.length) {
    const cfg = coordConfig(), nowMs = Date.now();
    const subs = subagentFiles(sid).filter((s) => nowMs - s.mtimeMs <= cfg.bg_task_max_min * MIN).map((s) => tail(s.file));
    bgTasks = openBgTasks([L, ...subs], { sinceMs: Date.parse(e.launched_at) || 0, nowMs, cfg }).map((t) => t.id);
    if (bgTasks.length) busy.push(`${bgTasks.length} background task(s) running`);
  }
  return { found: true, idle: busy.length === 0, busy, last, pending: pending.length, turnDone, bgAgents, bgKnown, bgTasks, liveStatus, file };
}

```

**Replace** in `claude/skills/handoff-launch/live.mjs`:

```js
    writeAtomic(f, JSON.stringify({ ...tj, at: now(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return true;
    spawn(process.execPath, [COORD_MJS, "tick"], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
    return true;
  } catch { return false; }
}

// ---------- the window launcher ----------
```

**with**:

```js
    writeAtomic(f, JSON.stringify({ ...tj, at: now(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return true;
    spawn(process.execPath, [COORD_MJS, "tick"], { detached: true, stdio: "ignore", windowsHide: true, env: launcherEnv() }).on("error", () => {}).unref();
    return true;
  } catch { return false; }
}

// A process the coordinator starts (launch.mjs, the tick) must not look like it was launched by whichever session's hook or
// command started the coordinator: no HL_SESSION_ID, no CLAUDE_CODE_SESSION_ID (batch A, Part 1's environment scrub).
export const launcherEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "HL_SESSION_ID" && k !== "CLAUDE_CODE_SESSION_ID")),
  ...extra,
});

// ---------- the window launcher ----------
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/liveness.test.mjs claude/skills/handoff-launch/tests/recover.test.mjs`
Expected: `ℹ fail 0` (the Windows-only tests skip elsewhere).

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/live.mjs claude/skills/handoff-launch/tests
git commit -m "live: hostBelow (empty host), background tasks in sessionState, launcherEnv; test hosts run a claude stand-in"
```

---

### Task 5: The tick: chain closes, the union restart guard, windows whose claude is gone, lanes.json, the reaper

**Files:**
- Modify: `claude/skills/handoff-launch/recover.mjs` (header, imports, `spawnLaunch` `:188`, `supersede` `:216-240`,
  `afterKill` `:253-254`, `resumePending` `:336-338`, `orphanScan` `:479-494`, new `reapPlaywright` before
  `housekeeping`, `guardedClose` `:508-524`, `closeCase` `:525-539`, `supersededScan` `:541-577`, new `goneScan`,
  `deadStart`, `laneTable`, `writeLanes` before the tick, `tick` `:599`)
- Test: `claude/skills/handoff-launch/tests/hygiene.test.mjs` (new), `tests/recover.test.mjs` (the resume restart's argv)

**Interfaces:**
- Consumes: Task 2 `restartBlockers`, `isSuccessor`, `supersedersOf`, `effectivePriority`, `byPriority`; Task 3
  `goneCandidate`, `goneKind`, `restartOf`, `DEAD_START_TEXT`, `playwrightOrphans`, `staleProfileDirs`, `parseGoal`,
  `goalNote`, `freshLaunchArgs({priority, supersedes})`; Task 4 `hostBelow`, `launcherEnv`, `processList().cmd`.
- Produces: `guardedClose(e, why, {dryRun, noClaude})` (the no-claude form: the recorded host, an empty host
  re-checked, no turn-state check) - Task 6's `closeGone` calls it; `laneTable(reg, repoKey?, now?) -> {repo: [lane]}`
  (exported; Task 13's dry run prints it); `<coord>/lanes.json` `{at, repos}`; registry lines
  `{dead_start: <id>, name, group, at}`; tick lines `DEAD START <name> (gen N): ...`, `closed <name> (gen N): claude
  exited`, `restart of <name> failed: its window is a dead start - blocked`, `<name> killed, not restarted: an open
  newer launch <x> shares its checkout - alert ...`, `killed Playwright orphan ...`, `removed N stale Playwright profile
  dir(s) from the temp dir`.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/hygiene.test.mjs`:

```js
// Batch A in the tick: closes follow the supersedes chain (Part 1), background tasks keep a window (Part 2), windows
// whose claude is gone (Part 3), the union restart guard's co-tenant alert, lanes.json (Part 5) and the Playwright reaper
// (Part 8). All in the stage-2 sandbox; windows are hidden powershell stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, sessionLine, appendLine, writeTranscript, setAgents, coordRun, tx, host, emptyHost, jobHost, hasPython, alive } from "./helpers.mjs";
import { key } from "../merge-lib.mjs";

const MIN = 60000, win = process.platform !== "win32";
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const idle = (start = Date.now() - 40 * MIN) => tx({ start }).user("go").call("Bash", { command: "x" }).say("handed off").turnDone().entries();
const bgRun = (sb, list) => setAgents(sb, list.map(([id, sid, name]) => ({ id, sessionId: sid, name, status: "running" })));

test("the tick closes a window only when its own successor runs: a co-tenant on the same checkout never closes it", { skip: win }, () => {
  const sb = sandbox();
  const h = host();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", gen: 1, sid: "a-s1", host: h, supersedes: null });
    writeTranscript(sb, sb.repo, a.session_id, idle());
    // A launch that landed on A's checkout without replacing it (--force): same repo + branch, newer generation.
    sessionLine(sb, { name: "T", id: "T@2", gen: 2, sid: "t-s2", mode: "bg", bg_id: "bg-T", supersedes: null, launched_at: new Date(Date.now() - 3600e3).toISOString() });
    bgRun(sb, [["bg-T", "t-s2", "T"]]);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /close[ds]? A /);
    assert.equal(alive(h.pid), true);
    // Its relay (supersedes A@1) runs: now A is superseded.
    sessionLine(sb, { name: "A", id: "A@3", gen: 3, sid: "a-s3", mode: "bg", bg_id: "bg-A3", supersedes: "A@1", launched_at: new Date(Date.now() - 1800e3).toISOString() });
    bgRun(sb, [["bg-T", "t-s2", "T"], ["bg-A3", "a-s3", "A"]]);
    r = tick(sb);
    assert.match(r.out, /^closed A \(gen 1\): superseded by generation 3: idle \d+ min$/m);
    assert.equal(alive(h.pid), false);
  } finally { h.kill(); sb.cleanup(); }
});

test("an idle superseded window with a background shell task running is kept until the task's notification", { skip: win }, () => {
  const sb = sandbox();
  const h = host();
  try {
    const x = sessionLine(sb, { name: "X", id: "X@1", gen: 1, sid: "x-s1", host: h, supersedes: null });
    const t = idle(), res = t.findIndex((o) => Array.isArray(o.message?.content) && o.message.content[0]?.type === "tool_result");
    t[res].toolUseResult = { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "b1" }; // run_in_background
    const f = writeTranscript(sb, sb.repo, x.session_id, t);
    sessionLine(sb, { name: "X", id: "X@2", gen: 2, sid: "x-s2", mode: "bg", bg_id: "bg-X2", supersedes: "X@1", launched_at: new Date(Date.now() - 3600e3).toISOString() });
    bgRun(sb, [["bg-X2", "x-s2", "X"]]);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /close[ds]? X /);
    assert.equal(alive(h.pid), true);
    // The task's notification arrives (a queue-operation enqueue, as Claude Code writes it): now the window is idle.
    fs.appendFileSync(f, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(Date.now() - 30 * MIN).toISOString(),
      content: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>" }) + "\n");
    fs.utimesSync(f, new Date(Date.now() - 30 * MIN), new Date(Date.now() - 30 * MIN));
    r = tick(sb);
    assert.match(r.out, /^closed X \(gen 1\): superseded by generation 2: idle \d+ min$/m);
  } finally { h.kill(); sb.cleanup(); }
});

test("windows whose claude is gone: a dead start alerts once, shows in status and closes after dead_close_min; an exited one closes at once; claude or a user's job keeps a window", { skip: win }, () => {
  const sb = sandbox();
  const hosts = [emptyHost(), emptyHost(), host(), ...(hasPython() ? [jobHost()] : [])];
  try {
    const old = Date.now() - 40 * MIN;
    const w = sessionLine(sb, { name: "W", id: "W@1", group: "g9", branch: "w", sid: "w-s1", host: hosts[0], supersedes: null }); // no transcript
    // A dead start leaves only metadata records, never an assistant one.
    writeTranscript(sb, sb.repo, w.session_id, [{ type: "mode", mode: "default", timestamp: new Date(old).toISOString() }]);
    fs.utimesSync(path.join(sb.env.HL_PROJECTS_DIR, path.resolve(sb.repo).replace(/[^a-zA-Z0-9]/g, "-"), `${w.session_id}.jsonl`), new Date(old), new Date(old));
    const e = sessionLine(sb, { name: "E", id: "E@1", group: "g9", branch: "e", sid: "e-s1", host: hosts[1], supersedes: null });
    const ef = writeTranscript(sb, sb.repo, e.session_id, idle(old)); fs.utimesSync(ef, new Date(old), new Date(old));
    sessionLine(sb, { name: "K", id: "K@1", group: "g9", branch: "k", sid: "k-s1", host: hosts[2], supersedes: null }); // claude runs, no transcript yet
    if (hosts[3]) sessionLine(sb, { name: "J", id: "J@1", group: "g9", branch: "j", sid: "j-s1", host: hosts[3], supersedes: null });
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would alert DEAD START W \(gen 1\) and close its window at /m);
    assert.match(dry.out, /^would close E \(gen 1\): claude exited$/m);
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^DEAD START W \(gen 1\): claude exited right after the launch - alert .*\.json$/m);
    assert.match(r.out, /^closed E \(gen 1\): claude exited$/m);
    assert.doesNotMatch(r.out, /[KJ] \(gen 1\)/);
    const alertsDir = path.join(sb.coord, "alerts");
    const texts = fs.readdirSync(alertsDir).filter((f) => /^\d.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(alertsDir, f), "utf8")).text);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^DEAD START: W \(w\): its window is open but claude exited right after the launch at .* UTC\. Read the error in that window, fix it, relaunch\. The coordinator closes the window at .* UTC\.$/);
    assert.equal(alive(hosts[0].pid), true); assert.equal(alive(hosts[1].pid), false); assert.equal(alive(hosts[2].pid), true);
    if (hosts[3]) assert.equal(alive(hosts[3].pid), true);
    r = tick(sb);
    assert.doesNotMatch(r.out, /DEAD START|close[ds]? W/); // one alert per entry; not yet dead_close_min
    // dead_close_min after the alert: the guarded no-claude close.
    const reg = path.join(sb.reg, "sessions.jsonl");
    fs.writeFileSync(reg, fs.readFileSync(reg, "utf8").replace(/("dead_start":"W@1"[^\n]*"at":")[^"]+/, `$1${new Date(Date.now() - 61 * MIN).toISOString()}`));
    r = tick(sb);
    assert.match(r.out, /^closed W \(gen 1\): dead start: no claude in the window since .*$/m);
    assert.equal(alive(hosts[0].pid), false);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("a coordinator restart that dies at once is a failed restart: {restart_failed} and {lane_blocked}, LOOP-BLOCKED in status", { skip: win }, () => {
  const sb = sandbox();
  const h = emptyHost();
  try {
    const at = new Date().toISOString();
    const w1 = sessionLine(sb, { name: "W", id: "W@1", group: "g9", branch: "w", gen: 1, sid: "w-s1", supersedes: null });
    appendLine(sb, { incident: w1.id, name: "W", n: 1, path: "x/incidents/W-1.md", signature: "a:main:x", rule: "a", mode: "auto", at });
    appendLine(sb, { kill_intent: w1.id, name: "W", kind: "ladder", at }); appendLine(sb, { closed: "W", id: w1.id, at });
    sessionLine(sb, { name: "W", id: "W@2", group: "g9", branch: "w", gen: 2, sid: "w-s2", host: h, supersedes: w1.id });
    appendLine(sb, { restart: "W", n: 1, kind: "fresh", from: w1.id, handoff: w1.handoff, model: "opus", effort: "high", at }); // the tick writes it after the launch line
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^DEAD START W \(gen 2\): claude exited right after the launch - alert /m);
    assert.match(r.out, /^restart of W failed: its window is a dead start - blocked$/m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.restart_failed === "W" && o.from === w1.id && o.n === 1));
    assert.ok(lines.some((o) => o.lane_blocked === "W" && o.group === "g9" && o.incident === "x/incidents/W-1.md"));
    assert.match(sb.run("status", "--group", "g9").out, /LOOP-BLOCKED \(incident x\/incidents\/W-1\.md/);
    assert.equal(alive(h.pid), true); // closed only dead_close_min after the alert, or by a relaunch (provenance.test.mjs)
  } finally { h.kill(); sb.cleanup(); }
});

test("the union restart guard: a killed lane next to a running co-tenant is not restarted, and the user is alerted", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", id: "A@1", sid: "a-s1", mode: "bg", bg_id: "bg-A" });
    sessionLine(sb, { name: "T", id: "T@2", gen: 2, sid: "t-s2", mode: "bg", bg_id: "bg-T", supersedes: null });
    bgRun(sb, [["bg-T", "t-s2", "T"]]);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^A killed, not restarted: an open newer launch T shares its checkout - alert .*\.json$/m);
    assert.ok(sb.registry().some((o) => o.restart_skipped === e.id && o.why === "an open newer launch T shares its checkout"));
    assert.equal(sb.registry().filter((o) => o.restart).length, 0);
  } finally { sb.cleanup(); }
});

test("lanes.json: the newest open running or unknown entry per lane, with id, scope, priority and checklist; a --repo tick rewrites only its key", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", id: "A@1", branch: "lane-a", sid: "a-s1", mode: "bg", bg_id: "bg-A", scope: "Stage A", model: "fable", effort: "high", supersedes: null });
    sessionLine(sb, { name: "B", id: "B@1", branch: "lane-b", sid: "b-s1", mode: "bg", bg_id: "bg-B", supersedes: null });
    sessionLine(sb, { name: "C", id: "C@1", branch: "lane-c", sid: "c-s1", mode: "bg", bg_id: "bg-C", supersedes: null }); // not listed: gone
    bgRun(sb, [["bg-A", "a-s1", "A"], ["bg-B", "b-s1", "B"]]);
    assert.equal(tick(sb).code, 0);
    const f = path.join(sb.coord, "lanes.json"), rk = key(sb.repo);
    let j = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.deepEqual(j.repos[rk].map((l) => [l.id, l.name, l.branch, l.scope, l.priority, l.liveness, l.goal]),
      [["A@1", "A", "lane-a", "Stage A", "high", "running", "no GOAL.md"], ["B@1", "B", "lane-b", null, "normal", "running", "no GOAL.md"]]);
    fs.writeFileSync(f, JSON.stringify({ at: j.at, repos: { "c:/elsewhere": [{ id: "Z@1" }], [rk]: [] } }));
    const r = sb.run("watchdog", "--repo", sb.repo, "--stop-looping");
    assert.equal(r.code, 0, r.err);
    j = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.deepEqual(j.repos["c:/elsewhere"], [{ id: "Z@1" }]);
    assert.deepEqual(j.repos[rk].map((l) => l.id), ["A@1", "B@1"]);
  } finally { sb.cleanup(); }
});

test("the Playwright reaper (hourly): kills orphans with Playwright's signature only, and removes stale --isolated profile dirs", () => {
  const sb = sandbox();
  try {
    const old = Date.now() - 5 * 3600e3;
    fs.writeFileSync(sb.env.HL_FAKE_PROCS, JSON.stringify([
      { pid: 9001, ppid: 4, name: "claude.exe", mb: 300, created: old, cmd: "claude" },
      { pid: 9002, ppid: 9001, name: "node.exe", mb: 60, created: old, cmd: "node C:/cfg/mcp-servers/node_modules/@playwright/mcp/cli.js --isolated" },
      { pid: 9003, ppid: 9002, name: "chrome.exe", mb: 200, created: old, cmd: `chrome.exe --remote-debugging-pipe --user-data-dir=${sb.temp}\\playwright_chromiumdev_profile-live` },
      { pid: 9101, ppid: 9999, name: "chrome.exe", mb: 500, created: old, cmd: "chrome.exe --remote-debugging-pipe --user-data-dir=C:\\T\\playwright_chromiumdev_profile-gone" },
      { pid: 9201, ppid: 9998, name: "chrome.exe", mb: 400, created: old, cmd: "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"" },
    ]));
    const mk = (n, ageH) => { const d = path.join(sb.temp, n); fs.mkdirSync(d); const t = new Date(Date.now() - ageH * 3600e3); fs.utimesSync(d, t, t); return d; };
    const stale = mk("playwright_chromiumdev_profile-old", 30), fresh = mk("playwright_chromiumdev_profile-new", 1), used = mk("playwright_chromiumdev_profile-live", 30);
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would kill Playwright orphan chrome\.exe 9101 \(parent 9999 gone\)$/m);
    assert.match(dry.out, /^would remove the stale Playwright profile .*playwright_chromiumdev_profile-old$/m);
    assert.equal(fs.existsSync(stale), true);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^killed Playwright orphan chrome\.exe 9101 \(parent 9999 gone\) \(HL_FAKE_PROCS: nothing really killed\)$/m);
    assert.doesNotMatch(r.out, /Playwright orphan [^\n]*(9002|9003|9201)/);
    assert.match(r.out, /^removed 1 stale Playwright profile dir\(s\) from the temp dir$/m);
    assert.deepEqual([fs.existsSync(stale), fs.existsSync(fresh), fs.existsSync(used)], [false, true, true]);
    assert.match(r.out, /^ORPHAN chrome\.exe pid 9201 400 MB/m); // the user's own Chrome: reported as before, never killed
  } finally { sb.cleanup(); }
});
```

**Replace** in `claude/skills/handoff-launch/tests/recover.test.mjs`:

```js
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: resume \(fable\/xhigh\)$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), ["--resume", SID, "--recovery", inc, "--model", "fable", "--effort", "xhigh"]);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.closed && o.id === e.id));
```

**with**:

```js
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: resume \(fable\/xhigh\)$/m);
    // Batch A: a restart keeps the lane's effective priority (fable/xhigh derives high).
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), ["--resume", SID, "--recovery", inc, "--model", "fable", "--effort", "xhigh", "--priority", "high"]);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.closed && o.id === e.id));
```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/hygiene.test.mjs claude/skills/handoff-launch/tests/recover.test.mjs`
Expected: FAIL - the co-tenant case closes A (generation order); the idle window with an open task is closed;
no `DEAD START` line; no `lanes.json`; no `killed Playwright orphan`; the resume argv lacks `--priority`.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
// The stage-2 coordinator tick: scan the launcher registry, flag loops, run the ladder (stop request -> grace ->
// incident -> kill -> restart or block), close idle superseded (any older generation, all groups) and paused windows
// (auto mode) through the guarded close, raise alerts. Every decision comes from recover-lib.mjs; this file reads state
// and acts. It writes only: the target's registry lines, stop file and incident; looping.json; alerts/; and its own
// tick.json, tick.lock, last-tick.txt, restart logs, housekeeping.json and orphans.json. Once an hour it prunes its own
// old files (prune below). Never a done marker, merge.lock, another lane's files or another worktree. Liveness
// `unknown` is never acted on: no stop, kill, close, restart or block is decided from it. Sessions a dead launcher left
// untracked and orphaned processes are only reported.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as L from "./recover-lib.mjs";
import * as V from "./live.mjs";
import { fwd, stem, isMergeSession } from "./merge-lib.mjs";

```

**with**:

```js
// The stage-2 coordinator tick: scan the launcher registry, flag loops, run the ladder (stop request -> grace ->
// incident -> kill -> restart or block), close idle superseded (a successor runs: batch A's chain relation, all groups)
// and paused windows (auto mode) through the guarded close, close windows whose claude is gone (batch A, Part 3), write
// lanes.json, raise alerts, and once an hour reap Playwright orphans. Every decision comes from recover-lib.mjs; this file reads state
// and acts. It writes only: the target's registry lines, stop file and incident; looping.json; alerts/; and its own
// tick.json, tick.lock, last-tick.txt, restart logs, housekeeping.json and orphans.json. Once an hour it prunes its own
// old files (prune below). Never a done marker, merge.lock, another lane's files or another worktree. Liveness
// `unknown` is never acted on: no stop, kill, close, restart or block is decided from it. Sessions a dead launcher left
// untracked and orphaned processes are only reported.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as L from "./recover-lib.mjs";
import * as V from "./live.mjs";
import * as G from "./lane-lib.mjs";
import { fwd, stem, isMergeSession } from "./merge-lib.mjs";

```

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
  const log = C("restarts", `${stem(name)}-${V.now().replace(/[:.]/g, "-")}.log`), started = V.now();
  touchTickLock();
  const r = spawnSync(process.execPath, [LAUNCH, ...argv], { encoding: "utf8", timeout: 3 * L.MIN, windowsHide: true });
  let logRef = fwd(log), logFile = log;
  try { V.writeAtomic(log, `node launch.mjs ${argv.join(" ")}\nexit ${r.status ?? r.error?.code ?? r.signal}\n${r.stdout || ""}${r.stderr || ""}`); }
```

**with**:

```js
  const log = C("restarts", `${stem(name)}-${V.now().replace(/[:.]/g, "-")}.log`), started = V.now();
  touchTickLock();
  // The scrubbed env: the restart must not look launched by the session whose hook started this tick (batch A, Part 1).
  const r = spawnSync(process.execPath, [LAUNCH, ...argv], { encoding: "utf8", timeout: 3 * L.MIN, windowsHide: true, env: V.launcherEnv() });
  let logRef = fwd(log), logFile = log;
  try { V.writeAtomic(log, `node launch.mjs ${argv.join(" ")}\nexit ${r.status ?? r.error?.code ?? r.signal}\n${r.stdout || ""}${r.stderr || ""}`); }
```

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
// Gap 17, for every end of a killed lane's ladder (afterKill, and reportBlock under report mode): only the newest
// generation of a lane is restarted or blocked - two sessions never share a worktree, and an old handoff never restarts
// over a lane that moved on to a later stage. Any newer launch without a {closed} line supersedes e. -> null when there
// is none; else the lines of the decision: running -> {restart_skipped}; unknown -> nothing written, the next tick
// retries; gone without a close -> {lane_blocked} + an alert. done/defer: how the caller's lines begin.
function supersede(e, reg, inc, { done, defer }) {
  const newer = reg.entries.filter((x) => x.id !== e.id && x.repo === e.repo && x.branch === e.branch && (x.generation || 0) > (e.generation || 0) && !reg.closed.has(x.id));
  if (!newer.length) return null;
  // Probed now, not from the memo: an earlier step of this tick (a 3-min restart) can leave it minutes old.
  for (const x of newer) V.forgetLiveness(x.id, { agents: V.usesAgents(x) }); // a bg one: its agents list too
  const n = newer.at(-1), lvs = newer.map((x) => ({ x, lv: V.liveness(x, reg) }));
  const run = lvs.find((s) => s.lv.state === "running");
  if (run) {
    V.append({ restart_skipped: e.id, name: e.name, why: `superseded by ${run.x.id}`, at: V.now() });
    return [`${done}: superseded by ${run.x.id}`];
  }
  // Unknown (a failed probe, a window still starting) is never a decision: no skip that ends the ladder, no block.
```

**with**:

```js
// Gap 17, for every end of a killed lane's ladder (afterKill, and reportBlock under report mode): only the newest
// generation of a lane is restarted or blocked - two sessions never share a worktree, and an old handoff never restarts
// over a lane that moved on to a later stage. The restart guard is the union (batch A, Part 1): any open entry newer on
// the same repo + branch, or with e in its chain (a relay on a switched branch). -> null when there is none; else the
// lines of the decision: a successor running -> {restart_skipped}; only a co-tenant running (a --force'd launch on e's
// checkout) -> {restart_skipped} + an alert, the user decides; unknown -> nothing written, the next tick retries; gone
// without a close -> {lane_blocked} + an alert. done/defer: how the caller's lines begin.
function supersede(e, reg, inc, { done, defer }) {
  const newer = G.restartBlockers(e, reg.entries, reg.closed);
  if (!newer.length) return null;
  // Probed now, not from the memo: an earlier step of this tick (a 3-min restart) can leave it minutes old.
  for (const x of newer) V.forgetLiveness(x.id, { agents: V.usesAgents(x) }); // a bg one: its agents list too
  const n = newer.at(-1), lvs = newer.map((x) => ({ x, lv: V.liveness(x, reg) }));
  const runs = lvs.filter((s) => s.lv.state === "running");
  const run = runs.find((s) => G.isSuccessor(s.x, e, reg.entries));
  if (run) {
    V.append({ restart_skipped: e.id, name: e.name, why: `superseded by ${run.x.id}`, at: V.now() });
    return [`${done}: superseded by ${run.x.id}`];
  }
  if (runs.length) {
    const co = runs[0].x, why = `an open newer launch ${co.name} shares its checkout`;
    V.append({ restart_skipped: e.id, name: e.name, why, at: V.now() });
    const text = `${e.name} ${endedHow(reg.lines, e)} and was not restarted: ${why} (${co.id}), launched without replacing it. Decide which session keeps the checkout.`;
    return [`${done}: ${why} - alert ${fwd(raiseAlert({ name: e.name, text, incident: inc?.path ?? null }))}`];
  }
  // Unknown (a failed probe, a window still starting) is never a decision: no skip that ends the ladder, no block.
```

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
  if (plan.do === "skip") { V.append({ restart_skipped: e.id, name: e.name, why: plan.why, at: V.now() }); return [`${e.name} killed, not restarted: ${plan.why}`]; }
  if (plan.do === "block") return block(e, inc, plan.restarts);
  const argv = plan.kind === "resume" ? ["--resume", e.session_id, "--recovery", inc.path, "--model", plan.model, "--effort", plan.effort]
    : L.freshLaunchArgs(e, { model: plan.model, effort: plan.effort, recovery: inc.path });
  const r = spawnLaunch(e.name, argv);
  // The cap refuses before any side effect, so this launcher registered nothing: deferred, never blocked for RAM.
```

**with**:

```js
  if (plan.do === "skip") { V.append({ restart_skipped: e.id, name: e.name, why: plan.why, at: V.now() }); return [`${e.name} killed, not restarted: ${plan.why}`]; }
  if (plan.do === "block") return block(e, inc, plan.restarts);
  // A restart is not a relay: it keeps the lane's effective priority (a hand-set one survives); a fresh one names the
  // killed entry as the one it replaces.
  const priority = G.effectivePriority(reg.lines, e);
  const argv = plan.kind === "resume" ? ["--resume", e.session_id, "--recovery", inc.path, "--model", plan.model, "--effort", plan.effort, "--priority", priority]
    : L.freshLaunchArgs(e, { model: plan.model, effort: plan.effort, recovery: inc.path, priority, supersedes: e.id });
  const r = spawnLaunch(e.name, argv);
  // The cap refuses before any side effect, so this launcher registered nothing: deferred, never blocked for RAM.
```

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
}
function resumePending({ dryRun, cfg, prevRun, now, repoKey }) {
  const out = [];
  for (const p of L.pendingLadders(V.readRegistry().lines)) {
    const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === p.id);
    if (!e || (repoKey && e.repo !== repoKey)) continue;
```

**with**:

```js
}
function resumePending({ dryRun, cfg, prevRun, now, repoKey }) {
  const out = [], first = V.readRegistry();
  // High priority first (Part 7), so a cap slot freed this tick goes to the highest-priority lane; then registry order.
  const prio = (p) => { const e = first.entries.find((x) => x.id === p.id); return e ? G.effectivePriority(first.lines, e) : "normal"; };
  for (const p of G.byPriority(L.pendingLadders(first.lines), prio)) {
    const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === p.id);
    if (!e || (repoKey && e.repo !== repoKey)) continue;
```

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
  const procs = V.processList();
  if (!procs) return [];
  const list = L.orphans(procs), total = list.reduce((s, o) => s + o.mb, 0), out = list.map(L.orphanLine);
  if (dryRun) return total > 1024 ? [...out, `would alert: orphaned processes hold ${total} MB`] : out;
  out.push(...writeState(C("orphans.json"), { at: V.now(), orphans: list }, "orphans.json")); // the coordinator's own report
  if (total > 1024) {
    const alerts = V.readJson(C("alerts", "index.json"), {}) || {}, k = `orphans|${list.map((o) => o.pid).sort((a, b) => a - b).join(",")}`;
    if (L.alertDue(alerts, k, now, cfg)) {
      const f = raiseAlert({ name: "orphans", text: L.ALERT.orphans(list, total), incident: null });
      alerts[k] = V.now();
      out.push(`orphaned processes hold ${total} MB - alert ${fwd(f)}`, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json"));
    }
  }
  return out;
}
function housekeeping({ dryRun, cfg, now }) {
  const f = C("housekeeping.json"), hk = V.readJson(f, {}) || {};
  const due = (k) => { const t = Date.parse(hk[k]); return !(t <= now && t > now - HOUR); }; // a future stamp is stale
  const jobs = [["prune_at", "prune", () => prune({ dryRun, cfg, now })], ["orphans_at", "orphan scan", () => orphanScan({ dryRun, cfg, now })]].filter(([k]) => due(k));
  const out = [];
  if (!jobs.length) return out;
  // Claimed before the work, as triggerTick claims a tick: a job that fails is tried again next hour, not every tick.
  if (!dryRun) out.push(...writeState(f, { ...hk, ...Object.fromEntries(jobs.map(([k]) => [k, V.now()])) }, "housekeeping.json"));
  for (const [, label, run] of jobs) { try { out.push(...run()); } catch (err) { out.push(`error: ${label} failed (${err?.message || err})`); } }
  return out;
}

// ---------- guarded closes: superseded (older generation) and paused windows ----------
// The guarded close (the hand-run guardclose script's logic): the host is still the recorded powershell with a start
// time within 2 s, and the transcript turn is done (re-read now); then kill_intent (kind close) -> taskkill /T /F ->
// {closed}, a process gone afterwards counting as closed (killTree, which probes once more). -> its one line
export function guardedClose(e, why, { dryRun }) {
  const w = V.readPidFile(e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
  if (!w.host_pid || !w.host_start) return `skip close of ${tag}: no recorded host pid and start time`;
  // checkHost is the same check once the pid file recorded the start time (required above): the name powershell and the
  // start within 2 s, a failed probe or an unreadable start unknown. Probed directly, never from the liveness memo.
  const h = V.checkHost(w, V.procInfo([w.host_pid]));
  if (h.state === "unknown") return `skip close of ${tag}: liveness unknown (${h.why})`;
  if (h.state !== "running") return `skip close of ${tag}: host pid ${w.host_pid} is not the recorded window (${h.why})`;
  const s = V.sessionState(e);
  if (s.found && (!s.idle || !s.bgKnown)) return `skip close of ${tag}: its turn is not done (${s.busy.join(", ") || "pending background agents unknown"})`;
  if (dryRun) return `would close ${tag}: ${why}`;
  const k = V.killTree(e, why, "close");
  return `${k.closed ? "closed" : "not closed"} ${tag}: ${why}${k.line === "closed" ? "" : ` - ${k.line}`}`;
}
// Why window e may be closed, from the registry alone (liveness is judged after): -> {newest, older, paused} or null.
// newest: the lane's (repo + branch) newest open launch; on a tie e stays, so same-generation siblings never supersede
// each other. older: e's generation is below newest's - N-1, or any older one still open (e.g. when N-1 is a closed
// duplicate; user decision 2026-10-04 after the dry run). The superseded close applies to every group (approved for
// all groups: an older generation handed its stage on, so its state is saved by construction); a paused window closes
// in auto mode only. A window with an incident and a newer launch is an older generation, so the superseded close
// covers it in every mode.
function closeCase(reg, e) {
  if (e.mode !== "window" || reg.closed.has(e.id)) return null;
  const newest = reg.entries.filter((x) => x.repo === e.repo && x.branch === e.branch && !reg.closed.has(x.id))
    .reduce((a, b) => ((b.generation || 0) > (a.generation || 0) ? b : a), e);
  const older = (e.generation || 0) < (newest.generation || 0);
  const paused = L.recoveryMode(reg.lines, e) === "auto" && pausedLine(reg.lines, e);
  return older || paused ? { newest, older, paused } : null;
}
const AGENTS_FRESH_MS = L.MIN; // a `claude agents --json` list younger than this is fresh enough for a close decision
export function supersededScan({ dryRun, cfg, now, repoKey }) {
  const out = [], first = V.readRegistry();
  const cands = first.entries.filter((e) => !repoKey || e.repo === repoKey).map((e) => [e, closeCase(first, e)]).filter(([, k]) => k);
  if (!cands.length) return out; // no probe at all in the common case
  // Probed now, not from the scan's memo: a 3-min restart earlier in this tick can leave it minutes old, and a successor
  // judged running then may be gone now. One window probe for the candidates and their lanes' newest launches; the
  // agents list is kept when it is under a minute old (one list per tick, not one per candidate or close).
  for (const [e, k] of cands) { V.forgetLiveness(e.id, { agents: false }); V.forgetLiveness(k.newest.id, { agents: AGENTS_FRESH_MS }); }
  V.primeLiveness(cands.flatMap(([e, k]) => [e, k.newest]));
  for (const [c] of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === c.id), k = e && closeCase(reg, e); // fresh, as in scan
      if (!k) continue;
      const tag = `${e.name} (gen ${e.generation ?? "?"})`;
      const superseded = k.older && V.liveness(k.newest, reg).state === "running"; // older, and the lane's newest runs
      if (!superseded && !k.paused) continue;
      // A pending loop ladder owns its session: it kills, cancels or ends it (resumePending runs first in the tick). A close
      // here with no running successor would let the next tick restart the closed session (afterKill); with one, the
      // ladder ends as superseded.
      if (!superseded && L.pendingLadders(reg.lines).some((p) => p.id === e.id)) { out.push(`skip close of ${tag}: its loop ladder is pending - the ladder ends first`); continue; }
      const lv = V.liveness(e, reg);
      if (lv.state !== "running") { if (lv.state === "unknown") out.push(`skip close of ${tag}: liveness unknown (${lv.why})`); continue; }
      // A missing hook state reads "not waiting" (a pre-stage-2 session has no hook); one that exists but does not parse is
      // a failed read, never taken for "not waiting".
      const hf = plainId(e.session_id) ? C("sessions", `${e.session_id}.json`) : null, hook = hf ? V.readJson(hf, null) : {};
      if (!hook && fs.existsSync(hf)) { out.push(`skip close of ${tag}: hook state unreadable`); continue; }
      const st = V.sessionState(e);
      // hasClaudeBelow answers whether claude runs in the window; closeDecision's emptyHost is the opposite (null: unknown).
      const below = st.found ? null : V.hasClaudeBelow(V.readPidFile(e).host_pid), noClaude = below === null ? null : !below;
      const reason = superseded ? `superseded by generation ${k.newest.generation}` : "paused";
      const d = L.closeDecision({ state: st, waitingSince: hook?.waiting_since || null, emptyHost: noClaude, now, cfg, reason, launchedAt: e.launched_at });
      if (d.close) out.push(guardedClose(e, d.why, { dryRun })); // a kept window prints nothing: every tick would repeat it
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
  }
  return out;
}

```

**with**:

```js
  const procs = V.processList();
  if (!procs) return [];
  const reaped = reapPlaywright(procs, { dryRun, now }), gone = new Set(reaped.pids);
  const list = L.orphans(procs.filter((p) => !gone.has(p.pid))), total = list.reduce((s, o) => s + o.mb, 0), out = [...reaped.lines, ...list.map(L.orphanLine)];
  if (dryRun) return total > 1024 ? [...out, `would alert: orphaned processes hold ${total} MB`] : out;
  // The coordinator's own report; command lines (batch A's process list) stay out of it: they can carry secrets.
  out.push(...writeState(C("orphans.json"), { at: V.now(), orphans: list.map(({ cmd, ...o }) => o) }, "orphans.json"));
  if (total > 1024) {
    const alerts = V.readJson(C("alerts", "index.json"), {}) || {}, k = `orphans|${list.map((o) => o.pid).sort((a, b) => a - b).join(",")}`;
    if (L.alertDue(alerts, k, now, cfg)) {
      const f = raiseAlert({ name: "orphans", text: L.ALERT.orphans(list, total), incident: null });
      alerts[k] = V.now();
      out.push(`orphaned processes hold ${total} MB - alert ${fwd(f)}`, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json"));
    }
  }
  return out;
}
// The Playwright orphan reaper (batch A, Part 8): Playwright's own processes whose parent is gone (L.playwrightOrphans),
// killed with their tree and logged; never by ancestor names. Then the temp dir's playwright_*dev_profile-* dirs that
// --isolated leaves behind (probe 7), older than 24 h and named by no running process. HL_FAKE_PROCS (tests) kills
// nothing: its pids are not real processes. -> {pids, lines}
function reapPlaywright(procs, { dryRun, now }) {
  const pw = L.playwrightOrphans(procs), lines = [];
  for (const p of pw) {
    const what = `Playwright orphan ${p.name} ${p.pid} (parent ${p.ppid} gone)`;
    if (dryRun) { lines.push(`would kill ${what}`); continue; }
    const k = process.env.HL_FAKE_PROCS ? { ok: true } : V.killPidTree(p.pid);
    lines.push(k.ok ? `killed ${what}${process.env.HL_FAKE_PROCS ? " (HL_FAKE_PROCS: nothing really killed)" : ""}` : `${what} not killed: ${k.why}`);
  }
  let dirs = [];
  try { dirs = fs.readdirSync(os.tmpdir(), { withFileTypes: true }).filter((d) => d.isDirectory() && /^playwright_\w*dev_profile-/.test(d.name)).map((d) => { const f = path.join(os.tmpdir(), d.name); return { path: f, mtimeMs: fs.statSync(f).mtimeMs }; }); } catch {}
  const stale = L.staleProfileDirs(dirs, procs, now);
  if (stale.length) {
    if (dryRun) lines.push(...stale.map((d) => `would remove the stale Playwright profile ${fwd(d.path)}`));
    else { const n = stale.filter((d) => { try { fs.rmSync(d.path, { recursive: true, force: true, maxRetries: 2 }); return true; } catch { return false; } }).length; lines.push(`removed ${n} stale Playwright profile dir(s) from the temp dir`); }
  }
  return { pids: pw.map((p) => p.pid), lines };
}
function housekeeping({ dryRun, cfg, now }) {
  const f = C("housekeeping.json"), hk = V.readJson(f, {}) || {};
  const due = (k) => { const t = Date.parse(hk[k]); return !(t <= now && t > now - HOUR); }; // a future stamp is stale
  const jobs = [["prune_at", "prune", () => prune({ dryRun, cfg, now })], ["orphans_at", "orphan scan", () => orphanScan({ dryRun, cfg, now })]].filter(([k]) => due(k));
  const out = [];
  if (!jobs.length) return out;
  // Claimed before the work, as triggerTick claims a tick: a job that fails is tried again next hour, not every tick.
  if (!dryRun) out.push(...writeState(f, { ...hk, ...Object.fromEntries(jobs.map(([k]) => [k, V.now()])) }, "housekeeping.json"));
  for (const [, label, run] of jobs) { try { out.push(...run()); } catch (err) { out.push(`error: ${label} failed (${err?.message || err})`); } }
  return out;
}

// ---------- guarded closes: superseded (older generation) and paused windows ----------
// The guarded close (the hand-run guardclose script's logic): the host is still the recorded powershell with a start
// time within 2 s, and the transcript turn is done (re-read now); then kill_intent (kind close) -> taskkill /T /F ->
// {closed}, a process gone afterwards counting as closed (killTree, which probes once more). noClaude (batch A, Part 3):
// the no-claude form - the turn state is not required (no claude is left to finish a turn); the host must be EMPTY,
// re-checked right before the kill. -> its one line
export function guardedClose(e, why, { dryRun, noClaude = false }) {
  const w = V.readPidFile(e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
  if (!w.host_pid || !w.host_start) return `skip close of ${tag}: no recorded host pid and start time`;
  // checkHost is the same check once the pid file recorded the start time (required above): the name powershell and the
  // start within 2 s, a failed probe or an unreadable start unknown. Probed directly, never from the liveness memo.
  const h = V.checkHost(w, V.procInfo([w.host_pid]));
  if (h.state === "unknown") return `skip close of ${tag}: liveness unknown (${h.why})`;
  if (h.state !== "running") return `skip close of ${tag}: host pid ${w.host_pid} is not the recorded window (${h.why})`;
  if (noClaude) {
    const b = V.hostBelow(w.host_pid);
    if (!b) return `skip close of ${tag}: the process probe below its window failed (${V.probeWhy()})`;
    if (!b.empty) return `skip close of ${tag}: its window is not empty (${b.names.join(", ")})`;
  } else {
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
const AGENTS_FRESH_MS = L.MIN; // a `claude agents --json` list younger than this is fresh enough for a close decision
export function supersededScan({ dryRun, cfg, now, repoKey }) {
  const out = [], first = V.readRegistry();
  const cands = first.entries.filter((e) => !repoKey || e.repo === repoKey).map((e) => [e, closeCase(first, e)]).filter(([, k]) => k);
  if (!cands.length) return out; // no probe at all in the common case
  // Probed now, not from the scan's memo: a 3-min restart earlier in this tick can leave it minutes old, and a successor
  // judged running then may be gone now. One window probe for the candidates and their lanes' newest launches; the
  // agents list is kept when it is under a minute old (one list per tick, not one per candidate or close).
  for (const [e, k] of cands) { V.forgetLiveness(e.id, { agents: false }); for (const n of k.succ) V.forgetLiveness(n.id, { agents: AGENTS_FRESH_MS }); }
  V.primeLiveness(cands.flatMap(([e, k]) => [e, ...k.succ]));
  for (const [c] of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === c.id), k = e && closeCase(reg, e); // fresh, as in scan
      if (!k) continue;
      const tag = `${e.name} (gen ${e.generation ?? "?"})`;
      const by = [...k.succ].reverse().find((n) => V.liveness(n, reg).state === "running"), superseded = !!by; // the newest running successor
      if (!superseded && !k.paused) continue;
      // A pending loop ladder owns its session: it kills, cancels or ends it (resumePending runs first in the tick). A close
      // here with no running successor would let the next tick restart the closed session (afterKill); with one, the
      // ladder ends as superseded.
      if (!superseded && L.pendingLadders(reg.lines).some((p) => p.id === e.id)) { out.push(`skip close of ${tag}: its loop ladder is pending - the ladder ends first`); continue; }
      const lv = V.liveness(e, reg);
      if (lv.state !== "running") { if (lv.state === "unknown") out.push(`skip close of ${tag}: liveness unknown (${lv.why})`); continue; }
      // A missing hook state reads "not waiting" (a pre-stage-2 session has no hook); one that exists but does not parse is
      // a failed read, never taken for "not waiting".
      const hf = plainId(e.session_id) ? C("sessions", `${e.session_id}.json`) : null, hook = hf ? V.readJson(hf, null) : {};
      if (!hook && fs.existsSync(hf)) { out.push(`skip close of ${tag}: hook state unreadable`); continue; }
      const st = V.sessionState(e);
      // Without a transcript only an EMPTY host closes (batch A): a job the user runs in the window keeps it (null: unknown).
      const below = st.found ? null : V.hostBelow(V.readPidFile(e).host_pid), emptyHost = st.found ? null : below ? below.empty : null;
      const reason = superseded ? `superseded by generation ${by.generation}` : "paused";
      const d = L.closeDecision({ state: st, waitingSince: hook?.waiting_since || null, emptyHost, now, cfg, reason, launchedAt: e.launched_at });
      if (d.close) out.push(guardedClose(e, d.why, { dryRun })); // a kept window prints nothing: every tick would repeat it
    } catch (err) { out.push(`error ${c.name}: ${err?.message || err} - no close this tick`); }
  }
  return out;
}

// ---------- batch A, Part 3: windows whose claude is gone (dead start, exited) ----------
// Window entries only, every group. Registry and file-time tests first (launch age, a quiet or missing transcript), so the
// tick probes few windows; then the host must be the recorded one, alive, and EMPTY (null: no action). Exited (the
// transcript has assistant records): closed at once, no alert. Dead start: one {dead_start} line and one alert (key
// deadstart|<id>, again after alert_repeat_hours), a coordinator restart also {restart_failed} + {lane_blocked}, and the
// window is closed dead_close_min after the alert. A pending ladder owns its session: skipped.
function goneScan({ dryRun, cfg, now, repoKey }) {
  const out = [], first = V.readRegistry(), pend = new Set(L.pendingLadders(first.lines).map((p) => p.id));
  const cands = [];
  for (const e of first.entries) {
    if (e.mode !== "window" || first.closed.has(e.id) || pend.has(e.id) || (repoKey && e.repo !== repoKey)) continue;
    const file = V.transcriptOf(e.session_id);
    let lastAt = NaN; if (file) { try { lastAt = fs.statSync(file).mtimeMs; } catch {} }
    if (L.goneCandidate({ launchedAt: e.launched_at, lastAt, hasTranscript: !!file, now, cfg })) cands.push({ e, file });
  }
  if (!cands.length) return out;
  V.primeLiveness(cands.map((c) => c.e));
  for (const { e, file } of cands) {
    touchTickLock();
    try {
      const reg = V.readRegistry();
      if (reg.closed.has(e.id) || V.liveness(e, reg).state !== "running") continue;
      const b = V.hostBelow(V.readPidFile(e).host_pid);
      if (!b || !b.empty) continue;
      if (L.goneKind(file ? V.tail(file) : null, Date.parse(e.launched_at)) === "exited") { out.push(guardedClose(e, "claude exited", { dryRun, noClaude: true })); continue; }
      out.push(...deadStart(e, reg, { dryRun, cfg, now }));
    } catch (err) { out.push(`error ${e.name}: ${err?.message || err} - no action this tick`); }
  }
  return out;
}
function deadStart(e, reg, { dryRun, cfg, now }) {
  const tag = `${e.name} (gen ${e.generation ?? "?"})`, seen = reg.lines.find((o) => o.dead_start === e.id);
  const alerts = V.readJson(C("alerts", "index.json"), {}) || {}, k = `deadstart|${e.id}`;
  const since = seen ? Date.parse(seen.at) : now, closeAt = since + cfg.dead_close_min * L.MIN;
  if (seen && now >= closeAt) return [guardedClose(e, `dead start: no claude in the window since ${seen.at}`, { dryRun, noClaude: true })];
  if (seen && !L.alertDue(alerts, k, now, cfg)) return [];
  if (dryRun) return [`would alert DEAD START ${tag}${seen ? " again" : ""} and close its window at ${new Date(closeAt).toISOString()}`];
  const out = [];
  if (!seen) {
    V.append({ dead_start: e.id, name: e.name, group: e.group || null, at: new Date(now).toISOString() });
    const rs = L.restartOf(reg.lines, e);
    if (rs) { // a coordinator restart that died at once: as a restart that failed to launch
      const inc = [...reg.lines].reverse().find((o) => o.incident && o.name === e.name && o.n === rs.n);
      V.append({ restart_failed: e.name, n: rs.n, kind: rs.kind, from: rs.from, handoff: e.handoff, why: "dead start: claude exited right after the launch", log: null, at: V.now() });
      V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc?.path ?? null, at: V.now() });
      out.push(`restart of ${e.name} failed: its window is a dead start - blocked`);
    }
  }
  const f = raiseAlert({ name: e.name, text: L.DEAD_START_TEXT({ name: e.name, branch: e.branch, launchedAt: e.launched_at, closeAt }), incident: null });
  alerts[k] = V.now();
  out.unshift(`DEAD START ${tag}: claude exited right after the launch - alert ${fwd(f)}`);
  return [...out, ...writeState(C("alerts", "index.json"), alerts, "alerts/index.json")];
}

// ---------- batch A, Part 5: lanes.json, the live lanes the hooks read ----------
// Per repo: the newest open entry of each lane (repo + branch) whose liveness is running or unknown, with its registry
// id, name, branch, worktree, group, scope, effective priority and checklist note. A --repo tick rewrites only its key.
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
    (repos[e.repo] ??= []).push({ id: e.id, name: e.name, branch: e.branch, worktree: e.worktree, group: e.group ?? null, scope: e.scope ?? null,
      priority: G.effectivePriority(reg.lines, e), liveness: lv.state, goal });
  }
  return repos;
}
function writeLanes({ dryRun, repoKey, now }) {
  if (dryRun) return [];
  const f = C("lanes.json"), table = laneTable(V.readRegistry(), repoKey, now);
  const prev = (V.readJson(f, {}) || {}).repos;
  const repos = repoKey ? { ...(prev && typeof prev === "object" ? prev : {}), [repoKey]: table[repoKey] || [] } : table;
  return writeState(f, { at: V.now(), repos }, "lanes.json");
}

```

**Replace** in `claude/skills/handoff-launch/recover.mjs`:

```js
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
    // Machine-wide, so only in an unrestricted tick ({starting} lines carry no repo; files and processes are global).
    if (!repoKey) out.push(...V.untracked().map(L.untrackedLine), ...housekeeping({ dryRun, cfg, now: Date.now() })); // now: a restart may have taken minutes
```

**with**:

```js
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey }));
    out.push(...supersededScan({ dryRun, cfg, now, repoKey }));
    out.push(...goneScan({ dryRun, cfg, now: Date.now(), repoKey }));
    out.push(...writeLanes({ dryRun, repoKey, now: Date.now() }));
    // Machine-wide, so only in an unrestricted tick ({starting} lines carry no repo; files and processes are global).
    if (!repoKey) out.push(...V.untracked().map(L.untrackedLine), ...housekeeping({ dryRun, cfg, now: Date.now() })); // now: a restart may have taken minutes
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/hygiene.test.mjs claude/skills/handoff-launch/tests/recover.test.mjs claude/skills/handoff-launch/tests/isolation.test.mjs`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/recover.mjs claude/skills/handoff-launch/tests
git commit -m "tick: closes follow the supersedes chain, union restart guard, dead starts and exited windows, lanes.json, Playwright reaper"
```

---

### Task 6: `launch.mjs` provenance: `launched_by`, `supersedes`, the occupancy check, the chain close, the resume guard, unknown flags

**Files:**
- Modify: `claude/skills/handoff-launch/launch.mjs` (imports `:57-62`, after `flag` `:69`, `closeOld` `:87-113` + new
  `closeGone`, `sessionCap` `:176-210`, `resume` `:442-454`, after the subcommands `:468`, `resumeLaunch` `:485-508`,
  the cap line `:566`, the entry `:705-711`, the dry-run report `:758`, the close after a launch `:772`)
- Modify: `claude/skills/handoff-launch/merge.mjs:11`, `:311-312` (the merge session's scrubbed env)
- Test: `claude/skills/handoff-launch/tests/provenance.test.mjs` (new), `tests/liveness.test.mjs` (the launch-time close
  follows the chain), `tests/profiles-cap.test.mjs` (the cap's exemption follows `supersedes`)

**Interfaces:**
- Consumes: Task 2 `pickSupersedes`, `sameCheckout`, `occupantAct`, `OCCUPIED`, `OCCUPANT_UNKNOWN`, `chainOf`,
  `hasSupersedesKey`, `restartBlockers`, `PRIORITIES`, `derivePriority`, `effectivePriority`, `scopeOf`; Task 3
  `freshLaunchArgs({priority, supersedes})`; Task 4 `hostBelow`, `launcherEnv`, `forgetLiveness`; Task 5 `guardedClose`
  (no-claude form).
- Produces: launch lines with `launched_by`, `supersedes`, `scope`, `priority` (also `--resume` lines, set explicitly);
  flags `--supersedes <id>`, `--priority high|normal|low`, `--scope "<text>"`, `--resume ... --profile <names>`;
  `closeGone(e, apply)`; the refusal `refused - <repo>@<branch> already has a running session ...` (exit 3); stderr
  `note: this launch replaces <name> (gen N) as its relay`, `warning: unknown flag --<x> (ignored)`, `occupancy
  overridden by --force: ...`; the dry-run report's `occupancy: {refused, would_close}`; `KNOWN_FLAGS` (Task 8 extends it);
  `launch.mjs resume --group` relaunches blocked lanes high priority first, each with `--priority <effective>` and
  `--supersedes <its newest entry>`, in the scrubbed env, after closing a dead-start window of the lane.

- [ ] **Step 1: Write the failing tests**

**Replace** in `claude/skills/handoff-launch/tests/liveness.test.mjs`:

```js
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const line = { id: "w@1", name: "w", repo: sb.repo.split(path.sep).join("/").toLowerCase(), branch: "main", worktree: "x", generation: 1, mode: "window", group: null, title: "w", handoff: "h.md", done_marker: null, launched_at: new Date(Date.now() - 3600e3).toISOString(), session_id: null, host_pid: dead, host_start: null, pid_file: null };
    fs.writeFileSync(path.join(sb.reg, "sessions.jsonl"), [line, { ...line, id: "w@2", generation: 2 }].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const dryLaunch = (env) => JSON.parse(spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "w", "--model", "opus", "--effort", "high", "--dry-run"], { env, encoding: "utf8" }).stdout).auto_close;
    assert.match(dryLaunch(sb.env)[0], /^skip w \(gen 1, pid \d+\): not running - would mark closed$/);
    assert.match(dryLaunch({ ...sb.env, HL_FAKE_PROBE: "fail" })[0], /^skip w \(gen 1, pid \d+\): liveness unknown \(process probe failed .*\) - nothing done$/);
```

**with**:

```js
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const line = { id: "w@1", name: "w", repo: sb.repo.split(path.sep).join("/").toLowerCase(), branch: "main", worktree: "x", generation: 1, mode: "window", group: null, title: "w", handoff: "h.md", done_marker: null, launched_at: new Date(Date.now() - 3600e3).toISOString(), session_id: null, host_pid: dead, host_start: null, pid_file: null };
    // Batch A: the launch-time close takes the new launch's chain beyond its direct predecessor (w@2 -> w@1).
    fs.writeFileSync(path.join(sb.reg, "sessions.jsonl"), [{ ...line, supersedes: null }, { ...line, id: "w@2", generation: 2, supersedes: "w@1" }].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const dryLaunch = (env) => JSON.parse(spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "w", "--model", "opus", "--effort", "high", "--supersedes", "w@2", "--dry-run"], { env, encoding: "utf8" }).stdout).auto_close;
    assert.match(dryLaunch(sb.env)[0], /^skip w \(gen 1, pid \d+\): not running - would mark closed$/);
    assert.match(dryLaunch({ ...sb.env, HL_FAKE_PROBE: "fail" })[0], /^skip w \(gen 1, pid \d+\): liveness unknown \(process probe failed .*\) - nothing done$/);
```

**Replace** in `claude/skills/handoff-launch/tests/liveness.test.mjs`:

```js
    const known = tx({ start: old }).user("go").say("handed off").turnDone().entries();
    const unknown = tx({ start: old }).user("go").say("handed off").entries(); // the turn ended without a turn_duration record
    const k = sessionLine(sb, { name: "k", id: "k@1", gen: 1, sid: "k-s1", host: hosts[0] }); writeTranscript(sb, sb.repo, k.session_id, known);
    const u = sessionLine(sb, { name: "u", id: "u@1", gen: 1, sid: "u-s1", host: hosts[1] }); writeTranscript(sb, sb.repo, u.session_id, unknown);
    sessionLine(sb, { name: "k", id: "k@2", gen: 2, sid: "k-s2" });
    const r = spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "k", "--model", "opus", "--effort", "high", "--dry-run"], { env: sb.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const auto = JSON.parse(r.stdout).auto_close;
    assert.ok(auto.some((l) => /^would close k \(gen 1, pid \d+\): idle \d+ min$/.test(l)), auto.join("\n"));
    assert.ok(auto.some((l) => /^skip u \(gen 1, pid \d+\): pending background agents unknown \(the turn ended without a turn_duration record\) - nothing done$/.test(l)), auto.join("\n"));
```

**with**:

```js
    const known = tx({ start: old }).user("go").say("handed off").turnDone().entries();
    const unknown = tx({ start: old }).user("go").say("handed off").entries(); // the turn ended without a turn_duration record
    // Batch A: each launch closes its own chain beyond its direct predecessor: k@2 -> k@1, u@2 -> u@1.
    const k = sessionLine(sb, { name: "k", id: "k@1", gen: 1, sid: "k-s1", host: hosts[0], supersedes: null }); writeTranscript(sb, sb.repo, k.session_id, known);
    const u = sessionLine(sb, { name: "u", id: "u@1", gen: 1, sid: "u-s1", host: hosts[1], supersedes: null }); writeTranscript(sb, sb.repo, u.session_id, unknown);
    sessionLine(sb, { name: "k", id: "k@2", gen: 2, sid: "k-s2", supersedes: "k@1" });
    sessionLine(sb, { name: "u", id: "u@2", gen: 2, sid: "u-s2", supersedes: "u@1" });
    const dry = (n, sup) => spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", n, "--model", "opus", "--effort", "high", "--supersedes", sup, "--dry-run"], { env: sb.env, encoding: "utf8" });
    const r = dry("k", "k@2"), r2 = dry("u", "u@2");
    assert.equal(r.status, 0, r.stderr); assert.equal(r2.status, 0, r2.stderr);
    const auto = [...JSON.parse(r.stdout).auto_close, ...JSON.parse(r2.stdout).auto_close];
    assert.ok(auto.some((l) => /^would close k \(gen 1, pid \d+\): idle \d+ min$/.test(l)), auto.join("\n"));
    assert.ok(auto.some((l) => /^skip u \(gen 1, pid \d+\): pending background agents unknown \(the turn ended without a turn_duration record\) - nothing done$/.test(l)), auto.join("\n"));
```

**Replace** in `claude/skills/handoff-launch/tests/profiles-cap.test.mjs`:

```js
});

test("session cap: max_sessions refuses the next launch (exit 3) until --force; a same repo+branch relay is not blocked", () => {
  const sb = sandbox();
  try {
    setCap(sb, { max_sessions: 2 });
    counted(sb, launch(sb, "A", "--worktree", "lane-a"));
    counted(sb, launch(sb, "B", "--worktree", "lane-b"));
    let r = launch(sb, "C", "--worktree", "lane-c");
    assert.equal(r.code, 3, r.out);
    assert.match(r.err, /refused - session cap: 2 sessions running, max_sessions 2 \(config .*launch-config\.json\)/);
    assert.match(r.err, /^ {2}A \(lane-a\): doubtful, counted - starting \(no pid file yet\)$/m);
    assert.match(r.err, /^ {2}B \(lane-b\): doubtful, counted - starting \(no pid file yet\)$/m);
    assert.match(r.err, /close idle sessions first, or pass --force \(ask the user first\)/);
    exactly(sb, 2);
    r = launch(sb, "C", "--worktree", "lane-c", "--force");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /session cap overridden by --force: 2 sessions running, max_sessions 2/);
    exactly(sb, 3);
    unspawn(sb);
    // Relay on lane-a at max 3: A (same repo+branch) is not counted -> B and C = 2 < 3, launched (counting A would
    // refuse). A launch on a fourth branch then sees A, A2, B, C (the predecessor runs until it is closed).
    setCap(sb, { max_sessions: 3 });
    counted(sb, launch(sb, "A2", "--worktree", "lane-a"));
    r = launch(sb, "D", "--worktree", "lane-d");
    assert.equal(r.code, 3); assert.match(r.err, /4 sessions running, max_sessions 3/);
```

**with**:

```js
});

test("session cap: max_sessions refuses the next launch (exit 3) until --force; a launch that replaces a session (--supersedes) does not count it", () => {
  const sb = sandbox();
  try {
    setCap(sb, { max_sessions: 2 });
    counted(sb, launch(sb, "A", "--worktree", "lane-a"));
    counted(sb, launch(sb, "B", "--worktree", "lane-b"));
    let r = launch(sb, "C", "--worktree", "lane-c");
    assert.equal(r.code, 3, r.out);
    assert.match(r.err, /refused - session cap: 2 sessions running, max_sessions 2 \(config .*launch-config\.json\)/);
    assert.match(r.err, /^ {2}A \(lane-a\): doubtful, counted - starting \(no pid file yet\)$/m);
    assert.match(r.err, /^ {2}B \(lane-b\): doubtful, counted - starting \(no pid file yet\)$/m);
    assert.match(r.err, /close idle sessions first, or pass --force \(ask the user first\)/);
    exactly(sb, 2);
    r = launch(sb, "C", "--worktree", "lane-c", "--force");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /session cap overridden by --force: 2 sessions running, max_sessions 2/);
    exactly(sb, 3);
    unspawn(sb);
    // Batch A: only the entry a launch replaces (its supersedes) is not counted. At max 3 a launch on lane-a that replaces
    // nothing counts A, B and C (and A, starting, only warns: its liveness is unknown); with --supersedes A it counts B
    // and C = 2 < 3. A launch on a fourth branch then sees A, A2, B, C (the predecessor runs until it is closed).
    setCap(sb, { max_sessions: 3 });
    const a = launches(sb).find((o) => o.name === "A");
    r = launch(sb, "A2", "--worktree", "lane-a");
    assert.equal(r.code, 3, r.out); assert.match(r.err, /3 sessions running, max_sessions 3/);
    assert.match(r.err, /^warning: .*@lane-a has an open session A \(gen 1, id .*\) whose liveness is unknown/m);
    counted(sb, launch(sb, "A2", "--worktree", "lane-a", "--supersedes", a.id));
    r = launch(sb, "D", "--worktree", "lane-d");
    assert.equal(r.code, 3); assert.match(r.err, /4 sessions running, max_sessions 3/);
```

**Replace** in `claude/skills/handoff-launch/tests/profiles-cap.test.mjs`:

```js
});

test("session cap excludes only the newest live session on the same repo+branch (the relay's predecessor)", () => {
  const sb = sandbox();
  try {
    counted(sb, launch(sb, "A")); counted(sb, launch(sb, "B")); // both on main
    setCap(sb, { max_sessions: 2 });
    counted(sb, launch(sb, "C")); // B is the predecessor, A counts: 1 < 2
    const r = launch(sb, "D"); // C is the predecessor, A and B count: 2 >= 2
    assert.equal(r.code, 3, r.out);
    assert.match(r.err, /refused - session cap: 2 sessions running, max_sessions 2/);
    assert.match(r.err, /^ {2}A \(main\): doubtful, counted/m);
    assert.match(r.err, /^ {2}B \(main\): doubtful, counted/m);
    assert.doesNotMatch(r.err, /^ {2}C \(/m);
    exactly(sb, 3);
  } finally { sb.cleanup(); }
});

test("session cap picks the predecessor among counted sessions: a dead newer entry on the branch does not take its place", () => {
  const sb = sandbox();
  try {
    counted(sb, launch(sb, "A")); // on main, no pid yet: doubtful, counted
    const a = launches(sb)[0];
    // A newer entry on the same branch whose host is dead (no {closed} line was ever written for it).
    fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ ...a, id: `Z@${Date.now()}`, name: "Z",
      launched_at: new Date(Date.parse(a.launched_at) + 1000).toISOString(), host_pid: 999999, host_start: a.launched_at }) + "\n");
    setCap(sb, { max_sessions: 1 });
    const r = launch(sb, "B"); // Z is gone, so A is the predecessor: 0 counted < 1
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /refused/);
  } finally { sb.cleanup(); }
});
```

**with**:

```js
});

test("session cap exempts only the entry the launch replaces (its supersedes), none without one", () => {
  const sb = sandbox();
  try {
    counted(sb, launch(sb, "A")); counted(sb, launch(sb, "B")); // both on main
    setCap(sb, { max_sessions: 2 });
    const [a, b] = launches(sb);
    let r = launch(sb, "C"); // replaces nothing: A and B count, 2 >= 2
    assert.equal(r.code, 3, r.out); assert.match(r.err, /refused - session cap: 2 sessions running, max_sessions 2/);
    counted(sb, launch(sb, "C", "--supersedes", b.id)); // B is the one it replaces: A counts, 1 < 2
    r = launch(sb, "D", "--supersedes", a.id); // A is exempt; B and C count: 2 >= 2
    assert.equal(r.code, 3, r.out);
    assert.match(r.err, /refused - session cap: 2 sessions running, max_sessions 2/);
    assert.match(r.err, /^ {2}B \(main\): doubtful, counted/m);
    assert.match(r.err, /^ {2}C \(main\): doubtful, counted/m);
    assert.doesNotMatch(r.err, /^ {2}A \(/m);
    exactly(sb, 3);
  } finally { sb.cleanup(); }
});

test("session cap: replacing an entry that does not count (gone) exempts nothing else", () => {
  const sb = sandbox();
  try {
    counted(sb, launch(sb, "A")); // on main, no pid yet: doubtful, counted
    const a = launches(sb)[0];
    // A newer entry on the same branch whose host is dead (no {closed} line was ever written for it).
    fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ ...a, id: `Z@${Date.now()}`, name: "Z",
      launched_at: new Date(Date.parse(a.launched_at) + 1000).toISOString(), host_pid: 999999, host_start: a.launched_at }) + "\n");
    setCap(sb, { max_sessions: 1 });
    let r = launch(sb, "B", "--supersedes", a.id); // A is the one it replaces: 0 counted < 1
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /refused/);
    const z = launches(sb).find((o) => o.name === "Z");
    r = launch(sb, "C", "--supersedes", z.id); // Z is gone: nothing exempt, A counts: 1 >= 1
    assert.equal(r.code, 3, r.out); assert.match(r.err, /^ {2}A \(main\): doubtful, counted/m);
  } finally { sb.cleanup(); }
});
```

**Create** `claude/skills/handoff-launch/tests/provenance.test.mjs`:

```js
// Batch A, Part 1 and the smaller launcher changes: launch provenance (launched_by, supersedes, scope, priority), the
// occupancy check, the environment scrub, unknown flags, --resume's --profile and the union restart guard.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, launchLane, commitIn, writeDone, host, emptyHost, jobHost, hasPython, alive, LAUNCH } from "./helpers.mjs";

const win = process.platform !== "win32";
// A launch with extra env (a launcher session's HL_SESSION_ID / CLAUDE_CODE_SESSION_ID).
const runEnv = (sb, env, ...a) => {
  const r = spawnSync(process.execPath, [LAUNCH, ...a], { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 180000 });
  return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
};
const base = (name) => ["--repo", null, "--handoff", null, "--name", name, "--model", "opus", "--effort", "high"];
const launch = (sb, name, ...extra) => sb.run(...base(name).map((x, i) => (i === 1 ? sb.repo : i === 3 ? sb.handoff : x)), ...extra);
const launchEnv = (sb, env, name, ...extra) => runEnv(sb, env, ...base(name).map((x, i) => (i === 1 ? sb.repo : i === 3 ? sb.handoff : x)), ...extra);
const lastLaunch = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name).at(-1);
const wtOf = (sb, b) => path.join(sb.repo, ".claude", "worktrees", b).split(path.sep).join("/");

test("launch lines record launched_by, supersedes, scope and priority; a plain-terminal launch replaces nothing", () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.handoff, "intro\n# Stage 3: lane hygiene\n");
    assert.equal(launch(sb, "A", "--worktree", "lane-a").code, 0);
    const a = lastLaunch(sb, "A");
    assert.ok(Object.hasOwn(a, "supersedes"));
    assert.deepEqual([a.launched_by, a.supersedes, a.scope, a.priority], [null, null, "Stage 3: lane hygiene", "normal"]);
    let r = runEnv(sb, {}, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "fable", "--effort", "high", "--worktree", "lane-b", "--scope", "my own scope");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([lastLaunch(sb, "B").priority, lastLaunch(sb, "B").scope], ["high", "my own scope"]);
    assert.equal(runEnv(sb, {}, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "C", "--model", "opus", "--effort", "medium", "--worktree", "lane-c").code, 0);
    assert.equal(lastLaunch(sb, "C").priority, "low");
    assert.equal(launch(sb, "D", "--worktree", "lane-d", "--priority", "low").code, 0);
    assert.equal(lastLaunch(sb, "D").priority, "low");
    r = launch(sb, "E", "--worktree", "lane-e", "--priority", "urgent");
    assert.equal(r.code, 2); assert.match(r.err, /--priority must be high, normal or low, got urgent/);
  } finally { sb.cleanup(); }
});

test("a relay supersedes its launcher (by HL_SESSION_ID, else CLAUDE_CODE_SESSION_ID); a launcher elsewhere replaces nothing", () => {
  const sb = sandbox();
  try {
    assert.equal(launch(sb, "A", "--worktree", "lane-a").code, 0);
    const a = lastLaunch(sb, "A");
    let r = launchEnv(sb, { HL_SESSION_ID: a.id, CLAUDE_CODE_SESSION_ID: "s-launcher" }, "A", "--worktree", "lane-a");
    assert.equal(r.code, 0, r.err);
    const a2 = lastLaunch(sb, "A");
    assert.deepEqual([a2.supersedes, a2.launched_by], [a.id, "s-launcher"]);
    assert.doesNotMatch(r.err, /as its relay/); // same name: no note
    // Found by launched_by alone (a launcher session without HL_SESSION_ID), under another name: the note says so.
    r = launchEnv(sb, { CLAUDE_CODE_SESSION_ID: a2.session_id }, "A-next", "--worktree", "lane-a");
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLaunch(sb, "A-next").supersedes, a2.id);
    assert.match(r.err, /^note: this launch replaces A \(gen 2\) as its relay$/m);
    // A registry session launching onto another checkout: no relay.
    r = launchEnv(sb, { HL_SESSION_ID: a.id }, "K", "--worktree", "lane-k");
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLaunch(sb, "K").supersedes, null);
  } finally { sb.cleanup(); }
});

test("--supersedes names the entry a launch replaces; an id with no launch line exits 2 before any side effect", () => {
  const sb = sandbox();
  try {
    assert.equal(launch(sb, "A", "--worktree", "lane-a").code, 0);
    const a = lastLaunch(sb, "A"), n = sb.registry().length;
    let r = launch(sb, "B", "--worktree", "lane-a", "--supersedes", "nobody@1");
    assert.equal(r.code, 2); assert.match(r.err, /--supersedes: no launch line has id nobody@1/);
    assert.equal(sb.registry().length, n);
    r = launch(sb, "B", "--worktree", "lane-a", "--supersedes");
    assert.equal(r.code, 2);
    r = launch(sb, "B", "--worktree", "lane-a", "--supersedes", a.id);
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLaunch(sb, "B").supersedes, a.id);
  } finally { sb.cleanup(); }
});

test("occupancy: a launch that replaces nothing onto a running session's checkout is refused (exit 3) before any side effect", { skip: win }, () => {
  const sb = sandbox();
  const h = host();
  try {
    const x = sessionLine(sb, { name: "X", id: "X@1", branch: "lane-x", worktree: wtOf(sb, "lane-x"), sid: "x-s1", host: h, supersedes: null });
    const before = fs.readFileSync(path.join(sb.reg, "sessions.jsonl"));
    let r = launch(sb, "Y", "--worktree", "lane-x");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /^refused - .*@lane-x already has a running session X \(gen 1, id X@1\): two sessions must not share a worktree\. Launch a helper with --worktree <own branch>, or replace that session explicitly with --supersedes X@1\. --force overrides \(ask the user first\)\.$/m);
    assert.ok(fs.readFileSync(path.join(sb.reg, "sessions.jsonl")).equals(before));
    assert.equal(fs.existsSync(wtOf(sb, "lane-x")), false);
    r = launch(sb, "Y", "--worktree", "lane-x", "--dry-run"); // prints the decision, refuses nothing
    assert.equal(r.code, 0, r.err); assert.match(r.err, /^would be refused - /m);
    assert.equal(JSON.parse(r.out).occupancy.refused, "X@1");
    // A relay of X itself, and an explicit replacement, never reach the refusal.
    r = launchEnv(sb, { HL_SESSION_ID: "X@1" }, "X", "--worktree", "lane-x");
    assert.equal(r.code, 0, r.err); assert.equal(lastLaunch(sb, "X").supersedes, "X@1");
    r = launch(sb, "Z", "--worktree", "lane-x", "--supersedes", "X@1");
    assert.equal(r.code, 0, r.err);
    assert.equal(alive(h.pid), true); // nothing closed it
    r = launch(sb, "W", "--worktree", "lane-x", "--force");
    assert.equal(r.code, 0, r.err); assert.match(r.err, /^occupancy overridden by --force: refused - /m);
  } finally { h.kill(); sb.cleanup(); }
});

test("occupancy: a window whose claude exited (empty host) is closed first; a user's job below the host keeps it; unknown only warns", { skip: win }, () => {
  const sb = sandbox();
  const hosts = [emptyHost(), ...(hasPython() ? [jobHost()] : [])];
  try {
    const d = sessionLine(sb, { name: "D", id: "D@1", branch: "lane-d", worktree: wtOf(sb, "lane-d"), sid: "d-s1", host: hosts[0], supersedes: null });
    let r = launch(sb, "D2", "--worktree", "lane-d");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.err, /^closed D \(gen 1\): claude exited \(closed before this launch\)$/m);
    assert.equal(alive(hosts[0].pid), false);
    assert.ok(sb.registry().some((o) => o.kill_intent === d.id && o.kind === "close") && sb.registry().some((o) => o.closed && o.id === d.id));
    if (hosts[1]) { // host + python child: the window is the user's now - kept, and it counts as running
      sessionLine(sb, { name: "J", id: "J@1", branch: "lane-j", worktree: wtOf(sb, "lane-j"), sid: "j-s1", host: hosts[1], supersedes: null });
      r = launch(sb, "J2", "--worktree", "lane-j");
      assert.equal(r.code, 3, r.err + r.out); assert.match(r.err, /already has a running session J /);
      assert.equal(alive(hosts[1].pid), true);
    }
    sessionLine(sb, { name: "U", id: "U@1", branch: "lane-u", worktree: wtOf(sb, "lane-u"), sid: "u-s1", host: { pid: 4242, start: new Date().toISOString() }, supersedes: null });
    r = runEnv(sb, { HL_FAKE_PROBE: "fail" }, ...base("U2").map((x, i) => (i === 1 ? sb.repo : i === 3 ? sb.handoff : x)), "--worktree", "lane-u");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.err, /^warning: .*@lane-u has an open session U \(gen 1, id U@1\) whose liveness is unknown \(process probe failed/m);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("an unknown flag warns and is ignored; the known set is exactly the opt/flag/val literals of launch.mjs", () => {
  const sb = sandbox();
  try {
    const r = launch(sb, "A", "--priorty", "high", "--reopen");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^warning: unknown flag --priorty \(ignored\)$/m);
    assert.doesNotMatch(r.err, /unknown flag --reopen/);
    const src = fs.readFileSync(LAUNCH, "utf8");
    const used = new Set([...src.matchAll(/\b(?:opt|flag|val)\("([a-z-]+)"/g)].map((m) => m[1]));
    const known = new Set([.../const KNOWN_FLAGS = new Set\(\[([^\]]*)\]\)/.exec(src)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...known].sort(), [...used].sort());
    assert.ok(known.has("reopen"));
  } finally { sb.cleanup(); }
});

test("--resume: --profile picks a new profile; provenance and priority are explicit; the restart guard is the union", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", sid: "s-1", profile: "python", model: "fable", effort: "xhigh", supersedes: null, scope: "Stage A" });
    let r = runEnv(sb, { CLAUDE_CODE_SESSION_ID: "s-hand" }, "--resume", "s-1", "--profile", "browser");
    assert.equal(r.code, 0, r.err);
    const n = lastLaunch(sb, "A");
    assert.deepEqual([n.profile, n.supersedes, n.launched_by, n.priority, n.scope, n.resumed_from], ["browser", a.id, "s-hand", "high", "Stage A", a.id]);
    // A relay of the resumed entry on a switched branch (same name check passes: another name) blocks a second resume.
    const b = sessionLine(sb, { name: "B", id: "B@1", sid: "s-b", branch: "b1", supersedes: null });
    sessionLine(sb, { name: "B-next", id: "B@2", sid: "s-b2", branch: "b2", supersedes: "B@1", launched_at: new Date(Date.parse(b.launched_at) + 1000).toISOString() });
    r = sb.run("--resume", "s-b");
    assert.equal(r.code, 3, r.err + r.out);
    assert.match(r.err, /--resume: an open newer launch shares the checkout of B \(B@2\)/);
    r = sb.run("--resume", "s-b", "--priority", "low", "--dry-run");
    assert.equal(r.code, 3);
  } finally { sb.cleanup(); }
});

test("a merge session launched by a lane's drain gets the scrubbed env: no launcher, so it replaces the merge worktree's previous session", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main", "--test", "node check.cjs").code, 0);
    const d = launchLane(sb, "g1", "D"), dl = lastLaunch(sb, "D");
    const scratch = path.join(sb.repo, ".claude", "worktrees", "_merge-g1").split(path.sep).join("/");
    const prev = sessionLine(sb, { name: "g1-merge-X", id: "g1-merge-X@1", group: "g1", branch: "int-g1", worktree: scratch, sid: "s-mx", supersedes: null });
    writeDone(sb, "g1", "D", commitIn(sb, d, { FAIL: "x\n" }, "D adds FAIL"));
    // The lane runs the merge from its own session: its identity is in the env.
    const r = runEnv(sb, { HL_SESSION_ID: dl.id, CLAUDE_CODE_SESSION_ID: "s-lane-d" }, "merge", "--group", "g1", "--repo", sb.repo, "--lane", "D");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /merge session g1-merge-D launched/);
    const m = lastLaunch(sb, "g1-merge-D");
    assert.deepEqual([m.launched_by, m.supersedes], [null, prev.id]);
  } finally { sb.cleanup(); }
});

test("launch.mjs resume closes the lane's dead-start window first, then relaunches it with its effective priority, replacing that entry", { skip: win }, () => {
  const sb = sandbox();
  const h = emptyHost();
  try {
    const w = sessionLine(sb, { name: "W", id: "W@2", group: "g9", branch: "w", gen: 2, sid: "w-s2", host: h, supersedes: null });
    appendLine(sb, { priority: "W", group: "g9", value: "low", at: new Date().toISOString() });
    appendLine(sb, { lane_blocked: "W", group: "g9", handoff: w.handoff, incident: "x/incidents/W-1.md", at: new Date().toISOString() });
    assert.match(sb.run("resume", "--group", "g9", "--dry-run").out, /^would close W \(gen 2\): claude exited \(closed before this launch\)$/m);
    assert.equal(alive(h.pid), true);
    const res = sb.run("resume", "--group", "g9", "--lane", "W");
    assert.equal(res.code, 0, res.err + res.out);
    assert.match(res.out, /^closed W \(gen 2\): claude exited \(closed before this launch\)$/m);
    assert.match(res.out, /^relaunched W fresh \(incident x\/incidents\/W-1\.md\); restart budget reset$/m);
    assert.equal(alive(h.pid), false);
    const w3 = sb.registry().filter((o) => o.name === "W" && o.launched_at).at(-1);
    assert.deepEqual([w3.supersedes, w3.priority, w3.launched_by], [w.id, "low", null]);
  } finally { h.kill(); sb.cleanup(); }
});

test("launch.mjs resume --group relaunches blocked lanes high priority first", () => {
  const sb = sandbox();
  try {
    const at = new Date().toISOString();
    for (const [n, effort] of [["L", "medium"], ["N", "high"], ["H", "xhigh"]]) {
      const e = sessionLine(sb, { name: n, id: `${n}@1`, group: "g8", branch: n.toLowerCase(), sid: `${n}-s1`, effort, supersedes: null });
      appendLine(sb, { lane_blocked: n, group: "g8", handoff: e.handoff, incident: `x/incidents/${n}-1.md`, at });
    }
    const r = sb.run("resume", "--group", "g8", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.split("\n").filter((l) => l.startsWith("would relaunch")).map((l) => l.split(" ")[2]), ["H", "N", "L"]);
  } finally { sb.cleanup(); }
});
```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/provenance.test.mjs claude/skills/handoff-launch/tests/liveness.test.mjs claude/skills/handoff-launch/tests/profiles-cap.test.mjs`
Expected: FAIL - launch lines have no `supersedes` key; the occupied launch exits 0; no unknown-flag warning; `--resume
--profile` keeps the old profile; the merge session records no `supersedes`; the cap still exempts the newest entry of
the branch; the chain-based `auto_close` is empty.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf } from "./merge.mjs";
import { HERE, REG_DIR, PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hasClaudeBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooks, sessionHooksFile, triggerTick, COORD, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness,
  agentsList, listedAgent } from "./live.mjs";
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine } from "./recover-lib.mjs";

const IDLE_CLOSE_MS = 10 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const dry = flag("dry-run");
// The MAIN checkout root, also when <dir> is a linked worktree: registry key, worktree parent, done-marker home.
// A timeout is no answer, never "not a git repo" (a rolling lane would launch as a legacy one); any other failure is
// git's own "not a repository" (its text is localized, so it is not parsed).
const mainRoot = (dir) => {
  const r = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (r.timedOut) { console.error(`${r.err} (in ${dir}) - nothing done; retry`); process.exit(2); }
  return r.ok ? path.dirname(path.resolve(r.out)) : null;
};
const reg = readRegistry();
const live = (e) => !reg.closed.has(e.id);
// sessionLiveness (live.mjs): the latest launch line of a session and its liveness, read fresh (the registry changes mid-run).
const mergeCtx = (root, group) => ({ readRegistry, append, launchMjs: fileURLToPath(import.meta.url), root, repoKey: key(root), group, sessionLiveness });
const rootArg = () => mainRoot(path.resolve(opt("repo", process.cwd())));
// A path with spaces stays one word for the session reading it. Single quotes: the prompt's " become ' anyway.
const qs = (p) => (/\s/.test(p) ? `'${p}'` : p);

// ---------- auto-close: windows of generations <= N-2 on this repo+branch, idle sessions only, tri-state ----------
function closeOld(repoKey, branch, n, apply) {
  const r = readRegistry();
  const cands = r.entries.filter((e) => e.repo === repoKey && e.branch === branch && e.mode === "window" && (e.generation || 0) <= n - 2 && !r.closed.has(e.id));
  primeLiveness(cands);
  const out = [];
  for (const e of cands.map(readPidFile)) {
    const tag = `${e.name} (gen ${e.generation}, pid ${e.host_pid ?? "?"})`;
    const lv = liveness(e, r);
    if (lv.state === "unknown") { out.push(`skip ${tag}: liveness unknown (${lv.why}) - nothing done`); continue; }
    if (lv.state === "gone") { if (apply) append({ closed: e.name, id: e.id, at: now(), why: lv.why }); out.push(`skip ${tag}: ${lv.why}${apply ? " - marked closed" : " - would mark closed"}`); continue; }
    const s = sessionState(e);
    let closable, why;
    if (!s.found) {
      const below = hasClaudeBelow(e.host_pid);
      if (below === null) { out.push(`skip ${tag}: no transcript and the process probe failed - nothing done`); continue; }
      closable = !below; why = closable ? "no claude running in the window" : "no transcript found but claude is running";
    } else if (!s.idle) { closable = false; why = `busy: ${s.busy.join(", ")}`; }
    // Only a turn_duration record at the turn's end says whether background agents are pending (as closeDecision): unknown keeps the window.
    else if (!s.bgKnown) { out.push(`skip ${tag}: pending background agents unknown (the turn ended without a turn_duration record) - nothing done`); continue; }
    else if (ago(s.last) < IDLE_CLOSE_MS) { out.push(`skip ${tag}: idle only ${mins(ago(s.last))} - a later launch retries`); continue; }
    else { closable = true; why = `idle ${mins(ago(s.last))}`; }
    if (!closable) { out.push(`skip ${tag}: ${why} - ${requestStop(e, `auto-close of gen ${e.generation}: ${why}`, { apply, reasonClass: "close" })}`); continue; }
    out.push(apply ? `${killTree(e, `auto-close: ${why}`, "close").line} ${tag}: ${why}` : `would close ${tag}: ${why}`);
  }
  return out;
}

```

**with**:

```js
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf } from "./merge.mjs";
import { HERE, REG_DIR, PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hostBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooks, sessionHooksFile, triggerTick, COORD, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness,
  agentsList, listedAgent, launcherEnv, forgetLiveness } from "./live.mjs";
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine } from "./recover-lib.mjs";
import * as G from "./lane-lib.mjs";
import { guardedClose } from "./recover.mjs";

const IDLE_CLOSE_MS = 10 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
// Every --flag the code reads: each opt("...")/flag("...")/val("...") literal (tests/provenance.test.mjs checks that this set
// and the code agree). The launch path warns on any other --flag and ignores it - it never refuses: other projects'
// lanes call the live launcher with whatever their handoffs say.
const KNOWN_FLAGS = new Set(["base", "dry-run", "effort", "force", "goal-from", "group", "handoff",
  "integration", "lane", "mode", "model", "name", "no-close", "no-merge", "priority", "profile", "prompt-file", "recovery", "reopen", "repo",
  "resume", "scope", "session", "skip", "stop-looping", "supersedes", "target", "test", "test-timeout-min",
  "why", "worktree", "id"]);
const dry = flag("dry-run");
// The MAIN checkout root, also when <dir> is a linked worktree: registry key, worktree parent, done-marker home.
// A timeout is no answer, never "not a git repo" (a rolling lane would launch as a legacy one); any other failure is
// git's own "not a repository" (its text is localized, so it is not parsed).
const mainRoot = (dir) => {
  const r = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (r.timedOut) { console.error(`${r.err} (in ${dir}) - nothing done; retry`); process.exit(2); }
  return r.ok ? path.dirname(path.resolve(r.out)) : null;
};
const reg = readRegistry();
const live = (e) => !reg.closed.has(e.id);
// sessionLiveness (live.mjs): the latest launch line of a session and its liveness, read fresh (the registry changes mid-run).
const mergeCtx = (root, group) => ({ readRegistry, append, launchMjs: fileURLToPath(import.meta.url), root, repoKey: key(root), group, sessionLiveness });
const rootArg = () => mainRoot(path.resolve(opt("repo", process.cwd())));
// A path with spaces stays one word for the session reading it. Single quotes: the prompt's " become ' anyway.
const qs = (p) => (/\s/.test(p) ? `'${p}'` : p);

// ---------- auto-close: the new launch's supersedes chain beyond its first link, idle sessions only, tri-state ----------
// The direct predecessor is busy launching this one (the tick closes it once idle). A legacy entry (no supersedes key)
// keeps the stage-2 rule: generations <= N-2 of its repo + branch.
function closeOld(entry, apply) {
  const r = readRegistry();
  const all = r.entries.some((x) => x.id === entry.id) ? r.entries : [...r.entries, entry];
  const set = G.hasSupersedesKey(entry) ? G.chainOf(entry, all).slice(1)
    : all.filter((e) => e.repo === entry.repo && e.branch === entry.branch && (e.generation || 0) <= (entry.generation || 0) - 2);
  const cands = set.filter((e) => e.mode === "window" && !r.closed.has(e.id));
  primeLiveness(cands);
  const out = [];
  for (const e of cands.map(readPidFile)) {
    const tag = `${e.name} (gen ${e.generation}, pid ${e.host_pid ?? "?"})`;
    const lv = liveness(e, r);
    if (lv.state === "unknown") { out.push(`skip ${tag}: liveness unknown (${lv.why}) - nothing done`); continue; }
    if (lv.state === "gone") { if (apply) append({ closed: e.name, id: e.id, at: now(), why: lv.why }); out.push(`skip ${tag}: ${lv.why}${apply ? " - marked closed" : " - would mark closed"}`); continue; }
    const s = sessionState(e);
    let closable, why;
    if (!s.found) { // only an EMPTY host closes: a job the user runs in the window after claude exited keeps it
      const below = hostBelow(e.host_pid);
      if (below === null) { out.push(`skip ${tag}: no transcript and the process probe failed - nothing done`); continue; }
      closable = below.empty; why = closable ? "no claude running in the window" : `no transcript found but its window is not empty (${below.names.join(", ")})`;
    } else if (!s.idle) { closable = false; why = `busy: ${s.busy.join(", ")}`; }
    // Only a turn_duration record at the turn's end says whether background agents are pending (as closeDecision): unknown keeps the window.
    else if (!s.bgKnown) { out.push(`skip ${tag}: pending background agents unknown (the turn ended without a turn_duration record) - nothing done`); continue; }
    else if (ago(s.last) < IDLE_CLOSE_MS) { out.push(`skip ${tag}: idle only ${mins(ago(s.last))} - a later launch retries`); continue; }
    else { closable = true; why = `idle ${mins(ago(s.last))}`; }
    if (!closable) { out.push(`skip ${tag}: ${why} - ${requestStop(e, `auto-close of gen ${e.generation}: ${why}`, { apply, reasonClass: "close" })}`); continue; }
    out.push(apply ? `${killTree(e, `auto-close: ${why}`, "close").line} ${tag}: ${why}` : `would close ${tag}: ${why}`);
  }
  return out;
}

// A window whose claude is gone (batch A, Part 3: an empty host, launched >= 2 min ago) is closed first by any launch onto
// its checkout, a --resume and `launch.mjs resume`: the guarded no-claude close (recover.mjs: the recorded host, an empty
// host re-checked right before the kill). apply false: the line it would print. -> a line, or null when e is not such a window.
function closeGone(e, apply) {
  if (e.mode !== "window" || ago(e.launched_at) < 2 * MIN) return null;
  const w = readPidFile(e);
  if (!w.host_pid) return null;
  const b = hostBelow(w.host_pid);
  if (!b?.empty) return null;
  const why = "claude exited (closed before this launch)";
  if (!apply) return `would close ${e.name} (gen ${e.generation ?? "?"}): ${why}`;
  const line = guardedClose(e, why, { dryRun: false, noClaude: true });
  forgetLiveness(e.id, { agents: false });
  return line;
}

```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
// ---------- session cap: refuse a launch while too many sessions run or free RAM is low ----------
// Config <REG_DIR>/launch-config.json {max_sessions, min_free_gb} (defaults 6 / 3). Counts the open sessions (tri-state
// liveness: running, and unknown as doubtful) except the newest counted one on this repo+branch (the predecessor a relay
// replaces). One unknown is never counted (as on main): a bg entry with neither bg_id nor session id - what a bg launch
// records when claude agents showed no new session (the spawn failed, or no match) - is unknown forever and nothing ever
// closes it, so counting it would cost every later launch and restart a slot. Exits 3 on a breach unless --force;
// --dry-run only reports. The refusal's first line starts with CAP_REFUSED: the coordinator tick recognises it there and
// defers the restart instead of blocking the lane. -> {running, max, free_gb, min_free_gb, would_refuse}.
function sessionCap(repoKey, branch) {
  const file = path.join(REG_DIR, "launch-config.json");
  let max = 6, minFree = 3;
```

**with**:

```js
// ---------- session cap: refuse a launch while too many sessions run or free RAM is low ----------
// Config <REG_DIR>/launch-config.json {max_sessions, min_free_gb} (defaults 6 / 3). Counts the open sessions (tri-state
// liveness: running, and unknown as doubtful) except the entry this launch replaces (its supersedes; batch A - none when
// supersedes is null). One unknown is never counted (as on main): a bg entry with neither bg_id nor session id - what a bg launch
// records when claude agents showed no new session (the spawn failed, or no match) - is unknown forever and nothing ever
// closes it, so counting it would cost every later launch and restart a slot. Exits 3 on a breach unless --force;
// --dry-run only reports. The refusal's first line starts with CAP_REFUSED: the coordinator tick recognises it there and
// defers the restart instead of blocking the lane. -> {running, max, free_gb, min_free_gb, would_refuse}.
function sessionCap(supersedesId) {
  const file = path.join(REG_DIR, "launch-config.json");
  let max = 6, minFree = 3;
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
    } else running.push({ e, line: `${tag}: running - host pid ${readPidFile(e).host_pid}` });
  }
  // The predecessor is picked among the sessions that count, so a dead newer entry never takes its place.
  const pred = running.filter((r) => r.e.repo === repoKey && r.e.branch === branch).reduce((a, r) => (!a || a.e.launched_at <= r.e.launched_at ? r : a), null);
  const counted = running.filter((r) => r !== pred).map((r) => r.line);
  const free = process.env.HL_FREE_GB !== undefined ? Number(process.env.HL_FREE_GB) : os.freemem() / 2 ** 30;
```

**with**:

```js
    } else running.push({ e, line: `${tag}: running - host pid ${readPidFile(e).host_pid}` });
  }
  // Only the entry this launch replaces, and only when it counts.
  const pred = supersedesId ? running.find((r) => r.e.id === supersedesId) ?? null : null;
  const counted = running.filter((r) => r !== pred).map((r) => r.line);
  const free = process.env.HL_FREE_GB !== undefined ? Number(process.env.HL_FREE_GB) : os.freemem() / 2 ** 30;
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  const g = opt("group") && slug(opt("group")), lane = opt("lane") && slug(opt("lane"));
  if (!g) { console.error("resume needs --group <id> [--lane <name>]"); process.exit(2); }
  const blocked = blockedLanes(reg.lines, g).filter((b) => !lane || b.name === lane);
  if (!blocked.length) { console.log(`no blocked lanes in group ${g}${lane ? ` named ${lane}` : ""}`); process.exit(0); }
  let code = 0;
  for (const b of blocked) {
    const e = [...reg.entries].reverse().find((x) => x.name === b.name && x.group === g);
    if (!e) { console.log(`not relaunched: no launch line for ${b.name} in group ${g}`); code = 1; continue; }
    if (!b.incident) { console.log(`not relaunched: the lane_blocked line of ${b.name} names no incident - relaunch it by hand with --recovery <incident>`); code = 1; continue; }
    // A lane whose newest launch still runs (or cannot be judged) is never relaunched: one worktree, one session.
    const lv = liveness(e, reg);
    if (lv.state !== "gone") { console.log(`not relaunched: ${e.id} is ${lv.state} (${lv.why}) - stop it or wait for it, then re-run`); code = 1; continue; }
    warnUntracked(b.name);
    if (dry) { console.log(`would relaunch ${b.name} fresh from ${e.handoff} (incident ${b.incident})`); continue; }
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", recovery: b.incident })], { encoding: "utf8", timeout: 3 * MIN });
    // {lane_resumed} only after a launch that worked: a failed one leaves the lane blocked, so a re-run tries again.
    const capWhy = capRefusal(r.status, `${r.stderr || ""}\n${r.stdout || ""}`);
    if (r.status === 0) { append({ lane_resumed: b.name, group: g, handoff: e.handoff, at: now() }); console.log(`relaunched ${b.name} fresh (incident ${b.incident}); restart budget reset`); }
    else if (capWhy) { code = 1; console.log(`not relaunched: ${b.name} - session cap (${capWhy}): close idle sessions or free RAM, then re-run (still blocked)`); }
    else { code = 1; console.log(`ERROR relaunching ${b.name}: ${`${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-5).join(" | ") || `the launcher exited ${r.status ?? r.signal ?? r.error?.code}`}`); }
  }
  process.exit(code);
}
if (sub === "profile-args") {
  // The same files a launch passes: the coordinator hooks ride in the profile's settings file (full: the hooks alone).
  console.log(JSON.stringify(profileArgs(opt("profile"), path.resolve(opt("repo", process.cwd())), sessionHooks())));
  process.exit(0);
}
if (sub) { console.error(`unknown subcommand ${sub}`); process.exit(2); }

// Never inherit the global defaults: each session is sized for its task (SKILL.md "Sizing the session"). -> the refusal
```

**with**:

```js
  const g = opt("group") && slug(opt("group")), lane = opt("lane") && slug(opt("lane"));
  if (!g) { console.error("resume needs --group <id> [--lane <name>]"); process.exit(2); }
  // High priority first (Part 7): when the cap frees one slot, the highest-priority lane gets it.
  const newestOf = (n) => [...reg.entries].reverse().find((x) => x.name === n && x.group === g);
  const blocked = G.byPriority(blockedLanes(reg.lines, g).filter((b) => !lane || b.name === lane),
    (b) => { const e = newestOf(b.name); return e ? G.effectivePriority(reg.lines, e) : "normal"; });
  if (!blocked.length) { console.log(`no blocked lanes in group ${g}${lane ? ` named ${lane}` : ""}`); process.exit(0); }
  let code = 0;
  for (const b of blocked) {
    const e = [...reg.entries].reverse().find((x) => x.name === b.name && x.group === g);
    if (!e) { console.log(`not relaunched: no launch line for ${b.name} in group ${g}`); code = 1; continue; }
    if (!b.incident) { console.log(`not relaunched: the lane_blocked line of ${b.name} names no incident - relaunch it by hand with --recovery <incident>`); code = 1; continue; }
    // A lane whose newest launch still runs (or cannot be judged) is never relaunched: one worktree, one session. A dead
    // start (its window open, claude gone) is closed first (batch A, Part 3).
    let lv = liveness(e, reg);
    if (lv.state === "running") { const c = closeGone(e, !dry); if (c) { console.log(c); lv = dry ? { state: "gone", why: "would be closed" } : liveness(e, readRegistry()); } }
    if (lv.state !== "gone") { console.log(`not relaunched: ${e.id} is ${lv.state} (${lv.why}) - stop it or wait for it, then re-run`); code = 1; continue; }
    warnUntracked(b.name);
    if (dry) { console.log(`would relaunch ${b.name} fresh from ${e.handoff} (incident ${b.incident})`); continue; }
    // A relaunch keeps the lane's effective priority and replaces its newest entry; the scrubbed env keeps this session
    // (if one runs this command) out of its provenance.
    const fa = freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", recovery: b.incident, priority: G.effectivePriority(reg.lines, e), supersedes: e.id });
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...fa], { encoding: "utf8", timeout: 3 * MIN, env: launcherEnv() });
    // {lane_resumed} only after a launch that worked: a failed one leaves the lane blocked, so a re-run tries again.
    const capWhy = capRefusal(r.status, `${r.stderr || ""}\n${r.stdout || ""}`);
    if (r.status === 0) { append({ lane_resumed: b.name, group: g, handoff: e.handoff, at: now() }); console.log(`relaunched ${b.name} fresh (incident ${b.incident}); restart budget reset`); }
    else if (capWhy) { code = 1; console.log(`not relaunched: ${b.name} - session cap (${capWhy}): close idle sessions or free RAM, then re-run (still blocked)`); }
    else { code = 1; console.log(`ERROR relaunching ${b.name}: ${`${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-5).join(" | ") || `the launcher exited ${r.status ?? r.signal ?? r.error?.code}`}`); }
  }
  process.exit(code);
}
if (sub === "profile-args") {
  // The same files a launch passes: the coordinator hooks ride in the profile's settings file (full: the hooks alone).
  console.log(JSON.stringify(profileArgs(opt("profile"), path.resolve(opt("repo", process.cwd())), sessionHooks())));
  process.exit(0);
}
if (sub) { console.error(`unknown subcommand ${sub}`); process.exit(2); }
for (const a of args) if (a.startsWith("--") && !KNOWN_FLAGS.has(a.slice(2))) console.error(`warning: unknown flag ${a} (ignored)`);
const prioArg = opt("priority");
if (flag("priority") && !G.PRIORITIES.includes(prioArg)) { console.error(`--priority must be high, normal or low, got ${prioArg}`); process.exit(2); }

// Never inherit the global defaults: each session is sized for its task (SKILL.md "Sizing the session"). -> the refusal
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  const newest = [...reg.entries].reverse().find((e) => e.name === prev.name && e.repo === prev.repo);
  if (newest.id !== prev.id) { console.error(`--resume: ${prev.name} has a newer launch (${newest.id}) - only the newest generation is resumed, so two sessions never share a worktree`); return 3; }
  if (prev.mode === "bg") { console.error(`--resume: ${prev.name} is a background session - background lanes restart fresh`); return 2; }
  // A restart only after the old process is confirmed gone: running or unknown would put two sessions in one worktree.
  const lv = liveness(prev, reg);
  if (lv.state !== "gone") { console.error(`--resume: ${prev.id} is ${lv.state} (${lv.why}) - stop it or wait, then re-run`); return 1; }
  if (!prev.worktree || !fs.existsSync(prev.worktree)) { console.error(`--resume: the worktree of ${prev.name} (${prev.worktree}) no longer exists - restart it fresh`); return 2; }
  const m = opt("model") || prev.model || "opus", ef = opt("effort") || prev.effort || "high";
  const se = sizeError(m, ef);
  if (se) { console.error(`--resume: ${se}`); return 2; }
  // The session cap, before any side effect (as a launch's): a resume starts a session too. A refusal exits 3 with the
  // CAP_REFUSED line, which the tick reads as "deferred". Merge sessions are exempt.
  const cap = prev.group && isMergeSession(prev.group, prev.name) ? { exempt: "merge session" } : sessionCap(prev.repo, prev.branch);
  warnUntracked(prev.name);
  // The same conversation keeps its profile; an entry from before profiles ran with every plugin and server: full.
  // MCP servers from the real dirs, as a fresh launch reads them: the worktree, then the main checkout (never the
  // registry key - a lowercased path).
  const wd = path.resolve(prev.worktree), wdRoot = mainRoot(wd);
  const prof = profileArgs(prev.profile || "full", [...new Map([wd, wdRoot].filter(Boolean).map((d) => [key(d), d])).values()], sessionHooks());
  const st = new Date().toISOString().replace(/[:.]/g, "-"), rid = `${prev.name}@${st}`, pf = path.join(PID_DIR, `${stem(rid)}.pid`);
  const gen = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === prev.repo && e.branch === prev.branch).map((e) => e.generation || 0));
  const text = (opt("recovery") ? RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))
    : "Resumed by the launcher: continue from your saved state and ledger resume point - re-check the repo state first, then carry on with your next step.").replace(/"/g, "'").replace(/;/g, ",");
  const e = { ...prev, id: rid, generation: gen, launched_at: now(), host_pid: null, host_start: null, pid_file: fwd(pf), model: m, effort: ef, coord: 1, resumed_from: prev.id, profile: prof.profile };
  delete e.no_spawn; delete e.bg_output;
  sessionHooksFile({ write: !dry }); // the inspectable copy of the hooks; the session gets them in the profile's file
```

**with**:

```js
  const newest = [...reg.entries].reverse().find((e) => e.name === prev.name && e.repo === prev.repo);
  if (newest.id !== prev.id) { console.error(`--resume: ${prev.name} has a newer launch (${newest.id}) - only the newest generation is resumed, so two sessions never share a worktree`); return 3; }
  // The restart guard is the union (batch A): also an open entry newer on its repo + branch, or with it in its chain.
  const blockers = G.restartBlockers(prev, reg.entries, reg.closed);
  if (blockers.length) { console.error(`--resume: an open newer launch shares the checkout of ${prev.name} (${blockers.map((b) => b.id).join(", ")}) - two sessions never share a worktree`); return 3; }
  if (prev.mode === "bg") { console.error(`--resume: ${prev.name} is a background session - background lanes restart fresh`); return 2; }
  // A restart only after the old process is confirmed gone: running or unknown would put two sessions in one worktree.
  // A window whose claude is gone (an empty host) is closed first (batch A, Part 3).
  let lv = liveness(prev, reg);
  if (lv.state === "running") { const c = closeGone(prev, !dry); if (c) { console.error(c); lv = dry ? { state: "gone", why: "would be closed" } : liveness(prev, readRegistry()); } }
  if (lv.state !== "gone") { console.error(`--resume: ${prev.id} is ${lv.state} (${lv.why}) - stop it or wait, then re-run`); return 1; }
  if (!prev.worktree || !fs.existsSync(prev.worktree)) { console.error(`--resume: the worktree of ${prev.name} (${prev.worktree}) no longer exists - restart it fresh`); return 2; }
  const m = opt("model") || prev.model || "opus", ef = opt("effort") || prev.effort || "high";
  const se = sizeError(m, ef);
  if (se) { console.error(`--resume: ${se}`); return 2; }
  // The session cap, before any side effect (as a launch's): a resume starts a session too. A refusal exits 3 with the
  // CAP_REFUSED line, which the tick reads as "deferred". Merge sessions are exempt.
  const cap = prev.group && isMergeSession(prev.group, prev.name) ? { exempt: "merge session" } : sessionCap(prev.id);
  warnUntracked(prev.name);
  // The same conversation keeps its profile; an entry from before profiles ran with every plugin and server: full.
  // MCP servers from the real dirs, as a fresh launch reads them: the worktree, then the main checkout (never the
  // registry key - a lowercased path).
  const wd = path.resolve(prev.worktree), wdRoot = mainRoot(wd);
  // --profile picks a new profile for the resumed session (recorded on the new entry); else the entry's, full without one.
  const prof = profileArgs(opt("profile") || prev.profile || "full", [...new Map([wd, wdRoot].filter(Boolean).map((d) => [key(d), d])).values()], sessionHooks());
  const st = new Date().toISOString().replace(/[:.]/g, "-"), rid = `${prev.name}@${st}`, pf = path.join(PID_DIR, `${stem(rid)}.pid`);
  const gen = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === prev.repo && e.branch === prev.branch).map((e) => e.generation || 0));
  const text = (opt("recovery") ? RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))
    : "Resumed by the launcher: continue from your saved state and ledger resume point - re-check the repo state first, then carry on with your next step.").replace(/"/g, "'").replace(/;/g, ",");
  // Provenance and priority are set explicitly, never inherited through ...prev (batch A): the resumed entry is what this
  // launch replaces; a resume keeps the lane's effective priority unless --priority.
  const e = { ...prev, id: rid, generation: gen, launched_at: now(), host_pid: null, host_start: null, pid_file: fwd(pf), model: m, effort: ef, coord: 1, resumed_from: prev.id, profile: prof.profile,
    launched_by: process.env.CLAUDE_CODE_SESSION_ID || null, supersedes: prev.id, scope: prev.scope ?? null, priority: opt("priority") || G.effectivePriority(reg.lines, prev) };
  delete e.no_spawn; delete e.bg_output;
  sessionHooksFile({ write: !dry }); // the inspectable copy of the hooks; the session gets them in the profile's file
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  return b.branch || "HEAD";
};
const cap = group && isMergeSession(group, name) ? { exempt: "merge session" } : sessionCap(key(root || repo), capBranch());

// Group guards run before any worktree is created or touched.
```

**with**:

```js
  return b.branch || "HEAD";
};
// ---------- provenance (batch A, Part 1): supersedes, and the occupancy check, before any side effect ----------
// The checkout this launch runs in: --worktree's existing worktree for the branch, or the one it creates; else --repo.
const targetDir = (() => {
  if (!wtBranch) return repo;
  const wl = worktrees(root), hit = wl.ok ? wl.list.find((w) => w.branch === `refs/heads/${wtBranch}` && !w.prunable) : null;
  return hit ? path.resolve(hit.worktree) : path.join(root, ".claude", "worktrees", slug(wtBranch));
})();
const target = { repo: key(root || repo), branch: capBranch(), worktree: fwd(targetDir) };
const explicitSup = opt("supersedes");
if (flag("supersedes") && (!explicitSup || explicitSup.startsWith("--"))) { console.error("--supersedes needs the registry id of the session this launch replaces"); process.exit(2); }
if (explicitSup && !reg.entries.some((e) => e.id === explicitSup)) { console.error(`--supersedes: no launch line has id ${explicitSup}`); process.exit(2); }
const prov = G.pickSupersedes({ entries: reg.entries, closed: reg.closed, explicit: explicitSup, hlSessionId: process.env.HL_SESSION_ID || null,
  launchedBy: process.env.CLAUDE_CODE_SESSION_ID || null, target, name, isMerge: !!group && isMergeSession(group, name) });
if (prov.note) console.error(prov.note);
// Two sessions must never share a worktree. Every fresh launch closes the target's windows whose claude is gone (an empty
// host); a launch that replaces nothing (rule 5) is refused while the target's session really runs (exit 3) unless
// --force (ask the user first); unknown liveness only warns; --dry-run reports and refuses or closes nothing.
const occupancy = { refused: null, closes: [], warnings: [] };
{
  const occ = reg.entries.filter((e) => !reg.closed.has(e.id) && G.sameCheckout(e, target));
  primeLiveness(occ);
  for (const e of occ) {
    const lv = liveness(e, reg);
    const below = lv.state === "running" && e.mode !== "bg" ? hostBelow(readPidFile(e).host_pid) : null;
    const a = G.occupantAct({ e, lv, below, ageMs: ago(e.launched_at) });
    if (a.act === "warn") occupancy.warnings.push(G.OCCUPANT_UNKNOWN({ repo: fwd(root || repo), branch: target.branch, e, why: a.why }));
    else if (a.act === "close") occupancy.closes.push(e);
    else if (a.act === "refuse" && prov.rule === "none" && !occupancy.refused) occupancy.refused = e;
  }
  for (const w of occupancy.warnings) console.error(w);
  if (occupancy.refused) {
    const text = G.OCCUPIED({ repo: fwd(root || repo), branch: target.branch, e: occupancy.refused });
    if (dry) console.error(`would be ${text}`);
    else if (flag("force")) console.error(`occupancy overridden by --force: ${text}`);
    else { console.error(text); process.exit(3); }
  }
  for (const e of occupancy.closes) { const c = closeGone(e, !dry); if (c) console.error(c); }
}
const cap = group && isMergeSession(group, name) ? { exempt: "merge session" } : sessionCap(prov.supersedes);

// Group guards run before any worktree is created or touched.
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  model, effort, coord: 1, prompt_file: fwd(promptFile),
  profile: laneProfile.profile, // a restart reuses it: --resume (this entry's), the tick's fresh restart (--profile <it>)
};
const noSpawn = process.env.HL_NO_SPAWN === "1";
```

**with**:

```js
  model, effort, coord: 1, prompt_file: fwd(promptFile),
  profile: laneProfile.profile, // a restart reuses it: --resume (this entry's), the tick's fresh restart (--profile <it>)
  // batch A: provenance (Part 1), the lane note's scope (Part 5), priority (Part 7)
  launched_by: process.env.CLAUDE_CODE_SESSION_ID || null, supersedes: prov.supersedes,
  scope: opt("scope") ?? (() => { try { return G.scopeOf(fs.readFileSync(handoff, "utf8")); } catch { return null; } })(),
  priority: prioArg || G.derivePriority({ model, effort }),
};
const noSpawn = process.env.HL_NO_SPAWN === "1";
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, launcher: ps1, command: [exe, ...exeArgs], cap };
if (dry) {
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(repoKey, branch, generation, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
const { launched, latency } = spawnWindow({ entry, ps1, script, exe, exeArgs, workDir });
append(launched);
// The tick judges loops, not the launch (the launch-time watchdog is gone): a launch only wakes it.
triggerTick("launch");
if (!launched.host_pid) {
  console.log(`launched, but no pid file after 20 s (${fwd(pidFile)}) - auto-close skipped, check the window`);
} else {
  console.log(`launched: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${generation} of ${branch}`);
  for (const l of noClose ? ["auto-close disabled (--no-close)"] : closeOld(repoKey, branch, generation, true)) console.log(l);
}
```

**with**:

```js
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, launcher: ps1, command: [exe, ...exeArgs], cap };
if (dry) {
  report.occupancy = { refused: occupancy.refused?.id ?? null, would_close: occupancy.closes.map((e) => e.id) };
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(entry, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
const { launched, latency } = spawnWindow({ entry, ps1, script, exe, exeArgs, workDir });
append(launched);
// The tick judges loops, not the launch (the launch-time watchdog is gone): a launch only wakes it.
triggerTick("launch");
if (!launched.host_pid) {
  console.log(`launched, but no pid file after 20 s (${fwd(pidFile)}) - auto-close skipped, check the window`);
} else {
  console.log(`launched: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${generation} of ${branch}`);
  for (const l of noClose ? ["auto-close disabled (--no-close)"] : closeOld(launched, true)) console.log(l);
}
```

**Replace** in `claude/skills/handoff-launch/merge.mjs`:

```js
import { spawnSync } from "node:child_process";
import * as L from "./merge-lib.mjs";
import { MIN, writeAtomic, pidAlive, procStart, selfStart, latestLaunch } from "./live.mjs";
import { blockedLanes } from "./recover-lib.mjs";

```

**with**:

```js
import { spawnSync } from "node:child_process";
import * as L from "./merge-lib.mjs";
import { MIN, writeAtomic, pidAlive, procStart, selfStart, latestLaunch, launcherEnv } from "./live.mjs";
import { blockedLanes } from "./recover-lib.mjs";

```

**Replace** in `claude/skills/handoff-launch/merge.mjs`:

```js
  const started = iso();
  const p = spawnSync(process.execPath, [ctx.launchMjs, "--repo", ctx.root, "--handoff", file, "--group", ctx.group, "--name", name,
    "--model", "opus", "--effort", "high", "--worktree", cfg.integration, "--mode", cfg.mode, "--no-close"], { encoding: "utf8", timeout: 3 * MIN });
  const what = r.result === "conflict" ? `CONFLICT ${lane.name}: ${r.conflicts.length} file(s): ${r.conflicts.join(", ")}`
    : `TEST FAILED ${lane.name} (${r.exit ?? `exit ${r.code}`}) after a clean merge`;
```

**with**:

```js
  const started = iso();
  const p = spawnSync(process.execPath, [ctx.launchMjs, "--repo", ctx.root, "--handoff", file, "--group", ctx.group, "--name", name,
    "--model", "opus", "--effort", "high", "--worktree", cfg.integration, "--mode", cfg.mode, "--no-close"], { encoding: "utf8", timeout: 3 * MIN, env: launcherEnv() });
  // launcherEnv: no HL_SESSION_ID / CLAUDE_CODE_SESSION_ID of the lane that ran the drain, so the merge session's
  // supersedes is the merge worktree's newest open entry (batch A, Part 1 rule 4), never the lane.
  const what = r.result === "conflict" ? `CONFLICT ${lane.name}: ${r.conflicts.length} file(s): ${r.conflicts.join(", ")}`
    : `TEST FAILED ${lane.name} (${r.exit ?? `exit ${r.code}`}) after a clean merge`;
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/provenance.test.mjs claude/skills/handoff-launch/tests/liveness.test.mjs claude/skills/handoff-launch/tests/profiles-cap.test.mjs claude/skills/handoff-launch/tests/restart.test.mjs`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/launch.mjs claude/skills/handoff-launch/merge.mjs claude/skills/handoff-launch/tests
git commit -m "launch: provenance (launched_by, supersedes, scope, priority), the occupancy check, chain close, union resume guard, unknown-flag warnings"
```

---

### Task 7: The merge queue by priority (T2a) and FINAL_READY tags (T2f)

**Files:**
- Modify: `claude/skills/handoff-launch/merge-lib.mjs` (imports, `mergeQueue` `:76-82`, `finalReadyText` `:124-130`,
  `conflictHandoff` `:155`)
- Modify: `claude/skills/handoff-launch/merge.mjs` (imports, after `groupDir` `:51`, `groupLanes` `:171`,
  `launchMergeSession` `:306`, `drain` `:481`)
- Test: `claude/skills/handoff-launch/tests/merge-lib.test.mjs` (two new tests)

**Interfaces:**
- Consumes: Task 2 `byPriority`, `effectivePriority`, `inboxItems`.
- Produces: lanes of `groupLanes` carry `priority`; `mergeQueue` sorts priority -> `Date.parse(marker.at)` (unreadable
  last) -> name; `finalReadyText(group, cfg, lanes, {queued, unread})`; `inboxDir(root, group)`,
  `inboxInfo(root, group, lanes) -> {queued: {n, path}|null, unread: [[lane, n]]}`; `conflictHandoff` names the lane's
  inbox (read only) when it exists. Task 8 imports `inboxDir`.

- [ ] **Step 1: Write the failing tests**

**Replace** in `claude/skills/handoff-launch/tests/merge-lib.test.mjs`:

```js
  assert.equal(L.mergeTag(c[1]), "LOOP-BLOCKED (incident x/incidents/b-3.md - resume: launch.mjs resume --group g --lane b)");
});
```

**with**:

```js
  assert.equal(L.mergeTag(c[1]), "LOOP-BLOCKED (incident x/incidents/b-3.md - resume: launch.mjs resume --group g --lane b)");
});

test("batch A: the merge queue orders by priority, then the marker's at as a time (unreadable last), then the name", () => {
  const q = (l) => ({ name: l.name, state: "queued", priority: l.p, marker: { status: "done", head: "h", at: l.at } });
  const c = [q({ name: "late", p: "normal", at: "2026-01-02T00:00:00Z" }), q({ name: "early", p: "normal", at: "2026-01-01T09:00:00+05:00" }),
    q({ name: "junk", p: "normal", at: "not a time" }), q({ name: "hi", p: "high", at: "2026-01-03T00:00:00Z" }), q({ name: "lo", p: "low", at: "2025-01-01T00:00:00Z" })];
  assert.deepEqual(L.mergeQueue(c).map((l) => l.name), ["hi", "early", "late", "junk", "lo"]);
  assert.deepEqual(L.mergeQueue(c, "lo").map((l) => l.name), ["lo", "hi", "early", "late", "junk"]);
});

test("batch A: finalReadyText keeps next_after_merge for merged lanes only and adds the held, queued and unread keys when non-empty", () => {
  const lane = (name, state, items) => ({ name, state, marker: { next_after_merge: items } });
  const cfg = { integration: "int", target: "main" };
  const t = L.finalReadyText("g1", cfg, [lane("a", "merged", ["a2"]), lane("b", "loop-blocked", ["b2"]), lane("c", "blocked", [])],
    { queued: { n: 2, path: "C:/r/.superpowers/sessions/g1/inbox/_after-merge.md" }, unread: [["b", 1]] });
  assert.match(t, / next_after_merge=\{"a":\["a2"\]\} held_next_after_merge=\{"b":\{"state":"loop-blocked","items":\["b2"\]\}\} queued_after_merge=2 \(C:\/r\/\.superpowers\/sessions\/g1\/inbox\/_after-merge\.md\) unread_inbox=\[b:1\]$/);
  assert.match(L.finalReadyText("g1", cfg, [lane("a", "merged", [])]), / next_after_merge=\{\}$/);
});
```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/merge-lib.test.mjs`
Expected: FAIL - the queue is `["lo", "early", "late", "hi", "junk"]` (a string sort of `at`, no priority); FINAL_READY lists
`b`'s items under `next_after_merge` and has no `held_next_after_merge`.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/merge-lib.mjs`:

```js
// in, so tests/merge-lib.test.mjs covers every decision directly.
import path from "node:path";

export const slug = (s) => String(s).replace(/[^\w.-]+/g, "-").slice(0, 60);
```

**with**:

```js
// in, so tests/merge-lib.test.mjs covers every decision directly.
import path from "node:path";
import { byPriority } from "./lane-lib.mjs";

export const slug = (s) => String(s).replace(/[^\w.-]+/g, "-").slice(0, 60);
```

**Replace** in `claude/skills/handoff-launch/merge-lib.mjs`:

```js
  });
}
export function mergeQueue(classified, prefer) {
  const q = classified.filter((l) => l.state === "queued")
    .sort((a, b) => String(a.marker.at ?? "").localeCompare(String(b.marker.at ?? "")) || a.name.localeCompare(b.name));
  const i = prefer ? q.findIndex((l) => l.name === prefer) : -1;
  if (i > 0) q.unshift(...q.splice(i, 1));
```

**with**:

```js
  });
}
// The rolling-merge queue (batch A, Part 7; fixes T2a): priority (l.priority, from groupLanes), then the done marker's
// `at` compared as a time (an unreadable `at` sorts last), then the name. prefer: that lane goes first.
const atMs = (l) => { const t = Date.parse(l.marker?.at); return Number.isFinite(t) ? t : Infinity; };
export function mergeQueue(classified, prefer) {
  const q = byPriority(classified.filter((l) => l.state === "queued"), (l) => l.priority,
    (a, b) => (atMs(a) === atMs(b) ? 0 : atMs(a) < atMs(b) ? -1 : 1) || a.name.localeCompare(b.name));
  const i = prefer ? q.findIndex((l) => l.name === prefer) : -1;
  if (i > 0) q.unshift(...q.splice(i, 1));
```

**Replace** in `claude/skills/handoff-launch/merge-lib.mjs`:

```js
  + `status --group ${group}, and on all_done=true merge_launched=false launch the group's merge handoff as ${group}-merge `
  + "(handoff-launch SKILL.md section 4, legacy groups)";
export function finalReadyText(group, cfg, lanes) {
  const next = Object.fromEntries(lanes.filter((l) => l.marker?.next_after_merge?.length).map((l) => [l.name, l.marker.next_after_merge]));
  const notMerged = lanes.filter((l) => l.state !== "merged").map((l) => l.name);
  return `FINAL_READY ${group}: every lane is merged or blocked${notMerged.length ? ` (not merged: ${notMerged.join(", ")})` : ""}`
    + ` - ${cfg.integration} is ready for the final merge into ${cfg.target}, which needs the user's approval`
    + ` (never push without asking). next_after_merge=${JSON.stringify(next)}`;
}

```

**with**:

```js
  + `status --group ${group}, and on all_done=true merge_launched=false launch the group's merge handoff as ${group}-merge `
  + "(handoff-launch SKILL.md section 4, legacy groups)";
// FINAL_READY (batch A, Part 6; fixes T2f): next_after_merge= lists merged lanes' items only (same key and shape as
// before); held_next_after_merge= the unmerged lanes' items with their state (they wait until that lane is resumed and
// merged); queued_after_merge= and unread_inbox= when non-empty. extra: {queued: {n, path} | null, unread: [[lane, n]]}.
export function finalReadyText(group, cfg, lanes, { queued = null, unread = [] } = {}) {
  const items = (l) => (Array.isArray(l.marker?.next_after_merge) ? l.marker.next_after_merge : []);
  const next = Object.fromEntries(lanes.filter((l) => l.state === "merged" && items(l).length).map((l) => [l.name, items(l)]));
  const held = Object.fromEntries(lanes.filter((l) => l.state !== "merged" && items(l).length).map((l) => [l.name, { state: l.state, items: items(l) }]));
  const notMerged = lanes.filter((l) => l.state !== "merged").map((l) => l.name);
  return `FINAL_READY ${group}: every lane is merged or blocked${notMerged.length ? ` (not merged: ${notMerged.join(", ")})` : ""}`
    + ` - ${cfg.integration} is ready for the final merge into ${cfg.target}, which needs the user's approval`
    + ` (never push without asking). next_after_merge=${JSON.stringify(next)}`
    + (Object.keys(held).length ? ` held_next_after_merge=${JSON.stringify(held)}` : "")
    + (queued?.n ? ` queued_after_merge=${queued.n} (${queued.path})` : "")
    + (unread?.length ? ` unread_inbox=[${unread.map(([l, n]) => `${l}:${n}`).join(",")}]` : "");
}

```

**Replace** in `claude/skills/handoff-launch/merge-lib.mjs`:

```js
    `- Test command: ${p.test ? `\`${p.test}\`` : "(none configured)"}`,
    ...(overlap.length ? ["- Files this lane shares with lanes still running (they merge later):", ...overlap] : []),
    ...(p.output ? ["", "## Output", fence(p.output)] : []),
    "", "## Steps",
```

**with**:

```js
    `- Test command: ${p.test ? `\`${p.test}\`` : "(none configured)"}`,
    ...(overlap.length ? ["- Files this lane shares with lanes still running (they merge later):", ...overlap] : []),
    ...(p.inbox ? [`- The lane's inbox (read only: items other lanes queued for it; the lane takes them at its next launch): ${p.inbox}`] : []),
    ...(p.output ? ["", "## Output", fence(p.output)] : []),
    "", "## Steps",
```

**Replace** in `claude/skills/handoff-launch/merge.mjs`:

```js
import { MIN, writeAtomic, pidAlive, procStart, selfStart, latestLaunch, launcherEnv } from "./live.mjs";
import { blockedLanes } from "./recover-lib.mjs";

export { writeAtomic }; // live.mjs's: one copy, which also removes its .tmp when the rename fails (D1)
```

**with**:

```js
import { MIN, writeAtomic, pidAlive, procStart, selfStart, latestLaunch, launcherEnv } from "./live.mjs";
import { blockedLanes } from "./recover-lib.mjs";
import { effectivePriority, inboxItems } from "./lane-lib.mjs";

export { writeAtomic }; // live.mjs's: one copy, which also removes its .tmp when the rename fails (D1)
```

**Replace** in `claude/skills/handoff-launch/merge.mjs`:

```js
}
export const groupDir = (root, group) => path.join(root, ".superpowers", "sessions", group);
export const mergeWorktree = (root, group) => path.join(root, ".claude", "worktrees", `_merge-${group}`);
const lockFile = (gd) => path.join(gd, "merge.lock");
```

**with**:

```js
}
export const groupDir = (root, group) => path.join(root, ".superpowers", "sessions", group);
// A group's inbox (batch A, Part 6): <lane>.md per lane, _after-merge.md for work that waits until the running lanes merge.
export const inboxDir = (root, group) => path.join(groupDir(root, group), "inbox");
const countItems = (f) => { try { return inboxItems(fs.readFileSync(f, "utf8")); } catch { return 0; } };
// -> {queued: {n, path} | null, unread: [[lane, n]]} for FINAL_READY
export function inboxInfo(root, group, lanes) {
  const dir = inboxDir(root, group), am = path.join(dir, "_after-merge.md"), n = countItems(am);
  return { queued: n ? { n, path: L.fwd(am) } : null, unread: lanes.map((l) => [l.name, countItems(path.join(dir, `${l.name}.md`))]).filter(([, k]) => k > 0) };
}
export const mergeWorktree = (root, group) => path.join(root, ".claude", "worktrees", `_merge-${group}`);
const lockFile = (gd) => path.join(gd, "merge.lock");
```

**Replace** in `claude/skills/handoff-launch/merge.mjs`:

```js
      } else if (c.code !== 1) mergeUnknown = c.timedOut ? c.err : `git rev-parse ${head} failed: ${c.err || `exit ${c.code}`}`;
    }
    return { name: e.name, branch: e.branch, entry: e, marker, overlap, loopBlocked: blocked.get(e.name) ?? null, merged, mergeUnknown, mergedSha: mergedRec?.sha ?? null, mergeBlocked: rec("merge_blocked")?.why ?? null };
  });
}
```

**with**:

```js
      } else if (c.code !== 1) mergeUnknown = c.timedOut ? c.err : `git rev-parse ${head} failed: ${c.err || `exit ${c.code}`}`;
    }
    return { name: e.name, branch: e.branch, entry: e, marker, overlap, loopBlocked: blocked.get(e.name) ?? null, merged, mergeUnknown, mergedSha: mergedRec?.sha ?? null, mergeBlocked: rec("merge_blocked")?.why ?? null,
      priority: effectivePriority(lines, e) };
  });
}
```

**Replace** in `claude/skills/handoff-launch/merge.mjs`:

```js
    output: r.output, code: r.code, exit: r.exit, test: cfg.test, overlap: lanes.find((l) => l.name === lane.name)?.overlap,
    launchMjs: L.fwd(ctx.launchMjs), root: L.fwd(ctx.root), at: iso(), session: name,
  }));
  if (!ownsLock(gd, token)) return { ok: false, lines: ["ERROR lost merge.lock before launching the merge session - nothing launched"] };
```

**with**:

```js
    output: r.output, code: r.code, exit: r.exit, test: cfg.test, overlap: lanes.find((l) => l.name === lane.name)?.overlap,
    launchMjs: L.fwd(ctx.launchMjs), root: L.fwd(ctx.root), at: iso(), session: name,
    inbox: fs.existsSync(path.join(inboxDir(ctx.root, ctx.group), `${lane.name}.md`)) ? L.fwd(path.join(inboxDir(ctx.root, ctx.group), `${lane.name}.md`)) : null,
  }));
  if (!ownsLock(gd, token)) return { ok: false, lines: ["ERROR lost merge.lock before launching the merge session - nothing launched"] };
```

**Replace** in `claude/skills/handoff-launch/merge.mjs`:

```js
  }
  const { lanes } = lanesNow(ctx, cfg);
  if (L.finalReady(lanes) && !readLock(gd)) out.push(L.finalReadyText(ctx.group, cfg, lanes));
  if (!out.length) out.push("nothing to merge");
  return { code: 0, lines: out };
```

**with**:

```js
  }
  const { lanes } = lanesNow(ctx, cfg);
  if (L.finalReady(lanes) && !readLock(gd)) out.push(L.finalReadyText(ctx.group, cfg, lanes, inboxInfo(ctx.root, ctx.group, lanes)));
  if (!out.length) out.push("nothing to merge");
  return { code: 0, lines: out };
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/merge-lib.test.mjs claude/skills/handoff-launch/tests/merge.test.mjs claude/skills/handoff-launch/tests/status.test.mjs`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/merge-lib.mjs claude/skills/handoff-launch/merge.mjs claude/skills/handoff-launch/tests
git commit -m "merge: queue by priority then marker time (T2a); FINAL_READY tags held, queued and unread items (T2f)"
```

---

### Task 8: `queue`, the inbox, `priority`, `sessions`, the GOAL sentence, status order and notes

**Files:**
- Modify: `claude/skills/handoff-launch/launch.mjs` (imports, `KNOWN_FLAGS`, new `laneNotes` before `reportOnlyLine`,
  `rollingStatus` `:272-274`, legacy status `:319`, new `queue`/`priority`/`sessions` before `profile-args`, the pointer
  prompt `:675-688`, the `%` check `:694-700`, the bg spawn `:732-738`, the dry-run report, the window spawn `:764`)
- Test: `claude/skills/handoff-launch/tests/lanes.test.mjs` (new)

**Interfaces:**
- Consumes: Task 2 `inboxBlock`, `inboxItems`, `INBOX_SENTENCE`, `takenName`, `byPriority`, `effectivePriority`,
  `PRIORITIES`; Task 3 `parseGoal`, `goalNote`; Task 4 `goalOf`, `projectKey`; Task 6 `KNOWN_FLAGS`, the provenance;
  Task 7 `inboxDir`, FINAL_READY.
- Produces: `launch.mjs queue --to <lane> [--group] [--repo] (--text|--text-file) [--after-merge] [--from]` ->
  `queued for <lane>: <path> (<n> items)`; `launch.mjs priority --name <lane> [--group] --set <p>` -> a
  `{priority: <name>, group, value, at}` line; `launch.mjs sessions [--repo]`; the inbox take
  (`<lane>.<stamp>.taken.md`, the prompt's ` Read your inbox first: <path> - items other lanes queued for you.`, never
  in `prompt_file`); the pointer sentence ` Write or re-read GOAL.md in your session scratchpad first (one goal line,
  then checkable items) and tick each item the moment it is done.`; the done-marker text is `doneMarkerNote`; status
  lists high -> normal -> low and adds `DEAD-START (since <at>)`, `inbox=<n>`, `goal=...`; the dry-run report's
  `occupancy.inbox`.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/lanes.test.mjs`:

```js
// Batch A, Parts 6, 7 and 9 at the command line: queue and the inbox, FINAL_READY, priority (command, status order),
// and `launch.mjs sessions` / status checklists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, launchLane, commitIn, writeDone, writeTranscript, setAgents, tx, LAUNCH } from "./helpers.mjs";
import { projectKey } from "../live.mjs";

const lastLaunch = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name).at(-1);
const inboxOf = (sb, g, lane) => path.join(sb.repo, ".superpowers", "sessions", g, "inbox", `${lane}.md`);

test("queue appends one block per item; a fresh launch of the lane takes it (prompt only, never prompt_file); --resume and --dry-run never take", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A");
    const a = lastLaunch(sb, "A");
    let r = sb.run("queue", "--to", "A", "--text", "fix the parser");
    assert.equal(r.code, 0, r.err);
    const f = inboxOf(sb, "g1", "A").split(path.sep).join("/");
    assert.equal(r.out, `queued for A: ${f} (1 items)\n`);
    const tf = path.join(sb.tmp, "item.md"); fs.writeFileSync(tf, "update the docs\nwith care\n");
    r = sb.run("queue", "--to", "A", "--text-file", tf, "--from", "B");
    assert.match(r.out, /\(2 items\)$/m);
    assert.match(fs.readFileSync(f, "utf8"), /^## \d{4}-\d\d-\d\dT\S+ from user\n\nfix the parser\n\n## \d{4}-\d\d-\d\dT\S+ from B\n\nupdate the docs\nwith care\n\n$/);
    assert.match(sb.run("status", "--group", "g1").out, /^A .*  inbox=2$/m);
    // --dry-run never takes; --resume continues the same stage and never takes.
    r = sb.run("--repo", wt, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--group", "g1", "--supersedes", a.id, "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).occupancy.inbox, f);
    assert.doesNotMatch(JSON.parse(r.out).prompt, /inbox/);
    assert.equal(sb.run("--resume", a.session_id).code, 0);
    assert.equal(fs.existsSync(f), true);
    // The lane's next fresh launch takes it.
    r = sb.run("--repo", wt, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--group", "g1", "--supersedes", lastLaunch(sb, "A").id);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out), taken = fs.readdirSync(path.dirname(f)).filter((n) => /^A\..*\.taken\.md$/.test(n));
    assert.equal(fs.existsSync(f), false); assert.equal(taken.length, 1);
    assert.ok(out.prompt.endsWith(` Read your inbox first: ${path.join(path.dirname(f), taken[0]).split(path.sep).join("/")} - items other lanes queued for you.`), out.prompt);
    assert.doesNotMatch(fs.readFileSync(lastLaunch(sb, "A").prompt_file, "utf8"), /inbox/); // a fresh restart reuses prompt_file
    assert.match(out.prompt, / Write or re-read GOAL\.md in your session scratchpad first \(one goal line, then checkable items\) and tick each item the moment it is done\./);
  } finally { sb.cleanup(); }
});

test("queue: an unknown lane exits 2; --after-merge needs a group; a lone session's inbox lives under the config dir", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "L", "--model", "opus", "--effort", "high").code, 0);
    let r = sb.run("queue", "--to", "nobody", "--text", "x");
    assert.equal(r.code, 2); assert.match(r.err, /unknown lane nobody/);
    r = sb.run("queue", "--to", "L", "--text", "x", "--after-merge");
    assert.equal(r.code, 2); assert.match(r.err, /--after-merge needs a lane in a group/);
    assert.equal(sb.run("queue", "--to", "L").code, 2);
    assert.equal(sb.run("queue", "--to", "L", "--text-file", path.join(sb.tmp, "missing.md")).code, 2);
    r = sb.run("queue", "--to", "L", "--text", "x");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `queued for L: ${path.join(sb.cfg, "state", "coord", "inbox", "L.md").split(path.sep).join("/")} (1 items)\n`);
  } finally { sb.cleanup(); }
});

test("a bg launch whose claude never started gives the taken inbox back", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "Q", "--model", "opus", "--effort", "high").code, 0);
    assert.equal(sb.run("queue", "--to", "Q", "--text", "x").code, 0);
    const f = path.join(sb.cfg, "state", "coord", "inbox", "Q.md");
    // No claude on PATH: the bg launch fails and no new agent appears. HL_NO_SPAWN off; the tick it triggers is detached
    // and hidden, in the sandbox.
    const sys = process.env.SystemRoot || "C:\\Windows";
    const gitDir = path.dirname(spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim());
    const env = { ...sb.env, HL_NO_SPAWN: "0", PATH: [gitDir, path.join(sys, "System32"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";") };
    const r = spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "Q", "--model", "opus", "--effort", "high", "--mode", "bg", "--supersedes", lastLaunch(sb, "Q").id], { env, encoding: "utf8", timeout: 120000 });
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(fs.existsSync(f), true);
    assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith(".taken.md")), []);
  } finally { sb.cleanup(); }
});

test("FINAL_READY tags next_after_merge: merged lanes only; held items with their state; queued after-merge items and unread inboxes", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const a = launchLane(sb, "g1", "A"); launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "a\n" }, "A"), { next_after_merge: ["A2"] });
    writeDone(sb, "g1", "B", "", { status: "blocked", next_after_merge: ["B2"] });
    assert.equal(sb.run("queue", "--to", "B", "--text", "for B").code, 0);
    assert.equal(sb.run("queue", "--to", "A", "--text", "after the merge", "--after-merge").code, 0);
    const r = sb.run("merge", "--group", "g1", "--repo", sb.repo);
    assert.equal(r.code, 0, r.err + r.out);
    const am = path.join(sb.repo, ".superpowers", "sessions", "g1", "inbox", "_after-merge.md").split(path.sep).join("/");
    assert.match(r.out, /^FINAL_READY g1: every lane is merged or blocked \(not merged: B\) - .* next_after_merge=\{"A":\["A2"\]\} held_next_after_merge=\{"B":\{"state":"blocked","items":\["B2"\]\}\}/m);
    assert.ok(r.out.includes(` queued_after_merge=1 (${am}) unread_inbox=[B:1]`), r.out);
  } finally { sb.cleanup(); }
});

test("priority: the command sets a lane's effective priority; status lists high -> normal -> low, then launch order", () => {
  const sb = sandbox();
  try {
    launchLane(sb, "g1", "A");
    launchLane(sb, "g1", "B", ["--priority", "high"]);
    assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "C", "--model", "opus", "--effort", "medium", "--worktree", "lane-C", "--group", "g1").code, 0);
    const order = () => sb.run("status", "--group", "g1").out.split("\n").filter((l) => /^[ABC] /.test(l)).map((l) => l[0]).join("");
    assert.equal(order(), "BAC");
    let r = sb.run("priority", "--name", "C", "--set", "high");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "set priority of C (group g1) to high\n");
    assert.ok(sb.registry().some((o) => o.priority === "C" && o.group === "g1" && o.value === "high" && !o.launched_at));
    assert.equal(order(), "BCA");
    assert.equal(sb.run("priority", "--name", "nobody", "--set", "high").code, 2);
    assert.equal(sb.run("priority", "--name", "C", "--set", "urgent").code, 2);
  } finally { sb.cleanup(); }
});

test("launch.mjs sessions lists every open launcher session with its checklist, then hand-opened sessions with a recent GOAL.md", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", id: "A@1", branch: "lane-a", sid: "a-s1", mode: "bg", bg_id: "bg-A", group: "g1", supersedes: null });
    sessionLine(sb, { name: "B", id: "B@1", branch: "lane-b", sid: "b-s1", mode: "bg", bg_id: "bg-B", effort: "xhigh", supersedes: null });
    setAgents(sb, [{ id: "bg-A", sessionId: "a-s1", name: "A", status: "idle" }, { id: "bg-B", sessionId: "b-s1", name: "B", status: "running" }]); // A: its turn finished
    writeTranscript(sb, sb.repo, a.session_id, tx({ start: Date.now() - 20 * 60000 }).user("go").say("done").turnDone().entries());
    const gp = path.join(sb.temp, "claude", projectKey(sb.repo), "a-s1", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(gp), { recursive: true });
    fs.writeFileSync(gp, "# Ship A\n- [x] one — evidence: x\n- [ ] two\n- [!] three — reason: needs the user\n");
    const hand = path.join(sb.temp, "claude", "C--some-project", "hand-0000-1111", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(hand), { recursive: true }); fs.writeFileSync(hand, "# hand\n- [ ] a\n");
    const oldHand = path.join(sb.temp, "claude", "C--some-project", "oldh-0000-1111", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(oldHand), { recursive: true }); fs.writeFileSync(oldHand, "# old\n");
    fs.utimesSync(oldHand, new Date(Date.now() - 30 * 3600e3), new Date(Date.now() - 30 * 3600e3));
    const r = sb.run("sessions");
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n");
    assert.match(lines[0], /^B  .*@lane-b  group=-  gen 1  running  no transcript  priority=high  no GOAL\.md$/);
    assert.match(lines[1], /^A  .*@lane-a  group=g1  gen 1  running  idle  priority=normal  goal 1\/3 done, 1 blocked \(reason: needs the user\), last ticked 0 min ago$/);
    assert.match(lines[2], /^hand-opened C--some-project hand-000  goal 0\/1 done, last ticked 0 min ago$/);
    assert.equal(lines.length, 3); // the old hand-opened GOAL.md and the registry session's own are not listed again
    assert.match(sb.run("status", "--group", "g1").out, /^A .*  goal=1\/3 done, 1 blocked \(reason: needs the user\), last ticked 0 min ago$/m);
  } finally { sb.cleanup(); }
});

test("status notes a dead start: DEAD-START (since <time>) on an open lane with a {dead_start} line", () => {
  const sb = sandbox();
  try {
    const w = sessionLine(sb, { name: "W", id: "W@1", group: "g9", branch: "w", sid: "w-s1", supersedes: null });
    assert.doesNotMatch(sb.run("status", "--group", "g9").out, /DEAD-START/);
    appendLine(sb, { dead_start: w.id, name: "W", group: "g9", at: "2026-10-05T10:00:00.000Z" });
    assert.match(sb.run("status", "--group", "g9").out, /^W .*  DEAD-START \(since 2026-10-05T10:00:00\.000Z\)$/m);
  } finally { sb.cleanup(); }
});
```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/lanes.test.mjs`
Expected: FAIL - `unknown subcommand queue` (exit 2), `unknown subcommand priority`, `unknown subcommand sessions`; no
`DEAD-START` note.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf } from "./merge.mjs";
import { HERE, REG_DIR, PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hostBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooks, sessionHooksFile, triggerTick, COORD, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness,
  agentsList, listedAgent, launcherEnv, forgetLiveness } from "./live.mjs";
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine } from "./recover-lib.mjs";
import * as G from "./lane-lib.mjs";
import { guardedClose } from "./recover.mjs";

const IDLE_CLOSE_MS = 10 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
// Every --flag the code reads: each opt("...")/flag("...")/val("...") literal (tests/provenance.test.mjs checks that this set
// and the code agree). The launch path warns on any other --flag and ignores it - it never refuses: other projects'
// lanes call the live launcher with whatever their handoffs say.
const KNOWN_FLAGS = new Set(["base", "dry-run", "effort", "force", "goal-from", "group", "handoff",
  "integration", "lane", "mode", "model", "name", "no-close", "no-merge", "priority", "profile", "prompt-file", "recovery", "reopen", "repo",
  "resume", "scope", "session", "skip", "stop-looping", "supersedes", "target", "test", "test-timeout-min",
  "why", "worktree", "id"]);
const dry = flag("dry-run");
// The MAIN checkout root, also when <dir> is a linked worktree: registry key, worktree parent, done-marker home.
```

**with**:

```js
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf, inboxDir } from "./merge.mjs";
import { HERE, REG_DIR, PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hostBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooks, sessionHooksFile, triggerTick, COORD, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness,
  agentsList, listedAgent, launcherEnv, forgetLiveness, goalOf, projectKey } from "./live.mjs";
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine, parseGoal, goalNote } from "./recover-lib.mjs";
import * as G from "./lane-lib.mjs";
import { guardedClose } from "./recover.mjs";

const IDLE_CLOSE_MS = 10 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
// Every --flag the code reads: each opt("...")/flag("...")/val("...") literal (tests/provenance.test.mjs checks that this set
// and the code agree). The launch path warns on any other --flag and ignores it - it never refuses: other projects'
// lanes call the live launcher with whatever their handoffs say.
const KNOWN_FLAGS = new Set(["after-merge", "base", "dry-run", "effort", "force", "from", "goal-from", "group", "handoff",
  "integration", "lane", "mode", "model", "name", "no-close", "no-merge", "priority", "profile", "prompt-file", "recovery", "reopen", "repo",
  "resume", "scope", "session", "set", "skip", "stop-looping", "supersedes", "target", "test", "test-timeout-min", "text", "text-file", "to",
  "why", "worktree", "id"]);
const dry = flag("dry-run");
// The MAIN checkout root, also when <dir> is a linked worktree: registry key, worktree parent, done-marker home.
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
    lv?.state === "unknown" ? `liveness=unknown (${lv.why})` : ""].filter(Boolean).map((s) => `  ${s}`).join("");
}
const reportOnlyLine = (group) => `recovery: report-only (group launched before stage 2: loops are reported, never stopped - opt in: launch.mjs recover --group ${group} --mode auto)`;
// One status line per lane in the legacy format; rolling groups append the merge state and overlap. known: the marker
```

**with**:

```js
    lv?.state === "unknown" ? `liveness=unknown (${lv.why})` : ""].filter(Boolean).map((s) => `  ${s}`).join("");
}
// Batch A notes for a lane line, empty when there is nothing to say (a group without any stays byte-identical):
// DEAD-START (Part 3), inbox=<n> (Part 6), goal=... when the session has a GOAL.md (Part 9).
function laneNotes(e) {
  const ds = live(e) ? reg.lines.find((o) => o.dead_start === e.id) : null;
  const ib = e.done_marker ? path.join(path.dirname(e.done_marker), "inbox", `${e.name}.md`) : path.join(COORD, "inbox", `${e.name}.md`);
  let n = 0; try { n = G.inboxItems(fs.readFileSync(ib, "utf8")); } catch {}
  const gp = e.session_id ? goalOf(e.session_id) : null;
  let goal = ""; if (gp) { try { goal = `goal=${goalNote(parseGoal(fs.readFileSync(gp, "utf8")), fs.statSync(gp).mtimeMs, Date.now()).replace(/^goal /, "")}`; } catch {} }
  return [ds ? `DEAD-START (since ${ds.at})` : "", n ? `inbox=${n}` : "", goal].filter(Boolean).map((x) => `  ${x}`).join("");
}
const reportOnlyLine = (group) => `recovery: report-only (group launched before stage 2: loops are reported, never stopped - opt in: launch.mjs recover --group ${group} --mode auto)`;
// One status line per lane in the legacy format; rolling groups append the merge state and overlap. known: the marker
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  const ovr = refreshOverlap(root, c.config, lanes, { write: !dry });
  if (ovr.error) console.log(`WARN overlap not refreshed: ${ovr.error}`);
  for (const l of lanes) {
    const tag = mergeTag(l), ov = l.overlap && Object.keys(l.overlap).length ? `  overlap=${JSON.stringify(l.overlap)}` : "";
    console.log(`${memberLine(l.entry, l.marker).text}${tag ? `  ${tag}` : ""}${ov}${recoveryNotes(l.entry, { legacy: false })}`);
  }
  const lock = readLock(groupDir(root, group));
```

**with**:

```js
  const ovr = refreshOverlap(root, c.config, lanes, { write: !dry });
  if (ovr.error) console.log(`WARN overlap not refreshed: ${ovr.error}`);
  for (const l of G.byPriority(lanes, (x) => x.priority)) { // high -> normal -> low, then launch order (Part 7)
    const tag = mergeTag(l), ov = l.overlap && Object.keys(l.overlap).length ? `  overlap=${JSON.stringify(l.overlap)}` : "";
    console.log(`${memberLine(l.entry, l.marker).text}${tag ? `  ${tag}` : ""}${ov}${recoveryNotes(l.entry, { legacy: false })}${laneNotes(l.entry)}`);
  }
  const lock = readLock(groupDir(root, group));
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  let done = 0;
  primeLiveness(members);
  for (const e of members) { const m = memberLine(e); if (m.done) done++; console.log(m.text + recoveryNotes(e, { legacy: true })); }
  const lockFile = gdir ? path.join(gdir, "merge.lock") : null;
  const lock = !!lockFile && fs.existsSync(lockFile);
```

**with**:

```js
  let done = 0;
  primeLiveness(members);
  for (const e of G.byPriority(members, (x) => G.effectivePriority(reg.lines, x))) { const m = memberLine(e); if (m.done) done++; console.log(m.text + recoveryNotes(e, { legacy: true }) + laneNotes(e)); }
  const lockFile = gdir ? path.join(gdir, "merge.lock") : null;
  const lock = !!lockFile && fs.existsSync(lockFile);
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  process.exit(code);
}
if (sub === "profile-args") {
  // The same files a launch passes: the coordinator hooks ride in the profile's settings file (full: the hooks alone).
```

**with**:

```js
  process.exit(code);
}
// The newest launch line named <name> (in group g when given; undefined = any group).
const newestNamed = (name, g) => [...reg.entries].reverse().find((x) => x.name === name && (g === undefined || (x.group ?? null) === g)) ?? null;
if (sub === "queue") {
  // batch A, Part 6: an item for another lane, delivered at its next fresh launch (never mid-task).
  const to = opt("to") && slug(opt("to")), tf = opt("text-file"), g = opt("group") ? slug(opt("group")) : undefined;
  let text = opt("text");
  if (!to || (text === undefined) === (tf === undefined)) { console.error('queue needs --to <lane> and one of --text "<text>" / --text-file <file> [--group <id>] [--repo <main repo>] [--after-merge] [--from <name>]'); process.exit(2); }
  if (tf !== undefined) { try { text = fs.readFileSync(tf, "utf8"); } catch (err) { console.error(`--text-file ${tf} unreadable (${err.code || err.message})`); process.exit(2); } }
  if (!String(text ?? "").trim() || String(text).startsWith("--")) { console.error("queue: the text is empty"); process.exit(2); }
  const repoKey = opt("repo") ? key(rootArg() || opt("repo")) : null;
  const e = [...reg.entries].reverse().find((x) => x.name === to && (g === undefined || (x.group ?? null) === g) && (!repoKey || x.repo === repoKey));
  if (!e) { console.error(`unknown lane ${to}${g ? ` in group ${g}` : ""}: no launch line has that name`); process.exit(2); }
  const grp = e.group ?? null;
  if (flag("after-merge") && !grp) { console.error(`--after-merge needs a lane in a group: ${to} has none`); process.exit(2); }
  const gd = grp ? (e.done_marker ? path.dirname(e.done_marker) : groupDir(opt("repo") ? rootArg() : e.repo, grp)) : null;
  const file = !grp ? path.join(COORD, "inbox", `${to}.md`) : path.join(gd, "inbox", flag("after-merge") ? "_after-merge.md" : `${to}.md`);
  const me = process.env.HL_SESSION_ID ? [...reg.entries].reverse().find((x) => x.id === process.env.HL_SESSION_ID) : null;
  const from = opt("from") || me?.name || "user";
  if (dry) { console.log(`would queue for ${to}: ${fwd(file)}`); process.exit(0); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, G.inboxBlock(now(), from, text)); // one append per item: concurrent queuers never interleave inside it
  console.log(`queued for ${to}: ${fwd(file)} (${G.inboxItems(fs.readFileSync(file, "utf8"))} items)`);
  process.exit(0);
}
if (sub === "priority") {
  // batch A, Part 7: a {priority: <name>, group, value, at} line; the lane's effective priority is the latest.
  const nm = opt("name") && slug(opt("name")), v = opt("set"), g = opt("group") ? slug(opt("group")) : undefined;
  if (!nm || !G.PRIORITIES.includes(v)) { console.error("priority needs --name <lane> [--group <id>] --set high|normal|low"); process.exit(2); }
  const e = newestNamed(nm, g);
  if (!e) { console.error(`unknown lane ${nm}${g ? ` in group ${g}` : ""}: no launch line has that name`); process.exit(2); }
  if (!dry) append({ priority: nm, group: e.group ?? null, value: v, at: now() });
  console.log(`${dry ? "would set" : "set"} priority of ${nm}${e.group ? ` (group ${e.group})` : ""} to ${v}`);
  process.exit(0);
}
if (sub === "sessions") {
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
    let turn = "-";
    if (lv.state !== "gone") {
      const st = sessionState(e), hook = (/^[\w-]+$/.test(e.session_id || "") && readJson(path.join(COORD, "sessions", `${e.session_id}.json`), {})) || {};
      turn = !st.found ? "no transcript" : hook.waiting_since ? "waiting" : st.idle ? "idle" : "busy";
    }
    const gp = e.session_id ? goalOf(e.session_id) : null;
    console.log(`${e.name}  ${e.repo}@${e.branch}  group=${e.group ?? "-"}  gen ${e.generation ?? "?"}  ${lv.state}  ${turn}  priority=${G.effectivePriority(reg.lines, e)}  ${gp ? goalText(gp) : "no GOAL.md"}`);
  }
  if (!list.length) console.log("no open launcher sessions");
  const known = new Set(reg.entries.map((e) => e.session_id).filter(Boolean)), base = path.join(os.tmpdir(), "claude");
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name); } catch { return []; } };
  const prefix = repoKey ? projectKey(rootArg() || opt("repo")) : null;
  for (const proj of dirs(base)) {
    if (prefix && !proj.startsWith(prefix)) continue;
    for (const sid of dirs(path.join(base, proj))) {
      if (known.has(sid)) continue;
      const gp = path.join(base, proj, sid, "scratchpad", "GOAL.md");
      let m; try { m = fs.statSync(gp).mtimeMs; } catch { continue; }
      if (nowMs - m <= 24 * 60 * MIN) console.log(`hand-opened ${proj} ${sid.slice(0, 8)}  ${goalText(gp)}`);
    }
  }
  process.exit(0);
}
if (sub === "profile-args") {
  // The same files a launch passes: the coordinator hooks ride in the profile's settings file (full: the hooks alone).
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
// so outside the repo dir the handoff is named by its absolute path.
const handoffRef = key(workDir) === key(repo) ? fwd(path.relative(repo, handoff)) : fwd(handoff);
const laneNote = !group || isMergeSession(group, name) ? ""
  : groupCfg ? ` Fan-out group ${group} (rolling merges): write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - then run node ${qs(fwd(fileURLToPath(import.meta.url)))} merge --group ${group} --repo ${qs(fwd(root))} --lane ${name} and report its output. Otherwise launch the lane next stage as the handoff says.`
  : ` Fan-out group ${group}: write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
const pointer = `Continue from the handoff at ${qs(handoffRef)} - read it first, then follow its paste-ready prompt section exactly.` + laneNote;
// --prompt-file: a fresh restart reuses the exact pointer prompt of the launch it replaces.
let basePrompt = pointer;
if (opt("prompt-file")) {
  try { basePrompt = fs.readFileSync(opt("prompt-file"), "utf8").trim() || pointer; }
  catch (err) { console.error(`warning: --prompt-file ${opt("prompt-file")} unreadable (${err.code || err.message}) - using the computed pointer prompt`); }
}
const clean = (s) => s.replace(/"/g, "'").replace(/;/g, ",");
// --recovery: the RECOVERY line goes in front of the prompt only; the prompt file keeps the base, so prefixes never stack.
const recovery = opt("recovery") ? `${RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))} ` : "";
const prompt = clean(recovery + basePrompt);
// The profile args go before -n and the prompt: --mcp-config is variadic and would swallow the prompt.
const bgArgs = ["--bg", ...laneProfile.args, "-n", name, "--model", model, "--effort", effort, prompt];
// bg on Windows without a claude.exe runs through cmd.exe, which expands %VAR% even inside quoted args (the prompt, the
// registry dir's profile files): refuse rather than mangle them (for the .exe too: one rule, decided before the CLI is
// resolved), before anything is recorded.
const pct = mode === "bg" && process.platform === "win32" && bgArgs.find((a) => String(a).includes("%"));
if (pct) {
  console.error(`a bg argument contains % (cmd.exe would expand %VAR% in it) - move the handoff or the registry dir to a path without %: ${pct}`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const id = `${name}@${stamp}`;
const pidFile = path.join(PID_DIR, `${stem(id)}.pid`);
```

**with**:

```js
// so outside the repo dir the handoff is named by its absolute path.
const handoffRef = key(workDir) === key(repo) ? fwd(path.relative(repo, handoff)) : fwd(handoff);
const doneMarkerNote = !group || isMergeSession(group, name) ? ""
  : groupCfg ? ` Fan-out group ${group} (rolling merges): write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - then run node ${qs(fwd(fileURLToPath(import.meta.url)))} merge --group ${group} --repo ${qs(fwd(root))} --lane ${name} and report its output. Otherwise launch the lane next stage as the handoff says.`
  : ` Fan-out group ${group}: write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
// Part 9: every session keeps a checklist ("re-read" covers a resumed session and a fresh restart with --goal-from).
const GOAL_SENTENCE = " Write or re-read GOAL.md in your session scratchpad first (one goal line, then checkable items) and tick each item the moment it is done.";
const pointer = `Continue from the handoff at ${qs(handoffRef)} - read it first, then follow its paste-ready prompt section exactly.` + GOAL_SENTENCE + doneMarkerNote;
// --prompt-file: a fresh restart reuses the exact pointer prompt of the launch it replaces.
let basePrompt = pointer;
if (opt("prompt-file")) {
  try { basePrompt = fs.readFileSync(opt("prompt-file"), "utf8").trim() || pointer; }
  catch (err) { console.error(`warning: --prompt-file ${opt("prompt-file")} unreadable (${err.code || err.message}) - using the computed pointer prompt`); }
}
const clean = (s) => s.replace(/"/g, "'").replace(/;/g, ",");
// --recovery: the RECOVERY line goes in front of the prompt only; the prompt file keeps the base, so prefixes never stack.
const recovery = opt("recovery") ? `${RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))} ` : "";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// The inbox (batch A, Part 6): a fresh launch named <lane> takes it - renamed to <lane>.<stamp>.taken.md - and the prompt
// (never prompt_file: a fresh restart reuses that file) names it. A rename that fails takes nothing (the next fresh launch
// tries again); a spawn that fails renames it back; --dry-run never takes. Merge sessions have no inbox of their own.
const inboxFile = group && isMergeSession(group, name) ? null : group ? path.join(inboxDir(root || repo, group), `${name}.md`) : path.join(COORD, "inbox", `${name}.md`);
let taken = null;
if (!dry && inboxFile && fs.existsSync(inboxFile)) {
  const dst = path.join(path.dirname(inboxFile), G.takenName(name, stamp));
  try { fs.renameSync(inboxFile, dst); taken = dst; } catch (err) { console.error(`warning: inbox ${fwd(inboxFile)} not taken (${err.code || err.message}) - the next fresh launch tries again`); }
}
const giveBack = () => { if (taken) { try { fs.renameSync(taken, inboxFile); } catch {} taken = null; } };
const prompt = clean(recovery + basePrompt + (taken ? G.INBOX_SENTENCE(qs(fwd(taken))) : ""));
// The profile args go before -n and the prompt: --mcp-config is variadic and would swallow the prompt.
const bgArgs = ["--bg", ...laneProfile.args, "-n", name, "--model", model, "--effort", effort, prompt];
// bg on Windows without a claude.exe runs through cmd.exe, which expands %VAR% even inside quoted args (the prompt, the
// registry dir's profile files): refuse rather than mangle them (for the .exe too: one rule, decided before the CLI is
// resolved), before anything is recorded.
const pct = mode === "bg" && process.platform === "win32" && bgArgs.find((a) => String(a).includes("%"));
if (pct) {
  giveBack();
  console.error(`a bg argument contains % (cmd.exe would expand %VAR% in it) - move the handoff or the registry dir to a path without %: ${pct}`);
  process.exit(2);
}

const id = `${name}@${stamp}`;
const pidFile = path.join(PID_DIR, `${stem(id)}.pid`);
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
  const r = spawnSync(file, argv, { cwd: workDir, env, encoding: "utf8", timeout: 120000, ...sh });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  // The bg id comes from a before/after diff of `claude agents --json`, matched by name: a guess from the CLI output is
  // not reliable, and a session with no id is never stopped by the coordinator.
  let hit = null;
  for (let i = 0; i < 10 && before && !hit; i++) { const after = refreshAgents(); hit = after && matchNewAgent(before, after, name); if (!hit) sleep(500); }
  append({ ...entry, bg_id: hit?.id ?? null, session_id: hit?.sessionId ?? null, bg_output: (r.stdout || "").slice(0, 2000) });
  if (opt("goal-from") && hit?.sessionId) goalCopy(null, hit.sessionId);
```

**with**:

```js
  const r = spawnSync(file, argv, { cwd: workDir, env, encoding: "utf8", timeout: 120000, ...sh });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  // A launcher that failed and left no new background session: the inbox goes back for the next fresh launch.
  // The bg id comes from a before/after diff of `claude agents --json`, matched by name: a guess from the CLI output is
  // not reliable, and a session with no id is never stopped by the coordinator.
  let hit = null;
  for (let i = 0; i < 10 && before && !hit; i++) { const after = refreshAgents(); hit = after && matchNewAgent(before, after, name); if (!hit) sleep(500); }
  if (!hit && (r.error || r.status !== 0)) giveBack();
  append({ ...entry, bg_id: hit?.id ?? null, session_id: hit?.sessionId ?? null, bg_output: (r.stdout || "").slice(0, 2000) });
  if (opt("goal-from") && hit?.sessionId) goalCopy(null, hit.sessionId);
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, launcher: ps1, command: [exe, ...exeArgs], cap };
if (dry) {
  report.occupancy = { refused: occupancy.refused?.id ?? null, would_close: occupancy.closes.map((e) => e.id) };
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(entry, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
const { launched, latency } = spawnWindow({ entry, ps1, script, exe, exeArgs, workDir });
append(launched);
// The tick judges loops, not the launch (the launch-time watchdog is gone): a launch only wakes it.
```

**with**:

```js
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, launcher: ps1, command: [exe, ...exeArgs], cap };
if (dry) {
  report.occupancy = { refused: occupancy.refused?.id ?? null, would_close: occupancy.closes.map((e) => e.id), inbox: inboxFile && fs.existsSync(inboxFile) ? fwd(inboxFile) : null };
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(entry, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
append(startingLine(entry)); // a launcher killed before its launch line leaves this: status and the tick report it UNTRACKED
let spawned;
try { spawned = spawnWindow({ entry, ps1, script, exe, exeArgs, workDir }); }
catch (err) { giveBack(); console.error(`the window did not start: ${err.code || err.message}`); process.exit(1); }
const { launched, latency } = spawned;
append(launched);
// The tick judges loops, not the launch (the launch-time watchdog is gone): a launch only wakes it.
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/lanes.test.mjs claude/skills/handoff-launch/tests/provenance.test.mjs claude/skills/handoff-launch/tests/launcher.test.mjs claude/skills/handoff-launch/tests/status.test.mjs`
Expected: `ℹ fail 0` (`provenance.test.mjs` checks the extended `KNOWN_FLAGS` against the code).

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/launch.mjs claude/skills/handoff-launch/tests
git commit -m "launch: queue and the inbox, priority, sessions, the GOAL sentence; status lists by priority with dead-start, inbox and goal notes"
```

---

### Task 9: The session hooks: the write fence, the lane note, the Stop tab check, checklist lines, goal-gate's nudge

**Files:**
- Modify: `claude/skills/handoff-launch/live.mjs` (`sessionHooks` `:440-445`)
- Modify: `claude/hooks/coord.mjs` (header, imports, `postTool` `:34-52`, new `goalPathOf`, `goalInfo`, `fence`,
  `laneNote`, `stopCheck`, `main` `:133`)
- Modify: `claude/hooks/goal-gate.mjs` (header, new `missingNudge`, the no-GOAL.md exit `:69`)
- Test: `claude/skills/handoff-launch/tests/lane-hooks.test.mjs` (new)

**Interfaces:**
- Consumes: Task 2 `ownRoot`, `normPath`, `isUnder`, `fenceDecision`, `fenceText`, `laneNoteText`, `textHash`,
  `otherLanes`, `openLanes`, `effectivePriority`; Task 3 `chromeTabs`, `isChromeTool`, `CHROME_TABS_TEXT`, `parseGoal`,
  `goalSteps`; Task 5 `lanes.json`.
- Produces: `sessionHooks()` with `PreToolUse` (`Edit|Write|MultiEdit|NotebookEdit` -> `coord.mjs fence`),
  `UserPromptSubmit` (`lane-note`), `Stop` (`stop`); exports `fence(input, env)`, `laneNote(input, env)`,
  `stopCheck(input, env)`; hook state keys `fence`, `lane`, `lane_hash`, `chrome_tabs`, `chrome_turn`, `main_calls`,
  `goal_path`, `goal_mtime`, `goal_open`, `goal_changes`, `goal_missing_said`, `goal_stale_said`; goal-gate's
  `<config>/goals/.nudged-<sid>`.

- [ ] **Step 1: Write the failing tests**

**Create** `claude/skills/handoff-launch/tests/lane-hooks.test.mjs`:

```js
// Batch A's session hooks with fake stdin: the write fence (Part 4), the lane note (Part 5), the claude-in-chrome Stop
// check (Part 8), the checklist lines of post-tool and goal-gate (Part 9). Every hook fails open.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun, sessionLine, writeTranscript, tx } from "./helpers.mjs";
import { GOAL_MISSING_TEXT, GOAL_STALE_TEXT, CHROME_TABS_TEXT } from "../recover-lib.mjs";
import { key } from "../merge-lib.mjs";
import { sessionHooks } from "../live.mjs";

const SID = "11111111-2222-3333-4444-555555555555";
const GOAL_GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "goal-gate.mjs");
const fwd = (p) => p.split(path.sep).join("/");
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "sessions", `${SID}.json`), "utf8"));
// Three lanes of one repo: A (this session, lane-a), B (lane-b), M on the main checkout.
function lanes(sb) {
  const wt = (b) => fwd(path.join(sb.repo, ".claude", "worktrees", b));
  const a = sessionLine(sb, { name: "A", id: "A@1", branch: "lane-a", worktree: wt("lane-a"), sid: SID, supersedes: null, scope: "Stage A" });
  sessionLine(sb, { name: "B", id: "B@1", branch: "lane-b", worktree: wt("lane-b"), sid: "b-s1", supersedes: null, scope: "Stage B" });
  sessionLine(sb, { name: "M", id: "M@1", branch: "main", worktree: fwd(sb.repo), sid: "m-s1", supersedes: null });
  return { a, wt };
}
const fence = (sb, filePath, o = {}) => coordRun(sb, ["fence"], { input: { session_id: SID, cwd: o.cwd, hook_event_name: "PreToolUse", tool_name: o.tool || "Write", tool_input: o.input || { file_path: filePath, content: "x" } }, env: o.env ?? { HL_SESSION_ID: "A@1" } });
const denial = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput : null);

test("the write fence allows the own worktree, config, temp, .superpowers, an agent worktree and other repos; denies other lanes and the main checkout", () => {
  const sb = sandbox();
  try {
    const { wt } = lanes(sb), cwd = wt("lane-a");
    for (const p of [path.join(wt("lane-a"), "src", "a.js"), "rel/b.js", path.join(sb.cfg, "experiments", "ledger.md"), path.join(sb.temp, "claude", "x", "GOAL.md"),
      path.join(sb.repo, ".superpowers", "sessions", "g", "A.done"), path.join(sb.repo, ".claude", "worktrees", "agent-77", "f.js"), path.join(sb.tmp, "other-repo", "f.js")]) {
      const r = fence(sb, p, { cwd });
      assert.equal(r.code, 0, r.err); assert.equal(r.out, "", p);
    }
    let r = fence(sb, path.join(wt("lane-b"), "src", "b.js"), { cwd });
    const d = denial(r);
    assert.deepEqual([d.hookEventName, d.permissionDecision], ["PreToolUse", "deny"]);
    assert.match(d.permissionDecisionReason, /^Write fence: .*\/\.claude\/worktrees\/lane-b\/src\/b\.js belongs to lane B \(lane-b\), not to this lane \(.*\/\.claude\/worktrees\/lane-a\)\. Do not edit it from here\. Queue the change: node .*launch\.mjs queue --to B --text "<what to change>" \[--after-merge\], or tell the user\.$/);
    r = fence(sb, null, { cwd, tool: "NotebookEdit", input: { notebook_path: path.join(sb.repo, "nb.ipynb") } });
    assert.match(denial(r).permissionDecisionReason, /belongs to the main checkout \(lane M, main\), not to this lane/);
    assert.equal(state(sb).fence.own, key(wt("lane-a"))); // cached: later calls under the own root read no registry
  } finally { sb.cleanup(); }
});

test("the write fence fails open: no HL_SESSION_ID, an unknown entry, garbage stdin, a missing skill folder", () => {
  const sb = sandbox();
  try {
    const { wt } = lanes(sb), p = path.join(wt("lane-b"), "b.js");
    for (const r of [fence(sb, p, { env: {} }), fence(sb, p, { env: { HL_SESSION_ID: "nobody@1" } }),
      coordRun(sb, ["fence"], { input: "{garbage", env: { HL_SESSION_ID: "A@1" } }),
      fence(sb, p, { env: { HL_SESSION_ID: "A@1", HL_SKILL_DIR: path.join(sb.tmp, "missing") } })]) {
      assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    }
  } finally { sb.cleanup(); }
});

test("the lane note: on the first prompt, again only when the live-lane set changes; lanes.json first, the registry when it is missing or stale", () => {
  const sb = sandbox();
  try {
    lanes(sb);
    const note = () => { const r = coordRun(sb, ["lane-note"], { input: { session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "go" }, env: { HL_SESSION_ID: "A@1" } }); assert.equal(r.code, 0, r.err); return r.out ? JSON.parse(r.out).hookSpecificOutput : null; };
    let n = note();
    assert.equal(n.hookEventName, "UserPromptSubmit");
    assert.match(n.additionalContext, /^Lane note: you are lane A \(branch lane-a, .*lane-a, priority normal\)\. Other live lanes in this repo: (B \(lane-b, Stage B\)|M \(main\)); (B \(lane-b, Stage B\)|M \(main\))\. A request meant for another lane/);
    assert.equal(note(), null); // unchanged: nothing
    const lj = path.join(sb.coord, "lanes.json"), rk = key(sb.repo);
    fs.writeFileSync(lj, JSON.stringify({ at: new Date().toISOString(), repos: { [rk]: [{ id: "A@1", name: "A", branch: "lane-a", worktree: "x", priority: "high" }, { id: "C@1", name: "C", branch: "lane-c", scope: null }] } }));
    n = note();
    assert.equal(n.additionalContext, `Lane note: you are lane A (branch lane-a, ${key(path.join(sb.repo, ".claude", "worktrees", "lane-a"))}, priority high). Other live lanes in this repo: C (lane-c). `
      + "A request meant for another lane: say it belongs to that lane and offer launch.mjs queue --to <lane>. Work on files another live lane is changing: queue it with --after-merge.");
    fs.writeFileSync(lj, JSON.stringify({ at: new Date(Date.now() - 31 * 60000).toISOString(), repos: { [rk]: [] } })); // stale: the registry again
    assert.match(note().additionalContext, /Other live lanes in this repo: .*B \(lane-b, Stage B\)/);
    assert.equal(coordRun(sb, ["lane-note"], { input: { session_id: SID }, env: {} }).out, "");
  } finally { sb.cleanup(); }
});

test("claude-in-chrome: post-tool tracks this session's tabs; Stop blocks once per turn that left them open", () => {
  const sb = sandbox();
  try {
    const post = (tool, input, response) => coordRun(sb, ["post-tool"], { input: { session_id: SID, transcript_path: "/t/x.jsonl", tool_name: tool, tool_input: input, tool_response: response }, env: { HL_SESSION_ID: "A@1" } });
    const stop = (o = {}) => coordRun(sb, ["stop"], { input: { session_id: SID, hook_event_name: "Stop", stop_hook_active: false, ...o }, env: { HL_SESSION_ID: "A@1" } });
    post("mcp__claude-in-chrome__tabs_context_mcp", { createIfEmpty: true }, [{ type: "text", text: JSON.stringify({ availableTabs: [{ tabId: 11, title: "New Tab" }, { tabId: 12, title: "x" }], tabGroupId: 3 }) }]);
    assert.deepEqual(state(sb).chrome_tabs, [11, 12]);
    let r = stop();
    assert.deepEqual(JSON.parse(r.out), { decision: "block", reason: CHROME_TABS_TEXT(2) });
    assert.equal(stop().out, ""); // once per turn
    post("mcp__claude-in-chrome__tabs_close_mcp", { tabId: 11 }, "closed");
    assert.equal(stop({ stop_hook_active: true }).out, ""); // never on a continuation
    post("mcp__claude-in-chrome__tabs_close_mcp", { tabId: 12 }, "closed");
    assert.equal(stop().out, ""); // all closed
    assert.equal(coordRun(sb, ["stop"], { input: "{x", env: { HL_SESSION_ID: "A@1" } }).out, "");
  } finally { sb.cleanup(); }
});

test("post-tool checklist lines: the missing line once after goal_missing_calls main calls; the stale line once per window", () => {
  const sb = sandbox();
  try {
    const tp = path.join(sb.tmp, "projects", "C--proj", `${SID}.jsonl`);
    const call = (o = {}) => { const r = coordRun(sb, ["post-tool"], { input: { session_id: SID, transcript_path: tp, tool_name: "Read", tool_input: { file_path: `f${Math.random()}` }, ...o }, env: { HL_SESSION_ID: "A@1" } }); return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : null; };
    const gp = path.join(sb.temp, "claude", "C--proj", SID, "scratchpad", "GOAL.md");
    const outs = Array.from({ length: 10 }, () => call());
    assert.deepEqual(outs.slice(0, 9), Array(9).fill(null));
    assert.equal(outs[9], GOAL_MISSING_TEXT(gp));
    assert.equal(call(), null);
    fs.mkdirSync(path.dirname(gp), { recursive: true }); fs.writeFileSync(gp, "# g\n- [x] a\n- [ ] b\n");
    const t = new Date(Date.now() - 50 * 60000); fs.utimesSync(gp, t, t);
    const work = Array.from({ length: 5 }, (_, i) => call({ tool_name: "Edit", tool_input: { file_path: `e${i}` } }));
    assert.deepEqual(work.slice(0, 4), [null, null, null, null]);
    assert.equal(work[4], GOAL_STALE_TEXT(50));
    assert.equal(call({ tool_name: "Edit", tool_input: { file_path: "e9" } }), null);
  } finally { sb.cleanup(); }
});

test("goal-gate: a hand-opened session with 10+ tool calls and no GOAL.md is nudged once; never in print mode, a one-shot run, a launcher session or a continuation", () => {
  const sb = sandbox();
  try {
    const gate = (input, env = {}) => { const r = spawnSync(process.execPath, [GOAL_GATE], { env: { ...sb.env, ...env }, input: JSON.stringify(input), encoding: "utf8" }); return { code: r.status, out: r.stdout }; };
    let t = tx({ start: Date.now() - 30 * 60000 }).user("first");
    for (let i = 0; i < 6; i++) t = t.call("Read", { file_path: `a${i}` });
    t = t.say("ok").user("second");
    for (let i = 0; i < 6; i++) t = t.call("Bash", { command: `b${i}` });
    const tp = writeTranscript(sb, path.join(sb.tmp, "hand"), "h-s1", t.say("done").entries());
    const want = path.join(sb.temp, "claude", path.basename(path.dirname(tp)), "h-s1", "scratchpad", "GOAL.md");
    const input = { session_id: "h-s1", transcript_path: tp, stop_hook_active: false, last_assistant_message: "done", background_tasks: [] };
    for (const [i, env] of [[{ ...input, stop_hook_active: true }, {}], [{ ...input, last_assistant_message: "ok?" }, {}], [{ ...input, background_tasks: [{ id: "b1" }] }, {}],
      [input, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }], [input, { HL_SESSION_ID: "X@1" }]]) assert.equal(gate(i, env).out, "");
    const r = gate(input);
    assert.deepEqual(JSON.parse(r.out), { decision: "block", reason: GOAL_MISSING_TEXT(want) });
    assert.ok(fs.existsSync(path.join(sb.cfg, "goals", ".nudged-h-s1")));
    assert.equal(gate(input).out, ""); // once per session
    // A one-shot run (a single user prompt) is never nudged.
    let one = tx({ start: Date.now() - 30 * 60000 }).user("only");
    for (let i = 0; i < 12; i++) one = one.call("Read", { file_path: `o${i}` });
    const tp1 = writeTranscript(sb, path.join(sb.tmp, "hand"), "h-s2", one.say("done").entries());
    assert.equal(gate({ ...input, session_id: "h-s2", transcript_path: tp1 }).out, "");
  } finally { sb.cleanup(); }
});

test("every launcher session gets the batch-A hooks in its one --settings file: fence, lane-note, stop", () => {
  const h = sessionHooks().hooks;
  assert.equal(h.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
  assert.match(h.PreToolUse[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" fence$/);
  assert.match(h.UserPromptSubmit[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" lane-note$/);
  assert.match(h.Stop[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" stop$/);
  assert.match(h.PostToolUse[0].hooks[0].command, / post-tool$/);
});
```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/lane-hooks.test.mjs`
Expected: FAIL - `coord.mjs fence` prints nothing for a write into lane B; `lane-note` prints nothing; `stop` never
blocks; no missing-GOAL.md line; `sessionHooks().hooks.PreToolUse` is undefined.

- [ ] **Step 3: Implement**

The fence binds to probe 1 (`hookSpecificOutput.permissionDecision: "deny"`), the lane note to probe 2, the tab set to
probe 8, goal-gate's one-shot skip to probe 2's `CLAUDE_CODE_ENTRYPOINT=sdk-cli`.

**Replace** in `claude/hooks/coord.mjs`:

```js
// Coordinator hook entry (stage 2 of handoff-launch). Subcommands:
//   post-tool   PostToolUse hook of launcher sessions (launch.mjs passes it with --settings): stop delivery, notices
//               for looping subagents, the early warning and the tick trigger. Prints at most one additionalContext.
//   notify      Notification hook: records waiting_since, for permission prompts only.
//   tick [--dry-run]  one coordinator tick (recover.mjs); --dry-run prints what it would do and writes nothing.
//   relay        Stop-hook helper: on a fresh Stop of a non-launcher session, claim one alert and ask the session to push it
//   alert-sent <file> | alert-release <file>   mark a claimed alert sent, or put it back
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any hook error: exit 0
// and no output - a broken hook must never block a tool call. A failed tick exits 1 (its trigger never waits on it, so
// only a hand or scheduled run sees the code): an import failure is shown on stderr, a failure inside the tick is its
// "tick failed:" line; the tick itself records its lines in <coord>/last-tick.txt.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
```

**with**:

```js
// Coordinator hook entry (stage 2 of handoff-launch). Subcommands:
//   post-tool   PostToolUse hook of launcher sessions (launch.mjs passes it with --settings): stop delivery, notices
//               for looping subagents, the early warning, the claude-in-chrome tab set, the checklist lines (missing or
//               stale GOAL.md) and the tick trigger. Prints at most one additionalContext.
//   notify      Notification hook: records waiting_since, for permission prompts only.
//   fence       PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit): denies a write into another lane's worktree or the main
//               checkout with a one-line hint to queue it (batch A, Part 4).
//   lane-note   UserPromptSubmit hook: the live lanes of this repo, on the first prompt and when that set changes (Part 5).
//   stop        Stop hook: once per turn that used claude-in-chrome and left this session's tabs open (Part 8).
//   tick [--dry-run]  one coordinator tick (recover.mjs); --dry-run prints what it would do and writes nothing.
//   relay        Stop-hook helper: on a fresh Stop of a non-launcher session, claim one alert and ask the session to push it
//   alert-sent <file> | alert-release <file>   mark a claimed alert sent, or put it back
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any hook error: exit 0
// and no output - a broken hook must never block a tool call. A failed tick exits 1 (its trigger never waits on it, so
// only a hand or scheduled run sees the code): an import failure is shown on stderr, a failure inside the tick is its
// "tick failed:" line; the tick itself records its lines in <coord>/last-tick.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
```

**Replace** in `claude/hooks/coord.mjs`:

```js
  const mine = readJson(path.join(V.COORD, "looping.json"), {})[sid];
  const looping = isObj(mine) ? Object.fromEntries(Object.entries(mine).filter(([, a]) => isObj(a) && str(a.key))) : {};
  const r = L.postToolSteps(readJson(stateFile, {}), { agentId: input.agent_id || null, key: L.callKey(input.tool_name, input.tool_input) },
    { stops, looping, cfg, now: Date.now() });
  // The {stop_delivered} line goes first: if the state write then fails, the next call delivers the stop again (once
  // more), whereas a state written first and a failed append would mark it delivered with nothing injected or recorded.
  if (r.delivered) V.append({ stop_delivered: regId, token: r.delivered, at: V.now() });
  V.writeAtomic(stateFile, JSON.stringify(r.state));
  V.triggerTick("post-tool", cfg.tick_min);
  return r.context;
}
// Probe 2 recorded the type field: a permission prompt, not an idle prompt, makes the session "waiting for the user".
```

**with**:

```js
  const mine = readJson(path.join(V.COORD, "looping.json"), {})[sid];
  const looping = isObj(mine) ? Object.fromEntries(Object.entries(mine).filter(([, a]) => isObj(a) && str(a.key))) : {};
  const now = Date.now();
  const r = L.postToolSteps(readJson(stateFile, {}), { agentId: input.agent_id || null, key: L.callKey(input.tool_name, input.tool_input) },
    { stops, looping, cfg, now });
  let state = r.state, said = r.context;
  // Batch A: the session's claude-in-chrome tab set (Part 8), then the checklist counters (Part 9), which speak only when
  // steps 1-4 did not. The GOAL.md path is derived once from transcript_path (as goal-gate does) and cached.
  if (L.isChromeTool(input.tool_name)) state = { ...state, chrome_turn: true, chrome_tabs: L.chromeTabs(state.chrome_tabs, { tool: input.tool_name, input: input.tool_input, response: input.tool_response }) };
  if (!str(state.goal_path)) state = { ...state, goal_path: goalPathOf(input, V) };
  const g = L.goalSteps(state, { agentId: input.agent_id || null, tool: input.tool_name }, { goal: goalInfo(state, [state.goal_path, path.join(V.CFG, "goals", `${sid}.md`)], L), goalPath: state.goal_path, now, cfg });
  state = g.state; said ??= g.context;
  // The {stop_delivered} line goes first: if the state write then fails, the next call delivers the stop again (once
  // more), whereas a state written first and a failed append would mark it delivered with nothing injected or recorded.
  if (r.delivered) V.append({ stop_delivered: regId, token: r.delivered, at: V.now() });
  V.writeAtomic(stateFile, JSON.stringify(state));
  V.triggerTick("post-tool", cfg.tick_min);
  return said;
}
// <tmp>/claude/<project folder>/<sid>/scratchpad/GOAL.md, the project folder being the transcript's (goal-gate's rule);
// without a transcript_path, goal-gate's fallback <config>/goals/<sid>.md.
function goalPathOf(input, V) {
  const t = input.transcript_path;
  return str(t) ? path.join(os.tmpdir(), "claude", path.basename(path.dirname(t)), input.session_id, "scratchpad", "GOAL.md") : path.join(V.CFG, "goals", `${input.session_id}.md`);
}
// The first GOAL.md that exists: {mtimeMs, open}; its open count is re-read only when its mtime changed. null: none.
function goalInfo(state, files, L) {
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (state.goal_mtime === st.mtimeMs && Number.isFinite(state.goal_open)) return { mtimeMs: st.mtimeMs, open: state.goal_open };
    let open = 0; try { open = L.parseGoal(fs.readFileSync(f, "utf8")).open; } catch {}
    state.goal_open = open;
    return { mtimeMs: st.mtimeMs, open };
  }
  return null;
}

// ---------- batch A: the write fence, the lane note, the Stop check (launcher sessions only; all fail open) ----------
const MIN = 60000;
const fileOf = (ti) => (isObj(ti) ? (str(ti.file_path) ? ti.file_path : str(ti.notebook_path) ? ti.notebook_path : null) : null);
const shown = (p, cwd) => { const a = String(path.isAbsolute(p) || !str(cwd) ? p : path.resolve(cwd, p)); return (a.startsWith("\\\\?\\") ? a.slice(4) : a).replace(/\\/g, "/"); };
// Part 4. The session's own entry is found once in the registry and cached in its hook state (fence: {id, name, branch,
// repo, own}); a write under its own root, the config dir, the temp dir or <main>/.superpowers is decided from that alone.
// Anything else reads the registry's open entries of the repo. -> the denial reason, or null (allow).
export async function fence(input, env = process.env) {
  const regId = env.HL_SESSION_ID, sid = input?.session_id, p = fileOf(input?.tool_input);
  if (!regId || !plainId(sid) || !p) return null;
  const [V, G] = await Promise.all([mod("live.mjs"), mod("lane-lib.mjs")]);
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
  let f = isObj(state.fence) && state.fence.id === regId && str(state.fence.own) ? state.fence : null, reg = null;
  if (!f) {
    reg = V.readRegistry();
    const me = [...reg.entries].reverse().find((e) => e.id === regId);
    if (!me) return null;
    f = { id: regId, name: me.name, branch: me.branch, repo: me.repo, own: G.ownRoot(me) };
    V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), fence: f }));
  }
  const P = G.normPath(p, input.cwd), base = { cwd: input.cwd, own: f.own, main: f.repo, config: V.CFG, tmp: os.tmpdir() };
  const rest = G.isUnder(P, f.own) ? P.slice(f.own.length) : null;
  const ownQuick = rest !== null && !rest.includes("/.claude/worktrees/") && (f.own !== f.repo || !G.isUnder(P, `${f.repo}/.claude/worktrees`));
  if (ownQuick || [V.CFG, os.tmpdir(), `${f.repo}/.superpowers`].some((r) => G.isUnder(P, G.normPath(r)))) return null;
  reg ??= V.readRegistry();
  const others = reg.entries.filter((e) => e.repo === f.repo && e.id !== regId && !reg.closed.has(e.id));
  const d = G.fenceDecision(p, { ...base, others });
  if (d.allow) return null;
  return G.fenceText({ p: shown(p, input.cwd), own: f.own, owner: d.owner, mainCheckout: d.mainCheckout, launchMjs: path.join(SKILL, "launch.mjs").split(path.sep).join("/"), ownName: f.name });
}
// Part 5. The live lanes of this repo from lanes.json (the tick's), or, when it is missing or older than 30 min, the
// registry's open entries (newest per lane, no liveness filter). Speaks on the first prompt and whenever the text changes
// (its hash in the hook state). -> the note, or null.
export async function laneNote(input, env = process.env) {
  const regId = env.HL_SESSION_ID, sid = input?.session_id;
  if (!regId || !plainId(sid)) return null;
  const [V, G] = await Promise.all([mod("live.mjs"), mod("lane-lib.mjs")]);
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
  let me = isObj(state.lane) && state.lane.id === regId ? state.lane : null, reg = null;
  if (!me) {
    reg = V.readRegistry();
    const e = [...reg.entries].reverse().find((x) => x.id === regId);
    if (!e) return null;
    me = { id: e.id, name: e.name, branch: e.branch, repo: e.repo, worktree: e.worktree, own: G.ownRoot(e), priority: G.effectivePriority(reg.lines, e) };
  }
  const lj = readJson(path.join(V.COORD, "lanes.json"), null);
  let lanes;
  if (lj && isObj(lj.repos) && Date.now() - Date.parse(lj.at) <= 30 * MIN) lanes = Array.isArray(lj.repos[me.repo]) ? lj.repos[me.repo] : [];
  else {
    reg ??= V.readRegistry();
    lanes = G.openLanes(reg.entries, reg.closed, me.repo).map((e) => ({ id: e.id, name: e.name, branch: e.branch, worktree: e.worktree, scope: e.scope ?? null, priority: G.effectivePriority(reg.lines, e) }));
  }
  const priority = lanes.find((l) => l?.id === regId)?.priority ?? me.priority;
  const text = G.laneNoteText({ name: me.name, branch: me.branch, own: me.own, priority }, G.otherLanes(lanes, me));
  const h = G.textHash(text);
  if (state.lane_hash === h && isObj(state.lane)) return null;
  V.writeAtomic(stateFile, JSON.stringify({ ...readJson(stateFile, {}), lane: me, lane_hash: h }));
  return state.lane_hash === h ? null : text;
}
// Part 8. Once per turn that used claude-in-chrome (post-tool sets chrome_turn): block when this session's tabs are still
// open. Never on a continuation Stop. -> the block reason, or null.
export async function stopCheck(input, env = process.env) {
  const sid = input?.session_id;
  if (!env.HL_SESSION_ID || !plainId(sid)) return null;
  const { V, L } = await context();
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`), state = readJson(stateFile, {});
  if (state.chrome_turn !== true) return null;
  V.writeAtomic(stateFile, JSON.stringify({ ...state, chrome_turn: false }));
  const tabs = Array.isArray(state.chrome_tabs) ? state.chrome_tabs.filter(Number.isInteger) : [];
  return input.stop_hook_active || !tabs.length ? null : L.CHROME_TABS_TEXT(tabs.length);
}
// Probe 2 recorded the type field: a permission prompt, not an idle prompt, makes the session "waiting for the user".
```

**Replace** in `claude/hooks/coord.mjs`:

```js
    if (c) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: c } }));
  } else if (sub === "notify") await notify(stdin());
  else if (sub === "tick") {
    const R = await mod("recover.mjs"), lines = R.tick({ dryRun: argv.includes("--dry-run") });
```

**with**:

```js
    if (c) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: c } }));
  } else if (sub === "notify") await notify(stdin());
  else if (sub === "fence") {
    const reason = await fence(stdin());
    if (reason) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  } else if (sub === "lane-note") {
    const c = await laneNote(stdin());
    if (c) await write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: c } }));
  } else if (sub === "stop") {
    const reason = await stopCheck(stdin());
    if (reason) await write(JSON.stringify({ decision: "block", reason }));
  }
  else if (sub === "tick") {
    const R = await mod("recover.mjs"), lines = R.tick({ dryRun: argv.includes("--dry-run") });
```

**Replace** in `claude/hooks/goal-gate.mjs`:

```js
// Coordinator (handoff-launch stage 2): each Stop may start its tick, and a session the launcher did not start relays
// at most one coordinator alert per user turn (the block asks it to push the alert to the phone).
import fs from "node:fs";
import path from "node:path";
```

**with**:

```js
// Coordinator (handoff-launch stage 2): each Stop may start its tick, and a session the launcher did not start relays
// at most one coordinator alert per user turn (the block asks it to push the alert to the phone).
// Checklist (batch A, Part 9): a hand-opened session with no GOAL.md after goal_missing_calls tool calls is blocked ONCE
// with a one-line nudge (marker <config>/goals/.nudged-<sid>), after the relay; never on a continuation Stop, a question,
// background tasks, a print-mode run (CLAUDE_CODE_ENTRYPOINT=sdk-cli) or a one-shot transcript (one user prompt).
import fs from "node:fs";
import path from "node:path";
```

**Replace** in `claude/hooks/goal-gate.mjs`:

```js
  process.exit(0);
};

let input;
```

**with**:

```js
  process.exit(0);
};

// The once-per-session nudge for a hand-opened session without GOAL.md (launcher sessions get theirs from coord.mjs
// post-tool). It counts as one of the turn's continuations: the gate's state file is written next to the GOAL.md it asks
// for, when that scratchpad exists. -> the block reason, or null.
function missingNudge(input, sid, candidates) {
  try {
    if (process.env.HL_SESSION_ID || input.stop_hook_active || !/^[\w-]+$/.test(String(sid))) return null;
    if (String(input.last_assistant_message ?? "").trim().endsWith("?")) return null;
    if (Array.isArray(input.background_tasks) && input.background_tasks.length > 0) return null;
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli") return null; // print mode (probe 2): a one-shot run
    const marker = path.join(CFG, "goals", `.nudged-${sid}`);
    if (fs.existsSync(marker) || !input.transcript_path) return null;
    let need = 10;
    try { const c = JSON.parse(fs.readFileSync(path.join(CFG, "state", "coord", "config.json"), "utf8")); if (Number.isFinite(c?.goal_missing_calls) && c.goal_missing_calls > 0) need = c.goal_missing_calls; } catch {}
    const fd = fs.openSync(input.transcript_path, "r");
    let text;
    try { const size = fs.fstatSync(fd).size, n = Math.min(size, 2_000_000), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); text = buf.toString("utf8"); }
    finally { fs.closeSync(fd); }
    let calls = 0, prompts = 0;
    for (const l of text.split(/\r?\n/)) {
      let x; try { x = JSON.parse(l); } catch { continue; }
      if (!x || x.isSidechain) continue;
      const c = x.message?.content;
      if (x.type === "assistant" && Array.isArray(c)) calls += c.filter((b) => b?.type === "tool_use").length;
      if (x.type === "user" && !x.isMeta && !x.isCompactSummary && (typeof c === "string" || (Array.isArray(c) && c.some((b) => b?.type === "text") && !c.some((b) => b?.type === "tool_result")))) prompts++;
    }
    if (prompts < 2 || calls < need) return null; // a one-shot run, or a short question-and-answer session
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    const want = candidates[0];
    try { if (fs.existsSync(path.dirname(want))) fs.writeFileSync(path.join(path.dirname(want), `.goal-gate-${sid}.json`), JSON.stringify({ blocks: 1, lastHash: null, finalAsked: false })); } catch {}
    return `No GOAL.md yet: write ${want} now (one goal line, then checkable items) and tick each item as it finishes, in the same message as your next tool call.`;
  } catch { return null; }
}

let input;
```

**Replace** in `claude/hooks/goal-gate.mjs`:

```js
  let msg = null; try { msg = (await coord?.relay(input)) || null; } catch {}
  if (msg) { try { if (goalPath) fs.rmSync(path.join(path.dirname(goalPath), `.goal-gate-${sid}.json`), { force: true }); } catch {} block(msg); }
  if (!goalPath) allow();
  const dir = path.dirname(goalPath);
  const stat = fs.statSync(goalPath);
```

**with**:

```js
  let msg = null; try { msg = (await coord?.relay(input)) || null; } catch {}
  if (msg) { try { if (goalPath) fs.rmSync(path.join(path.dirname(goalPath), `.goal-gate-${sid}.json`), { force: true }); } catch {} block(msg); }
  if (!goalPath) { const n = missingNudge(input, sid, candidates); if (n) block(n); allow(); }
  const dir = path.dirname(goalPath);
  const stat = fs.statSync(goalPath);
```

**Replace** in `claude/skills/handoff-launch/live.mjs`:

```js
// <config>/skills/handoff-launch -> <config>/hooks/coord.mjs (the repo has the same layout: claude/skills, claude/hooks).
export const COORD_MJS = path.resolve(HERE, "..", "..", "hooks", "coord.mjs");
// The hooks every launched session gets: PostToolUse (all tools) and Notification -> coord.mjs. launch.mjs folds them
// into the profile's ONE --settings file (two --settings flags do not merge: the last one wins entirely).
export function sessionHooks() {
  const cmd = (sub) => ({ type: "command", command: `node "${fwd(COORD_MJS)}" ${sub}`, timeout: 10 });
  return { hooks: { PostToolUse: [{ matcher: "*", hooks: [cmd("post-tool")] }], Notification: [{ hooks: [cmd("notify")] }] } };
}
// session-hooks.json next to the registry: the inspectable copy of sessionHooks() (written when it changed).
```

**with**:

```js
// <config>/skills/handoff-launch -> <config>/hooks/coord.mjs (the repo has the same layout: claude/skills, claude/hooks).
export const COORD_MJS = path.resolve(HERE, "..", "..", "hooks", "coord.mjs");
// The hooks every launched session gets -> coord.mjs: PostToolUse (all tools), Notification, and (batch A) PreToolUse on
// file writes (the write fence), UserPromptSubmit (the lane note) and Stop (the claude-in-chrome tab check). launch.mjs
// folds them into the profile's ONE --settings file (two --settings flags do not merge: the last one wins entirely).
export function sessionHooks() {
  const cmd = (sub) => ({ type: "command", command: `node "${fwd(COORD_MJS)}" ${sub}`, timeout: 10 });
  return { hooks: {
    PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [cmd("fence")] }],
    PostToolUse: [{ matcher: "*", hooks: [cmd("post-tool")] }],
    Notification: [{ hooks: [cmd("notify")] }],
    UserPromptSubmit: [{ hooks: [cmd("lane-note")] }],
    Stop: [{ hooks: [cmd("stop")] }],
  } };
}
// session-hooks.json next to the registry: the inspectable copy of sessionHooks() (written when it changed).
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/lane-hooks.test.mjs claude/skills/handoff-launch/tests/coord-hook.test.mjs claude/skills/handoff-launch/tests/alerts.test.mjs`
Expected: `ℹ fail 0` (the stage-2 hook tests, the isolation test of post-tool included, still pass).

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/live.mjs claude/hooks/coord.mjs claude/hooks/goal-gate.mjs claude/skills/handoff-launch/tests
git commit -m "hooks: the write fence, the lane note, the claude-in-chrome Stop check, checklist lines; goal-gate nudges hand-opened sessions"
```

---

### Task 10: Browser tools: the pinned Playwright server in every profile; claude-in-chrome kept

**Files:**
- Modify: `claude/skills/handoff-launch/profiles.json` (the note, `servers.playwright`, `profiles.lean`)
- Modify: `claude/skills/handoff-launch/launch.mjs` (imports: `CFG`; new `builtinServer` before `profileArgs`; the server
  resolution `:169`)
- Test: `claude/skills/handoff-launch/tests/profiles-cap.test.mjs`, `tests/restart.test.mjs`

**Interfaces:**
- Consumes: Task 4 `CFG` export (already in `live.mjs`).
- Produces: `builtinServer(def)` (`{config}` -> the config dir; the `fallback` when the pinned cli is missing; the
  `fallback` key never reaches the file); every profile's MCP config has `playwright` (`full` keeps the user's
  configuration).

- [ ] **Step 1: Write the failing tests**

**Replace** in `claude/skills/handoff-launch/tests/profiles-cap.test.mjs`:

```js
}
const setCap = (sb, cfg) => fs.writeFileSync(path.join(sb.reg, "launch-config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));

test("default profile is lean: all heavy plugins off, empty strict MCP config, registry profile lean", () => {
  const sb = sandbox();
  try {
    const f = profileFiles(winOut(launch(sb, "A")).claude_args);
    assert.deepEqual(disabled(f.settings), [...HEAVY].sort());
    assert.deepEqual(readJson(f.mcp), { mcpServers: {} });
    assert.equal(path.dirname(f.settings), path.join(sb.reg, "profiles").split(path.sep).join("/"));
    assert.match(path.basename(f.settings), /^lean-[0-9a-f]{8}\.settings\.json$/);
    assert.equal(launches(sb).at(-1).profile, "lean");
    // Same profile again: the same content-addressed files.
    const g = profileFiles(winOut(launch(sb, "B")).claude_args);
    assert.deepEqual(g, f);
    assert.equal(fs.readdirSync(path.join(sb.reg, "profiles")).length, 2);
  } finally { sb.cleanup(); }
});

const PLAYWRIGHT = { playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] } };

test("--profile browser disables every heavy plugin and runs the built-in playwright server via --mcp-config", () => {
```

**with**:

```js
}
const setCap = (sb, cfg) => fs.writeFileSync(path.join(sb.reg, "launch-config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
// Batch A: every profile keeps the playwright server. The sandbox's config dir has no pinned install, so the server is the
// fallback (npx of the same pin); a test below installs a stand-in cli.js to see the pinned one.
const PW_ARGS = ["--isolated", "--headless", "--idle-timeout", "900000"];
const PLAYWRIGHT = { playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@0.0.83", ...PW_ARGS] } };

test("default profile is lean: all heavy plugins off, a strict MCP config with playwright only, registry profile lean", () => {
  const sb = sandbox();
  try {
    const f = profileFiles(winOut(launch(sb, "A")).claude_args);
    assert.deepEqual(disabled(f.settings), [...HEAVY].sort());
    assert.deepEqual(readJson(f.mcp), { mcpServers: PLAYWRIGHT });
    assert.equal(path.dirname(f.settings), path.join(sb.reg, "profiles").split(path.sep).join("/"));
    assert.match(path.basename(f.settings), /^lean-[0-9a-f]{8}\.settings\.json$/);
    assert.equal(launches(sb).at(-1).profile, "lean");
    // Same profile again: the same content-addressed files.
    const g = profileFiles(winOut(launch(sb, "B")).claude_args);
    assert.deepEqual(g, f);
    assert.equal(fs.readdirSync(path.join(sb.reg, "profiles")).length, 2);
  } finally { sb.cleanup(); }
});

test("--profile browser disables every heavy plugin and runs the built-in playwright server via --mcp-config", () => {
```

**Replace** in `claude/skills/handoff-launch/tests/profiles-cap.test.mjs`:

```js
    fs.writeFileSync(sb.env.HL_CLAUDE_JSON, JSON.stringify({ mcpServers: { repomix: { command: "npx", args: ["repomix", "--mcp"] }, "ast-grep": { command: "ast-grep-mcp" }, other: { command: "x" } } }));
    let f = profileFiles(winOut(launch(sb, "A", "--profile", "explore")).claude_args);
    assert.deepEqual(readJson(f.mcp), { mcpServers: { repomix: { command: "npx", args: ["repomix", "--mcp"] }, "ast-grep": { command: "ast-grep-mcp" } } });
    assert.deepEqual(disabled(f.settings), [...HEAVY].sort());
    // maps: not in the user servers -> not found yet
    let r = launch(sb, "B", "--profile", "maps");
    assert.equal(r.code, 2); assert.match(r.err, /MCP server google-maps not found/);
    exactly(sb, 1);
    fs.writeFileSync(path.join(sb.repo, ".mcp.json"), JSON.stringify({ mcpServers: { "google-maps": { command: "maps-mcp", env: { KEY: "test-key" } } } }));
    sb.git(sb.repo, "add", ".mcp.json"); sb.git(sb.repo, "commit", "-q", "-m", "mcp");
    f = profileFiles(winOut(launch(sb, "B", "--profile", "maps", "--worktree", "lane-m")).claude_args);
    assert.deepEqual(readJson(f.mcp), { mcpServers: { "google-maps": { command: "maps-mcp", env: { KEY: "test-key" } } } });
    assert.equal(launches(sb).at(-1).profile, "maps");
  } finally { sb.cleanup(); }
```

**with**:

```js
    fs.writeFileSync(sb.env.HL_CLAUDE_JSON, JSON.stringify({ mcpServers: { repomix: { command: "npx", args: ["repomix", "--mcp"] }, "ast-grep": { command: "ast-grep-mcp" }, other: { command: "x" } } }));
    let f = profileFiles(winOut(launch(sb, "A", "--profile", "explore")).claude_args);
    assert.deepEqual(readJson(f.mcp), { mcpServers: { repomix: { command: "npx", args: ["repomix", "--mcp"] }, "ast-grep": { command: "ast-grep-mcp" }, ...PLAYWRIGHT } });
    assert.deepEqual(disabled(f.settings), [...HEAVY].sort());
    // maps: not in the user servers -> not found yet
    let r = launch(sb, "B", "--profile", "maps");
    assert.equal(r.code, 2); assert.match(r.err, /MCP server google-maps not found/);
    exactly(sb, 1);
    fs.writeFileSync(path.join(sb.repo, ".mcp.json"), JSON.stringify({ mcpServers: { "google-maps": { command: "maps-mcp", env: { KEY: "test-key" } } } }));
    sb.git(sb.repo, "add", ".mcp.json"); sb.git(sb.repo, "commit", "-q", "-m", "mcp");
    f = profileFiles(winOut(launch(sb, "B", "--profile", "maps", "--worktree", "lane-m")).claude_args);
    assert.deepEqual(readJson(f.mcp), { mcpServers: { "google-maps": { command: "maps-mcp", env: { KEY: "test-key" } }, ...PLAYWRIGHT } });
    assert.equal(launches(sb).at(-1).profile, "maps");
  } finally { sb.cleanup(); }
```

**Replace** in `claude/skills/handoff-launch/tests/profiles-cap.test.mjs`:

```js
    assert.ok(!fs.existsSync(path.join(reg, "sessions.jsonl")));
  } finally { sb.cleanup(); }
});
```

**with**:

```js
    assert.ok(!fs.existsSync(path.join(reg, "sessions.jsonl")));
  } finally { sb.cleanup(); }
});

test("every profile keeps playwright (the pinned install when present, else npx of the same pin) and none disables claude-in-chrome", () => {
  const sb = sandbox();
  try {
    // Stub servers so every shipped profile resolves.
    fs.writeFileSync(sb.env.HL_CLAUDE_JSON, JSON.stringify({ mcpServers: { "google-maps": { command: "m" }, repomix: { command: "r" }, "ast-grep": { command: "a" } } }));
    const shipped = readJson(path.join(import.meta.dirname, "..", "profiles.json"));
    for (const name of Object.keys(shipped.profiles)) {
      const r = sb.run("profile-args", "--profile", name);
      assert.equal(r.code, 0, `${name}: ${r.err}`);
      const pa = JSON.parse(r.out);
      assert.ok(!pa.args.includes("--no-chrome"), name);
      assert.notEqual(readJson(pa.args[pa.args.indexOf("--settings") + 1]).claudeInChromeDefaultEnabled, false, name);
      if (name === "full") continue; // full keeps the user's own configuration
      assert.deepEqual(readJson(pa.args[pa.args.indexOf("--mcp-config") + 1]).mcpServers.playwright, PLAYWRIGHT.playwright, name);
    }
    const cli = path.join(sb.cfg, "mcp-servers", "node_modules", "@playwright", "mcp", "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, "");
    const pa = JSON.parse(sb.run("profile-args").out);
    assert.deepEqual(readJson(pa.args[pa.args.indexOf("--mcp-config") + 1]).mcpServers.playwright,
      { type: "stdio", command: "node", args: [cli.split(path.sep).join("/"), ...PW_ARGS] });
  } finally { sb.cleanup(); }
});
```

**Replace** in `claude/skills/handoff-launch/tests/restart.test.mjs`:

```js
    assert.equal(s.enabledPlugins["pyright-lsp@claude-plugins-official"], undefined); // python keeps it
    assert.equal(s.enabledPlugins["playwright@claude-plugins-official"], false);
    assert.deepEqual(JSON.parse(fs.readFileSync(uq(a[6]), "utf8")), { mcpServers: {} });
    // The same files a fresh launch of the profile passes (content-addressed).
    const f = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "F", "--model", "opus", "--effort", "high", "--profile", "python", "--worktree", "lane-f").out).claude_args;
```

**with**:

```js
    assert.equal(s.enabledPlugins["pyright-lsp@claude-plugins-official"], undefined); // python keeps it
    assert.equal(s.enabledPlugins["playwright@claude-plugins-official"], false);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(uq(a[6]), "utf8")).mcpServers), ["playwright"]); // batch A: every profile keeps playwright
    // The same files a fresh launch of the profile passes (content-addressed).
    const f = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "F", "--model", "opus", "--effort", "high", "--profile", "python", "--worktree", "lane-f").out).claude_args;
```

**Replace** in `claude/skills/handoff-launch/tests/restart.test.mjs`:

```js
    assert.equal(r.code, 0, r.err);
    const args = JSON.parse(r.out).claude_args;
    assert.deepEqual(JSON.parse(fs.readFileSync(uq(args[args.indexOf("'--mcp-config'") + 1]), "utf8")), { mcpServers: { "google-maps": { command: "maps-mcp" } } });
    // Without the server, the refusal names the dirs it read: the worktree, then the main checkout - real paths.
    fs.rmSync(path.join(sb.repo, ".mcp.json"));
```

**with**:

```js
    assert.equal(r.code, 0, r.err);
    const args = JSON.parse(r.out).claude_args;
    const servers = JSON.parse(fs.readFileSync(uq(args[args.indexOf("'--mcp-config'") + 1]), "utf8")).mcpServers;
    assert.deepEqual(servers["google-maps"], { command: "maps-mcp" }); assert.deepEqual(Object.keys(servers).sort(), ["google-maps", "playwright"]);
    // Without the server, the refusal names the dirs it read: the worktree, then the main checkout - real paths.
    fs.rmSync(path.join(sb.repo, ".mcp.json"));
```


- [ ] **Step 2: Run them to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/profiles-cap.test.mjs claude/skills/handoff-launch/tests/restart.test.mjs`
Expected: FAIL - lean's MCP config is `{ mcpServers: {} }`; browser's playwright is `npx @playwright/mcp@latest`.

- [ ] **Step 3: Implement**

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf, inboxDir } from "./merge.mjs";
import { HERE, REG_DIR, PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hostBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooks, sessionHooksFile, triggerTick, COORD, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness,
  agentsList, listedAgent, launcherEnv, forgetLiveness, goalOf, projectKey } from "./live.mjs";
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine, parseGoal, goalNote } from "./recover-lib.mjs";
import * as G from "./lane-lib.mjs";
import { guardedClose } from "./recover.mjs";

const IDLE_CLOSE_MS = 10 * MIN;
```

**with**:

```js
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, branchRead, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf, inboxDir } from "./merge.mjs";
import { HERE, REG_DIR, PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hostBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv,
  sessionHooks, sessionHooksFile, triggerTick, COORD, CFG, copyGoal, readJson, writeAtomic, startingLine, untracked, claudeSpawn, sessionLiveness,
  agentsList, listedAgent, launcherEnv, forgetLiveness, goalOf, projectKey } from "./live.mjs";
import { RECOVERY_LINE, CAP_REFUSED, capRefusal, blockedLanes, recoveryMode, freshLaunchArgs, untrackedLine, orphanLine, parseGoal, goalNote } from "./recover-lib.mjs";
import * as G from "./lane-lib.mjs";
import { guardedClose } from "./recover.mjs";

const IDLE_CLOSE_MS = 10 * MIN;
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
// merge, the last one wins entirely, so the hooks ride in this ONE file. With baseSettings, "full" also gets a
// --settings file (the hooks alone).
function profileArgs(list, workDirs, baseSettings = {}) {
  const fail = (m) => { console.error(m); process.exit(2); };
```

**with**:

```js
// merge, the last one wins entirely, so the hooks ride in this ONE file. With baseSettings, "full" also gets a
// --settings file (the hooks alone).
// A built-in server of profiles.json "servers" as the --mcp-config file gets it: {config} in its args is the config dir
// (batch A: the pinned Playwright install under <config>/mcp-servers, run by node directly); when its first argument is a
// file that does not exist (the install is missing), its "fallback" is used. The fallback key never reaches the file.
function builtinServer(def) {
  if (!def || typeof def !== "object") return def;
  const fill = (d) => { const { fallback, ...rest } = d; return Array.isArray(rest.args) ? { ...rest, args: rest.args.map((a) => (typeof a === "string" ? a.replaceAll("{config}", fwd(CFG)) : a)) } : rest; };
  const main = fill(def), first = main.args?.[0];
  return def.fallback && typeof def.fallback === "object" && typeof first === "string" && /[\\/]/.test(first) && !fs.existsSync(first) ? fill(def.fallback) : main;
}
function profileArgs(list, workDirs, baseSettings = {}) {
  const fail = (m) => { console.error(m); process.exit(2); };
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
    const sources = [...[process.env.HL_CLAUDE_JSON || path.join(os.homedir(), ".claude.json"), ...[].concat(workDirs).map((d) => path.join(d, ".mcp.json"))].map(readServers), builtin];
    const missing = [];
    for (const n of mcp) { const hit = sources.find((s) => Object.hasOwn(s, n)); if (hit) servers[n] = hit[n]; else missing.push(n); }
    if (missing.length) fail(`profile ${profile}: MCP server ${missing.join(", ")} not found in ~/.claude.json mcpServers or ${[].concat(workDirs).map((d) => fwd(path.join(d, ".mcp.json"))).join(" / ")} or ${fwd(file)} servers`);
  }
```

**with**:

```js
    const sources = [...[process.env.HL_CLAUDE_JSON || path.join(os.homedir(), ".claude.json"), ...[].concat(workDirs).map((d) => path.join(d, ".mcp.json"))].map(readServers), builtin];
    const missing = [];
    for (const n of mcp) { const hit = sources.find((s) => Object.hasOwn(s, n)); if (hit) servers[n] = hit === builtin ? builtinServer(hit[n]) : hit[n]; else missing.push(n); }
    if (missing.length) fail(`profile ${profile}: MCP server ${missing.join(", ")} not found in ~/.claude.json mcpServers or ${[].concat(workDirs).map((d) => fwd(path.join(d, ".mcp.json"))).join(" / ")} or ${fwd(file)} servers`);
  }
```

**Replace** in `claude/skills/handoff-launch/profiles.json`:

```json
{
  "_note": "plugins = non-MCP heavy plugins a profile keeps (e.g. LSP). Every MCP server, a plugin's one included, goes in mcp: --strict-mcp-config drops plugin MCP servers. Names in mcp resolve from ~/.claude.json mcpServers, <work dir>/.mcp.json, <repo>/.mcp.json, then servers below.",
  "default": "lean",
  "heavy_plugins": [
    "playwright@claude-plugins-official",
    "context7@claude-plugins-official",
    "pyright-lsp@claude-plugins-official",
    "typescript-lsp@claude-plugins-official"
  ],
  "servers": {
    "playwright": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest"] }
  },
  "profiles": {
    "lean": { "plugins": [], "mcp": [] },
    "python": { "plugins": ["pyright-lsp@claude-plugins-official"], "mcp": [] },
    "browser": { "plugins": [], "mcp": ["playwright"] },
```

**with**:

```json
{
  "_note": "plugins = non-MCP heavy plugins a profile keeps (e.g. LSP). Every MCP server, a plugin's one included, goes in mcp: --strict-mcp-config drops plugin MCP servers. Names in mcp resolve from ~/.claude.json mcpServers, <work dir>/.mcp.json, <repo>/.mcp.json, then servers below. Every profile keeps playwright (lean includes it) and claude-in-chrome (no profile may pass --no-chrome); full keeps the user's own configuration. playwright runs the pinned install directly ({config} = the config dir; update: npm install --prefix <config>/mcp-servers @playwright/mcp@<version>, then change the fallback's pin), headless and isolated, its browser closed after 15 min without a call; fallback = npx of the same pin when the install is missing.",
  "default": "lean",
  "heavy_plugins": [
    "playwright@claude-plugins-official",
    "context7@claude-plugins-official",
    "pyright-lsp@claude-plugins-official",
    "typescript-lsp@claude-plugins-official"
  ],
  "servers": {
    "playwright": {
      "type": "stdio", "command": "node",
      "args": ["{config}/mcp-servers/node_modules/@playwright/mcp/cli.js", "--isolated", "--headless", "--idle-timeout", "900000"],
      "fallback": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp@0.0.83", "--isolated", "--headless", "--idle-timeout", "900000"] }
    }
  },
  "profiles": {
    "lean": { "plugins": [], "mcp": ["playwright"] },
    "python": { "plugins": ["pyright-lsp@claude-plugins-official"], "mcp": [] },
    "browser": { "plugins": [], "mcp": ["playwright"] },
```


- [ ] **Step 4: Run them to verify they pass**

Run: `node --test claude/skills/handoff-launch/tests/profiles-cap.test.mjs claude/skills/handoff-launch/tests/restart.test.mjs claude/skills/handoff-launch/tests/coord-hook.test.mjs`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/profiles.json claude/skills/handoff-launch/launch.mjs claude/skills/handoff-launch/tests
git commit -m "profiles: every profile keeps the pinned headless Playwright server (npx fallback); claude-in-chrome never disabled"
```

---

### Task 11: The isolation test, extended

The spec's isolation test: a second lane's files, registry lines and processes are unchanged when the first lane is
fenced, queued to, or closed. All code exists by now, so this test passes on first run; it pins the guarantee. If it
fails, the bug is in the task that owns that code (fence: 9, queue: 8, the close: 5), fixed there.

**Files:**
- Test: `claude/skills/handoff-launch/tests/isolation.test.mjs`

**Interfaces:**
- Consumes: Tasks 4, 5, 8, 9.
- Produces: nothing new.

- [ ] **Step 1: Write the test**

**Replace** in `claude/skills/handoff-launch/tests/isolation.test.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane, commitIn, writeDone, sessionLine, appendLine, writeTranscript, setAgents, coordRun, tx, host, alive } from "./helpers.mjs";
import { RESUME_WORKS } from "../recover-lib.mjs";

```

**with**:

```js
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane, commitIn, writeDone, sessionLine, appendLine, writeTranscript, setAgents, coordRun, tx, host, emptyHost, alive } from "./helpers.mjs";
import { RESUME_WORKS } from "../recover-lib.mjs";

```

**Replace** in `claude/skills/handoff-launch/tests/isolation.test.mjs`:

```js
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});
```

**with**:

```js
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("isolation (batch A): fencing, queueing to and closing lane A leave lane B's files, registry lines and process unchanged", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hA = emptyHost(), hB = host();
  try {
    const wt = (b) => path.join(sb.repo, ".claude", "worktrees", b);
    fs.mkdirSync(wt("lane-b"), { recursive: true }); fs.writeFileSync(path.join(wt("lane-b"), "b.txt"), "B's file\n");
    const old = Date.now() - 40 * MIN;
    const a = sessionLine(sb, { name: "A", id: "A@1", group: "g1", branch: "lane-a", worktree: wt("lane-a").split(path.sep).join("/"), sid: "a-s1", host: hA, supersedes: null });
    const tf = writeTranscript(sb, sb.repo, a.session_id, tx({ start: old }).user("go").say("done").turnDone().entries());
    fs.utimesSync(tf, new Date(old), new Date(old));
    const b = sessionLine(sb, { name: "B", id: "B@1", group: "g1", branch: "lane-b", worktree: wt("lane-b").split(path.sep).join("/"), sid: "b-s1", host: hB, supersedes: null });
    const bLines = () => sb.registry().filter((o) => JSON.stringify(o).includes("B@1") || o.name === "B");
    const before = { lines: JSON.stringify(bLines()), file: fs.readFileSync(path.join(wt("lane-b"), "b.txt"), "utf8") };
    // A's session tries to write into B's worktree: denied, nothing written.
    const f = coordRun(sb, ["fence"], { input: { session_id: "a-s1", cwd: wt("lane-a"), tool_name: "Write", tool_input: { file_path: path.join(wt("lane-b"), "b.txt"), content: "x" } }, env: { HL_SESSION_ID: "A@1" } });
    assert.equal(JSON.parse(f.out).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(sb.run("queue", "--to", "A", "--text", "for A").code, 0);
    const t = coordRun(sb, ["tick"]); // A's claude is gone: closed; B runs claude: untouched
    assert.match(t.out, /^closed A \(gen 1\): claude exited$/m);
    assert.equal(alive(hA.pid), false); assert.equal(alive(hB.pid), true);
    assert.equal(JSON.stringify(bLines()), before.lines);
    assert.equal(fs.readFileSync(path.join(wt("lane-b"), "b.txt"), "utf8"), before.file);
    assert.equal(fs.existsSync(path.join(sb.repo, ".superpowers", "sessions", "g1", "inbox", "B.md")), false);
    assert.equal(b.id, "B@1");
  } finally { hA.kill(); hB.kill(); sb.cleanup(); }
});
```


- [ ] **Step 2: Run it**

Run: `node --test claude/skills/handoff-launch/tests/isolation.test.mjs`
Expected: `ℹ fail 0` on Windows (the new test skips elsewhere).

- [ ] **Step 3: Full suite, then commit**

Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`.

```bash
git add claude/skills/handoff-launch/tests/isolation.test.mjs
git commit -m "isolation: fencing, queueing to and closing one lane leave the other lane unchanged"
```

---

### Task 12: Docs: SKILL.md, coordinator.md, the launch.mjs header, the stage-2 spec wording

SKILL.md stays lean: lane rules and commands there, internals in `coordinator.md` (the `merge --skip/--force`
refusal details move there). Check its size after the edit: about 28 KB (stage 2 left it at 25.4 KB).

**Files:**
- Modify: `claude/skills/handoff-launch/SKILL.md`, `claude/skills/handoff-launch/coordinator.md`,
  `claude/skills/handoff-launch/launch.mjs` (header `:3-39`),
  `docs/specs/2026-10-04-stage2-loop-recovery-design.md` (`:328-329`, `:413`)
- (`profiles.json`'s note is Task 10's.)

- [ ] **Step 1: Edit the docs**

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

````markdown
```
node ~/.claude/skills/handoff-launch/launch.mjs --repo <repo dir> --handoff <path to handoff .md> --name <short-label>
     --model <m> --effort low|medium|high|xhigh|max [--mode window|bg] [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>] [--force] [--no-close] [--dry-run]
```
Fan-out subcommands (section 4): `launch.mjs group --group <id> --repo <dir> --integration <b> --target <b> [--test "<cmd>"] [--test-timeout-min <n>] [--mode window|bg] [--force]`,
`launch.mjs merge --group <id> [--repo <dir>] [--lane <name>] [--skip <lane> [--session <merge session>] --why <reason>] [--force] [--dry-run]`,
`launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]`, `launch.mjs status --group <id> [--repo <dir>] [--no-merge] [--dry-run]`.
Coordinator subcommands (section 5): `launch.mjs recover (--group <id> | --name <session>) --mode auto|report`,
`launch.mjs resume --group <id> [--lane <name>]`, `launch.mjs watchdog [--repo <dir>]` (what the coordinator tick would
do now; writes nothing), `node ~/.claude/hooks/coord.mjs tick --dry-run`.
`launch.mjs stop (--name <name> | --id <registry id>) [--why <text>]` writes a stop request by hand.
- `--model` + `--effort` are REQUIRED (the launcher refuses without them): size each session for ITS task before launching (user directives 2026-10-01). **Sizing the session** — judge two things, difficulty and length:

  | Session's task | `--model` | `--effort` |
  |---|---|---|
  | mechanical: doc edits, test/live-run babysitting, merges of reviewed branches | `opus` | `medium` |
  | normal controller: plans, dispatches, judges reviews | `opus` | `high` |
  | long AND hard: cross-cutting design, many rulings, multi-wave implementation | `opus` | `xhigh` (fable stays the reviewer via dispatch — too costly as a long controller) |
  | SHORT but very hard: one security/data-integrity ruling, a root cause nobody found, a high-stakes spec decision, bounded scope | `fable` | `high` |
  | short and the hardest class (correctness proof, an incident with data at risk) | `fable` | `xhigh` (`max` only if xhigh already failed on it) |

  Never Haiku; never sonnet as a session (sonnet is a mechanical subagent tier). If a session fails its task, relaunch one rung up. State the chosen row + reason in one line when reporting the launch. The session's subagents are still sized per dispatch by `sizing-dispatches`.
- Worktree sessions inherit the main checkout's `.claude/settings.local.json` (MCP approvals + allow rules, merged into any existing file), so they start without an "enable MCP servers?" prompt.
- `window` (default): new Windows Terminal window, interactive `claude` session, visible to the user. Windows only — the launcher refuses it on other OSes (use `bg`).
- `bg`: Claude Code background session (`claude agents` to list, `claude attach <id>` to open). Background sessions
  cannot edit the main checkout until they enter a worktree — use `window` for work that writes to the checkout.
- `--worktree <branch>`: the session runs in `<repo>/.claude/worktrees/<branch-slug>` (created from `--base`, default
  the repo's HEAD; reused if it exists). The main checkout is never checked out. The handoff is passed by absolute path.
  A lane is repo + branch: only a session's own relay may launch on the checkout + branch that hosts it; an on-demand
  helper gets `--worktree <its own branch>` (why: `coordinator.md`, Closes by the tick).
- The launcher strips this session's `CLAUDE_*` environment and reloads PATH from the registry, so the child is a
  genuinely new session. Run with `--dry-run` first if anything looks unusual: it shows the worktree action, the
  registry line and the windows it would close, and changes nothing.
- Every launch is recorded in `~/.claude/skills/handoff-launch/sessions.jsonl` (name, repo, branch, worktree,
  generation per repo+branch, window host pid, `--session-id`, group, profile, model, effort, `coord: 1`, the base
  pointer prompt's file). Append-only (a `{starting}` line precedes each launch line; see `coordinator.md`).

### Lane profiles and the session cap
`--profile a,b` (from `profiles.json`) picks what heavy tooling a session keeps; names union, `lean` is implied, the
default is `lean`. Every other heavy plugin is disabled via one `--settings` file, and only the kept MCP servers run
(`--strict-mcp-config --mcp-config <file>`, which also drops plugin MCP servers and claude.ai connectors; plugin skills still load).
So a profile keeps only non-MCP plugins in `plugins` (e.g. an LSP); an MCP server, a plugin's one included, goes in
`mcp`. Names resolve from `~/.claude.json` `mcpServers`, the work dir's `.mcp.json`, the repo's `.mcp.json`, then the
built-in `servers` of `profiles.json`; a profile that keeps a plugin named like a built-in server exits 2.

| Profile | Keeps | Measured RAM it saves per session |
|---|---|---|
| `lean` (default) | no heavy plugin, no MCP server | ~480 MB (22 procs / 513 MB of children -> ~35 MB) |
| `python` | pyright LSP (lanes editing Python that want diagnostics) | pyright costs ~230 MB once a .py is edited |
| `browser` | the playwright MCP server (built-in `servers` entry, via `--mcp-config`; tools `mcp__playwright__*`, not the plugin's) | playwright costs ~140 MB |
| `maps` | the `google-maps` server from the work dir's `.mcp.json` | - |
| `explore` | `repomix` + `ast-grep` from `~/.claude.json` | they cost ~150 + ~120 MB |
| `full` | everything: no plugin or MCP flags (the old behaviour); its `--settings` file carries only the coordinator hooks | 0 |

An unknown profile or MCP server exits 2. The generated files live in `<registry dir>/profiles/` (content-addressed;
`--dry-run` writes them too, nothing else). The registry line records the canonical `profile`; for a restart,
`launch.mjs profile-args --profile <it> [--repo <work dir>]` prints `{"profile", "args"}` for `claude --resume <id> <args>`
(keep the args before any prompt: `--mcp-config` is variadic).
A `.mcp.json` or `~/.claude.json` that exists but is not valid JSON also exits 2, naming the file.
Registry entries without `profile` were launched before profiles existed (all plugins and servers): restart them by
hand with `--profile full`, or pick a lane profile on purpose (every automatic restart reuses the entry's profile, and
`full` for an entry without one). Every launched session gets the coordinator hooks inside its ONE profile
`--settings` file (`profile-args` prints it). Two `--settings` flags do not merge (the last one wins): never add a
hand-made `--settings` to a launcher session.
**Session cap**: a launch is refused (exit 3) before it creates or records anything, while ≥ `max_sessions` (6, an
integer ≥ 1) other sessions run (windows whose host is alive or unproven, bg sessions `claude agents` lists as
unfinished; the newest one on the same repo+branch is not counted - a relay replaces it) or free RAM < `min_free_gb`
(3). Config: `<registry dir>/launch-config.json`. It counts launcher sessions only: hand-opened sessions are not
counted (the free-RAM floor covers them), and a window whose claude exited still counts until its window is closed.
Merge sessions (`<group>-merge...`) are exempt. Close idle sessions first; `--force` overrides it only with the user's
OK. `--dry-run` reports `cap` and never refuses. The cap also refuses `--resume`. A coordinator restart it
refuses is deferred (one alert, retried each tick), never blocked; `launch.mjs resume` leaves the lane blocked
(details: `coordinator.md`).

## 3. Verify and hand over
````

**with**:

````markdown
```
node ~/.claude/skills/handoff-launch/launch.mjs --repo <repo dir> --handoff <path to handoff .md> --name <short-label>
     --model <m> --effort low|medium|high|xhigh|max [--mode window|bg] [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>]
     [--supersedes <registry id>] [--priority high|normal|low] [--scope "<text>"] [--force] [--no-close] [--dry-run]
```
Fan-out subcommands (section 4): `launch.mjs group --group <id> --repo <dir> --integration <b> --target <b> [--test "<cmd>"] [--test-timeout-min <n>] [--mode window|bg] [--force]`,
`launch.mjs merge --group <id> [--repo <dir>] [--lane <name>] [--skip <lane> [--session <merge session>] --why <reason>] [--force] [--dry-run]`,
`launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]`, `launch.mjs status --group <id> [--repo <dir>] [--no-merge] [--dry-run]`.
Coordinator subcommands (section 5): `launch.mjs recover (--group <id> | --name <session>) --mode auto|report`,
`launch.mjs resume --group <id> [--lane <name>]`, `launch.mjs watchdog [--repo <dir>]` (what the coordinator tick would
do now; writes nothing), `node ~/.claude/hooks/coord.mjs tick --dry-run`.
`launch.mjs stop (--name <name> | --id <registry id>) [--why <text>]` writes a stop request by hand.
Lane subcommands (sections 4, 5): `launch.mjs queue --to <lane> (--text "<text>" | --text-file <f>) [--after-merge] [--from <name>]`,
`launch.mjs priority --name <lane> --set high|normal|low`, `launch.mjs sessions [--repo <dir>]`. An unknown `--flag`
only warns (`warning: unknown flag ...`): fix the typo.
- `--model` + `--effort` are REQUIRED (the launcher refuses without them): size each session for ITS task before launching (user directives 2026-10-01). **Sizing the session** — judge two things, difficulty and length:

  | Session's task | `--model` | `--effort` |
  |---|---|---|
  | mechanical: doc edits, test/live-run babysitting, merges of reviewed branches | `opus` | `medium` |
  | normal controller: plans, dispatches, judges reviews | `opus` | `high` |
  | long AND hard: cross-cutting design, many rulings, multi-wave implementation | `opus` | `xhigh` (fable stays the reviewer via dispatch — too costly as a long controller) |
  | SHORT but very hard: one security/data-integrity ruling, a root cause nobody found, a high-stakes spec decision, bounded scope | `fable` | `high` |
  | short and the hardest class (correctness proof, an incident with data at risk) | `fable` | `xhigh` (`max` only if xhigh already failed on it) |

  Never Haiku; never sonnet as a session (sonnet is a mechanical subagent tier). If a session fails its task, relaunch one rung up. State the chosen row + reason in one line when reporting the launch. The session's subagents are still sized per dispatch by `sizing-dispatches`.
  **Priority** follows the sizing (fable, or effort xhigh/max → `high`; high → `normal`; medium/low → `low`);
  `--priority` overrides it, `launch.mjs priority` changes it later, and restarts keep it. It orders `status`, the merge
  queue and the coordinator's restarts; it never bypasses the session cap.
- Worktree sessions inherit the main checkout's `.claude/settings.local.json` (MCP approvals + allow rules, merged into any existing file), so they start without an "enable MCP servers?" prompt.
- `window` (default): new Windows Terminal window, interactive `claude` session, visible to the user. Windows only — the launcher refuses it on other OSes (use `bg`).
- `bg`: Claude Code background session (`claude agents` to list, `claude attach <id>` to open). Background sessions
  cannot edit the main checkout until they enter a worktree — use `window` for work that writes to the checkout.
- `--worktree <branch>`: the session runs in `<repo>/.claude/worktrees/<branch-slug>` (created from `--base`, default
  the repo's HEAD; reused if it exists). The main checkout is never checked out. The handoff is passed by absolute path.
  A lane is repo + branch. Only a session's own relay, a resume, a coordinator restart, or a launch with
  `--supersedes <its id>` replaces a session. A launch onto a checkout whose session is running is refused (exit 3;
  `--force` only with the user's OK); helpers get `--worktree <own branch>`. A window there whose claude exited is
  closed first. A session that launches another session's next stage on its behalf passes `--supersedes <that id>`.
- The launcher strips this session's `CLAUDE_*` environment and reloads PATH from the registry, so the child is a
  genuinely new session. Run with `--dry-run` first if anything looks unusual: it shows the worktree action, the
  registry line and the windows it would close, and changes nothing.
- Every launch is recorded in `~/.claude/skills/handoff-launch/sessions.jsonl` (name, repo, branch, worktree,
  generation per repo+branch, window host pid, `--session-id`, group, profile, model, effort, `coord: 1`, the base
  pointer prompt's file, `launched_by`, `supersedes` - the entry it replaces; a line without the key is a legacy line -
  `scope` and `priority`). Append-only (a `{starting}` line precedes each launch line; see `coordinator.md`). Never
  write the new line types (`supersedes`, `{priority}`, `{dead_start}`) by hand.
- `--resume <session id> [--profile <names>]` resumes a session; `--profile` picks a new profile (else the entry's).

### Lane profiles and the session cap
`--profile a,b` (from `profiles.json`) picks what heavy tooling a session keeps; names union, `lean` is implied, the
default is `lean`. Every other heavy plugin is disabled via one `--settings` file, and only the kept MCP servers run
(`--strict-mcp-config --mcp-config <file>`, which also drops plugin MCP servers and claude.ai connectors; plugin skills still load).
So a profile keeps only non-MCP plugins in `plugins` (e.g. an LSP); an MCP server, a plugin's one included, goes in
`mcp`. Names resolve from `~/.claude.json` `mcpServers`, the work dir's `.mcp.json`, the repo's `.mcp.json`, then the
built-in `servers` of `profiles.json`; a profile that keeps a plugin named like a built-in server exits 2.

| Profile | Keeps | Measured RAM it saves per session |
|---|---|---|
| `lean` (default) | no heavy plugin; the playwright MCP server only (built-in `servers` entry; tools `mcp__playwright__*`) | ~480 MB (22 procs / 513 MB of children -> ~35 MB); playwright's idle server costs ~100 MB, its browser ~550 MB while in use |
| `python` | pyright LSP (lanes editing Python that want diagnostics) | pyright costs ~230 MB once a .py is edited |
| `browser` | the same as `lean` (kept for older handoffs) | - |
| `maps` | the `google-maps` server from the work dir's `.mcp.json` | - |
| `explore` | `repomix` + `ast-grep` from `~/.claude.json` | they cost ~150 + ~120 MB |
| `full` | everything: no plugin or MCP flags (the old behaviour); its `--settings` file carries only the coordinator hooks | 0 |

An unknown profile or MCP server exits 2. The generated files live in `<registry dir>/profiles/` (content-addressed;
`--dry-run` writes them too, nothing else). The registry line records the canonical `profile`; for a restart,
`launch.mjs profile-args --profile <it> [--repo <work dir>]` prints `{"profile", "args"}` for `claude --resume <id> <args>`
(keep the args before any prompt: `--mcp-config` is variadic).
A `.mcp.json` or `~/.claude.json` that exists but is not valid JSON also exits 2, naming the file.
Registry entries without `profile` were launched before profiles existed (all plugins and servers): restart them by
hand with `--profile full`, or pick a lane profile on purpose (every automatic restart reuses the entry's profile, and
`full` for an entry without one). Every launched session gets the coordinator hooks inside its ONE profile
`--settings` file (`profile-args` prints it). Two `--settings` flags do not merge (the last one wins): never add a
hand-made `--settings` to a launcher session.
**Session cap**: a launch is refused (exit 3) before it creates or records anything, while ≥ `max_sessions` (6, an
integer ≥ 1) other sessions run (windows whose host is alive or unproven, bg sessions `claude agents` lists as
unfinished; the entry the launch replaces - its `supersedes` - is not counted) or free RAM < `min_free_gb`
(3). Config: `<registry dir>/launch-config.json`. It counts launcher sessions only: hand-opened sessions are not
counted (the free-RAM floor covers them), and a window whose claude exited still counts until its window is closed.
Merge sessions (`<group>-merge...`) are exempt. Close idle sessions first; `--force` overrides it only with the user's
OK. `--dry-run` reports `cap` and never refuses. The cap also refuses `--resume`. A coordinator restart it
refuses is deferred (one alert, retried each tick), never blocked; `launch.mjs resume` leaves the lane blocked
(details: `coordinator.md`).

**Browser tools** (every profile keeps both): Playwright (`mcp__playwright__*`) is the default live-testing tool - its
own headless browser per session, closed after 15 min without a call. Use claude-in-chrome only for a site where the
user is logged in: it is shared by every session (expect clashes), and you close the tabs you opened.

## 3. Verify and hand over
````

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

```markdown
   - `FINAL_READY ...`: every lane is merged or blocked. Ask the user to approve the final merge of the integration
     branch into the target (never push without asking). After it, set up a NEW group with `launch.mjs group` (step 1;
     without it the group silently becomes a legacy group), then launch the listed `next_after_merge` stages in it,
     each on a NEW branch with `--base <target>`.
   - `ERROR ...` (exit 1): report it to the user verbatim. Never delete the lock or edit the merge worktree yourself.
   - `merge.lock changed hands repeatedly - run merge again`: run the same merge command once more.
```

**with**:

```markdown
   - `FINAL_READY ...`: every lane is merged or blocked. Ask the user to approve the final merge of the integration
     branch into the target (never push without asking). After it, set up a NEW group with `launch.mjs group` (step 1;
     without it the group silently becomes a legacy group), then launch the listed `next_after_merge` stages (merged
     lanes only) in it, each on a NEW branch with `--base <target>`. `held_next_after_merge=` lists an unmerged lane's
     stages with its state: they wait until that lane is resumed and merged. `queued_after_merge=<n> (<path>)` and
     `unread_inbox=[<lane>:<n>]` name queued work (step 8).
   - `ERROR ...` (exit 1): report it to the user verbatim. Never delete the lock or edit the merge worktree yourself.
   - `merge.lock changed hands repeatedly - run merge again`: run the same merge command once more.
```

**Replace** in `claude/skills/handoff-launch/SKILL.md`:

```markdown
     left in the merge worktree.
   - `merge --group <id> --skip <lane> --why "<reason>"` gives up on the lane's current head (`MERGE-BLOCKED`; a new
     done-marker head is queued again) and frees its merge session's lock. Refused (exit 1) for a merged lane, while the
     lane's merge is in progress in the merge worktree (`git merge --abort` there first), and while that lane's merge
     session is still running unless `--session <that session>` is given (its own handoff's skip command passes it).
   - `merge --group <id> --force` clears a lock that status reports as STALE (the merge process died, or the merge
     session's window closed or its process ended) or older than the test timeout; the lane is retried. It aborts
     nothing itself. Refused (exit 1, nothing merged) while a live merge process younger than the test timeout holds
     the lock, while the holding merge session is still running (`launch.mjs stop --name <session>` or close its window
     first), while a merge session's half merge is in progress in the merge worktree (abort a half merge in the merge
     worktree first: `git merge --abort` there), or when that lane is already merged (run plain `merge`). With both
     flags, `--skip` runs before `--force`. Both also refuse while a merge session that just took the lock
     has no launch line yet (`liveness is starting`, up to 3 min).
   - Large-org variant: a merge queue or CI-gated pull request per lane instead of local merges.
5. Never relaunch a finished lane under the old group: the launcher refuses a lane whose done marker exists (it would
   read as DONE at once). `--reopen` (archives the marker) reopens a lane only before it is merged (refused while it is
   merged or being merged); a reopened lane's new head is merged like any other.
6. `status` shows an unreadable or JSON `null` marker as `UNREADABLE` and does not count it as done, and warns when a
   marker's `head` is not the branch tip. Lanes always use `--worktree` (the head check reads the lane's recorded branch).
7. **Legacy groups** (no `config.json`, launched before 2026-10-03) keep the old flow: after its done marker, the lane
   runs `status --group <id>`; on `all_done=true merge_launched=false` it launches the merge handoff:
   `--repo <main repo> --handoff <merge handoff> --group <id> --name <id>-merge --model opus --effort high --worktree <integration branch> --base <target branch>`
   (an exclusive `merge.lock` + the registry refuse a second `<id>-merge`). That merge session confirms every lane is
   DONE, reviews and merges each branch (never pushes without asking), removes merged worktrees, and launches each
   lane's `next_after_merge` stages as a NEW group, each on a NEW branch with `--base <integration branch>` (so it has
   the merged code), with its own merge handoff. `merge_lock` without a merge entry is stale: relaunch with `--force`.
   `--reopen` is refused once that merge has launched. `launch.mjs merge` (any flag) on a legacy group only prints this
   flow and changes nothing.

## 5. Auto-close, stop and loop recovery (the coordinator)
Internals (state files and thresholds, close rules, housekeeping, orphans, alerts, test hooks): `coordinator.md` next
to this file. `<config>` is `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.
- **Auto-close at launch** (window launches): after launching generation N on a repo+branch, the windows of generations
  ≤ N-2 there are closed - only if the window's process is still the PowerShell host recorded at launch (PID-reuse
  guard) AND its session is idle (finished turn, no outstanding tool call, no background agents) for ≥ 10 min. A busy
  session gets a stop request instead. `--no-close` disables this launch-time close only; the tick's closes below
  still apply.
- **The coordinator tick** (`coord.mjs tick`, code in `recover.mjs`) runs at most every 5 min, started by Stop hooks,
  tool calls and launches. It spends no tokens, acts only on its target's own process tree and worktree, and never on
  a liveness it could not probe (`unknown`).
- **It also closes** idle windows (≥ 10 min, no outstanding call, no background agents, no permission prompt): a window
  of an older generation (N-1, or any older one still open) once N runs (every group and lone session); and, in `auto`
  mode only (auto groups and lone sessions launched after stage 2), a window that recorded `{paused}`. A close never
  leads to a restart. Generations count per repo + branch across names, so the older of two sessions on one
  checkout + branch is N-1 (the lane rule in section 2).
- **Lane rules.** The session hook (every launcher session has it) checks after each tool call and adds at most one
  line. When you receive:
  - an early warning ("You have repeated `<call>` N times ..."): stop repeating, find the cause, change approach. If you
    are waiting on something, wait with Monitor or ScheduleWakeup instead of polling.
  - a looping-subagent notice ("Agent `<type>` `<id>` is looping ..."): TaskStop that agent, find the cause in its
    transcript, fix the brief or the code, then re-dispatch per sizing-dispatches. A subagent told "You are
    repeating ..." stops and returns what it has and the suspected cause.
  - a stop request ("The coordinator flagged a loop ..." or "STOP REQUEST from handoff-launch ...", also sent by
    `launch.mjs stop --name <n>`) - **the stop contract**: finish or cancel the in-flight call, TaskStop every
    background agent you started, save your state (ledger or handoff, GOAL item `[!] loop-stopped`), end your turn and
    start no new work. The loop is cleared when you change something (a new successful edit, write or shell command)
    or stop repeating the call; a different read alone does not clear it.
  - a RECOVERY prompt (you are a restarted session): read the incident file it names, find and fix the cause
    (systematic-debugging), write it into the incident's `## Cause` section and your lane ledger, then continue. A
    Cause left empty sends the next restart one sizing rung up.
- **Pausing:** a session that saved its state and wants to be left alone appends
  `{"paused":"<its --name>","at":"<ISO time>"}` to the registry (`sessions.jsonl`). `<config>/state/coord/pause.json`
  (`{"until":"<ISO time>"}`, `"until": null` for no end) pauses all flags and restarts.
- **The ladder** (`auto` mode): warning → stop request → 5 min grace → incident file → kill → restart. Incidents:
  `<main repo>/.superpowers/sessions/<group>/incidents/<lane>-<n>.md`, or `<config>/state/coord/incidents/<name>-<n>.md`
  for a lone session. The first restart resumes the session (`claude --resume`; a background session always restarts
  fresh), the second is fresh from the original pointer prompt with its GOAL.md; at ≥ 400k tokens of context the first
  restart is fresh and the cap is 1. After that the lane is `LOOP-BLOCKED` and you are alerted. A restart that fails to
  launch also blocks the lane (its alert names the launcher log); one the session cap refuses is deferred. A lane whose
  done marker exists is not restarted, and only the newest generation of a lane is ever restarted. Waiting on a usage limit, on AskUserQuestion or on a permission prompt is never
  flagged.
- **Recovery modes:** groups and lone sessions launched after stage 2 are `auto`; earlier ones are `report-only` (an
  incident and an alert, nothing stopped; `status` prints `recovery: report-only (...)`). Switch with
  `launch.mjs recover (--group <id> | --name <session>) --mode auto|report`. Opting in warns about sessions that have
  no session hook: a stop request cannot reach them, so a loop there is killed 5 min after the request.
- **A merge session at its cap** keeps `merge.lock` (status shows STALE). Its alert says what to do: `git merge --abort`
  in `.claude/worktrees/_merge-<id>`, then `launch.mjs merge --group <id> --force` (or `--skip <lane> --why ...`).
- **`status`** lane notes: `incidents=<n> (latest <path>)`, `LOOP-BLOCKED (...)`, `liveness=unknown (...)`; after any
  group, report-only `UNTRACKED <name>: ...` (a launcher died before registering a session) and `ORPHAN <name> pid ...`
  lines. `launch.mjs resume --group <id> [--lane <n>]` relaunches blocked lanes fresh with a new restart budget;
```

**with**:

```markdown
     left in the merge worktree.
   - `merge --group <id> --skip <lane> --why "<reason>"` gives up on the lane's current head (`MERGE-BLOCKED`; a new
     head is queued again) and frees its merge session's lock; `merge --group <id> --force` clears a lock that status
     reports as STALE (the lane is retried). Both refuse (exit 1) while a merge is in progress there or its session
     still runs; every refusal is in `coordinator.md` (Merge internals).
   - Large-org variant: a merge queue or CI-gated pull request per lane instead of local merges.
5. Never relaunch a finished lane under the old group: the launcher refuses a lane whose done marker exists (it would
   read as DONE at once). `--reopen` (archives the marker) reopens a lane only before it is merged (refused while it is
   merged or being merged); a reopened lane's new head is merged like any other.
6. `status` shows an unreadable or JSON `null` marker as `UNREADABLE` and does not count it as done, and warns when a
   marker's `head` is not the branch tip. Lanes always use `--worktree` (the head check reads the lane's recorded branch).
7. **Legacy groups** (no `config.json`, launched before 2026-10-03) keep the old flow: after its done marker, the lane
   runs `status --group <id>`; on `all_done=true merge_launched=false` it launches the merge handoff:
   `--repo <main repo> --handoff <merge handoff> --group <id> --name <id>-merge --model opus --effort high --worktree <integration branch> --base <target branch>`
   (an exclusive `merge.lock` + the registry refuse a second `<id>-merge`). That merge session confirms every lane is
   DONE, reviews and merges each branch (never pushes without asking), removes merged worktrees, and launches each
   lane's `next_after_merge` stages as a NEW group, each on a NEW branch with `--base <integration branch>` (so it has
   the merged code), with its own merge handoff. `merge_lock` without a merge entry is stale: relaunch with `--force`.
   `--reopen` is refused once that merge has launched. `launch.mjs merge` (any flag) on a legacy group only prints this
   flow and changes nothing.
8. **Queue, never half-apply.** Work meant for another lane: `launch.mjs queue --to <lane> --text "<what>"` (or
   `--text-file`); `--after-merge` for work that must wait until the running lanes are merged (the group's
   `inbox/_after-merge.md`). The lane's next fresh launch takes its inbox (`inbox/<lane>.<stamp>.taken.md`) and its prompt
   names it: read it first. `--resume` does not take it. `status` shows `inbox=<n>`. Never write a handoff or ledger
   into the main checkout from a worktree: keep them in your own worktree or under `~/.claude/experiments/` (the write
   fence denies the rest; section 5).

## 5. Auto-close, stop and loop recovery (the coordinator)
Internals (state files and thresholds, close rules, housekeeping, orphans, alerts, test hooks): `coordinator.md` next
to this file. `<config>` is `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.
- **Auto-close at launch** (window launches): the windows in the new launch's `supersedes` chain beyond its direct
  predecessor are closed (a line from before batch A: generations ≤ N-2 of its repo + branch) - only if the window's
  process is still the PowerShell host recorded at launch (PID-reuse guard) AND its session is idle (finished turn, no
  outstanding tool call, no background agents or tasks) for ≥ 10 min. A busy
  session gets a stop request instead. `--no-close` disables this launch-time close only; the tick's closes below
  still apply.
- **The coordinator tick** (`coord.mjs tick`, code in `recover.mjs`) runs at most every 5 min, started by Stop hooks,
  tool calls and launches. It spends no tokens, acts only on its target's own process tree and worktree, and never on
  a liveness it could not probe (`unknown`).
- **It also closes** idle windows (≥ 10 min, no outstanding call, no background agents or shell/Monitor tasks, no
  permission prompt): a window once its successor runs (a launch whose `supersedes` chain reaches it; an unrelated
  session on the same checkout never closes it), in every group and lone session; and, in `auto` mode only, a window
  that recorded `{paused}`. A window whose claude exited is closed at once; a **dead start** (claude exited right after
  the launch) alerts once (`DEAD-START` in `status`) and is closed 60 min later. A job you run in such a window keeps it.
  A close never leads to a restart.
- **Lane rules.** The session hook (every launcher session has it) checks after each tool call and adds at most one
  line. When you receive:
  - an early warning ("You have repeated `<call>` N times ..."): stop repeating, find the cause, change approach. If you
    are waiting on something, wait with Monitor or ScheduleWakeup instead of polling.
  - a looping-subagent notice ("Agent `<type>` `<id>` is looping ..."): TaskStop that agent, find the cause in its
    transcript, fix the brief or the code, then re-dispatch per sizing-dispatches. A subagent told "You are
    repeating ..." stops and returns what it has and the suspected cause.
  - a stop request ("The coordinator flagged a loop ..." or "STOP REQUEST from handoff-launch ...", also sent by
    `launch.mjs stop --name <n>`) - **the stop contract**: finish or cancel the in-flight call, TaskStop every
    background agent you started, save your state (ledger or handoff, GOAL item `[!] loop-stopped`), end your turn and
    start no new work. The loop is cleared when you change something (a new successful edit, write or shell command)
    or stop repeating the call; a different read alone does not clear it.
  - a RECOVERY prompt (you are a restarted session): read the incident file it names, find and fix the cause
    (systematic-debugging), write it into the incident's `## Cause` section and your lane ledger, then continue. A
    Cause left empty sends the next restart one sizing rung up.
  - "Write fence: <path> belongs to lane <name> ...": do not edit it; queue it with the command it names, or tell the
    user (Bash writes are not fenced; the rule holds for them too).
  - "Lane note: ..." (first prompt, and when the live lanes change): a request meant for another lane belongs to it -
    say so and offer `launch.mjs queue --to <lane>`; files another live lane is changing: `--after-merge`.
  - "No GOAL.md yet ..." / "GOAL.md has not changed ...": write or tick GOAL.md in the same message as your next tool
    call. "You left <n> claude-in-chrome tab(s) open": close them with `tabs_close_mcp`.
- **Pausing:** a session that saved its state and wants to be left alone appends
  `{"paused":"<its --name>","at":"<ISO time>"}` to the registry (`sessions.jsonl`). `<config>/state/coord/pause.json`
  (`{"until":"<ISO time>"}`, `"until": null` for no end) pauses all flags and restarts.
- **The ladder** (`auto` mode): warning → stop request → 5 min grace → incident file → kill → restart. Incidents:
  `<main repo>/.superpowers/sessions/<group>/incidents/<lane>-<n>.md`, or `<config>/state/coord/incidents/<name>-<n>.md`
  for a lone session. The first restart resumes the session (`claude --resume`; a background session always restarts
  fresh), the second is fresh from the original pointer prompt with its GOAL.md; at ≥ 400k tokens of context the first
  restart is fresh and the cap is 1. After that the lane is `LOOP-BLOCKED` and you are alerted. A restart that fails to
  launch also blocks the lane (its alert names the launcher log); one the session cap refuses is deferred. A lane whose
  done marker exists is not restarted, and only the newest generation of a lane is ever restarted. Waiting on a usage limit, on AskUserQuestion or on a permission prompt is never
  flagged.
- **Recovery modes:** groups and lone sessions launched after stage 2 are `auto`; earlier ones are `report-only` (an
  incident and an alert, nothing stopped; `status` prints `recovery: report-only (...)`). Switch with
  `launch.mjs recover (--group <id> | --name <session>) --mode auto|report`. Opting in warns about sessions that have
  no session hook: a stop request cannot reach them, so a loop there is killed 5 min after the request.
- **A merge session at its cap** keeps `merge.lock` (status shows STALE). Its alert says what to do: `git merge --abort`
  in `.claude/worktrees/_merge-<id>`, then `launch.mjs merge --group <id> --force` (or `--skip <lane> --why ...`).
- **`launch.mjs sessions`** lists every open launcher session (liveness, busy/idle/waiting, priority, its checklist),
  then hand-opened sessions with a GOAL.md from the last 24 h. Read-only.
- **`status`** lane notes: `incidents=<n> (latest <path>)`, `LOOP-BLOCKED (...)`, `liveness=unknown (...)`,
  `DEAD-START (since ...)`, `inbox=<n>`, `goal=...`; lanes are listed high → normal → low priority; after any
  group, report-only `UNTRACKED <name>: ...` (a launcher died before registering a session) and `ORPHAN <name> pid ...`
  lines. `launch.mjs resume --group <id> [--lane <n>]` relaunches blocked lanes fresh with a new restart budget;
```

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

```markdown
- `session-hooks.json` next to the registry: the inspectable copy of the session hooks that every launch folds into
  its one profile `--settings` file.
- `<config>/state/coord/`:
  - `config.json`: thresholds (`repeat_window` 20, `repeat_count` 4, `warn_streak` 3, `stuck_min` 30, `grace_min` 5,
    `idle_close_min` 10, `fresh_at_tokens` 400000, `max_restarts` 2, `tick_min` 5, `alert_repeat_hours` 6). An
    unknown key or a bad value is reported on the tick's output (`config: unknown key <k> (the default is used)`) and
    ignored.
  - `tick.json`: the rate-limit stamp, written by whichever trigger starts a tick (a Stop, a tool call, a launch). It
    is not another session's state.
  - `tick.lock`, `last-tick.txt` (the last tick's lines), `housekeeping.json` (`{prune_at, orphans_at}`),
    `orphans.json` (`{at, orphans}`).
  - `sessions/<session id>.json`: one session hook's state. Parallel subagents share their parent's file, so one stop
    token can get more than one `{stop_delivered}` registry line; the ladder reads the first.
  - `looping.json`, `restarts/<name>-<stamp>.log`, `alerts/` (with `alerts/index.json`), and
    `incidents/<name>-<n>.md` for lone sessions. Group lanes' incidents live in
```

**with**:

```markdown
- `session-hooks.json` next to the registry: the inspectable copy of the session hooks that every launch folds into
  its one profile `--settings` file.
- Registry lines added in batch A: launch lines carry `launched_by`, `supersedes`, `scope`, `priority`;
  `{priority: <name>, group, value, at}` (`launch.mjs priority`); `{dead_start: <id>, name, group, at}` (the tick, Part 3
  below). Old launchers ignore the new fields; a launch line without `supersedes` is a legacy line.
- `<config>/state/coord/`:
  - `config.json`: thresholds (`repeat_window` 20, `repeat_count` 4, `warn_streak` 3, `stuck_min` 30, `grace_min` 5,
    `idle_close_min` 10, `fresh_at_tokens` 400000, `max_restarts` 2, `tick_min` 5, `alert_repeat_hours` 6,
    `bg_task_max_min` 240, `dead_close_min` 60, `goal_missing_calls` 10, `goal_stale_min` 40, `goal_stale_changes` 5). An
    unknown key or a bad value is reported on the tick's output (`config: unknown key <k> (the default is used)`) and
    ignored.
  - `tick.json`: the rate-limit stamp, written by whichever trigger starts a tick (a Stop, a tool call, a launch). It
    is not another session's state.
  - `tick.lock`, `last-tick.txt` (the last tick's lines), `housekeeping.json` (`{prune_at, orphans_at}`),
    `orphans.json` (`{at, orphans}`).
  - `sessions/<session id>.json`: one session hook's state. Parallel subagents share their parent's file, so one stop
    token can get more than one `{stop_delivered}` registry line; the ladder reads the first. Batch A adds `fence`
    (the session's own root, cached at its first write), `lane`/`lane_hash` (the lane note), `chrome_tabs`/`chrome_turn`
    and the checklist counters (`main_calls`, `goal_path`, `goal_mtime`, `goal_open`, `goal_changes`, `goal_*_said`).
  - `lanes.json` (`{at, repos: {<repo key>: [{id, name, branch, worktree, group, scope, priority, liveness, goal}]}}`):
    the newest open running or unknown entry per lane, written by every tick (a `--repo` tick rewrites only its key).
    The lane note reads it; older than 30 min, it falls back to the registry.
  - `inbox/<name>.md`: queued items for a session without a group (group lanes:
    `<main repo>/.superpowers/sessions/<group>/inbox/<lane>.md`, `_after-merge.md`, taken as `<lane>.<stamp>.taken.md`).
  - `looping.json`, `restarts/<name>-<stamp>.log`, `alerts/` (with `alerts/index.json`), and
    `incidents/<name>-<n>.md` for lone sessions. Group lanes' incidents live in
```

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

```markdown
  `waiting_since` for permission prompts. It adds at most one line per call. The early warning comes after
  `warn_streak` repeats of the same call; Monitor calls never count.
- The tick's rule (a), unlike the early warning, counts a call `repeat_count` times since the last change, within the
  last `repeat_window` calls. A change is a successful `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash` or
  `PowerShell` call that is new: a write counts as new until it has once succeeded in the window (amended 2026-10-04
  by user decision after the final review).
- A subagent receives its own notice but may not act on it. The parent's looping-subagent notice and the ladder cover
  that case.

## Closes by the tick
- Candidates: an older generation of a repo+branch (N-1, or any older one still open, e.g. when N-1 was a closed
  duplicate) once N runs (all modes; this covers a window with an incident once a newer launch runs). In auto mode
  only: a window that recorded `{paused}`.
- Lane identity: a lane is repo + branch, and `launch.mjs` numbers generations per lane across session names. So two
  launcher sessions on one checkout + branch are one lane to the closes: the older one is N-1 and is closed as
  superseded once it is idle, even when the newer one is an unrelated helper rather than its relay. The registry
  cannot tell a relay from an unrelated session yet (launch lines record no `launched_by`/`supersedes`), so the rule
  is operational: an on-demand helper session (one that is not this session's relay to its next stage) is launched
  with `--worktree <its own branch>`; never launch a second session on a checkout + branch that already hosts one
  unless it is that session's relay.
- "Idle" means the turn ended with a `turn_duration` record (otherwise its background agents are unknown and the window
  is kept), with no outstanding call and no permission wait, for ≥ `idle_close_min`. A window with no transcript
  closes only when its launch is ≥ `idle_close_min` old and no claude runs below its host. The launch-time N-2 close
  also keeps a window without a `turn_duration` record.
- Lines:
  - `would close <name> (gen N): <why>` (dry run), `closed ...`, `not closed ...: <why> - <kill result>`;
  - `skip close of <name> (gen N): <reason>`, where the reason is: no recorded host pid and start time; liveness
    unknown; host pid N is not the recorded window; its turn is not done; hook state unreadable; its loop ladder is
    pending;
  - a kept window prints nothing.
- A close writes `{kill_intent, kind: "close"}` then `{closed}`, and never leads to a restart.
- A paused window with a pending ladder: the real tick cancels the ladder (paused is exempt) and closes the window in
  one tick. A dry run records no cancel, so it shows `skip close ...: its loop ladder is pending`.
- `{paused}` is never written by the code. A session that saved its state appends
  `{"paused":"<its --name or registry id>","at":"<ISO time>"}`; it covers launches started before `at`.

## Launch details
- `profile-args` prints the files a launch passes, hooks included (`full` gives `["--settings", <file>]`).
- `.mcp.json` lookup: the work dir's, then `--repo`'s, then the main checkout's; a `--resume` reads the worktree's and
  the main checkout's.
- On git < 2.22 the branch recorded at launch falls back to `--worktree`'s branch, or `HEAD`.
- On Windows a bg launch refuses a `%` in any of its arguments (registry dir and profile file paths included).

## Restarts and the session cap
- The coordinator restarts with `launch.mjs --resume <session id> --recovery <incident> --model <m> --effort <e>`, or
  fresh with `--repo <its worktree> --handoff <h> --name <n> [--group <g>] [--worktree <branch>] --profile <the entry's,
  or full> --model <m> --effort <e> --mode <its mode, default window> --no-close --recovery <incident>`, plus
  `--goal-from <session id>` and `--prompt-file <base prompt>` when recorded. There is no `--base`; `--force` only
  for a legacy `<group>-merge` session. Model and effort (a resume and a fresh restart alike) are the entry's; an entry
  from before stage 2 has neither and restarts as `opus`/`high`. Only the second restart may go one sizing rung up:
  when the incident that led to the first restart still has an empty `## Cause`. The rungs are opus/medium →
  opus/high → opus/xhigh → fable/high → fable/xhigh (the top stays, never `max`); a pair off that ladder keeps its
  model and steps its effort up once, capped at xhigh (low → medium → high → xhigh).
- Only the newest generation of a lane is restarted. A killed session with a newer open launch is not restarted:
  `{restart_skipped}` (`killed, not restarted: superseded by <id>`) while that launch runs; blocked with an alert if
  it is gone without a close; retried next tick while its liveness is unknown.
- A restart of a pre-profile entry uses `full` on every path (`--resume`, the tick's fresh restart, `launch.mjs
  resume`). A profile renamed or removed in `profiles.json` makes the restart exit 2. The tick records
```

**with**:

```markdown
  `waiting_since` for permission prompts. It adds at most one line per call. The early warning comes after
  `warn_streak` repeats of the same call; Monitor calls never count.
- Batch A adds, in the same `--settings` file: `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` → `coord.mjs fence`,
  `UserPromptSubmit` → `coord.mjs lane-note`, `Stop` → `coord.mjs stop`. Running sessions keep their old settings file
  until they relaunch. All fail open (any error: exit 0, no output); each costs about 100 ms (node start), and reads the
  registry only at a session's first write and when a write leaves its own root.
- **The write fence** decides for an absolute, normalised path (case-insensitive, forward slashes, `\\?\` stripped):
  allow under the own root (the entry's worktree, or the main checkout = main root minus `.claude/worktrees/**`), the
  config dir, the temp dir, `<main>/.superpowers/**` and an unowned `<main>/.claude/worktrees/<x>` (a subagent's own
  worktree); deny under another open entry's worktree of the repo, or under the main checkout for a session not on it;
  allow the rest. The owner named is the open entry whose worktree is the longest prefix. Bash writes, junctions and
  symlinks are not fenced (known gaps).
- **post-tool** also keeps the claude-in-chrome tab set (ids from `tabs_context_mcp`/`tabs_create_mcp` results, minus
  `tabs_close_mcp` inputs) and the checklist lines: after `goal_missing_calls` main-thread calls with no GOAL.md, one
  line per session; when GOAL.md has open items, is `goal_stale_min` old and `goal_stale_changes` work calls (Edit,
  MultiEdit, Write, NotebookEdit, Bash, PowerShell, Agent) happened since its last write, one line per window. A
  subagent's call is counted as work but never gets the line.
- Hand-opened sessions get one missing-GOAL.md block from goal-gate (once per session: `<config>/goals/.nudged-<sid>`;
  not on a continuation, a question, background tasks, print mode `CLAUDE_CODE_ENTRYPOINT=sdk-cli`, or a transcript with
  one user prompt; it counts toward the gate's 3 continuations).
- The tick's rule (a), unlike the early warning, counts a call `repeat_count` times since the last change, within the
  last `repeat_window` calls. A change is a successful `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash` or
  `PowerShell` call that is new: a write counts as new until it has once succeeded in the window (amended 2026-10-04
  by user decision after the final review).
- A subagent receives its own notice but may not act on it. The parent's looping-subagent notice and the ladder cover
  that case.

## Closes by the tick
- Candidates: a window O once an open, `running` entry N supersedes it - N launched after O, and O in N's chain (all
  modes; this covers a window with an incident once its successor runs). In auto mode only: a window that recorded
  `{paused}`. Reason text: `superseded by generation <N>` (the newest running successor).
- The chain: N with the `supersedes` key follows its links (`supersedes`, then that entry's, while it has the key);
  a legacy entry reached through a link ends the chain; chains pass through closed entries. A legacy N (no key) keeps
  the stage-2 rule: every lower generation of its repo + branch. `generation` is still numbered and shown; it decides
  closes only for legacy lines. So an unrelated session that landed on a checkout never closes its session.
- "Idle" means the turn ended with a `turn_duration` record (otherwise its background agents are unknown and the window
  is kept), with no outstanding call, no open background shell or Monitor task, and no permission wait, for
  ≥ `idle_close_min`. A task is open from its start record (`toolUseResult.backgroundTaskId`, or a Monitor's `taskId` +
  `timeoutMs`) until a `<task-notification>` with a `<status>`, a `[Monitor expired` event or a TaskStop result; tasks
  from before the entry's `launched_at` are ignored; a task with no end counts for at most `bg_task_max_min` (a Monitor
  until its timeout + 5 min). The scan runs only for a session that is otherwise idle. A window with no transcript
  closes only when its launch is ≥ `idle_close_min` old and its host is empty. The launch-time close also keeps a
  window without a `turn_duration` record.
- **Windows whose claude is gone** (Part 3; window entries, every group): launched ≥ `idle_close_min` ago, transcript
  quiet that long (or none), and an EMPTY host (nothing below it; a probe failure means no action). Exited (the
  transcript has assistant records since the launch): `closed <name> (gen N): claude exited`. Dead start: one
  `{dead_start}` line, `DEAD START ...` and one alert (`deadstart|<id>`, again after `alert_repeat_hours`); a
  coordinator restart (the first `{restart}` of its name after its launch line) also gets `{restart_failed}` +
  `{lane_blocked}`; `dead_close_min` after the alert the window is closed (`... dead start: no claude in the window
  since <at>`). The close is the guarded no-claude form: the recorded host, an empty host re-checked before the kill,
  no turn-state check. A launch onto that checkout, a `--resume` or `launch.mjs resume` closes such a window first.
- Lines:
  - `would close <name> (gen N): <why>` (dry run), `closed ...`, `not closed ...: <why> - <kill result>`;
  - `skip close of <name> (gen N): <reason>`, where the reason is: no recorded host pid and start time; liveness
    unknown; host pid N is not the recorded window; its turn is not done; hook state unreadable; its loop ladder is
    pending;
  - a kept window prints nothing.
- A close writes `{kill_intent, kind: "close"}` then `{closed}`, and never leads to a restart.
- A paused window with a pending ladder: the real tick cancels the ladder (paused is exempt) and closes the window in
  one tick. A dry run records no cancel, so it shows `skip close ...: its loop ladder is pending`.
- `{paused}` is never written by the code. A session that saved its state appends
  `{"paused":"<its --name or registry id>","at":"<ISO time>"}`; it covers launches started before `at`.

## Launch details
- `supersedes` (first match wins): `--resume`'s entry; `--supersedes <id>` (the tick's fresh restart passes the killed
  entry, `launch.mjs resume` the blocked lane's newest); a relay - the launcher (found by `HL_SESSION_ID`, else
  `launched_by` = its session id) runs in the target checkout (same worktree path, or same repo + branch; another
  `--name` prints `note: this launch replaces <name> (gen N) as its relay`); a merge session with no known launcher: the
  merge worktree's newest open entry; else `null`. `launched_by` is `CLAUDE_CODE_SESSION_ID` of the launching process.
- The environment scrub: every spawn of `launch.mjs` by the coordinator (the tick's restarts, the merge session,
  `launch.mjs resume`) and the detached tick run without `HL_SESSION_ID` and `CLAUDE_CODE_SESSION_ID`.
- The occupancy check (a launch whose `supersedes` is null): an open entry on the target checkout that really runs
  (its host alive with anything below it - claude, or a job the user runs there - or a bg session `claude agents`
  lists) refuses it: `refused - <repo>@<branch> already has a running session <name> (gen N, id <id>): ...` (exit 3,
  before any side effect; `--force` overrides). A window launched < 2 min ago with an empty host counts as running
  (still starting). Unknown liveness only warns. Every fresh launch first closes the target's windows whose claude is
  gone. `--dry-run` reports `occupancy` and refuses or closes nothing.
- The inbox: a fresh launch named `<lane>` (not a merge session, not `--resume`, not `--dry-run`) renames its inbox to
  `<lane>.<stamp>.taken.md` and appends ` Read your inbox first: <path> - ...` to the prompt only (never to
  `prompt_file`). A failed rename takes nothing (warning); a bg launch that failed with no new session renames it back,
  as does a window that could not be spawned.
- Unknown flags only warn (`warning: unknown flag --<x> (ignored)`); the known set is every `opt`/`flag`/`val` literal
  of `launch.mjs` (`tests/provenance.test.mjs` checks it).
- `profile-args` prints the files a launch passes, hooks included (`full` gives `["--settings", <file>]`).
- The built-in `playwright` server runs `node <config>/mcp-servers/node_modules/@playwright/mcp/cli.js --isolated
  --headless --idle-timeout 900000`; without that install, its `fallback` (npx of the same pinned version). A user
  server of the same name (`~/.claude.json`, `.mcp.json`) still wins.
- `.mcp.json` lookup: the work dir's, then `--repo`'s, then the main checkout's; a `--resume` reads the worktree's and
  the main checkout's.
- On git < 2.22 the branch recorded at launch falls back to `--worktree`'s branch, or `HEAD`.
- On Windows a bg launch refuses a `%` in any of its arguments (registry dir and profile file paths included).

## Restarts and the session cap
- The coordinator restarts with `launch.mjs --resume <session id> --recovery <incident> --model <m> --effort <e>`, or
  fresh with `--repo <its worktree> --handoff <h> --name <n> [--group <g>] [--worktree <branch>] --profile <the entry's,
  or full> --model <m> --effort <e> --mode <its mode, default window> --no-close --recovery <incident>`, plus
  `--goal-from <session id>` and `--prompt-file <base prompt>` when recorded. There is no `--base`; `--force` only
  for a legacy `<group>-merge` session. Model and effort (a resume and a fresh restart alike) are the entry's; an entry
  from before stage 2 has neither and restarts as `opus`/`high`. Only the second restart may go one sizing rung up:
  when the incident that led to the first restart still has an empty `## Cause`. The rungs are opus/medium →
  opus/high → opus/xhigh → fable/high → fable/xhigh (the top stays, never `max`); a pair off that ladder keeps its
  model and steps its effort up once, capped at xhigh (low → medium → high → xhigh).
- Restarts pass `--priority <the lane's effective priority>`, and a fresh one `--supersedes <the killed entry>`.
- Only the newest generation of a lane is restarted. The restart guard is the union: any open entry newer on the same
  repo + branch, or with the entry in its chain (a relay on a switched branch). A killed session with such a launch is
  not restarted: `{restart_skipped}` (`killed, not restarted: superseded by <id>`) while a successor runs; `killed, not
  restarted: an open newer launch <name> shares its checkout` + an alert when only a co-tenant runs (the user decides);
  blocked with an alert if it is gone without a close; retried next tick while its liveness is unknown. `--resume`
  refuses on the same union.
- A restart of a pre-profile entry uses `full` on every path (`--resume`, the tick's fresh restart, `launch.mjs
  resume`). A profile renamed or removed in `profiles.json` makes the restart exit 2. The tick records
```

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

```markdown
  `.cmd` install or a restart timeout shows only as `UNTRACKED ... pid ? unknown`.

## Housekeeping (the tick, at most hourly)
Deleted after 14 days: restart logs, `sent-*` alerts, and the state files of closed or gone sessions. Also deleted:
```

**with**:

```markdown
  `.cmd` install or a restart timeout shows only as `UNTRACKED ... pid ? unknown`.

- The Playwright reaper (with the hourly orphan scan, Windows): a browser (`chrome`, `chromium`, `msedge`) with
  `--remote-debugging-pipe` and a Playwright `--user-data-dir` (`playwright_*dev_profile-*`, or under
  `ms-playwright-mcp`), or a `node`/`cmd` naming `@playwright/mcp`, whose direct parent is gone or newer, is killed with
  its tree (`killed Playwright orphan <name> <pid> (parent <ppid> gone)`); never by ancestor names. Then the temp dir's
  `playwright_*dev_profile-*` dirs older than 24 h that no running process names are removed (`--isolated` leaves them).

## Housekeeping (the tick, at most hourly)
Deleted after 14 days: restart logs, `sent-*` alerts, and the state files of closed or gone sessions. Also deleted:
```

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

```markdown
    most one alert per run.
- goal-gate fails open: without a working `coord.mjs` beside it, it behaves exactly as before.

## Merge internals (section 4)
- A loop-blocked lane counts as running for `overlap=` (it merges after `launch.mjs resume`).
- Overlap lives in a sidecar `<group dir>/<lane>.overlap.json`; done markers are never rewritten (an older marker's own
```

**with**:

```markdown
    most one alert per run.
- goal-gate fails open: without a working `coord.mjs` beside it, it behaves exactly as before.
- `DEAD START: <name> (<branch>): its window is open but claude exited right after the launch at <time>. Read the error
  in that window, fix it, relaunch. The coordinator closes the window at <time + dead_close_min>.`

## Merge internals (section 4)
- `merge --group <id> --skip <lane> --why "<reason>"` gives up on the lane's current head (`MERGE-BLOCKED`; a new
  done-marker head is queued again) and frees its merge session's lock. Refused (exit 1) for a merged lane, while the
  lane's merge is in progress in the merge worktree (`git merge --abort` there first), and while that lane's merge
  session is still running unless `--session <that session>` is given (its own handoff's skip command passes it).
- `merge --group <id> --force` clears a lock that status reports as STALE (the merge process died, or the merge
  session's window closed or its process ended) or older than the test timeout; the lane is retried. It aborts
  nothing itself. Refused (exit 1, nothing merged) while a live merge process younger than the test timeout holds
  the lock, while the holding merge session is still running (`launch.mjs stop --name <session>` or close its window
  first), while a merge session's half merge is in progress in the merge worktree (abort a half merge in the merge
  worktree first: `git merge --abort` there), or when that lane is already merged (run plain `merge`). With both
  flags, `--skip` runs before `--force`. Both also refuse while a merge session that just took the lock
  has no launch line yet (`liveness is starting`, up to 3 min).
- A loop-blocked lane counts as running for `overlap=` (it merges after `launch.mjs resume`).
- Overlap lives in a sidecar `<group dir>/<lane>.overlap.json`; done markers are never rewritten (an older marker's own
```

**Replace** in `claude/skills/handoff-launch/coordinator.md`:

```markdown
`HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, `HL_PROFILES_JSON`, `HL_CLAUDE_JSON`, `HL_FREE_GB`, `HL_FAKE_PROCS`,
`HL_FAKE_GIT_TIMEOUT`, `HL_LAUNCH_MJS`, `HL_SKILL_DIR`. Their meanings are in the header comments of `launch.mjs`,
`live.mjs`, `merge.mjs`, `recover.mjs` and `hooks/coord.mjs`.
```

**with**:

```markdown
`HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, `HL_PROFILES_JSON`, `HL_CLAUDE_JSON`, `HL_FREE_GB`, `HL_FAKE_PROCS`,
`HL_FAKE_GIT_TIMEOUT`, `HL_LAUNCH_MJS`, `HL_SKILL_DIR`. Their meanings are in the header comments of `launch.mjs`,
`live.mjs`, `merge.mjs`, `recover.mjs` and `hooks/coord.mjs`. With `HL_FAKE_PROCS` the reaper kills nothing. The sandbox
drops the developer session's `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED` and
`CLAUDE_PID`; tests set them. `tests/helpers.mjs` `host()` runs a claude stand-in below the window host (a live
session's host is never empty); `emptyHost()` and `jobHost()` model an exited claude and a user's job.
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
//                   [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>] [--force] [--no-close] [--dry-run]
//                   [--recovery <incident>] [--prompt-file <file>] [--goal-from <session id>]
//   node launch.mjs --resume <session id> [--recovery <incident>] [--model m --effort e]   (the coordinator's first restart;
//                   the entry's profile, full for an entry without one)
//   node launch.mjs recover (--group <id> | --name <session>) --mode auto|report
//   node launch.mjs resume --group <id> [--lane <name>]                     (relaunch blocked lanes fresh)
```

**with**:

```js
//                   [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>] [--force] [--no-close] [--dry-run]
//                   [--recovery <incident>] [--prompt-file <file>] [--goal-from <session id>]
//                   [--supersedes <registry id>] [--priority high|normal|low] [--scope "<text>"]
//   node launch.mjs --resume <session id> [--recovery <incident>] [--model m --effort e] [--profile <names>] [--priority <p>]
//                   (the coordinator's first restart; the entry's profile unless --profile, full for an entry without one)
//   node launch.mjs queue --to <lane> [--group <id>] [--repo <main repo>] (--text "<text>" | --text-file <file>)
//                   [--after-merge] [--from <name>]                      (an item for another lane's next fresh launch)
//   node launch.mjs priority --name <lane> [--group <id>] --set high|normal|low
//   node launch.mjs sessions [--repo <dir>]          (every open launcher session and its checklist; hand-opened GOAL.md files)
//   node launch.mjs recover (--group <id> | --name <session>) --mode auto|report
//   node launch.mjs resume --group <id> [--lane <name>]                     (relaunch blocked lanes fresh)
```

**Replace** in `claude/skills/handoff-launch/launch.mjs`:

```js
//   status also prints, for any group, UNTRACKED sessions (a launcher died between its {starting} line and its launch
//   line) and ORPHAN processes (the tick's orphans.json, < 2 h old).
//   Every launch appends a {starting} line, then its launch line, to sessions.jsonl (next to this file). After a
//   window launch of generation N on a repo+branch, windows of generations <= N-2 there are closed - only when their
//   session is idle for >= 10 min;
//   a busy one gets a stop request instead and is retried by a later launch (--no-close disables all of it).
//   Every launch line records model, effort, coord: 1 and prompt_file (the base prompt - never a --recovery line -
//   next to the pid file).
```

**with**:

```js
//   status also prints, for any group, UNTRACKED sessions (a launcher died between its {starting} line and its launch
//   line) and ORPHAN processes (the tick's orphans.json, < 2 h old).
//   Every launch appends a {starting} line, then its launch line, to sessions.jsonl (next to this file). The launch line
//   records launched_by (CLAUDE_CODE_SESSION_ID of the session that ran this, else null), supersedes (the registry id it
//   replaces: --resume's entry, --supersedes <id>, the launching session's own entry when it relays in its own checkout,
//   a merge session's predecessor in the merge worktree, else null), scope (the handoff's first # heading, or --scope)
//   and priority (--priority, else derived from the sizing). A launch with supersedes null onto a checkout whose session
//   really runs is refused (exit 3) unless --force; windows there whose claude is gone are closed first. After a window
//   launch, the windows in its supersedes chain beyond its direct predecessor are closed - only when their session is idle
//   for >= 10 min; a busy one gets a stop request instead and is retried by a later launch (--no-close disables all of it).
//   A fresh launch named <lane> takes its inbox (queue) and names it in the prompt; an unknown --flag only warns.
//   Every launch line records model, effort, coord: 1 and prompt_file (the base prompt - never a --recovery line -
//   next to the pid file).
```

**Replace** in `docs/specs/2026-10-04-stage2-loop-recovery-design.md`:

```markdown
  - the older window is idle for ≥ `idle_close_min`, with no outstanding call, no pending background agents and no
    `waiting_since`.
- The same applies to an idle window that recorded `{paused}`, and to one that has an incident and whose successor is
  running. These are the outline's exemptions from "never close N-1".
- **The guarded close** (the logic of `guardclose.cjs`, moved into `recover.mjs`):
  - the host is the recorded powershell, with a start time within 2 s;
```

**with**:

```markdown
  - the older window is idle for ≥ `idle_close_min`, with no outstanding call, no pending background agents and no
    `waiting_since`.
- The same applies to an idle window that recorded `{paused}` (a window with an incident whose successor runs is a case
  of the older-generation close above). These are the outline's exemptions from "never close N-1".
- **The guarded close** (the logic of `guardclose.cjs`, moved into `recover.mjs`):
  - the host is the recorded powershell, with a start time within 2 s;
```

**Replace** in `docs/specs/2026-10-04-stage2-loop-recovery-design.md`:

```markdown
- **The merge-session test:** a looping merge session at the cap leaves `merge.lock` held, and the alert names the
  abort-then-force step.
- **The superseded-close test:** N-1 idle with N running is closed; N-1 busy or `waiting_since` is not.
- **All tests use** `HL_REGISTRY_DIR`, `HL_AGENTS_JSON=<file containing []>`, `HL_PROJECTS_DIR`, a temp `CFG`,
  `HL_FAKE_CLAUDE=1` and `HL_NO_SPAWN=1`. They never touch the real registry.
```

**with**:

```markdown
- **The merge-session test:** a looping merge session at the cap leaves `merge.lock` held, and the alert names the
  abort-then-force step.
- **The superseded-close test:** any older open generation idle with N running is closed; one busy or `waiting_since` is not.
- **All tests use** `HL_REGISTRY_DIR`, `HL_AGENTS_JSON=<file containing []>`, `HL_PROJECTS_DIR`, a temp `CFG`,
  `HL_FAKE_CLAUDE=1` and `HL_NO_SPAWN=1`. They never touch the real registry.
```


- [ ] **Step 2: Check the docs against the code**

Run: `wc -c claude/skills/handoff-launch/SKILL.md` -> about 28000.
Run: `grep -n "N-2\|record no\|newest one on the same repo" claude/skills/handoff-launch/SKILL.md claude/skills/handoff-launch/coordinator.md`
Expected: no line still says a launch closes generations <= N-2 for a new line, that the registry records no
`launched_by`/`supersedes`, or that the cap exempts the newest session of the branch (the legacy mentions stay).
Run: `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0` (the header is a comment).

- [ ] **Step 3: Commit**

```bash
git add claude/skills/handoff-launch/SKILL.md claude/skills/handoff-launch/coordinator.md claude/skills/handoff-launch/launch.mjs docs/specs/2026-10-04-stage2-loop-recovery-design.md
git commit -m "docs: batch A - provenance and the occupancy rule, closes by the chain, dead starts, the fence, lane note, queue, priority, checklists, browser tools"
```

---

### Task 13 (controller): review, dry-run gate, deploy, verify, push

Not a subagent implementation task: the controller runs it.

- [ ] **Step 1: Whole-branch review.** Dispatch `worker-xhigh` + **fable** on `git diff main...batchA-lane-hygiene-priority`
  with this plan, the spec and the Review Focus list. Fix findings through `worker-xhigh` + opus (close, fence,
  restart, reaper or idle-test code) or `worker-high` + opus (anything else); anything edited after the review gets a
  scoped re-review of those edits.
- [ ] **Step 2: Full suite.** `timeout 1200 node --test "claude/skills/handoff-launch/tests/*.test.mjs"` -> `ℹ fail 0`;
  quote the summary lines.
- [ ] **Step 3: The dry-run gate (read-only, against the live registry, before anything is deployed).** From the
  branch's worktree, with the live registry and config dir:

  ```bash
  D=$(mktemp -d); R="$HOME/.claude/skills/handoff-launch"
  snap() { sha1sum "$R/sessions.jsonl"; ls -la "$R/stops" "$R/pids" ~/.claude/state/coord 2>&1; }
  snap > "$D/before.txt"
  HL_NO_SPAWN=1 HL_REGISTRY_DIR="$R" node claude/hooks/coord.mjs tick --dry-run > "$D/tick-dry.txt"; cat "$D/tick-dry.txt"
  HL_NO_SPAWN=1 HL_REGISTRY_DIR="$R" node --input-type=module -e "import * as V from './claude/skills/handoff-launch/live.mjs'; import { laneTable } from './claude/skills/handoff-launch/recover.mjs'; console.log(JSON.stringify(laneTable(V.readRegistry()), null, 2))" > "$D/lanes.txt"; cat "$D/lanes.txt"
  snap | diff "$D/before.txt" -
  ```

  It writes nothing (the `diff` prints nothing). Show the user every line: each `would close <window>: superseded by
  generation <N>` (now only by a real successor), `would close ...: claude exited`, `would alert DEAD START ...`,
  `would kill Playwright orphan ...`, `would remove the stale Playwright profile ...`, each `unknown` session, and the
  lane table. The user approves before anything is deployed; a line they reject is fixed (or ruled on) first.
- [ ] **Step 4: Deploy, in order** (a module imported before it exists would break running lanes' next call). Before
  the code, install the pinned Playwright MCP server, and check whether the live `~/.claude.json` defines its own
  `playwright` server (it would win over the pinned one in every profile: ask the user whether to keep it):

  ```bash
  npm install --prefix ~/.claude/mcp-servers @playwright/mcp@0.0.83
  test -f ~/.claude/mcp-servers/node_modules/@playwright/mcp/cli.js && echo pinned-ok
  node -e "const j=require(require('os').homedir()+'/.claude.json'); console.log('user playwright server:', !!(j.mcpServers||{}).playwright)"
  ```

  1. `lane-lib.mjs`, `recover-lib.mjs`, then `live.mjs`, then `recover.mjs` -> `~/.claude/skills/handoff-launch/`;
  2. `merge-lib.mjs`, `merge.mjs` and `launch.mjs` in one step (their APIs change together);
  3. `claude/hooks/coord.mjs` -> `~/.claude/hooks/coord.mjs` (a session launched between steps 1 and 3 already lists the
     new hooks; the old `coord.mjs` ignores an unknown subcommand: fail open);
  4. `profiles.json`, `SKILL.md`, `coordinator.md`, `run-test.mjs`, `tests/`;
  5. `claude/hooks/goal-gate.mjs` last (it enables the hand-opened nudge).
  Then the `claude/CLAUDE.md` mirror: copy the live `~/.claude/CLAUDE.md` over it (the coordinator's 2026-10-05 edits:
  the every-session checklist rule, tick at once in the same message as the next tool call, "Kimi is retired"), run the
  secret scan on it, and commit it on the branch. Then
  `diff -r claude/skills/handoff-launch ~/.claude/skills/handoff-launch` -> only live runtime files differ (`pids`,
  `stops`, `profiles`, `sessions.jsonl`, `session-hooks.json`, `launch-config.json`);
  `diff claude/hooks/coord.mjs ~/.claude/hooks/coord.mjs`, `diff claude/hooks/goal-gate.mjs ~/.claude/hooks/goal-gate.mjs`
  and `diff claude/CLAUDE.md ~/.claude/CLAUDE.md` -> identical.
- [ ] **Step 5: Verify live** (no visible window: hook calls with fake stdin, read-only commands):
  `echo {} | node ~/.claude/hooks/coord.mjs fence`, `... lane-note`, `... stop`, `... post-tool` -> exit 0, no output each;
  `echo {} | node ~/.claude/hooks/goal-gate.mjs` -> exit 0, no output;
  `node ~/.claude/skills/handoff-launch/launch.mjs sessions` -> the open sessions and their checklists;
  `node ~/.claude/skills/handoff-launch/launch.mjs status --group none` ->
  `members=0 done=0 all_done=false merge_launched=false merge_lock=false`. After the first live tick (within 5 min),
  read `~/.claude/state/coord/last-tick.txt` and `lanes.json` and check them against the approved dry run.
  Rollback, if the live tick does anything the dry run did not show: restore `~/.claude/hooks/goal-gate.mjs` and
  `coord.mjs` from `main` before this branch, then the rest from the same commit.
- [ ] **Step 6: Secret scan** (pattern from the private handoff) -> prints nothing.
- [ ] **Step 7: Commit and push.** `git fetch . batchA-lane-hygiene-priority:main` (a fast-forward), push `main`.
  Commit messages end with the session's attribution lines.
- [ ] **Step 8: The restart table to `coordinator`.** Send the coordinator, per running launcher session: whether it
  gains the fence, the lane note, the Stop tab check and the checklist lines by relaunching (only sessions launched
  after the deploy have them; running ones keep their old `--settings` file), and that old sessions must not write the
  new line types (`supersedes`, `{priority}`, `{dead_start}`) by hand. Then report to the user: what deployed, the
  Playwright pin and how to update it, that headless Playwright is the default and claude-in-chrome stays for
  logged-in sites, and stop and ask before any batch-B work.

---

## Spec gaps found while planning

Each one is resolved in the plan as written. Gap 1 contradicts the spec's literal text and goes to the controller as a
question; the others stay inside the spec's rules.

1. **QUESTION: the coordinator-restart match is written in the wrong order.** Part 3 says an entry is a coordinator
   restart "when it is the first launch line of its name after a `{restart}` line of that name". The code writes the
   other order: the tick's `afterKill` runs the launcher to its end (the launcher appends `{starting}` and the launch
   line) and only then appends `{restart}` (`recover.mjs:255` then `:274`). Read literally, the rule marks the NEXT
   launch of that name as the restart - for example a `launch.mjs resume` relaunch, the very case the spec's test list
   names ("the Part 3 restart match when a later `launch.mjs resume` line exists"). Resolution in the plan
   (`restartOf`, Task 3): the `{restart}` line of that name that FOLLOWS the entry's launch line, before any other
   launch line or `{lane_resumed}` of that name, with `from` != the entry. The intent (a dead coordinator restart is a
   failed restart) is unchanged. The controller confirms or rules otherwise.
2. **Part 3 needs a durable alert time.** "`dead_close_min` after the alert" and "`status` shows `DEAD-START (since
   <time>)`" need state the spec does not list. Resolution: one registry line `{dead_start: <id>, name, group, at}` at
   the first alert; the alert index key `deadstart|<id>` only times the repeats.
3. **The occupancy close of an empty host has no minimum age.** A window launched a second ago has an empty host until
   its claude starts. Resolution: an empty host counts as gone (closed first) only when its launch is >= 2 min old;
   younger, it counts as running ("still starting") and a rule-5 launch is refused.
4. **The fence cannot see a lane launched after its cache.** "The registry once per session ... or on a denial" would
   let a session write into a worktree whose session launched after its first write. Resolution: the registry is read
   at the first call and for every write outside the quick-allow set (own root, config, temp, `.superpowers`); writes
   inside it read nothing.
5. **`{priority}` lines reuse the `priority` key.** A launch line's `priority` is a value; a `{priority}` line's is a lane
   name. Resolution: readers tell them apart by `launched_at` (launch lines) and `value` (`{priority}` lines);
   `readRegistry` already files a `{priority}` line among the other lines, never among entries.
6. **`status --group`'s `goal=` note vs the byte-identical legacy output.** Resolution: the note (and `inbox=`,
   `DEAD-START`) appears only when there is something to say; `launch.mjs sessions` shows `no GOAL.md`.
7. **`--isolated` leaves profile dirs** (probe 7). Resolution (controller ruling): hourly cleanup of
   `playwright_*dev_profile-*` dirs older than 24 h that no running process names.
8. **A user `playwright` server in `~/.claude.json` would override the pinned one** in every profile (the stage-1
   resolution order lets a user server win). Resolution: kept (the user's own configuration wins), and Task 13 checks
   the live file before the deploy and asks the user if one exists.
9. **`--resume`'s guard.** The spec makes the guard the union; stage 2's name check (a newer launch line of the same
   name, closed or not) also stays on `--resume`, the conservative direction.
10. **Hook latency:** the spec's target "under 100 ms"; probe 6 measured a 106 ms median. Written as "about 100 ms; no
    registry parse after the first call" (controller).
11. **SKILL.md size** grows by about 2.6 KB to about 28 KB; the `merge --skip/--force` refusal details move to
    `coordinator.md`.
