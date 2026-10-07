---
name: handoff-launch
description: Use when work should continue in a NEW, clean Claude Code session — the context is getting large, a task boundary is reached, or the user asks to "continue in a new session" / "start a fresh session with the handoff". Writes or verifies the handoff document, then opens the new session (a Windows Terminal window by default) already pointed at it, and hands control over.
---

# Handoff launch

Continue work in a fresh session without the user copy-pasting anything.

## 0. When (token-optimal, same rule as ~/.claude/AGENTS.md "Long work")
Hand off at the FIRST task boundary once context passes ~250k; from ~150k when the next task is unrelated to what is
in context; never later than ~400k (split the task to force a boundary). Never mid-task, and never while background
agents are still running — wait for them, or record them in the handoff as "re-dispatch". The next dispatch after 250k
is the relay: the status line's ctx segment says `relay`, and the Agent gate says so once at that dispatch.

## 1. The handoff must be complete on disk first
A handoff document (house format: repo state, what was done, what is next in order, traps, and a `THE PROMPT` section
with a paste-ready prompt). Multi-session work chains plan-prompt → plan → impl-prompt → implement → next prompt; each
prompt carries read order, house rules, agent protocol, measured baselines and traps written as prohibitions; with no
ruled scope its first instruction is "ask the user". Keep the handoff on disk and refresh it at each task boundary. The
new session only receives a short pointer prompt; everything it needs is in the file.
Before launching, make it durable:
- anything the next session needs that lives only in this session's scratchpad → copy to a durable place
  (the repo's docs, or `~/.claude/experiments/<date>-<topic>/`) and reference that path;
- update project memory with a one-line pointer to the handoff;
- if this session has a `GOAL.md`, mark items moving to the new session `- [!] ... — reason: handed off to <name>`.

**Shared checkout** (sessions without worktrees): disjoint file sets; `git commit -- <paths>` commits the WHOLE file, so
when a file also holds another session's uncommitted edits stage only your hunks (`git add -p` / `git apply --cached`)
and commit without paths; never `git checkout` another branch; one session owns rebuilds.

## 2. Launch
```
node ~/.claude/skills/handoff-launch/launch.mjs --repo <repo dir> --handoff <path to handoff .md> --name <short-label>
     --model <m> --effort low|medium|high|xhigh|max [--mode window|bg] [--worktree <branch> [--base <ref>]] [--group
     <id>] [--profile <names>]
     [--supersedes <registry id>] [--priority high|normal|low] [--scope "<text>"] [--force] [--no-close] [--dry-run]
```
Fan-out subcommands (section 4): `launch.mjs group --group <id> --repo <dir> --integration <b> --target <b> [--test
"<cmd>"] [--test-timeout-min <n>] [--mode window|bg] [--force]`,
`launch.mjs merge --group <id> [--repo <dir>] [--lane <name>] [--skip <lane> [--session <merge session>] --why <reason>]
[--force] [--dry-run]`, `launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]`,
`launch.mjs status --group <id> [--repo <dir>] [--no-merge] [--dry-run]`.
Coordinator subcommands (section 5): `launch.mjs recover (--group <id> | --name <session>) --mode auto|report`,
`launch.mjs resume --group <id> [--lane <name>]`, `launch.mjs watchdog [--repo <dir>]` (what the coordinator tick would
do now; writes nothing), `node ~/.claude/hooks/coord.mjs tick --dry-run`.
`launch.mjs stop (--name <name> | --id <registry id>) [--why <text>]` writes a stop request by hand.
Lane subcommands (sections 4, 5): `launch.mjs queue --to <lane> [--group <id>] [--repo <main repo>] (--text "<text>" |
--text-file <f>) [--after-merge] [--from <name>]` (without `--group`: the newest lane of that name in any group),
`launch.mjs priority --name <lane> [--group <id>] --set high|normal|low`, `launch.mjs sessions [--repo <dir>]`. An
unknown `--flag` only warns (`warning: unknown flag ...`) on any path - a launch, `--resume`, every subcommand - and is
ignored; `group` refuses it. Check your spelling.
- `--model` + `--effort` are REQUIRED (the launcher refuses without them): size each session for ITS task before
  launching (user directives 2026-10-01). **Sizing the session** — judge two things, difficulty and length:

  | Session's task | `--model` | `--effort` |
  |---|---|---|
  | mechanical: doc edits, test/live-run babysitting, merges of reviewed branches | `opus` | `medium` |
  | normal controller: plans, dispatches, judges reviews | `opus` | `high` |
  | long AND hard: cross-cutting design, many rulings, multi-wave implementation | `opus` | `xhigh` (fable stays the reviewer via dispatch — too costly as a long controller) |
  | SHORT but very hard: one security/data-integrity ruling, a root cause nobody found, a high-stakes spec decision, bounded scope | `fable` | `high` |
  | short and the hardest class (correctness proof, an incident with data at risk) | `fable` | `xhigh` (`max` only if xhigh already failed on it) |

  Never Haiku; never sonnet as a session (sonnet is a mechanical subagent tier). If a session fails its task, relaunch
  one rung up. State the chosen row + reason in one line when reporting the launch. The session's subagents are still
  sized per dispatch by `sizing-dispatches`.
  **Priority** follows the sizing (fable, or effort xhigh/max → `high`; high → `normal`; medium/low → `low`);
  `--priority` overrides it, `launch.mjs priority` changes it later, and restarts keep it. It orders `status`, the merge
  queue and the coordinator's restarts; it never bypasses the session cap.
- Worktree sessions inherit the main checkout's `.claude/settings.local.json` (MCP approvals + allow rules, merged into
  any existing file), so they start without an "enable MCP servers?" prompt.
- `window` (default): new Windows Terminal window, interactive `claude` session, visible to the user. Windows only — the
  launcher refuses it on other OSes (use `bg`).
- `bg`: Claude Code background session (`claude agents` to list, `claude attach <id>` to open). Background sessions
  cannot edit the main checkout until they enter a worktree — use `window` for work that writes to the checkout.
- `--worktree <branch>`: the session runs in `<repo>/.claude/worktrees/<branch-slug>` (created from `--base`, default
  the repo's HEAD; reused if it exists). The main checkout is never checked out. The handoff is passed by absolute path.
  A lane is repo + branch. Only a session's own relay, a resume, a coordinator restart, a launch with
  `--supersedes <its id>`, or a merge session launched by no known session (it replaces the merge worktree's newest
  open entry) replaces a session. Any other launch onto a checkout whose session is running is refused (exit 3;
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
(`--strict-mcp-config --mcp-config <file>`, which also drops plugin MCP servers and claude.ai connectors; plugin skills
still load). So a profile keeps only non-MCP plugins in `plugins` (e.g. an LSP); an MCP server, a plugin's one included,
goes in `mcp`. Names resolve from `~/.claude.json` `mcpServers`, the work dir's `.mcp.json`, the repo's `.mcp.json`,
then the built-in `servers` of `profiles.json`; a profile that keeps a plugin named like a built-in server exits 2.

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

**Browser tools** (every profile keeps both; `full` keeps your own setup): Playwright (`mcp__playwright__*`) is the
default live-testing tool - its own headless browser per session, closed after 15 min without a call. Use
claude-in-chrome only for a site where the user is logged in: it is shared by every session (expect clashes), and you
close the tabs you opened.

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
   registry keeps the latest entry per name, so the done marker stays the same). Only a small follow-up (≲ 1 hour,
   context still < ~150k) continues in the same session. Stages inside an already-ruled wave (the lane's own
   ledger/plan) need no ask-before-handoff; anything else (memory
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
   - `lane <name>: loop-blocked`: the coordinator blocked that lane (restart cap or a failed restart; see section 5).
     Report it in one line; `launch.mjs resume --group <id> --lane <name>` relaunches it after the cause is fixed.
   - `CONFLICT ...` / `TEST FAILED ... merge session <id>-merge-<lane> launched`: that session (opus/high) resolves it.
     Nothing to do.
   - `FINAL_READY ...`: every lane is merged or blocked. Ask the user to approve the final merge of the integration
     branch into the target (never push without asking). After it, set up a NEW group with `launch.mjs group` (step 1;
     without it the group silently becomes a legacy group), then launch the listed `next_after_merge` stages (merged
     lanes only) in it, each on a NEW branch with `--base <target>`. `held_next_after_merge=` lists an unmerged lane's
     stages with its state: they wait until that lane is resumed and merged. `queued_after_merge=<n> (<path>)` and
     `unread_inbox=[<lane>:<n>]` name queued work (step 8).
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
     it and `final_ready` counts it like a blocked lane.
   - git calls time out, and a git check that fails refuses instead of guessing (`could not tell whether ...`). A
     killed git can leave `index.lock` in the merge worktree: the next drain stops with an ERROR; remove that file by
     hand. Exact refusals and timeouts: `coordinator.md`.
   - `--dry-run` on `merge`, `status` or `overlap` writes nothing (no merge, no launch, no overlap in the markers);
     `merge --dry-run` prints the order it would merge in and the lock holder.
   - Recovery: a lock whose merge process died is reclaimed by the next merge, which also aborts an unfinished merge
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
   fence denies another lane's worktree and the main checkout; `<main>/.superpowers/` stays writable; section 5).

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
  that recorded `{paused}`. A window whose claude exited is closed once quiet 10 min; a **dead start** (claude
  exited right after the launch) alerts once (`DEAD-START` in `status`) and is closed 60 min later. A job you run in
  a window whose claude exited keeps it (every close, the one at launch too, looks below the window first).
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
- **Usage pacing** (every session, also hand-opened ones): the status line shows `... │ 5h 6% │ wk 31%` (and
  `│ pace slow +12` while usage runs ahead). While
  usage runs ahead of the 5-hour or weekly pace, an `Agent` dispatch of a low-priority lane is denied ("Usage is ahead of
  pace ...": do the step inline at lower effort, or save state and end your turn); other sessions get one line
  "Usage ahead of pace ...: step effort down (`effort-medium`/`low`) and keep work small". `coord.mjs pace` prints the
  table; details in `coordinator.md` "Usage pacing".
- **The ladder** (`auto` mode): warning → stop request → 5 min grace → incident file → kill → restart. Incidents:
  `<main repo>/.superpowers/sessions/<group>/incidents/<lane>-<n>.md`, or `<config>/state/coord/incidents/<name>-<n>.md`
  for a lone session. The first restart resumes the session (`claude --resume`; a background session always restarts
  fresh), the second is fresh from the original pointer prompt with its GOAL.md; at ≥ 400k tokens of context the first
  restart is fresh and the cap is 1. After that the lane is `LOOP-BLOCKED` and you are alerted. A restart that fails to
  launch also blocks the lane (its alert names the launcher log); one the session cap refuses is deferred. A lane whose
  done marker exists is not restarted, and only the newest generation of a lane is ever restarted. Waiting on a usage
  limit, on AskUserQuestion or on a permission prompt is never flagged.
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
  `launch.mjs watchdog` (dry run; `--stop-looping` is an alias that runs the tick) shows what the tick would do.
- **Alerts:** a desktop notification (best effort), and a phone push relayed by the next hand-opened session: its Stop
  hook asks it once to send the text with PushNotification and run the printed `alert-sent` (or `alert-release`).
- Large-org variant: a central supervisor service with an audit log, per-session credentials for stop and kill, and
  policy-gated kills.
