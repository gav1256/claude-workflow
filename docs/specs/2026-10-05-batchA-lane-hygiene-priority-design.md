# Batch A: lane hygiene (stage 3) and priority ordering (stage 4): design

Status: draft for the Fable spec review (2026-10-05). It details stages 3 and 4 of
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
- **Notifications** are muted on the user's machine and are lower priority: the desktop balloon stays best effort, and
  the phone relay is the real alert channel. Nothing in batch A depends on the balloon.
- **Earlier decisions that still apply:** rule (d) keeps `stuck_min` (S1); auto recovery for groups launched after
  stage 2; the older-generation close applies in every group; the standalone master app stays "later".

## Carry items and their disposition
| Item | Source | Disposition |
|---|---|---|
| `launched_by` / `supersedes` on launch lines | stage-2 ledger | Part 1 |
| Dead-restart alert | stage-2 ledger | Part 3 (any window launch, not only restarts) |
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
2. `--supersedes <id>` (internal, never typed by hand): the tick's fresh restart passes the killed entry; `launch.mjs
   resume` passes the blocked lane's newest entry.
3. **A relay.** The launcher is a registry session L (found by `HL_SESSION_ID` = L.id, else by `launched_by` =
   L.session_id) and the new session runs in L's checkout: same worktree path (case-insensitive, slashes normalised),
   or same repo + branch. Then `supersedes = L.id`. The worktree-path test keeps a relay a relay even when L switched
   its checkout's branch after its own launch.
4. **A known session launching onto someone else's lane** (a registry session in another checkout, or a hand-opened
   session): `supersedes = null`. If the target lane has an open entry that is running, the launch prints one warning
   line: `warning: lane <repo>@<branch> already has an open session <name> (gen N); this launch does not replace it,
   so both share the worktree - launch helpers with --worktree <own branch>`. It never refuses (a refusal could block
   a merge session or a restart in an edge case).
5. **No known launcher** (`launched_by` is null: a plain terminal, or a coordinator spawn with the scrubbed environment
   below): the target lane's newest open entry, if any. This is today's behaviour, so merge sessions on
   `_merge-<group>` keep replacing the previous one.

**Environment scrub.** Processes that the coordinator starts must not look like they were launched by the session
whose hook happened to trigger them. These spawns pass an environment without `HL_SESSION_ID` and
`CLAUDE_CODE_SESSION_ID`: `triggerTick` (so the tick and every restart it starts are anonymous), `merge.mjs`'s merge-session
launch, and `launch.mjs resume`'s relaunches.

**The superseded relation.** Entry O is superseded by entry N when N is newer (`launched_at` later) and O is in N's
chain:
- a line with the `supersedes` key: its chain is `supersedes` plus that entry's chain (closed entries included, so a
  chain passes through a closed duplicate);
- a legacy line (no key): its chain is every entry of the same repo + branch with a lower generation (today's rule).

**Who uses it:**
- The tick's close (`closeCase`/`supersededScan`): an open window O is a candidate when some open N that is
  `running` supersedes it. Every other close condition (idle ≥ `idle_close_min`, no outstanding call, no background
  agents or tasks, no permission wait, host identity) is unchanged. The reason text stays `superseded by generation <N>`.
- The launch-time close (`closeOld`): the entries in the new launch's chain beyond its first link (its direct
  predecessor is busy launching it). A legacy launch keeps "generation ≤ N-2".
- **Restarts stay conservative:** the ladder still skips a restart while ANY newer open launch exists on the lane
  (`supersede()` keeps the generation test). Restarting next to a duplicate would make a third session.
- `generation` is still numbered per repo + branch and shown everywhere. It no longer decides closes for new lines.

**What the docs rule becomes:** "Only a session's own relay, a resume or a coordinator restart replaces it. A helper
launched onto an occupied checkout never closes its occupant (the launch warns); helpers still get
`--worktree <own branch>`, because two sessions must not share a worktree."

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
  agents). So busy sessions pay nothing extra.

`sessionState` gains `bgTasks` (the open task ids). Idle requires none, and `busy` lists `N background task(s) running`.
Every reader of idleness gets it: the tick's closes, the launch-time close, `guardedClose`'s re-check, and `status`.

## Part 3: dead-start alert
**Problem.** A window launch runs `claude` inside a `-NoExit` PowerShell host. When `claude` exits at once (a bad flag,
a broken install, a crash), the host stays alive, liveness reads `running`, and nothing notices. The window also counts
toward the session cap.

**Detection** (the tick, window entries only):
- the host is the recorded one and is alive;
- the launch is at least `idle_close_min` old;
- the transcript has no `assistant` record stamped at or after `launched_at` (no file at all counts too; a dead start
  leaves only metadata such as `mode`, `permission-mode`, hook attachments, `cost-state` or `bridge-session`);
- `hasClaudeBelow(host)` is `false`. `null` (probe failed) means no action.

A session that waits on a first-run prompt (trust, MCP approval) has a claude process below its host, so it is never
flagged.

**Action:**
- One alert per entry: `DEAD START: <name> (<branch>): its window is open but claude exited right after the launch at
  <time>. Read the error in that window, fix it, relaunch. The coordinator closes the window at <time + 60 min>.`
  The key is `deadstart|<id>`, repeated after `alert_repeat_hours` like the other alerts.
- `status` shows `DEAD-START (since <time>)` on that lane.
- If the entry is a coordinator restart (a `{restart}` line names it), the tick also records `{restart_failed}` and
  `{lane_blocked}`, exactly like a restart that failed to launch. The lane then shows `LOOP-BLOCKED`, and
  `launch.mjs resume` relaunches it after the fix.
- 60 minutes after the alert (`dead_close_min`, new config key, default 60), the tick closes the window through the
  guarded path (recorded host, start time within 2 s, still no claude below). This frees the cap slot. The user has an
  hour to read the error.

## Part 4: write fence
A `PreToolUse` hook (`coord.mjs fence`) on `Edit|Write|MultiEdit|NotebookEdit` in every launcher session, folded into the
profile's one `--settings` file next to the stage-2 hooks.

**Inputs:** the hook's stdin (`tool_input.file_path` or `notebook_path`, `cwd`, `session_id`) and `HL_SESSION_ID`.
The session's own entry is found once in the registry and cached in its hook state file (`sessions/<sid>.json`
`fence: {own, main}`), so later calls read only that small file.

**Own root:** the entry's worktree when it is under `<main>/.claude/worktrees/` or outside the main checkout;
otherwise the main checkout itself (a session launched on the main checkout, or on a subdirectory of it).

**Decision** for an absolute, normalised path P (relative paths resolve against `cwd`; compare case-insensitively with
forward slashes, like `key()`):
1. **Allow** when P is under the own root. For a main-checkout session the own root excludes `<main>/.claude/worktrees/**`.
2. **Allow** when P is under `<config>` (`~/.claude`), the OS temp directory (the session scratchpad lives there), or
   `<main>/.superpowers/**` (done markers, inbox, incidents: a lane must be able to finish).
3. **Deny** when P is under the main checkout, or under the worktree of another open registry entry of the same repo.
4. **Allow** everything else (other repos, files outside any checkout). The fence protects this repo's lanes, not the disk.

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
entry of each lane whose liveness is `running` or `unknown`, with name, branch, worktree, group, scope and effective
priority. A hook never probes processes. If `lanes.json` is missing or older than 30 minutes, the hook falls back to the
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
  `<lane>.<stamp>.taken.md` and adds to the pointer prompt: ` Read your inbox first: <path> - items other lanes queued
  for you.` A `--resume` does not take it: a resumed session continues the same stage.
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
   `<config>/mcp-servers/` (`npm install --prefix`). The server runs as `node <that>/cli.js` directly. That removes the
   74-second cold start, the timeout it caused, and the npx node and cmd wrappers (~100 MB). An update is a documented
   one-liner: install the new version, then the next session refreshes the cached tool list (item 3).
3. **A lazy stub** (`claude/skills/handoff-launch/mcp-lazy.mjs`, ~150 lines, generic). It is the configured server
   command, so no Playwright process runs until the first browser call:
   - it answers `initialize` and `tools/list` from a cached copy of the real server's answers (`<registry
     dir>/profiles/mcp-cache/<name>-<hash of the command>.json`). With no cache yet, it starts the real server once to
     fill it;
   - on the first `tools/call` it starts the real server with the session's working directory, replays `initialize`
     and `notifications/initialized` under its own request id (and drops that one reply), then pipes lines both ways
     unchanged. Server-to-client requests such as `roots/list` and `notifications/tools/list_changed` pass through;
   - when the real server's tool list differs from the cache, it rewrites the cache and sends
     `notifications/tools/list_changed`;
   - after `idle_min` (default 30) with no call, it stops the real server (its stdin-close watchdog closes the
     browser), and the next call starts it again. A crashed real server is restarted on the next call too, which today
     leaves the tools dead for the rest of the session;
   - it never exits on its own while its stdin is open (Claude Code would not restart it).
4. **Server arguments:** `--isolated` (in-memory profile: no profile clash between sessions, nothing piles up on disk)
   and `--headless` (unattended lanes pop no windows onto the user's screen; screenshots still work), plus
   `--idle-timeout 900000` (the browser closes after 15 minutes without a call; the stub's 30-minute stop then ends the
   server too).
5. **Orphan reaper** (the tick, Windows): a browser process whose command line carries Playwright's `--user-data-dir`
   (a `playwright_chromiumdev_profile-*` temp dir or a dir under `ms-playwright-mcp`) and `--remote-debugging-pipe`,
   and whose parent chain has no live `@playwright/mcp` node, is killed with its tree. A `@playwright/mcp` or
   `mcp-lazy` node whose parent chain has no live `claude` is killed too. Nothing else is ever touched: the user's own
   Chrome and Brave have neither flag and descend from Explorer. The kill is logged on the tick's output; the existing
   report-only orphan scan stays as it is for everything else.
6. **claude-in-chrome stays enabled in every profile.** No profile may pass `--no-chrome` or set
   `claudeInChromeDefaultEnabled: false`; a test asserts it for every profile in `profiles.json`. The lane rules say:
   use it only when a real logged-in browser is needed (a site where the user is already signed in), and expect clashes
   when another session uses it at the same time.
7. **Closing claude-in-chrome tabs.** No program outside the extension can close its tabs, so this one is not zero
   tokens. The session hook tracks the tabs a session creates through claude-in-chrome (tab ids from
   `tabs_create_mcp` results, minus `tabs_close_mcp` calls) in its hook state. At Stop, when the turn used
   claude-in-chrome and left tabs it created open, the Stop hook blocks once: "You opened <n> claude-in-chrome tab(s)
   this turn and left them open: close them with tabs_close_mcp (only yours)". That costs one line and one tool call,
   only in turns that leave tabs open.

**Verified in the plan's probes before building:** the stub works in `claude -p` (tools listed, ToolSearch loads them,
the first call starts the server, an idle stop followed by a call restarts it); two `--isolated --headless` servers in
the same directory run at once; the reaper identifies a Playwright browser on this machine and nothing else; a
`tabs_create_mcp` result carries the tab id.

## Smaller changes
- **`--resume <sid> --profile <names>`:** a resume may pick a new profile, which is recorded on the new entry. Without
  it, the entry's profile (`full` for an entry without one) is used, as today.
- **Stage-2 spec wording:** `:328-329` loses the separate "an incident and whose successor is running" case (now a case of
  the older-generation close), and `:413` reads "any older open generation". Docs only.
- **Unknown flags:** the launch path rejects an unknown `--flag` (exit 2) instead of ignoring it, so a typo such as
  `--priorty` is never silent. Every flag in the usage text is accepted.

## Hooks, speed and failure
- The new hooks join `sessionHooks()`: `PreToolUse` (matcher `Edit|Write|MultiEdit|NotebookEdit`) → `coord.mjs fence`,
  `UserPromptSubmit` → `coord.mjs lane-note`, and `Stop` → `coord.mjs stop` (the claude-in-chrome tab check, Part 8). The
  existing `post-tool` hook also records claude-in-chrome tab ids. Every launcher session gets them in its one `--settings` file. Hand-opened
  sessions get nothing and pay nothing.
- Both hooks only read small files: the hook state file, `lanes.json`, and the registry once per session (the fence's
  first call) or on a denial. Target: under 100 ms including node startup, measured in the plan's probes.
- Both fail open: any error exits 0 with no output.
- Running sessions keep their old `--settings` file until they relaunch, so they get the new hooks only after a relay or
  restart. The restart table says which sessions benefit.

## State and registry summary
- New launch-line fields: `launched_by`, `supersedes`, `scope`, `priority`.
- New registry lines: `{priority: <name>, group, value, at}`.
- `<config>/state/coord/`: `lanes.json` (the tick); `inbox/<name>.md` (sessions without a group); new config keys
  `bg_task_max_min` (240) and `dead_close_min` (60); new alert key `deadstart|<id>`; hook state gains `fence` and
  `lane_hash`.
- `<main>/.superpowers/sessions/<group>/inbox/`: `<lane>.md`, `<lane>.<stamp>.taken.md`, `_after-merge.md`.
- `<config>/mcp-servers/` (the pinned `@playwright/mcp` install) and `<registry dir>/profiles/mcp-cache/` (the stub's
  cached answers); hook state gains `chrome_tabs`.
- Old launchers ignore the new fields; the new code treats a line without `supersedes` as legacy.

## Commands (new or changed)
- `launch.mjs queue --to <lane> ... [--after-merge]`
- `launch.mjs priority --name <lane> --set high|normal|low`
- `launch.mjs ... --priority <p> --scope "<text>"` (launch); `--resume <sid> --profile <names>`
- `coord.mjs fence`, `coord.mjs lane-note`, `coord.mjs stop` (hooks only)
- `node mcp-lazy.mjs --name <n> [--idle-min <m>] -- <real server command>` (the configured MCP command, never typed by
  hand)

## Docs to rewrite
- `SKILL.md`: the usage line, the sizing table's priority note, §2's lane rule and registry fields, §4's lane rules
  (queue, inbox, FINAL_READY keys), §5's closes, lane rules (fence denial, lane note), and the browser-tools rule
  (Part 8).
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
- **Units** for the pure functions: the `supersedes` choice and chain, the background-task scan (fixtures from real
  shapes), the dead-start decision, the fence decision (case, slashes, nested worktrees, the main checkout, `.superpowers`,
  temp, config, other repos), the lane-note hash, the inbox render and take, FINAL_READY tagging, priority derivation and
  the shared sort.
- **Hook tests** with fake stdin for `fence` and `lane-note` (deny JSON shape, fail-open on garbage).
- **End-to-end in the sandbox:** a relay supersedes its launcher; a foreign launch onto an occupied lane warns and closes
  nothing; a merge session launched with the scrubbed environment replaces the previous one; an idle window with an
  open background task is not closed; a dead start alerts, blocks a restart lane and closes after `dead_close_min`;
  queue → fresh launch takes the inbox; the merge queue and `status` follow priority.
- **The isolation test from stage 2** is extended: a second lane's files, registry lines and processes are unchanged
  when the first lane is fenced, queued to, or closed.
- All tests use the stage-2 sandbox (`HL_REGISTRY_DIR`, `HL_AGENTS_JSON=<file with []>`, `HL_PROJECTS_DIR`, a temp
  `CLAUDE_CONFIG_DIR`, `HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`) and `test@example.com`.

## Deploy notes
- The dry-run gate applies: batch A changes which windows the tick closes, adds a close (dead start) and new denials.
  The dry run lists every close the new tick would make against the live registry, plus the lane table.
- Before the code: install the pinned `@playwright/mcp` into `<config>/mcp-servers/` and fill the stub's cache once.
- Deploy order: `mcp-lazy.mjs`, `recover-lib.mjs`, `live.mjs`, `recover.mjs` → `merge-lib.mjs` + `merge.mjs` + `launch.mjs` in one step
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
| Playwright stub, idle stop, orphan reaper | 0 (code) |
| claude-in-chrome tab check | one line and one tool call, only in a turn that leaves its own tabs open |

## Large-org variant
A central lane registry service with per-lane credentials: writes outside a lane's sandbox are refused by the
filesystem (per-lane OS users or containers), not by a hook, and lane priority comes from a scheduler with quotas.

## Out of scope
Fencing Bash writes; resolving junctions and symlinks in the fence; cross-repo fences; pausing, broadcasting and
pacing (batch B); the standalone master app.

