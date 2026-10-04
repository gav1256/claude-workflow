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
- It is the `PostToolUse` hook (`coord.mjs post-tool`), plus a `Notification` hook (`coord.mjs notify`) that records
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

## Merge internals (section 4)
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
`HL_REGISTRY_DIR`, `HL_PROJECTS_DIR`, `HL_AGENTS_JSON`, `HL_AGENTS_LOG`, `HL_FAKE_PROBE=fail|timeout`,
`HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, `HL_PROFILES_JSON`, `HL_CLAUDE_JSON`, `HL_FREE_GB`, `HL_FAKE_PROCS`,
`HL_FAKE_GIT_TIMEOUT`, `HL_LAUNCH_MJS`, `HL_SKILL_DIR`. Their meanings are in the header comments of `launch.mjs`,
`live.mjs`, `merge.mjs`, `recover.mjs` and `hooks/coord.mjs`.
