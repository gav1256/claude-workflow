# handoff-launch: coordinator and merge internals (reference)

Operator reference for SKILL.md sections 2, 4 and 5. A lane does not need this file to follow its rules; read it when
debugging the coordinator, the merge drain or a refusal. `<config>` is `CLAUDE_CONFIG_DIR` if set, otherwise
`~/.claude`.

## Files
- Launcher registry: `sessions.jsonl` next to `launch.mjs` (append-only). Right before each spawn the launcher
  appends `{starting: <session id|null>, name, group?, pid_file, at}`, then the launch line. The pid files (`pids/`) and
  stop files (`stops/`) also live next to the registry. A `{starting}` line is not
  a launch line (no `launched_at`, no `id`).
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
    The lane note reads it; older than 30 min, it falls back to the registry. Its liveness can lag one tick behind a
    close made in that same tick.
  - `inbox/<name>.md`: queued items for a session without a group (group lanes:
    `<main repo>/.superpowers/sessions/<group>/inbox/<lane>.md`, `_after-merge.md`, taken as `<lane>.<stamp>.taken.md`).
  - `looping.json`, `restarts/<name>-<stamp>.log`, `alerts/` (with `alerts/index.json`), and
    `incidents/<name>-<n>.md` for lone sessions. Group lanes' incidents live in
    `<main repo>/.superpowers/sessions/<group>/incidents/<lane>-<n>.md`. An incident with flagged subagents has a
    `## Looping subagents` section.
  - `pause.json`: `{"until":"<ISO time>"}`, or `"until": null` for no end. While it is active, every session is exempt
    from flags and every restart waits.

## The tick
- At most one per `tick_min`, from any trigger. One tick runs at a time under `tick.lock`. A working tick refreshes
  the lock. On Windows, a holder that has held it ≥ 10 min and is still the same node process (start time within 2 s)
  is killed (`tick: killed hung tick ...`). Any other old lock is only reclaimed (10 s PID-reuse tolerance).
- It reads only the launcher registry's sessions. The orphan scan reads the whole process list, but only reports.
- A process probe that fails or times out means liveness `unknown`. Nothing is stopped, killed, closed, restarted,
  blocked or judged STALE on `unknown` (status: `liveness of <session> unknown: ... - not judged STALE`).
- A kill hits only the target's own recorded process tree, and only when its liveness reads `running`: a window's
  recorded host pid and start time are checked, then that host's tree is killed; a bg session's liveness comes from
  `claude agents`, then `claude stop <its background id>` (none recorded: never stopped).
- `coord.mjs tick --dry-run` and `launch.mjs watchdog` print what it would do and write nothing.

## The session hook
- Every launch installs five hooks (`live.mjs` `sessionHooks()`, folded into the profile's one `--settings` file):
  - `PostToolUse` (every tool) → `coord.mjs post-tool`: stop delivery, the looping-subagent notice, the early warning,
    the claude-in-chrome tab set and the checklist lines; it adds at most one line per call.
  - `Notification` → `coord.mjs notify`: records `waiting_since` for permission prompts.
  - `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` → `coord.mjs fence`: the write fence (batch A).
  - `UserPromptSubmit` → `coord.mjs lane-note`: the lane note, on the first prompt and when the live lanes change.
  - `Stop` → `coord.mjs stop`: once per turn that used claude-in-chrome and left this session's tabs open, it blocks
    with `You left <n> claude-in-chrome tab(s) open ...` (never on a continuation Stop).
- The early warning comes after `warn_streak` repeats of the same call; Monitor calls never count.
- Running sessions keep their old settings file until they relaunch. The batch-A hooks fail open (any error: exit 0, no
  output); each costs about 100 ms (node start). The fence reads the registry only at a session's first write and when
  a write leaves its own root, the config dir, the temp dir and `<main>/.superpowers`.
- **The write fence** decides for an absolute, normalised path (case-insensitive, forward slashes, `\\?\` stripped):
  allow under the own root (the entry's worktree, or the main checkout = main root minus `.claude/worktrees/**`), the
  config dir, the temp dir, `<main>/.superpowers/**` and an unowned `<main>/.claude/worktrees/<x>` (a subagent's own
  worktree); deny under another open entry's worktree of the repo, or under the main checkout for a session not on it;
  allow the rest. The owner named is the open entry whose worktree is the longest prefix. Bash writes, junctions and
  symlinks are not fenced (known gaps). The denial names `launch.mjs queue --to <owner>`, with `[--after-merge]` only
  when the owner is in a group (`queue` refuses the flag otherwise); a main-checkout file with no session there says
  "tell the user", plus `--after-merge` to your own lane when you are in a group.
- **post-tool** also keeps the claude-in-chrome tab set (ids from `tabs_context_mcp`/`tabs_create_mcp` results, minus
  `tabs_close_mcp` inputs) and the checklist lines: after `goal_missing_calls` main-thread calls with no GOAL.md, one
  line per session; when GOAL.md has open items, is `goal_stale_min` old and `goal_stale_changes` work calls (Edit,
  MultiEdit, Write, NotebookEdit, Bash, PowerShell, Agent, Task) happened since its last write, one line until GOAL.md
  changes again. A subagent's call is counted as work but never gets the line.
- Hand-opened sessions get one missing-GOAL.md block from goal-gate after `goal_missing_calls` tool calls (once per
  session: `<config>/goals/.nudged-<sid>`; not on a continuation, a question, background tasks, print mode
  `CLAUDE_CODE_ENTRYPOINT=sdk-cli`, or a transcript with one user prompt; it counts toward the gate's 3 continuations).
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
  window without a `turn_duration` record. An idle transcript is not enough: both closes probe below the host first,
  and a window that runs something but no claude (claude exited, the user runs a job there) is kept, as is one whose
  probe failed.
- **Windows whose claude is gone** (Part 3; window entries, every group): launched ≥ `idle_close_min` ago, transcript
  quiet that long (or none), and an EMPTY host (nothing below it; a probe failure means no action). Exited (the
  transcript has assistant records since the launch): `closed <name> (gen N): claude exited`. Dead start: one
  `{dead_start}` line, `DEAD START ...` and one alert (`deadstart|<id>`, again after `alert_repeat_hours`); a
  coordinator restart (the first `{restart}` of its name after its launch line) also gets `{restart_failed}` +
  `{lane_blocked}`; `dead_close_min` after the alert the window is closed (`... dead start: no claude in the window
  since <at>`). The close is the guarded no-claude form: the recorded host, an empty host re-checked before the kill,
  no turn-state check. A launch onto that checkout, a `--resume` or `launch.mjs resume` closes such a window first
  (launched ≥ 2 min ago, empty host). A failed probe below the hosts prints `skip the gone scan of <n> window(s): ...
  - no action`. A dead-start window the user reuses by hand (a job runs in it, so it is never closed) keeps
  `DEAD-START (since ...)` in `status` while it is open.
- Lines:
  - `would close <name> (gen N): <why>` (dry run), `closed ...`, `not closed ...: <why> - <kill result>`;
  - `skip close of <name> (gen N): <reason>`, where the reason is: no recorded host pid and start time; liveness
    unknown; host pid N is not the recorded window; the process probe below its window failed; its window runs
    `<names>`, no claude; its turn is not done; hook state unreadable; its loop ladder is pending; and, for the
    no-claude form, its window is not empty;
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
- The occupancy check (a launch that replaces nothing by rule: not a resume, `--supersedes`, a relay or a merge session
  with no known launcher - such a merge launch is never refused, even when it finds no predecessor): an open entry on
  the target checkout that really runs (its host alive with anything below it - claude, or a job the user runs there - or a bg session `claude agents`
  lists) refuses it: `refused - <repo>@<branch> already has a running session <name> (gen N, id <id>): ...` (exit 3,
  before any side effect; `--force` overrides). A window launched < 2 min ago with an empty host counts as running
  (still starting). Unknown liveness, or a failed probe below its window, only warns. Every fresh launch closes the
  target's windows whose claude is gone (launched ≥ 2 min ago, empty host). `--dry-run` reports `occupancy` and refuses
  or closes nothing. A `--worktree` branch checked out in the main checkout exits 2 before the occupancy check;
  `--supersedes` without a known registry id and `--scope` without a text exit 2.
- The inbox: a fresh launch named `<lane>` (not a merge session, not `--resume`, not `--dry-run`) renames its inbox to
  `<lane>.<stamp>.taken.md` and appends ` Read your inbox first: <path> - ...` to the prompt only (never to
  `prompt_file`). A failed rename takes nothing (warning). A launcher that ends before the session is recorded (a
  failed bg launch with no new session, a window that could not be spawned, a refusal after the take) gives it back;
  items queued meanwhile follow the taken ones in the merged `<lane>.md` (nothing is lost).
- `queue` appends `## <time> from <name>` + the text; a text line that looks like such a heading is stored escaped as
  `\## ...`, so it never counts as an item. `--after-merge` needs a `--to` lane in a group (exit 2 otherwise).
- An unknown flag only warns, on any path - a launch, `--resume` and every subcommand - (`warning: unknown flag --<x>
  (ignored)`, on stderr) and is ignored; a word with whitespace is a value, never a flag. The known set is every
  `opt`/`flag`/`val` literal of `launch.mjs` (`tests/provenance.test.mjs` checks it). `group` refuses an unknown flag
  (exit 2) with its own line instead.
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
  `{restart_failed}` + `{lane_blocked}` + an alert; it does not defer.
- A restart the cap refuses is deferred, never blocked or forced. The tick prints `restart of <lane> deferred: session
  cap (...)`, raises one alert (`cap|<registry id>`, again after `alert_repeat_hours`), retries at every tick, and
  restarts once the cap allows. `launch.mjs resume` prints `not relaunched: <lane> - session cap (...)` and the lane
  stays blocked. The refusal's first line starts with `refused - session cap:` (`CAP_REFUSED`), which the tick
  matches: never reword one without the other.
- The cap refuses a launch or a `--resume` before any side effect. It counts a session whose liveness is unknown as
  doubtful. A bg entry with no background session id recorded
  is listed as `<name> (<branch>): not counted - no background session id recorded`.
- A session closed by hand after its incident but before the kill is relaunched by the next tick (the kill finds it
  gone). The pause file prevents that.
- A lane becomes `loop-blocked` (a `{lane_blocked}` line, no later `{lane_resumed}`, no done marker) at its restart cap,
  after a failed restart, when its newer launch is gone without a close, or when an auto ladder ends in report mode.

## Untracked sessions and orphans (report-only)
- `UNTRACKED <name>: launcher died before registering it - pid <pid|?> <running|gone|unknown>`: a `{starting}` line
  older than 3 min with no later launch line of that name (a bg `{starting}` with no session id is tracked by any later
  launch line of its name). Gone or pid-less lines stop showing 24 h after their start. A launch warns (never refuses)
  when an untracked session of its lane still runs.
- Orphan scan (Windows, hourly): python, pythonw, node, pytest and chrome processes ≥ 300 MB whose parent is gone or
  newer, into `orphans.json`; one alert when they hold > 1 GB. `status` prints `ORPHAN <name> pid <pid> <mb> MB (parent
  <ppid> gone) since <time>` while the scan is < 2 h old. `claude` is not an orphan name: a claude left by an npm
  `.cmd` install or a restart timeout shows only as `UNTRACKED ... pid ? unknown`.

- The Playwright reaper (with the hourly orphan scan, Windows): a browser (`chrome`, `chromium`, `msedge`) with
  `--remote-debugging-pipe` and a Playwright `--user-data-dir` (`playwright_*dev_profile-*`, or under
  `ms-playwright-mcp`), or a `node`/`cmd` naming `@playwright/mcp`, whose direct parent is gone or newer, is killed with
  its tree (`killed Playwright orphan <name> <pid> (parent <ppid> gone)`); never by ancestor names. Then the temp dir's
  `playwright_*dev_profile-*` dirs older than 24 h that no running process names are removed (`--isolated` leaves them).

## Housekeeping (the tick, at most hourly)
Deleted after 14 days: restart logs, `sent-*` alerts, and the state files of closed or gone sessions. Also deleted:
`writeAtomic` temp files (`<file>.<pid>.<8 hex>.tmp`) older than 1 h, `looping.json` entries of closed sessions, and
`alerts/index.json` entries older than `alert_repeat_hours`. Never pruned: incidents, unclaimed or claimed alerts, the
state of running or unknown sessions, a state file with no launch line.

## Alerts
- The tick writes `alerts/<stamp>-<name>.json` (`{text, incident, created, desktop}`). It also starts a desktop
  notifier: a PowerShell balloon on Windows, `osascript` on macOS, `notify-send` on Linux, all best effort. `desktop`
  records only the spawn attempt (`spawned`, `skipped (HL_NO_SPAWN)` or `failed: <msg>`), never that a notification
  showed.
- The phone relay runs only in sessions without `HL_SESSION_ID` (opened by hand), from goal-gate's Stop hook:
  - It runs on a fresh Stop only (at most one alert per user turn), never when the turn ends with a question, and
    never to a session that released that alert (`released_by`; another session may take it).
  - It claims the file (`claimed-<sid>-<ms>-<orig>`) and blocks once, asking the session to send the text with
    PushNotification and run `coord.mjs alert-sent <file>` (renamed `sent-<orig>`) or `alert-release <file>`.
  - A relay block resets the goal gate's per-turn state; the GOAL.md check runs again at the next Stop.
  - A claim not resolved within 15 min is put back by the next tick (`released the unsent alert <orig>`).
  - With no hand-opened session reaching a Stop, alerts wait in the queue. A headless `claude -p` session relays at
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
  `overlap` is read when there is no sidecar). A reopened lane shows no overlap. `--dry-run` writes no sidecar.
- `status` probes every lane's liveness: one PowerShell probe for the windows, plus one `claude agents --json` for a
  group with bg lanes.
- git timeouts: 60 s for reads, 5 min for a merge or a worktree add, `max(5 min, test timeout + 2 min)` for the merge
  commit (`git <args> timed out after N s`). A failed git check refuses instead of guessing:
  - `--force`: `not cleared: could not tell whether a merge is in progress in <wt> (...) - nothing cleared`;
  - `--skip`: `ERROR could not tell whether <lane>'s merge is still in progress in <wt> (...) - nothing skipped`;
  - the drain: `ERROR could not tell whether a merge is left in <wt>`;
  - overlap: `WARN overlap not refreshed: ...`;
  - status: `QUEUED (merged unknown: ...)`.
  A killed git can leave `index.lock` in the merge worktree; the next drain stops with an ERROR until it is removed by
  hand.
- A drain lock records `pid_start`. On Windows a live pid that started > 10 s after it is a reused pid: the lock is
  reclaimed (STALE in status).
- A merge session's lock younger than 3 min with no launch line yet makes `--force` and `--skip` refuse (`liveness is
  starting (merge.lock taken N s ago, no launch line yet)`). Past 3 min, a running untracked window of that session
  refuses as `still running (untracked: ...)`, and a host that cannot be probed as `liveness is unknown`. An untracked
  bg merge session (no pid file) never blocks them.

## Test hooks (tests only)
`HL_REGISTRY_DIR`, `HL_PROJECTS_DIR`, `HL_AGENTS_JSON`, `HL_AGENTS_LOG`, `HL_FAKE_PROBE=fail|timeout|fail:<label>`,
`HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, `HL_PROFILES_JSON`, `HL_CLAUDE_JSON`, `HL_FREE_GB`, `HL_FAKE_PROCS`,
`HL_FAKE_GIT_TIMEOUT`, `HL_LAUNCH_MJS`, `HL_SKILL_DIR`. Their meanings are in the header comments of `launch.mjs`,
`live.mjs`, `merge.mjs`, `recover.mjs` and `hooks/coord.mjs`. With `HL_FAKE_PROCS` the reaper kills nothing. The sandbox
drops the developer session's `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED` and
`CLAUDE_PID`; tests set them. `tests/helpers.mjs` `host()` runs a claude stand-in below the window host (a live
session's host is never empty); `emptyHost()` and `jobHost()` model an exited claude and a user's job.
