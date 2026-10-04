---
name: handoff-launch
description: Use when work should continue in a NEW, clean Claude Code session — the context is getting large, a task boundary is reached, or the user asks to "continue in a new session" / "start a fresh session with the handoff". Writes or verifies the handoff document, then opens the new session (a Windows Terminal window by default) already pointed at it, and hands control over.
---

# Handoff launch

Continue work in a fresh session without the user copy-pasting anything.

## 0. When (token-optimal, same rule as ~/.claude/CLAUDE.md "Long work")
Hand off at the FIRST task boundary once context passes ~250k; from ~150k when the next task is unrelated to what is
in context; never later than ~400k (split the task to force a boundary). Never mid-task, and never while background
agents are still running — wait for them, or record them in the handoff as "re-dispatch".

## 1. The handoff must be complete on disk first
A handoff document (house format: repo state, what was done, what is next in order, traps, and a `THE PROMPT` section
with a paste-ready prompt). Multi-session work chains plan-prompt → plan → impl-prompt → implement → next prompt; each prompt
carries read order, house rules, agent protocol, measured baselines and traps written as prohibitions; with no ruled scope
its first instruction is "ask the user". Keep the handoff on disk and refresh it at each task boundary. The new session only receives a short pointer prompt; everything it needs is in the file.
Before launching, make it durable:
- anything the next session needs that lives only in this session's scratchpad → copy to a durable place
  (the repo's docs, or `~/.claude/experiments/<date>-<topic>/`) and reference that path;
- update project memory with a one-line pointer to the handoff;
- if this session has a `GOAL.md`, mark items moving to the new session `- [!] ... — reason: handed off to <name>`.

**Shared checkout** (sessions without worktrees): disjoint file sets; `git commit -- <paths>` commits the WHOLE file, so when a
file also holds another session's uncommitted edits stage only your hunks (`git add -p` / `git apply --cached`) and commit
without paths; never `git checkout` another branch; one session owns rebuilds.

## 2. Launch
```
node ~/.claude/skills/handoff-launch/launch.mjs --repo <repo dir> --handoff <path to handoff .md> --name <short-label>
     --model <m> --effort low|medium|high|xhigh|max [--mode window|bg] [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>] [--force] [--no-close] [--dry-run]
```
Fan-out subcommands (section 4): `launch.mjs group --group <id> --repo <dir> --integration <b> --target <b> [--test "<cmd>"] [--test-timeout-min <n>] [--mode window|bg] [--force]`,
`launch.mjs merge --group <id> [--repo <dir>] [--lane <name>] [--skip <lane> [--session <merge session>] --why <reason>] [--force] [--dry-run]`,
`launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]`, `launch.mjs status --group <id> [--repo <dir>] [--no-merge] [--dry-run]`.
Coordinator subcommands (section 5): `launch.mjs recover (--group <id> | --name <session>) --mode auto|report`,
`launch.mjs resume --group <id> [--lane <name>]`, `launch.mjs watchdog [--repo <dir>]` (what the coordinator tick would
do now; writes nothing), `node ~/.claude/hooks/coord.mjs tick --dry-run`. The coordinator itself calls
`launch.mjs --resume <session id> --recovery <incident>` and `--recovery/--prompt-file/--goal-from` on a fresh restart.
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
  On Windows a bg launch refuses a `%` in any of its arguments (registry dir and profile file paths included).
- `--worktree <branch>`: the session runs in `<repo>/.claude/worktrees/<branch-slug>` (created from `--base`, default
  the repo's HEAD; reused if it exists). The main checkout is never checked out. The handoff is passed by absolute path.
  With git < 2.22 the branch recorded at launch falls back to `--worktree`'s branch, or `HEAD` without one.
- The launcher strips this session's `CLAUDE_*` environment and reloads PATH from the registry, so the child is a
  genuinely new session. Run with `--dry-run` first if anything looks unusual: it shows the worktree action, the
  registry line and the windows it would close, and changes nothing.
- Every launch is recorded in `~/.claude/skills/handoff-launch/sessions.jsonl` (name, repo, branch, worktree,
  generation per repo+branch, window host pid, `--session-id`, group, profile, model, effort, `coord: 1`, the base
  pointer prompt's file). Append-only. Right before each spawn the launcher appends a `{starting}` line (session id or
  null, name, group, pid file, at), which is not a launch line; a launcher that dies between the two leaves a session
  that `status` reports as `UNTRACKED` (section 5).

### Lane profiles and the session cap
`--profile a,b` (from `profiles.json`) picks what heavy tooling a session keeps; names union, `lean` is implied, the
default is `lean`. Every other heavy plugin is disabled via one `--settings` file, and only the kept MCP servers run
(`--strict-mcp-config --mcp-config <file>`, which also drops plugin MCP servers and claude.ai connectors; plugin skills still load).
So a profile keeps only non-MCP plugins in `plugins` (e.g. an LSP); an MCP server, a plugin's one included, goes in
`mcp`. Names resolve from `~/.claude.json` `mcpServers`, the work dir's `.mcp.json`, the repo's `.mcp.json`, then the
built-in `servers` of `profiles.json`; a profile that keeps a plugin named like a built-in server exits 2. The main
checkout's `.mcp.json` is read after the repo's; a `--resume` reads the worktree's and the main checkout's.

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
hand with `--profile full`, or pick a lane profile on purpose. Every automatic restart already does this: `--resume`,
the coordinator's fresh restart and `launch.mjs resume` reuse the entry's profile, and `full` for an entry without one.
A profile renamed or removed in `profiles.json` makes the restart of a lane launched under the old name exit 2: the
coordinator blocks that lane (`{restart_failed}`, `{lane_blocked}`, an alert), it does not defer it.
**One `--settings` file per launch.** Every launched session gets the coordinator's session hooks folded into its
profile's `--settings` file (`session-hooks.json` next to the registry is only their inspectable copy), so
`profile-args` prints the files a launch passes (`full` gives `["--settings", <file>]`). Two `--settings` flags do not
merge (the last one wins): never add a hand-made `--settings` to a launcher session.
**Session cap**: a launch is refused (exit 3) before it creates or records anything, while ≥ `max_sessions` (6, an
integer ≥ 1) other sessions run (windows whose host is alive or unproven, bg sessions `claude agents` lists as
unfinished; the newest one on the same repo+branch is not counted - a relay replaces it) or free RAM < `min_free_gb`
(3). Config: `<registry dir>/launch-config.json`. It counts launcher sessions only: hand-opened sessions are not
counted (the free-RAM floor covers them), and a window whose claude exited still counts until its window is closed.
Merge sessions (`<group>-merge...`) are exempt. Close idle sessions first; `--force` overrides it only with the user's
OK. `--dry-run` reports `cap` and never refuses. The cap also refuses `--resume`, before any side effect. A session
whose liveness is unknown counts as doubtful; a bg entry with no background session id recorded (its spawn showed no
new session) is listed as `<name> (<branch>): not counted - no background session id recorded`. A coordinator restart
the cap refuses is deferred, never blocked or forced: the tick prints `restart of <lane> deferred: session cap (...)`,
raises one alert (again after `alert_repeat_hours`), retries at every tick and restarts the lane once the cap allows.
`launch.mjs resume` prints `not relaunched: <lane> - session cap (...)` and the lane stays blocked. The refusal's first
line starts with `refused - session cap:`, which the tick matches: never reword it.

## 3. Verify and hand over
- Call `ListAgents`: the new session should appear (by its `-n` name) within ~30 s. If it does not, say so and give the
  user the exact launcher command — never claim it started.
- The NEW session is now the controller. This session finishes only what is in flight, dispatches nothing new, and
  tells the user in a few lines: the handoff path, the session name, how to reach it.
- Sessions launched by this launcher get their stop requests from their session hook at their next tool call. Only if
  the launcher printed `stop requested ... deliver with SendMessage to '<name>': <text>` (a session launched before
  stage 2), send that text to that session with `SendMessage`.

## 4. Fan-out: parallel lanes, merged as each one finishes
1. **Set up the group once, before launching any lane:**
   `node ~/.claude/skills/handoff-launch/launch.mjs group --group <id> --repo <main repo> --integration <branch> --target <branch> [--test "<cmd>"]`
   It writes `.superpowers/sessions/<id>/config.json` (`.superpowers/` must be git-ignored). The test command runs in
   the merge worktree `.claude/worktrees/_merge-<id>` on the integration branch, so it installs what it needs (e.g.
   `npm ci && npm test`); default timeout 30 min (`--test-timeout-min`). That worktree persists across merges
   (installed deps and build output stay); the test must not modify tracked files. Then write one handoff per task and
   launch each with its own branch and the same group: `--worktree <branch> --group <id> --name <task>`.
   `group --force` on a group that already launched lanes switches it to rolling merges mid-flight: do not, except
   before any lane finished.
2. **Lanes never wait for each other** (user directive 2026-10-01). Each member (`--name`) is a LANE: its whole wave of
   stages, not one handoff. When a stage finishes and the lane has a next stage that does not need another lane's
   unmerged work, START IT NOW in a NEW session: write that stage's handoff and launch it via this skill with the SAME
   `--name`, `--group` and `--worktree <same branch>`, sized for that stage, passing `--handoff` as an ABSOLUTE path (the
   registry keeps the latest entry per name, so the done marker stays the same). Only a small follow-up (≲ 1 hour, context still < ~150k) continues in the
   same session. Stages inside an already-ruled wave (the lane's own ledger/plan) need no ask-before-handoff; anything else (memory
   queues, a new feature) → ask the user before starting it. Never idle waiting for a sibling.
3. **Done contract** — only when the lane's whole wave is finished (or blocked, or its next stage needs another lane's
   unmerged work): commit on its own branch (never push, never merge), then write
   `<main repo>/.superpowers/sessions/<id>/<name>.done` (the pointer prompt names the exact path) as JSON
   `{"name","branch","head":"<sha>","status":"done|blocked","tests":"<real test output summary>","next_after_merge":[...],"at"}`,
   then run `launch.mjs merge --group <id> --repo <main repo> --lane <name>` (the pointer prompt has the exact command)
   and act on its output:
   - `merged <lane> -> <integration> <sha>`: done; tell the user in one line.
   - `queued: ...`: another merge holds the lock and picks this lane up after its own. Nothing to do, unless the line
     says STALE or names merge --skip/--force: then pass it to the user.
   - `MERGE-BLOCKED <lane>: ...`: if `<lane>` is yours, your marker's `head` is unusable - rewrite the marker with
     `head` = `git rev-parse <your branch>` and run merge again (a new head is queued again); otherwise report it in
     one line.
   - `lane <name>: loop-blocked`: the coordinator stopped that lane at its restart cap (see section 5). Report it in
     one line; `launch.mjs resume --group <id> --lane <name>` relaunches it after the cause is fixed.
   - `CONFLICT ...` / `TEST FAILED ... merge session <id>-merge-<lane> launched`: that session (opus/high) resolves it.
     Nothing to do.
   - `FINAL_READY ...`: every lane is merged or blocked. Ask the user to approve the final merge of the integration
     branch into the target (never push without asking). After it, set up a NEW group with `launch.mjs group` (step 1;
     without it the group silently becomes a legacy group), then launch the listed `next_after_merge` stages in it,
     each on a NEW branch with `--base <target>`.
   - `ERROR ...` (exit 1): report it to the user verbatim. Never delete the lock or edit the merge worktree yourself.
   - `merge.lock changed hands repeatedly - run merge again`: run the same merge command once more.
   - Anything else (`lane <name>: <state>`, `nothing to merge`, `merged ... (already contained ...)`): report it in one
     line.
4. **How merges run** (code, zero tokens): one at a time under `.superpowers/sessions/<id>/merge.lock`, in the scratch
   worktree `.claude/worktrees/_merge-<id>` (never a lane's): `git merge --no-ff --no-commit <marker head>`, the test
   command, then the commit. A conflict or a failing test aborts the merge (the integration branch does not move) and
   launches `<id>-merge-<lane>` with a generated handoff listing the conflicts and the test output. That session holds
   the lock until its last step, `launch.mjs merge --group <id>`, sees the lane merged, releases the lock and merges
   the lanes that finished meanwhile. Running lanes are never touched. Pass `--repo <main repo>` to `merge`, `status`
   and `overlap`.
   - `status --group <id>` also merges finished lanes (`--no-merge` only looks). Per lane it shows `MERGED`/`QUEUED`/
     `MERGE-BLOCKED` and `overlap=` (files a finished lane shares with running lanes; also `launch.mjs overlap --group
     <id>`). The summary adds `merged= queue=[..] merge_holder= final_ready=`; `merge_launched=true` means a merge
     session holds the lock. Its merge step prints `merge: ...` lines and `status` exits 0 even after `merge: ERROR ...`:
     read the output, not the exit code.
   - `status` shows a lane the coordinator blocked as `LOOP-BLOCKED (incident <path> - resume: ...)`; the drain skips
     it and `final_ready` counts it like a blocked lane. It still counts as running for `overlap=`. A lane whose
     merge state git could not answer shows `QUEUED (merged unknown: ...)`. `status` probes every lane's liveness with
     one PowerShell probe (plus one `claude agents --json` for a group with bg lanes).
   - Overlap is kept in a sidecar `.superpowers/sessions/<id>/<lane>.overlap.json`; done markers are never rewritten
     (an older marker's own `overlap` is still read when there is no sidecar). A reopened lane shows no overlap.
   - git calls time out (60 s for reads, 5 min for a merge or a worktree add, `max(5 min, test timeout + 2 min)` for
     the merge commit) with `git <args> timed out after N s`. A git check that fails refuses instead of guessing:
     `could not tell whether a merge is in progress in <wt> (...)` for `--force`/`--skip`, `ERROR could not tell whether
     a merge is left in <wt>` from the drain, `WARN overlap not refreshed: ...`. A killed git can leave `index.lock` in
     the merge worktree: the next drain stops with an ERROR; remove that file by hand.
   - `--dry-run` on `merge`, `status` or `overlap` writes nothing (no merge, no launch, no overlap in the markers);
     `merge --dry-run` prints the order it would merge in and the lock holder.
   - Recovery: a lock whose merge process died is reclaimed by the next merge, which also aborts an unfinished merge
     left in the merge worktree. A drain lock records its process's start time (`pid_start`): on Windows, a live pid
     that started more than 10 s later is a reused pid, so the lock is reclaimed (STALE in status).
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
     flags, `--skip` runs before `--force`. For 3 min after a merge session took the lock with no launch line yet,
     `--force` and `--skip` refuse with `liveness is starting (merge.lock taken N s ago, no launch line yet)`; after
     that, a running window its dead launcher never registered refuses as `still running (untracked: ...)` (a host
     that cannot be probed: `liveness is unknown`). An untracked bg merge session (no pid file) never blocks them.
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
`<config>` below is `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`; the coordinator's files live in
`<config>/state/coord/`.
- **Auto-close** (window launches): after launching generation N on a repo+branch, the windows of generations ≤ N-2
  there are closed - only if the window's process is still the PowerShell host recorded at launch (PID-reuse guard) AND
  its session is idle (finished turn, no outstanding tool call, no background agents) for ≥ 10 min. A busy session gets
  a stop request instead. A window whose turn ended without a `turn_duration` record is kept (its background agents are
  unknown). `--no-close` disables it.
- **The coordinator tick** (`~/.claude/hooks/coord.mjs tick`, code in `recover.mjs`) runs at most every 5 min. It is
  started detached by the goal-gate Stop hook in every session, by the session hook in launcher sessions, and by every
  launch; whichever trigger fires writes `<config>/state/coord/tick.json`, the rate-limit stamp (not another session's
  state). It spends no tokens until something fires, reads only the launcher registry's sessions, and never touches
  another session: a kill hits only the target's own recorded process tree (pid and start time checked first), and a
  restart reuses only the target's own worktree. A process probe that fails or times out means `unknown`: nothing is
  closed, killed or judged STALE, and `status` says `liveness=unknown (...)`. One tick runs at a time (`tick.lock`); a
  holder hung ≥ 10 min (a live node process with the recorded start time) is killed (`tick: killed hung tick ...`), any
  other old lock is reclaimed.
- **It also closes,** for every group (report-only included) and lone session, a window of generation N-1 once N runs
  and N-1 is idle ≥ 10 min with no outstanding call, no background agents (its turn ended with a `turn_duration`
  record) and no permission prompt open; and, in `auto` groups only, an idle window that recorded `{paused}`, and one
  that has an incident while a newer launch of its lane runs. A window with no transcript closes only when it was
  launched ≥ 10 min ago and no claude runs below its host. Lines: `would close <name> (gen N): <why>` (dry run),
  `closed ...`, `not closed ...: <why> - <kill result>`, `skip close of <name> (gen N): <reason>` (no recorded host pid,
  liveness unknown, host pid is not the recorded window, its turn is not done, hook state unreadable, its loop ladder is
  pending); a kept window prints nothing. A close writes `{kill_intent, kind: "close"}` then `{closed}` and never leads
  to a restart. A paused window with a pending ladder: the tick cancels the ladder and closes the window in one tick,
  but a `--dry-run` shows `skip close ...: its loop ladder is pending` (a dry run records no cancel).
- **The session hook** (every session this launcher starts gets it through `--settings`) runs after each tool call and
  adds at most one line: a stop request, a looping-subagent notice, or an early warning. A subagent receives its notice
  but may not act on it; its parent's notice and the ladder cover that case. Parallel subagents share their parent's
  state file, so one stop token can get more than one `{stop_delivered}` line; the ladder reads the first.
- **Lane rules - when you receive:**
  - an early warning ("You have repeated `<call>` N times ..."): stop repeating, find the cause, change approach. If you
    are waiting on something, wait with Monitor or ScheduleWakeup instead of polling.
  - a looping-subagent notice ("Agent `<type>` `<id>` is looping ..."): TaskStop that agent, find the cause in its
    transcript, fix the brief or the code, then re-dispatch per sizing-dispatches. A subagent told "You are
    repeating ..." stops and returns what it has and the suspected cause.
  - a stop request ("The coordinator flagged a loop ..." or "STOP REQUEST from handoff-launch ..."): finish or cancel the
    current call, TaskStop your background agents, save your state (ledger or handoff, GOAL item `[!] loop-stopped`),
    and end your turn. The loop is cleared only when the repeated call stops, not by one different call.
  - a RECOVERY prompt (you are a restarted session): read the incident file it names, find and fix the cause
    (systematic-debugging), write it into the incident's `## Cause` section and your lane ledger, then continue. A
    Cause left empty sends the next restart one sizing rung up.
- **Pausing.** A session that has saved its state and wants to be left alone appends one line to the registry
  (`sessions.jsonl`): `{"paused":"<its --name or registry id>","at":"<ISO time>"}` (it covers launches started before
  `at`). It means "state saved": the session is never flagged, and in an `auto` group its idle window may be closed.
  `<config>/state/coord/pause.json` (`{"until":"<ISO time>"}`, or `"until": null` for no end) exempts every session
  from flags and holds every restart while it is active.
- **The ladder** (groups launched after stage 2 are `auto`): warning → stop request → 5 min grace → incident file → kill
  → restart. Incidents: `<main repo>/.superpowers/sessions/<group>/incidents/<lane>-<n>.md` for a group lane,
  `<config>/state/coord/incidents/<name>-<n>.md` for a lone session; an incident with flagged subagents has a
  `## Looping subagents` section. The first restart resumes the session (`claude --resume`; a background session
  always restarts fresh), the second is fresh from the original pointer prompt with its GOAL.md; at ≥ 400k tokens of
  context the first restart is fresh and the cap is 1. After that the lane is `LOOP-BLOCKED` and you are alerted. A lane
  whose done marker exists is killed but not restarted, and only the newest generation of a lane is ever restarted. A
  restart that fails to launch also blocks the lane; its alert names the launcher log (`<config>/state/coord/restarts/`).
  A restart the session cap refuses is deferred, not blocked (section 2). A restart waits while the pause file is
  active. A session closed by hand after its incident but before the kill is relaunched by the next tick: use the
  pause file to prevent that. Waiting on a usage limit, on AskUserQuestion or on a permission prompt is never flagged.
- **Groups launched before stage 2 are `report-only`:** an incident and an alert, nothing stopped. `status` prints
  `recovery: report-only (...)`. Opt in with `launch.mjs recover --group <id> --mode auto` (`--mode report` opts out;
  a lone session takes `--name <session>`). Opting in warns about sessions that have no session hook: a stop request
  cannot reach them, so a loop there is killed 5 min after the request.
- **A merge session at its cap** keeps `merge.lock` (status shows STALE). Its alert says what to do: `git merge --abort`
  in `.claude/worktrees/_merge-<id>`, then `launch.mjs merge --group <id> --force` (or `--skip <lane> --why ...`).
- **`status`** lane notes: `incidents=<n> (latest <path>)`, `LOOP-BLOCKED (...)`, `liveness=unknown (...)`. After any
  group it also prints, report-only, `UNTRACKED <name>: launcher died before registering it - pid <pid|?>
  <running|gone|unknown>` for a `{starting}` line older than 3 min with no later launch line of that name (so a bg
  `{starting}` line, which has no session id, is tracked by any later launch line of its name; a gone or pid-less one
  stops showing after 24 h), and `ORPHAN <name> pid <pid> <mb> MB (parent <ppid> gone) since <time>` from
  `orphans.json` while it is < 2 h old.
  `launch.mjs resume --group <id> [--lane <n>]` relaunches blocked lanes fresh with a new restart budget.
  `launch.mjs watchdog [--repo <dir>]` prints what the tick would do now and writes nothing (`--stop-looping` is kept as
  an alias that runs the tick for real); `coord.mjs tick --dry-run` does the same for every repo.
- **Untracked and orphaned processes** are only reported. The orphan scan (Windows, hourly) writes `orphans.json`:
  python, pythonw, node, pytest and chrome processes of ≥ 300 MB whose parent is gone, with one alert when they hold
  more than 1 GB. `claude` is not an orphan name: a claude left by an npm `.cmd` install or a restart timeout shows only
  as `UNTRACKED ... pid ? unknown`. A launch also warns (never refuses) when an untracked session of its lane still runs.
- **Housekeeping** (the tick, at most hourly; stamps in `housekeeping.json`): deletes restart logs, `sent-*` alerts and
  the state files of closed or gone sessions older than 14 days, `writeAtomic` temp files older than 1 h, `looping.json`
  entries of closed sessions and `alerts/index.json` entries older than `alert_repeat_hours`. Incidents and unclaimed
  or claimed alerts are never pruned.
- **Alerts:** a desktop notification, plus an alert file `<config>/state/coord/alerts/<stamp>-<name>.json` that the
  next session not started by this launcher relays as a phone push: its Stop hook asks it once to send the text with
  PushNotification and run the printed `alert-sent` (or `alert-release`) command. The file's `desktop` field records
  only that the notifier was started (`spawned`), never that a notification showed. The relay needs a hand-opened
  session: with none running, alerts wait in the queue, and a claim not resolved within 15 min returns to it
  (`released the unsent alert ...`). Bounds: one alert per user turn (a fresh Stop only), none when the turn ends with a
  question, never to a session that released that alert (another may take it); a relay resets the goal gate's
  per-turn state. A headless `claude -p` session has no `HL_SESSION_ID`, so it relays at most one alert per run.
- Thresholds: `<config>/state/coord/config.json` (`repeat_window` 20, `repeat_count` 4, `warn_streak` 3, `stuck_min`
  30, `grace_min` 5, `idle_close_min` 10, `fresh_at_tokens` 400000, `max_restarts` 2, `tick_min` 5,
  `alert_repeat_hours` 6). The last tick's report: `<config>/state/coord/last-tick.txt`.
- **Stop contract** - any session that receives a stop request (or `launch.mjs stop --name <n>` was run for it):
  finish or cancel the in-flight tool call, `TaskStop` every background agent it started, record its state in its
  ledger/handoff, then end its turn and start no new work.
- Large-org variant: a central supervisor service with an audit log, per-session credentials for stop and kill, and
  policy-gated kills.
