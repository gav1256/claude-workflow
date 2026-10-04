# Batch A: lane hygiene (stage 3) and priority ordering (stage 4): design

Status: approved by the user (2026-10-05), after 3 Fable review rounds. It details stages 3 and 4 of
`docs/specs/2026-10-02-parallel-sessions-design.md` and replaces their outlines. It builds on stage 2
(`docs/specs/2026-10-04-stage2-loop-recovery-design.md`). Approval of this file covers batch A only.

## Goal
- Parallel sessions stay clean: a lane writes only into its own worktree, knows which other lanes are live, and
  queues work meant for another lane instead of half-applying it.
- Windows are closed only when their own successor replaces them, never because an unrelated session landed on the
  same checkout.
- The idle test sees everything a session still waits on, so a close never kills running work.
- High-priority work is listed, merged and restarted first.
- Both live-testing browser tools stay available in every session, cost nothing until used, and are shut down when
  the session is done with them.
- Every session keeps a checklist and ticks it as it goes, and the user sees every checklist in one place.

As in stages 1-2, every decision is deterministic code and costs zero tokens until it fires.

## User decisions (2026-10-05)
- **Batching and approval:** batch A = stages 3 + 4, batch B = stages 5 + 6 + 7. The user approves each batch's overall
  design once. Fable signs off the sections, and the user is asked only when Fable objects.
- **Write fence:** a write outside the lane is **denied** with a one-line hint to queue it. No permission prompt, so an
  unattended lane never stalls.
- **Rule (a):** no read-only shell-command classifier. A new successful read-only command still resets the repeat
  count. That errs toward fewer flags; the tracking item may measure how often the escape happens.
- **Priority:** it orders work only. It never bypasses the session cap (6 sessions, 3 GB free RAM).
- **Browser tools** (the user's words, relayed by the coordinator): "We shouldn't be disabling live testing ability in
  chromium." Then, replacing "pick one": "Keep both tools available but not constantly active and make sure when a
  session is done with them then shut them down properly." The measurement runs at sonnet low/medium effort; opus or
  fable reviews the results.
- **A checklist in every session** (the user's words, relayed by the coordinator): "In general and in the workflow
  there needs to be for every session a checklist." and "It needs to mark it as it finishes tasks to ensure that it is
  staying on task and finishing them."
- **Notifications** are muted on the user's machine and are lower priority: the desktop balloon stays best effort, and
  the phone relay is the real alert channel. Nothing in batch A depends on the balloon.
- **Earlier decisions that still apply:** rule (d) keeps `stuck_min` (S1); auto recovery for groups launched after
  stage 2; the older-generation close applies in every group; the standalone master app stays "later".

## Carry items and their disposition
| Item | Source | Disposition |
|---|---|---|
| `launched_by` / `supersedes` on launch lines | stage-2 ledger | Part 1 |
| Dead-restart alert | stage-2 ledger | Part 3 (any window launch, not only restarts; also windows whose claude exited later) |
| Background Bash tasks invisible to the idle test | stage-2 ledger | Part 2 (shell and Monitor tasks) |
| Stage-2 spec wording `:328-329`, `:413` | Task 12b minor | "Smaller changes" |
| `launch.mjs --resume` cannot change the profile | stage-2 ledger | "Smaller changes" (`--profile` on `--resume`) |
| T2f: `finalReadyText` lists unmerged lanes' `next_after_merge` untagged | stage-1 triage | Part 6 |
| Lane hooks ride in the ONE profile `--settings` file | stage-2 ledger | Already true since stage 2 (`sessionHooks()` is the base of `profileArgs`); the new hooks join it |
| T2a: `mergeQueue` sorts raw `at` strings | stage-1 triage | Part 7 |
| Read-only shell-command classifier | stage-2 ledger | Closed by the user: not built |
| Live check `--resume` quoting | stage-2 ledger | Done: exercised 2026-10-04 20:53:59Z (bakeoff gen 9 → 10) |
| Live checks `claude stop` (no-shell path) and `isPermission` | stage-2 ledger | Still owed at first occurrence; recorded in the batch-A ledger when they happen |
| Stage 6 must reuse `pause.json` and `{paused}` | stage-2 ledger | Batch B |

## Part 1: launch provenance (`launched_by`, `supersedes`)
**Problem.** A lane is repo + branch, and the close rule says "an older generation of the lane is superseded once a
newer one runs". The registry cannot tell a relay from an unrelated session that landed on the same checkout, so a
helper launched there gets its controller closed (2026-10-04: the coordinator shared the main-checkout lane with the
stage-2 controller and was closed as superseded). Today only a documentation rule prevents it.

**New launch-line fields** (fresh launches, `--resume`, restarts):
- `launched_by`: the transcript session id of the session that ran `launch.mjs`, read from `CLAUDE_CODE_SESSION_ID` in
  the launcher's environment (every Claude Code tool call carries it, hand-opened sessions included). `null` when
  launched from a plain terminal or by a coordinator process.
- `supersedes`: the registry id of the entry this launch replaces, or `null`. Written on every new launch line, so a
  line WITHOUT the key is a legacy line.
- `scope` (for Part 5): the handoff's first `# ` heading, trimmed to 80 characters; `--scope "<text>"` overrides it.
- `priority` (Part 7).

**How `supersedes` is set** (first match wins):
1. `--resume <sid>`: the entry being resumed.
2. `--supersedes <id>`: that entry. The tick's fresh restart passes the killed entry, and `launch.mjs resume` passes the
   blocked lane's newest entry. It is also a documented hand flag: a session that launches another session's next stage
   on its behalf (for example the coordinator) names the entry it replaces.
3. **A relay.** The launcher is a registry session L (found by `HL_SESSION_ID` = L.id, else by `launched_by` =
   L.session_id) and the new session runs in L's checkout: same worktree path (case-insensitive, slashes normalised),
   or same repo + branch. Then `supersedes = L.id`. The worktree-path test keeps a relay a relay even when L switched
   its checkout's branch after its own launch. A relay under another `--name` prints one line:
   `note: this launch replaces <L name> (gen N) as its relay`.
4. **A merge session** (`<group>-merge...`) with no known launcher: the target lane's newest open entry, so a merge
   session on `_merge-<group>` replaces the previous one, as today.
5. **Anything else** (a registry session launching onto another checkout's lane, a hand-opened session, a plain
   terminal): `supersedes = null`.

**The occupancy check** (rule-5 launches only). Two sessions must never share a worktree. When the target checkout
(same worktree path, or same repo + branch) has an open entry whose session really runs (its host is alive AND a claude
runs below it, or a background session `claude agents` lists as running), the launch is refused before any side
effect: `refused - <repo>@<branch> already has a running session <name> (gen N, id <id>): two sessions must not share a
worktree. Launch a helper with --worktree <own branch>, or replace that session explicitly with --supersedes <id>.
--force overrides (ask the user first).` Exit 3. Then:
- an occupant whose liveness is `unknown` only prints a warning;
- an occupant whose window host is empty (a dead start, or a claude that exited after its work; Part 3) is closed
  through the guarded no-claude path first, and the launch goes on. A host with anything else below it (claude, or a
  job the user runs there) counts as running;
- `--dry-run` prints the decision and refuses nothing.
Relays, resumes, restarts and merge sessions never reach this check.

**Environment scrub.** A process the coordinator starts must not look like it was launched by whichever session's hook
or command happened to start the coordinator. Every spawn of `launch.mjs` passes an environment without `HL_SESSION_ID`
and `CLAUDE_CODE_SESSION_ID`: the tick's restarts (`spawnLaunch`, `recover.mjs:188`), the merge-session launch
(`merge.mjs:311`) and `launch.mjs resume`'s relaunches (`launch.mjs:454`). `triggerTick` scrubs too, because the tick
can also run in-process (`watchdog --stop-looping`) or from a session's shell.

**The superseded relation.** Entry O is superseded by entry N when N was launched after O and O is in N's chain:
- **N has the `supersedes` key:** its chain is S = N.supersedes, plus S's chain when S also has the key. A legacy entry
  reached through a link ends the chain. Without that stop, the first relay after the deploy would pull in every older
  generation of a shared checkout and repeat the 2026-10-04 incident. Chains pass through closed entries.
- **N is a legacy line** (no key): its chain is every entry of the same repo + branch with a lower generation (today's
  rule, applied only when N itself is legacy).

**Who uses it:**
- The tick's close (`closeCase`/`supersededScan`): an open window O is a candidate when some open, `running` N
  supersedes it. Every other close condition (idle ≥ `idle_close_min`, no outstanding call, no background agents or
  tasks, no permission wait, host identity) is unchanged. The reason text stays `superseded by generation <N>`.
- The launch-time close (`closeOld`): the entries in the new launch's chain beyond its first link (its direct
  predecessor is busy launching it). A legacy launch keeps "generation ≤ N-2".
- **The restart guard is the union**, the conservative direction: the ladder (`supersede()`, `recover.mjs:221-240`) and
  `resumeLaunch`'s newest-entry check (`launch.mjs:485`) skip a restart while ANY open entry is newer on the same repo +
  branch OR has the entry in its chain (for example a relay on a switched branch). Restarting next to a successor would
  put two sessions in one checkout. When the newer entry is not a successor (a `--force`d co-tenant), the skip line says
  `killed, not restarted: an open newer launch <name> shares its checkout` and raises an alert, so the user decides.
- The session cap's predecessor exemption (`launch.mjs:210`) follows `supersedes`: only the entry a launch replaces is
  not counted (none when `supersedes` is null).
- `generation` is still numbered per repo + branch and shown everywhere. It no longer decides closes for new lines.

**What the docs rule becomes:** "Only a session's own relay, a resume, a coordinator restart, or a launch with
`--supersedes <its id>` replaces a session. A launch onto a checkout whose session is running is refused; helpers get
`--worktree <own branch>`."

## Part 2: the idle test sees background shell and Monitor tasks
**Problem.** `sessionState` calls a session idle when its last turn ended with a `turn_duration` record, no tool call is
outstanding, and `pendingBackgroundAgentCount` is absent. That count covers agents only. Verified on real transcripts
(Claude Code 2.1.289): a `turn_duration` with no pending count was written while a background shell task ran, and the
task's notification woke the session 10.5 minutes later. A close at that moment would have killed the running task.

**The rule** (pure, in `recover-lib.mjs`; fixtures copied from the real record shapes):
- **Start of task T:** a record whose `toolUseResult.backgroundTaskId` is T (a `run_in_background` Bash or PowerShell
  call), or whose `toolUseResult.taskId` is T together with `timeoutMs` (a Monitor).
- **End of task T**, any of:
  - a `<task-notification>` naming `<task-id>T</task-id>` with a `<status>` tag, found in a `queue-operation`
    `enqueue` record's `content`, an `attachment.queued_command.prompt`, or a user record's content;
  - a Monitor event for T whose `<event>` starts with `[Monitor expired`;
  - a `toolUseResult` with `task_id` T whose `message` starts with `Successfully stopped task` (TaskStop).
  Monitor events without `<status>` are not ends. `remove` queue records are ignored (they repeat the enqueue).
- **Scope:** the main transcript's tail (the existing 2 MB) plus the session's `subagents/agent-*.jsonl` files modified
  within the last `bg_task_max_min`. A subagent's task notifies in the MAIN file, so starts and ends are matched
  across files by task id.
- **Restart boundary:** a task that started before the registry entry's `launched_at` is ignored. It belonged to an
  earlier process (a resume keeps the old transcript), and that process's tasks died with it.
- **Safety valve:** a task with no end marker counts as running until `bg_task_max_min` (new config key, default
  240) after its start; a Monitor until its `timeoutMs` plus 5 minutes, if that is sooner. Counting too long only
  delays a close.
- **Cost:** the scan runs only when the session would otherwise be idle (turn done, nothing outstanding, no pending
  agents), and only where idleness is computed: the tick's closes, the launch-time close, `guardedClose`'s re-check and
  the new `launch.mjs sessions` view (`status` computes no idleness). So busy sessions and `status` pay nothing extra.

`sessionState` gains `bgTasks` (the open task ids). Idle requires none, and `busy` lists `N background task(s) running`.
Every reader of idleness gets it: the tick's closes, the launch-time close, `guardedClose`'s re-check and `launch.mjs
sessions`.

## Part 3: windows whose claude is gone (dead start, exited)
**Problem.** A window launch runs `claude` inside a `-NoExit` PowerShell host. When `claude` exits (at once: a bad flag,
a broken install, a crash; or later: `/exit`, a crash after work), the host stays alive and liveness reads `running`.
Nothing notices, the window counts toward the session cap, and today it is closed only if a newer generation of its
lane happens to launch.

**Detection** (the tick, window entries only):
- the host is the recorded one and is alive;
- the launch is at least `idle_close_min` old, and the transcript has had no record for at least `idle_close_min` (a
  working claude writes to it), or there is no transcript;
- the host is **empty**: no process below it at all except `conhost` (the probe returns the descendant list next to
  the existing claude flag of `hasClaudeBelow`). A dead start and a plain exit both leave an empty host. `null` (probe
  failed) means no action. Only entries that pass the first two tests are probed, so the tick probes few windows.

A session that waits on a first-run prompt (trust, MCP approval) or on the user has a claude process below its host, so
it is never flagged. After claude exits, the user may use the window as a shell (`python`, `git`, `npm test`, an
editor): any such process keeps the window open. A background task cannot outlive its claude, so nothing running is
lost.

**Two kinds:**
- **Dead start:** the transcript has no `assistant` record stamped at or after `launched_at` (no file at all counts too;
  a dead start leaves only metadata such as `mode`, `permission-mode`, hook attachments, `cost-state` or
  `bridge-session`). Something went wrong, so the user hears about it:
  - one alert per entry: `DEAD START: <name> (<branch>): its window is open but claude exited right after the launch at
    <time>. Read the error in that window, fix it, relaunch. The coordinator closes the window at <time + 60 min>.`
    The key is `deadstart|<id>`, repeated after `alert_repeat_hours` like the other alerts;
  - `status` shows `DEAD-START (since <time>)` on that lane;
  - if the entry is a coordinator restart, the tick also records `{restart_failed}` and `{lane_blocked}`, exactly like a
    restart that failed to launch, and the lane shows `LOOP-BLOCKED`. An entry is a coordinator restart when it is the
    first launch line of its name after a `{restart}` line of that name (`{restart}` names the killed entry in `from`,
    not the new one);
  - `dead_close_min` (new config key, default 60) after the alert, the tick closes the window. The user has an hour to
    read the error.
- **Exited:** the transcript has assistant records: claude did its work and exited. The window is closed at once,
  without an alert (`closed <name> (gen N): claude exited`), like any finished idle window (the user's standing OK to
  close finished sessions).

**The close** is the guarded path in its no-claude form: the recorded host with a start time within 2 s, and an empty
host, re-checked right before the kill. The transcript's turn state is not required (no claude is left to finish a
turn). Any launch onto that checkout, a `--resume`, or `launch.mjs resume` of that lane closes such a window first (the
occupancy check in Part 1), so a fix never waits for `dead_close_min`.

## Part 4: write fence
A `PreToolUse` hook (`coord.mjs fence`) on `Edit|Write|MultiEdit|NotebookEdit` in every launcher session, folded into the
profile's one `--settings` file next to the stage-2 hooks.

**Inputs:** the hook's stdin (`tool_input.file_path` or `notebook_path`, `cwd`, `session_id`) and `HL_SESSION_ID`.
The session's own entry is found once in the registry and cached in its hook state file (`sessions/<sid>.json`
`fence: {own, main}`), so later calls read only that small file.

**Terms.** "The main checkout" is the main root minus `<main>/.claude/worktrees/**`. A directory
`<main>/.claude/worktrees/<x>` is "owned" when an open registry entry's worktree is that directory. Claude Code's own
worktrees (an Agent with `isolation: "worktree"`, `EnterWorktree`) live there too and are owned by no entry.

**Own root:** the entry's worktree when it is under `<main>/.claude/worktrees/` or outside the main checkout;
otherwise the main checkout (a session launched on the main checkout, or on a subdirectory of it).

**Decision** for an absolute, normalised path P (relative paths resolve against `cwd`; a long-path `\\?\` prefix is stripped;
compare case-insensitively with forward slashes, like `key()`):
1. **Allow** when P is under the own root.
2. **Allow** when P is under `<config>` (`~/.claude`), the OS temp directory (the session scratchpad lives there),
   `<main>/.superpowers/**` (done markers, inbox, incidents: a lane must be able to finish), or an unowned
   `<main>/.claude/worktrees/<x>` (a subagent's own worktree).
3. **Deny** when P is under the main checkout (for a session whose own root is not the main checkout), or under the
   worktree of another open registry entry of the same repo, wherever that worktree lives.
4. **Allow** everything else (other repos, files outside any checkout). The fence protects this repo's lanes, not the disk.

Where lanes keep their files is unchanged by this: today's lanes write handoffs inside their own worktree
(`<worktree>/docs/.../handoffs/`) and controllers write them under `~/.claude/experiments/`; both are allowed. SKILL.md
says so explicitly: never write a handoff or ledger into the main checkout from a worktree.

**The denial** (`permissionDecision: "deny"`, one line in `permissionDecisionReason`):
`Write fence: <P> belongs to lane <name> (<branch>) [or: to the main checkout], not to this lane (<own root>). Do not
edit it from here. Queue the change: node <launch.mjs> queue --to <name> --text "<what to change>" [--after-merge], or
tell the user.` The owner is the open entry whose worktree is the longest prefix of P. For the main checkout it is that
checkout's open session, or, with none, the text says "the main checkout (no session): tell the user, or queue it
--after-merge in your group".

**Never in the way:**
- Any error, a missing `HL_SESSION_ID`, or an entry it cannot find means allow, with no output.
- Bash and PowerShell writes are not fenced (a known gap; the lane rules forbid them outside the worktree).
- A junction or symlink is not resolved (a known gap: the launcher creates no links).
- The check runs inside subagents too (their hooks carry the parent's environment).

## Part 5: lane note
A `UserPromptSubmit` hook (`coord.mjs lane-note`) in every launcher session. It adds `additionalContext` only on the
session's first prompt, and again whenever the set of live lanes in its repo changes (a hash kept in its hook state
file). Otherwise it prints nothing.

**Text** (about 60-100 tokens):
`Lane note: you are lane <name> (branch <b>, <own root>, priority <p>). Other live lanes in this repo: <name> (<branch>,
<scope>); ... A request meant for another lane: say it belongs to that lane and offer launch.mjs queue --to <lane>.
Work on files another live lane is changing: queue it with --after-merge.` With no other lane: `No other live lanes
in this repo.`

**Live lanes** come from `<config>/state/coord/lanes.json`, which the tick writes on every run: per repo, the newest open
entry of each lane whose liveness is `running` or `unknown`, with its registry id, name, branch, worktree, group, scope,
effective priority and checklist progress (Part 9). A tick limited to one repo (`--repo`) rewrites only that repo's key.
A hook never probes processes. If `lanes.json` is missing or older than 30 minutes, the hook falls back to the
registry's open entries, newest per lane, with no liveness filter.

The existing `laneNote` variable in `launch.mjs` (the done-marker text in the pointer prompt) is unrelated; the plan
renames it to avoid confusion.

## Part 6: inbox and queue
**Command:** `launch.mjs queue --to <lane> [--group <id>] [--repo <main repo>] (--text "<text>" | --text-file <file>)
[--after-merge] [--from <name>]`.
- The group defaults to the newest registry entry named `<lane>`. A lane in a group gets
  `<main>/.superpowers/sessions/<group>/inbox/<lane>.md`. A session without a group gets
  `<config>/state/coord/inbox/<name>.md`.
- `--after-merge` (group lanes only) appends to the group's `inbox/_after-merge.md` instead: work that must wait until
  the running lanes are merged.
- Each item is appended as a block: `## <ISO time> from <from>` plus the text. `--from` defaults to the calling
  session's registry name, else `user`.
- Output: `queued for <lane>: <path> (<n> items)`. An unknown lane exits 2.

**Delivery, never mid-task:**
- A fresh launch named `<lane>` (the lane's next stage, or a fresh restart) takes the inbox. It renames the file to
  `<lane>.<stamp>.taken.md` and adds to the prompt: ` Read your inbox first: <path> - items other lanes queued for you.`
  A `--resume` does not take it: a resumed session continues the same stage.
- The inbox sentence goes into the prompt only, never into `prompt_file` (a fresh restart reuses that file and would
  point at an old inbox). A rename that fails (the file is open) takes nothing and prints a warning; the next fresh
  launch tries again. When the spawn fails after the take, the file is renamed back. `--dry-run` never takes.
- `queue` appends with one `appendFileSync` per item, so concurrent queuers never interleave inside an item.
- The lane's conflict-merge session gets the inbox path (read-only) in its generated handoff.
- `status` shows `inbox=<n>` on a lane with items waiting.

**FINAL_READY (fixes T2f):** today it lists every lane's `next_after_merge` with no sign of whether that lane was
merged, so a blocked lane's follow-up stages look ready. The new text is:
- `next_after_merge=` lists merged lanes' items only;
- `held_next_after_merge={"<lane>":{"state":"<state>","items":[...]}}` lists the unmerged lanes' items, which wait
  until that lane is resumed and merged;
- `queued_after_merge=<n> (<path>)` and `unread_inbox=[<lane>:<n>,...]` are added when non-empty.

Lanes and controllers that parse `next_after_merge=` keep working (same key, same shape).

## Part 7: priority (stage 4)
- **At launch:** `priority` = `--priority high|normal|low`, else derived from the sizing: model `fable`, or effort
  `xhigh` or `max` → `high`; effort `high` → `normal`; `medium` or `low` → `low`. A legacy line without `priority` is
  derived the same way from its `model`/`effort`, and is `normal` if it has neither.
- **Changing it later:** `launch.mjs priority --name <lane> [--group <id>] --set high|normal|low` appends
  `{priority: <name>, group, value, at}`. A lane's effective priority is the latest of its newest launch line and any
  later `{priority}` line for that name. A relay re-derives priority from its own sizing unless it passes `--priority`.
  A restart is not a relay: the tick's restarts (resume and fresh) and `launch.mjs resume` pass `--priority
  <effective>`, so a hand-set priority survives them.
- **Used for** (one shared sort helper, priority first, then the existing order):
  - `status`: lanes listed high → normal → low, then launch order;
  - the rolling-merge queue: priority, then the done marker's `at` compared as a time (`Date.parse`; an unreadable `at`
    sorts last), then the name. This replaces T2a's string sort;
  - deferred restarts: the tick retries them high first, so a freed cap slot goes to the highest-priority lane;
  - `launch.mjs resume --group`: blocked lanes relaunch high first;
  - `lanes.json` carries it, for the lane note and for batch B (resume order, pacing).
- It never bypasses the session cap or the free-RAM floor.

## Part 8: browser tools
**Measured 2026-10-05** (sonnet, `claude -p`, Claude Code 2.1.289; a fake local site, test@example.com, log in, 3
steps, read the result, one screenshot):

| | Playwright MCP | claude-in-chrome |
|---|---|---|
| Result | success, 24 s, 10 tool calls, $0.15 | failed twice ("Tab N is not in Claude's tab group for this session", "No tab group exists for this session yet", then a timeout); $0.31 each |
| Largest tool results | screenshot 8.6k chars, snapshot 416 | tabs_context ~470 |
| Two sessions at once | both succeeded, separate profiles and browsers | not runnable (one session already failed) |
| Idle cost per session | cmd + npx node + cmd + cli node ≈ 204 MB working set before any browser | none in the session: one shared native host (5 MB) spawned by Brave |
| With the browser open | + system Chrome, 8 processes ≈ 546 MB | Brave's own tabs (not attributable) |
| Start | cold `npx @playwright/mcp@latest` took 74 s and the server failed to connect at the default timeout | instant |
| After the session exits | nothing left (Playwright's stdin-close watchdog closes its browser) | the session's tab group stays open unless it holds only empty tabs |

Facts from the docs and the installed package (@playwright/mcp 0.0.83):
- Claude Code starts stdio MCP servers at session start, never stops an idle one, and never restarts one that exits.
- Playwright already starts its browser on the first tool call. `--idle-timeout <ms>` closes the browser after that
  long without a call, and the next call relaunches it. Its default is "never" for a headed browser.
- Its default browser is the system `chrome.exe`, so it can only be told apart from the user's Chrome by its parent chain
  (the `@playwright/mcp` node) or its `--user-data-dir`.
- Its default profile is persistent, one per working-directory hash. Two servers in the same directory conflict unless
  they use `--isolated`.
- claude-in-chrome is one bridge shared by every session. The docs warn about named-pipe conflicts between sessions,
  and its tab group closes only on `/clear`, or on exit when it holds nothing but empty tabs.

**Design.** Both tools stay available in every launcher session. Neither runs anything heavy until it is used, and both
are shut down when the session is done with them.
1. **Playwright is the default live-testing tool**: it is reliable in parallel lanes, gives each session its own
   browser, and costs half the tokens of the failed claude-in-chrome runs. Every profile (`lean` included) gets the
   `playwright` server; `full` keeps the user's own configuration, as today.
2. **No npx, a pinned version.** The deploy installs `@playwright/mcp` at a pinned version into
   `<config>/mcp-servers/` (`npm install --prefix`). The server runs as `node <that>/node_modules/@playwright/mcp/cli.js`
   directly. That removes the 74-second cold start, the connect timeout it caused, and the npx node and cmd wrappers
   (~100 MB working set). An update is a documented one-liner (install the new pinned version); sessions launched after
   it use it.
3. **Not constantly active.** The browser (the heavy part: ~550 MB) starts only on the first browser call, and
   `--idle-timeout 900000` closes it after 15 minutes without a call; the next call relaunches it. What stays resident is
   the idle server: 101 MB working set, 65 MB private, measured. A lazy stub that starts even the server on first use
   was designed and measured but is NOT built: a bare node process already costs 55 MB / 18 MB private, so it would save
   ~47 MB private per session, for ~150 lines of protocol proxy whose failure would leave the tools dead for the whole
   session (Claude Code never restarts a stdio server). It stays a measured follow-up the user can ask for.
4. **Server arguments:** `--isolated` (an in-memory profile: no profile clash between sessions in one directory, nothing
   piles up on disk) and `--headless` (unattended lanes pop no windows onto the user's screen; screenshots still work),
   plus `--idle-timeout 900000`.
5. **Orphan reaper** (the tick, Windows). It uses the existing orphan rule (`recover-lib.mjs:355-363`: the direct parent is
   gone, or was created after the child), restricted to Playwright's signature:
   - a browser process (`chrome`, `chromium`, `msedge`) whose command line carries `--remote-debugging-pipe` and a
     Playwright `--user-data-dir` (a `playwright_*dev_profile-*` temp dir, or a dir under `ms-playwright-mcp`);
   - a `node` or `cmd` process whose command line names `@playwright/mcp`.
   Such an orphan is killed with its tree, and the kill is logged on the tick's output. Never by ancestor names: a
   browser of `npx playwright test`, a Python script or an IDE has the same flags, but its parent is alive, so it is
   never touched. The user's own Chrome and Brave carry neither flag. The existing report-only orphan scan stays as it
   is for everything else.
6. **claude-in-chrome stays enabled in every profile.** No profile may pass `--no-chrome` or set
   `claudeInChromeDefaultEnabled: false`; a test asserts it for every profile in `profiles.json`. The lane rules say:
   use it only when a real logged-in browser is needed (a site where the user is already signed in), and expect clashes
   when another session uses it at the same time.
7. **Closing claude-in-chrome tabs.** No program outside the extension can close its tabs, so this one is not zero
   tokens. The `post-tool` hook tracks the session's claude-in-chrome tab set in its hook state: every tab id in a
   `tabs_context_mcp` or `tabs_create_mcp` result (the measurement's stray tab came from `tabs_context_mcp` with
   `createIfEmpty`), minus the ids closed by `tabs_close_mcp`. At Stop, when the turn used claude-in-chrome and tabs of
   that set are still open, the Stop hook blocks once: `You left <n> claude-in-chrome tab(s) open: close them with
   tabs_close_mcp (only the ones this session opened).` That costs one line and one tool call, only in turns that leave
   tabs open.

**Verified in the plan's probes before building:** `node cli.js --isolated --headless` starts within the default MCP
connect timeout and serves the measured task; two such servers in one directory run at once; `--idle-timeout` closes
the browser and the next call relaunches it; the reaper's fixtures (the npx chain with a live parent: never killed;
with a gone parent: killed; a non-MCP Playwright browser with a live parent: never killed) match real process lists on
this machine; the shape of the `tabs_context_mcp` and `tabs_create_mcp` results carries the tab ids.

## Part 9: a checklist in every session
The user's words (2026-10-05, relayed by the coordinator): "In general and in the workflow there needs to be for every
session a checklist." and "It needs to mark it as it finishes tasks to ensure that it is staying on task and finishing
them." The global `CLAUDE.md` already says so (edited live by the coordinator; the deploy syncs the repo copy). Batch A
makes it checked and visible, at zero tokens unless something is missing.

**Where the checklist lives:** `GOAL.md` in the session scratchpad, as today (`<tmp>/claude/<project folder>/<session
id>/scratchpad/GOAL.md`, found by `goalOf()` in `live.mjs`). Subagents keep theirs in their reports and never write
GOAL.md (unchanged).

**Parsing** (pure, `recover-lib.mjs`): the goal is the first `# ` line; items are lines starting `- [x]`, `- [ ]`, `- [!]`;
a `[!]` line's text after `reason:` is its reason. "Last ticked" is GOAL.md's modification time.

**1. Explicit at launch.** The pointer prompt gains one sentence: ` Write or re-read GOAL.md in your session scratchpad
first (one goal line, then checkable items) and tick each item the moment it is done.` ("Re-read" covers a resumed
session and a fresh restart that got its GOAL.md copied with `--goal-from`.)

**2. Missing checklist** (one line, once per session):
- Launcher sessions: the `post-tool` hook counts main-thread tool calls (calls carrying an `agent_id` are a subagent's and
  are not counted). After `goal_missing_calls` (default 10) with no GOAL.md, it adds: `No GOAL.md yet: write <path> now
  (one goal line, then checkable items) and tick each item as it finishes, in the same message as your next tool call.` The scratchpad path is derived once from the
  hook input's `transcript_path` (as `goal-gate.mjs` does) and cached in the hook state; no directory scan per call.
- Hand-opened sessions: `goal-gate.mjs` at Stop blocks once per session with the same line when no GOAL.md exists and
  the session has made at least `goal_missing_calls` tool calls (counted from the transcript tail, which the Stop input
  names). Its guards:
  - the "once" marker lives in `<config>/goals/.nudged-<session id>` (the gate's own state file sits next to the
    missing GOAL.md, so it cannot hold it);
  - never when `stop_hook_active` is set, when the last message ends with `?`, or while `background_tasks` is non-empty
    (the gate's existing exemptions);
  - never in a one-shot run: a transcript with a single user prompt (a `claude -p` probe or measurement). An
    interactive session that does all its work in its first turn is therefore nudged only from its second turn, or
    never if it stays single-turn; accepted (if the hook input exposes a print-mode marker, the plan uses it instead);
  - it runs after the alert relay, and its block counts toward the gate's 3 continuations per user turn;
  - a short question-and-answer session (fewer calls) is never nudged.

**3. Stale checklist** (launcher sessions, one line per staleness window): the `post-tool` hook counts the session's work
calls: every Edit, MultiEdit, Write, NotebookEdit, Bash or PowerShell call, and every completed Agent call (the hook
cannot see `is_error` reliably, so it does not try to tell a success from a failure; the threshold below allows for
that). When GOAL.md has open items, has not been written for `goal_stale_min` (default 40), and at
least `goal_stale_changes` (default 5) changes happened since its last write, the hook adds: `GOAL.md has not changed
for <n> min while work went on: tick the finished items now, with evidence, in the same message as your next tool call (never as an extra round trip). If you drifted, return to the next
unticked item, or rewrite GOAL.md if the user changed direction.`
- Never a loop trigger: one line per window; a GOAL.md write re-arms it; the line is not a tool call, and rule (a) never
  counts it.
- Hand-opened sessions have no `post-tool` hook. For them the global rule and the existing goal gate apply; no staleness
  check (it would cost a forced continuation each time).

**4. Visible in one place:**
- `launch.mjs sessions [--repo <dir>]` (new) lists every open launcher session, all groups and lone sessions: name,
  lane (repo@branch), group, generation, liveness, turn state (busy / idle / waiting), priority, and the checklist:
  `goal 5/9 done, 1 blocked (reason: ...), last ticked 12 min ago` or `no GOAL.md`. It then lists hand-opened sessions
  that have a GOAL.md modified in the last 24 hours (project folder + short session id), leaving out every session id
  the registry knows (launcher sessions' scratchpads sit in the same tree). Read-only, zero tokens.
- `status --group` adds the same `goal=` note per lane, and `lanes.json` carries it.

## Smaller changes
- **`--resume <sid> --profile <names>`:** a resume may pick a new profile, which is recorded on the new entry. Without
  it, the entry's profile (`full` for an entry without one) is used, as today.
- **Stage-2 spec wording:** `:328-329` loses the separate "an incident and whose successor is running" case (now a case of
  the older-generation close), and `:413` reads "any older open generation". Docs only.
- **Unknown flags:** the launch path prints `warning: unknown flag --<x> (ignored)` on stderr instead of ignoring it
  silently, so a typo such as `--priorty` shows. It never refuses: other projects' lanes call the live launcher with
  whatever their handoffs say. The known set is every `opt("...")`/`flag("...")` literal in the code (`--reopen`
  included), and a test checks that the set and the code agree.
- **`resumeLaunch`** sets `launched_by`, `supersedes` and `priority` explicitly instead of inheriting them through
  `...prev`.

## Hooks, speed and failure
- The new hooks join `sessionHooks()`: `PreToolUse` (matcher `Edit|Write|MultiEdit|NotebookEdit`) → `coord.mjs fence`,
  `UserPromptSubmit` → `coord.mjs lane-note`, and `Stop` → `coord.mjs stop` (the claude-in-chrome tab check, Part 8).
  The existing `post-tool` hook also records claude-in-chrome tab ids and the checklist counters (Part 9). Every
  launcher session gets them in its one `--settings` file. Hand-opened sessions get only the global goal gate's
  missing-checklist line (Part 9).
- Both hooks only read small files: the hook state file, `lanes.json`, and the registry once per session (the fence's
  first call) or on a denial. Target: under 100 ms including node startup, measured in the plan's probes.
- Both fail open: any error exits 0 with no output.
- Running sessions keep their old `--settings` file until they relaunch, so they get the new hooks only after a relay or
  restart. The restart table says which sessions benefit.

## State and registry summary
- New launch-line fields: `launched_by`, `supersedes`, `scope`, `priority`.
- New registry lines: `{priority: <name>, group, value, at}`.
- `<config>/state/coord/`: `lanes.json` (the tick); `inbox/<name>.md` (sessions without a group); new config keys
  `bg_task_max_min` (240), `dead_close_min` (60), `goal_missing_calls` (10), `goal_stale_min` (40) and
  `goal_stale_changes` (5); new alert key `deadstart|<id>`; hook state gains `fence`, `lane_hash`, `chrome_tabs` and the
  checklist counters.
- `<main>/.superpowers/sessions/<group>/inbox/`: `<lane>.md`, `<lane>.<stamp>.taken.md`, `_after-merge.md`.
- `<config>/mcp-servers/` (the pinned `@playwright/mcp` install).
- `claude/CLAUDE.md` (the repo mirror) is synced with the live `~/.claude/CLAUDE.md`, which the coordinator edited on
  2026-10-05 (the every-session checklist rule, tick at once, and the "Kimi is retired" line).
- Old launchers ignore the new fields; the new code treats a line without `supersedes` as legacy.

## Commands (new or changed)
- `launch.mjs queue --to <lane> ... [--after-merge]`
- `launch.mjs priority --name <lane> --set high|normal|low`
- `launch.mjs sessions [--repo <dir>]` (every session's state and checklist, read-only)
- `--supersedes <id>` on a launch (replace that session explicitly)
- `launch.mjs ... --priority <p> --scope "<text>"` (launch); `--resume <sid> --profile <names>`
- `coord.mjs fence`, `coord.mjs lane-note`, `coord.mjs stop` (hooks only)

## Docs to rewrite
- `SKILL.md`: the usage line, the sizing table's priority note, §2's lane rule (the occupancy refusal, `--supersedes`)
  and registry fields, §4's lane rules (queue, inbox, FINAL_READY keys, where handoffs and ledgers may be written), §5's
  closes, lane rules (fence denial, lane note, checklist lines), the browser-tools rule (Part 8: Playwright first,
  headless; claude-in-chrome for logged-in sites), and `launch.mjs sessions`.
- `coordinator.md`: Files, the session hook, "Closes by the tick" (`:59-65` says launch lines record no
  `launched_by`/`supersedes`), idle, Launch details, Alerts (dead start), the test hooks.
- The `launch.mjs` header comment, the stage-2 spec lines above, and `profiles.json`'s note.

## Testing
- **Live headless probes, run first in the plan.** The design changes if one fails:
  1. a `PreToolUse` deny with `permissionDecision` blocks an Edit in `claude -p`, and the reason reaches the model;
  2. `UserPromptSubmit` `additionalContext` from a `--settings` file reaches the model in `claude -p`;
  3. `CLAUDE_CODE_SESSION_ID` is in a Bash tool call's environment (verified 2026-10-05 in this session) and in the
     environment `launch.mjs` sees when a session runs it;
  4. a background `sleep` in `claude -p` produces the start, notification and TaskStop records Part 2 matches;
  5. a window launch whose `claude` exits at once leaves the host alive with no claude below (the dead-start signature);
  6. the fence hook's latency (node start + decision) on this machine;
  7. the browser-tool checks listed at the end of Part 8.
- **Units** for the pure functions: the `supersedes` choice and chain, including a mixed legacy/new chain at the deploy
  boundary; the chain-based restart guard; the occupancy decision (running, unknown, dead start); the background-task
  scan (fixtures from real shapes); the dead-start decision and the restart match; the fence decision (case, slashes,
  a `\\?\` prefix, nested worktrees, an unowned agent worktree, the main checkout, `.superpowers`, temp, config, other repos);
  the occupancy decision for an exited-claude occupant and for a host with a user's job below it (kept); the Part 3 restart match when a later `launch.mjs resume` line
  exists; the reaper (the npx chain with a live parent: kept; with a gone parent: killed; a non-MCP Playwright browser with a live
  parent: kept; the user's Chrome: kept); the claude-in-chrome tab set from `tabs_context_mcp`/`tabs_create_mcp`/
  `tabs_close_mcp`; the lane-note hash; the inbox render and take; FINAL_READY tagging; priority derivation, its survival
  across restarts and the shared sort; the checklist parse, missing and stale decisions; the flag set against the code.
- **Hook tests** with fake stdin for `fence` and `lane-note` (deny JSON shape, fail-open on garbage).
- **End-to-end in the sandbox:** a relay supersedes its launcher; a foreign launch onto a running occupant is refused
  and closes nothing, and `--supersedes <id>` replaces it; a merge session launched with the scrubbed environment
  replaces the previous one; an idle window with an open background task is not closed; a dead start alerts, blocks a
  restart lane, is closed first by `launch.mjs resume`, and otherwise closes after `dead_close_min`; queue → fresh launch
  takes the inbox; the merge queue and `status` follow priority; `launch.mjs sessions` shows the checklists.
- **The isolation test from stage 2** is extended: a second lane's files, registry lines and processes are unchanged
  when the first lane is fenced, queued to, or closed.
- All tests use the stage-2 sandbox (`HL_REGISTRY_DIR`, `HL_AGENTS_JSON=<file with []>`, `HL_PROJECTS_DIR`, a temp
  `CLAUDE_CONFIG_DIR`, `HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`) and `test@example.com`.

## Deploy notes
- The dry-run gate applies: batch A changes which windows the tick closes, adds closes (windows whose claude is gone: dead starts and exited sessions) and new denials.
  The dry run lists every close the new tick would make against the live registry, plus the lane table.
- Before the code: install the pinned `@playwright/mcp` into `<config>/mcp-servers/`.
- Deploy order: `recover-lib.mjs`, `live.mjs`, `recover.mjs` → `merge-lib.mjs` + `merge.mjs` + `launch.mjs` in one step
  (their APIs change together) → `hooks/coord.mjs` → `profiles.json`, docs, tests → anything that enables a hook last.
- The restart table to `coordinator` lists which running sessions gain the fence and lane note by relaunching, and
  that old sessions must not write the new line types by hand.

## Token accounting
| Piece | Tokens |
|---|---|
| Provenance, chain closes, background-task scan, dead-start check, fence decision, priority, lanes.json | 0 (code) |
| Lane note | ~60-100 per session on its first prompt, and again only when the live-lane set changes |
| Fence denial | one line, only when it fires |
| Dead-start alert | one relayed alert per dead window |
| Inbox | read once by the next stage, only when items exist |
| Playwright idle close, orphan reaper | 0 (code) |
| claude-in-chrome tab check | one line and one tool call, only in a turn that leaves its own tabs open |
| Checklist: missing / stale line (launcher sessions) | one line, only when GOAL.md is missing (once per session) or stale (once per window) |
| Checklist: missing (hand-opened sessions) | one forced continuation, once per session, only with 10+ tool calls and no GOAL.md |
| `launch.mjs sessions` | 0 (code; read by the user) |

## Large-org variant
A central lane registry service with per-lane credentials: writes outside a lane's sandbox are refused by the
filesystem (per-lane OS users or containers), not by a hook, and lane priority comes from a scheduler with quotas.

## Out of scope
Fencing Bash writes; resolving junctions and symlinks in the fence; cross-repo fences; pausing, broadcasting and
pacing (batch B); the standalone master app.

