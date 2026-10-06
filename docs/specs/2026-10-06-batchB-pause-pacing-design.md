# Batch B: usage pacing (5-hour + weekly), one pause protocol, broadcast, power-aware pause

Date: 2026-10-06. Status: Fable-approved (review + scoped re-review, 2026-10-06); awaiting the user's one approval.
Parent spec: `docs/specs/2026-10-02-parallel-sessions-design.md` (stage 5-7 outlines). This spec supersedes those
outlines where they differ; every difference is listed in "Differences from the outlines".
Builds on batch A (`docs/specs/2026-10-05-batchA-lane-hygiene-priority-design.md`), which is live.

## Why, and the order

The weekly Claude limit was hit on 2026-10-05 with 4-5 parallel sessions. Pacing against the 5-hour AND the weekly
window is the most valuable part, and Codex routing (the codex-dual lane, deadline ~2026-10-09) reads its output.
So the batch ships in three releases, each useful on its own:

| Release | Contents | Depends on |
|---|---|---|
| B1 | Stage 7 core: usage recorder (status line), pacer, `pace.json`, `slow` enforcement (Agent hook), weekly pacing | nothing new |
| B2 | Stage 6: the one pause protocol (sources, Stop, close, manifest, resume, watcher), `/broadcast`; then stage 7's `hold`/`exhausted` on top of it | B1 |
| B3 | Stage 5: power probe as one more pause source | B2 |

Requirements carried from the user:
- **Provider-pluggable.** The usage files and `pace.json` are per provider; the pacer has no Claude-specific code. The
  Claude adapter is the status-line recorder plus the Agent hook. The Codex adapter (owned by codex-dual) writes
  `usage/codex-<run-id>.json` and reads `pace.json`. Never break the local Claude setup.
  The adapter seam, for hooks and launcher too: a provider's runner writes `usage/<provider>-<run>.json`, reads
  `pace.json[<provider>]` for its own routing, and honours a pause by reading the pause sources (`<coord>/pause/*.json`,
  the old `pause.json`, and Claude's pace state in `pace.json`) before it starts work. The Claude side's adapters are the
  status-line recorder, the Agent gate and the lane Stop hook; `launch.mjs` launches Claude sessions only, and another
  provider's runner launches its own work through the same files.
- **Zero tokens to track.** Only a state change costs one notice line per affected session.
- **Small-company design.** Large-org variant noted where it applies.

## Contract with codex-dual (agreed 2026-10-06; binding)

- Readings: `~/.claude/state/coord/usage/<session_id>.json` (Claude) and `usage/codex-<run-id>.json` (Codex), each
  `{ts, provider, pct, resets_at, week_pct, week_resets_at}`:
  - `ts` = epoch ms of the reading (Codex: the rollout event's time, not the write time);
  - `provider` absent = `"claude"`;
  - `pct`/`week_pct` numeric 0-100, or `null` for a missing window; `resets_at`/`week_resets_at` epoch seconds or
    `null`. Codex on Pro Lite is weekly-only (`pct` and `resets_at` null).
  - Codex keeps its newest 20 files. Claude files older than 8 days are pruned by the tick's hourly housekeeping.
- Output: `~/.claude/state/coord/pace.json` = `{updated, <provider>: {state, pct, ahead, resets_at, week_pct,
  week_ahead, week_resets_at, since}}`, written atomically (`writeAtomic`). `state` is one of `ok | slow | hold |
  exhausted`. A reader treats a `pace.json` older than 15 min as absent (default routing). `week_ahead`, `since`
  (when the state was entered) and `windows: {five_hour: {state}, weekly: {state}}` (per-window state, for hysteresis)
  are additive fields; readers that do not know them ignore them. `updated` is a reserved top-level key, not a
  provider: a reader iterating providers skips any key whose value is not an object with a `state`.
- Codex's own entry (user decision, 2026-10-06): the pacer writes `pace.json["codex"]` like any provider (a weekly-only
  Codex gets the weekly bands, `ahead` null). codex-dual's router reads it: when Codex is `exhausted` (or quota-blocked),
  work routes back to Claude silently, and Codex routing resumes after its reset - no user-visible stop. Nothing on the
  Claude side blocks on the `codex` entry: the Agent gate and the pace pause source read only `claude`.

## Part 1 (B1): the usage recorder

- `coord.mjs statusline` becomes the global `statusLine` command (`settings.fragment.json`; the user has none today, so
  nothing is chained; if one exists at install time, the installer keeps its command in
  `<coord>/statusline-chain.json` `{command}` - not as a `statusLine.chain` key, which Claude Code's settings validation
  may reject - and the recorder runs it with the same stdin and prints its output first).
- On each run it reads stdin (documented fields: `session_id`, `rate_limits.five_hour.{used_percentage,resets_at}`,
  `rate_limits.seven_day.{used_percentage,resets_at}`), and:
  1. If `rate_limits` is absent (not Pro/Max, or before the first API response): print the short line without usage
     and write nothing.
  2. Otherwise write `usage/<session_id>.json` atomically with `ts = now`, `provider: "claude"`, a missing window as
     `null`. Writing is skipped when the values equal the file's and its `ts` is under 60 s old (cheap; avoids
     churn under the 300 ms debounce).
  3. If `pace.json` is older than 30 s, recompute it (Part 2) and write it. Two sessions may do this at once; both
     compute from the same files and the last atomic rename wins, which is harmless.
  4. Print one line in the user's layout (2026-10-06): `◆ Opus 5.5 · 1M │ effort medium │ ctx ▰▰▰▱▱▱▱▱▱▱ 26% │ 5h 6% │
     wk 31% │ pace slow +12 │ ◇ 0 agents`, from the documented stdin fields (code.claude.com/docs/en/statusline):
     `model.display_name` and the window size `context_window.context_window_size` (`1M`/`200k`); `effort.level`, else
     the settings' `effortLevel`; `context_window.used_percentage` (else Part 8's tokens / the window size) as a
     10-segment bar (▰ filled, ▱ empty); `5h`/`wk` from `rate_limits`; `pace <state> +<ahead>` only when the state is
     not `ok`; `◇ N agents` from a `tasks` array only if the stdin has one. A subscription segment would come first, but
     no plan or auth field is documented, so it is never shown (never guessed). A missing field drops its segment, never
     an error; past ~110 characters the `pace`, then the `wk` segment is dropped. Output never enters the model's
     context. (The sessions-pane mod keeps its own separate `$.ui.status` segment.)
- No `refreshInterval`. Every run then follows a real event (mostly an assistant message), so `ts = now` is close to
  the reading's real age. A timer would re-stamp old values as fresh.
- The status line does not run in subagents or (assumed, undocumented) in `-p`/background sessions. Readings come
  from any interactive session; the limit is account-wide, so one fresh session is enough.
- Fail-safe: any error prints the plain line (or nothing) and exits 0. A hook timeout never blocks the UI.

## Part 2 (B1, `hold`/`exhausted` actions in B2): the pacer

A pure function in a new `pace-lib.mjs`:
`paceState({readings, prev, now, cfg}) -> {<provider>: {state, pct, ahead, resets_at, week_pct, week_ahead,
week_resets_at, since}}`. It is called by the recorder (step 3), by the tick, and by `coord.mjs pace` (prints the
table; `--json`). No I/O inside; the callers read the files and write `pace.json`.

**Reading selection, per provider.**
- 5-hour: the newest reading whose `resets_at` is in the future. It counts as fresh when `ts` < 10 min old.
- Weekly: the newest reading whose `week_resets_at` is in the future. It counts as fresh when `ts` < 6 h old (the
  weekly figure moves slowly; this keeps Codex's weekly state alive between runs). Additive to the contract.
- **Entering** `slow`/`hold` needs a fresh reading. **Leaving** any non-`ok` state (`slow`, `hold`, `exhausted`) uses
  the newest reading of the same window even when stale: while lanes are paused nothing spends, so no fresh reading
  arrives, and "no reading → ok" would resume everything at once and flap. The stale value bounds only what the
  **lanes** spent; claude.ai chat or hand-opened sessions may have spent more meanwhile. The pace line moves on with
  time, so the state eases by itself, and a resume left on a stale reading is a **probe resume** (Part 4): one lane
  first, the rest only after a fresh reading confirms.
- A state's window passing its reset ends that window's state (it restarts from `ok` on the next reading).
- No reading at all for a window (or the window is past its reset): that window is `ok` (fail open).

**The pace lines.** `target` = `pace_target` (95).
- 5-hour: `elapsed = 300 − (resets_at − now)/60` min; `allowed = max(pace_floor, target × elapsed / 300)` with
  `pace_floor` = 10 (spares the first-minutes burst of a window); `ahead = pct − allowed`.
- Weekly: `elapsedW = 10080 − (week_resets_at − now)/60` min; `allowedW = target × min(1, (elapsedW + grace)/10080)`
  with `grace` = `week_grace_min` (720: half a day of head start, so a normal first day is not throttled);
  `week_ahead = week_pct − allowedW`. `elapsedW` and the 10080 are measured by one function, `workingMinutes(from, to,
  off)` (plain minutes while `off` is empty), the seam for counting working time only: the Shabbat/Yom Tov follow-up
  (`docs/plans/2026-10-07-shabbat-followup.md`, last priority) passes its off-time table there.

**Bands (hysteresis; all thresholds in `<coord>/config.json` under `pace`).**

| Window | State | Enter when | Leave when |
|---|---|---|---|
| 5-hour | slow | ahead > 10 | ahead < 5 |
| 5-hour | hold | ahead > 20 | ahead < 15 |
| 5-hour | exhausted | pct ≥ 95 | the window resets |
| weekly | slow | week_ahead > 5, or week_pct ≥ 90 | week_ahead < 2 and week_pct < 90 |
| weekly | hold | week_ahead > 10 | week_ahead < 7 |
| weekly | exhausted | week_pct ≥ 97 | the weekly window resets |

- Each window keeps its own state, computed from `prev.windows` (the previous `pace.json`'s per-window states; a
  missing `windows` = `ok`) for hysteresis, never from the merged state. The provider's
  `state` = the more severe of the two (`ok < slow < hold < exhausted`). `since` changes only when `state` changes.
- A weekly-only provider gets only the weekly bands; its `ahead` is `null`.
- `autoContinueAtUsageLimit` stays on as the backstop.

## Part 3 (B1): `slow` enforcement and notices

A new **global** PreToolUse hook on `Agent` (`coord.mjs agent-gate`, matcher `^(Agent|Task)$`: anchored, so never
`TaskUpdate` or another `Task*` tool), added to `settings.fragment.json` and the live
settings. Unlike the per-launch hooks it must work in hand-opened sessions, so it does not return early without
`HL_SESSION_ID`.
- It reads only `pace.json` (and, from B2, the pause sources). Absent or older than 15 min → allow, no output.
- The session's priority: a launcher lane → `effectivePriority` from the registry (by `HL_SESSION_ID`); any other
  session (hand-opened: the user is at it) → `high`.
- Claude `state` = `slow`:
  - `low` priority → deny: "Usage is ahead of pace (5h +12 / week +6). Low-priority lanes start no new agents now. Do
    the step inline at lower effort, or save state and end your turn; dispatch resumes when the pace eases."
  - `normal`/`high` → allow, and once per session per state entry (`since`) add one line of `additionalContext`:
    "Usage ahead of pace (5h +12 / week +6): step effort down (`effort-medium`/`low`) and keep work small."
    Seen-marker: `<coord>/pace-seen/<session_id>`, JSON `{since, ctx}` (`ctx`: Part 8's markers). Each notice is first
    claimed with an exclusive create (`pace-seen/<session_id>.p<since>`, `.relay`, `.hard-<previous hard_at>`), so of
    two dispatches of one session at once only the one that creates the claim speaks.
- `hold`/`exhausted` before B2 ships: treated as `slow` for every priority (deny low, notice others). After B2: Part 5.
  Note: under `exhausted` (B2) the Agent gate denies the user's own hand-opened sessions too, by design.
- Errors → allow, no output.
- `pace-seen/` markers and their claims older than 8 days (by mtime) are pruned by the tick's hourly housekeeping.
- Codex side: codex-dual's routing reads the `claude` entry (slow/hold → borderline tasks go to Codex). Nothing to
  build here for that.

## Part 4 (B2): the one pause protocol

Low battery, `hold`/`exhausted` and a manual `/broadcast pause` are **sources** of one pause. Nothing else pauses.

**Sources.** One file per source, each with a single writer, each written atomically (no read-modify-write of a
shared file, so no lost update):
- `<coord>/pause/manual.json` `{until, by, at}`, written only by `coord.mjs pause [30m | until HH:MM]` and deleted by
  `coord.mjs resume` (both used by `/broadcast`); `resume` also deletes a legacy `<coord>/pause.json`. A past `until` means inactive; housekeeping deletes it.
- `<coord>/pause/battery.json` `{at, pct, ac}`, written only by the power refresh (Part 7).
- **pace** is not stored: it is derived at read time from `pace.json` (Claude `state` = `hold` or `exhausted`, with
  its `since`), with the same rule as the Agent gate: `pace.json` older than 15 min = absent. Nothing extra to keep in
  sync, and the pause view and the dispatch view never disagree.
- `pauseActive(now)` keeps its meaning (any active source) and also still reads the old `<coord>/pause.json`
  `{until}` shape (treated as a manual source).
- **Scope by priority:** manual and battery pause every lane; pace `hold` pauses `normal` and `low` lanes; pace
  `exhausted` pauses every lane. Hand-opened sessions are never closed (no recorded host pid); they get the notice and
  their entry in the manifest (below).
- A helper `pauseFor(priority, now) -> {paused, reason}` gives the one answer every hook uses.

**What a paused lane does (enforced, deterministic).**
1. The Agent hook denies new dispatches with the pause text: "Paused (<reason>): start no new agents or tasks. Let
   running agents finish, save state (ledger/handoff), mark open GOAL items `[!] paused — <reason>`, then end your
   turn. Work resumes automatically."
2. The lane's Stop hook (`coord.mjs stop`) appends `{paused: <lane>, at, reason}` to the registry when it ends a turn
   while `pauseFor` says paused, unless a matching `{paused}` line for this launch already exists (a goal-gate
   continuation runs Stop twice). This is the line `pausedLine` (`recover.mjs:27`) already matches; `coordinator.md`
   "never written by the code" is updated. The goal gate allows the stop while paused and returns
   `systemMessage: "paused: <reason>"`. `coord.mjs stop` runs from the live file, so running lanes get this at deploy;
   only the global Agent hook needs a relaunch.
3. Running agents are never killed (busy is not broken). In-flight agents finish.

**Closing.** The tick closes a lane window that has a `{paused}` line, while its pause is active, through
`guardedClose` (pid-reuse check, idle, no background tasks, `{kill_intent}` then `{closed}`). This applies in **both**
recovery modes: `closeCase` (`recover.mjs:597-603`) replaces its `recoveryMode === "auto"` term with
`pausedLine && (pause active for the lane || a resume is pending for it)` (the still-open case under Resuming), because
the user asked that a pause closes finished sessions. For a pause close, `idle_close_min` is waived (the lane saved
its state by protocol before writing `{paused}`), but the `{paused}` line must be at least 1 min old; the pid-reuse,
host and idle-now checks stay.
- Background-mode lanes (`closeCase` returns null for `e.mode !== "window"`, and `guardedClose` needs a host pid) get
  their own branch: liveness `running` + `{paused}` + `bg_id` → `killTree(e, why, "close")` (`live.mjs:457-470`, which
  stops by `bg_id`). A bg lane without `bg_id` cannot be stopped: it is left alone, listed in status and in the alert.
- A lane that is still busy is left alone and re-checked next tick. A lane whose close is skipped for any other reason
  (non-empty host, unknown liveness) after two ticks gets one alert naming it.

**The paused-session manifest.** One file for the current pause, `~/.claude/state/coord/paused.json` (the shape of the
existing hand-written `paused-2026-10-02.json`): `{paused_at, how_to_resume, sessions: [{name, generation, session_id,
cwd, branch, handoff, priority, reason, closed: true|false, resumed_at?}]}`. The tick upserts a row on each close;
hand-opened sessions seen by the hooks while paused are added with `closed: false` and their session id (they resume
with `claude --resume <id>`). Only the newest generation of a lane is kept: two sessions must never share a worktree.
It is archived as `paused-<paused_at date>-<HHMM>.json` when no source is active and every `closed: true` row has
`resumed_at` (hand-opened rows were sent in the alert and are dropped at archive), or when the user runs `resume`.

**Resuming.** A source ends (pace eases, AC back, manual resume or expiry). The tick (or the watcher) then:
- for a `{paused}` lane that is **still open** (it ended its turn but was never closed, e.g. a short `hold`): nothing
  can message an idle session, so it is closed through the pause close above, then relaunched like a closed one;
- relaunches each closed paused lane whose pause no longer applies, in `byPriority` order, from its handoff. The tick
  relaunches them itself under `tick.lock`; the by-hand path is a new `launch.mjs resume --paused` branch, which takes
  `tick.lock` too and refuses while a tick runs (no double relaunch). Today's `resume` requires `--group` and blocked lanes
  (`launch.mjs:519-530`), and `freshLaunchArgs` requires a recovery record (`recover-lib.mjs:289-294`), so the branch
  accepts a lone lane, passes a non-incident pointer ("resume after <reason> pause"), and treats a cap refusal
  (`capRefusal`) as "next tick". It marks the manifest row `resumed_at`;
- leaves hand-opened sessions to the user: a phone alert through the existing `raiseAlert` path lists their
  `claude --resume <id>` commands;
- caps relaunches at `max_resumes_per_tick` (default 3) to avoid a token spike, the rest next tick.
- **Probe resume:** when the pace source ended on a stale reading, the cap is 1 (the highest-priority **window-mode**
  lane; bg lanes produce no status-line reading) until a fresh reading confirms the state is still not
  `hold`/`exhausted`. If it goes back to `hold`, only that lane re-pauses. If no fresh reading arrives within 10 min
  (dead start, the lane finished at once), the next lane is probed. A pause that ended because its window **reset**:
  a 5-hour reset is a full resume; a weekly reset while the 5-hour reading is unknown or stale is a probe.
- Hysteresis lives in the pacer; the resume side adds a minimum pause of `min_pause_min` (15) so a lane closed for a
  pace `hold` is not relaunched within 15 minutes.

**The watcher (who wakes an idle machine).** Ticks today only come from hooks (`coord.mjs:73`, `goal-gate.mjs:105`),
so a fully paused machine gets none. `coord.mjs watch` is a hidden, detached, single-instance process (lock file with
pid + start time, taken with exclusive create (`wx`, as `tick.lock`) so exactly one survives; `sameProc` check):
- started by any tick or hook that sees a pause source active while an open lane or an unresumed `{paused}` lane
  exists (not only after a close: a skipped close followed by idle sessions would otherwise leave no tick at all);
- every 60 s: refreshes the power probe, recomputes `pace.json` from the files, and runs a tick when something can
  resume;
- **stops itself** when no source is active and nothing is left to resume, or after 8 days (a weekly window). `coord.mjs
  watch --stop` stops it; the tick restarts it if it died while needed. After a reboot it is gone: `launch.mjs status`
  lists paused lanes, `launch.mjs resume --paused` relaunches them by hand.
- Large-org variant: a fleet scheduler drains work on power or quota events; not needed per machine.

**Status.** `launch.mjs status` and `sessions` show `paused (<reason>, since HH:MM)` per lane and a header line with
`pace.json` (`claude 5h 42% wk 31% slow · codex wk 12% ok`).

## Part 5 (B2): `hold` and `exhausted`

With Part 4 in place, the pacer's states act through the pause source:
- `hold` → the derived pace source: `normal`/`low` lanes pause; `high` lanes and hand-opened sessions get the
  notice line only.
- `exhausted` → every lane pauses, except in-flight agents. The 5-hour one ends at `resets_at`; the weekly one at
  `week_resets_at` (the watcher sleeps until then, waking every 60 s to check cheaply).
- `slow` stays Part 3 (deny `low` dispatches only).

## Part 6 (B2): `/broadcast`

A skill (`claude/skills/broadcast/SKILL.md`), run from any session (the "master"):
- `ListAgents`, then `SendMessage` to every live interactive or background peer (not itself, not offline Remote
  Control rows); report who received it and who did not.
- Verbs: `pause [30m | until HH:MM]` → `coord.mjs pause ...` then broadcast the pause text; `resume` → `coord.mjs
  resume` then broadcast "resume your saved work" (the tick/watcher relaunches closed lanes); `restart` → reopen every
  manifest row (`launch.mjs resume --paused --all`, and for hand-opened rows print the `claude --resume <id> -n <name>`
  commands for the user); anything else is relayed verbatim.
- The timed pause needs no reminder: `until` expires on its own and the watcher resumes. (CronCreate one-shots only
  fire while that session is open and idle, so they are not relied on.)

## Part 7 (B3): power-aware pause

- `coord.mjs power`: user-level probes only. Windows `Get-CimInstance Win32_Battery` (charge; `BatteryStatus` 1, 4, 5
  = discharging/low/critical = not on AC; every other value, including 2, 3 and the charging states 6-9, = on AC);
  macOS `pmset -g batt`; Linux `/sys/class/power_supply/*`. No battery, or a null/absent `BatteryStatus` → never pauses (fail open). Result cached in
  `<coord>/power.json` for 60 s; the hooks only read the cache and, when stale, trigger the hidden detached refresh
  (the `triggerTick` pattern). `HL_FAKE_POWER=19,battery` injects a reading in tests.
- Low battery = `≤ battery_pct` (20) and not on AC → battery source on (all lanes pause); on AC → source off, the
  watcher resumes. This machine has a battery (79 %, AC at survey time).

## Part 8 (B1): controller context discipline (user-approved proposal P5, 2026-10-06)

54 % of controller spend happened above the 250k relay rule, and nothing enforces it. Never blocking, only showing
and nudging:
- **Context size.** The current context = the last main-thread assistant message's `input_tokens +
  cache_read_input_tokens + cache_creation_input_tokens`, read from the transcript tail (`transcript_path`, last ~64 KB;
  the status-line stdin's own context field is used instead when present). Zero tokens.
- **Status line.** The recorder's ctx segment (Part 1, step 4) is marked `ctx ▰▰▰▱▱▱▱▱▱▱ 26% relay` past `relay_ctx`
  (250k) and `... RELAY NOW` past `hard_ctx` (400k); without a window size it shows the count (`ctx 263k relay`).
- **Agent gate nudge (main thread only; a subagent's hook input carries `agent_id` and is skipped).** The first
  dispatch past 250k gets one `additionalContext` line: "Context 263k is past the 250k relay rule: this dispatch is
  your task boundary. Relay with handoff-launch after it (or finish before an idle gap; above ~200k an idle gap
  expires the cache)." Past 400k, each dispatch (at most once per 10 min) gets: "Context 402k is past the 400k hard
  cap: write the handoff and relay now." The dispatch is always allowed. Markers in `pace-seen/<session_id>` (the same
  file, a `ctx` field).
- Thresholds `relay_ctx`, `hard_ctx` in `<coord>/config.json`. Errors → nothing shown, allow.
- The `handoff-launch` skill's section 0 gains one line: "the next dispatch after 250k is the relay".

## Carried fixes (from batch A)

- `laneTable` (`recover.mjs:715-734`) and `launch.mjs sessions` (`:592-597`) pick the newest open entry per lane BEFORE
  the liveness filter, so a gone, unclosed newest entry hides an older running one. Fix: filter `gone` first, then pick
  the newest. B1 (pacing reads lanes and priorities).
- Flaky `recover.test.mjs` "report-only: alerts/index.json ..." failed once on `tick.lock` held by another tick in the
  full suite. B1 fixes it. Likely cause (Fable): a test kills a tick before its `finally`,
  so `tick.lock` keeps a dead pid that a parallel test file can reuse; a lock holding only a pid then reads as "another
  tick". Record and compare the holder's start time in `tick.lock`, as b2c2b2f did for the drain lock.
- goal-gate's once-markers `<config>/goals/.nudged-<sid>` are pruned by the tick's hourly housekeeping after 14 days (B1).
- After a dead start, the fresh restart did not name the earlier `<lane>.<stamp>.taken.md`: a launch with `--supersedes
  X` of the same lane now also names X's taken inbox in its prompt when that file is still there (B2).

- The sessions-pane mod writes `<coord>/pane/<session-id>.json` (one per instance) and cannot delete files: the tick's
  hourly housekeeping prunes `pane/*.json` older than 1 day (B1, with a test).

## Differences from the outlines (rulings)

1. Weekly window gets its own pace line and bands (outline: only `week_pct ≥ 90 → slow`). Reason: the weekly limit is
   the one that was hit.
2. Leaving `hold`/`exhausted` uses the last stale reading (outline: no fresh reading → pacing off). Reason: otherwise a
   full pause resumes at once and flaps.
3. The paused close applies in both recovery modes, not only auto (outline assumed it existed). Hand-opened sessions
   are never closed; they are listed for `claude --resume`.
4. Pause sources are one file per source under `<coord>/pause/` (single writer each), and the pace source is derived
   from `pace.json` at read time; the old `pause.json` `{until}` shape stays readable.
5. `launch.mjs resume` gets a `--paused` branch (today it only resumes blocked lanes).
6. One watcher for all sources (outline: a battery watcher), and it names its stop rule.
7. The Agent hook is global (outline said so; today only launcher sessions carry hooks): a deploy step adds it to the
   live settings. Running sessions pick it up only on relaunch; the restart table says so.
8. `{paused}` registry lines are now written by code.
9. Hysteresis uses a per-window state (`windows` in `pace.json`), never the merged state.
10. Resume after a pace pause that ended on a stale reading is a probe (one lane until a fresh reading confirms).
11. A paused lane that ended its turn but was never closed is closed by the pause close (idle wait waived) and then
    relaunched; bg lanes close by `bg_id`.
12. The manifest is one current `paused.json`, archived when done (outline: one file per date).

## Testing

- `pace-lib.mjs` units: band entry/exit per window, hysteresis both ways, weekly grace, weekly-only provider, stale
  reading rules (enter needs fresh, leave uses stale), severity merge, `since` only on change, provider selection by
  `provider` (absent = claude), ms vs s units.
- Recorder: fake stdin JSON (with/without `rate_limits`, one window missing), the skip-unchanged rule, the chained
  status line, error → exit 0. Concurrency: two recorders writing at once leave valid JSON.
- Agent gate: by priority and state, pace.json absent/stale, hand-opened session (no `HL_SESSION_ID`), the
  once-per-`since` notice, error → allow.
- B2: `pauseFor` scope table; Stop writes `{paused}` only while paused; goal gate allows with the system message;
  close in report mode; manifest upsert keeps the newest generation; resume order, cap and `min_pause_min`; watcher
  single instance and self-stop (fake clock); old `pause.json` shape; concurrent writers of the pause sources (no
  lost update); a paused-but-not-closed lane when the pause lifts; bg lane close by `bg_id` and the no-`bg_id` case;
  the watcher starting without a close; probe resume (cap 1 until fresh, re-pause of that one lane, the 10-min probe
  timeout, reset-ended pauses); `resume` removes a legacy `pause.json`; the archive rule with pending hand-opened rows.
- B3: `HL_FAKE_POWER` readings, desktop (no battery), cache staleness, `BatteryStatus` 6 (charging) at 19 % = on AC.
- Pacer additions: per-window hysteresis (weekly `slow` + 5h `ahead` 7 does not hold the 5h window in `slow`),
  `pace_floor`, leaving `slow` on a stale reading, `updated` skipped by a provider iterator.
- Sandbox only (`HL_REGISTRY_DIR`, temp `CLAUDE_CONFIG_DIR`, `HL_FAKE_PROCS`, `HL_NO_SPAWN`); no visible windows; the
  watcher in tests runs with a fake clock and `HL_NO_SPAWN`.
- Live verify per release: B1 — the status line shows the reading and `pace.json` appears from this machine's real
  sessions (read-only check); B2/B3 — a dry-run tick with an injected source lists what it would close and resume.

## Deploy notes

- Each release: the dry-run gate (what the tick would close, pause or resume with the live registry), shown to the user;
  then the ordered copy, `diff -r` live vs repo, the secret scan, push, and the restart table to the coordinator.
- B1 adds `statusLine` and the global PreToolUse `Agent` hook to the live `settings.json` (backup first). New hooks
  load only in new sessions: test them headless with `claude -p --settings ...`; the status line itself is verified in
  an interactive session by reading the usage file it writes.

## Out of scope

The standalone master app (Later); cross-machine coordination; a live remaining-quota API (none exists); per-model
(Fable) limits; the tracking item (own spec).
