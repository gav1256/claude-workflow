# Stage 2: loop prevention and recovery: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Looping or stuck launcher sessions and their subagents are warned early, told to stop, and if that fails are
killed, written up and restarted (resume, then fresh, then blocked + alert), by deterministic code that spends zero
tokens until something fires and never touches another session.

**Architecture:** One new shared module, `live.mjs`, takes the registry, the process probes (now tri-state:
`running` / `gone` / `unknown`), the transcript readers, stop requests, kills and the window launcher out of
`launch.mjs`, because `launch.mjs` is a CLI script that `recover.mjs` and the hook cannot import. `recover-lib.mjs`
holds every decision as a pure function (tool calls, rules a/b/d, exemptions, the ladder, restart kind and cap,
closes, texts, the hook's steps). `recover.mjs` is the tick (scan, stop request, grace, incident, kill, restart,
block, guarded close, alert files). `claude/hooks/coord.mjs` is the thin hook entry (`post-tool`, `notify`, `tick`,
`relay`, `alert-sent`, `alert-release`). `launch.mjs` gains the restart surface (`--resume`, `--recovery`,
`--prompt-file`, `--goal-from`, `recover`, `resume`), passes the session hooks with `--settings`, and its `watchdog`
becomes the tick's dry run. `merge.mjs` gets the M3 sidecar, M8, T4e and the `{lane_blocked}` skip. `goal-gate.mjs`
starts the tick and relays alerts.

**Tech Stack:** Node ≥ 18 ESM (`node:fs`, `node:child_process`, `node:crypto`, `node:test`), Windows PowerShell 5.1
for process probes and the desktop balloon, git worktrees. No dependencies.

**Spec:** `docs/specs/2026-10-04-stage2-loop-recovery-design.md` (approved 2026-10-04; approval covers stage 2 only).
Read it with this plan: the plan argues from it.

## Global Constraints

- Decisions in deterministic code, zero tokens until something fires. Busy-but-progressing work is never killed.
  No action on `unknown` liveness: `unknown` never writes `{closed}`, never reports STALE, never kills, and makes
  `--force`/`--skip` refuse.
- Scope: sessions in the launcher registry only. Sessions the user opened by hand are never watched.
- **No other concurrent session is affected.** The tick writes only the target's registry lines, stop file, incident
  and hook state, `looping.json` and `alerts/`. It never writes done markers, other lanes' files, `merge.lock` or
  another worktree. A session hook writes only its own `sessions/<sid>.json` (and its own `{stop_delivered}` line).
- Automatic recovery for groups launched after stage 2 deploys (earliest launch line has `coord: 1`). Earlier groups
  are **report-only** (incident + alert, no stop request, no kill) until the user opts them in. The superseded-window
  close applies to all groups.
- Kill only looping or broken work; never kill an agent that can't save its state and restart from the middle; pauses
  close only idle sessions that saved their state.
- Thresholds (`CFG/state/coord/config.json`, missing = defaults): `repeat_window` 20, `repeat_count` 4, `warn_streak` 3,
  `stuck_min` 30, `grace_min` 5, `idle_close_min` 10, `fresh_at_tokens` 400000, `max_restarts` 2, `tick_min` 5,
  `alert_repeat_hours` 6.
- `CFG = $CLAUDE_CONFIG_DIR || ~/.claude`, resolved once in `live.mjs` (used by `launch.mjs`, `merge.mjs`, `recover.mjs`,
  `coord.mjs`) and in `goal-gate.mjs`. Children keep `CLAUDE_CONFIG_DIR`.
- Tests never touch the real registry: `HL_REGISTRY_DIR=<temp>`, `HL_AGENTS_JSON=<file containing []>` (never
  `/dev/null`: Node on Windows resolves it to `nul` and fails), `HL_PROJECTS_DIR=<temp>`, a temp CFG
  (`CLAUDE_CONFIG_DIR=<temp>/cfg`), `HL_FAKE_CLAUDE=1`, `HL_NO_SPAWN=1`, temp git repos; test identities
  `test@example.com`. A test imports only pure functions from `live.mjs`/`recover-lib.mjs` in-process; anything that
  reads or writes the registry runs as a child process with the sandbox env.
- Every change lands in the repo copy (`claude/skills/handoff-launch/`, `claude/hooks/`) and is deployed to live
  (`~/.claude/skills/handoff-launch/`, `~/.claude/hooks/`) only in the controller task after review; the copies stay
  identical.
- The repo is PUBLIC: no private project names, no user paths, no email. The secret scan
  `grep -rniE "<the scan pattern from the private handoff>" . --exclude-dir=.git` must print nothing before a push.
- Node ≥ 18 ESM, no dependencies. Proving check: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"` (the
  hook and goal-gate tests live in the same folder, so the glob covers them). Node 24's default reporter prints
  `ℹ pass N` / `ℹ fail N`; report those lines (or `# pass`/`# fail` with `--test-reporter=tap`). Baseline at
  `878c0fc`: `ℹ tests 67`, `ℹ pass 67`, `ℹ fail 0`, about 200 s.
- Large-org variant (document only): a central supervisor service with an audit log, per-session credentials for stop
  and kill, policy-gated kills.

## Decisions beyond the spec's text

- **`live.mjs`** (new) holds what `launch.mjs`, `merge.mjs`, `recover.mjs` and `coord.mjs` share: `CFG` and the
  registry paths, `readRegistry`/`append`, the tri-state probes, `liveness`, transcript readers, `requestStop`,
  `killTree`, the window launcher. `launch.mjs` keeps the CLI.
- **Ladder lines.** `{stop_requested}` gains `reason_class` (`ladder`/`close`/`manual`), `signature` and `token`;
  `{stop_delivered}` carries the `token`; `{kill_intent}` gains `kind` (`ladder`/`close`); new lines
  `{ladder_cancelled}`, `{ladder_rearmed}`, `{restart_skipped}`, `{lane_resumed}` (see "Spec gaps"). Old lines without
  these fields are read as: `reason_class` from the `why` text, `kind` = close. So no pre-stage-2 kill is ever
  resumed into a restart.
- **One ladder per session at a time.** When several signatures fire, the first one escalates; the others wait.
- **Signatures:** rule (a) `a:<main|agent id>:<sha1(key)[0..10]>`, rule (b) `b:<tool name>`, rule (d) `d:<agent id>`.
  The hook's warning signature is `<main|agent id>:<sha1(key)[0..10]>`.
- **Calls before a launch line do not count.** The tick reads only tool calls at or after the entry's `launched_at`, so
  a resumed session (same session id, same transcript) is not re-flagged by the calls that got it killed.
- **Monitor is waiting by design:** rule (a) never counts `Monitor` calls, rule (b) never flags an outstanding one, and
  the early warning never fires on one (the warning tells sessions to wait with Monitor).
- **Rule (a) skips a finished main turn** with nothing outstanding: an idle session repeats nothing now. Rule (d) still
  judges idle parents. A stop request older than 60 min is marked handled by the hook and never injected.
- **Stop files per reason class:** `stops/<stem>.<ladder|close|manual>.stop.json`; the hook delivers the first
  undelivered one, ladder first, so a close or manual request never overwrites a pending ladder token.
- **Background lanes always restart fresh** (controller ruling), and so does any session without a recorded session
  id. Probe 4's `--bg --resume` result is recorded for information only.
- **Restarts run to their end:** the tick runs `launch.mjs` with `spawnSync` (3 min timeout, output in
  `CFG/state/coord/restarts/<name>-<stamp>.log`) and records `{restart}` only on exit 0; otherwise
  `{restart_failed}` + `{lane_blocked}` + an alert (controller ruling). Only the newest generation of a lane is ever
  restarted.
- **Grace never counts a permission wait:** the hook keeps the last waits (`waits: [[from, to]]`) when a tool call
  clears `waiting_since`; `graceElapsed` leaves them out.
- **`prompt_file` stores the base pointer prompt** (without any RECOVERY prefix), so prefixes never pile up.
- **HL_NO_SPAWN launch lines carry `no_spawn: true`**; such a line with no pid and no bg id reads as `gone` ("recorded
  without a process"). Without it, a fresh test line with no pid would be `unknown` and every stage-1 `--force` test
  would refuse. A copy of such a line that a test gives a live pid or bg id is judged normally.
- **Test hooks:** `HL_FAKE_PROBE=fail|timeout` (every process probe fails / really times out after 0.3 s);
  `HL_FAKE_CLAUDE=1` with `HL_AGENTS_JSON` makes `claude stop <id>` remove that agent from the JSON file;
  `HL_NO_SPAWN=1` also means: no detached tick, no desktop balloon, and a restart is run synchronously (it records its
  launch line and starts nothing); `HL_SKILL_DIR` points `coord.mjs` at a skill folder; `HL_LAUNCH_MJS` stands a fake launcher in for the tick's restarts.
- **The tick's own output** goes to `CFG/state/coord/last-tick.txt` (overwritten each run), because a detached tick
  has no console.

## Review Focus

1. **A resumed session's transcript still holds the loop that got it killed** (same session id): the tick must ignore
   calls before the new launch line, so the resumed session is not stopped and killed again at once. (Test: Task 6,
   "a resumed session is not re-flagged by its pre-kill calls".)
2. **The first tick after deploy reads a registry full of pre-stage-2 lines** (no `coord`, no `model`, `kill_intent`
   without `kind`, old watchdog `stop_requested`): it must restart nothing, kill nothing, and treat those groups as
   report-only. (Test: Task 6, "legacy registry lines: no restart, no kill, report-only".)
3. **The hook meets broken input or state** (malformed stdin, corrupt `sessions/<sid>.json` or `looping.json`, a
   missing skill folder): exit 0 with no output, so a tool call is never blocked. (Test: Task 4, "any error or corrupt
   state: exit 0, no output".)
4. **Two ticks start at the same moment** (a Stop hook in one session, a PostToolUse in another): exactly one acts; a
   held `tick.lock` makes the other a no-op, and a dead holder's lock is reclaimed. (Test: Task 6, "tick.lock: a live
   holder blocks a second tick; a dead holder's lock is reclaimed".)
5. **A recovery prompt for a path with spaces** (repo under `C:/Users/<name with space>/...`, incident path inside it):
   the restart must launch with the incident path intact and no `"` or `;` in the prompt. (Test: Task 5, "a recovery
   prompt keeps a spaced incident path intact".)

Also watch, by review rather than test: concurrent PostToolUse hooks of parallel tool calls may lose a streak update
(worst case: one extra warning, accepted); the tick that runs inside the lane it kills may die before the restart (the
next tick resumes from registry state).

## File structure

| File | Responsibility |
|---|---|
| `claude/skills/handoff-launch/live.mjs` (new, Task 2) | `CFG`, registry paths, `readRegistry`/`append`, tri-state `procInfo`/`hasClaudeBelow`/`agentsList`, `checkHost`, `liveness` (memoized), transcript and subagent readers, `sessionState`, `requestStop`, `killTree`, `sessionBlocker`, `cleanEnv`, the window launcher, `matchNewAgent`, `triggerTick` (Task 4), `copyGoal` (Task 5). |
| `claude/skills/handoff-launch/recover-lib.mjs` (new, Task 3) | Pure: `loadConfig`, `toolCalls`, `contextTokens`, rules a/b/d, `exemption`, `detect`, `graceElapsed`, `ladderOf`, `ladderActions`, `pendingLadders`, `restartsSince`, `restartKind`, `afterKillPlan`, `rungUp`, `causeFilled`, `closeDecision`, `recoveryMode`, `blockedLanes`, `alertDue`, `freshLaunchArgs`, `postToolSteps`, `incidentText`, the texts. |
| `claude/skills/handoff-launch/recover.mjs` (new, Tasks 6, 7, 9) | The tick: `tick`, `tick.lock`, `observe`, `scan`, the ladder, `writeIncident`, `afterKill`, `resumePending`, `guardedClose`, `supersededScan`, `raiseAlert`, `desktopNotify`, `releaseStaleClaims`. |
| `claude/hooks/coord.mjs` (new, Tasks 4, 6, 9) | Hook entry: `post-tool`, `notify`, `tick [--dry-run]`, `relay`, `alert-sent`, `alert-release`; exports `postTool`, `notify`, `claimAlert`, `startTick` for goal-gate. |
| `claude/skills/handoff-launch/launch.mjs` (modify, Tasks 0, 2, 4, 5, 6, 8) | CLI: foundations rewiring, launch line fields, `--settings`, `--resume`/`--recovery`/`--prompt-file`/`--goal-from`, `recover`, `resume`, `watchdog` = tick dry run, `status` recovery notes. |
| `claude/skills/handoff-launch/merge.mjs` (modify, Tasks 0, 2, 8) | `lane` in the lock refresh, link-error wording, `--why` collapse, `sessionLiveness`, M8 `pid_start`, M3 sidecar, `{lane_blocked}` lanes. |
| `claude/skills/handoff-launch/merge-lib.mjs` (modify, Tasks 0, 2, 8) | `stem`, NaN `at`, unknown config keys, quoted `conflictHandoff` paths, `rollingSummary` unknown hint, M8 `lockState`, `loop-blocked` state. |
| `claude/hooks/goal-gate.mjs` (modify, Task 9) | `CFG`, start the tick, relay one alert per Stop in non-launcher sessions. Still fails open. |
| `claude/skills/handoff-launch/tests/helpers.mjs` (modify, Tasks 0, 2, 3) | Sandbox (`space`, temp CFG and TEMP, scrubbed env), transcript fixture builder `tx`, `sessionLine`, `writeTranscript`, `writeSubagent`, `setAgents`, `coordRun`, `host`, `alive`. |
| `tests/liveness.test.mjs` (Task 2), `tests/recover-lib.test.mjs` (Task 3), `tests/coord-hook.test.mjs` (Task 4), `tests/restart.test.mjs` (Task 5), `tests/recover.test.mjs` (Tasks 6, 7), `tests/alerts.test.mjs` (Task 9), `tests/isolation.test.mjs` (Task 10) (new, all under `claude/skills/handoff-launch/tests/`) | As named. |
| `claude/skills/handoff-launch/SKILL.md`, `README.md`, `INSTALL_PROMPT.md` (modify, Task 11) | Lane rules, new commands, status words; install of `coord.mjs`. |

Run every test from the repo root: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`.

## Execution notes for the controller

- **Task 0 first, on its own branch** `stage1-fixes` off `main`; it is reviewed, pushed, merged into `main` and
  deployed to live before any stage-2 work. Then branch `stage2-loop-recovery` off the updated `main` in the main
  checkout for Tasks 2-11; per-task commits there; Task 12 fast-forwards `main` and pushes.
- **Task 1 (live probes) runs before Task 2.** Its results table below is the gate: Task 2's bg-id step needs probe 3;
  Task 4 needs probes 1, 2, 3 (the `HL_SESSION_ID` check) and 5; Task 5 needs probe 4; Task 9 needs probe 6; probe 7 only informs the review. A failed
  probe switches the owning task to the fallback written in Task 1; record which fallback was taken in the table.
- **Dispatch sizing** (`sizing-dispatches`), implementer / per-task reviewer:

  | Task | Implementer | Reviewer |
  |---|---|---|
  | 0 stage-1 fixes | `worker-high` + opus | `worker-high` + opus |
  | 1 probes | controller (headless probes may go to `worker-medium` + opus) | — |
  | 2 liveness foundation | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 3 recover-lib | `worker-high` + opus | `worker-high` + opus |
  | 4 coord hook | `worker-high` + opus | `worker-high` + opus |
  | 5 restart surface | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 6 tick | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 7 closes | `worker-xhigh` + opus | `worker-xhigh` + **fable** |
  | 8 merge + status | `worker-xhigh` + opus (lock logic) | `worker-xhigh` + **fable** |
  | 9 alerts + goal-gate | `worker-high` + opus | `worker-high` + opus |
  | 10 end-to-end tests | `worker-high` + opus | `worker-high` + opus |
  | 11 docs | `worker-medium` + opus | `worker-high` + opus |
  | 12 release | controller; whole-branch review `worker-xhigh` + **fable** | — |

- The proving check for every task is `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`; report its real
  summary lines. Windows-only tests (real PowerShell hosts) are `skip`ped elsewhere, as in stage 1.
- Line numbers below are at `878c0fc` (Task 0) or after Task 0 merged (later tasks); anchor on the quoted code.

### Probe results (filled by the controller in Task 1; the gate for Tasks 2, 4, 5, 9)

| # | Probe | Result (pass / fail + evidence) | Fallback taken |
|---|---|---|---|
| 1 | PostToolUse `additionalContext` inside a subagent reaches the subagent | PARTIAL (2026-10-04, CLI 2.1.289): the subagent's PostToolUse carries `agent_id` (17 hex) + `agent_type` (`general-purpose`), `transcript_path` is the parent's, and `subagents/agent-<agent_id>.jsonl` (+ `.meta.json`) exists. The notice reached the subagent's context (a `hook_additional_context` attachment in its jsonl), but the model did not act on it (n=1). The parent's own Agent PostToolUse has no `agent_id`. | Probe 1's fallback: hook step 2 stays but is not relied on; step 3 + rule (d) handle a looping subagent. Task 11 SKILL.md: "a subagent receives its notice but may not act on it". |
| 2 | Notification type field (permission vs idle); Stop input keys | PARTIAL: idle = `notification_type: "idle_prompt"` (60 s after Stop). No permission prompt could be provoked: the user's auto mode auto-approved Write and Bash, even with `--permission-mode default`. `permission_prompt` is corroborated by the CLI binary (17 occurrences, next to `idle_prompt`, `elicitation_dialog`, `auth_success`). The Stop input has `session_id` and `transcript_path` (plus `background_tasks`, `last_assistant_message`, `stop_hook_active`; interactive also has `scratchpad_dir`). | None: `isPermission` unchanged (`permission_prompt`, message fallback kept). Under auto mode permission waits are rare, so the `waiting_since` exemption matters less. |
| 3 | `claude agents --json` fields; before/after diff by name; a bg session's hooks see `HL_SESSION_ID` | PASS: exactly one new entry, fields `cwd,id,kind,name,pid,sessionId,startedAt,state,status`, with the name in `name`; `id` = the first 8 hex of `sessionId`. The bg hooks saw `HL_SESSION_ID`. A bg session whose turn finished stays listed as `status: idle, state: done`; after `claude stop` the entry is gone. Interactive entries have no `id`. A bg launch in an untrusted cwd exits 1 ("Workspace not trusted"). | None: `matchNewAgent` keys on `id` (bg entries always have one) and matches `name`. `BG_ENDED` (tests `status`) unchanged: a turn-finished bg session reads `running` (idle), like an idle window; stopped = unlisted = `gone`. Task 4 Step 5b not needed. |
| 4 | `--resume` after a kill mid-tool-call (`--resume` with `--bg`: recorded only) | PARTIAL: headless variant: a `-p --session-id` session killed (`taskkill /T /F`) with 1 `tool_use` and 0 `tool_result` in its transcript resumed with `claude -p ... --resume <id> -n <name> --model opus --effort low`: exit 0, `RESUMED-OK`, and it named the dangling Bash call. `--bg --resume` appeared (same session id; info only). The window variant was not reached: the probe's wt windows persisted no transcript (real launcher windows do: 8/8 recent registry launches have transcripts), and the CLI auto-backgrounded `sleep 300`. The plan's probe command also put the prompt after the variadic `--allowedTools`, which swallowed it. | None: `RESUME_WORKS = true`. Residual: resuming a window session that has no transcript fails inside the window, so the new generation dies, and gap 17's path writes `{lane_blocked}` + an alert. A prompt must never follow a variadic flag. |
| 5 | `--settings` hooks layer onto the user's hooks | PASS: the global goal-gate ran (`GOAL_GATE_LOG` written) and the `--settings` Stop hook ran once. | None. |
| 6 | NotifyIcon balloon from a detached, windowless node spawn | INCONCLUSIVE: the hidden PowerShell ran (seen in the process list). Screen captures show no taskbar or notification area (auto-hidden), so the balloon was not seen. A capture cannot prove there was no console flash. | Pending the user's confirmation (asked 2026-10-04); decided before Task 9. |
| 7 | Detached node child survives `taskkill /T` of its host | PASS: `taskkill /T /F` of the host did not include the detached child (alive, heartbeat 198 ms old). So a tick spawned inside a lane survives that lane's kill. | None. |

---

### Task 0: Stage-1 fix PR (branch `stage1-fixes`, merged and deployed before stage 2)

The eight "stage-1 fix PR" items of the spec's "Carried triage items". Line numbers verified at `878c0fc`.

**Files:**
- Modify: `claude/skills/handoff-launch/merge-lib.mjs:5` (`stem`), `:13-24` (`validateConfig`), `:35-39` (`lockState`),
  `:123-147` (`conflictHandoff`)
- Modify: `claude/skills/handoff-launch/merge.mjs:95-96` (`acquireLock` error text), `:294-306` (`skipLane`), `:389`
  (drain lock refresh)
- Modify: `claude/skills/handoff-launch/launch.mjs:187` (stop file stem), `:350-367` (`group` flags), `:538-543`
  (prompt quoting), `:552` (pid file stem), `:620-622` (pid file removed before the spawn)
- Modify: `claude/skills/handoff-launch/tests/helpers.mjs` (`sandbox({ space })`)
- Test: `tests/launcher.test.mjs`, `tests/merge-lib.test.mjs`, `tests/merge.test.mjs`

**Interfaces:**
- Consumes: stage-1 code as is.
- Produces: `stem(id) → string` in merge-lib (`String(id).replace(/[^\w.-]+/g, "-")`, never truncated); pid and stop
  file stems `${name}-${stamp}`; `sandbox({ space: true })` (the temp dir name contains a space); `validateConfig`
  rejects unknown keys with `unknown key <k> (allowed: ...)`; `group` rejects unknown flags with
  `unknown flag <flag>` (exit 2); `lockState` returns `drain-old` for a non-finite age.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b stage1-fixes main
```

- [ ] **Step 2: Add the `space` option to the sandbox**

In `tests/helpers.mjs` replace the first two lines of `sandbox`:

```js
export function sandbox({ space = false } = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), space ? "hl test-" : "hl-test-")));
```

- [ ] **Step 3: Write the failing tests**

Append to `tests/launcher.test.mjs`:

```js
test("M5: two launches of a 60-character name get distinct pid files", () => {
  const sb = sandbox();
  try {
    const long = "x".repeat(60);
    for (let i = 0; i < 2; i++) assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", long, "--model", "opus", "--effort", "high").code, 0);
    const [a, b] = sb.registry().map((o) => o.pid_file);
    assert.notEqual(a, b);
    assert.match(a, new RegExp(`/pids/${long}-\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.pid$`));
  } finally { sb.cleanup(); }
});

test("paths with spaces are single-quoted in the lane prompt", () => {
  const sb = sandbox({ space: true });
  try {
    assert.match(sb.repo, / /);
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const p = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--worktree", "lane-A", "--group", "g1").out).prompt;
    const root = sb.repo.split(path.sep).join("/");
    assert.ok(p.includes(`Continue from the handoff at '${sb.handoff.split(path.sep).join("/")}' - read it first`), p);
    assert.ok(p.includes(`write the done marker '${root}/.superpowers/sessions/g1/A.done' only when`), p);
    assert.ok(p.includes(`merge --group g1 --repo '${root}' --lane A and report its output`), p);
    assert.doesNotMatch(p, /[";]/);
  } finally { sb.cleanup(); }
});
```

Append to `tests/merge-lib.test.mjs`:

```js
test("stage-1 fixes: unknown config keys, NaN lock age, quoted handoff paths, unsliced stem", () => {
  assert.match(L.validateConfig({ integration: "i", target: "t", tests: "x" }).errors[0], /^unknown key tests \(allowed: /);
  const now = Date.parse("2026-01-01T01:00:00Z");
  assert.equal(L.lockState({ holder: "drain", pid: 1, at: "garbage" }, { pidAlive: () => true, now, maxAgeMs: 3600e3 }), "drain-old");
  assert.equal(L.lockState({ holder: "drain", pid: 1 }, { pidAlive: () => true, now, maxAgeMs: 3600e3 }), "drain-old");
  const md = L.conflictHandoff({ group: "g1", lane: "C", branch: "lane-C", head: "abc", integration: "int", target: "main",
    wt: "/r s/.claude/worktrees/_merge-g1", before: "def", reason: "conflict", conflicts: ["x"], output: "", code: null,
    test: null, overlap: {}, launchMjs: "/h s/launch.mjs", root: "/r s", at: "2026-01-01T00:00:00Z" });
  assert.match(md, /`node "\/h s\/launch\.mjs" merge --group g1 --repo "\/r s"`/);
  assert.match(md, /node "\/h s\/launch\.mjs" merge --group g1 --repo "\/r s" --skip C --session g1-merge-C --why "<reason>"/);
  assert.equal(L.stem(`${"n".repeat(60)}@2026-01-01T00-00-00-000Z`), `${"n".repeat(60)}-2026-01-01T00-00-00-000Z`);
});
```

In `tests/merge.test.mjs`, extend the F2 test: directly after `assert.notEqual(seen[0].at, seen[1].at);` add

```js
    assert.deepEqual(seen.map((s) => s.lane), ["A", "B"]); // the refresh records the lane being merged now
```

Append to `tests/merge.test.mjs`:

```js
test("group rejects an unknown flag; config.json rejects an unknown key", () => {
  const sb = sandbox();
  try {
    const r = sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main", "--tests", "node check.cjs");
    assert.equal(r.code, 2); assert.match(r.err, /unknown flag --tests/);
    assert.equal(fs.existsSync(path.join(gdir(sb, "g1"), "config.json")), false);
    setup(sb);
    const f = path.join(gdir(sb, "g1"), "config.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), tests: "x" }));
    const m = merge(sb);
    assert.equal(m.code, 1); assert.match(m.out, /ERROR config: unknown key tests/);
  } finally { sb.cleanup(); }
});

test("a link error other than missing hard links is reported as such", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const r = inProcessDrain(sb, () => { throw Object.assign(new Error("permission denied, link"), { code: "EACCES" }); });
    assert.deepEqual(r, { code: 1, lines: ["ERROR could not create merge.lock (EACCES)"] });
  } finally { sb.cleanup(); }
});

test("--why with a newline is collapsed to one line in the record and the output", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "Z", at: new Date().toISOString() }));
    const r = merge(sb, "--skip", "A", "--why", "first line\n  second line");
    assert.match(r.out, /^skipped A \(first line second line\)$/m);
    assert.equal(sb.registry().find((o) => o.merge_blocked === "A").why, "first line second line");
  } finally { sb.cleanup(); }
});

test("--force clears a legacy (empty) merge.lock in a rolling group, then the lane merges", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), "");
    const r = merge(sb, "--force");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^cleared merge\.lock \(a legacy merge launch\)$/m);
    assert.match(r.out, /merged A -> int-g1/);
  } finally { sb.cleanup(); }
});

test("--force clears a drain lock older than the test timeout, then the lane merges", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "Z", at: "2026-01-01T00:00:00.000Z" }));
    assert.match(merge(sb).out, /queued: merge\.lock is held by merge process \d+ \(lane Z, since 2026-01-01T00:00:00\.000Z\).*older than the test timeout/);
    const r = merge(sb, "--force");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^cleared merge\.lock \(merge process \d+ \(lane Z, since 2026-01-01T00:00:00\.000Z\)\)$/m);
    assert.match(r.out, /merged A -> int-g1/);
  } finally { sb.cleanup(); }
});

test("rolling --reopen is refused while a drain lock is held for the same lane", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    const marker = writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, lane: "A", at: new Date().toISOString() }));
    const r = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--worktree", "lane-A", "--group", "g1", "--reopen");
    assert.equal(r.code, 3); assert.match(r.err, /already merged \(or being merged\)/);
    assert.ok(fs.existsSync(marker));
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: FAIL: "M5" (equal pid files), "paths with spaces" (unquoted), the merge-lib test (`L.stem` is not a
function, no unknown-key error, `drain-live` for NaN, unquoted paths), F2 (`["A","A"]`), "unknown flag" (exit 0),
"link error" (`hard links` text), "--why" (two lines). The three gap tests ("legacy (empty) merge.lock", "drain lock
older", "--reopen ... drain lock") already PASS: they pin behaviour stage 1 has but never tested.

- [ ] **Step 5: Implement in `merge-lib.mjs`**

After `export const slug = ...` (line 5) add:

```js
// File stem for a registry id (pid, prompt and stop files). Never truncated: two long names never collide (M5).
export const stem = (id) => String(id).replace(/[^\w.-]+/g, "-");
```

In `validateConfig`, directly after `const errors = [];` add:

```js
  const KEYS = ["integration", "target", "test", "test_timeout_min", "mode"];
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) errors.push(`unknown key ${k} (allowed: ${KEYS.join(", ")})`);
```

Replace the last line of `lockState` (`return now - Date.parse(lock.at) > maxAgeMs ? "drain-old" : "drain-live";`) with:

```js
  // An unreadable `at` is never young: report it like an old lock (merge --force clears it), never drain-live forever.
  const age = now - Date.parse(lock.at);
  return !Number.isFinite(age) || age > maxAgeMs ? "drain-old" : "drain-live";
```

In `conflictHandoff`, replace its first line (`const merge = ...`) with:

```js
  const qd = (s) => (/\s/.test(String(s)) ? `"${s}"` : String(s)); // paths with spaces stay one shell word
  const merge = `node ${qd(p.launchMjs)} merge --group ${p.group} --repo ${qd(p.root)}`;
```

- [ ] **Step 6: Implement in `merge.mjs`**

In `acquireLock`, replace the `catch (e) { return { ok: false, lock: null, state: "error", error: ... }; }` line with:

```js
    catch (e) {
      const noLinks = ["EPERM", "ENOTSUP", "EINVAL", "EXDEV"].includes(e.code);
      return { ok: false, lock: null, state: "error", error: noLinks ? `merge.lock needs a filesystem with hard links (${e.code})` : `could not create merge.lock (${e.code || e.message})` };
    }
```

At the top of `skipLane`'s body (before `const gd = ...`) add:

```js
  why = String(why ?? "").replace(/\s+/g, " ").trim() || "skipped by hand"; // one line in the record and the output
```

In `drain`, replace the refresh line `if (ownsLock(gd, token)) writeAtomic(lockFile(gd), JSON.stringify({ ...acq.lock, at: iso() }));` with:

```js
      if (ownsLock(gd, token)) writeAtomic(lockFile(gd), JSON.stringify({ ...acq.lock, lane: next.name, at: iso() }));
```

- [ ] **Step 7: Implement in `launch.mjs`**

1. Import `stem` from `./merge-lib.mjs` (add it to the existing import list).
2. `requestStop` (line 187): `const file = path.join(STOP_DIR, \`${stem(e.id)}.stop.json\`);`
3. `group` subcommand: directly after its `if (!group || !root || ...) { ...; process.exit(2); }` block add:

```js
  const allowed = ["--group", "--repo", "--integration", "--target", "--test", "--test-timeout-min", "--mode", "--force"];
  const valued = ["--group", "--repo", "--integration", "--target", "--test", "--test-timeout-min", "--mode"];
  const bad = [];
  for (let i = 1; i < args.length; i++) if (args[i].startsWith("--")) { if (!allowed.includes(args[i])) bad.push(args[i]); else if (valued.includes(args[i])) i++; }
  if (bad.length) { console.error(`group: unknown flag ${bad.join(", ")} (allowed: ${allowed.join(" ")})`); process.exit(2); }
```

4. Prompt quoting. Directly before `const handoffRef = ...` add the helper, and use it in `handoffRef`'s sentence and
   both lane notes:

```js
// A path with spaces stays one word for the session reading it. Single quotes: the prompt's " become ' anyway.
const qs = (p) => (/\s/.test(p) ? `'${p}'` : p);
```

```js
const laneNote = !group || isMergeSession(group, name) ? ""
  : groupCfg ? ` Fan-out group ${group} (rolling merges): write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - then run node ${qs(fwd(fileURLToPath(import.meta.url)))} merge --group ${group} --repo ${qs(fwd(root))} --lane ${name} and report its output. Otherwise launch the lane next stage as the handoff says.`
  : ` Fan-out group ${group}: write the done marker ${qs(fwd(doneMarker))} only when this LANE whole wave is done, blocked or needs another lane unmerged work - not just this stage - otherwise launch the lane next stage as the handoff says.`;
const prompt = (`Continue from the handoff at ${qs(handoffRef)} - read it first, then follow its paste-ready prompt section exactly.` + laneNote)
  .replace(/"/g, "'").replace(/;/g, ",");
```

5. Pid file stem (line 552): `const pidFile = path.join(PID_DIR, \`${stem(id)}.pid\`);`
6. Directly before `const t0 = Date.now();` (line 620) add:

```js
// A leftover pid file from an earlier launch must never be read as this window's.
fs.rmSync(pidFile, { force: true });
```

- [ ] **Step 8: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0` (67 + 9 = 76 tests).

- [ ] **Step 9: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "handoff-launch: stage-1 fixes (unsliced pid/stop stems, quoted paths with spaces, lock refresh lane, link error text, NaN lock age, unknown config keys and group flags, one-line --why, three merge tests)"
```

- [ ] **Step 10 (controller): review, push, merge, deploy**

1. Review: `worker-high` + opus on `git diff main...stage1-fixes` against the triage rows (UQ, M5, L103a, L103b, T2c,
   T2d, T2h, T4c). Fix findings; re-review edits made after the review.
2. Secret scan (pattern from the private handoff) → prints nothing.
3. `git push -u origin stage1-fixes`, then `gh pr create --base main --head stage1-fixes --title "handoff-launch: stage-1 fixes" --body "<the triage rows fixed, the test summary>"`
   (the body ends with the session's PR attribution lines), then fast-forward `main`
   (`git checkout main && git merge --ff-only stage1-fixes && git push`). These pushes are part of this approved plan.
4. Deploy: copy `merge-lib.mjs`, `merge.mjs`, `tests/` then `launch.mjs` into `~/.claude/skills/handoff-launch/`;
   `diff -r claude/skills/handoff-launch ~/.claude/skills/handoff-launch` → only `pids`, `stops`, `sessions.jsonl`
   differ. `node ~/.claude/skills/handoff-launch/launch.mjs status --group none` →
   `members=0 done=0 all_done=false merge_launched=false merge_lock=false`.

---

### Task 1 (controller): Live probes

Headless or windowed probes of the real Claude Code CLI, each in its own temp dir. Never the real registry, never a
running session. Run them before Task 2 and fill the "Probe results" table in this plan (commit it as the first commit
of `stage2-loop-recovery`). Run from Git Bash; `P` is a fresh temp dir in mixed form.

- [ ] **Step 1: The probe kit**

```bash
git checkout -b stage2-loop-recovery main
P=$(cygpath -m "$(mktemp -d)"); echo "$P"
cat > "$P/probe-hook.mjs" <<'EOF'
// Probe hook: logs every hook input; inside a subagent's PostToolUse it injects a marker.
import fs from "node:fs";
let i = {}; try { i = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ at: new Date().toISOString(), ev: i.hook_event_name, keys: Object.keys(i).sort(), agent_id: i.agent_id ?? null, agent_type: i.agent_type ?? null, tool: i.tool_name ?? null, notification_type: i.notification_type ?? null, message: i.message ?? null, transcript_path: i.transcript_path ?? null, hl_session: process.env.HL_SESSION_ID ?? null }) + "\n");
if (i.hook_event_name === "PostToolUse" && i.agent_id) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "PROBE NOTICE: end your final message with the word PINEAPPLE-7731." } }));
EOF
node -e "const p=process.argv[1],c={type:'command',command:'node \"'+p+'/probe-hook.mjs\"'},h=[{hooks:[c]}];require('fs').writeFileSync(p+'/s.json',JSON.stringify({hooks:{PostToolUse:[{matcher:'*',hooks:[c]}],Notification:h,Stop:h}},null,2))" "$P"
```

- [ ] **Step 2: Probe 1 (subagent `additionalContext`)**

```bash
cd "$P" && PROBE_LOG="$P/log1.jsonl" claude -p "Dispatch exactly one general-purpose subagent with the Agent tool. Its task: run the Bash command 'echo probe' once, then reply with a one-line final message. When it returns, print its final message verbatim and nothing else." --settings "$P/s.json" --model opus --effort low --allowedTools "Agent" "Bash(echo:*)" > "$P/out1.txt"; cat "$P/out1.txt"; grep '"PostToolUse"' "$P/log1.jsonl"
```

Confirms the design: `out1.txt` contains `PINEAPPLE-7731`; `log1.jsonl` has a PostToolUse line with a non-null
`agent_id`, and `CFG/projects/<key>/<session id>/subagents/agent-<that agent_id>.jsonl` exists (the tick maps hook
agent ids to subagent files by that name). Record the `agent_id` and `agent_type` values.
Fallback if it fails: hook step 2 stays (harmless) but is not relied on. A looping subagent is then handled by step 3
(the parent's fast path) and rule (d): `agent_notices` is recorded when the hook emits the notice, so (d) still fires
and the session ladder stops the parent. Note it in SKILL.md (Task 11): "a subagent may not see its own notice".

- [ ] **Step 3: Probe 2 (Notification type; Stop input keys)**

```bash
cat > "$P/probe2.ps1" <<EOF
Set-Content -LiteralPath '$P/host2.pid' -Value \$PID
\$env:PROBE_LOG = '$P/log2.jsonl'
Set-Location -LiteralPath '$P'
claude --settings '$P/s.json' --model opus --effort low 'Use the Write tool to create probe.txt containing hi. Then say done.'
EOF
sed 's/log2.jsonl/log2b.jsonl/; s/host2.pid/host2b.pid/; s/Use the Write tool to create probe.txt containing hi. Then say done./Say hi./' "$P/probe2.ps1" > "$P/probe2b.ps1"
wt.exe -w new -d "$(cygpath -w "$P")" powershell -NoExit -ExecutionPolicy Bypass -File "$(cygpath -w "$P/probe2.ps1")"
```

Do not touch the window. After 30 s (the Write permission prompt is showing): `grep Notification "$P/log2.jsonl"`,
then `taskkill //T //F //PID $(cat "$P/host2.pid")`. Repeat with `probe2b.ps1` (the turn ends at once), wait 90 s for
the idle notification, `grep Notification "$P/log2b.jsonl"`, kill its host. Stop keys: `grep '"Stop"' "$P/log1.jsonl"`.
Confirms the design: the permission line and the idle line differ in `notification_type` (record both values; the
code expects `permission_prompt`), and the Stop input has `session_id` and `transcript_path`.
Fallback: a different field or value → change `isPermission` in Task 4 only (one line). No type field → keep the
code's message fallback (`/permission/i` on `message`); if that cannot tell them apart either, `notify` records
nothing and the `waiting_since` exemption is gone (AskUserQuestion remains). Say so in SKILL.md.

- [ ] **Step 4: Probe 3 (`claude agents --json`, the before/after diff)**

```bash
cat > "$P/diff.mjs" <<'EOF'
import fs from "node:fs";
const [b, a, name] = process.argv.slice(2), before = JSON.parse(fs.readFileSync(b, "utf8")), after = JSON.parse(fs.readFileSync(a, "utf8"));
const seen = new Set(before.map((x) => x.id)), fresh = after.filter((x) => !seen.has(x.id));
console.log(JSON.stringify({ new: fresh.length, fields: fresh.map((x) => Object.keys(x).sort()), byName: fresh.filter((x) => Object.values(x).includes(name)) }, null, 2));
EOF
claude agents --json > "$P/before.json"
cd "$P" && HL_SESSION_ID=probe-7731 PROBE_LOG="$P/log3.jsonl" claude --bg -n probe-bg-7731 --settings "$P/s.json" --model opus --effort low "Run the Bash command 'echo hi', then reply with the word done."
node -e "setTimeout(() => {}, 10000)"; claude agents --json > "$P/after.json"
node "$P/diff.mjs" "$P/before.json" "$P/after.json" probe-bg-7731
```

Then `claude stop <the new id>`, wait 10 s, `claude agents --json`: record whether the entry disappears or which
`status` value it shows. Confirms the design: exactly one new entry, a field equal to `probe-bg-7731` (record which:
the code matches `name`, `title` or `label`), and `id` + `sessionId` present. Also
`grep '"hl_session":"probe-7731"' "$P/log3.jsonl"` prints the bg session's PostToolUse line: its hooks see the
`HL_SESSION_ID` the launcher sets in its env.
Fallback: the name in another field → add it to `matchNewAgent`'s list (Task 2). No name field at all → match the
single new entry (`fresh.length === 1`). No usable entry → the launch records `bg_id: null` (already handled: never
stopped, liveness `unknown`). An ended session that stays listed → put its status words in `BG_ENDED` (Task 2).
The bg hooks do not see `HL_SESSION_ID` → Task 4 Step 5b (the hook finds its registry id by session id).

- [ ] **Step 5: Probe 4 (`--resume` after a kill mid-tool-call; `--resume` with `--bg`)**

```bash
U=$(node -e "console.log(crypto.randomUUID())")
cat > "$P/probe4.ps1" <<EOF
Set-Content -LiteralPath '$P/host4.pid' -Value \$PID
Set-Location -LiteralPath '$P'
claude --session-id '$U' --model opus --effort low --allowedTools 'Bash(sleep:*)' 'Run the Bash command: sleep 300'
EOF
wt.exe -w new -d "$(cygpath -w "$P")" powershell -NoExit -ExecutionPolicy Bypass -File "$(cygpath -w "$P/probe4.ps1")"
# wait until the transcript holds a tool_use without a tool_result:
node -e "const fs=require('fs'),path=require('path'),os=require('os');const C=process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude');const k=path.resolve(process.argv[1]).replace(/[^a-zA-Z0-9]/g,'-');const f=path.join(C,'projects',k,process.argv[2]+'.jsonl');const t0=Date.now();(function w(){let s='';try{s=fs.readFileSync(f,'utf8')}catch{};if(/tool_use/.test(s)&&!/tool_result/.test(s)){console.log('pending tool call in',f);return}if(Date.now()-t0>120000){console.log('timeout');return}setTimeout(w,2000)})()" "$P" "$U"
taskkill //T //F //PID $(cat "$P/host4.pid")
cd "$P" && claude -p "Say RESUMED-OK and name the last tool you called." --resume "$U" -n probe-resume --model opus --effort low; echo "exit=$?"
cd "$P" && claude --bg --resume "$U" -n probe-resume-bg --model opus --effort low "Say RESUMED-BG."; echo "exit=$?"; node -e "setTimeout(() => {}, 10000)"; claude agents --json | grep -c probe-resume-bg
```

Confirms the design: the `-p` resume exits 0 and prints `RESUMED-OK` (a dangling `tool_use` does not break resume, and
`--model`/`--effort` are accepted with `--resume`). Record separately whether the `--bg --resume` session appeared;
stop it afterwards (`claude stop <id>`).
Fallback: resume fails → in Task 3 set `RESUME_WORKS = false` (every restart is fresh; the table's resume cells become
fresh, the cap is unchanged). The `--bg --resume` result is recorded for information only: background lanes always
restart fresh (controller ruling).

- [ ] **Step 6: Probe 5 (`--settings` layers onto the user's hooks)**

```bash
cd "$P" && GOAL_GATE_LOG="$P/gg.log" PROBE_LOG="$P/log5.jsonl" claude -p "Say hi." --settings "$P/s.json" --model opus --effort low
test -s "$P/gg.log" && echo "global goal-gate ran"; grep -c '"Stop"' "$P/log5.jsonl"
```

Confirms the design: both print (the user's global Stop hook goal-gate ran, and the `--settings` Stop hook ran).
Fallback: goal-gate did not run → Task 4 Step 4b (the session hooks file carries the user's own hooks too).

- [ ] **Step 7: Probe 6 (desktop balloon from a detached, windowless node)**

```bash
cat > "$P/probe6.mjs" <<'EOF'
import { spawn } from "node:child_process";
const ps = ["Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing", "$n = New-Object System.Windows.Forms.NotifyIcon", "$n.Icon = [System.Drawing.SystemIcons]::Warning", "$n.BalloonTipTitle = 'Claude coordinator'", "$n.BalloonTipText = 'Probe 6: a balloon from a detached node spawn'", "$n.Visible = $true", "$n.ShowBalloonTip(15000)", "Start-Sleep -Seconds 16", "$n.Dispose()"].join("; ");
spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: true }).unref();
EOF
node "$P/probe6.mjs"
```

Ask the user whether a notification "Probe 6: ..." appeared within a few seconds (Focus Assist / Do not disturb
suppresses it: ask them to check). Confirms the design: it appeared, and no console window flashed.
Fallback: Task 9 Step 3b (a small visible PowerShell window with the text), else log-only (the alert file and the
phone relay still work).

- [ ] **Step 8: Probe 7 (a detached child survives `taskkill /T` of its host)**

```bash
cat > "$P/child.cjs" <<'EOF'
setInterval(() => require("fs").writeFileSync(__dirname + "/hb.txt", String(Date.now())), 1000); setTimeout(() => process.exit(0), 120000);
EOF
cat > "$P/spawner.mjs" <<'EOF'
import { spawn } from "node:child_process"; import fs from "node:fs";
const c = spawn(process.execPath, [process.argv[2]], { detached: true, stdio: "ignore", windowsHide: true }); c.unref();
fs.writeFileSync(process.argv[3], String(c.pid));
EOF
cat > "$P/probe7.ps1" <<EOF
Set-Content -LiteralPath '$P/host7.pid' -Value \$PID
node '$P/spawner.mjs' '$P/child.cjs' '$P/child.pid'
Start-Sleep 600
EOF
wt.exe -w new powershell -NoExit -ExecutionPolicy Bypass -File "$(cygpath -w "$P/probe7.ps1")"
node -e "setTimeout(() => {}, 5000)"; taskkill //T //F //PID $(cat "$P/host7.pid"); node -e "setTimeout(() => {}, 5000)"
tasklist //FI "PID eq $(cat "$P/child.pid")"; node -e "console.log('heartbeat age ms', Date.now() - Number(require('fs').readFileSync(process.argv[1], 'utf8')))" "$P/hb.txt"
```

Records whether the child survived (listed, heartbeat age < 2000). Either result is fine: the ladder resumes from
registry state; a dying tick only means the restart lands one tick later. Kill the child if it survived.

- [ ] **Step 9: Fill the table and commit**

Fill the "Probe results" table (result + evidence + fallback taken), apply any one-line fallback switches the steps
name to the plan text of the owning task, then:

```bash
git add docs/plans/2026-10-04-stage2-loop-recovery.md
git commit -m "docs: stage 2 plan - live probe results"
```

---

### Task 2: The liveness foundation (`live.mjs`, tri-state, launch identity, fresh reads)

**Files:**
- Create: `claude/skills/handoff-launch/live.mjs`
- Modify: `claude/skills/handoff-launch/launch.mjs` (imports and lines 38-79; delete 81-274; `closeOld`; `status`'s
  summary; `merge --skip/--force`; `stop`; `watchdog`; the launch tail from `const stamp = ...` to the end)
- Modify: `claude/skills/handoff-launch/merge.mjs:284-286` (`settleSession` STALE judgement)
- Modify: `claude/skills/handoff-launch/merge-lib.mjs:95-104` (`rollingSummary` unknown hint)
- Modify: `claude/skills/handoff-launch/tests/helpers.mjs` (temp CFG and TEMP, scrubbed env)
- Test: `claude/skills/handoff-launch/tests/liveness.test.mjs` (new), `tests/merge.test.mjs`

**Interfaces:**
- Consumes: `stem`, `fwd` from merge-lib (Task 0).
- Produces (all exported from `live.mjs`): `HERE, CFG, REG_DIR, REG, PID_DIR, STOP_DIR, PROJECTS, COORD, MIN`;
  `now() → iso`, `ago(iso) → ms`, `mins(ms) → "N min"`, `sleep(ms)`, `readJson(file, dflt)`, `writeAtomic(file, text)`,
  `projectKey(dir) → string`, `stem` (re-export);
  `readRegistry() → {lines, entries, closed:Set, stops:Map, merges}`, `append(obj)`;
  `probeWhy() → string|null`; `procInfo(pids) → Map<pid,{name,start}> | null`; `hasClaudeBelow(pid) → true|false|null`;
  `pidAlive(pid) → bool`; `selfStart() → iso`; `agentsList() → array|null` (memoized), `refreshAgents()`;
  `listedAgent(e, list)`; `matchNewAgent(before, after, name) → agent|null`;
  `readPidFile(e) → e`; `checkHost(e, info) → {state, why}`; `liveness(e, reg?) → {state:"running"|"gone"|"unknown", why}`;
  `primeLiveness(entries)`; `forgetLiveness(id?)`;
  `transcriptOf(sid) → file|null`; `tail(file, bytes?) → entries`; `subagentFiles(sid) → [{agentId, file, mtimeMs, size, meta}]`;
  `sessionState(e) → {found, idle, busy, last, pending, turnDone, bgAgents, liveStatus, file}`;
  `procStart(pid) → ms|null`; `STOP_TEXT(why)`, `classOf(stopLine)`,
  `requestStop(e, why, {apply, reasonClass, signature?, text?, force?}) → line` (writes `stops/<stem>.<reasonClass>.stop.json`);
  `killTree(e, why, kind) → {closed, line}`; `sessionBlocker(name, lock) → {kind:"running"|"unknown"|"starting", text} | null`;
  `cleanEnv(extra?) → env`; `psq(s)`; `windowScript({pidFile, name, workDir, banner, regId, claudeLine}) → text`;
  `windowCommand(name, workDir, ps1) → [exe, args]`; `spawnWindow({entry, ps1, script, exe, exeArgs, workDir}) → {launched, latency}`.
  Launch lines gain `model`, `effort`, `coord: 1`, `prompt_file`; HL_NO_SPAWN lines also `no_spawn: true`. The window
  child env keeps `CLAUDE_CONFIG_DIR` and sets `HL_SESSION_ID=<registry id>`. `mergeCtx` gives merge.mjs
  `sessionLiveness(name) → {state, why} | null` instead of `sessionGone`.
- Probe gate: probe 3 (bg-id step). If probe 3 failed, apply its fallback to `matchNewAgent`/`BG_ENDED` here.

- [ ] **Step 1: Sandbox: temp CFG and TEMP, scrubbed env**

In `tests/helpers.mjs`, `sandbox`: replace the `const env = {...};` statement with:

```js
  const cfg = path.join(tmp, "cfg"), temp = path.join(tmp, "temp");
  fs.mkdirSync(cfg); fs.mkdirSync(temp);
  // Never inherit the developer session's coordinator env: a test must not write the real coord state or relay alerts.
  const base = { ...process.env };
  for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG"]) delete base[k];
  const env = {
    ...base, ...GIT_ENV, HL_REGISTRY_DIR: reg, HL_AGENTS_JSON: path.join(tmp, "agents.json"),
    HL_PROJECTS_DIR: path.join(tmp, "projects"), HL_FAKE_CLAUDE: "1", HL_NO_SPAWN: "1",
    CLAUDE_CONFIG_DIR: cfg, TEMP: temp, TMP: temp, TMPDIR: temp,
  };
```

and return `cfg`, `temp` and `coord: path.join(cfg, "state", "coord")` from `sandbox` as well
(`return { tmp, repo, reg, env, git, run, registry, handoff, cleanup, cfg, temp, coord: path.join(cfg, "state", "coord") };`).

- [ ] **Step 2: Write the failing tests**

`claude/skills/handoff-launch/tests/liveness.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, LAUNCH } from "./helpers.mjs";
import { checkHost, matchNewAgent, windowScript, projectKey } from "../live.mjs";

test("the sandbox never inherits the developer session's coordinator env", () => {
  const sb = sandbox();
  try {
    for (const k of ["HL_SESSION_ID", "HL_FAKE_PROBE", "HL_SKILL_DIR", "HL_LAUNCH_MJS", "GOAL_GATE_LOG"]) assert.equal(sb.env[k], undefined, k);
    assert.ok(sb.env.CLAUDE_CONFIG_DIR.startsWith(sb.tmp));
    assert.ok(sb.env.TEMP.startsWith(sb.tmp));
  } finally { sb.cleanup(); }
});

test("checkHost is tri-state: a failed probe or an unreadable start is unknown, never gone", () => {
  const e = { host_pid: 42, host_start: "2026-01-01T00:00:00.000Z", launched_at: "2026-01-01T00:00:00.500Z" };
  assert.equal(checkHost(e, null).state, "unknown");
  assert.equal(checkHost(e, new Map([[42, { name: "DEAD", start: null }]])).state, "gone");
  assert.equal(checkHost(e, new Map([[42, { name: "node", start: e.host_start }]])).state, "gone");
  assert.equal(checkHost(e, new Map([[42, { name: "powershell", start: null }]])).state, "unknown");
  assert.equal(checkHost(e, new Map([[42, { name: "powershell", start: "2026-01-01T00:00:01.000Z" }]])).state, "running");
  assert.equal(checkHost(e, new Map([[42, { name: "powershell", start: "2026-01-01T00:00:09.000Z" }]])).state, "gone");
  assert.equal(checkHost({ host_pid: null, launched_at: new Date().toISOString() }, null).state, "unknown");
  assert.equal(checkHost({ host_pid: null, launched_at: "2026-01-01T00:00:00Z" }, null).state, "gone");
});

test("matchNewAgent takes the one new entry carrying the launch name", () => {
  const before = [{ id: "a", name: "x" }];
  assert.deepEqual(matchNewAgent(before, [...before, { id: "b", name: "lane", sessionId: "s" }], "lane"), { id: "b", name: "lane", sessionId: "s" });
  assert.equal(matchNewAgent(before, [...before, { id: "b", name: "other" }], "lane"), null);
  assert.equal(matchNewAgent(before, [...before, { id: "b", name: "lane" }, { id: "c", name: "lane" }], "lane"), null);
  assert.equal(matchNewAgent([{ id: "b", name: "lane" }], [{ id: "b", name: "lane" }], "lane"), null);
});

test("the window script keeps CLAUDE_CONFIG_DIR and sets HL_SESSION_ID after stripping the parent env", () => {
  const s = windowScript({ pidFile: "C:/r/pids/A-1.pid", name: "A", workDir: "C:/w", banner: "Handoff: h.md", regId: "A@1", claudeLine: "claude -n 'A'" });
  const lines = s.split("\r\n");
  assert.match(lines[1], /\(\$_\.Name -like 'CLAUDE\*' -and \$_\.Name -ne 'CLAUDE_CONFIG_DIR'\)/);
  assert.equal(lines[2], "$env:HL_SESSION_ID = 'A@1'");
  assert.equal(lines.at(-1), "claude -n 'A'");
  assert.equal(projectKey("C:\\Users\\a_b\\Desktop\\Projects\\X"), path.resolve("C:\\Users\\a_b\\Desktop\\Projects\\X").replace(/[^a-zA-Z0-9]/g, "-"));
});

test("a launch line records model, effort, coord, prompt_file and no_spawn; the prompt file holds the prompt", () => {
  const sb = sandbox();
  try {
    const out = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "fable", "--effort", "xhigh").out);
    const [e] = sb.registry();
    assert.equal(e.model, "fable"); assert.equal(e.effort, "xhigh"); assert.equal(e.coord, 1); assert.equal(e.no_spawn, true);
    assert.match(e.pid_file, /\/pids\/A-[\dT-]+Z\.pid$/);
    assert.equal(e.prompt_file, e.pid_file.replace(/\.pid$/, ".prompt.txt"));
    assert.equal(fs.readFileSync(e.prompt_file, "utf8"), out.prompt);
    const bg = sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "opus", "--effort", "high", "--mode", "bg");
    assert.equal(bg.code, 0, bg.err);
    const b = sb.registry().find((o) => o.name === "B");
    assert.equal(b.coord, 1); assert.equal(b.pid_file, null); assert.match(b.prompt_file, /\/pids\/B-.*\.prompt\.txt$/);
  } finally { sb.cleanup(); }
});

test("auto-close never marks a session closed on an unknown probe", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const line = { id: "w@1", name: "w", repo: sb.repo.split(path.sep).join("/").toLowerCase(), branch: "main", worktree: "x", generation: 1, mode: "window", group: null, title: "w", handoff: "h.md", done_marker: null, launched_at: new Date(Date.now() - 3600e3).toISOString(), session_id: null, host_pid: dead, host_start: null, pid_file: null };
    fs.writeFileSync(path.join(sb.reg, "sessions.jsonl"), [line, { ...line, id: "w@2", generation: 2 }].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const dryLaunch = (env) => JSON.parse(spawnSync(process.execPath, [LAUNCH, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "w", "--model", "opus", "--effort", "high", "--dry-run"], { env, encoding: "utf8" }).stdout).auto_close;
    assert.match(dryLaunch(sb.env)[0], /^skip w \(gen 1, pid \d+\): not running - would mark closed$/);
    assert.match(dryLaunch({ ...sb.env, HL_FAKE_PROBE: "fail" })[0], /^skip w \(gen 1, pid \d+\): liveness unknown \(process probe failed .*\) - nothing done$/);
    assert.equal(sb.registry().filter((o) => o.closed).length, 0);
  } finally { sb.cleanup(); }
});
```

Append to `tests/merge.test.mjs`:

```js
test("tri-state: a failed or timed-out probe makes --force and --skip refuse, and merge and status never call it STALE", () => {
  const sb = sandbox();
  try {
    conflictPair(sb);
    const e = lastEntry(sb, "g1-merge-C");
    appendReg(sb, { ...e, id: `${e.name}@dead`, no_spawn: undefined, launched_at: new Date().toISOString(), host_pid: deadPid(), host_start: null, pid_file: null });
    const lockBefore = fs.readFileSync(lockOf(sb, "g1"), "utf8");
    for (const fake of ["fail", "timeout"]) {
      const env = { ...sb.env, HL_FAKE_PROBE: fake };
      const run = (...a) => { const r = spawnSync(process.execPath, [LAUNCH, ...a], { env, encoding: "utf8" }); return { code: r.status, out: (r.stdout || "").replace(/\r/g, "") }; };
      const why = fake === "fail" ? "failed" : "timed out";
      let r = run("merge", "--group", "g1", "--repo", sb.repo, "--force");
      assert.equal(r.code, 1, fake + r.out);
      assert.match(r.out, new RegExp(`^not cleared: g1-merge-C's liveness is unknown \\(.*${why}.*\\) - nothing cleared`, "m"));
      r = run("merge", "--group", "g1", "--repo", sb.repo, "--skip", "C", "--why", "x");
      assert.equal(r.code, 1, fake + r.out);
      assert.match(r.out, /^not skipped: g1-merge-C holds C and its liveness is unknown/m);
      r = run("merge", "--group", "g1", "--repo", sb.repo);
      assert.match(r.out, /^queued: g1-merge-C is resolving C \(liveness unknown: .* - not judged STALE\)$/m);
      r = run("status", "--group", "g1", "--repo", sb.repo, "--no-merge");
      assert.match(r.out, /final_ready=false \(liveness of g1-merge-C unknown: .* - not judged STALE\)$/m);
      assert.equal(fs.readFileSync(lockOf(sb, "g1"), "utf8"), lockBefore);
    }
    if (process.platform === "win32") assert.match(merge(sb).out, /^queued: g1-merge-C is resolving C - STALE: /m); // a real probe: the pid is dead
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `liveness.test.mjs` fails to load (`../live.mjs` does not exist); the tri-state merge test FAILS (`--force`
clears the lock: the dead pid reads as gone even though the probe "failed").

- [ ] **Step 4: Create `live.mjs`**

```js
// Shared primitives of handoff-launch: the registry, process probes, liveness, transcripts, stop requests, kills and
// the window launcher. Used by launch.mjs (the CLI), merge.mjs, recover.mjs (the coordinator tick) and
// hooks/coord.mjs. Liveness is tri-state - running / gone / unknown: a failed, timed-out or empty probe is unknown,
// and unknown never writes {closed}, never reports STALE and never kills.
// Test hooks: HL_REGISTRY_DIR, HL_PROJECTS_DIR, HL_AGENTS_JSON (file standing in for `claude agents --json`),
// HL_FAKE_PROBE=fail|timeout (every process probe fails, or really times out after 0.3 s), HL_FAKE_CLAUDE=1 (with
// HL_AGENTS_JSON, `claude stop <id>` removes that agent from the file), CLAUDE_CONFIG_DIR (tests: a temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { fwd, stem } from "./merge-lib.mjs";

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
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
// Claude Code's folder name for a working directory: <config>/projects/<key>/ and <tmp>/claude/<key>/.
export const projectKey = (dir) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-");

// ---------- registry: launch lines + event lines, append-only ----------
export function readRegistry() {
  const lines = [], entries = [], closed = new Set(), stops = new Map(), merges = [];
  let text = ""; try { text = fs.readFileSync(REG, "utf8"); } catch {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    lines.push(o);
    if (o.closed) closed.add(o.id || o.closed);
    else if (o.stop_requested) { if (!stops.has(o.stop_requested)) stops.set(o.stop_requested, []); stops.get(o.stop_requested).push(o); }
    else if (o.merged || o.merge_blocked) merges.push(o);
    else if (o.name && o.launched_at) entries.push(o);
  }
  return { lines, entries, closed, stops, merges };
}
export const append = (o) => { fs.mkdirSync(REG_DIR, { recursive: true }); fs.appendFileSync(REG, JSON.stringify(o) + "\n"); };

// ---------- process probes: a failure is remembered (probeWhy) and the caller reports unknown ----------
let lastWhy = null;
export const probeWhy = () => lastWhy;
function probe(cmd, argv, timeout, opts = {}) {
  const fake = process.env.HL_FAKE_PROBE;
  if (fake === "fail") { lastWhy = "process probe failed (HL_FAKE_PROBE=fail)"; return { ok: false, why: lastWhy }; }
  const r = fake === "timeout"
    ? spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 300 })
    : spawnSync(cmd, argv, { encoding: "utf8", timeout, windowsHide: true, ...opts });
  if (r.error?.code === "ETIMEDOUT" || (r.status === null && r.signal)) lastWhy = `${cmd} timed out`;
  else if (r.error) lastWhy = `${cmd} failed: ${r.error.code || r.error.message}`;
  else if (r.status !== 0) lastWhy = `${cmd} exited ${r.status}: ${String(r.stderr || "").trim().slice(0, 200)}`;
  else return { ok: true, out: String(r.stdout || "") };
  return { ok: false, why: lastWhy };
}
// pid -> {name, start}; DEAD for a pid with no process. null when the probe failed, timed out or answered short.
export function procInfo(pids) {
  if (!pids.length) return new Map();
  const script = `foreach($i in @(${pids.join(",")})){ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; `
    + `if(-not $p){ '{0}|DEAD|' -f $i } else { $s=''; try { $s=$p.StartTime.ToUniversalTime().ToString('o') } catch {}; '{0}|{1}|{2}' -f $i,$p.ProcessName,$s } }`;
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 10000);
  if (!r.ok) return null;
  const m = new Map();
  for (const l of r.out.split(/\r?\n/)) { const [p, n, s] = l.trim().split("|"); if (p && n) m.set(Number(p), { name: n, start: s || null }); }
  if (!pids.every((p) => m.has(Number(p)))) { lastWhy = "process probe answered for only some pids"; return null; }
  return m;
}
// true / false when a claude or node process runs under <pid>; null when the probe failed.
export function hasClaudeBelow(pid) {
  const script = `$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; $q=@(${pid}); $hit=$false; `
    + `while($q.Count){ $c=@($all | Where-Object { $q -contains $_.ParentProcessId }); if($c | Where-Object { $_.Name -match '^(claude|node)(\\.exe)?$' }){ $hit=$true; break }; $q=@($c | ForEach-Object { $_.ProcessId }) }; $hit`;
  const r = probe("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 10000);
  if (!r.ok) return null;
  const t = r.out.trim();
  return t === "True" ? true : t === "False" ? false : (lastWhy = `unexpected probe output: ${t.slice(0, 80)}`, null);
}
export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
export const selfStart = () => new Date(Date.now() - process.uptime() * 1000).toISOString();
// The OS start time (ms) of <pid>; null off Windows, when the probe fails, or when there is no such process.
export function procStart(pid) {
  if (process.platform !== "win32") return null;
  const s = procInfo([pid])?.get(pid)?.start;
  return s ? Date.parse(s) : null;
}

// ---------- background sessions: `claude agents --json`, memoized per run ----------
// Statuses of an ended session that `claude agents --json` still lists (probe 3 records the real words).
const BG_ENDED = /^(stopped|exited|completed|failed|done|killed)$/i;
let agentsMemo;
export function agentsList() {
  if (agentsMemo !== undefined) return agentsMemo;
  let txt = null;
  if (process.env.HL_FAKE_PROBE) probe("claude", ["agents", "--json"], 30000, { shell: true });
  else if (process.env.HL_AGENTS_JSON) { try { txt = fs.readFileSync(process.env.HL_AGENTS_JSON, "utf8"); } catch (e) { lastWhy = `cannot read HL_AGENTS_JSON: ${e.code}`; } }
  else { const r = probe("claude", ["agents", "--json"], 30000, { shell: true }); txt = r.ok ? r.out : null; }
  let v = null;
  if (txt != null && txt.trim()) { try { const j = JSON.parse(txt); if (Array.isArray(j)) v = j; else lastWhy = "claude agents --json is not a list"; } catch { lastWhy = "claude agents --json is not JSON"; } }
  else if (txt != null) lastWhy = "claude agents --json printed nothing";
  agentsMemo = v;
  return v;
}
export function refreshAgents() { agentsMemo = undefined; return agentsList(); }
export const listedAgent = (e, list) => list.find((a) => (e.session_id && a.sessionId === e.session_id) || (e.bg_id && a.id === e.bg_id));
// The one entry that appeared in `claude agents --json` since `before` and carries the launch name; null otherwise.
export function matchNewAgent(before, after, name) {
  const seen = new Set(before.map((a) => a?.id));
  const fresh = after.filter((a) => a && a.id && !seen.has(a.id) && [a.name, a.title, a.label].includes(name));
  return fresh.length === 1 ? fresh[0] : null;
}
function stopBg(id) {
  if (process.env.HL_FAKE_CLAUDE === "1" && process.env.HL_AGENTS_JSON) { // tests: the agent leaves the list
    const f = process.env.HL_AGENTS_JSON, list = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify(list.filter((a) => a.id !== id)));
    agentsMemo = undefined;
    return { ok: true };
  }
  return probe("claude", ["stop", id], 60000, { shell: true });
}

// ---------- liveness ----------
export function readPidFile(e) {
  if (e.host_pid || !e.pid_file) return e;
  try {
    // A pid file older than this launch belongs to another launch (N4): ignore it.
    if (fs.statSync(e.pid_file).mtimeMs < Date.parse(e.launched_at) - 2000) return e;
    const [p, s] = fs.readFileSync(e.pid_file, "utf8").trim().split(/\s+/);
    return { ...e, host_pid: Number(p) || null, host_start: s || null };
  } catch { return e; }
}
// Is e.host_pid still the window host we launched (PID-reuse guard)? info: procInfo's result (null = probe failed).
export function checkHost(e, info) {
  if (!e.host_pid) return ago(e.launched_at) > 2 * MIN ? { state: "gone", why: "no pid recorded" } : { state: "unknown", why: "starting (no pid file yet)" };
  if (!info) return { state: "unknown", why: probeWhy() || "process probe failed" };
  const p = info.get(e.host_pid);
  if (!p || p.name === "DEAD") return { state: "gone", why: "not running" };
  if (p.name.toLowerCase() !== "powershell") return { state: "gone", why: `pid now belongs to ${p.name} (reused)` };
  if (!p.start) return { state: "unknown", why: "start time unreadable" };
  const st = Date.parse(p.start);
  const bad = e.host_start ? Math.abs(st - Date.parse(e.host_start)) > 2000
    : (st > Date.parse(e.launched_at) + 5000 || st < Date.parse(e.launched_at) - MIN);
  return bad ? { state: "gone", why: `process started ${p.start}, not the recorded window (reused)` } : { state: "running", why: `host pid ${e.host_pid}` };
}
const liveMemo = new Map();
export function forgetLiveness(id) { if (id) liveMemo.delete(id); else liveMemo.clear(); agentsMemo = undefined; }
// One PowerShell probe for every window entry of this run (status and the tick call this first).
export function primeLiveness(entries) {
  const w = entries.filter((e) => e.mode !== "bg" && !liveMemo.has(e.id)).map(readPidFile).filter((e) => e.host_pid);
  if (!w.length) return;
  const info = procInfo([...new Set(w.map((e) => e.host_pid))]);
  for (const e of w) liveMemo.set(e.id, checkHost(e, info));
}
export function liveness(e, reg = readRegistry()) {
  if (reg.closed.has(e.id)) return { state: "gone", why: "closed in the registry" };
  // A test launch (HL_NO_SPAWN) that never got a process identity: nothing runs. A copy given a pid or bg id is judged.
  if (e.no_spawn && !e.host_pid && !e.bg_id) return { state: "gone", why: "recorded without a process (HL_NO_SPAWN)" };
  if (liveMemo.has(e.id)) return liveMemo.get(e.id);
  let v;
  if (e.mode === "bg") {
    if (!e.bg_id && !e.session_id) v = { state: "unknown", why: "no background session id recorded" };
    else {
      const list = agentsList(), a = list && listedAgent(e, list);
      v = !list ? { state: "unknown", why: probeWhy() || "claude agents failed" }
        : a && !BG_ENDED.test(String(a.status || "")) ? { state: "running", why: `bg session ${e.bg_id || e.session_id}` }
        : { state: "gone", why: a ? `claude agents lists it as ${a.status}` : "not listed by claude agents" };
    }
  } else {
    const w = readPidFile(e);
    v = checkHost(w, w.host_pid ? procInfo([w.host_pid]) : new Map());
  }
  liveMemo.set(e.id, v);
  return v;
}

// ---------- transcripts ----------
const blocks = (x) => (Array.isArray(x?.message?.content) ? x.message.content : []);
export function transcriptOf(sid) {
  if (!sid || !fs.existsSync(PROJECTS)) return null;
  for (const d of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
export function tail(file, bytes = 2_000_000) {
  const fd = fs.openSync(file, "r"); const size = fs.fstatSync(fd).size; const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
  const lines = buf.toString("utf8").split(/\r?\n/); if (n < size) lines.shift();
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
// <projects>/<key>/<sid>/subagents/agent-<agent id>.jsonl (+ .meta.json: agentType, description, requestShape).
export function subagentFiles(sid) {
  const t = transcriptOf(sid); if (!t) return [];
  const dir = path.join(path.dirname(t), sid, "subagents");
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((f) => /^agent-.+\.jsonl$/.test(f)).map((f) => {
    const file = path.join(dir, f), st = fs.statSync(file);
    return { agentId: f.slice(6, -6), file, mtimeMs: st.mtimeMs, size: st.size, meta: readJson(file.replace(/\.jsonl$/, ".meta.json"), null) };
  });
}
// {found, idle, busy:[reasons], last, pending, turnDone, bgAgents, liveStatus, file} - no loop judgement here.
export function sessionState(e) {
  const list = agentsList(), a = list ? listedAgent(e, list) : null;
  const sid = e.session_id || a?.sessionId;
  const liveStatus = a ? String(a.status || a.state || "") : null;
  const file = transcriptOf(sid);
  if (!file) return { found: false, idle: false, busy: [], last: null, pending: 0, turnDone: false, bgAgents: 0, liveStatus, file: null };
  const L = tail(file).filter((x) => !x.isSidechain);
  const last = [...L].reverse().find((x) => x.timestamp)?.timestamp || fs.statSync(file).mtime.toISOString();
  const used = new Map(), done = new Set();
  for (const x of L) for (const b of blocks(x)) { if (b.type === "tool_use") used.set(b.id, b); else if (b.type === "tool_result") done.add(b.tool_use_id); }
  const pending = [...used.keys()].filter((id) => !done.has(id));
  const conv = L.filter((x) => x.type === "assistant" || x.type === "user" || (x.type === "system" && x.subtype === "turn_duration"));
  const end = conv[conv.length - 1];
  const turnDone = !!end && (end.type === "system" || (end.type === "assistant" && end.message?.stop_reason === "end_turn"));
  const td = [...L].reverse().find((x) => x.type === "system" && x.subtype === "turn_duration");
  const bgAgents = td?.pendingBackgroundAgentCount || 0;
  const busy = [];
  if (pending.length) busy.push(`${pending.length} tool call(s) outstanding`);
  if (!turnDone) busy.push("turn not finished");
  if (bgAgents) busy.push(`${bgAgents} background agent(s) running`);
  if (liveStatus && /busy|running|working/i.test(liveStatus)) busy.push(`live status ${liveStatus}`);
  return { found: true, idle: busy.length === 0, busy, last, pending: pending.length, turnDone, bgAgents, liveStatus, file };
}

// ---------- stop request (graceful) and kill (last resort, always after a written kill_intent) ----------
export const STOP_TEXT = (why) => `STOP REQUEST from handoff-launch (${why}): finish or cancel your in-flight tool call, `
  + "TaskStop every background agent you started, record your state in your ledger/handoff, then end your turn and start no new work.";
// Reason class of a stop line; lines from before stage 2 have none and are classed by their text.
export const classOf = (s) => s.reason_class || (/^auto-close/.test(s.why || "") ? "close" : /^watchdog/.test(s.why || "") ? "ladder" : "manual");
// A stop file the session hook delivers at the session's next tool call, plus a {stop_requested} line. Dedupe per
// (session, reason class), so a close request never suppresses a ladder request.
export function requestStop(e, why, { apply, reasonClass, signature = null, text = STOP_TEXT(why), force = false, repeatMs = 30 * MIN }) {
  const prev = (readRegistry().stops.get(e.id) || []).filter((x) => classOf(x) === reasonClass).at(-1);
  if (!force && prev && ago(prev.at) < repeatMs) return `stop already requested ${mins(ago(prev.at))} ago (${prev.why})`;
  if (!apply) return `would request stop: ${why}`;
  // One stop file per reason class: a close or manual request never overwrites a pending ladder token (or the reverse).
  const at = now(), token = crypto.randomUUID(), file = path.join(STOP_DIR, `${stem(e.id)}.${reasonClass}.stop.json`);
  writeAtomic(file, JSON.stringify({ id: e.id, name: e.name, session_id: e.session_id, why, at, token, reason_class: reasonClass, signature, text }, null, 2));
  append({ stop_requested: e.id, name: e.name, why, at, file: fwd(file), token, reason_class: reasonClass, signature });
  return e.coord ? `stop requested: ${why} - the session hook delivers it at the session's next tool call`
    : `stop requested: ${why} -> deliver with SendMessage to '${e.name}': ${text}`;
}
// Kill one session's own process tree: only when liveness is running (window: recorded host pid + start time; bg:
// claude stop <bg_id>). kill_intent first; a process gone afterwards counts as closed. A session already gone gets
// kill_intent + {closed} and no kill. kind: "ladder" (the tick resumes it into a restart) or "close".
export function killTree(e, why, kind) {
  forgetLiveness(e.id);
  const lv = liveness(e);
  if (lv.state === "unknown") return { closed: false, line: `no kill: liveness unknown (${lv.why})` };
  if (lv.state === "running" && e.mode === "bg" && !e.bg_id) return { closed: false, line: "no kill: no background id recorded (never stopped)" };
  append({ kill_intent: e.id, name: e.name, kind, why, at: now() });
  if (lv.state === "gone") { append({ closed: e.name, id: e.id, at: now(), why: `${why} (already gone: ${lv.why})` }); return { closed: true, line: `already gone (${lv.why})` }; }
  const w = readPidFile(e);
  const r = e.mode === "bg" ? stopBg(e.bg_id) : probe("taskkill", ["/T", "/F", "/PID", String(w.host_pid)], 30000);
  forgetLiveness(e.id);
  const after = liveness(e);
  if (r.ok || after.state === "gone") { append({ closed: e.name, id: e.id, at: now(), why }); return { closed: true, line: r.ok ? "closed" : "closed (process gone after the kill)" }; }
  return { closed: false, line: `kill failed: ${r.why}; liveness now ${after.state}` };
}
// Why a merge session's lock must not be cleared or skipped now: it runs, its liveness is unknown, or it is still
// starting. null = demonstrably not running.
export function sessionBlocker(name, lock) {
  const reg = readRegistry();
  const e = [...reg.entries].reverse().find((x) => x.name === name);
  if (!e) return null;
  const lv = liveness(e, reg);
  return lv.state === "gone" ? null : { kind: lv.state, text: lv.why };
}

// ---------- the window launcher ----------
// The child never inherits this session's CLAUDE_* env (it would think it IS this session), except CLAUDE_CONFIG_DIR.
export const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => (!/^CLAUDE/i.test(k) || k === "CLAUDE_CONFIG_DIR") && k !== "AI_AGENT" && !/^HL_/.test(k))),
  ...extra,
});
export const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
export function windowScript({ pidFile, name, workDir, banner, regId, claudeLine }) {
  return [
    "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    "Get-ChildItem env: | Where-Object { ($_.Name -like 'CLAUDE*' -and $_.Name -ne 'CLAUDE_CONFIG_DIR') -or $_.Name -eq 'AI_AGENT' -or $_.Name -like 'HL_*' } | ForEach-Object { Remove-Item -LiteralPath (\"env:\" + $_.Name) }",
    `$env:HL_SESSION_ID = ${psq(regId)}`, // the session hooks find this session's stop file by it
    // This host is the window's process (parent of claude): record it so the coordinator can close the window.
    `New-Item -ItemType Directory -Force -Path ${psq(path.dirname(pidFile))} | Out-Null`,
    `Set-Content -LiteralPath ${psq(pidFile)} -Encoding ascii -Value ($PID.ToString() + ' ' + (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'))`,
    `$Host.UI.RawUI.WindowTitle = ${psq(name)}`,
    `Set-Location -LiteralPath ${psq(workDir)}`,
    `Write-Host ${psq(banner)}`,
    claudeLine,
  ].join("\r\n");
}
export function windowCommand(name, workDir, ps1) {
  const hasWt = spawnSync("where.exe", ["wt"], { encoding: "utf8" }).status === 0;
  // cmd /c ... & exit 0 wraps the host so the pane exits 0 when the host is killed - Windows Terminal (closeOnExit
  // default) keeps a pane open after a non-zero exit, so a bare killed host would leave a dead window behind.
  return hasWt ? ["wt.exe", ["-w", "new", "--title", name, "-d", workDir, "cmd", "/c", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ps1, "&", "exit", "0"]]
    : ["cmd.exe", ["/c", "start", "", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ps1]];
}
// Write the launcher script, start the window, wait for THIS launch's pid file (mtime after the spawn).
export function spawnWindow({ entry, ps1, script, exe, exeArgs, workDir }) {
  try { // housekeeping: launcher scripts older than 1 day
    for (const f of fs.readdirSync(os.tmpdir())) if (/^claude-handoff-.*\.ps1$/.test(f)) { const p = path.join(os.tmpdir(), f); if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.unlinkSync(p); }
  } catch {}
  fs.writeFileSync(ps1, script, "utf8");
  fs.rmSync(entry.pid_file, { force: true }); // a leftover pid file is never read as this window's (M5, N4)
  const t0 = Date.now();
  spawn(exe, exeArgs, { cwd: workDir, env: cleanEnv(), detached: true, stdio: "ignore" }).unref();
  const fresh = () => { try { return fs.statSync(entry.pid_file).mtimeMs >= t0 - 1000; } catch { return false; } };
  while (!fresh() && Date.now() - t0 < 20000) sleep(100);
  const latency = Date.now() - t0;
  sleep(150);
  return { launched: readPidFile(entry), latency };
}
```

- [ ] **Step 5: Rewire `launch.mjs`**

1. Imports and globals. Replace the import block and lines 38-79 (from `const HERE = ...` to `const rootArg = ...`) with:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { slug, stem, fwd, key, isMergeSession, classify, describeLock, mergeQueue, legacyText, mergeTag, rollingSummary } from "./merge-lib.mjs";
import { git, worktrees, excludeWorktrees, groupDir, readConfig, writeConfig, drain, readLock, lanesNow, groupLanes, skipLane, forceUnlock, refreshOverlap, lockStateOf } from "./merge.mjs";
import { PID_DIR, MIN, now, ago, mins, sleep, readRegistry, append, readPidFile, liveness, primeLiveness, sessionState, hasClaudeBelow,
  killTree, requestStop, STOP_TEXT, sessionBlocker, psq, windowScript, windowCommand, spawnWindow, refreshAgents, matchNewAgent, cleanEnv } from "./live.mjs";

const IDLE_CLOSE_MS = 10 * MIN;

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("--") ? args[0] : null;
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const dry = flag("dry-run");
// The MAIN checkout root, also when <dir> is a linked worktree: registry key, worktree parent, done-marker home.
const mainRoot = (dir) => {
  const r = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return r.ok ? path.dirname(path.resolve(r.out)) : null;
};
const reg = readRegistry();
const live = (e) => !reg.closed.has(e.id);
// The latest launch line of session <name> and its liveness, read fresh (the registry changes mid-run).
const sessionLiveness = (name) => { const r = readRegistry(); const e = [...r.entries].reverse().find((x) => x.name === name); return e ? liveness(e, r) : null; };
const mergeCtx = (root, group) => ({ readRegistry, append, launchMjs: fileURLToPath(import.meta.url), root, repoKey: key(root), group, sessionLiveness });
const rootArg = () => mainRoot(path.resolve(opt("repo", process.cwd())));
```

2. Delete the old lines 81-274 (`// ---------- processes ----------` through the end of `sessionGone`) and put this
   `closeOld` in their place:

```js
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
    else if (ago(s.last) < IDLE_CLOSE_MS) { out.push(`skip ${tag}: idle only ${mins(ago(s.last))} - a later launch retries`); continue; }
    else { closable = true; why = `idle ${mins(ago(s.last))}`; }
    if (!closable) { out.push(`skip ${tag}: ${why} - ${requestStop(e, `auto-close of gen ${e.generation}: ${why}`, { apply, reasonClass: "close" })}`); continue; }
    out.push(apply ? `${killTree(e, `auto-close: ${why}`, "close").line} ${tag}: ${why}` : `would close ${tag}: ${why}`);
  }
  return out;
}
```

3. `rollingStatus`: replace its last `console.log(rollingSummary(...))` with:

```js
  const lv = lock?.holder === "session" ? ctx.sessionLiveness(lock.session) : null;
  console.log(rollingSummary(lanes, lock, { state: lock ? lockStateOf(lock, c.config) : null, sessionClosed: lv?.state === "gone", sessionUnknown: lv?.state === "unknown" ? lv.why : null }));
```

4. `stop`: `console.log(requestStop(e, opt("why", "requested"), { apply: !dry, reasonClass: "manual", force: true, text: STOP_TEXT(opt("why", "requested")) }));`
5. `watchdog`: replace its body with (Task 6 wires it to the tick's dry run):

```js
if (sub === "watchdog") {
  console.log("watchdog: the loop rules moved to the coordinator tick (recover.mjs)");
  process.exit(0);
}
```

6. `merge --skip`: replace the `if (held?.holder === "session" && held.lane === skipName && val("session") !== held.session && sessionRunning(held.session)) {...}` block with:

```js
    if (held?.holder === "session" && held.lane === skipName && val("session") !== held.session) {
      const b = sessionBlocker(held.session, held);
      if (b?.kind === "running") { console.log(`not skipped: ${held.session} is still running and holds ${skipName} - let it finish, or stop it (launch.mjs stop --name ${held.session}) and re-run`); process.exit(1); }
      if (b) { console.log(`not skipped: ${held.session} holds ${skipName} and its liveness is ${b.kind} (${b.text}) - re-run once its window or claude agents answers`); process.exit(1); }
    }
```

7. `merge --force`: replace `const held = readLock(gd), running = ...; if (running) {...}` with:

```js
    const held = readLock(gd), b = held?.holder === "session" ? sessionBlocker(held.session, held) : null;
    if (b?.kind === "running") { console.log(`not cleared: ${held.session} is still running (${b.text}) - launch.mjs stop --name ${held.session} or close its window, then re-run`); process.exit(1); }
    if (b) { console.log(`not cleared: ${held.session}'s liveness is ${b.kind} (${b.text}) - nothing cleared; re-run once its window or claude agents answers`); process.exit(1); }
```

   (`b.kind` is `unknown` here, and `starting` once Task 8 adds the startup window.)

8. The launch tail. Replace everything from `const stamp = new Date()...` to the end of the file with:

```js
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const id = `${name}@${stamp}`;
const pidFile = path.join(PID_DIR, `${stem(id)}.pid`);
const promptFile = path.join(PID_DIR, `${stem(id)}.prompt.txt`);
const sessionId = mode === "window" ? crypto.randomUUID() : null;
const entry = {
  id, name, repo: repoKey, branch, worktree: fwd(workDir), generation, mode, group, title: name,
  handoff: fwd(handoff), done_marker: doneMarker && fwd(doneMarker), launched_at: now(), session_id: sessionId,
  host_pid: null, host_start: null, pid_file: mode === "window" ? fwd(pidFile) : null,
  model, effort, coord: 1, prompt_file: fwd(promptFile),
};
const noSpawn = process.env.HL_NO_SPAWN === "1";
if (!dry) { fs.mkdirSync(PID_DIR, { recursive: true }); fs.writeFileSync(promptFile, prompt); }

if (mode === "bg") {
  const bgArgs = ["--bg", "-n", name, "--model", model, "--effort", effort, prompt];
  console.log(JSON.stringify({ mode, worktree: wtPlan, registry_line: entry, prompt, command: ["claude", ...bgArgs] }, null, 2));
  if (dry) process.exit(0);
  if (noSpawn) { append({ ...entry, no_spawn: true }); console.log("HL_NO_SPAWN=1: recorded, not started"); process.exit(0); }
  const before = refreshAgents();
  const env = cleanEnv({ HL_SESSION_ID: id });
  // Windows needs a shell to resolve claude.cmd; pass one pre-quoted command string so the prompt stays ONE argument
  // (the prompt never contains double quotes - they are replaced above). Elsewhere spawn without a shell.
  const r = process.platform === "win32"
    ? spawnSync(["claude", ...bgArgs.map((a) => `"${a}"`)].join(" "), { cwd: workDir, env, encoding: "utf8", shell: true, timeout: 120000 })
    : spawnSync("claude", bgArgs, { cwd: workDir, env, encoding: "utf8", timeout: 120000 });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  // The bg id comes from a before/after diff of `claude agents --json`, matched by name: a guess from the CLI output is
  // not reliable, and a session with no id is never stopped by the coordinator.
  let hit = null;
  for (let i = 0; i < 10 && before && !hit; i++) { const after = refreshAgents(); hit = after && matchNewAgent(before, after, name); if (!hit) sleep(500); }
  append({ ...entry, bg_id: hit?.id ?? null, session_id: hit?.sessionId ?? null, bg_output: (r.stdout || "").slice(0, 2000) });
  if (!hit) console.log(`WARN no new entry named ${name} in claude agents --json - recorded with bg_id null (the coordinator never stops it; its liveness is unknown)`);
  process.exit(r.status ?? 1);
}

const claudeArgs = ["-n", psq(name), "--session-id", psq(sessionId), "--model", psq(model), "--effort", psq(effort), psq(prompt)];
if (!dry && noSpawn) { // tests: record the launch, start nothing
  console.log(JSON.stringify({ mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, spawned: false }, null, 2));
  append({ ...entry, no_spawn: true });
  process.exit(0);
}
const ps1 = path.join(os.tmpdir(), `claude-handoff-${stamp}.ps1`);
const script = windowScript({ pidFile, name, workDir, banner: `Handoff: ${handoffRef}`, regId: id,
  claudeLine: process.env.HL_FAKE_CLAUDE === "1" ? "powershell -NoExit -Command Start-Sleep 600" : `claude ${claudeArgs.join(" ")}` });
const [exe, exeArgs] = windowCommand(name, workDir, ps1);
const report = { mode: "window", worktree: wtPlan, registry_line: entry, prompt, claude_args: claudeArgs, launcher: ps1, command: [exe, ...exeArgs] };
if (dry) {
  report.auto_close = noClose ? "disabled (--no-close)" : closeOld(repoKey, branch, generation, false);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
console.log(JSON.stringify(report, null, 2));
const { launched, latency } = spawnWindow({ entry, ps1, script, exe, exeArgs, workDir });
append(launched);
if (!launched.host_pid) {
  console.log(`launched, but no pid file after 20 s (${fwd(pidFile)}) - auto-close skipped, check the window`);
} else {
  console.log(`launched: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${generation} of ${branch}`);
  for (const l of noClose ? ["auto-close disabled (--no-close)"] : closeOld(repoKey, branch, generation, true)) console.log(l);
}
```

9. Header comment: drop the `--stop-looping` sentence about the launch-time watchdog; add `HL_FAKE_PROBE` to the
   test-hook list and "Every launch line records model, effort, coord: 1 and prompt_file".

- [ ] **Step 6: `merge.mjs` and `merge-lib.mjs`**

In `settleSession`, replace the two lines `const gone = ctx.sessionGone ? ...` and `const stale = gone ? ...` with:

```js
  // Tri-state: only a session demonstrably gone is STALE; an unknown probe is reported, never judged.
  const lv = ctx.sessionLiveness ? ctx.sessionLiveness(held.session) : (sessionClosed(reg, held.session) ? { state: "gone", why: "closed" } : null);
  const stale = lv?.state === "gone" ? ` - STALE: that session is gone (window closed or process ended) - merge --force retries the lane, merge --skip ${held.lane} --why <reason> gives up on it`
    : lv?.state === "unknown" ? ` (liveness unknown: ${lv.why} - not judged STALE)` : "";
```

In `merge-lib.mjs` `rollingSummary`, change the signature to
`export function rollingSummary(classified, lock, { state = null, sessionClosed = false, sessionUnknown = null } = {})`
and the `hint` line to:

```js
  const hint = sessionClosed ? ` (STALE: ${lock.session} closed without merging ${lock.lane} - merge --force retries it, merge --skip ${lock.lane} --why <reason> gives up on it)`
    : sessionUnknown ? ` (liveness of ${lock.session} unknown: ${sessionUnknown} - not judged STALE)` : lockHint(state);
```

- [ ] **Step 7: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0`. The stage-1 merge-session tests keep passing because HL_NO_SPAWN lines are `no_spawn` (gone):
`--force`/`--skip` on them are allowed exactly as before, and the substring `queued: g1-merge-C is resolving C`
still matches where they now also say STALE.

- [ ] **Step 8: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "handoff-launch: live.mjs - tri-state liveness with probe timeouts, reliable bg ids, launch identity fields, CLAUDE_CONFIG_DIR and HL_SESSION_ID for children"
```

---

### Task 3: `recover-lib.mjs`, the pure decisions, and the transcript fixtures

**Files:**
- Create: `claude/skills/handoff-launch/recover-lib.mjs`
- Modify: `claude/skills/handoff-launch/tests/helpers.mjs` (fixture builder and registry/transcript writers)
- Test: `claude/skills/handoff-launch/tests/recover-lib.test.mjs` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure; `helpers.mjs` imports `projectKey` from `live.mjs`, Task 2).
- Produces (exported from `recover-lib.mjs`): `MIN`, `DEFAULTS`, `REARM_MS`, `RESUME_WORKS`, `STOP_EXPIRE_MS`, `turnEnded(entries) → bool`;
  `loadConfig(text|null) → {config, errors}`; `callKey(name, input)`, `shortHash(s)`, `display(s, n?)`;
  `toolCalls(entries, sinceMs?) → [{id, name, input, key, at, done, doneAt}]`; `contextTokens(entries) → number|null`;
  `usageLimited(entries) → bool`; `agentDone(entries) → bool`;
  `ruleA(calls, cfg, scope?) → flag[]`; `ruleB({calls, lastEntryAt, subGrowthAt, now}, cfg) → flag[]`;
  `ruleD({looping, notices, done, hooked}) → flag[]` (flag = `{rule, scope, key, signature, text, count?}`);
  `exemption({entries, calls, waitingSince, paused, pauseActive, liveState}) → reason|null`;
  `detect(obs, cfg) → {exempt, flags, subFlags}` (obs = `{entries, calls, subs:[{id, type, file, calls, grewAt, done}], lastEntryAt, now, hook, hooked, waitingSince, paused, pauseActive, liveState}`);
  `graceElapsed({start, calls, preKeys, now, waits?}) → ms`; `preKeysOf(calls, beforeMs, cfg) → Set`;
  `ladderOf(lines, id, signature) → {stop, delivered, cancelAt, cancelWhy, rearmAt, open, incident}`;
  `ladderActions({lines, entry, flags, callsFor, now, cfg, waits?}) → [{do:"stop"|"wait"|"cancel"|"rearm"|"kill", signature, flag?, why?}]`;
  `pendingLadders(lines) → [{id, incident, intent, closed}]`; `restartsSince(lines, name, handoff) → n`;
  `restartKind({restarts, tokens, cfg, isBg, hasSession?, resumeWorks?}) → "resume"|"fresh"|"blocked"`;
  `afterKillPlan({lines, entry, incident, cfg, doneMarkerExists, pauseActive, prevCauseFilled}) → {do:"restart"|"block"|"skip"|"defer", kind?, model?, effort?, restarts?, why?}`;
  `rungUp(model, effort) → {model, effort}`; `CAUSE_PLACEHOLDER`, `causeFilled(text) → bool`;
  `closeDecision({state, waitingSince, noClaude, now, cfg, reason}) → {close, why}`;
  `recoveryMode(lines, entry) → "auto"|"report"`; `blockedLanes(lines, group) → [{name, handoff, incident, at}]`;
  `alertDue(index, key, now, cfg) → bool`; `freshLaunchArgs(entry, {model, effort, recovery}) → string[]`;
  `postToolSteps(state, ev, ctx) → {state, context, delivered}` (ev = `{agentId, key}`, ctx = `{stops, looping, cfg, now}`);
  `incidentText(p) → markdown`; `STOP_TEXT_LADDER(sig)`, `SUBAGENT_TEXT(call)`, `PARENT_TEXT({type, id, reason, transcript})`,
  `WARN_TEXT(call, n)`, `RECOVERY_LINE(incidentRef)`, `ALERT.{blocked, mergeCap, restartFailed, report}(p)`.
- Produces (helpers): `tx({start?, step?})` builder with `.at(ms) .gap(ms) .tokens(input, cacheRead, cacheCreate)
  .user(text) .call(name, input, {result?, id?}) .say(text) .limit() .turnDone(bg?) .entries() .last()`;
  `sessionLine(sb, o) → entry`; `appendLine(sb, obj)`; `writeTranscript(sb, dir, sid, entries) → file`;
  `writeSubagent(sb, dir, sid, agentId, entries, meta?, mtimeMs?) → file`; `setAgents(sb, list)`.
- Probe gate: probe 4 sets `RESUME_WORKS` here.

- [ ] **Step 1: Add the fixtures to `tests/helpers.mjs`**

```js
import { projectKey } from "../live.mjs";
const MIN_MS = 60000;

// Transcript fixtures in Claude Code's JSONL shape: tx({start}).user("go").call("Bash", {command: "x"}).say("done").entries()
export function tx({ start = Date.now() - 60 * MIN_MS, step = 1000 } = {}) {
  const lines = []; let t = start, n = 0, usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  const ts = () => new Date((t += step)).toISOString();
  const api = {
    at(ms) { t = ms; return api; },
    gap(ms) { t += ms; return api; },
    tokens(input, cacheRead = 0, cacheCreate = 0) { usage = { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate }; return api; },
    user(text) { lines.push({ type: "user", message: { role: "user", content: text }, timestamp: ts() }); return api; },
    call(name, input = {}, { result = true, id } = {}) {
      const tid = id || `toolu_${String(++n).padStart(4, "0")}`;
      lines.push({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: tid, name, input }] }, timestamp: ts() });
      if (result) lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] }, timestamp: ts() });
      return api;
    },
    say(text) { lines.push({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", usage, content: [{ type: "text", text }] }, timestamp: ts() }); return api; },
    limit() { return api.say("You've hit your weekly limit · resets 6pm"); },
    turnDone(bg = 0) { lines.push({ type: "system", subtype: "turn_duration", pendingBackgroundAgentCount: bg, timestamp: ts() }); return api; },
    entries: () => lines.map((x) => JSON.parse(JSON.stringify(x))),
    last: () => t,
  };
  return api;
}
const toFwd = (p) => p.split(path.sep).join("/");
export const appendLine = (sb, o) => fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify(o) + "\n");
// A launch line as a stage-2 launcher writes it. Override any field; pass coord/model/effort: undefined for a pre-stage-2 line.
export function sessionLine(sb, o) {
  const wt = o.worktree || sb.repo;
  const e = {
    id: o.id || `${o.name}@${o.gen ?? 1}`, name: o.name, repo: toFwd(path.resolve(o.repo || sb.repo)).toLowerCase(), branch: o.branch || "main",
    worktree: toFwd(wt), generation: o.gen ?? 1, mode: o.mode || "window", group: o.group ?? null, title: o.name,
    handoff: toFwd(o.handoff || sb.handoff), done_marker: o.done_marker ?? null,
    launched_at: o.launched_at || new Date(Date.now() - 2 * 3600e3).toISOString(), session_id: o.sid ?? null,
    host_pid: o.host?.pid ?? null, host_start: o.host?.start ?? null, pid_file: null, bg_id: o.bg_id ?? null,
    model: "model" in o ? o.model : "opus", effort: "effort" in o ? o.effort : "high", coord: "coord" in o ? o.coord : 1, prompt_file: o.prompt_file ?? null,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  appendLine(sb, e);
  return e;
}
export function writeTranscript(sb, dir, sid, entries) {
  const f = path.join(sb.env.HL_PROJECTS_DIR, projectKey(dir), `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return f;
}
export function writeSubagent(sb, dir, sid, agentId, entries, meta = { agentType: "worker-high", requestShape: "background", description: "a task" }, mtimeMs = Date.now()) {
  const d = path.join(sb.env.HL_PROJECTS_DIR, projectKey(dir), sid, "subagents"), f = path.join(d, `agent-${agentId}.jsonl`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(f, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(d, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
}
export const setAgents = (sb, list) => fs.writeFileSync(path.join(sb.tmp, "agents.json"), JSON.stringify(list));
```

- [ ] **Step 2: Write the failing tests**

`claude/skills/handoff-launch/tests/recover-lib.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../recover-lib.mjs";
import { tx } from "./helpers.mjs";

const MIN = 60000, cfg = R.DEFAULTS, t0 = Date.parse("2026-01-01T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
// calls(["Bash x", "Read y"], start, step): done tool calls with keys as given
const calls = (keys, start, step = 1000) => keys.map((k, i) => ({ id: `t${start}-${i}`, name: k.split(" ")[0], input: {}, key: k, at: start + i * step, done: true, doneAt: start + i * step + 1 }));
const rep = (k, n) => Array(n).fill(k);

test("loadConfig: defaults, overrides, unknown keys and bad values are reported and ignored", () => {
  assert.deepEqual(R.loadConfig(null), { config: { ...R.DEFAULTS }, errors: [] });
  assert.equal(R.loadConfig('{"grace_min": 2}').config.grace_min, 2);
  const r = R.loadConfig('{"grace": 2, "stuck_min": -1}');
  assert.deepEqual(r.errors, ["unknown key grace", "stuck_min must be a positive number"]);
  assert.equal(r.config.stuck_min, 30);
  assert.match(R.loadConfig("{oops").errors[0], /not valid JSON/);
});

test("toolCalls, contextTokens, usageLimited and agentDone read Claude Code transcripts", () => {
  const e = tx({ start: t0 }).user("go").call("Bash", { command: "ls" }).tokens(5000, 300000, 2000).call("Read", { file_path: "a" }, { result: false }).entries();
  const c = R.toolCalls(e);
  assert.deepEqual(c.map((x) => [x.key, x.done]), [['Bash {"command":"ls"}', true], ['Read {"file_path":"a"}', false]]);
  assert.equal(R.toolCalls(e, c[1].at).length, 1); // calls before a launch line do not count
  assert.equal(R.contextTokens(e), 307000);
  assert.equal(R.usageLimited(tx().call("Bash", {}).limit().entries()), true);
  assert.equal(R.usageLimited(tx().limit().call("Bash", {}).entries()), false); // a call after the limit message: not waiting
  assert.equal(R.agentDone(tx().call("Bash", {}).say("done").entries()), true);
  assert.equal(R.agentDone(tx().call("Bash", {}).call("SubagentHandback", { message: "m" }).entries()), true);
  assert.equal(R.agentDone(tx().call("Bash", {}).entries()), false);
});

test("rule (a): the same call >= 4 times in the last 20 tool calls (calls, not entries)", () => {
  const four = calls([...rep("Bash x", 4), ...rep("Read y", 3)], t0);
  const [f] = R.ruleA(four, cfg);
  assert.equal(f.rule, "a"); assert.equal(f.count, 4); assert.equal(f.signature, `a:main:${R.shortHash("Bash x")}`);
  assert.deepEqual(R.ruleA(calls(rep("Bash x", 3), t0), cfg), []);
  assert.deepEqual(R.ruleA(calls(["Bash x", ...Array.from({ length: 19 }, (_, i) => `Read ${i}`), ...rep("Bash x", 3)], t0), cfg), []); // the first one left the window
  assert.equal(R.ruleA(calls(rep("Grep z", 5), t0), cfg, "ag1")[0].signature, `a:ag1:${R.shortHash("Grep z")}`);
});

test("legitimate polling that switches to Monitor: the rule stops firing and the grace timer pauses", () => {
  const poll = calls(rep("Bash gh run view", 4), t0, 60000);
  assert.equal(R.ruleA(poll, cfg).length, 1);
  const after = [...poll, ...calls(["Monitor ci", ...Array.from({ length: 17 }, (_, i) => `Read f${i}`)], t0 + 5 * MIN, 1000)]; // Monitor is not counted
  assert.deepEqual(R.ruleA(after, cfg), []);
  const pre = R.preKeysOf(poll, t0 + 4 * MIN, cfg);
  assert.equal(R.graceElapsed({ start: t0 + 4 * MIN, calls: after, preKeys: pre, now: t0 + 30 * MIN }), MIN); // counted only until Monitor
});

test("rule (b): an outstanding call with no activity for 30 min; a working subagent or Monitor is not stuck", () => {
  const c = [...calls(["Read a"], t0), { id: "p", name: "mcp__x__slow", key: "mcp__x__slow {}", at: t0 + MIN, done: false, doneAt: null }];
  const [f] = R.ruleB({ calls: c, lastEntryAt: t0 + MIN, subGrowthAt: 0, now: t0 + 32 * MIN }, cfg);
  assert.equal(f.signature, "b:mcp__x__slow"); assert.match(f.text, /no activity for 31 min/);
  assert.deepEqual(R.ruleB({ calls: c, lastEntryAt: t0 + MIN, subGrowthAt: t0 + 30 * MIN, now: t0 + 32 * MIN }, cfg), []);
  const mon = [{ id: "m", name: "Monitor", key: "Monitor {}", at: t0, done: false }];
  assert.deepEqual(R.ruleB({ calls: mon, lastEntryAt: t0, subGrowthAt: 0, now: t0 + 90 * MIN }, cfg), []);
});

test("detect: a looping foreground subagent makes the parent stuck (b) and waiting (d); its growth is not activity", () => {
  const now = t0 + 40 * MIN;
  const main = [{ id: "ag", name: "Agent", key: "Agent {}", at: t0, done: false }];
  const looping = { id: "ag1", type: "worker-high", file: "/p/agent-ag1.jsonl", calls: calls(rep("Bash x", 6), t0 + 30 * MIN), grewAt: now - 1000, done: false };
  const base = { entries: [], calls: main, lastEntryAt: t0, now, hooked: true, hook: { agent_notices: { ag1: iso(t0 + 36 * MIN) } } };
  let d = R.detect({ ...base, subs: [looping] }, cfg);
  assert.deepEqual(Object.keys(d.subFlags), ["ag1"]);
  assert.deepEqual(d.flags.map((f) => f.signature), ["b:Agent", "d:ag1"]);
  const working = { ...looping, id: "ag2", calls: calls(["Read a", "Edit b", "Bash c"], t0 + 30 * MIN) };
  d = R.detect({ ...base, subs: [working] }, cfg);
  assert.deepEqual(d.flags, []); // a long foreground Agent call whose subagent works is not stuck
  d = R.detect({ ...base, hook: {}, subs: [looping] }, cfg);
  assert.deepEqual(d.flags.map((f) => f.rule), ["b"]); // (d) waits for the notice to be delivered...
  d = R.detect({ ...base, hook: {}, hooked: false, subs: [looping] }, cfg);
  assert.deepEqual(d.flags.map((f) => f.rule), ["b", "d"]); // ...unless the session has no hook to deliver it
});

test("never flagged: usage limit, AskUserQuestion, a permission prompt with no call after it, paused, pause file, unknown", () => {
  const loop = calls(rep("Bash x", 5), t0);
  const obs = (o) => ({ entries: [], calls: loop, subs: [], lastEntryAt: t0, now: t0 + MIN, hook: {}, hooked: true, ...o });
  assert.equal(R.detect(obs({}), cfg).flags.length, 1);
  assert.equal(R.detect(obs({ entries: tx().call("Bash", {}).limit().entries() }), cfg).exempt, "waiting on a usage limit");
  assert.equal(R.detect(obs({ calls: [...loop, { id: "q", name: "AskUserQuestion", key: "AskUserQuestion {}", at: t0 + 9000, done: false }] }), cfg).exempt, "waiting for the user (AskUserQuestion)");
  assert.equal(R.detect(obs({ waitingSince: iso(t0 + 10000) }), cfg).exempt, "waiting for the user (permission prompt)");
  assert.equal(R.detect(obs({ waitingSince: iso(t0 + 2000) }), cfg).exempt, null); // calls followed it: not waiting
  assert.match(R.detect(obs({ paused: true }), cfg).exempt, /paused/);
  assert.match(R.detect(obs({ pauseActive: true }), cfg).exempt, /pause file/);
  assert.equal(R.detect(obs({ liveState: "unknown" }), cfg).exempt, "liveness unknown");
});

test("graceElapsed: runs while the loop repeats, pauses on a distinct call, resumes on the next repeat", () => {
  const pre = new Set(["A", "B"]);
  assert.equal(R.graceElapsed({ start: t0, calls: [], preKeys: null, now: t0 + 6 * MIN }), 6 * MIN);
  const c = [{ key: "A", at: t0 + MIN }, { key: "C", at: t0 + 2 * MIN }, { key: "A", at: t0 + 4 * MIN }];
  assert.equal(R.graceElapsed({ start: t0, calls: c, preKeys: pre, now: t0 + 5 * MIN }), 3 * MIN);
  // a call that sat 60 min on a permission prompt: the wait does not count
  assert.equal(R.graceElapsed({ start: t0, calls: [{ key: "A", at: t0 + 61 * MIN }], preKeys: pre, now: t0 + 64 * MIN, waits: [[t0 + MIN, t0 + 61 * MIN]] }), 4 * MIN);
  assert.equal(R.graceElapsed({ start: t0, calls: [], preKeys: null, now: t0 + 10 * MIN, waits: [[t0 + 2 * MIN, null]] }), 2 * MIN);
});

test("the ladder: stop, wait for delivery, grace, kill; cancel when the rule stops firing", () => {
  const E = { id: "A@1", name: "A", coord: 1 }, sig = "a:main:abc";
  const flag = { rule: "a", scope: "main", key: "Bash x", signature: sig, text: "same call x5" };
  const loop = calls(rep("Bash x", 5), t0 - MIN);
  const run = (lines, now, c = loop, flags = [flag]) => R.ladderActions({ lines, entry: E, flags, callsFor: () => c, now, cfg });
  assert.deepEqual(run([], t0).map((a) => a.do), ["stop"]);
  const stop = { stop_requested: "A@1", reason_class: "ladder", signature: sig, token: "t1", at: iso(t0) };
  let a = run([stop], t0 + 10 * MIN);
  assert.equal(a[0].do, "wait"); assert.match(a[0].why, /not delivered/);
  const dl = { stop_delivered: "A@1", token: "t1", at: iso(t0 + MIN) };
  assert.equal(run([stop, dl], t0 + 4 * MIN)[0].do, "wait");
  assert.equal(run([stop, dl], t0 + 7 * MIN, [...loop, ...calls(["Bash x"], t0 + 2 * MIN)])[0].do, "kill");
  assert.equal(run([stop, dl], t0 + 7 * MIN, [...loop, ...calls(["Read y"], t0 + 2 * MIN)])[0].do, "wait"); // a distinct call paused it
  assert.deepEqual(run([stop, dl], t0 + 3 * MIN, loop, []), [{ do: "cancel", signature: sig }]);
  assert.deepEqual(run([stop], t0 + 61 * MIN), [{ do: "cancel", signature: sig, why: "stop expired" }]); // never delivered, stale
  const expired = { ladder_cancelled: "A@1", signature: sig, why: "stop expired", at: iso(t0 + 61 * MIN) };
  assert.deepEqual(run([stop, expired], t0 + 70 * MIN).map((a) => a.do), ["stop"]); // a fresh stop, not a re-arm
  assert.deepEqual(run([stop, dl, { incident: "A@1", signature: sig, n: 1, path: "i.md", at: iso(t0 + 7 * MIN) }], t0 + 8 * MIN), []); // the kill path owns it
});

test("re-arming: an A,B,A,B loop with a stray distinct call still escalates; an old cancel starts over", () => {
  const E = { id: "A@1", name: "A", coord: 1 }, sig = "a:main:abc";
  const flag = { rule: "a", scope: "main", key: "A", signature: sig, text: "same call x4" };
  const before = calls(["A", "B", "A", "B", "A", "B", "A", "B"], t0 - 8000);
  const stop = { stop_requested: "A@1", reason_class: "ladder", signature: sig, token: "t1", at: iso(t0) };
  const dl = { stop_delivered: "A@1", token: "t1", at: iso(t0 + MIN) };
  const cancel = { ladder_cancelled: "A@1", signature: sig, at: iso(t0 + 3 * MIN) };
  const run = (lines, now, c) => R.ladderActions({ lines, entry: E, flags: [flag], callsFor: () => c, now, cfg });
  assert.deepEqual(run([stop, dl, cancel], t0 + 20 * MIN, before).map((a) => a.do), ["rearm"]);
  const rearm = { ladder_rearmed: "A@1", signature: sig, at: iso(t0 + 20 * MIN) };
  const after = [...before, { key: "A", at: t0 + 21 * MIN }, { key: "B", at: t0 + 22 * MIN }, { key: "C", at: t0 + 22.5 * MIN }, { key: "A", at: t0 + 23 * MIN }, { key: "B", at: t0 + 24 * MIN }];
  assert.equal(run([stop, dl, cancel, rearm], t0 + 26 * MIN, after)[0].do, "kill"); // 5.5 min counted, C paused 0.5 min
  assert.deepEqual(run([stop, dl, cancel], t0 + 70 * MIN, before).map((a) => a.do), ["stop"]);
});

test("grace starts at the request for rules (b)/(d) and for a session without the hook", () => {
  const sig = "b:mcp__x__slow", stop = { stop_requested: "A@1", reason_class: "ladder", signature: sig, token: "t", at: iso(t0) };
  const fb = { rule: "b", scope: "main", key: "k", signature: sig, text: "stuck" };
  assert.equal(R.ladderActions({ lines: [stop], entry: { id: "A@1", coord: 1 }, flags: [fb], callsFor: () => [], now: t0 + 6 * MIN, cfg })[0].do, "kill");
  const fa = { ...fb, rule: "a", signature: "a:main:x" }, stopA = { ...stop, signature: "a:main:x" };
  assert.equal(R.ladderActions({ lines: [stopA], entry: { id: "A@1" }, flags: [fa], callsFor: () => [], now: t0 + 6 * MIN, cfg })[0].do, "kill");
});

test("pendingLadders: an auto incident with a kill_intent and no restart is pending; old kill_intents never are", () => {
  const sig = "a:main:x", inc = { incident: "A@1", name: "A", n: 1, path: "i.md", signature: sig, mode: "auto", at: iso(t0) };
  const ki = { kill_intent: "A@1", kind: "ladder", at: iso(t0 + 1) };
  assert.deepEqual(R.pendingLadders([inc, ki]).map((p) => [p.id, !!p.intent, p.closed]), [["A@1", true, false]]);
  assert.deepEqual(R.pendingLadders([inc]).map((p) => p.intent), [null]);
  assert.deepEqual(R.pendingLadders([inc, ki, { closed: "A", id: "A@1" }, { restart: "A", from: "A@1", handoff: "h" }]), []);
  assert.deepEqual(R.pendingLadders([inc, ki, { restart_skipped: "A@1" }]), []);
  assert.deepEqual(R.pendingLadders([{ ...inc, mode: "report" }]), []);
  assert.deepEqual(R.pendingLadders([{ kill_intent: "B@1", why: "watchdog: old", at: iso(t0) }]), []);
  const cancel = { ladder_cancelled: "A@1", signature: sig, at: iso(t0 + 2) };
  assert.deepEqual(R.pendingLadders([inc, cancel]), []);
  assert.deepEqual(R.pendingLadders([inc, ki, { restart_failed: "A", from: "A@1" }]), []);
  assert.equal(R.ladderOf([inc, cancel], "A@1", sig).incident, null); // the same signature can re-arm
});

test("restart kind and cap, including a 400k crossing; a new handoff or a manual resume resets the count", () => {
  const k = (restarts, tokens, o = {}) => R.restartKind({ restarts, tokens, cfg, isBg: false, ...o });
  assert.deepEqual([k(0, 100), k(1, 100), k(2, 100)], ["resume", "fresh", "blocked"]);
  assert.deepEqual([k(0, 400000), k(1, 450000)], ["fresh", "blocked"]);
  assert.equal(k(1, 400000), "blocked"); // resumed, grew past the threshold, looped again: the >= row
  assert.equal(k(0, 100, { isBg: true }), "fresh");
  assert.equal(k(0, 100, { hasSession: false }), "fresh");
  assert.equal(k(0, 100, { resumeWorks: false }), "fresh");
  const lines = [{ restart: "A", handoff: "h1" }, { restart: "A", handoff: "h1" }, { restart: "B", handoff: "h1" }];
  assert.equal(R.restartsSince(lines, "A", "h1"), 2);
  assert.equal(R.restartsSince(lines, "A", "h2"), 0);
  assert.equal(R.restartsSince([...lines, { lane_resumed: "A", handoff: "h1" }, { restart: "A", handoff: "h1" }], "A", "h1"), 1);
});

test("afterKillPlan: a done lane is killed but not restarted; pause defers; the cap blocks; one rung up only after an empty Cause", () => {
  const entry = { id: "A@1", name: "A", handoff: "h", mode: "window", session_id: "s", model: "opus", effort: "high" };
  const p = (o) => R.afterKillPlan({ lines: [], entry, incident: { tokens: 1000 }, cfg, doneMarkerExists: false, pauseActive: false, prevCauseFilled: true, ...o });
  assert.equal(p({ doneMarkerExists: true }).do, "skip");
  assert.equal(p({ pauseActive: true }).do, "defer");
  assert.deepEqual(p({}), { do: "restart", kind: "resume", model: "opus", effort: "high", restarts: 0 });
  const one = [{ restart: "A", handoff: "h" }];
  assert.deepEqual(p({ lines: one }), { do: "restart", kind: "fresh", model: "opus", effort: "high", restarts: 1 });
  assert.deepEqual(p({ lines: one, prevCauseFilled: false }), { do: "restart", kind: "fresh", model: "opus", effort: "xhigh", restarts: 1 });
  assert.equal(p({ lines: [...one, ...one] }).do, "block");
  assert.deepEqual(R.afterKillPlan({ lines: [], entry: { ...entry, model: undefined, effort: undefined }, incident: {}, cfg, doneMarkerExists: false, pauseActive: false }).model, "opus");
});

test("rungUp, causeFilled, incidentText", () => {
  assert.deepEqual(R.rungUp("opus", "high"), { model: "opus", effort: "xhigh" });
  assert.deepEqual(R.rungUp("opus", "xhigh"), { model: "fable", effort: "high" });
  assert.deepEqual(R.rungUp("fable", "xhigh"), { model: "fable", effort: "xhigh" });
  assert.deepEqual(R.rungUp("opus", "low"), { model: "opus", effort: "medium" });
  const md = R.incidentText({ lane: "A", n: 2, at: "2026-01-01T00:00:00Z", name: "A", id: "A@1", sessionId: "s", generation: 3, rule: "a",
    signature: "a:main:abc", text: "same call x5", tokens: 1234, branch: "lane-A", worktree: "/w", handoff: "/h.md", mode: "auto",
    calls: ['Bash {"command":"x"}'], main: "/p/s.jsonl", subs: [{ id: "ag1", type: "worker-high", file: "/p/s/subagents/agent-ag1.jsonl" }],
    others: [{ id: "ag2", type: "explorer", description: "map the code" }] });
  assert.match(md, /^# Incident A-2: loop stopped by the coordinator\n/);
  assert.match(md, /- Rule: \(a\) the same tool call repeated/);
  assert.match(md, /## Last 20 tool calls\n1\. `Bash \{"command":"x"\}`/);
  assert.match(md, /## Other background agents \(re-dispatch\)\n- ag2 \(explorer\): map the code/);
  assert.equal(R.causeFilled(md), false);
  assert.equal(R.causeFilled(md.replace(R.CAUSE_PLACEHOLDER, "The brief named the wrong file.")), true);
});

test("closeDecision: idle long enough and not waiting closes; busy, waiting or young does not", () => {
  const st = (o) => ({ found: true, idle: true, busy: [], last: iso(t0), ...o });
  const d = (o) => R.closeDecision({ state: st({}), waitingSince: null, noClaude: null, now: t0 + 20 * MIN, cfg, reason: "superseded by generation 2", ...o });
  assert.deepEqual(d({}), { close: true, why: "superseded by generation 2: idle 20 min" });
  assert.equal(d({ state: st({ idle: false, busy: ["1 tool call(s) outstanding"] }) }).close, false);
  assert.equal(d({ waitingSince: iso(t0) }).close, false);
  assert.equal(d({ now: t0 + 5 * MIN }).close, false);
  assert.equal(d({ state: { found: false }, noClaude: true }).close, true);
  assert.equal(d({ state: { found: false }, noClaude: null }).close, false);
});

test("recoveryMode, blockedLanes, alertDue, freshLaunchArgs", () => {
  const old = { name: "A", group: "g", repo: "r", launched_at: iso(t0) }, neu = { name: "B", group: "h", repo: "r", launched_at: iso(t0), coord: 1 };
  assert.equal(R.recoveryMode([old, { ...old, coord: 1 }], { ...old, coord: 1 }), "report"); // the group's EARLIEST line decides
  assert.equal(R.recoveryMode([neu], neu), "auto");
  assert.equal(R.recoveryMode([old, { recovery_mode: "g", mode: "auto" }], old), "auto");
  assert.equal(R.recoveryMode([neu, { recovery_mode: "h", mode: "auto" }, { recovery_mode: "h", mode: "report" }], neu), "report");
  assert.equal(R.recoveryMode([], { name: "solo", group: null, coord: 1 }), "auto");
  assert.equal(R.recoveryMode([{ name: "solo", launched_at: iso(t0), coord: 1 }], { name: "solo", group: null }), "report"); // its own line decides
  const lines = [{ lane_blocked: "A", group: "g", handoff: "h", incident: "i1" }, { lane_blocked: "B", group: "g", handoff: "h", incident: "i2" }, { lane_resumed: "B", group: "g" }];
  assert.deepEqual(R.blockedLanes(lines, "g").map((b) => b.name), ["A"]);
  assert.equal(R.alertDue({}, "k", t0, cfg), true);
  assert.equal(R.alertDue({ k: iso(t0 - 5 * 3600e3) }, "k", t0, cfg), false);
  assert.equal(R.alertDue({ k: iso(t0 - 7 * 3600e3) }, "k", t0, cfg), true);
  const e = { name: "A", group: "g", repo: "c:/r", worktree: "C:/r/.claude/worktrees/lane-A", branch: "lane-A", handoff: "C:/h.md", mode: "window", session_id: "s1", prompt_file: "C:/p.txt" };
  assert.deepEqual(R.freshLaunchArgs(e, { model: "opus", effort: "high", recovery: "C:/i.md" }), ["--repo", e.worktree, "--handoff", "C:/h.md", "--name", "A", "--group", "g",
    "--worktree", "lane-A", "--model", "opus", "--effort", "high", "--mode", "window", "--no-close", "--recovery", "C:/i.md", "--goal-from", "s1", "--prompt-file", "C:/p.txt"]);
  assert.ok(R.freshLaunchArgs({ ...e, name: "g-merge" }, { model: "opus", effort: "high", recovery: "i" }).includes("--force")); // legacy merge session relaunch
  assert.ok(!R.freshLaunchArgs({ ...e, worktree: "C:/r" }, { model: "opus", effort: "high", recovery: "i" }).includes("--worktree"));
});

test("postToolSteps: stop delivery (parent only), subagent notice, parent fast path, early warning per agent - once each", () => {
  const ctx = (o) => ({ stops: [], looping: {}, cfg, now: t0, ...o });
  const stop = { token: "t1", text: "STOP NOW" };
  let r = R.postToolSteps({}, { agentId: "ag1", key: "Read a" }, ctx({ stops: [stop] }));
  assert.equal(r.context, null); // a subagent's event never takes the session-level stop
  r = R.postToolSteps(r.state, { agentId: null, key: "Read a" }, ctx({ stops: [stop] }));
  assert.equal(r.context, "STOP NOW"); assert.equal(r.delivered, "t1");
  r = R.postToolSteps(r.state, { agentId: null, key: "Read b" }, ctx({ stops: [stop] }));
  assert.equal(r.context, null);
  const looping = { ag2: { key: 'Bash {"command":"loop"}', type: "worker-high", text: "same call x5", transcript: "/t/agent-ag2.jsonl" } };
  r = R.postToolSteps(r.state, { agentId: "ag2", key: "Bash loop" }, ctx({ looping }));
  assert.equal(r.context, R.SUBAGENT_TEXT('Bash {"command":"loop"}'));
  r = R.postToolSteps(r.state, { agentId: "ag2", key: "Bash loop" }, ctx({ looping }));
  assert.equal(r.context, null);
  r = R.postToolSteps(r.state, { agentId: null, key: "Read c" }, ctx({ looping }));
  assert.equal(r.context, R.PARENT_TEXT({ type: "worker-high", id: "ag2", reason: "same call x5", transcript: "/t/agent-ag2.jsonl" }));
  r = R.postToolSteps(r.state, { agentId: null, key: "Read d" }, ctx({ looping }));
  assert.equal(r.context, null);
  const out = [];
  for (const [agentId, key] of [[null, "X"], ["ag3", "X"], [null, "X"], ["ag3", "X"], [null, "X"], [null, "X"]]) { r = R.postToolSteps(r.state, { agentId, key }, ctx({})); out.push(r.context); }
  assert.deepEqual(out, [null, null, null, null, R.WARN_TEXT("X", 3), null]); // per-agent streaks; once per signature
  r = R.postToolSteps({ ...r.state, waiting_since: iso(t0) }, { agentId: null, key: "Y" }, ctx({}));
  assert.equal(r.state.waiting_since, null); // a tool call followed the permission prompt
  assert.deepEqual(r.state.waits.at(-1), [t0, t0]); // ...and the wait is kept for the grace timer
  r = R.postToolSteps({}, { agentId: null, key: "Z" }, ctx({ stops: [{ token: "old", text: "OLD", at: iso(t0 - 61 * MIN) }, { token: "t9", text: "LADDER", at: iso(t0) }] }));
  assert.equal(r.context, "LADDER"); assert.match(r.state.delivered.old, /^expired/); // a stale stop is never injected
  for (let i = 0; i < 3; i++) r = R.postToolSteps(r.state, { agentId: null, key: "Monitor {}" }, ctx({}));
  assert.equal(r.context, null); // no warning for waiting with Monitor
});

test("rule (a) leaves a finished turn alone and never counts Monitor; rule (d) still judges an idle parent", () => {
  let t = tx({ start: t0 }).user("go");
  for (let i = 0; i < 4; i++) t = t.call("Bash", { command: "x" });
  const idle = t.say("done").turnDone().entries(), c = R.toolCalls(idle);
  const base = { entries: idle, calls: c, subs: [], lastEntryAt: t0, now: t0 + 3 * 3600e3, hook: {}, hooked: true };
  assert.deepEqual(R.detect(base, cfg).flags, []);
  assert.equal(R.detect({ ...base, entries: idle.slice(0, -2) }, cfg).flags[0].rule, "a"); // mid-turn: flagged
  assert.deepEqual(R.ruleA(calls(rep("Monitor ci", 6), t0), cfg), []);
  const looping = { id: "ag1", type: "worker-high", file: "/f", calls: calls(rep("Bash y", 5), t0), grewAt: t0, done: false };
  assert.deepEqual(R.detect({ ...base, subs: [looping], hook: { agent_notices: { ag1: iso(t0) } } }, cfg).flags.map((f) => f.signature), ["d:ag1"]);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/recover-lib.test.mjs`
Expected: FAIL to load: `Cannot find module '.../recover-lib.mjs'`.

- [ ] **Step 4: Write `recover-lib.mjs`**

```js
// Pure decisions of the stage-2 coordinator: transcript -> tool calls, the loop rules (a) repetition, (b) stuck call,
// (d) waiting on a looping subagent, the "never flagged" exemptions, the re-arming ladder, the restart kind and cap,
// superseded closes, the session hook's steps, and every text. No fs, no clock, no processes: callers pass the
// registry lines, transcripts and `now` in (tests/recover-lib.test.mjs covers each decision).
import crypto from "node:crypto";

export const MIN = 60000;
export const DEFAULTS = Object.freeze({ repeat_window: 20, repeat_count: 4, warn_streak: 3, stuck_min: 30, grace_min: 5,
  idle_close_min: 10, fresh_at_tokens: 400000, max_restarts: 2, tick_min: 5, alert_repeat_hours: 6 });
export const REARM_MS = 60 * MIN; // the same signature within this of a cancel resumes at the grace step
// Probe 4 (plan Task 1): RESUME_WORKS = false if `claude --resume` failed on a killed transcript. Background lanes
// always restart fresh (controller ruling), whatever `claude --bg --resume` did in the probe.
export const RESUME_WORKS = true;
export const STOP_EXPIRE_MS = 60 * MIN; // a stop request this old is stale: the hook marks it handled, never injects it

// config.json text (null = missing) -> {config, errors}. Unknown keys and bad values are reported and ignored.
export function loadConfig(text) {
  const config = { ...DEFAULTS }, errors = [];
  if (text == null) return { config, errors };
  let o; try { o = JSON.parse(text); } catch (e) { return { config, errors: [`config.json is not valid JSON: ${e.message}`] }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { config, errors: ["config.json must be a JSON object"] };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in DEFAULTS)) errors.push(`unknown key ${k}`);
    else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) errors.push(`${k} must be a positive number`);
    else config[k] = v;
  }
  return { config, errors };
}

// ---------- transcripts ----------
const blocksOf = (x) => (Array.isArray(x?.message?.content) ? x.message.content : []);
const textOf = (x) => (typeof x?.message?.content === "string" ? x.message.content
  : typeof x?.content === "string" ? x.content : blocksOf(x).filter((b) => b.type === "text").map((b) => b.text || "").join("\n"));
export const callKey = (name, input) => `${name} ${JSON.stringify(input ?? {})}`;
export const shortHash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
export const display = (s, n = 160) => { const t = String(s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n)}...` : t; };
// Tool calls in order, from tool_use blocks (deduplicated by id) and their tool_result. Calls before sinceMs (the
// launch line's time) are not this run's: a resumed session keeps its old transcript.
export function toolCalls(entries, sinceMs = 0) {
  const calls = [], byId = new Map();
  for (const x of entries) {
    const at = Date.parse(x?.timestamp) || 0;
    for (const b of blocksOf(x)) {
      if (b.type === "tool_use" && b.id && !byId.has(b.id)) {
        const c = { id: b.id, name: b.name, input: b.input, key: callKey(b.name, b.input), at, done: false, doneAt: null };
        byId.set(b.id, c);
        if (at >= sinceMs) calls.push(c);
      } else if (b.type === "tool_result" && byId.has(b.tool_use_id)) { const c = byId.get(b.tool_use_id); c.done = true; c.doneAt = at; }
    }
  }
  return calls;
}
// input + cache read + cache creation of the last assistant usage (drops after a compaction, as it should).
export function contextTokens(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const u = entries[i]?.type === "assistant" && entries[i].message?.usage;
    if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return null;
}
// The tail shows "limit · resets" with no tool call after it: the session waits for a usage-limit reset.
export function usageLimited(entries) {
  for (let i = entries.length - 1; i >= Math.max(0, entries.length - 12); i--) {
    if (blocksOf(entries[i]).some((b) => b.type === "tool_use")) return false;
    if (/limit\s*·\s*resets/i.test(textOf(entries[i]))) return true;
  }
  return false;
}
// A subagent transcript that ended: its last message ends the turn, or its last call is a finished SubagentHandback.
export function agentDone(entries) {
  const conv = entries.filter((x) => x.type === "assistant" || x.type === "user");
  const last = conv.at(-1);
  if (!last) return false;
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn") return true;
  const c = toolCalls(entries), h = c.at(-1);
  return !!h && h.name === "SubagentHandback" && h.done;
}
// The main turn has ended: its last message ends the turn, or the turn_duration line follows it.
export function turnEnded(entries) {
  const conv = entries.filter((x) => x.type === "assistant" || x.type === "user" || (x.type === "system" && x.subtype === "turn_duration"));
  const end = conv.at(-1);
  return !!end && (end.type === "system" || (end.type === "assistant" && end.message?.stop_reason === "end_turn"));
}

// ---------- loop rules: each flag = {rule, scope, key, signature, text} ----------
// (a) The same call >= repeat_count times in the last repeat_window calls. Monitor is waiting by design: never counted.
export function ruleA(calls, cfg, scope = "main") {
  const win = calls.filter((c) => c.name !== "Monitor").slice(-cfg.repeat_window), counts = new Map();
  for (const c of win) counts.set(c.key, (counts.get(c.key) || 0) + 1);
  return [...counts].filter(([, n]) => n >= cfg.repeat_count).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ rule: "a", scope, key, count: n, signature: `a:${scope}:${shortHash(key)}`, text: `same call x${n} in the last ${win.length} tool calls: ${display(key)}` }));
}
// (b) The oldest outstanding main call with no activity for stuck_min. Activity: a newer main entry, or growth of a
// subagent transcript that is not itself looping (the caller passes subGrowthAt without those). Monitor is waiting
// by design and never stuck.
export function ruleB({ calls, lastEntryAt, subGrowthAt, now }, cfg) {
  const c = calls.find((x) => !x.done && x.name !== "Monitor");
  if (!c) return [];
  const idle = now - Math.max(lastEntryAt || 0, subGrowthAt || 0, c.at || 0);
  if (idle < cfg.stuck_min * MIN) return [];
  return [{ rule: "b", scope: "main", key: c.key, signature: `b:${c.name}`, text: `${c.name} call outstanding with no activity for ${Math.round(idle / MIN)} min` }];
}
// (d) A subagent in looping.json (flagged this tick) whose notice was delivered - or whose session has no hook to
// deliver it - and that has not finished. Its distinct calls pause the grace timer; leaving looping.json cancels.
export function ruleD({ looping, notices, done, hooked }) {
  return Object.entries(looping || {}).filter(([id]) => (notices?.[id] || !hooked) && !done?.[id])
    .map(([id, a]) => ({ rule: "d", scope: id, key: a.key, signature: `d:${id}`, text: `waiting on looping subagent ${a.type || "agent"} ${id} (${a.text})` }));
}
export function exemption({ entries = [], calls = [], waitingSince, paused, pauseActive, liveState }) {
  if (liveState === "unknown") return "liveness unknown";
  if (paused) return "paused ({paused} registry line)";
  if (pauseActive) return "the pause file is active";
  if (usageLimited(entries)) return "waiting on a usage limit";
  if (calls.some((c) => !c.done && c.name === "AskUserQuestion")) return "waiting for the user (AskUserQuestion)";
  if (waitingSince && !calls.some((c) => c.at > Date.parse(waitingSince))) return "waiting for the user (permission prompt)";
  return null;
}
// One session's flags. subFlags (looping.json for this session) are computed even when the session is exempt.
export function detect(obs, cfg) {
  const subFlags = {};
  for (const s of obs.subs || []) {
    if (s.done) continue;
    const f = ruleA(s.calls, cfg, s.id)[0];
    if (f) subFlags[s.id] = { key: f.key, count: f.count, text: f.text, type: s.type || null, transcript: s.file, signature: f.signature };
  }
  const exempt = exemption(obs);
  if (exempt) return { exempt, flags: [], subFlags };
  const growth = Math.max(0, ...(obs.subs || []).filter((s) => !subFlags[s.id]).map((s) => s.grewAt || 0));
  const done = Object.fromEntries((obs.subs || []).map((s) => [s.id, !!s.done]));
  // (a) leaves a finished main turn with nothing outstanding alone (an idle session repeats nothing now); (d) does not:
  // idle parents of looping agents are its point.
  const idleTurn = turnEnded(obs.entries || []) && !obs.calls.some((c) => !c.done);
  const flags = [...(idleTurn ? [] : ruleA(obs.calls, cfg)), ...ruleB({ calls: obs.calls, lastEntryAt: obs.lastEntryAt, subGrowthAt: growth, now: obs.now }, cfg),
    ...ruleD({ looping: subFlags, notices: obs.hook?.agent_notices, done, hooked: obs.hooked })];
  return { exempt: null, flags, subFlags };
}

// ---------- the ladder ----------
// Grace used since start: the clock runs while the session repeats calls it made before the stop request (or makes
// none), pauses from a distinct call until the next repeated one, and never runs while the session waited on a
// permission prompt (waits: [[from, to|null]] from the hook state).
export function graceElapsed({ start, calls, preKeys, now, waits = [] }) {
  const span = (a, b) => Math.max(0, b - a) - waits.reduce((s, [f, u]) => s + Math.max(0, Math.min(b, u ?? Infinity) - Math.max(a, f)), 0);
  let t = start, counting = true, acc = 0;
  for (const c of calls) {
    if (!(c.at > start) || c.at > now) continue;
    if (counting) acc += span(t, c.at);
    t = c.at;
    counting = !preKeys || preKeys.has(c.key);
  }
  return acc + (counting ? span(t, now) : 0);
}
export const preKeysOf = (calls, beforeMs, cfg) => new Set(calls.filter((c) => c.at < beforeMs).slice(-cfg.repeat_window).map((c) => c.key));
export function ladderOf(lines, id, signature) {
  let stop = null, delivered = null, cancelAt = 0, cancelWhy = null, rearmAt = 0, incident = null;
  for (const o of lines) {
    const at = Date.parse(o.at) || 0;
    if (o.stop_requested === id && o.reason_class === "ladder" && o.signature === signature) { stop = { at, token: o.token }; delivered = null; }
    else if (o.stop_delivered === id && stop && o.token === stop.token && delivered === null) delivered = at;
    else if (o.ladder_cancelled === id && o.signature === signature) { cancelAt = at; cancelWhy = o.why || null; incident = null; } // a cancelled ladder can re-arm
    else if (o.ladder_rearmed === id && o.signature === signature) rearmAt = at;
    else if (o.incident === id && o.signature === signature) incident = { at, n: o.n, path: o.path };
  }
  return { stop, delivered, cancelAt, cancelWhy, rearmAt, open: Math.max(stop?.at || 0, rearmAt) > cancelAt, incident };
}
// The tick's next step for one auto-mode session. One ladder per session at a time; an incident's ladder belongs to
// the kill path (pendingLadders).
export function ladderActions({ lines, entry, flags, callsFor, now, cfg, waits = [] }) {
  const acts = [], firing = new Map(flags.map((f) => [f.signature, f]));
  const sigs = [...new Set(lines.filter((o) => (o.stop_requested === entry.id && o.reason_class === "ladder") || o.ladder_rearmed === entry.id).map((o) => o.signature))];
  let open = null;
  for (const s of sigs) {
    const L = ladderOf(lines, entry.id, s);
    if (!L.open || L.incident) continue;
    if (!firing.has(s)) acts.push({ do: "cancel", signature: s });
    else if (!open) open = { s, L };
  }
  if (open) {
    const f = firing.get(open.s), L = open.L;
    const start = L.rearmAt > L.cancelAt ? L.rearmAt : (L.delivered ?? (f.rule !== "a" || entry.coord !== 1 ? L.stop.at : null));
    if (start == null) {
      // The hook found this stop stale and never injected it: cancel, so the next firing sends a fresh stop (no re-arm).
      acts.push(now - L.stop.at > STOP_EXPIRE_MS ? { do: "cancel", signature: open.s, why: "stop expired" } : { do: "wait", signature: open.s, why: "stop request not delivered yet" });
      return acts;
    }
    const c = callsFor(f) || [];
    const used = graceElapsed({ start, calls: c, preKeys: f.rule === "b" ? null : preKeysOf(c, L.stop?.at ?? start, cfg), now, waits });
    acts.push(used >= cfg.grace_min * MIN ? { do: "kill", signature: open.s, flag: f }
      : { do: "wait", signature: open.s, why: `grace ${Math.round(used / 1000)} s of ${cfg.grace_min} min` });
    return acts;
  }
  const f = flags.find((x) => !ladderOf(lines, entry.id, x.signature).incident);
  if (!f) return acts;
  const L = ladderOf(lines, entry.id, f.signature);
  const rearm = L.stop && L.cancelAt && L.cancelWhy !== "stop expired" && now - L.cancelAt <= REARM_MS;
  acts.push(rearm ? { do: "rearm", signature: f.signature, flag: f } : { do: "stop", signature: f.signature, flag: f });
  return acts;
}
// Ladders to resume at tick start: an auto incident with no later restart, restart_skipped, restart_failed, lane_blocked
// or cancel of its signature.
export function pendingLadders(lines) {
  const out = new Map();
  lines.forEach((inc, i) => {
    if (!inc.incident || inc.mode !== "auto") return;
    const id = inc.incident, after = lines.slice(i + 1);
    if (after.some((o) => (o.restart && o.from === id) || o.restart_skipped === id || (o.restart_failed && o.from === id)
      || (o.lane_blocked && o.incident === inc.path) || (o.ladder_cancelled === id && o.signature === inc.signature))) { out.delete(id); return; }
    out.set(id, { id, incident: inc, intent: after.filter((o) => o.kill_intent === id && o.kind === "ladder").at(-1) || null, closed: after.some((o) => o.closed && o.id === id) });
  });
  return [...out.values()];
}

// ---------- restarts ----------
// {restart} lines of this lane for this handoff since its last {lane_resumed} (a new handoff starts at zero).
export function restartsSince(lines, name, handoff) {
  let n = 0;
  for (const o of lines) { if (o.lane_resumed === name && (!o.handoff || o.handoff === handoff)) n = 0; else if (o.restart === name && o.handoff === handoff) n++; }
  return n;
}
export function restartKind({ restarts, tokens, cfg, isBg, hasSession = true, resumeWorks = RESUME_WORKS }) {
  const big = (tokens ?? 0) >= cfg.fresh_at_tokens;
  if (restarts >= (big ? 1 : cfg.max_restarts)) return "blocked";
  // Resume needs a window session with a known session id; background lanes always restart fresh.
  if (big || restarts > 0 || !resumeWorks || isBg || !hasSession) return "fresh";
  return "resume";
}
const RUNGS = [["opus", "medium"], ["opus", "high"], ["opus", "xhigh"], ["fable", "high"], ["fable", "xhigh"]];
const EFFORTS = ["low", "medium", "high", "xhigh"];
// One rung up the sizing-dispatches ladder; never to max (max only after xhigh already failed, by a person).
export function rungUp(model, effort) {
  const i = RUNGS.findIndex(([m, e]) => m === model && e === effort);
  if (i >= 0) { const [m, e] = RUNGS[Math.min(i + 1, RUNGS.length - 1)]; return { model: m, effort: e }; }
  const j = EFFORTS.indexOf(effort);
  return { model, effort: EFFORTS[Math.min((j < 0 ? 2 : j) + 1, EFFORTS.length - 1)] };
}
export function afterKillPlan({ lines, entry, incident, cfg, doneMarkerExists, pauseActive, prevCauseFilled = true }) {
  if (doneMarkerExists) return { do: "skip", why: "its done marker exists - its work belongs to the merge drain (a relaunch would need --reopen)" };
  const restarts = restartsSince(lines, entry.name, entry.handoff);
  const kind = restartKind({ restarts, tokens: incident?.tokens, cfg, isBg: entry.mode === "bg", hasSession: !!entry.session_id });
  if (kind === "blocked") return { do: "block", restarts };
  if (pauseActive) return { do: "defer", why: "the pause file is active - the restart waits until it lifts" };
  let model = entry.model || "opus", effort = entry.effort || "high"; // lines from before stage 2 restart as opus/high
  if (restarts === 1 && !prevCauseFilled) ({ model, effort } = rungUp(model, effort));
  return { do: "restart", kind, model, effort, restarts };
}
export const CAUSE_PLACEHOLDER = "_(left for the restarted session: the root cause, and the fix)_";
export function causeFilled(text) {
  const m = /^## Cause[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(String(text || ""));
  return !!m && m[1].replace(CAUSE_PLACEHOLDER, "").trim().length > 0;
}
// The launch.mjs arguments of a fresh restart (the ladder's and `launch.mjs resume`'s).
export function freshLaunchArgs(e, { model, effort, recovery }) {
  const a = ["--repo", e.worktree, "--handoff", e.handoff, "--name", e.name];
  if (e.group) a.push("--group", e.group);
  if (e.worktree && e.repo && e.worktree.toLowerCase() !== e.repo) a.push("--worktree", e.branch);
  a.push("--model", model, "--effort", effort, "--mode", e.mode || "window", "--no-close", "--recovery", recovery);
  if (e.session_id) a.push("--goal-from", e.session_id);
  if (e.prompt_file) a.push("--prompt-file", e.prompt_file);
  if (e.group && e.name === `${e.group}-merge`) a.push("--force"); // a legacy merge session: its merge.lock exists
  return a;
}

// ---------- closes, modes, blocked lanes, alerts ----------
export function closeDecision({ state, waitingSince, noClaude, now, cfg, reason }) {
  if (!state.found) return noClaude === true ? { close: true, why: `${reason}: no claude running in the window` }
    : { close: false, why: noClaude === null ? "no transcript and the process probe failed" : "no transcript, but claude is running" };
  if (!state.idle) return { close: false, why: `busy: ${state.busy.join(", ")}` };
  if (waitingSince) return { close: false, why: "waiting for the user (permission prompt)" };
  const idle = now - Date.parse(state.last);
  if (!(idle >= cfg.idle_close_min * MIN)) return { close: false, why: `idle only ${Math.round(idle / MIN)} min` };
  return { close: true, why: `${reason}: idle ${Math.round(idle / MIN)} min` };
}
// auto when the group's (or the lone session's) EARLIEST launch line has coord: 1; the latest {recovery_mode} wins.
export function recoveryMode(lines, entry) {
  const target = entry.group || entry.name;
  let mode = null;
  for (const o of lines) if (o.recovery_mode === target && (o.mode === "auto" || o.mode === "report")) mode = o.mode;
  if (mode) return mode;
  if (!entry.group) return entry.coord === 1 ? "auto" : "report"; // a lone session: its own launch line decides
  const first = lines.find((o) => o.name && o.launched_at && o.group === entry.group && (!entry.repo || o.repo === entry.repo));
  return first?.coord === 1 ? "auto" : "report";
}
export function blockedLanes(lines, group) {
  const m = new Map();
  for (const o of lines) {
    if (o.lane_blocked && (o.group ?? null) === (group ?? null)) m.set(o.lane_blocked, { name: o.lane_blocked, handoff: o.handoff, incident: o.incident, at: o.at });
    else if (o.lane_resumed && (o.group ?? null) === (group ?? null)) m.delete(o.lane_resumed);
  }
  return [...m.values()];
}
export const alertDue = (index, key, now, cfg) => { const last = Date.parse(index?.[key]); return !Number.isFinite(last) || now - last >= cfg.alert_repeat_hours * 3600e3; };

// ---------- the session hook (PostToolUse steps 1-4; step 5, the tick trigger, is the caller's) ----------
// At most one line of context per call; the first step that speaks wins. State: {streaks, warned, agent_notices,
// parent_notices, delivered, waiting_since, waits}. ctx.stops: this session's stop files, ladder first.
export function postToolSteps(state, ev, ctx) {
  const s = { streaks: {}, warned: {}, agent_notices: {}, parent_notices: {}, delivered: {}, ...(state && typeof state === "object" ? state : {}) };
  for (const k of ["streaks", "warned", "agent_notices", "parent_notices", "delivered"]) s[k] = s[k] && typeof s[k] === "object" ? { ...s[k] } : {};
  // A tool call followed any permission prompt: keep that wait (the last 10), so grace never counts it.
  s.waits = (Array.isArray(s.waits) ? s.waits : []).slice(-9);
  if (s.waiting_since && Number.isFinite(Date.parse(s.waiting_since))) s.waits.push([Date.parse(s.waiting_since), ctx.now]);
  s.waiting_since = null;
  const who = ev.agentId || "main", at = new Date(ctx.now).toISOString(), prev = s.streaks[who];
  s.streaks[who] = prev && prev.key === ev.key ? { key: ev.key, n: prev.n + 1 } : { key: ev.key, n: 1 };
  const say = (context, delivered = null) => ({ state: s, context, delivered });
  if (!ev.agentId) for (const st of ctx.stops || []) {
    if (!st?.token || s.delivered[st.token]) continue;
    if (ctx.now - Date.parse(st.at) > STOP_EXPIRE_MS) { s.delivered[st.token] = `expired ${at}`; continue; } // stale: never injected
    s.delivered[st.token] = at;
    return say(st.text, st.token);
  }
  const looping = ctx.looping || {};
  if (ev.agentId && looping[ev.agentId] && !s.agent_notices[ev.agentId]) { s.agent_notices[ev.agentId] = at; return say(SUBAGENT_TEXT(display(looping[ev.agentId].key, 120))); }
  if (!ev.agentId) {
    const id = Object.keys(looping).find((k) => !s.parent_notices[k]);
    if (id) { s.parent_notices[id] = at; const a = looping[id]; return say(PARENT_TEXT({ type: a.type || "agent", id, reason: a.text, transcript: a.transcript })); }
  }
  const n = s.streaks[who].n, sig = `${who}:${shortHash(ev.key)}`;
  if (n >= ctx.cfg.warn_streak && !s.warned[sig] && !ev.key.startsWith("Monitor ")) { s.warned[sig] = at; return say(WARN_TEXT(display(ev.key, 120), n)); }
  return say(null);
}

// ---------- texts ----------
export const STOP_TEXT_LADDER = (sig) => `The coordinator flagged a loop (${sig}). Finish or cancel the current call. Save your state (ledger or handoff, GOAL \`[!] loop-stopped\`). End your turn. If the repetition is intentional waiting, switch to Monitor or ScheduleWakeup instead. The loop is cleared when the repeated call stops, not by one different call.`;
export const SUBAGENT_TEXT = (call) => `You are repeating \`${call}\`. Stop, return what you have and the suspected cause.`;
export const PARENT_TEXT = ({ type, id, reason, transcript }) => `Agent \`${type}\` \`${id}\` is looping (${reason}). TaskStop it, diagnose the cause from \`${transcript}\`, fix the brief or the code, then re-dispatch per sizing-dispatches.`;
export const WARN_TEXT = (call, n) => `You have repeated \`${call}\` ${n} times. Stop, find the cause, change approach. If this is intentional waiting, use Monitor or ScheduleWakeup instead of polling.`;
// No double quotes or semicolons: it becomes part of a launch prompt (launch.mjs replaces them anyway).
export const RECOVERY_LINE = (incidentRef) => `RECOVERY: you were stopped for a loop. Read ${incidentRef}. Find and fix the cause (systematic-debugging), record it in the incident's Cause section and the lane ledger, then continue.`;
const RULES = { a: "the same tool call repeated", b: "a tool call stuck with no activity", d: "waiting on a looping subagent" };
export function incidentText(p) {
  return [
    `# Incident ${p.lane}-${p.n}: loop stopped by the coordinator`, "",
    `- At: ${p.at}`,
    `- Session: ${p.name} (registry id ${p.id}, session ${p.sessionId ?? "?"}, generation ${p.generation ?? "?"})`,
    `- Rule: (${p.rule}) ${RULES[p.rule] || p.rule}`,
    `- Signature: \`${p.signature}\` - ${p.text}`,
    `- Context tokens: ${p.tokens ?? "unknown"}`,
    `- Lane: ${p.lane}, branch ${p.branch ?? "?"}, worktree ${p.worktree ?? "?"}, handoff ${p.handoff ?? "?"}`,
    `- Recovery mode: ${p.mode}`, "",
    "## Last 20 tool calls", ...(p.calls?.length ? p.calls.slice(-20).map((k, i) => `${i + 1}. \`${display(k, 200).replace(/`/g, "'")}\``) : ["(none)"]), "",
    "## Transcripts", `- main: ${p.main ?? "(not found)"}`, ...(p.subs || []).map((s) => `- subagent ${s.id} (${s.type || "agent"}): ${s.file}`), "",
    "## Other background agents (re-dispatch)", ...(p.others?.length ? p.others.map((o) => `- ${o.id} (${o.type || "agent"}): ${o.description || ""}`) : ["(none)"]), "",
    "## Cause", CAUSE_PLACEHOLDER, "",
  ].join("\n");
}
export const ALERT = {
  blocked: ({ name, group, restarts, incident, launchMjs, handoff }) => `${name}${group ? ` (group ${group})` : ""} looped again after ${restarts} restart(s) and is blocked. Incident: ${incident}. `
    + (group ? `Resume it: node ${launchMjs} resume --group ${group} --lane ${name}` : `Relaunch it from ${handoff} with launch.mjs once the cause is fixed.`),
  mergeCap: ({ name, group, lane, incident, launchMjs }) => `Merge session ${name} looped at its restart cap and still holds merge.lock. Incident: ${incident}. `
    + `Next: git merge --abort in .claude/worktrees/_merge-${group}, then node ${launchMjs} merge --group ${group} --force`
    + (lane ? ` (or --skip ${lane} --why ...).` : "."),
  restartFailed: ({ name, group, why, log, incident, launchMjs, handoff }) => `Restart of ${name}${group ? ` (group ${group})` : ""} after a loop failed: ${why}. Log: ${log}. Incident: ${incident}. `
    + (group ? `Fix it, then: node ${launchMjs} resume --group ${group} --lane ${name}` : `Fix it, then relaunch from ${handoff} with launch.mjs.`),
  report: ({ name, group, text, incident, launchMjs }) => `Loop in ${name} (report-only${group ? `, group ${group}` : ""}): ${text}. Incident: ${incident}. Nothing was stopped. `
    + `Opt in: node ${launchMjs} recover ${group ? `--group ${group}` : `--name ${name}`} --mode auto`,
};
```

- [ ] **Step 5: Run the tests**

Run: `node --test claude/skills/handoff-launch/tests/recover-lib.test.mjs`, then the full glob.
Expected: all PASS; full suite `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add claude/skills/handoff-launch/recover-lib.mjs claude/skills/handoff-launch/tests
git commit -m "handoff-launch: recover-lib - pure loop rules, exemptions, re-arming ladder, restart table, closes, hook steps, texts"
```

---

### Task 4: `coord.mjs`, the session hook (post-tool, notify, tick trigger) and `--settings`

**Files:**
- Create: `claude/hooks/coord.mjs`
- Modify: `claude/skills/handoff-launch/live.mjs` (add `COORD_MJS`, `sessionHooksFile`, `triggerTick`)
- Modify: `claude/skills/handoff-launch/launch.mjs` (`--settings` in both launch modes; `triggerTick("launch")` after
  every recorded launch)
- Modify: `claude/skills/handoff-launch/tests/helpers.mjs` (`COORD_MJS`, `coordRun`)
- Test: `claude/skills/handoff-launch/tests/coord-hook.test.mjs` (new)

**Interfaces:**
- Consumes: `live.mjs` (Task 2): `COORD`, `STOP_DIR`, `REG_DIR`, `HERE`, `CFG`, `stem`, `readJson`, `writeAtomic`, `append`,
  `now`, `fwd`; `recover-lib.mjs` (Task 3): `loadConfig`, `callKey`, `postToolSteps`.
- Produces: `coord.mjs` exports `postTool(input, env?) → context|null`, `notify(input, env?)`, `isPermission(input) → bool`
  (Task 6 adds `tick`, Task 9 adds `claimAlert`, `startTick`, `alertSent`, `alertRelease`); CLI `post-tool`, `notify`.
  `live.mjs`: `COORD_MJS`, `sessionHooksFile({write}) → path`, `triggerTick(by, tickMin = 5) → bool` (writes
  `tick.json {at, by, last_run?}` and spawns `node coord.mjs tick` detached unless `HL_NO_SPAWN=1`).
  State files: `CFG/state/coord/sessions/<session id>.json` = `{streaks, warned, agent_notices, parent_notices, delivered, waiting_since}`;
  `CFG/state/coord/looping.json` = `{<session id>: {<agent id>: {key, count, text, type, transcript, signature}}}` (written by
  the tick, Task 6). Stop files: `<REG_DIR>/stops/<stem(registry id)>.<ladder|close|manual>.stop.json` = `{id, token, text, at, ...}`.
- Helpers: `COORD_MJS`, `coordRun(sb, args, {input?, env?}) → {code, out, err}`.
- Probe gate: probes 1, 2, 3, 5. Probe 2's real type value goes into `isPermission`; probe 3's fallback is Step 5b;
  probe 5's is Step 4b.

- [ ] **Step 1: Add the helper**

In `tests/helpers.mjs`:

```js
export const COORD_MJS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "coord.mjs");
// Run claude/hooks/coord.mjs with the sandbox env; input is the hook's stdin (an object is sent as JSON).
export function coordRun(sb, args, { input = "", env = {} } = {}) {
  const r = spawnSync(process.execPath, [COORD_MJS, ...args], { env: { ...sb.env, ...env }, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
}
```

- [ ] **Step 2: Write the failing tests**

`claude/skills/handoff-launch/tests/coord-hook.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun } from "./helpers.mjs";
import * as R from "../recover-lib.mjs";

const SID = "11111111-2222-3333-4444-555555555555", REG_ID = "A@2026-01-01T00-00-00-000Z";
const ev = (o) => ({ session_id: SID, transcript_path: "/t.jsonl", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a" }, ...o });
const ctxOf = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : null);
const hook = (sb, input, env = { HL_SESSION_ID: REG_ID }) => coordRun(sb, ["post-tool"], { input, env });
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "sessions", `${SID}.json`), "utf8"));

test("post-tool steps 1-5 in order: stop (parent only), subagent notice, parent fast path, early warning, tick trigger", () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.join(sb.reg, "stops"), { recursive: true });
    fs.writeFileSync(path.join(sb.reg, "stops", "A-2026-01-01T00-00-00-000Z.manual.stop.json"), JSON.stringify({ id: REG_ID, token: "tok1", text: "STOP NOW" }));
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "looping.json"), JSON.stringify({ [SID]: { ag2: { key: 'Bash {"command":"loop"}', type: "worker-high", text: "same call x5", transcript: "/t/agent-ag2.jsonl" } } }));
    assert.equal(ctxOf(hook(sb, ev({ agent_id: "ag2", agent_type: "worker-high", tool_name: "Bash", tool_input: { command: "loop" } }))), R.SUBAGENT_TEXT('Bash {"command":"loop"}'));
    assert.equal(ctxOf(hook(sb, ev({}))), "STOP NOW");
    assert.ok(sb.registry().some((o) => o.stop_delivered === REG_ID && o.token === "tok1"));
    assert.equal(ctxOf(hook(sb, ev({ tool_input: { file_path: "b" } }))), R.PARENT_TEXT({ type: "worker-high", id: "ag2", reason: "same call x5", transcript: "/t/agent-ag2.jsonl" }));
    const outs = [1, 2, 3, 4].map(() => ctxOf(hook(sb, ev({ tool_name: "Bash", tool_input: { command: "poll" } }))));
    assert.deepEqual(outs, [null, null, R.WARN_TEXT('Bash {"command":"poll"}', 3), null]);
    assert.equal(sb.registry().filter((o) => o.stop_delivered).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "post-tool"); // HL_NO_SPAWN: recorded, not started
  } finally { sb.cleanup(); }
});

test("stop files per reason class: the ladder's goes first, then the others, each once", () => {
  const sb = sandbox();
  try {
    const d = path.join(sb.reg, "stops"), at = new Date().toISOString();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "A-2026-01-01T00-00-00-000Z.close.stop.json"), JSON.stringify({ id: REG_ID, token: "c1", text: "CLOSE STOP", at }));
    fs.writeFileSync(path.join(d, "A-2026-01-01T00-00-00-000Z.ladder.stop.json"), JSON.stringify({ id: REG_ID, token: "l1", text: "LADDER STOP", at }));
    assert.equal(ctxOf(hook(sb, ev({}))), "LADDER STOP");
    assert.equal(ctxOf(hook(sb, ev({ tool_input: { file_path: "b" } }))), "CLOSE STOP");
    assert.equal(ctxOf(hook(sb, ev({ tool_input: { file_path: "c" } }))), null);
    assert.deepEqual(sb.registry().filter((o) => o.stop_delivered).map((o) => o.token), ["l1", "c1"]);
  } finally { sb.cleanup(); }
});

test("notify records waiting_since for a permission prompt only; the next tool call clears it", () => {
  const sb = sandbox();
  try {
    const n = (o) => coordRun(sb, ["notify"], { input: { session_id: SID, hook_event_name: "Notification", ...o }, env: { HL_SESSION_ID: REG_ID } });
    assert.equal(n({ notification_type: "idle_prompt", message: "Claude is waiting for your input" }).out, "");
    assert.equal(fs.existsSync(path.join(sb.coord, "sessions", `${SID}.json`)), false);
    n({ notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    assert.match(state(sb).waiting_since, /^\d{4}-/);
    hook(sb, ev({}));
    assert.equal(state(sb).waiting_since, null);
  } finally { sb.cleanup(); }
});

test("outside a launcher session (no HL_SESSION_ID) the hook does nothing", () => {
  const sb = sandbox();
  try {
    const r = hook(sb, ev({}), {});
    assert.equal(r.code, 0); assert.equal(r.out, "");
    assert.equal(fs.existsSync(sb.coord), false);
  } finally { sb.cleanup(); }
});

test("any error or corrupt state: exit 0, no output", () => {
  const sb = sandbox();
  try {
    for (const input of ["{not json", "", "null", "[]"]) { const r = hook(sb, input); assert.equal(r.code, 0, input); assert.equal(r.out, "", input); }
    fs.mkdirSync(path.join(sb.coord, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "sessions", `${SID}.json`), "{corrupt");
    fs.writeFileSync(path.join(sb.coord, "looping.json"), "[1,2");
    fs.writeFileSync(path.join(sb.coord, "config.json"), "{bad");
    let r = hook(sb, ev({}));
    assert.equal(r.code, 0); assert.equal(r.out, "");
    r = coordRun(sb, ["post-tool"], { input: ev({}), env: { HL_SESSION_ID: REG_ID, HL_SKILL_DIR: path.join(sb.tmp, "missing") } });
    assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    r = coordRun(sb, ["notify"], { input: "{x", env: { HL_SESSION_ID: REG_ID } });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    r = coordRun(sb, ["no-such-subcommand"]);
    assert.equal(r.code, 0); assert.equal(r.out, "");
  } finally { sb.cleanup(); }
});

test("every launch passes the session hooks with --settings and triggers a tick", () => {
  const sb = sandbox();
  try {
    const out = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high").out);
    const f = path.join(sb.reg, "session-hooks.json").split(path.sep).join("/");
    const i = out.claude_args.indexOf("--settings");
    assert.ok(i >= 0); assert.equal(out.claude_args[i + 1], `'${f}'`);
    const h = JSON.parse(fs.readFileSync(f, "utf8")).hooks;
    assert.equal(h.PostToolUse[0].matcher, "*");
    assert.match(h.PostToolUse[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" post-tool$/);
    assert.match(h.Notification[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" notify$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "launch");
    const bg = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "opus", "--effort", "high", "--mode", "bg").out.split("\nHL_NO_SPAWN")[0]);
    const j = bg.command.indexOf("--settings");
    assert.deepEqual(bg.command.slice(j, j + 2), ["--settings", f]);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/coord-hook.test.mjs`
Expected: FAIL: `coord.mjs` does not exist (node exits 1 with `Cannot find module`), so every `code`/`out`
assertion fails; the launch test fails on `indexOf("--settings") >= 0`.

- [ ] **Step 4: Add to `live.mjs`**

```js
// ---------- the coordinator: session hooks file and the tick trigger ----------
// <config>/skills/handoff-launch -> <config>/hooks/coord.mjs (the repo has the same layout: claude/skills, claude/hooks).
export const COORD_MJS = path.resolve(HERE, "..", "..", "hooks", "coord.mjs");
// The hooks every launched session gets with --settings: PostToolUse (all tools) and Notification -> coord.mjs.
export function sessionHooksFile({ write = true } = {}) {
  const f = path.join(REG_DIR, "session-hooks.json");
  const cmd = (sub) => ({ type: "command", command: `node "${fwd(COORD_MJS)}" ${sub}`, timeout: 10 });
  const body = { hooks: { PostToolUse: [{ matcher: "*", hooks: [cmd("post-tool")] }], Notification: [{ hooks: [cmd("notify")] }] } };
  const text = JSON.stringify(body, null, 2) + "\n";
  let cur = null; try { cur = fs.readFileSync(f, "utf8"); } catch {}
  if (write && cur !== text) writeAtomic(f, text);
  return f;
}
// At most one tick per tickMin, from any trigger: claim it in tick.json, then start `coord.mjs tick` detached. Fails
// closed to "no tick" on any error; HL_NO_SPAWN records the claim and starts nothing.
export function triggerTick(by, tickMin = 5) {
  try {
    const f = path.join(COORD, "tick.json"), tj = readJson(f, {}) || {};
    if (Date.parse(tj.at) > Date.now() - tickMin * MIN) return false;
    writeAtomic(f, JSON.stringify({ ...tj, at: now(), by }));
    if (process.env.HL_NO_SPAWN === "1" || !fs.existsSync(COORD_MJS)) return true;
    spawn(process.execPath, [COORD_MJS, "tick"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch { return false; }
}
```

- [ ] **Step 4b (only if probe 5 failed): carry the user's own hooks in the session hooks file**

In `sessionHooksFile`, directly after `const body = ...` add:

```js
  // Probe 5: --settings replaces the user's hooks instead of layering, so carry them (goal-gate included) here too.
  const user = readJson(path.join(CFG, "settings.json"), {})?.hooks || {};
  for (const [ev, list] of Object.entries(user)) if (Array.isArray(list)) body.hooks[ev] = [...list, ...(body.hooks[ev] || [])];
```

- [ ] **Step 5: Create `claude/hooks/coord.mjs`**

```js
// Coordinator hook entry (stage 2 of handoff-launch). Subcommands:
//   post-tool   PostToolUse hook of launcher sessions (launch.mjs passes it with --settings): stop delivery, notices
//               for looping subagents, the early warning and the tick trigger. Prints at most one additionalContext.
//   notify      Notification hook: records waiting_since, for permission prompts only.
// It reads small state files and answers in milliseconds; anything slow is spawned detached. Any error: exit 0 and no
// output - a broken hook must never block a tool call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// <config>/hooks/coord.mjs -> <config>/skills/handoff-launch (the repo has the same layout). HL_SKILL_DIR: tests.
const SKILL = path.resolve(process.env.HL_SKILL_DIR || path.join(HERE, "..", "skills", "handoff-launch"));
const mod = (f) => import(pathToFileURL(path.join(SKILL, f)).href);
const readJson = (f, d) => { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : d; } catch { return d; } };

async function context() {
  const [V, L] = await Promise.all([mod("live.mjs"), mod("recover-lib.mjs")]);
  let text = null; try { text = fs.readFileSync(path.join(V.COORD, "config.json"), "utf8"); } catch {}
  return { V, L, cfg: L.loadConfig(text).config };
}

// Steps 1-5 of the spec's "Prevention: the session hook". Writes only this session's state file and, for a delivered
// stop, this session's {stop_delivered} line.
export async function postTool(input, env = process.env) {
  const regId = env.HL_SESSION_ID, sid = input?.session_id;
  if (!regId || !sid || !input.tool_name) return null;
  const { V, L, cfg } = await context();
  const stateFile = path.join(V.COORD, "sessions", `${sid}.json`);
  const stops = ["ladder", "close", "manual"].map((c) => readJson(path.join(V.STOP_DIR, `${V.stem(regId)}.${c}.stop.json`), null)).filter((s) => s?.id === regId);
  const looping = readJson(path.join(V.COORD, "looping.json"), {})[sid] || {};
  const r = L.postToolSteps(readJson(stateFile, {}), { agentId: input.agent_id || null, key: L.callKey(input.tool_name, input.tool_input) },
    { stops, looping, cfg, now: Date.now() });
  V.writeAtomic(stateFile, JSON.stringify(r.state));
  if (r.delivered) V.append({ stop_delivered: regId, token: r.delivered, at: V.now() });
  V.triggerTick("post-tool", cfg.tick_min);
  return r.context;
}
// Probe 2 recorded the type field: a permission prompt, not an idle prompt, makes the session "waiting for the user".
export const isPermission = (i) => (i?.notification_type ? i.notification_type === "permission_prompt" : /permission/i.test(String(i?.message || "")));
export async function notify(input, env = process.env) {
  if (!env.HL_SESSION_ID || !input?.session_id || !isPermission(input)) return;
  const { V } = await context();
  const f = path.join(V.COORD, "sessions", `${input.session_id}.json`);
  V.writeAtomic(f, JSON.stringify({ ...readJson(f, {}), waiting_since: V.now() }));
}

const stdin = () => { try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; } };
async function main(argv) {
  const sub = argv[0];
  if (sub === "post-tool") {
    const c = await postTool(stdin());
    if (c) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: c } }));
  } else if (sub === "notify") await notify(stdin());
}
const self = (p) => path.resolve(p || "").toLowerCase();
if (self(process.argv[1]) === self(fileURLToPath(import.meta.url))) {
  try { await main(process.argv.slice(2)); } catch {}
  process.exit(0);
}
```

- [ ] **Step 5b (only if probe 3 showed a bg session's hooks do not see `HL_SESSION_ID`)**

In `postTool`, replace `const regId = env.HL_SESSION_ID, sid = input?.session_id;` and the guard after it with:

```js
  const sid = input?.session_id;
  if (!sid || !input.tool_name) return null;
  // Probe 3: a background session's hooks do not see HL_SESSION_ID - find this session's latest launch line instead.
  const regId = env.HL_SESSION_ID || [...(await mod("live.mjs")).readRegistry().entries].reverse().find((e) => e.session_id === sid && e.coord === 1)?.id;
  if (!regId) return null;
```

- [ ] **Step 6: `launch.mjs`: `--settings` and the tick trigger**

1. Add `sessionHooksFile, triggerTick` to the `live.mjs` import.
2. Directly before `if (mode === "bg") {` (the launch tail) add `const hooksFile = fwd(sessionHooksFile({ write: !dry }));`
3. bg: `const bgArgs = ["--bg", "-n", name, "--settings", hooksFile, "--model", model, "--effort", effort, prompt];`
   and after each `append(...)` in the bg branch (the HL_NO_SPAWN one and the real one) call `triggerTick("launch");`.
4. window: `const claudeArgs = ["-n", psq(name), "--session-id", psq(sessionId), "--settings", psq(hooksFile), "--model", psq(model), "--effort", psq(effort), psq(prompt)];`
   and after `append({ ...entry, no_spawn: true });` and after `append(launched);` call `triggerTick("launch");`.
   This replaces the launch-time watchdog (triage T1c): a launch never judges loops itself.

- [ ] **Step 7: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0`.

- [ ] **Step 8: Commit**

```bash
git add claude/hooks/coord.mjs claude/skills/handoff-launch
git commit -m "coord.mjs: session hook (stop delivery, looping-subagent notices, early warning, tick trigger); launches pass it with --settings"
```

---

### Task 5: The restart surface in `launch.mjs` (`--resume`, `--recovery`, `--prompt-file`, `--goal-from`, `recover`, `resume`)

**Files:**
- Modify: `claude/skills/handoff-launch/launch.mjs` (imports; `qs` moves to the globals; new `recover` and `resume`
  subcommands before `if (sub) { ... unknown subcommand ... }`; `resumeLaunch` and its call at the top of the launch
  section; the prompt; the prompt file; the GOAL copy; header usage lines)
- Modify: `claude/skills/handoff-launch/live.mjs` (add `scratchGoal`, `goalOf`, `copyGoal`)
- Test: `claude/skills/handoff-launch/tests/restart.test.mjs` (new)

**Interfaces:**
- Consumes: `live.mjs` (Tasks 2, 4): `COORD`, `PID_DIR`, `sessionHooksFile`, `triggerTick`, `windowScript`, `windowCommand`,
  `spawnWindow`, `psq`, `transcriptOf`, `projectKey`, `CFG`; `recover-lib.mjs` (Task 3): `RECOVERY_LINE`, `blockedLanes`,
  `freshLaunchArgs`.
- Produces: CLI
  - `launch.mjs --resume <session id> [--recovery <incident>] [--model m --effort e] [--dry-run]`: window sessions only;
    newest generation only (exit 3 otherwise); a new launch line `{...prev, id, generation: next, coord: 1,
    resumed_from: prev.id}` with the same `session_id` and `prompt_file`; deletes `CFG/state/coord/sessions/<sid>.json`
    and the session's entry in `looping.json`.
  - `--recovery <incident>` on a normal launch: the prompt starts with `RECOVERY_LINE(<incident, single-quoted if it has
    spaces>)` + one space; `--prompt-file <file>`: the base prompt is that file's text instead of the computed pointer;
    `--goal-from <old session id>`: the old GOAL.md is copied to the new session's scratchpad (window) or
    `CFG/goals/<sid>.md` (bg; window mode writes both). `prompt_file` always stores the base prompt.
  - `launch.mjs recover (--group <id> | --name <s>) --mode auto|report [--dry-run]` → appends `{recovery_mode, mode, at}`;
    `--mode auto` warns about sessions launched before stage 2 (no session hook: stops cannot reach them).
  - `launch.mjs resume --group <id> [--lane <name>] [--dry-run]` → per blocked lane: `{lane_resumed: name, group,
    handoff, at}`, then a fresh launch from the lane's newest line (`freshLaunchArgs`, recovery = its last incident); a
    lane whose newest line is `running` or `unknown` is refused (`not relaunched: <id> is <state>`, exit 1); prints
    `relaunched <lane> fresh (incident <path>); restart budget reset`.
  - `live.mjs`: `goalOf(sid) → path|null`, `copyGoal(fromSid, toDir|null, toSid) → path[]`.
- Probe gate: probe 4 (if `RESUME_WORKS` is false, `--resume` stays available but the ladder never calls it).

- [ ] **Step 1: Write the failing tests**

`claude/skills/handoff-launch/tests/restart.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane, sessionLine, appendLine, setAgents, writeTranscript, tx } from "./helpers.mjs";
import { projectKey } from "../live.mjs";

const fwdp = (p) => p.split(path.sep).join("/");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("recover sets the recovery mode: the latest line wins; bad arguments exit 2", () => {
  const sb = sandbox();
  try {
    launchLane(sb, "g1", "A");
    assert.equal(sb.run("recover", "--group", "g1", "--mode", "report").code, 0);
    assert.equal(sb.run("recover", "--group", "g1", "--mode", "auto").out, "set recovery mode of group g1 to auto\n");
    assert.deepEqual(sb.registry().filter((o) => o.recovery_mode).map((o) => [o.recovery_mode, o.mode]), [["g1", "report"], ["g1", "auto"]]);
    assert.equal(sb.run("recover", "--group", "g1").code, 2);
    assert.equal(sb.run("recover", "--group", "g1", "--name", "A", "--mode", "auto").code, 2);
    assert.equal(sb.run("recover", "--group", "nope", "--mode", "auto").code, 2);
    assert.equal(sb.run("recover", "--name", "A", "--mode", "report", "--dry-run").out, "would set recovery mode of session A to report\n");
    sessionLine(sb, { name: "Old", group: "g9", coord: undefined, branch: "old" });
    assert.match(sb.run("recover", "--group", "g9", "--mode", "auto").out, /^WARN no session hook in Old \(launched before stage 2\): stop requests cannot reach it/m);
  } finally { sb.cleanup(); }
});

test("--resume relaunches the newest generation with the same session id, a RECOVERY prompt and fresh hook state", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: "s-1", model: "fable", effort: "high", prompt_file: fwdp(path.join(sb.reg, "p.txt")) });
    fs.mkdirSync(path.join(sb.coord, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "sessions", "s-1.json"), JSON.stringify({ warned: { x: 1 } }));
    fs.writeFileSync(path.join(sb.coord, "looping.json"), JSON.stringify({ "s-1": { ag: { key: "k" } }, other: { ag: { key: "k" } } }));
    const inc = path.join(sb.repo, ".superpowers", "sessions", "g", "incidents", "A-1.md");
    const r = sb.run("--resume", "s-1", "--recovery", inc);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.deepEqual(out.claude_args.slice(0, 4), ["--resume", "'s-1'", "-n", "'A'"]);
    assert.ok(out.claude_args.includes("--settings"));
    assert.match(out.prompt, new RegExp(`^RECOVERY: you were stopped for a loop\\. Read ${esc(fwdp(inc))}\\. Find and fix the cause`));
    const n = sb.registry().filter((o) => o.name === "A" && o.launched_at).at(-1);
    assert.equal(n.session_id, "s-1"); assert.equal(n.resumed_from, e.id); assert.equal(n.generation, 2);
    assert.equal(n.model, "fable"); assert.equal(n.coord, 1); assert.equal(n.prompt_file, e.prompt_file);
    assert.equal(fs.existsSync(path.join(sb.coord, "sessions", "s-1.json")), false); // its warnings fire again
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "looping.json"), "utf8"))), ["other"]); // its old subagents' flags go too
    sessionLine(sb, { name: "B", id: "B@1", sid: "s-b1", branch: "b" }); sessionLine(sb, { name: "B", id: "B@2", gen: 2, sid: "s-b2", branch: "b" });
    let x = sb.run("--resume", "s-b1");
    assert.equal(x.code, 3); assert.match(x.err, /has a newer launch \(B@2\) - only the newest generation is resumed/);
    sessionLine(sb, { name: "C", sid: "s-c", mode: "bg", bg_id: "bg-c", branch: "c" });
    x = sb.run("--resume", "s-c");
    assert.equal(x.code, 2); assert.match(x.err, /background lanes restart fresh/);
    assert.equal(sb.run("--resume", "nope").code, 2);
  } finally { sb.cleanup(); }
});

test("a fresh restart: the RECOVERY line, then the original pointer prompt; its GOAL.md is copied; prompt_file keeps the base", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A");
    const first = sb.registry().find((o) => o.name === "A");
    const base = fs.readFileSync(first.prompt_file, "utf8");
    // The old session's project folder as Claude Code named it - not what projectKey(path) computes - holds its transcript.
    const key = "Q--claude-chose-this-folder";
    const oldT = path.join(sb.env.HL_PROJECTS_DIR, key, "old-sid.jsonl");
    fs.mkdirSync(path.dirname(oldT), { recursive: true }); fs.writeFileSync(oldT, tx().user("go").entries().map((x) => JSON.stringify(x)).join("\n") + "\n");
    const oldGoal = path.join(sb.temp, "claude", key, "old-sid", "scratchpad", "GOAL.md");
    fs.mkdirSync(path.dirname(oldGoal), { recursive: true }); fs.writeFileSync(oldGoal, "- [ ] finish the lane\n");
    const inc = path.join(sb.tmp, "A-1.md");
    const r = sb.run("--repo", wt, "--handoff", sb.handoff, "--name", "A", "--group", "g1", "--worktree", "lane-A", "--model", "opus", "--effort", "xhigh",
      "--no-close", "--recovery", inc, "--goal-from", "old-sid", "--prompt-file", first.prompt_file);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out), n = sb.registry().filter((o) => o.name === "A").at(-1);
    assert.equal(out.prompt, `RECOVERY: you were stopped for a loop. Read ${fwdp(inc)}. Find and fix the cause (systematic-debugging), record it in the incident's Cause section and the lane ledger, then continue. ${base}`);
    assert.equal(fs.readFileSync(n.prompt_file, "utf8"), base); // no RECOVERY prefix: prefixes never pile up
    assert.equal(n.effort, "xhigh"); assert.equal(n.generation, 2);
    assert.equal(fs.readFileSync(path.join(sb.temp, "claude", key, n.session_id, "scratchpad", "GOAL.md"), "utf8"), "- [ ] finish the lane\n");
    assert.equal(fs.readFileSync(path.join(sb.cfg, "goals", `${n.session_id}.md`), "utf8"), "- [ ] finish the lane\n"); // goal-gate's fallback
    assert.equal(fs.existsSync(path.join(sb.temp, "claude", projectKey(wt), n.session_id)), false);
  } finally { sb.cleanup(); }
});

test("resume --group relaunches blocked lanes fresh from their last incident and resets their restart budget", () => {
  const sb = sandbox();
  try {
    launchLane(sb, "g1", "A"); launchLane(sb, "g1", "B");
    const a = sb.registry().find((o) => o.name === "A");
    appendLine(sb, { lane_blocked: "A", group: "g1", handoff: a.handoff, incident: "C:/inc/A-3.md", at: new Date().toISOString() });
    assert.match(sb.run("resume", "--group", "g1", "--dry-run").out, /^would relaunch A fresh from .* \(incident C:\/inc\/A-3\.md\)$/m);
    const r = sb.run("resume", "--group", "g1");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^relaunched A fresh \(incident C:\/inc\/A-3\.md\); restart budget reset$/m);
    assert.ok(sb.registry().some((o) => o.lane_resumed === "A" && o.group === "g1" && o.handoff === a.handoff));
    assert.equal(sb.registry().filter((o) => o.name === "A" && o.launched_at).length, 2);
    assert.equal(sb.registry().filter((o) => o.name === "B" && o.launched_at).length, 1);
    assert.equal(sb.run("resume", "--group", "g1").out, "no blocked lanes in group g1\n");
    assert.equal(sb.run("resume").code, 2);
  } finally { sb.cleanup(); }
});

test("resume --group refuses a blocked lane whose newest launch is still running", () => {
  const sb = sandbox();
  try {
    const wt = launchLane(sb, "g1", "A"), a = sb.registry().find((o) => o.name === "A"), now = new Date().toISOString();
    sessionLine(sb, { name: "A", id: "A@live", group: "g1", branch: "lane-A", worktree: wt, gen: 2, sid: "s-live", mode: "bg", bg_id: "bg-live" });
    setAgents(sb, [{ id: "bg-live", sessionId: "s-live", name: "A", status: "running" }]); // the "failed" launch did start
    appendLine(sb, { restart_failed: "A", from: a.id, handoff: a.handoff, why: "the launcher exited 1: x", at: now });
    appendLine(sb, { lane_blocked: "A", group: "g1", handoff: a.handoff, incident: "C:/inc/A-1.md", at: now });
    const before = sb.registry().filter((o) => o.launched_at).length;
    const r = sb.run("resume", "--group", "g1");
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^not relaunched: A@live is running \(bg session bg-live\)/m);
    assert.equal(sb.registry().filter((o) => o.launched_at).length, before);
    assert.equal(sb.registry().filter((o) => o.lane_resumed).length, 0);
  } finally { sb.cleanup(); }
});

test("a recovery prompt keeps a spaced incident path intact", () => {
  const sb = sandbox({ space: true });
  try {
    const inc = path.join(sb.tmp, "incidents", "A-1.md");
    const out = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high", "--recovery", inc).out);
    assert.ok(out.prompt.startsWith(`RECOVERY: you were stopped for a loop. Read '${fwdp(inc)}'. Find`), out.prompt);
    assert.doesNotMatch(out.prompt, /[";]/);
    assert.equal(out.claude_args.at(-1), `'${out.prompt.replace(/'/g, "''")}'`);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/restart.test.mjs`
Expected: FAIL: `recover` → `unknown subcommand recover` (exit 2); `--resume` is ignored (the launcher demands
`--handoff`, exit 2); the fresh-restart prompt lacks the RECOVERY line; `resume` → unknown subcommand; the spaced
test's prompt starts with `Continue from`.

- [ ] **Step 3: Add the GOAL helpers to `live.mjs`**

```js
// ---------- GOAL.md across a fresh restart ----------
// goal-gate looks in <tmp>/claude/<project folder>/<sid>/scratchpad/GOAL.md, then <config>/goals/<sid>.md.
export function goalOf(sid) {
  const t = transcriptOf(sid);
  return [t && path.join(os.tmpdir(), "claude", path.basename(path.dirname(t)), sid, "scratchpad", "GOAL.md"), path.join(CFG, "goals", `${sid}.md`)]
    .filter(Boolean).find((p) => fs.existsSync(p)) || null;
}
// Copy the old session's GOAL.md to where goal-gate looks for the new one. A restart runs in the same worktree, so its
// transcript lands in the old one's project folder: that folder's name (not one recomputed from the path, which Claude
// Code may spell differently) keys the new scratchpad. Window mode knows the new id in advance; both modes also get
// <config>/goals/<sid>.md, goal-gate's fallback. -> the paths written.
export function copyGoal(fromSid, toDir, toSid) {
  const src = fromSid && goalOf(fromSid);
  if (!src || !toSid) return [];
  const t = transcriptOf(fromSid), dsts = [path.join(CFG, "goals", `${toSid}.md`)];
  if (toDir) dsts.unshift(path.join(os.tmpdir(), "claude", t ? path.basename(path.dirname(t)) : projectKey(toDir), toSid, "scratchpad", "GOAL.md"));
  for (const d of dsts) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(src, d); }
  return dsts;
}
```

- [ ] **Step 4: `launch.mjs`**

1. Imports: add `COORD, copyGoal, readJson, writeAtomic` to the `live.mjs` import, and
   `import { RECOVERY_LINE, blockedLanes, freshLaunchArgs } from "./recover-lib.mjs";`.
2. Move `const qs = (p) => ...` (Task 0) up to the globals, directly after `const rootArg = ...`.
3. New subcommands, directly before `if (sub) { console.error(\`unknown subcommand ${sub}\`); ... }`:

```js
if (sub === "recover") {
  const g = opt("group") && slug(opt("group")), n = opt("name") && slug(opt("name")), m = opt("mode");
  if (!!g === !!n || !/^(auto|report)$/.test(m || "")) { console.error("recover needs --group <id> or --name <session>, and --mode auto|report"); process.exit(2); }
  if (!reg.entries.some((e) => (g ? e.group === g : e.name === n))) { console.error(`no launch line for ${g ? `group ${g}` : `session ${n}`}`); process.exit(2); }
  if (!dry) append({ recovery_mode: g || n, mode: m, at: now() });
  console.log(`${dry ? "would set" : "set"} recovery mode of ${g ? "group" : "session"} ${g || n} to ${m}`);
  if (m === "auto") { // sessions launched before stage 2 have no session hook: a stop request cannot reach them
    const latest = new Map();
    for (const e of reg.entries) if ((g ? e.group === g : e.name === n) && !reg.closed.has(e.id)) latest.set(e.name, e);
    const old = [...latest.values()].filter((e) => e.coord !== 1).map((e) => e.name);
    if (old.length) console.log(`WARN no session hook in ${old.join(", ")} (launched before stage 2): stop requests cannot reach ${old.length === 1 ? "it" : "them"}, so a loop there is killed grace_min (default 5 min) after the request. Restarted sessions get the hook.`);
  }
  process.exit(0);
}
if (sub === "resume") {
  const g = opt("group") && slug(opt("group")), lane = opt("lane") && slug(opt("lane"));
  if (!g) { console.error("resume needs --group <id> [--lane <name>]"); process.exit(2); }
  const blocked = blockedLanes(reg.lines, g).filter((b) => !lane || b.name === lane);
  if (!blocked.length) { console.log(`no blocked lanes in group ${g}${lane ? ` named ${lane}` : ""}`); process.exit(0); }
  let code = 0;
  for (const b of blocked) {
    const e = [...reg.entries].reverse().find((x) => x.name === b.name && x.group === g);
    // A lane whose newest launch still runs (or cannot be judged) is never relaunched: one worktree, one session.
    const lv = liveness(e, reg);
    if (lv.state !== "gone") { console.log(`not relaunched: ${e.id} is ${lv.state} (${lv.why}) - stop it or wait for it, then re-run`); code = 1; continue; }
    if (dry) { console.log(`would relaunch ${b.name} fresh from ${e.handoff} (incident ${b.incident})`); continue; }
    append({ lane_resumed: b.name, group: g, handoff: e.handoff, at: now() });
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high", recovery: b.incident })], { encoding: "utf8", timeout: 3 * MIN });
    if (r.status === 0) console.log(`relaunched ${b.name} fresh (incident ${b.incident}); restart budget reset`);
    else { code = 1; console.log(`ERROR relaunching ${b.name}: ${`${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-5).join(" | ")}`); }
  }
  process.exit(code);
}
```

4. `resumeLaunch`, defined above `// ---------- launch ----------`, and called first thing in the launch section:

```js
// ---------- --resume <session id>: the ladder's first restart - the same conversation, a new registry line ----------
function resumeLaunch(sid) {
  if (process.platform !== "win32" && process.env.HL_FAKE_CLAUDE !== "1") { console.error("--resume opens a window and only works on Windows"); return 2; }
  const prev = [...reg.entries].reverse().find((e) => e.session_id === sid);
  if (!prev) { console.error(`--resume: no launch line has session id ${sid}`); return 2; }
  const newest = [...reg.entries].reverse().find((e) => e.name === prev.name && e.repo === prev.repo);
  if (newest.id !== prev.id) { console.error(`--resume: ${prev.name} has a newer launch (${newest.id}) - only the newest generation is resumed, so two sessions never share a worktree`); return 3; }
  if (prev.mode === "bg") { console.error(`--resume: ${prev.name} is a background session - background lanes restart fresh`); return 2; }
  const m = opt("model") || prev.model || "opus", ef = opt("effort") || prev.effort || "high";
  const st = new Date().toISOString().replace(/[:.]/g, "-"), rid = `${prev.name}@${st}`, pf = path.join(PID_DIR, `${stem(rid)}.pid`);
  const gen = 1 + Math.max(0, ...reg.entries.filter((e) => e.repo === prev.repo && e.branch === prev.branch).map((e) => e.generation || 0));
  const text = (opt("recovery") ? RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))
    : "Resumed by the launcher: continue from your saved state and ledger resume point - re-check the repo state first, then carry on with your next step.").replace(/"/g, "'").replace(/;/g, ",");
  const e = { ...prev, id: rid, generation: gen, launched_at: now(), host_pid: null, host_start: null, pid_file: fwd(pf), model: m, effort: ef, coord: 1, resumed_from: prev.id };
  delete e.no_spawn; delete e.bg_output;
  const hooks = fwd(sessionHooksFile({ write: !dry }));
  const cargs = ["--resume", psq(sid), "-n", psq(prev.name), "--settings", psq(hooks), "--model", psq(m), "--effort", psq(ef), psq(text)];
  const report = { mode: "window", resume: sid, registry_line: e, prompt: text, claude_args: cargs };
  if (dry) { console.log(JSON.stringify(report, null, 2)); return 0; }
  fs.rmSync(path.join(COORD, "sessions", `${sid}.json`), { force: true }); // its hook state starts over: warnings fire again
  const lp = path.join(COORD, "looping.json"), loops = readJson(lp, {}) || {};
  if (loops[sid]) { delete loops[sid]; writeAtomic(lp, JSON.stringify(loops, null, 2)); } // and its old subagents' flags go
  if (process.env.HL_NO_SPAWN === "1") { console.log(JSON.stringify({ ...report, spawned: false }, null, 2)); append({ ...e, no_spawn: true }); triggerTick("launch"); return 0; }
  const wd = path.resolve(prev.worktree), ps1 = path.join(os.tmpdir(), `claude-handoff-${st}.ps1`);
  const script = windowScript({ pidFile: pf, name: prev.name, workDir: wd, banner: `Resume: ${prev.name} (${sid})`, regId: rid,
    claudeLine: process.env.HL_FAKE_CLAUDE === "1" ? "powershell -NoExit -Command Start-Sleep 600" : `claude ${cargs.join(" ")}` });
  const [exe, exeArgs] = windowCommand(prev.name, wd, ps1);
  console.log(JSON.stringify({ ...report, command: [exe, ...exeArgs] }, null, 2));
  const { launched, latency } = spawnWindow({ entry: e, ps1, script, exe, exeArgs, workDir: wd });
  append(launched);
  triggerTick("launch");
  console.log(launched.host_pid ? `resumed: host pid ${launched.host_pid} (pid file after ${latency} ms), generation ${gen}` : `resumed, but no pid file after 20 s (${fwd(pf)}) - check the window`);
  return 0;
}
```

   First line of the launch section (before `const repo = path.resolve(opt("repo", process.cwd()));`):

```js
if (opt("resume")) process.exit(resumeLaunch(opt("resume")));
```

5. The prompt. Replace the `const prompt = (...)...;` statement with:

```js
const pointer = `Continue from the handoff at ${qs(handoffRef)} - read it first, then follow its paste-ready prompt section exactly.` + laneNote;
// --prompt-file: a fresh restart reuses the exact pointer prompt of the launch it replaces.
let basePrompt = pointer;
if (opt("prompt-file")) { try { basePrompt = fs.readFileSync(opt("prompt-file"), "utf8").trim() || pointer; } catch {} }
const clean = (s) => s.replace(/"/g, "'").replace(/;/g, ",");
const recovery = opt("recovery") ? `${RECOVERY_LINE(qs(fwd(path.resolve(opt("recovery")))))} ` : "";
const prompt = clean(recovery + basePrompt);
```

   and the prompt file write in the launch tail becomes `fs.writeFileSync(promptFile, clean(basePrompt));` (the base
   prompt, never the RECOVERY prefix).
6. GOAL copy. Directly after `const noSpawn = ...` add:

```js
if (!dry && opt("goal-from") && sessionId) copyGoal(opt("goal-from"), workDir, sessionId); // window: the id is known now
```

   and in the bg branch, after the real `append({ ...entry, bg_id: ... })`:
   `if (opt("goal-from") && hit?.sessionId) copyGoal(opt("goal-from"), null, hit.sessionId);`
7. Header usage: add the lines
   `//   node launch.mjs --resume <session id> [--recovery <incident>]           (the coordinator's first restart)`,
   `//   node launch.mjs recover (--group <id> | --name <session>) --mode auto|report`,
   `//   node launch.mjs resume --group <id> [--lane <name>]                     (relaunch blocked lanes fresh)`,
   and on the main launch line `[--recovery <incident>] [--prompt-file <file>] [--goal-from <session id>]`.

- [ ] **Step 5: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "handoff-launch: restart surface - --resume, --recovery, --prompt-file, --goal-from, recover and resume subcommands"
```

---

### Task 6: `recover.mjs`, the tick

**Files:**
- Create: `claude/skills/handoff-launch/recover.mjs`
- Modify: `claude/hooks/coord.mjs` (the `tick` subcommand)
- Modify: `claude/skills/handoff-launch/launch.mjs` (`watchdog` = the tick's dry run; `--stop-looping` runs it)
- Test: `claude/skills/handoff-launch/tests/recover.test.mjs` (new)

**Interfaces:**
- Consumes: `live.mjs` (Tasks 2, 4): `COORD, HERE, readRegistry, append, readJson, writeAtomic, now, ago, liveness,
  primeLiveness, forgetLiveness, transcriptOf, tail, subagentFiles, requestStop, killTree, pidAlive, selfStart`;
  `recover-lib.mjs` (Task 3): everything in its Produces list; `launch.mjs` restart flags (Task 5).
- Produces (`recover.mjs` exports): `tick({dryRun?, repoKey?}) → string[]`; `acquireTickLock() → bool`;
  `releaseTickLock()`; `loadCfg() → {config, errors}`; `pauseActive(now?) → bool`; `observe(e, {prevRun, looping, now}) → obs`;
  `raiseAlert({name, text, incident}) → file`. Registry lines written: `{stop_requested ... reason_class: "ladder",
  signature, token}` (via `requestStop`), `{ladder_cancelled: id, name, signature, at}`, `{ladder_rearmed: id, name,
  signature, at}`, `{incident: id, name, n, path, signature, rule, tokens, mode, at}`, `{kill_intent ... kind: "ladder"}`
  and `{closed}` (via `killTree`), `{restart: name, n, kind, from, handoff, model, effort, at}`,
  `{restart_skipped: id, name, why, at}`, `{restart_failed: name, n, kind, from, handoff, why, log, at}` (`{restart}` gains
  `launcher_exit` when the launcher failed after registering the session),
  `{lane_blocked: name, group, handoff, incident, at}`. State files:
  `tick.json {at, by?, last_run}`, `tick.lock {pid, start, at}`, `looping.json`, `alerts/<stamp>-<name>.json {text,
  incident, created}`, `alerts/index.json {"<id>|<signature>": lastAlertAt}`, `last-tick.txt`, incidents in
  `<group dir>/incidents/<lane>-<n>.md` or `CFG/state/coord/incidents/<name>-<n>.md`. CLI: `coord.mjs tick [--dry-run]`,
  `launch.mjs watchdog [--repo <dir>] [--stop-looping]`. Restart logs: `CFG/state/coord/restarts/<name>-<stamp>.log`.
  (Task 7 adds `guardedClose`, `supersededScan`; Task 9 adds `desktopNotify`, `releaseStaleClaims`.)

- [ ] **Step 1: Write the failing tests**

`claude/skills/handoff-launch/tests/recover.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, writeTranscript, writeSubagent, setAgents, coordRun, tx } from "./helpers.mjs";
import { callKey, shortHash } from "../recover-lib.mjs";

const MIN = 60000, SID = "aaaaaaaa-0000-0000-0000-000000000001";
const tick = (sb, ...a) => coordRun(sb, ["tick", ...a]);
const agents = (sb) => JSON.parse(fs.readFileSync(path.join(sb.tmp, "agents.json"), "utf8"));
// A running background session (listed by claude agents) whose transcript repeats one call 5 times.
function loopingLane(sb, o = {}) {
  const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", ...o });
  setAgents(sb, [...agents(sb), { id: e.bg_id, sessionId: e.session_id, name: e.name, status: "running" }]);
  let t = tx({ start: Date.now() - 10 * MIN }).user("go");
  for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
  writeTranscript(sb, sb.repo, e.session_id, t.entries());
  return e;
}

test("report-only: a loop in a pre-stage-2 session gets one incident and one alert per signature, nothing stopped", () => {
  const sb = sandbox();
  try {
    loopingLane(sb, { coord: undefined });
    let r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^report-only A: same call x5 .* - incident .*\/incidents\/A-1\.md, alerted$/m);
    const inc = sb.registry().filter((o) => o.incident);
    assert.equal(inc.length, 1); assert.equal(inc[0].mode, "report");
    assert.equal(sb.registry().filter((o) => o.stop_requested || o.kill_intent).length, 0);
    const alerts = () => fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => /^\d.*\.json$/.test(f));
    assert.equal(alerts().length, 1);
    assert.match(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", alerts()[0]), "utf8")).text, /Nothing was stopped\. Opt in: node .* recover --name A --mode auto$/);
    tick(sb);
    assert.equal(sb.registry().filter((o) => o.incident).length, 1); assert.equal(alerts().length, 1);
    const ix = path.join(sb.coord, "alerts", "index.json"), idx = JSON.parse(fs.readFileSync(ix, "utf8"));
    for (const k of Object.keys(idx)) idx[k] = new Date(Date.now() - 7 * 3600e3).toISOString();
    fs.writeFileSync(ix, JSON.stringify(idx));
    tick(sb);
    assert.equal(alerts().length, 2); assert.equal(sb.registry().filter((o) => o.incident).length, 1);
    assert.equal(agents(sb).length, 1);
  } finally { sb.cleanup(); }
});

test("auto ladder: stop request, delivery, grace, incident, kill, fresh restart (a bg lane restarts fresh)", () => {
  const sb = sandbox();
  try {
    const e = loopingLane(sb);
    let r = tick(sb);
    assert.match(r.out, /^LOOPING A \(gen 1\): same call x5 .* - stop requested: loop: /m);
    const stop = JSON.parse(fs.readFileSync(path.join(sb.reg, "stops", `${e.id.replace(/[^\w.-]+/g, "-")}.ladder.stop.json`), "utf8"));
    assert.equal(stop.reason_class, "ladder"); assert.match(stop.text, /^The coordinator flagged a loop \(a:main:/);
    assert.match(tick(sb).out, /stop request not delivered yet/);
    appendLine(sb, { stop_delivered: e.id, token: stop.token, at: new Date(Date.now() - 6 * MIN).toISOString() });
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^incident .*\/incidents\/A-1\.md for A/m);
    assert.match(r.out, /^killed A: closed$/m);
    assert.match(r.out, /^restarted A: fresh \(opus\/high\)/m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.kill_intent === e.id && o.kind === "ladder"));
    assert.ok(lines.some((o) => o.closed && o.id === e.id));
    assert.ok(lines.some((o) => o.restart === "A" && o.kind === "fresh" && o.from === e.id && o.n === 1));
    const relaunch = lines.filter((o) => o.name === "A" && o.launched_at).at(-1);
    assert.notEqual(relaunch.id, e.id); assert.equal(relaunch.mode, "bg");
    assert.equal(agents(sb).length, 0); // claude stop (fake) took it off the list
    assert.match(fs.readFileSync(lines.find((o) => o.incident).path, "utf8"), /## Last 20 tool calls\n1\. `Bash \{"command":"poll"\}`/);
  } finally { sb.cleanup(); }
});

test("a resumed session is not re-flagged by its pre-kill calls", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", launched_at: new Date(Date.now() - 5 * MIN).toISOString() });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    let t = tx({ start: Date.now() - 20 * MIN }).user("go");
    for (let i = 0; i < 6; i++) t = t.call("Bash", { command: "poll" }); // the loop that got it killed, before this launch line
    t.at(Date.now() - 2 * MIN).call("Read", { file_path: "incident.md" }).call("Edit", { file_path: "x" });
    writeTranscript(sb, sb.repo, SID, t.entries());
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /LOOPING/);
    assert.equal(sb.registry().filter((o) => o.stop_requested).length, 0);
  } finally { sb.cleanup(); }
});

test("legacy registry lines: no restart, no kill, report-only", () => {
  const sb = sandbox();
  try {
    const old = loopingLane(sb, { name: "L", bg_id: "bg-L", group: "g0", coord: undefined, model: undefined, effort: undefined });
    const gone = sessionLine(sb, { name: "M", id: "M@1", group: "g0", coord: undefined, model: undefined, effort: undefined, branch: "m" });
    appendLine(sb, { stop_requested: old.id, name: "L", why: "watchdog: same tool call x4", at: new Date(Date.now() - 60 * MIN).toISOString() });
    appendLine(sb, { kill_intent: gone.id, name: "M", why: "watchdog: still looping", at: new Date(Date.now() - 50 * MIN).toISOString() });
    appendLine(sb, { closed: "M", id: gone.id, at: new Date(Date.now() - 50 * MIN).toISOString() });
    const before = sb.registry().length;
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    const added = sb.registry().slice(before);
    assert.deepEqual(added.map((o) => Object.keys(o)[0]), ["incident"]);
    assert.equal(added[0].mode, "report");
    assert.equal(agents(sb).length, 1); // nothing stopped
  } finally { sb.cleanup(); }
});

test("tick.lock: a live holder blocks a second tick; a dead holder's lock is reclaimed", () => {
  const sb = sandbox();
  try {
    loopingLane(sb, { coord: undefined });
    fs.mkdirSync(sb.coord, { recursive: true });
    const lock = path.join(sb.coord, "tick.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    let r = tick(sb);
    assert.equal(r.out, "tick: another tick holds tick.lock - skipped\n");
    assert.equal(sb.registry().filter((o) => o.incident).length, 0);
    assert.equal(fs.existsSync(path.join(sb.coord, "tick.json")), false);
    fs.writeFileSync(lock, JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid, at: new Date().toISOString() }));
    r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.equal(sb.registry().filter((o) => o.incident).length, 1);
    assert.equal(fs.existsSync(lock), false); // released after the run
    if (process.platform === "win32") { // a live pid whose process started after the lock was taken: PID reuse, reclaimed
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: "2020-01-01T00:00:00.000Z", at: new Date().toISOString() }));
      assert.notEqual(tick(sb).out, "tick: another tick holds tick.lock - skipped\n");
      assert.equal(fs.existsSync(lock), false);
    }
  } finally { sb.cleanup(); }
});

test("a tick that died after the kill: the next tick records the close and restarts, once", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    setAgents(sb, []); // the kill went through: the session is gone
    const inc = path.join(sb.coord, "incidents", "A-1.md");
    fs.mkdirSync(path.dirname(inc), { recursive: true }); fs.writeFileSync(inc, "# Incident A-1\n");
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: inc.split(path.sep).join("/"), signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: fresh/m);
    assert.ok(sb.registry().some((o) => o.closed && o.id === e.id));
    assert.equal(sb.registry().filter((o) => o.restart === "A" && o.from === e.id).length, 1);
    assert.equal(tick(sb).out, "tick: nothing to do\n");
    assert.equal(sb.registry().filter((o) => o.restart).length, 1);
  } finally { sb.cleanup(); }
});

test("a lane whose done marker exists is killed but not restarted", () => {
  const sb = sandbox();
  try {
    const marker = path.join(sb.repo, ".superpowers", "sessions", "g1", "A.done"), body = JSON.stringify({ head: "abc", status: "done" });
    fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, body);
    const e = sessionLine(sb, { name: "A", group: "g1", sid: SID, mode: "bg", bg_id: "bg-A", done_marker: marker.split(path.sep).join("/") });
    setAgents(sb, []);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = tick(sb);
    assert.match(r.out, /^A killed, not restarted: its done marker exists/m);
    assert.ok(sb.registry().some((o) => o.restart_skipped === e.id));
    assert.equal(sb.registry().filter((o) => o.restart).length, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), body); // the tick never writes a done marker
  } finally { sb.cleanup(); }
});

const LOOP_SIG = `a:main:${shortHash(callKey("Bash", { command: "poll" }))}`;
// The ladder reached its incident but the kill never started (or must be retried): stop, delivery, incident.
function killPending(sb, e, { stopFile = true } = {}) {
  const ago = (m) => new Date(Date.now() - m * MIN).toISOString();
  appendLine(sb, { stop_requested: e.id, name: e.name, why: "loop", reason_class: "ladder", signature: LOOP_SIG, token: "tk", at: ago(8) });
  if (stopFile) { fs.mkdirSync(path.join(sb.reg, "stops"), { recursive: true }); fs.writeFileSync(path.join(sb.reg, "stops", "A-1.ladder.stop.json"), JSON.stringify({ id: e.id, token: "tk", text: "x" })); }
  appendLine(sb, { stop_delivered: e.id, token: "tk", at: ago(7) });
  appendLine(sb, { incident: e.id, name: e.name, n: 1, path: "x/incidents/A-1.md", signature: LOOP_SIG, rule: "a", tokens: 1000, mode: "auto", at: ago(1) });
}

test("an incident whose kill never started, and the rule stopped meanwhile: cancelled, nothing killed, not pending; it can re-arm", () => {
  const sb = sandbox();
  try {
    const e = loopingLane(sb);
    killPending(sb, e);
    let t = tx({ start: Date.now() - 10 * MIN }).user("go");
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
    for (let i = 0; i < 18; i++) t = t.call("Read", { file_path: `f${i}` }); // it moved on: the repeated call left the window
    writeTranscript(sb, sb.repo, SID, t.entries());
    assert.match(tick(sb).out, new RegExp(`^cancelled the ladder ${LOOP_SIG} of A: the rule stopped firing before the kill`, "m"));
    assert.equal(sb.registry().filter((o) => o.kill_intent).length, 0);
    assert.equal(agents(sb).length, 1);
    assert.equal(fs.existsSync(path.join(sb.reg, "stops", "A-1.ladder.stop.json")), false); // never delivered later
    assert.doesNotMatch(tick(sb).out, /cancelled|kill/); // not pending any more
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" }); // the same loop again
    writeTranscript(sb, sb.repo, SID, t.entries());
    assert.match(tick(sb).out, /fired again within 60 min of its cancel: resumed at the grace step/);
  } finally { sb.cleanup(); }
});

test("an incident whose kill never started, and the rule still fires: killed and restarted", () => {
  const sb = sandbox();
  try {
    const e = loopingLane(sb);
    killPending(sb, e, { stopFile: false });
    const r = tick(sb);
    assert.match(r.out, /^killed A: closed$/m);
    assert.match(r.out, /^restarted A: fresh/m);
    assert.ok(sb.registry().some((o) => o.kill_intent === e.id && o.kind === "ladder"));
  } finally { sb.cleanup(); }
});

test("a killed lane with a newer live generation is not restarted (two sessions never share a worktree)", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    sessionLine(sb, { name: "A", id: "A@2", gen: 2, sid: "sid-2", mode: "bg", bg_id: "bg-A2" });
    setAgents(sb, [{ id: "bg-A2", sessionId: "sid-2", name: "A", status: "running" }]);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    assert.match(tick(sb).out, /^A killed, not restarted: superseded by A@2$/m);
    assert.ok(sb.registry().some((o) => o.restart_skipped === e.id && o.why === "superseded by A@2"));
    assert.equal(sb.registry().filter((o) => o.restart).length, 0);
  } finally { sb.cleanup(); }
});

test("a killed lane whose newer generation is gone without a close: blocked and alerted, never restarted from the old handoff", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", group: "g1", sid: SID, mode: "bg", bg_id: "bg-A" });
    sessionLine(sb, { name: "A", id: "A@2", group: "g1", gen: 2, sid: "sid-2", mode: "bg", bg_id: "bg-A2", handoff: path.join(sb.tmp, "stage2.md") });
    setAgents(sb, []); // both gone; A@2 has no {closed} line
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    assert.match(tick(sb).out, /^A killed, not restarted: superseded by A@2, which is gone - blocked, alert /m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.lane_blocked === "A" && o.handoff === path.join(sb.tmp, "stage2.md").split(path.sep).join("/")));
    assert.equal(lines.filter((o) => o.restart).length, 0);
    assert.equal(tick(sb).out, "tick: nothing to do\n");
  } finally { sb.cleanup(); }
});

test("a launcher that registers the session and then fails: {restart} with launcher_exit, no block, one alert, nothing pending", () => {
  const sb = sandbox();
  try {
    // A stand-in launcher: it records the new session's launch line, then exits 7 (as claude --bg can after starting).
    const stub = path.join(sb.tmp, "launcher-stub.cjs");
    fs.writeFileSync(stub, [
      'const fs = require("fs"), path = require("path"), a = process.argv.slice(2), name = a[a.indexOf("--name") + 1];',
      'fs.appendFileSync(path.join(process.env.HL_REGISTRY_DIR, "sessions.jsonl"), JSON.stringify({ id: name + "@stub", name, repo: "x", branch: "y", generation: 9, mode: "bg", launched_at: new Date().toISOString(), no_spawn: true }) + "\\n");',
      'console.error("claude --bg reported failure"); process.exit(7);'].join("\n"));
    const env = { HL_LAUNCH_MJS: stub };
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    setAgents(sb, []);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    const r = coordRun(sb, ["tick"], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^restarted A: fresh \(opus\/high\) - the launcher then failed \(the launcher exited 7: claude --bg reported failure, log .*\/restarts\/A-.*\.log\), but it registered the session - alert .*\.json$/m);
    const lines = sb.registry();
    assert.equal(lines.find((o) => o.restart === "A" && o.from === e.id).launcher_exit, "the launcher exited 7: claude --bg reported failure");
    assert.equal(lines.filter((o) => o.lane_blocked || o.restart_failed).length, 0);
    const d = path.join(sb.coord, "alerts");
    const al = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.equal(al.length, 1); // one alert: it was registered, but may not be running
    assert.match(JSON.parse(fs.readFileSync(path.join(d, al[0]), "utf8")).text, /^Restart of A was registered but its launcher exited 7: claude --bg reported failure \(log .*\)\. Check claude agents; if it is not running, stop\/judge it and relaunch by hand\.$/);
    assert.equal(coordRun(sb, ["tick"], { env }).out, "tick: nothing to do\n"); // nothing pending for that ladder
  } finally { sb.cleanup(); }
});

test("a restart that fails to launch: {restart_failed}, the lane is blocked, an alert names the log; never retried", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", handoff: path.join(sb.tmp, "missing.md") });
    setAgents(sb, []);
    appendLine(sb, { incident: e.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", rule: "a", tokens: 1000, mode: "auto", at: new Date().toISOString() });
    appendLine(sb, { kill_intent: e.id, name: "A", kind: "ladder", why: "loop ladder", at: new Date().toISOString() });
    assert.match(tick(sb).out, /^restart of A failed: the launcher exited 2: handoff not found: .* \(log .*\/restarts\/A-.*\.log\) - blocked, alert /m);
    const lines = sb.registry();
    assert.ok(lines.some((o) => o.restart_failed === "A" && o.from === e.id));
    assert.equal(lines.filter((o) => o.restart).length, 0);
    assert.ok(lines.some((o) => o.lane_blocked === "A"));
    const d = path.join(sb.coord, "alerts"), [f] = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.match(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).text, /^Restart of A after a loop failed: .* Log: /);
    assert.equal(tick(sb).out, "tick: nothing to do\n");
  } finally { sb.cleanup(); }
});

test("an idle session whose finished turn repeated a call hours ago is not flagged", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A", launched_at: new Date(Date.now() - 4 * 3600e3).toISOString() });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    let t = tx({ start: Date.now() - 3 * 3600e3 }).user("go");
    for (let i = 0; i < 4; i++) t = t.call("Bash", { command: "poll" });
    writeTranscript(sb, sb.repo, SID, t.say("done").turnDone().entries());
    assert.doesNotMatch(tick(sb).out, /LOOPING/);
    assert.equal(sb.registry().filter((o) => o.stop_requested).length, 0);
  } finally { sb.cleanup(); }
});

test("launch.mjs watchdog prints the tick's decisions and writes nothing", () => {
  const sb = sandbox();
  try {
    loopingLane(sb);
    const before = sb.registry().length;
    const r = sb.run("watchdog");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^LOOPING A \(gen 1\): same call x5 .* - would request stop: loop: /m);
    assert.equal(sb.registry().length, before);
    for (const f of ["looping.json", "tick.json", "tick.lock"]) assert.equal(fs.existsSync(path.join(sb.coord, f)), false, f);
    assert.equal(fs.existsSync(path.join(sb.reg, "stops")), false);
  } finally { sb.cleanup(); }
});

test("an unknown probe: the tick takes no action and says so", () => {
  const sb = sandbox();
  try {
    loopingLane(sb);
    const before = sb.registry().length;
    const r = coordRun(sb, ["tick"], { env: { HL_FAKE_PROBE: "fail" } });
    assert.match(r.out, /^unknown A: liveness unknown \(process probe failed .*\) - no action$/m);
    assert.equal(sb.registry().length, before);
  } finally { sb.cleanup(); }
});

test("a looping subagent: looping.json, its notice through the hook, then rule (d) puts the session on the ladder", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "A", sid: SID, mode: "bg", bg_id: "bg-A" });
    setAgents(sb, [{ id: "bg-A", sessionId: SID, name: "A", status: "running" }]);
    writeTranscript(sb, sb.repo, SID, tx({ start: Date.now() - 5 * MIN }).user("go").call("Agent", { prompt: "find x" }, { result: false }).entries());
    let s = tx({ start: Date.now() - 4 * MIN }).user("task");
    for (let i = 0; i < 5; i++) s = s.call("Grep", { pattern: "x" });
    writeSubagent(sb, sb.repo, SID, "ag1", s.entries(), { agentType: "worker-high", requestShape: "foreground", description: "find x" });
    tick(sb);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "looping.json"), "utf8"))[SID]), ["ag1"]);
    const h = coordRun(sb, ["post-tool"], { input: { session_id: SID, agent_id: "ag1", tool_name: "Grep", tool_input: { pattern: "x" } }, env: { HL_SESSION_ID: e.id } });
    assert.match(JSON.parse(h.out).hookSpecificOutput.additionalContext, /^You are repeating `Grep \{"pattern":"x"\}`/);
    assert.match(tick(sb).out, /^LOOPING A \(gen 1\): waiting on looping subagent worker-high ag1 .* - stop requested/m);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/recover.test.mjs`
Expected: FAIL: `coord.mjs tick` prints nothing (no such subcommand yet), so every `match` fails; `watchdog` prints
the interim line Task 2 left.

- [ ] **Step 3: Write `recover.mjs`**

```js
// The stage-2 coordinator tick: scan the launcher registry, flag loops, run the ladder (stop request -> grace ->
// incident -> kill -> restart or block), close superseded windows, raise alerts. Every decision comes from
// recover-lib.mjs; this file reads state and acts. It writes only: the target's registry lines, stop file, incident
// and hook state; looping.json; alerts/. Never a done marker, merge.lock, another lane's files or another worktree.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as L from "./recover-lib.mjs";
import * as V from "./live.mjs";
import { fwd, stem } from "./merge-lib.mjs";

// HL_LAUNCH_MJS: tests stand a fake launcher in for launch.mjs.
const LAUNCH = process.env.HL_LAUNCH_MJS || path.join(V.HERE, "launch.mjs");
const C = (...p) => path.join(V.COORD, ...p);
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
export const loadCfg = () => { let t = null; try { t = fs.readFileSync(C("config.json"), "utf8"); } catch {} return L.loadConfig(t); };
export const pauseActive = (now = Date.now()) => { const p = V.readJson(C("pause.json"), null); return !!p && (p.until == null || Date.parse(p.until) > now); };
const pausedLine = (lines, e) => lines.some((o) => o.paused && (o.paused === e.name || o.paused === e.id) && (Date.parse(o.at) || 0) >= (Date.parse(e.launched_at) || 0));
const isMergeName = (e) => !!e.group && (e.name === `${e.group}-merge` || e.name.startsWith(`${e.group}-merge-`));
const incidentPath = (e, n) => (e.done_marker ? path.join(path.dirname(e.done_marker), "incidents", `${e.name}-${n}.md`) : C("incidents", `${e.name}-${n}.md`));

// ---------- tick.lock: exclusive create; a dead or > 10 min old holder is reclaimed ----------
export function acquireTickLock() {
  fs.mkdirSync(V.COORD, { recursive: true });
  const f = C("tick.lock");
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: V.selfStart(), at: V.now() }), { flag: "wx" }); return true; }
    catch (e) { if (e.code !== "EEXIST") return false; }
    const held = V.readJson(f, null);
    // A live pid whose process started well after the lock was taken is another process (PID reuse): the holder is dead.
    const st = held?.start ? V.procStart(held.pid) : null, reused = st != null && st - Date.parse(held.start) > 10000;
    if (held && V.pidAlive(held.pid) && !reused && V.ago(held.at) < 10 * L.MIN) return false;
    // Move aside only the lock judged dead here; if another tick replaced it meanwhile, put that one back.
    const aside = `${f}.reclaimed-${process.pid}`;
    try { fs.renameSync(f, aside); } catch { continue; }
    if (JSON.stringify(V.readJson(aside, null)) === JSON.stringify(held)) fs.rmSync(aside, { force: true });
    else { try { fs.renameSync(aside, f); } catch {} return false; }
  }
  return false;
}
export const releaseTickLock = () => { const f = C("tick.lock"); if (V.readJson(f, {})?.pid === process.pid) fs.rmSync(f, { force: true }); };

// ---------- what the tick reads per live session ----------
export function observe(e, { prevRun, looping, now }) {
  const sid = e.session_id || null, since = Date.parse(e.launched_at) || 0;
  const file = V.transcriptOf(sid);
  const entries = file ? V.tail(file).filter((x) => !x.isSidechain) : [];
  const calls = L.toolCalls(entries, since);
  const lastEntryAt = Math.max(since, ...entries.map((x) => Date.parse(x.timestamp) || 0));
  const all = V.subagentFiles(sid).filter((s) => s.mtimeMs >= since);
  // Read only subagent transcripts that grew since the previous tick or are still flagged; the rest count as activity.
  const subs = all.map((s) => {
    if (!(s.mtimeMs > prevRun) && !looping?.[s.agentId]) return { id: s.agentId, type: s.meta?.agentType || null, file: fwd(s.file), calls: [], grewAt: s.mtimeMs, done: false };
    const se = V.tail(s.file);
    return { id: s.agentId, type: s.meta?.agentType || null, file: fwd(s.file), calls: L.toolCalls(se, since), grewAt: s.mtimeMs, done: L.agentDone(se) };
  });
  const hook = V.readJson(C("sessions", `${sid}.json`), {}) || {};
  return { sid, file, entries, calls, lastEntryAt, subs, hook, hooked: e.coord === 1, now, tokens: L.contextTokens(entries), waitingSince: hook.waiting_since || null };
}

// ---------- alerts (Task 9 adds the desktop notification) ----------
export function raiseAlert({ name, text, incident }) {
  const f = C("alerts", `${V.now().replace(/[:.]/g, "-")}-${stem(name)}.json`);
  V.writeAtomic(f, JSON.stringify({ text, incident, created: V.now() }, null, 2));
  return f;
}

// ---------- incident, kill, restart, block ----------
function writeIncident(e, flag, obs, n, file, mode) {
  const subsAll = V.subagentFiles(e.session_id).map((s) => ({ ...s, entries: V.tail(s.file) }));
  const others = subsAll.filter((s) => s.meta?.requestShape === "background" && s.agentId !== flag.scope && !L.agentDone(s.entries))
    .map((s) => ({ id: s.agentId, type: s.meta?.agentType, description: s.meta?.description }));
  const calls = flag.rule === "d" ? obs.subs.find((s) => s.id === flag.scope)?.calls || [] : obs.calls;
  V.writeAtomic(file, L.incidentText({ lane: e.name, n, at: V.now(), name: e.name, id: e.id, sessionId: e.session_id, generation: e.generation,
    rule: flag.rule, signature: flag.signature, text: flag.text, tokens: obs.tokens, branch: e.branch, worktree: e.worktree, handoff: e.handoff,
    mode, calls: calls.map((c) => c.key), main: obs.file && fwd(obs.file), subs: subsAll.map((s) => ({ id: s.agentId, type: s.meta?.agentType, file: fwd(s.file) })), others }));
}
function incidentAndKill(e, flag, obs, { dryRun, cfg }) {
  const n = 1 + V.readRegistry().lines.filter((o) => o.incident && o.name === e.name).length, file = incidentPath(e, n);
  if (dryRun) return [`would write ${fwd(file)} and kill ${e.name}: ${flag.text}`];
  writeIncident(e, flag, obs, n, file, "auto");
  V.append({ incident: e.id, name: e.name, n, path: fwd(file), signature: flag.signature, rule: flag.rule, tokens: obs.tokens, mode: "auto", at: V.now() });
  return [`incident ${fwd(file)} for ${e.name} (${flag.text})`, ...killAndContinue(e, cfg)];
}
function killAndContinue(e, cfg) {
  const k = V.killTree(e, "loop ladder: still looping after the grace period", "ladder");
  if (!k.closed) return [`kill of ${e.name}: ${k.line} - the next tick retries`];
  return [`killed ${e.name}: ${k.line}`, ...afterKill(e, cfg)];
}
// The restart runs to its end (3 min at most): the launcher records the new session, starts its window or background
// session detached, and exits. Its output goes to CFG/state/coord/restarts/<name>-<stamp>.log. -> {ok, why, log}
function spawnLaunch(name, argv) {
  const log = C("restarts", `${stem(name)}-${V.now().replace(/[:.]/g, "-")}.log`), started = V.now();
  const r = spawnSync(process.execPath, [LAUNCH, ...argv], { encoding: "utf8", timeout: 3 * L.MIN, windowsHide: true });
  try { V.writeAtomic(log, `node launch.mjs ${argv.join(" ")}\nexit ${r.status ?? r.error?.code ?? r.signal}\n${r.stdout || ""}${r.stderr || ""}`); } catch {}
  const last = `${r.stderr || ""}${r.stdout || ""}`.trim().split(/\r?\n/).at(-1) || "";
  const why = r.status === 0 ? null : r.error?.code === "ETIMEDOUT" ? "the launcher did not finish in 3 min" : `the launcher exited ${r.status ?? r.signal}: ${last}`;
  return { ok: r.status === 0, why, log: fwd(log), started };
}
function afterKill(e, cfg) {
  const reg = V.readRegistry();
  // Only the newest generation of a lane is restarted: two sessions never share a worktree, and an old handoff never
  // restarts over a lane that moved on to a later stage. Any newer launch without a {closed} line supersedes this one.
  const newer = reg.entries.filter((x) => x.id !== e.id && x.repo === e.repo && x.branch === e.branch && (x.generation || 0) > (e.generation || 0) && !reg.closed.has(x.id));
  if (newer.length) {
    const n = newer.at(-1);
    if (newer.some((x) => V.liveness(x, reg).state !== "gone")) { // running, starting or unknown (e.g. a restart a dying tick launched)
      V.append({ restart_skipped: e.id, name: e.name, why: `superseded by ${n.id}`, at: V.now() });
      return [`${e.name} killed, not restarted: superseded by ${n.id}`];
    }
    // The newer launch is gone without a close: blocked + alert; launch.mjs resume relaunches from the newest line.
    const inc0 = [...reg.lines].reverse().find((o) => o.incident === e.id && o.mode === "auto");
    V.append({ lane_blocked: e.name, group: e.group || null, handoff: n.handoff, incident: inc0?.path ?? null, at: V.now() });
    const text = `${e.name} was killed for a loop, but its newer launch ${n.id} is gone without a close: not restarted from the old handoff. `
      + (e.group ? `Check it, then: node ${fwd(LAUNCH)} resume --group ${e.group} --lane ${e.name}` : `Check it, then relaunch from ${n.handoff} with launch.mjs.`);
    return [`${e.name} killed, not restarted: superseded by ${n.id}, which is gone - blocked, alert ${fwd(raiseAlert({ name: e.name, text, incident: inc0?.path ?? null }))}`];
  }
  const inc = [...reg.lines].reverse().find((o) => o.incident === e.id && o.mode === "auto");
  if (!inc) return [`${e.name}: killed without an incident - not restarted`];
  const lastRestart = [...reg.lines].reverse().find((o) => o.restart === e.name && o.handoff === e.handoff);
  const prevInc = lastRestart && [...reg.lines].reverse().find((o) => o.incident && o.name === e.name && o.n === lastRestart.n);
  const plan = L.afterKillPlan({ lines: reg.lines, entry: e, incident: inc, cfg, doneMarkerExists: !!e.done_marker && fs.existsSync(e.done_marker),
    pauseActive: pauseActive(), prevCauseFilled: prevInc ? L.causeFilled(readText(prevInc.path)) : true });
  if (plan.do === "defer") return [`restart of ${e.name} deferred: ${plan.why}`];
  if (plan.do === "skip") { V.append({ restart_skipped: e.id, name: e.name, why: plan.why, at: V.now() }); return [`${e.name} killed, not restarted: ${plan.why}`]; }
  if (plan.do === "block") return block(e, inc, plan.restarts);
  const argv = plan.kind === "resume" ? ["--resume", e.session_id, "--recovery", inc.path, "--model", plan.model, "--effort", plan.effort]
    : L.freshLaunchArgs(e, { model: plan.model, effort: plan.effort, recovery: inc.path });
  const r = spawnLaunch(e.name, argv);
  if (!r.ok && V.readRegistry().entries.some((x) => x.name === e.name && x.launched_at >= r.started)) {
    // The launcher registered the session before it failed or timed out (merge.mjs makes the same check): that session
    // owns the worktree now, so this is a restart, never a block. It may not be running (a bg session whose id was never
    // captured stays unknown), so the user is told.
    V.append({ restart: e.name, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, model: plan.model, effort: plan.effort, launcher_exit: r.why, at: V.now() });
    const text = `Restart of ${e.name} was registered but its launcher ${r.why.replace(/^the launcher /, "")} (log ${r.log}). `
      + `Check ${e.group ? `status --group ${e.group}` : "claude agents"}; if it is not running, stop/judge it and relaunch by hand.`;
    const f = raiseAlert({ name: e.name, text, incident: inc.path });
    return [`restarted ${e.name}: ${plan.kind} (${plan.model}/${plan.effort}) - the launcher then failed (${r.why}, log ${r.log}), but it registered the session - alert ${fwd(f)}`];
  }
  if (!r.ok) { // never a silent loss: the lane is blocked (status shows it, launch.mjs resume relaunches it) and alerted
    V.append({ restart_failed: e.name, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, why: r.why, log: r.log, at: V.now() });
    V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc.path, at: V.now() });
    const f = raiseAlert({ name: e.name, text: L.ALERT.restartFailed({ name: e.name, group: e.group, why: r.why, log: r.log, incident: inc.path, launchMjs: fwd(LAUNCH), handoff: e.handoff }), incident: inc.path });
    return [`restart of ${e.name} failed: ${r.why} (log ${r.log}) - blocked, alert ${fwd(f)}`];
  }
  V.append({ restart: e.name, n: inc.n, kind: plan.kind, from: e.id, handoff: e.handoff, model: plan.model, effort: plan.effort, at: V.now() });
  return [`restarted ${e.name}: ${plan.kind} (${plan.model}/${plan.effort})`];
}
function block(e, inc, restarts) {
  V.append({ lane_blocked: e.name, group: e.group || null, handoff: e.handoff, incident: inc.path, at: V.now() });
  const lane = e.group && e.name.startsWith(`${e.group}-merge-`) ? e.name.slice(`${e.group}-merge-`.length) : null;
  const text = isMergeName(e) ? L.ALERT.mergeCap({ name: e.name, group: e.group, lane, incident: inc.path, launchMjs: fwd(LAUNCH) })
    : L.ALERT.blocked({ name: e.name, group: e.group, restarts, incident: inc.path, launchMjs: fwd(LAUNCH), handoff: e.handoff });
  return [`BLOCKED ${e.name} after ${restarts} restart(s): incident ${inc.path} - alert ${fwd(raiseAlert({ name: e.name, text, incident: inc.path }))}`];
}

// ---------- the ladder resumes from registry state (the tick can die between kill and restart) ----------
// Before a kill that has not started, or a retry, detection runs again on the current transcript: the session may have
// stopped repeating, saved its state, or opened AskUserQuestion since the incident.
function ruleStillFires(e, inc, { reg, cfg, prevRun, now, lv }) {
  const obs = observe(e, { prevRun, looping: (V.readJson(C("looping.json"), {}) || {})[e.session_id], now });
  const det = L.detect({ ...obs, paused: pausedLine(reg.lines, e), pauseActive: pauseActive(now), liveState: lv.state }, cfg);
  return !det.exempt && det.flags.some((f) => f.signature === inc.signature);
}
function cancelBeforeKill(e, inc) {
  V.append({ ladder_cancelled: e.id, name: e.name, signature: inc.signature, incident: inc.path, at: V.now() });
  dropStop(e, inc.signature);
  return `cancelled the ladder ${inc.signature} of ${e.name}: the rule stopped firing before the kill (incident ${inc.path} kept)`;
}
function resumePending({ dryRun, cfg, prevRun, now }) {
  const out = [];
  for (const p of L.pendingLadders(V.readRegistry().lines)) {
    const reg = V.readRegistry(), e = reg.entries.find((x) => x.id === p.id), inc = p.incident;
    if (!e) continue;
    if (p.closed || reg.closed.has(e.id)) { out.push(...(dryRun ? [`would restart or block ${e.name} (killed, no restart recorded)`] : afterKill(e, cfg))); continue; }
    V.forgetLiveness(e.id);
    const lv = V.liveness(e, reg);
    if (lv.state === "unknown") { out.push(`pending ${e.name}: liveness unknown (${lv.why}) - no action`); continue; }
    if (lv.state === "gone" && p.intent) { // the kill went through and the tick died before recording it
      if (dryRun) { out.push(`would record the close of ${e.name}, then restart or block it (${inc.path})`); continue; }
      V.append({ closed: e.name, id: e.id, at: V.now(), why: "gone after the ladder kill" });
      out.push(...afterKill(e, cfg));
      continue;
    }
    if (!ruleStillFires(e, inc, { reg, cfg, prevRun, now, lv })) {
      out.push(dryRun ? `would cancel the ladder ${inc.signature} of ${e.name}: the rule stopped firing before the kill` : cancelBeforeKill(e, inc));
      continue;
    }
    if (dryRun) { out.push(`would kill ${e.name}, then restart or block it (${inc.path})`); continue; }
    out.push(...killAndContinue(e, cfg)); // running: (re)try the kill; gone with no kill_intent: recorded closed, then restarted
  }
  return out;
}

// ---------- scan ----------
function reportOnly(e, flags, obs, { dryRun, cfg, now, alerts, reg }) {
  const out = [];
  for (const f of flags) {
    const k = `${e.id}|${f.signature}`, had = reg.lines.find((o) => o.incident === e.id && o.signature === f.signature);
    if (had && !L.alertDue(alerts, k, now, cfg)) continue;
    if (dryRun) { out.push(`report-only ${e.name}: ${f.text} - would ${had ? "alert again" : "write an incident and alert"}`); continue; }
    let file = had?.path;
    if (!had) {
      const n = 1 + reg.lines.filter((o) => o.incident && o.name === e.name).length;
      file = fwd(incidentPath(e, n));
      writeIncident(e, f, obs, n, file, "report");
      V.append({ incident: e.id, name: e.name, n, path: file, signature: f.signature, rule: f.rule, tokens: obs.tokens, mode: "report", at: V.now() });
    }
    raiseAlert({ name: e.name, text: L.ALERT.report({ name: e.name, group: e.group, text: f.text, incident: file, launchMjs: fwd(LAUNCH) }), incident: file });
    alerts[k] = V.now();
    out.push(`report-only ${e.name}: ${f.text} - incident ${file}, alerted`);
  }
  return out;
}
// Remove a ladder's stop file while it is still pending (same token), so a cancelled request is never delivered later.
function dropStop(e, signature) {
  const s = [...V.readRegistry().lines].reverse().find((o) => o.stop_requested === e.id && o.reason_class === "ladder" && o.signature === signature);
  const f = path.join(V.STOP_DIR, `${stem(e.id)}.ladder.stop.json`);
  if (s && V.readJson(f, null)?.token === s.token) fs.rmSync(f, { force: true });
}
function runLadder(e, det, obs, { dryRun, cfg, now, reg }) {
  const out = [], tag = `${e.name} (gen ${e.generation ?? "?"})`;
  const callsFor = (f) => (f.rule === "d" ? obs.subs.find((s) => s.id === f.scope)?.calls || [] : obs.calls);
  // Permission waits (kept by the hook) never count toward the grace period.
  const waits = [...(Array.isArray(obs.hook.waits) ? obs.hook.waits : []), ...(obs.waitingSince ? [[Date.parse(obs.waitingSince), null]] : [])];
  for (const a of L.ladderActions({ lines: reg.lines, entry: e, flags: det.flags, callsFor, now, cfg, waits })) {
    const f = a.flag;
    if (a.do === "cancel") {
      out.push(`${dryRun ? "would cancel" : "cancelled"} the ladder ${a.signature} of ${tag}: ${a.why === "stop expired" ? "its stop request expired undelivered" : "the rule stopped firing"}`);
      if (!dryRun) { V.append({ ladder_cancelled: e.id, name: e.name, signature: a.signature, ...(a.why ? { why: a.why } : {}), at: V.now() }); dropStop(e, a.signature); }
    }
    else if (a.do === "rearm") { out.push(`LOOPING ${tag}: ${f.text} - fired again within 60 min of its cancel: ${dryRun ? "would resume" : "resumed"} at the grace step`); if (!dryRun) V.append({ ladder_rearmed: e.id, name: e.name, signature: a.signature, at: V.now() }); }
    else if (a.do === "stop") out.push(`LOOPING ${tag}: ${f.text} - ${V.requestStop(e, `loop: ${f.text}`, { apply: !dryRun, reasonClass: "ladder", signature: a.signature, text: L.STOP_TEXT_LADDER(a.signature), force: true })}`);
    else if (a.do === "wait") out.push(`LOOPING ${tag}: ${a.signature} - ${a.why}`);
    else if (a.do === "kill") out.push(...incidentAndKill(e, f, obs, { dryRun, cfg }));
  }
  return out;
}
function scan({ dryRun, cfg, prevRun, now, repoKey }) {
  const out = [], first = V.readRegistry();
  const loopingAll = V.readJson(C("looping.json"), {}) || {}, nextLooping = { ...loopingAll };
  const alerts = V.readJson(C("alerts", "index.json"), {}) || {};
  const cands = first.entries.filter((e) => !first.closed.has(e.id) && (!repoKey || e.repo === repoKey));
  V.primeLiveness(cands);
  for (const c of cands) {
    const reg = V.readRegistry(); // fresh read before each decision, never a start-of-run snapshot
    const e = reg.entries.find((x) => x.id === c.id);
    if (!e || reg.closed.has(e.id)) continue;
    const lv = V.liveness(e, reg);
    if (lv.state === "unknown") { out.push(`unknown ${e.name}: liveness unknown (${lv.why}) - no action`); continue; }
    if (lv.state === "gone") { if (e.session_id) delete nextLooping[e.session_id]; continue; }
    const obs = observe(e, { prevRun, looping: loopingAll[e.session_id], now });
    const det = L.detect({ ...obs, paused: pausedLine(reg.lines, e), pauseActive: pauseActive(now), liveState: lv.state }, cfg);
    if (e.session_id) { if (Object.keys(det.subFlags).length) nextLooping[e.session_id] = det.subFlags; else delete nextLooping[e.session_id]; }
    if (det.exempt) continue; // never flagged, and no ladder moves while it waits
    out.push(...(L.recoveryMode(reg.lines, e) === "report" ? reportOnly(e, det.flags, obs, { dryRun, cfg, now, alerts, reg }) : runLadder(e, det, obs, { dryRun, cfg, now, reg })));
  }
  if (!dryRun) { V.writeAtomic(C("looping.json"), JSON.stringify(nextLooping, null, 2)); V.writeAtomic(C("alerts", "index.json"), JSON.stringify(alerts, null, 2)); }
  return out;
}

// ---------- one tick ----------
export function tick({ dryRun = false, repoKey = null } = {}) {
  const out = [];
  if (!dryRun && !acquireTickLock()) return ["tick: another tick holds tick.lock - skipped"];
  try {
    const { config: cfg, errors } = loadCfg();
    for (const e of errors) out.push(`config: ${e} (the default is used)`);
    const tj = V.readJson(C("tick.json"), {}) || {}, prevRun = Date.parse(tj.last_run) || 0, now = Date.now();
    if (!dryRun) V.writeAtomic(C("tick.json"), JSON.stringify({ ...tj, at: V.now(), last_run: V.now() }));
    out.push(...resumePending({ dryRun, cfg, prevRun, now }));
    out.push(...scan({ dryRun, cfg, prevRun, now, repoKey }));
  } finally { if (!dryRun) releaseTickLock(); }
  if (!out.length) out.push("tick: nothing to do");
  if (!dryRun) { try { V.writeAtomic(C("last-tick.txt"), `${V.now()}\n${out.join("\n")}\n`); } catch {} }
  return out;
}
```

- [ ] **Step 4: `coord.mjs tick` and `launch.mjs watchdog`**

In `coord.mjs`, extend the header comment with `//   tick [--dry-run]  one coordinator tick (recover.mjs); --dry-run prints what it would do and writes nothing.`,
add to `main` (after the `notify` branch):

```js
  else if (sub === "tick") { const R = await mod("recover.mjs"); for (const l of R.tick({ dryRun: argv.includes("--dry-run") })) console.log(l); }
```

and replace the last block with (a tick's failure is shown; a hook's never is):

```js
if (self(process.argv[1]) === self(fileURLToPath(import.meta.url))) {
  try { await main(process.argv.slice(2)); }
  catch (e) { if (process.argv[2] === "tick") { console.error(`tick failed: ${e?.stack || e}`); process.exit(1); } }
  process.exit(0);
}
```

In `launch.mjs`, replace the Task 2 `watchdog` block with:

```js
if (sub === "watchdog") {
  // What the coordinator tick would do now (dry run). --stop-looping (kept as an alias) runs the tick for real.
  const repoKey = opt("repo") ? key(mainRoot(path.resolve(opt("repo"))) || opt("repo")) : null;
  const { tick } = await import("./recover.mjs");
  for (const l of tick({ dryRun: dry || !flag("stop-looping"), repoKey })) console.log(l);
  process.exit(0);
}
```

and the header line `//   node launch.mjs watchdog [--repo <dir>] [--stop-looping]   (the coordinator tick's dry run; --stop-looping runs it)`.

- [ ] **Step 5: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add claude/skills/handoff-launch claude/hooks/coord.mjs
git commit -m "recover.mjs: coordinator tick - report-only and auto ladders, incidents, tri-state kills, restarts and blocks resumed from registry state"
```

---

### Task 7: Guarded closes: superseded, paused and incident windows

**Files:**
- Modify: `claude/skills/handoff-launch/recover.mjs` (add `guardedClose`, `supersededScan`; call it from `tick`)
- Modify: `claude/skills/handoff-launch/tests/helpers.mjs` (`host`, `alive`)
- Test: `claude/skills/handoff-launch/tests/recover.test.mjs`

**Interfaces:**
- Consumes: `live.mjs`: `readPidFile, procInfo, probeWhy, sessionState, killTree, hasClaudeBelow, liveness, primeLiveness`;
  `recover-lib.mjs`: `closeDecision`.
- Produces: `guardedClose(e, why, {dryRun}) → line` (the logic of the hand-run guarded-close script: the host is the
  recorded powershell with a start time within 2 s; the transcript turn is done; `kill_intent` (kind `close`) →
  `taskkill /T /F` → `{closed}`; gone afterwards counts as closed); `supersededScan({dryRun, cfg, now, repoKey}) → lines`
  (the N-1 close in both modes and all groups; paused and incident windows in auto mode only). Helpers: `host() → {pid, start, kill()}` (Windows), `alive(pid) → bool`.

- [ ] **Step 1: Add the helpers**

In `tests/helpers.mjs` add `spawn` to the `node:child_process` import, then:

```js
// A window-host stand-in (Windows): a real powershell process and its start time, as the pid file records them.
export function host() {
  const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep 300"], { stdio: "ignore", windowsHide: true });
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${p.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8" });
  return { pid: p.pid, start: r.stdout.trim(), kill: () => { try { p.kill(); } catch {} } };
}
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
```

- [ ] **Step 2: Write the failing test**

Append to `tests/recover.test.mjs` (add `host, alive` to its helpers import):

```js
test("superseded N-1 and paused windows close when idle; busy or waiting ones stay", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hosts = Array.from({ length: 10 }, () => host());
  try {
    const old = Date.now() - 40 * MIN;
    const idleT = tx({ start: old }).user("go").call("Bash", { command: "x" }).say("handed off").turnDone().entries();
    const busyT = tx({ start: old }).user("go").call("mcp__x__slow", {}, { result: false }).entries();
    const mk = (name, branch, i, t, gen) => { const e = sessionLine(sb, { name, id: `${name}@${gen}`, branch, gen, sid: `${name}-s${gen}`, host: hosts[i] }); if (t) writeTranscript(sb, sb.repo, e.session_id, t); return e; };
    const x1 = mk("X", "x", 0, idleT, 1); mk("X", "x", 1, null, 2);      // idle N-1, N running: closed
    mk("Y", "y", 2, busyT, 1); mk("Y", "y", 3, null, 2);                 // busy N-1: kept
    const z1 = mk("Z", "z", 4, idleT, 1); mk("Z", "z", 5, null, 2);      // idle but waiting on a permission: kept
    const p1 = mk("P", "p", 6, idleT, 1);                                // paused and idle: closed
    appendLine(sb, { paused: "P", at: new Date().toISOString() });
    // a report-only session (pre-stage-2 line) with an incident and a running gen 3, not N-1: kept
    const q1 = sessionLine(sb, { name: "Q", id: "Q@1", branch: "q", gen: 1, sid: "Q-s1", host: hosts[7], coord: undefined });
    writeTranscript(sb, sb.repo, q1.session_id, idleT);
    sessionLine(sb, { name: "Q", id: "Q@3", branch: "q", gen: 3, sid: "Q-s3", host: hosts[8], coord: undefined });
    appendLine(sb, { incident: q1.id, name: "Q", n: 1, path: "x/Q-1.md", signature: "a:main:x", mode: "report", at: new Date().toISOString() });
    // a paused, idle window of a report-only session: kept (only the N-1 close applies to report-only groups)
    const r1 = sessionLine(sb, { name: "R", id: "R@1", branch: "r", gen: 1, sid: "R-s1", host: hosts[9], coord: undefined });
    writeTranscript(sb, sb.repo, r1.session_id, idleT);
    appendLine(sb, { paused: "R", at: new Date().toISOString() });
    fs.mkdirSync(path.join(sb.coord, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "sessions", `${z1.session_id}.json`), JSON.stringify({ waiting_since: new Date().toISOString() }));
    const dry = tick(sb, "--dry-run");
    assert.match(dry.out, /^would close X \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.equal(alive(hosts[0].pid), true);
    const r = tick(sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^closed X \(gen 1\): superseded by generation 2: idle \d+ min$/m);
    assert.match(r.out, /^closed P \(gen 1\): paused: idle \d+ min$/m);
    assert.doesNotMatch(r.out, /close[ds]? [YZQR] /);
    assert.equal(alive(hosts[0].pid), false); assert.equal(alive(hosts[6].pid), false);
    for (const i of [1, 2, 3, 4, 5, 7, 8, 9]) assert.equal(alive(hosts[i].pid), true, `host ${i}`);
    assert.equal(sb.registry().filter((o) => o.kill_intent === r1.id).length, 0);
    const lines = sb.registry();
    for (const e of [x1, p1]) {
      assert.ok(lines.some((o) => o.kill_intent === e.id && o.kind === "close"), e.id);
      assert.ok(lines.some((o) => o.closed && o.id === e.id), e.id);
    }
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test claude/skills/handoff-launch/tests/recover.test.mjs`
Expected: on Windows FAIL (`would close X` absent: the tick has no close pass yet); skipped elsewhere.

- [ ] **Step 4: Implement**

Add to `recover.mjs` (above `// ---------- one tick ----------`):

```js
// ---------- guarded closes: superseded N-1, paused and incident windows (all groups, both modes) ----------
export function guardedClose(e, why, { dryRun }) {
  const w = V.readPidFile(e), tag = `${e.name} (gen ${e.generation ?? "?"})`;
  if (!w.host_pid || !w.host_start) return `skip close of ${tag}: no recorded host pid and start time`;
  V.forgetLiveness(e.id);
  const info = V.procInfo([w.host_pid]);
  if (!info) return `skip close of ${tag}: liveness unknown (${V.probeWhy()})`;
  const p = info.get(w.host_pid);
  if (!p || p.name === "DEAD" || p.name.toLowerCase() !== "powershell" || !p.start || Math.abs(Date.parse(p.start) - Date.parse(w.host_start)) > 2000)
    return `skip close of ${tag}: host pid ${w.host_pid} is not the recorded window`;
  const s = V.sessionState(e);
  if (s.found && (!s.turnDone || s.pending || s.bgAgents)) return `skip close of ${tag}: its turn is not done`;
  if (dryRun) return `would close ${tag}: ${why}`;
  return `${V.killTree(w, why, "close").line} ${tag}: ${why}`;
}
export function supersededScan({ dryRun, cfg, now, repoKey }) {
  const out = [], reg = V.readRegistry();
  const wins = reg.entries.filter((e) => e.mode === "window" && !reg.closed.has(e.id) && (!repoKey || e.repo === repoKey));
  V.primeLiveness(wins);
  for (const e of wins) {
    const lane = reg.entries.filter((x) => x.repo === e.repo && x.branch === e.branch && !reg.closed.has(x.id));
    const newest = lane.reduce((a, b) => ((b.generation || 0) > (a.generation || 0) ? b : a), e);
    const succ = newest.id !== e.id && V.liveness(newest, reg).state === "running";
    const isN1 = succ && (e.generation || 0) === (newest.generation || 0) - 1;
    const paused = pausedLine(reg.lines, e), incident = reg.lines.some((o) => o.incident === e.id);
    // Report-only groups get only the superseded N-1 close (approved for all groups); paused and incident windows close
    // in auto mode only.
    const auto = L.recoveryMode(reg.lines, e) === "auto";
    if (!isN1 && !(auto && (paused || (incident && succ)))) continue;
    const lv = V.liveness(e, reg);
    if (lv.state !== "running") { if (lv.state === "unknown") out.push(`skip close of ${e.name} (gen ${e.generation ?? "?"}): liveness unknown (${lv.why})`); continue; }
    const st = V.sessionState(e), hook = V.readJson(C("sessions", `${e.session_id}.json`), {}) || {};
    const noClaude = st.found ? null : V.hasClaudeBelow(V.readPidFile(e).host_pid);
    const reason = isN1 ? `superseded by generation ${newest.generation}` : paused ? "paused" : "incident, successor running";
    const d = L.closeDecision({ state: st, waitingSince: hook.waiting_since || null, noClaude, now, cfg, reason });
    if (d.close) out.push(guardedClose(e, d.why, { dryRun }));
  }
  return out;
}
```

In `tick`, after `out.push(...scan(...));` add `out.push(...supersededScan({ dryRun, cfg, now, repoKey }));`.

`closeOld`'s generation ≤ N-2 rule is unchanged; Task 2 already made it tri-state (its test is in `liveness.test.mjs`).

- [ ] **Step 5: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0` (the close test runs on Windows only).

- [ ] **Step 6: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "recover.mjs: guarded close of superseded N-1, paused and incident windows (all groups)"
```

---

### Task 8: `merge.mjs` and `status`: blocked lanes, M8, T4e, the M3 sidecar, recovery notes

**Files:**
- Modify: `claude/skills/handoff-launch/merge-lib.mjs` (`classify`, `mergeTag`, `finalReady`, `lockState`)
- Modify: `claude/skills/handoff-launch/merge.mjs` (`lockStateOf`, `drain`'s `acquireLock` body, `groupLanes`, `lanesNow`,
  `refreshOverlap`, `launchMergeSession`)
- Modify: `claude/skills/handoff-launch/live.mjs` (`sessionBlocker`'s starting window)
- Modify: `claude/skills/handoff-launch/launch.mjs` (`rollingStatus`, the legacy `status` loop, the reopen guard's
  `groupLanes` call)
- Test: `tests/merge-lib.test.mjs`, `tests/merge.test.mjs`, `tests/status.test.mjs`

**Interfaces:**
- Consumes: `recover-lib.mjs` (Task 3): `blockedLanes`, `recoveryMode`; `live.mjs` (Task 2): `procStart`, `selfStart`,
  `liveness`, `primeLiveness`, `ago`, `MIN`.
- Produces: lane state `loop-blocked` (a `{lane_blocked}` line with no later `{lane_resumed}`, and no done marker):
  never queued, counted by `finalReady`; `mergeTag` → `LOOP-BLOCKED (incident <path> - resume: launch.mjs resume --group <g> --lane <n>)`.
  `groupLanes({entries, merges, lines?, group, repoKey, cfg, root})` lanes gain `loopBlocked` (incident path | null) and
  `overlap` (from `<group dir>/<lane>.overlap.json`, else the marker's legacy `overlap`). `refreshOverlap` writes only the
  sidecar. Drain locks record `pid_start`; `lockState(lock, {pidAlive, pidStart?, now, maxAgeMs})` returns `drain-dead`
  when the live pid started more than 10 s after `pid_start` (read with Task 2's `procStart`). `sessionBlocker` returns
  `{kind: "starting", text: "merge.lock taken N s ago, no launch line yet"}` for a session lock younger than 3 min whose
  session has no launch line at or after the lock's `at`. `status` lane lines may end with `  incidents=<n> (latest <path>)`
  and `  liveness=unknown (<why>)`; legacy lane lines with `  LOOP-BLOCKED (...)`; after the summary, a report-mode
  group prints `recovery: report-only (...)` (rolling groups always; legacy groups only when they have an incident or a
  blocked lane, so the legacy golden stays byte-identical).

- [ ] **Step 1: Write the failing tests**

Append to `tests/merge-lib.test.mjs`:

```js
test("M8: a drain lock whose pid now belongs to a process started later is dead (PID reuse)", () => {
  const now = Date.parse("2026-01-01T01:00:00Z"), at = "2026-01-01T00:50:00Z", pid_start = "2026-01-01T00:49:00Z";
  const s = (startMs) => L.lockState({ holder: "drain", pid: 1, at, pid_start }, { pidAlive: () => true, pidStart: () => startMs, now, maxAgeMs: 3600e3 });
  assert.equal(s(Date.parse(pid_start) + 300), "drain-live");
  assert.equal(s(Date.parse("2026-01-01T00:55:00Z")), "drain-dead");
  assert.equal(s(null), "drain-live"); // start unreadable: judged as before
  assert.equal(L.lockState({ holder: "drain", pid: 1, at }, { pidAlive: () => true, pidStart: () => 0, now, maxAgeMs: 3600e3 }), "drain-live"); // a lock without pid_start
});

test("loop-blocked lanes: never queued, counted as blocked for the final merge", () => {
  const c = L.classify([lane("a", done("h1"), { merged: true }), lane("b", null, { loopBlocked: "x/incidents/b-3.md", entry: { group: "g" } })]);
  assert.deepEqual(c.map((l) => l.state), ["merged", "loop-blocked"]);
  assert.deepEqual(L.mergeQueue(c), []);
  assert.equal(L.finalReady(c), true);
  assert.equal(L.mergeTag(c[1]), "LOOP-BLOCKED (incident x/incidents/b-3.md - resume: launch.mjs resume --group g --lane b)");
});
```

In `tests/status.test.mjs`, add `const sidecar = (sb, name) => JSON.parse(fs.readFileSync(path.join(sb.repo, ".superpowers", "sessions", "g1", \`${name}.overlap.json\`), "utf8"));`
at the top; in "overlap writes the files ... into its done marker" rename the test to
"overlap writes the files a finished lane shares with running lanes into its sidecar, never its done marker" and replace
`assert.deepEqual(marker(sb, "A").overlap, { B: ["shared.txt"] });` with:

```js
    assert.deepEqual(sidecar(sb, "A"), { B: ["shared.txt"] });
    assert.equal(marker(sb, "A").overlap, undefined); // overlap never rewrites a done marker (M3)
```

In "status and overlap with --dry-run write nothing", after `assert.equal(fs.readFileSync(doneFile, "utf8"), before);` add:

```js
    assert.equal(fs.existsSync(path.join(sb.repo, ".superpowers", "sessions", "g1", "A.overlap.json")), false);
```

Append to `tests/status.test.mjs` (add `sessionLine` to its helpers import):

```js
test("a loop-blocked lane: LOOP-BLOCKED with its resume command, the drain skips it, final_ready counts it", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A"); launchLane(sb, "g1", "B");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const b = sb.registry().find((o) => o.name === "B");
    fs.appendFileSync(path.join(sb.reg, "sessions.jsonl"), JSON.stringify({ lane_blocked: "B", group: "g1", handoff: b.handoff, incident: "x/incidents/B-3.md", at: new Date().toISOString() }) + "\n");
    const r = sb.run("status", "--group", "g1");
    assert.match(r.out, /^merge: merged A -> int-g1 [0-9a-f]{7}$/m);
    assert.match(r.out, /^B +lane-B +open \(lane still running its stages\) {2}LOOP-BLOCKED \(incident x\/incidents\/B-3\.md - resume: launch\.mjs resume --group g1 --lane B\)$/m);
    assert.match(r.out, /^merge: FINAL_READY g1: .*not merged: B/m);
    assert.match(r.out, /final_ready=true$/m);
  } finally { sb.cleanup(); }
});

test("status notes incidents, liveness unknown and report-only groups", () => {
  const sb = sandbox();
  try {
    setup(sb);
    launchLane(sb, "g1", "A");
    const a = sb.registry().find((o) => o.name === "A"), regFile = path.join(sb.reg, "sessions.jsonl");
    fs.appendFileSync(regFile, JSON.stringify({ incident: a.id, name: "A", n: 1, path: "x/incidents/A-1.md", signature: "a:main:x", mode: "auto", at: new Date().toISOString() }) + "\n");
    let r = sb.run("status", "--group", "g1", "--no-merge");
    assert.match(r.out, /^A +lane-A +open \(lane still running its stages\) {2}incidents=1 \(latest x\/incidents\/A-1\.md\)$/m);
    assert.doesNotMatch(r.out, /^recovery:/m); // a group launched by a stage-2 launcher is auto
    fs.appendFileSync(regFile, JSON.stringify({ ...a, id: "A@live", no_spawn: undefined, host_pid: 4242, launched_at: new Date().toISOString() }) + "\n");
    const u = spawnSync(process.execPath, [LAUNCH, "status", "--group", "g1", "--no-merge"], { env: { ...sb.env, HL_FAKE_PROBE: "fail" }, encoding: "utf8" });
    assert.match(u.stdout, /^A +lane-A .* {2}liveness=unknown \(process probe failed/m);
    assert.equal(sb.run("group", "--group", "g2", "--repo", sb.repo, "--integration", "int-g2", "--target", "main").code, 0);
    sessionLine(sb, { name: "O", group: "g2", branch: "lane-O", coord: undefined, done_marker: path.join(sb.repo, ".superpowers", "sessions", "g2", "O.done").split(path.sep).join("/") });
    r = sb.run("status", "--group", "g2", "--no-merge");
    assert.match(r.out, /\nrecovery: report-only \(group launched before stage 2: loops are reported, never stopped - opt in: launch\.mjs recover --group g2 --mode auto\)\n$/);
  } finally { sb.cleanup(); }
});
```

(`status.test.mjs` needs `LAUNCH` and `sessionLine` from `./helpers.mjs`.)

In `tests/merge.test.mjs`: in "overlap with a running lane is written into the finished lane's marker and its
merge-session handoff" rename "marker" to "sidecar" in the title and replace the `D.done` overlap assertion with:

```js
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gdir(sb, "g1"), "D.overlap.json"), "utf8")), { R: ["shared.txt"] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(gdir(sb, "g1"), "D.done"), "utf8")).overlap, undefined);
```

In the F2 test add after the lane assertion: `assert.match(seen[0].pid_start, /^\d{4}-\d\d-\d\dT/); // M8`.

Append to `tests/merge.test.mjs`:

```js
test("T4e: a session lock < 3 min old whose session has no launch line yet is starting: --force and --skip refuse", () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    const lock = (at) => fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "session", token: "t", session: "g1-merge-A", lane: "A", head: "x", at }));
    lock(new Date().toISOString());
    let r = merge(sb, "--force");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^not cleared: g1-merge-A's liveness is starting \(merge\.lock taken \d+ s ago, no launch line yet\)/m);
    r = merge(sb, "--skip", "A", "--why", "x");
    assert.equal(r.code, 1, r.out); assert.match(r.out, /^not skipped: g1-merge-A holds A and its liveness is starting/m);
    lock(new Date(Date.now() - 4 * 60000).toISOString());
    r = merge(sb, "--force");
    assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /cleared merge\.lock \(merge session g1-merge-A \(lane A\)\)/);
  } finally { sb.cleanup(); }
});

test("M8: a drain lock whose recorded pid start does not match the live process is reclaimed", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  try {
    setup(sb);
    const a = launchLane(sb, "g1", "A");
    writeDone(sb, "g1", "A", commitIn(sb, a, { "a.txt": "A\n" }, "A work"));
    fs.writeFileSync(lockOf(sb, "g1"), JSON.stringify({ holder: "drain", token: "t", pid: process.pid, pid_start: "2020-01-01T00:00:00.000Z", lane: "Z", at: new Date().toISOString() }));
    const r = merge(sb);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /merged A -> int-g1/);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: FAIL: the merge-lib tests (`drain-live` for the reused pid; state `open` for the blocked lane), the sidecar
assertions (no `.overlap.json`; the marker has `overlap`), F2's `pid_start`, LOOP-BLOCKED, the status notes, T4e
(`--force` clears the young lock), M8 on Windows (`queued: merge.lock is held by merge process`).

- [ ] **Step 3: `merge-lib.mjs`**

Replace `lockState` with:

```js
export function lockState(lock, { pidAlive, pidStart = () => null, now, maxAgeMs }) {
  if (lock.holder !== "drain") return lock.holder;
  if (!pidAlive(lock.pid)) return "drain-dead";
  // PID reuse (M8): a live pid whose process started well after the lock's holder did is another process.
  const st = lock.pid_start ? pidStart(lock.pid) : null;
  if (st != null && st - Date.parse(lock.pid_start) > 10000) return "drain-dead";
  // An unreadable `at` is never young: report it like an old lock (merge --force clears it), never drain-live forever.
  const age = now - Date.parse(lock.at);
  return !Number.isFinite(age) || age > maxAgeMs ? "drain-old" : "drain-live";
}
```

In `classify`, the first state line becomes `const state = !m ? (l.loopBlocked ? "loop-blocked" : "open")`; in
`finalReady` add `|| l.state === "loop-blocked"`; in `mergeTag` add, before the `merged` case:

```js
  if (l.state === "loop-blocked") return `LOOP-BLOCKED (incident ${l.loopBlocked} - resume: launch.mjs resume --group ${l.entry?.group} --lane ${l.name})`;
```

- [ ] **Step 4: `merge.mjs`**

1. Imports: `import { procStart, selfStart } from "./live.mjs";` and `import { blockedLanes } from "./recover-lib.mjs";`.
2. `export const lockStateOf = (lock, cfg) => L.lockState(lock, { pidAlive, pidStart: procStart, now: Date.now(), maxAgeMs: (cfg.test_timeout_min + 10) * MIN });`
3. In `drain`: `const acq = acquireLock(gd, { pid: process.pid, pid_start: selfStart(), lane: next.name }, cfg);`
4. `groupLanes` takes `lines = []` too and returns `loopBlocked` and `overlap` per lane:

```js
export const overlapFile = (doneMarker) => String(doneMarker).replace(/\.done$/, ".overlap.json");
export function groupLanes({ entries, merges, lines = [], group, repoKey, cfg, root }) {
  const latest = new Map();
  for (const e of entries) {
    if (e.group !== group || (repoKey && e.repo !== repoKey) || L.isMergeSession(group, e.name)) continue;
    const prev = latest.get(e.name);
    if (!prev || prev.launched_at < e.launched_at) latest.set(e.name, e);
  }
  const blocked = new Map(blockedLanes(lines, group).map((b) => [b.name, b.incident]));
  return [...latest.values()].map((e) => {
    let marker = null, overlap = null;
    if (e.done_marker && fs.existsSync(e.done_marker)) {
      try { marker = JSON.parse(fs.readFileSync(e.done_marker, "utf8")); } catch { marker = { unreadable: true }; }
      // null, false, 0, a string or an array is no marker object: unreadable, never "open" (it would never merge).
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) marker = { unreadable: true };
    }
    if (e.done_marker) { try { overlap = JSON.parse(fs.readFileSync(overlapFile(e.done_marker), "utf8")); } catch { overlap = marker?.overlap ?? null; } }
    const head = marker?.head ? String(marker.head) : null;
    const rec = (k) => [...merges].reverse().find((m) => m[k] === e.name && m.group === group && (!repoKey || m.repo === repoKey) && head && m.head === head);
    const mergedRec = rec("merged");
    let merged = !!mergedRec;
    if (!merged && head && cfg && root) {
      const c = git(root, "rev-parse", "--verify", "--quiet", `${head}^{commit}`);
      merged = c.ok && git(root, "merge-base", "--is-ancestor", c.out, `refs/heads/${cfg.integration}`).ok;
    }
    return { name: e.name, branch: e.branch, entry: e, marker, overlap, loopBlocked: blocked.get(e.name) ?? null, merged, mergedSha: mergedRec?.sha ?? null, mergeBlocked: rec("merge_blocked")?.why ?? null };
  });
}
```

   and `lanesNow` passes `lines: reg.lines || []`.
5. `refreshOverlap` writes the sidecar, never the marker (M3):

```js
  for (const l of finished) {
    const overlap = Object.fromEntries(pairs.filter((p) => p.finished === l.name).map((p) => [p.running, p.files]));
    if (JSON.stringify(l.overlap || {}) === JSON.stringify(overlap)) continue;
    l.overlap = overlap;
    if (write) writeAtomic(overlapFile(l.entry.done_marker), JSON.stringify(overlap, null, 2) + "\n");
  }
```

6. `launchMergeSession`: `overlap: lanes.find((l) => l.name === lane.name)?.overlap,`.

- [ ] **Step 5: `live.mjs`**

In `sessionBlocker`, replace `if (!e) return null;` with:

```js
  // T4e: launchMergeSession writes the session lock before its session's launch line exists.
  if (lock?.at && ago(lock.at) < 3 * MIN && (!e || e.launched_at < lock.at)) return { kind: "starting", text: `merge.lock taken ${Math.round(ago(lock.at) / 1000)} s ago, no launch line yet` };
  if (!e) return null;
```

- [ ] **Step 6: `launch.mjs` status**

1. Imports: add `recoveryMode` to the `recover-lib.mjs` import (Task 5 already imports `blockedLanes`).
2. Above `memberLine` add:

```js
// Recovery notes for a lane line - incidents, a loop-blocked legacy lane, liveness unknown. Empty when there is
// nothing to say, so the output of a group without any stays byte-identical.
function recoveryNotes(e, { legacy }) {
  const incs = reg.lines.filter((o) => o.incident && o.name === e.name);
  const b = legacy && e.group ? blockedLanes(reg.lines, e.group).find((x) => x.name === e.name) : null;
  const lv = live(e) ? liveness(e, reg) : null;
  return [b ? `LOOP-BLOCKED (incident ${b.incident} - resume: launch.mjs resume --group ${e.group} --lane ${e.name})` : "",
    incs.length ? `incidents=${incs.length} (latest ${incs.at(-1).path})` : "",
    lv?.state === "unknown" ? `liveness=unknown (${lv.why})` : ""].filter(Boolean).map((s) => `  ${s}`).join("");
}
const reportOnlyLine = (group) => `recovery: report-only (group launched before stage 2: loops are reported, never stopped - opt in: launch.mjs recover --group ${group} --mode auto)`;
```

3. `rollingStatus`: call `primeLiveness(lanes.map((l) => l.entry));` after `lanesNow`; the lane line becomes
   `console.log(\`${memberLine(l.entry, l.marker).text}${tag ? \`  ${tag}\` : ""}${ov}${recoveryNotes(l.entry, { legacy: false })}\`);`
   with `ov` built from `l.overlap` instead of `l.marker?.overlap`:
   `const ov = l.overlap && Object.keys(l.overlap).length ? \`  overlap=${JSON.stringify(l.overlap)}\` : "";`
   After the summary line: `if (lanes[0] && recoveryMode(reg.lines, lanes[0].entry) === "report") console.log(reportOnlyLine(group));`
4. Legacy `status`: before its member loop `primeLiveness(members);`; the loop prints `console.log(m.text + recoveryNotes(e, { legacy: true }));`;
   after its summary line:

```js
  const noted = members.some((e) => reg.lines.some((o) => (o.incident && o.name === e.name) || (o.lane_blocked === e.name && o.group === e.group)));
  if (members[0] && noted && recoveryMode(reg.lines, members[0]) === "report") console.log(reportOnlyLine(slug(group)));
```

5. The `--reopen` guard's `groupLanes({ entries: reg.entries, merges: reg.merges, ...})` call gains `lines: reg.lines`.

- [ ] **Step 7: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0`; the legacy golden in `launcher.test.mjs` is unchanged and passes.

- [ ] **Step 8: Commit**

```bash
git add claude/skills/handoff-launch
git commit -m "handoff-launch: loop-blocked lanes in drain and status, drain-lock pid start (M8), starting session lock (T4e), overlap sidecar (M3), status recovery notes"
```

---

### Task 9: Alerts: the desktop notification, the phone relay, and goal-gate

**Files:**
- Modify: `claude/skills/handoff-launch/recover.mjs` (`desktopNotify`, `raiseAlert` uses it, `releaseStaleClaims`, the tick calls it)
- Modify: `claude/hooks/coord.mjs` (`claimAlert`, `alertSent`, `alertRelease`, `startTick`; CLI `relay`, `alert-sent`, `alert-release`)
- Modify: `claude/hooks/goal-gate.mjs` (CFG, start the tick, relay one alert per Stop)
- Test: `claude/skills/handoff-launch/tests/alerts.test.mjs` (new)

**Interfaces:**
- Consumes: `recover.mjs` (Task 6) `raiseAlert`, `tick`; `live.mjs` `triggerTick`, `psq`, `COORD`; coord.mjs `context()` (Task 4).
- Produces: `desktopNotify(title, text) → "spawned" | "skipped (HL_NO_SPAWN)" | "failed: <msg>"` (Windows: a NotifyIcon
  balloon from PowerShell 5.1; macOS `osascript`; Linux `notify-send`); alert files gain `desktop`;
  `releaseStaleClaims(now) → lines` (a `claimed-<sid>-<ms>-<orig>` older than 15 min is renamed back to `<orig>`).
  `coord.mjs` exports `claimAlert(sid) → reason|null`, `alertSent(file) → line`, `alertRelease(file) → line`,
  `startTick(by) → bool`; CLI `relay` (Stop-hook stdin; prints `{"decision":"block","reason":...}` or nothing),
  `alert-sent <file>`, `alert-release <file>`. goal-gate: in a session without `HL_SESSION_ID`, one claimed alert per
  Stop becomes its block reason; every Stop may start a tick; any coordinator failure is ignored.
- Probe gate: probe 6 (Step 3b is the fallback).

- [ ] **Step 1: Write the failing tests**

`claude/skills/handoff-launch/tests/alerts.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun, sessionLine, setAgents, writeTranscript, tx } from "./helpers.mjs";

const GOAL_GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "goal-gate.mjs");
const gate = (sb, input, env = {}) => { const r = spawnSync(process.execPath, [GOAL_GATE], { env: { ...sb.env, ...env }, input: JSON.stringify(input), encoding: "utf8" }); return { code: r.status, out: r.stdout }; };
const queue = (sb, name, text) => {
  const d = path.join(sb.coord, "alerts"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `2026-01-01T00-00-00-000Z-${name}.json`), JSON.stringify({ text, incident: "i.md", created: "2026-01-01T00:00:00Z" }));
};
const claimedIn = (reason) => /alert-sent "([^"]+)"/.exec(reason)[1];

test("the phone relay: a non-launcher session claims one alert per Stop; sent or released; a stale claim returns", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "Lane A is blocked");
    let r = gate(sb, { session_id: "s1" });
    assert.equal(r.code, 0);
    const o = JSON.parse(r.out);
    assert.equal(o.decision, "block");
    assert.match(o.reason, /^Coordinator alert\. Send this with PushNotification: Lane A is blocked\nThen run: node ".*coord\.mjs" alert-sent ".*\/alerts\/claimed-s1-\d{13}-2026-01-01T00-00-00-000Z-A\.json"/);
    assert.equal(gate(sb, { session_id: "s2" }).out, ""); // nothing left to claim, and no GOAL.md
    assert.equal(coordRun(sb, ["alert-release", claimedIn(o.reason)]).out, "alert released\n");
    r = gate(sb, { session_id: "s2" });
    assert.equal(coordRun(sb, ["alert-sent", claimedIn(JSON.parse(r.out).reason)]).out, "alert marked sent\n");
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => f !== "index.json"), ["sent-2026-01-01T00-00-00-000Z-A.json"]);
    queue(sb, "B", "Lane B is blocked");
    const d = path.join(sb.coord, "alerts");
    fs.renameSync(path.join(d, "2026-01-01T00-00-00-000Z-B.json"), path.join(d, `claimed-s3-${Date.now() - 16 * 60000}-2026-01-01T00-00-00-000Z-B.json`));
    assert.match(coordRun(sb, ["tick"]).out, /^released the unsent alert 2026-01-01T00-00-00-000Z-B\.json$/m);
    assert.ok(fs.existsSync(path.join(d, "2026-01-01T00-00-00-000Z-B.json")));
    assert.match(coordRun(sb, ["alert-sent", path.join(sb.tmp, "x.json")]).out, /^not a claimed alert/);
  } finally { sb.cleanup(); }
});

test("a launcher session (HL_SESSION_ID) never relays; goal-gate starts the tick quietly, uses CFG, and fails open alone", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "x");
    assert.equal(gate(sb, { session_id: "s1" }, { HL_SESSION_ID: "A@1" }).out, "");
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "stop");
    assert.equal(fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => f.startsWith("claimed-")).length, 0);
    const lone = path.join(sb.tmp, "hooks"); fs.mkdirSync(lone); fs.copyFileSync(GOAL_GATE, path.join(lone, "goal-gate.mjs"));
    fs.mkdirSync(path.join(sb.cfg, "goals"), { recursive: true }); fs.writeFileSync(path.join(sb.cfg, "goals", "s9.md"), "- [ ] open item\n");
    const run = (input) => spawnSync(process.execPath, [path.join(lone, "goal-gate.mjs")], { env: sb.env, input, encoding: "utf8" }).stdout;
    assert.equal(JSON.parse(run(JSON.stringify({ session_id: "s9" }))).decision, "block"); // CFG/goals fallback
    assert.equal(run("{}"), "");
  } finally { sb.cleanup(); }
});

test("an alert file records the desktop notification result", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "R", sid: "r-1", mode: "bg", bg_id: "bg-R", coord: undefined });
    setAgents(sb, [{ id: "bg-R", sessionId: "r-1", name: "R", status: "running" }]);
    let t = tx({ start: Date.now() - 10 * 60000 }).user("go");
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
    writeTranscript(sb, sb.repo, e.session_id, t.entries());
    coordRun(sb, ["tick"]);
    const d = path.join(sb.coord, "alerts"), [f] = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).desktop, "skipped (HL_NO_SPAWN)");
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test claude/skills/handoff-launch/tests/alerts.test.mjs`
Expected: FAIL: goal-gate prints nothing for the queued alert (no relay yet); `tick.json` is missing (goal-gate
starts no tick); the CFG goals fallback does not block (goal-gate looks in `~/.claude/goals`); the alert file has no
`desktop`.

- [ ] **Step 3: `recover.mjs`**

```js
// ---------- desktop notification: best effort, the result is logged in the alert file ----------
// Windows: a NotifyIcon balloon from built-in PowerShell 5.1 (the WinRT toast API needs a registered AppUserModelID
// and fails silently without one). macOS: osascript. Linux: notify-send, if present.
export function desktopNotify(title, text) {
  if (process.env.HL_NO_SPAWN === "1") return "skipped (HL_NO_SPAWN)";
  const opts = { detached: true, stdio: "ignore", windowsHide: true };
  try {
    let p;
    if (process.platform === "win32") {
      const ps = ["Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing",
        "$n = New-Object System.Windows.Forms.NotifyIcon", "$n.Icon = [System.Drawing.SystemIcons]::Warning",
        `$n.BalloonTipTitle = ${V.psq(title)}`, `$n.BalloonTipText = ${V.psq(String(text).slice(0, 250))}`,
        "$n.Visible = $true", "$n.ShowBalloonTip(15000)", "Start-Sleep -Seconds 16", "$n.Dispose()"].join("; ");
      p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], opts);
    } else if (process.platform === "darwin") p = spawn("osascript", ["-e", `display notification ${JSON.stringify(String(text))} with title ${JSON.stringify(title)}`], opts);
    else p = spawn("notify-send", [title, String(text)], opts);
    p.on("error", () => {});
    p.unref();
    return "spawned";
  } catch (e) { return `failed: ${e.message}`; }
}
// A claimed alert not marked sent within 15 min goes back to the queue, so an alert never dies silently.
export function releaseStaleClaims(now = Date.now()) {
  const dir = C("alerts"), out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    const m = /^claimed-.+-(\d{13})-(\d.*\.json)$/.exec(f);
    if (!m || now - Number(m[1]) < 15 * L.MIN) continue;
    try { fs.renameSync(path.join(dir, f), path.join(dir, m[2])); out.push(`released the unsent alert ${m[2]}`); } catch {}
  }
  return out;
}
```

   `raiseAlert` becomes:

```js
export function raiseAlert({ name, text, incident }) {
  const f = C("alerts", `${V.now().replace(/[:.]/g, "-")}-${stem(name)}.json`);
  V.writeAtomic(f, JSON.stringify({ text, incident, created: V.now(), desktop: desktopNotify("Claude coordinator", text) }, null, 2));
  return f;
}
```

   In `tick`, directly after the `tick.json` write: `if (!dryRun) out.push(...releaseStaleClaims(now));`

- [ ] **Step 3b (only if probe 6 failed): a visible window instead of the balloon**

Replace the win32 branch of `desktopNotify` with:

```js
      // Probe 6: no balloon from a detached, windowless spawn on this machine - show a small console window instead.
      p = spawn("cmd.exe", ["/c", "start", "Claude coordinator", "powershell", "-NoProfile", "-Command", `Write-Host ${V.psq(String(text))}; Start-Sleep 120`], opts);
```

- [ ] **Step 4: `coord.mjs`**

Add the header lines `//   relay        Stop-hook helper: in a non-launcher session, claim one alert and ask the session to push it`
and `//   alert-sent <file> | alert-release <file>   mark a claimed alert sent, or put it back`, then insert this block
directly above `const stdin = ...` (it must come before the CLI block at the end of the file: its `const`s are read when
`main` runs):

```js
// ---------- alerts: the phone push goes out through a live non-launcher session (goal-gate calls these) ----------
const ME = () => fileURLToPath(import.meta.url).split(path.sep).join("/");
// Claim one queued alert for session <sid>. The rename is atomic, so two sessions never claim the same alert.
export async function claimAlert(sid) {
  const { V } = await context();
  const dir = path.join(V.COORD, "alerts");
  let names = []; try { names = fs.readdirSync(dir).filter((f) => /^\d.*\.json$/.test(f)).sort(); } catch { return null; }
  for (const f of names) {
    const claimed = path.join(dir, `claimed-${sid}-${Date.now()}-${f}`);
    try { fs.renameSync(path.join(dir, f), claimed); } catch { continue; }
    const a = readJson(claimed, {}), c = claimed.split(path.sep).join("/");
    return `Coordinator alert. Send this with PushNotification: ${a.text}\nThen run: node "${ME()}" alert-sent "${c}". If you can't, run: node "${ME()}" alert-release "${c}".`;
  }
  return null;
}
const CLAIMED = /^claimed-.+-\d{13}-(\d.*\.json)$/;
function claimedFile(V, file) {
  const dir = path.resolve(V.COORD, "alerts"), f = path.resolve(String(file || ""));
  return path.dirname(f).toLowerCase() === dir.toLowerCase() && CLAIMED.test(path.basename(f)) && fs.existsSync(f) ? f : null;
}
export async function alertSent(file) {
  const { V } = await context(), f = claimedFile(V, file);
  if (!f) return `not a claimed alert: ${file}`;
  fs.renameSync(f, path.join(path.dirname(f), `sent-${CLAIMED.exec(path.basename(f))[1]}`));
  return "alert marked sent";
}
export async function alertRelease(file) {
  const { V } = await context(), f = claimedFile(V, file);
  if (!f) return `not a claimed alert: ${file}`;
  fs.renameSync(f, path.join(path.dirname(f), CLAIMED.exec(path.basename(f))[1]));
  return "alert released";
}
export async function startTick(by) { const { V, cfg } = await context(); return V.triggerTick(by, cfg.tick_min); }
```

   and in `main`:

```js
  else if (sub === "relay") {
    const i = stdin();
    if (!process.env.HL_SESSION_ID && i?.session_id) { const msg = await claimAlert(i.session_id); if (msg) process.stdout.write(JSON.stringify({ decision: "block", reason: msg })); }
  }
  else if (sub === "alert-sent") console.log(await alertSent(argv[1]));
  else if (sub === "alert-release") console.log(await alertRelease(argv[1]));
```

- [ ] **Step 5: `goal-gate.mjs`**

1. Imports: `import { fileURLToPath, pathToFileURL } from "node:url";`
2. After the `MAX_BLOCKS`/`STALE_HOURS` constants:

```js
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
// The coordinator (handoff-launch stage 2) lives next to this hook. Each Stop may start its tick (at most every
// tick_min), and a session the launcher did not start (no HL_SESSION_ID) relays one alert per Stop. If coord.mjs is
// missing or fails, the gate behaves exactly as before (fail open).
let coord = null;
try { const f = path.join(path.dirname(fileURLToPath(import.meta.url)), "coord.mjs"); if (fs.existsSync(f)) coord = await import(pathToFileURL(f).href); } catch {}
```

3. Inside the main `try`, directly after `if (!sid) allow();`:

```js
  try { await coord?.startTick("stop"); } catch {}
  if (coord && !process.env.HL_SESSION_ID) { let msg = null; try { msg = await coord.claimAlert(sid); } catch {} if (msg) block(msg); }
```

4. The fallback goal path becomes `candidates.push(path.join(CFG, "goals", \`${sid}.md\`));`, and the header comment's
   contract line notes "Fallback: <config dir>/goals/<session id>.md (CLAUDE_CONFIG_DIR or ~/.claude)".

- [ ] **Step 6: Run the tests**

Run: `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add claude/skills/handoff-launch claude/hooks
git commit -m "coordinator alerts: desktop balloon, phone relay through goal-gate in non-launcher sessions, stale claims returned; goal-gate starts the tick and uses CLAUDE_CONFIG_DIR"
```

---

### Task 10: End-to-end tests: isolation and the merge session at its cap

The superseded-close end-to-end test lives in Task 7 with the code it pins.

**Files:**
- Test: `claude/skills/handoff-launch/tests/isolation.test.mjs` (new)

**Interfaces:**
- Consumes: everything above; helpers `sandbox, launchLane, commitIn, writeDone, sessionLine, appendLine, writeTranscript,
  setAgents, coordRun, tx, host, alive`; `RESUME_WORKS` from `recover-lib.mjs`.
- Produces: no new code. If a test fails, the fix goes to the owning task's file, with a scoped re-review.

- [ ] **Step 1: Write the tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, launchLane, commitIn, writeDone, sessionLine, appendLine, writeTranscript, setAgents, coordRun, tx, host, alive } from "./helpers.mjs";
import { RESUME_WORKS } from "../recover-lib.mjs";

const MIN = 60000;
const loopT = (cmd) => { let t = tx({ start: Date.now() - 10 * MIN }).user("go"); for (let i = 0; i < 5; i++) t = t.call("Bash", { command: cmd }); return t.entries(); };

test("isolation: the tick kills and restarts only the looping lane; the other lane is byte- and pid-identical", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const hA = host(), hB = host();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const wa = launchLane(sb, "g1", "A"), wb = launchLane(sb, "g1", "B");
    commitIn(sb, wb, { "b.txt": "B work\n" }, "B work");
    fs.writeFileSync(path.join(wb, "scratch.txt"), "uncommitted\n");
    const first = (n) => sb.registry().find((o) => o.name === n);
    const lane = (n, wt, h) => sessionLine(sb, { name: n, id: `${n}@live`, group: "g1", branch: `lane-${n}`, worktree: wt, gen: 2, sid: `sid-${n}`, host: h, done_marker: first(n).done_marker, prompt_file: first(n).prompt_file });
    lane("A", wa, hA); lane("B", wb, hB);
    writeTranscript(sb, wa, "sid-A", loopT("poll"));
    const tB = writeTranscript(sb, wb, "sid-B", tx({ start: Date.now() - 10 * MIN }).user("go").call("Read", { file_path: "b.txt" }).call("Edit", { file_path: "b.txt" }).call("Bash", { command: "npm test" }).entries());
    const snap = () => ({
      lines: sb.registry().filter((o) => o.name === "B" || JSON.stringify(o).includes('"B@live"')).map((o) => JSON.stringify(o)),
      head: sb.git(wb, "rev-parse", "HEAD"), status: sb.git(wb, "status", "--porcelain"),
      files: fs.readdirSync(wb).filter((f) => f !== ".git").sort().map((f) => [f, fs.statSync(path.join(wb, f)).isFile() ? fs.readFileSync(path.join(wb, f), "utf8") : "dir"]),
      transcript: fs.readFileSync(tB, "utf8"),
      stops: fs.existsSync(path.join(sb.reg, "stops")) ? fs.readdirSync(path.join(sb.reg, "stops")).filter((f) => f.startsWith("B-live")) : [],
      hook: fs.existsSync(path.join(sb.coord, "sessions", "sid-B.json")),
    });
    const before = snap();
    let r = coordRun(sb, ["tick"]);
    assert.match(r.out, /^LOOPING A \(gen 2\): .* - stop requested/m);
    const stop = JSON.parse(fs.readFileSync(path.join(sb.reg, "stops", "A-live.ladder.stop.json"), "utf8"));
    appendLine(sb, { stop_delivered: "A@live", token: stop.token, at: new Date(Date.now() - 6 * MIN).toISOString() });
    r = coordRun(sb, ["tick"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^killed A: closed$/m);
    assert.match(r.out, new RegExp(`^restarted A: ${RESUME_WORKS ? "resume" : "fresh"} \\(opus/high\\)$`, "m"));
    assert.equal(alive(hA.pid), false);
    assert.equal(alive(hB.pid), true); // same pid, still running
    assert.deepEqual(snap(), before);
    assert.equal((JSON.parse(fs.readFileSync(path.join(sb.coord, "looping.json"), "utf8")))["sid-B"], undefined);
    const again = sb.registry().filter((o) => o.name === "A" && o.launched_at).at(-1);
    assert.equal(again.worktree, first("A").worktree); // A's own worktree only
    if (RESUME_WORKS) { assert.equal(again.session_id, "sid-A"); assert.equal(again.resumed_from, "A@live"); }
  } finally { hA.kill(); hB.kill(); sb.cleanup(); }
});

test("a looping merge session at its cap: blocked, merge.lock untouched, the alert names abort-then-force", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main").code, 0);
    const b = launchLane(sb, "g1", "B"), c = launchLane(sb, "g1", "C");
    writeDone(sb, "g1", "B", commitIn(sb, b, { "shared.txt": "line1\nB\nline3\n" }, "B edits line2"));
    assert.match(sb.run("merge", "--group", "g1", "--repo", sb.repo).out, /merged B/);
    writeDone(sb, "g1", "C", commitIn(sb, c, { "shared.txt": "line1\nC\nline3\n" }, "C edits line2"));
    assert.match(sb.run("merge", "--group", "g1", "--repo", sb.repo).out, /CONFLICT C/);
    const lockFile = path.join(sb.repo, ".superpowers", "sessions", "g1", "merge.lock"), lockBefore = fs.readFileSync(lockFile, "utf8");
    const m = sb.registry().filter((o) => o.name === "g1-merge-C" && o.launched_at).at(-1);
    const live = sessionLine(sb, { name: "g1-merge-C", id: "g1-merge-C@live", group: "g1", branch: "int-g1", worktree: m.worktree, gen: m.generation + 1,
      sid: "sid-M", mode: "bg", bg_id: "bg-M", handoff: m.handoff, done_marker: m.done_marker });
    setAgents(sb, [{ id: "bg-M", sessionId: "sid-M", name: "g1-merge-C", status: "running" }]);
    for (let i = 0; i < 2; i++) appendLine(sb, { restart: "g1-merge-C", n: i + 1, kind: "fresh", from: `g1-merge-C@${i}`, handoff: m.handoff, at: new Date().toISOString() });
    writeTranscript(sb, m.worktree, "sid-M", loopT("git status"));
    coordRun(sb, ["tick"]);
    const stop = JSON.parse(fs.readFileSync(path.join(sb.reg, "stops", "g1-merge-C-live.ladder.stop.json"), "utf8"));
    appendLine(sb, { stop_delivered: live.id, token: stop.token, at: new Date(Date.now() - 6 * MIN).toISOString() });
    const r = coordRun(sb, ["tick"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^BLOCKED g1-merge-C after 2 restart\(s\): incident .*\/incidents\/g1-merge-C-1\.md/m);
    assert.equal(fs.readFileSync(lockFile, "utf8"), lockBefore); // the ladder never touches merge.lock
    assert.ok(sb.registry().some((o) => o.lane_blocked === "g1-merge-C" && o.group === "g1"));
    const d = path.join(sb.coord, "alerts"), [f] = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.match(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).text,
      /Next: git merge --abort in \.claude\/worktrees\/_merge-g1, then node .*launch\.mjs merge --group g1 --force \(or --skip C --why \.\.\.\)\./);
    assert.match(sb.run("status", "--group", "g1", "--repo", sb.repo, "--no-merge").out, /STALE: g1-merge-C closed without merging C/);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run them**

Run: `node --test claude/skills/handoff-launch/tests/isolation.test.mjs`, then the full glob.
Expected: PASS (the isolation test runs on Windows only); full suite `ℹ fail 0`. These pin behaviour Tasks 2-9 built,
so they should pass on first run; a failure is a bug in the owning task's code, never a reason to loosen the test.

- [ ] **Step 3: Commit**

```bash
git add claude/skills/handoff-launch/tests/isolation.test.mjs
git commit -m "tests: coordinator isolation (only the looping lane is touched) and the merge session at its restart cap"
```

---

### Task 11: SKILL.md, README, INSTALL_PROMPT

**Files:**
- Modify: `claude/skills/handoff-launch/SKILL.md` (§2 usage, §3 stop delivery, §4 the `LOOP-BLOCKED` bullet, §5 rewritten)
- Modify: `README.md` (the handoff-launch row; a `hooks/coord.mjs` row), `INSTALL_PROMPT.md` (copy and verify `coord.mjs`)

**Interfaces:** none (docs). The text must match the CLI as built in Tasks 2-9: command names, flags, output words.
If Task 1 took a fallback for probe 1 or 2, add its one-line note to §5 as Task 1 says.

- [ ] **Step 1: SKILL.md §2**

After the `launch.mjs status --group ...` usage line add:

```
Coordinator subcommands (section 5): `launch.mjs recover (--group <id> | --name <session>) --mode auto|report`,
`launch.mjs resume --group <id> [--lane <name>]`, `launch.mjs watchdog [--repo <dir>]` (what the coordinator tick would
do now; writes nothing), `node ~/.claude/hooks/coord.mjs tick --dry-run`. The coordinator itself calls
`launch.mjs --resume <session id> --recovery <incident>` and `--recovery/--prompt-file/--goal-from` on a fresh restart.
```

and replace the bullet "Run with `--dry-run` first ... the windows it would close and the watchdog findings, and changes
nothing." ending with "...the registry line and the windows it would close, and changes nothing."

- [ ] **Step 2: SKILL.md §3**

Replace the last bullet with:

```
- Sessions launched by this launcher get their stop requests from their session hook at their next tool call. Only if
  the launcher printed `stop requested ... deliver with SendMessage to '<name>': <text>` (a session launched before
  stage 2), send that text to that session with `SendMessage`.
```

- [ ] **Step 3: SKILL.md §4**

In the done-contract list (step 3) add after the `MERGE-BLOCKED` bullet:

```
   - `lane <name>: loop-blocked`: the coordinator stopped that lane at its restart cap (see section 5). Report it in
     one line; `launch.mjs resume --group <id> --lane <name>` relaunches it after the cause is fixed.
```

and in "How merges run" add: "`status` shows a lane the coordinator blocked as `LOOP-BLOCKED (incident <path> - resume:
...)`; the drain skips it and `final_ready` counts it like a blocked lane."

- [ ] **Step 4: SKILL.md §5, replaced**

```
## 5. Auto-close, stop and loop recovery (the coordinator)
- **Auto-close** (window launches): after launching generation N on a repo+branch, the windows of generations ≤ N-2
  there are closed - only if the window's process is still the PowerShell host recorded at launch (PID-reuse guard) AND
  its session is idle (finished turn, no outstanding tool call, no background agents) for ≥ 10 min. A busy session gets
  a stop request instead. `--no-close` disables it.
- **The coordinator tick** (`~/.claude/hooks/coord.mjs tick`, code in `recover.mjs`) runs at most every 5 min. It is
  started detached by the goal-gate Stop hook in every session, by the session hook in launcher sessions, and by every
  launch. It spends no tokens until something fires, reads only the launcher registry's sessions, and never touches
  another session: a kill hits only the target's own recorded process tree (pid and start time checked first), and a
  restart reuses only the target's own worktree. A process probe that fails or times out means `unknown`: nothing is
  closed, killed or judged STALE, and `status` says `liveness=unknown (...)`.
- **It also closes,** in every group, a window of generation N-1 once N runs and N-1 is idle ≥ 10 min with no
  outstanding call, no background agents and no permission prompt open; and, in `auto` groups only, an idle window
  that recorded `{paused}` or has an incident while a newer generation runs.
- **The session hook** (every session this launcher starts gets it through `--settings`) runs after each tool call and
  adds at most one line: a stop request, a looping-subagent notice, or an early warning.
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
- **The ladder** (groups launched after stage 2 are `auto`): warning → stop request → 5 min grace → incident file
  (`.superpowers/sessions/<id>/incidents/<lane>-<n>.md`) → kill → restart. The first restart resumes the session
  (`claude --resume`; a background session always restarts fresh), the second is fresh from the original pointer prompt with its GOAL.md; at ≥ 400k tokens of
  context the first restart is fresh and the cap is 1. After that the lane is `LOOP-BLOCKED` and you are alerted. A lane
  whose done marker exists is killed but not restarted, and only the newest generation of a lane is ever restarted. A
  restart that fails to launch also blocks the lane; its alert names the launcher log (`~/.claude/state/coord/restarts/`). A restart waits while the pause file is active. Waiting on a
  usage limit, on AskUserQuestion or on a permission prompt is never flagged.
- **Groups launched before stage 2 are `report-only`:** an incident and an alert, nothing stopped. `status` prints
  `recovery: report-only (...)`. Opt in with `launch.mjs recover --group <id> --mode auto` (`--mode report` opts out). Opting in warns about
  sessions that have no session hook: a stop request cannot reach them, so a loop there is killed 5 min after the request.
- **A merge session at its cap** keeps `merge.lock` (status shows STALE). Its alert says what to do: `git merge --abort`
  in `.claude/worktrees/_merge-<id>`, then `launch.mjs merge --group <id> --force` (or `--skip <lane> --why ...`).
- **`status`** lane notes: `incidents=<n> (latest <path>)`, `LOOP-BLOCKED (...)`, `liveness=unknown (...)`.
  `launch.mjs resume --group <id> [--lane <n>]` relaunches blocked lanes fresh with a new restart budget.
  `launch.mjs watchdog [--repo <dir>]` prints what the tick would do now and writes nothing.
- **Alerts:** a desktop notification, plus an alert file that the next session not started by this launcher relays as
  a phone push: its Stop hook asks it once to send the text with PushNotification and run the printed `alert-sent`
  (or `alert-release`) command. An unsent claim returns to the queue after 15 min.
- Thresholds: `~/.claude/state/coord/config.json` (`repeat_window` 20, `repeat_count` 4, `warn_streak` 3, `stuck_min`
  30, `grace_min` 5, `idle_close_min` 10, `fresh_at_tokens` 400000, `max_restarts` 2, `tick_min` 5,
  `alert_repeat_hours` 6). The last tick's report: `~/.claude/state/coord/last-tick.txt`.
- **Stop contract** - any session that receives a stop request: finish or cancel the in-flight tool call, `TaskStop`
  every background agent it started, record its state in its ledger/handoff, then end its turn and start no new work.
- Large-org variant: a central supervisor service with an audit log, per-session credentials for stop and kill, and
  policy-gated kills.
```

- [ ] **Step 5: README and INSTALL_PROMPT**

`README.md`: in the `skills/handoff-launch/` row replace "auto-close of stale windows, and a loop watchdog." with
"auto-close of stale and superseded windows, and a loop coordinator: an early warning after each tool call, then stop
request → incident → kill → resume/fresh restart → blocked + alert, with no effect on any other session."; add a row:

```
| `hooks/coord.mjs` | The loop coordinator's hook entry: the session hook that `launch.mjs` passes to every session it starts (`--settings`), the coordinator tick, and the alert relay that goal-gate uses. Not registered in `settings.json`. |
```

`INSTALL_PROMPT.md` step 3: add `   - claude/hooks/coord.mjs       -> CONFIG/hooks/coord.mjs` after the goal-gate line,
and in step 9 after the goal-gate check add:

```
   - `echo {} | node "CONFIG/hooks/coord.mjs" post-tool` exits 0 with no output, and
     `node "CONFIG/hooks/coord.mjs" tick --dry-run` prints `tick: nothing to do` (or the lines of what it would do).
     coord.mjs is not added to settings.json: launch.mjs passes it to each session it starts.
```

- [ ] **Step 6: Check the docs against the code, then commit**

Run: `grep -n "watchdog\|stop-looping\|nudge" claude/skills/handoff-launch/SKILL.md README.md INSTALL_PROMPT.md`
Expected: no line still says the watchdog runs at every launch, kills windows, or counts goal-gate nudges.

```bash
git add claude/skills/handoff-launch/SKILL.md README.md INSTALL_PROMPT.md
git commit -m "docs: loop coordinator - lane rules, the ladder, report-only groups, new commands and status notes, coord.mjs install"
```

---

### Task 12 (controller): review, deploy, verify, push

Not a subagent implementation task: the controller runs it.

- [ ] **Step 1: Whole-branch review.** Dispatch `worker-xhigh` + **fable** on `git diff main...stage2-loop-recovery`
  with this plan, the spec and the Review Focus list. Fix findings through a `worker-xhigh` + opus dispatch (kill,
  liveness or restart code) or `worker-high` + opus (anything else); anything edited after the review gets a scoped
  re-review of those edits.
- [ ] **Step 2: Full suite.** `node --test "claude/skills/handoff-launch/tests/*.test.mjs"` → `ℹ fail 0`; quote the
  summary lines.
- [ ] **Step 3: Deployment safety: a read-only dry run against the live registry, before anything is deployed.**
  From the repo copy, pointed at the live registry and the live config dir:

  ```bash
  D=$(mktemp -d); R="$HOME/.claude/skills/handoff-launch"
  snap() { sha1sum "$R/sessions.jsonl"; ls -la "$R/stops" "$R/pids" ~/.claude/state/coord 2>&1; }
  snap > "$D/before.txt"
  HL_NO_SPAWN=1 HL_REGISTRY_DIR="$R" node claude/hooks/coord.mjs tick --dry-run > "$D/tick-dry.txt"; cat "$D/tick-dry.txt"
  snap | diff "$D/before.txt" -
  ```

  It writes nothing (no registry line, stop or pid file, `tick.json`, `looping.json` or alert): the `diff` prints
  nothing. `HL_NO_SPAWN=1` is a belt: even a bug could not start a process. Show the user every line: each `report-only` incident it would write,
  each `would close <window>` (superseded N-1 and paused windows, all groups, including the running pre-stage-2
  groups), and each `unknown` session. The user approves before anything is deployed; a line they reject is fixed
  (or the rule is ruled on) first. Also capture, for each running group named in the private handoff,
  `node ~/.claude/skills/handoff-launch/launch.mjs status --group <id> --no-merge` as the baseline (read-only).
- [ ] **Step 4: Deploy, in order** (a module imported before it exists would break running lanes' next call):
  1. `live.mjs`, `recover-lib.mjs`, `recover.mjs`, `merge-lib.mjs`, `merge.mjs`, `run-test.mjs`, `tests/` →
     `~/.claude/skills/handoff-launch/`;
  2. `claude/hooks/coord.mjs` → `~/.claude/hooks/coord.mjs`;
  3. `launch.mjs`, then `SKILL.md` → `~/.claude/skills/handoff-launch/`;
  4. `claude/hooks/goal-gate.mjs` → `~/.claude/hooks/goal-gate.mjs` last: from this moment every session's Stop starts
     the live tick.
  Then `diff -r claude/skills/handoff-launch ~/.claude/skills/handoff-launch` → only `pids`, `stops`, `sessions.jsonl`
  and `session-hooks.json` differ (live-only runtime files); `diff claude/hooks/coord.mjs ~/.claude/hooks/coord.mjs`
  and `diff claude/hooks/goal-gate.mjs ~/.claude/hooks/goal-gate.mjs` → identical.
- [ ] **Step 5: Verify live.** `echo {} | node ~/.claude/hooks/goal-gate.mjs` → exit 0, no output;
  `echo {} | node ~/.claude/hooks/coord.mjs post-tool` → exit 0, no output;
  `node ~/.claude/skills/handoff-launch/launch.mjs status --group none` →
  `members=0 done=0 all_done=false merge_launched=false merge_lock=false`; re-run the Step 3 status commands and
  `diff` against the baseline: identical except a `recovery: report-only (...)` line where that group now has an
  incident, and the lane notes the dry run predicted. After the first live tick (within 5 min), read
  `~/.claude/state/coord/last-tick.txt` and check it against the approved dry run.
  Rollback, if the live tick does anything the dry run did not show: restore `~/.claude/hooks/goal-gate.mjs` from
  `main` before this branch (this stops the Stop-hook trigger), then the rest from the same commit.
- [ ] **Step 6: Secret scan** (pattern from the private handoff) → prints nothing.
- [ ] **Step 7: Commit and push.** Fast-forward `main` to `stage2-loop-recovery`, push `main`. Commit messages end with
  the session's attribution lines.
- [ ] **Step 8: Report and hand over.** Tell the user: what deployed; that running lanes pick up `launch.mjs`,
  `merge*.mjs` and the tick on their next call, while the session hook reaches only sessions launched from now on;
  that pre-stage-2 groups are report-only until they opt in (`launch.mjs recover --group <id> --mode auto`); and which
  probe fallbacks are in effect. Then stop and ask the user before any next-stage spec or handoff.

---

## Spec gaps found while planning

Each one is resolved in the plan as written; the resolution stays inside the spec's rules.

1. **Ladder state needs registry lines the spec does not list.** Cancel and re-arm must survive a tick that dies, and
   "the ladder resumes from registry state". Resolution: `{ladder_cancelled: id, signature}` and
   `{ladder_rearmed: id, signature}`; `{stop_requested}` gains `reason_class`, `signature`, `token`; `{stop_delivered}`
   gains `token` (a later stop is a new token, delivered once); `{kill_intent}` gains `kind` (`ladder`/`close`).
2. **A kill_intent with `{closed}` but no restart** (the tick died after recording the close) would never restart under
   the spec's literal rule ("no later {closed} or {restart}"). Resolution: a ladder is pending until a `{restart}`,
   `{restart_skipped}` or `{lane_blocked}` follows its auto incident (`pendingLadders`). A pre-stage-2 `kill_intent`
   (no `kind`, no auto incident) is never pending, so the first live tick restarts nothing it did not kill.
3. **A done lane that is killed but not restarted needs a terminal line**, or every tick would re-examine it.
   Resolution: `{restart_skipped: id, name, why}`.
4. **"A new restart budget" for `launch.mjs resume`** has no registry form. Resolution: `{lane_resumed: name, group,
   handoff}`; `restartsSince` counts `{restart}` lines after the latest one, and `blockedLanes` drops a lane once it
   follows its `{lane_blocked}`.
5. **A resumed session keeps the transcript that got it killed** (same session id): rule (a) would fire on the old
   calls at once. Resolution: only calls at or after the launch line's `launched_at` count (Review Focus 1).
6. **Grace for rule (a) when the stop can never be delivered** (a session without the hook, e.g. after a manual opt-in
   of an old group): the spec starts grace at delivery. Resolution: such a session (no `coord: 1`) gets `grace_min` from
   the request, as rules (b) and (d) do. `launch.mjs recover --mode auto` on a group with such sessions warns that
   stop requests cannot reach them, so a loop there is killed `grace_min` after the request.
7. **Rule (d)'s "no progress since its notice"** is not defined. Resolution: (d) fires while the subagent is in
   `looping.json` (its rule (a) still fires), its notice was delivered (or the session has no hook) and it has not
   finished; its distinct calls pause the grace timer (spec: a distinct call pauses), and leaving `looping.json`
   cancels the ladder (spec: the rule ceasing to fire cancels).
8. **Rule (b) and intentional waiting:** the spec tells sessions to wait with Monitor, but (b) would flag a Monitor call
   outstanding for 30 min. Resolution: (b) never flags an outstanding `Monitor` call.
9. **"Status shows report-only groups" vs the byte-identical legacy golden:** every legacy group is report-only, so an
   unconditional line would change legacy output. Resolution: rolling groups in report mode always print
   `recovery: report-only (...)`; legacy groups print it only when they have an incident or a blocked lane, and lane
   notes appear only when there is something to note.
10. **The hook's isolation line vs step 1:** the spec says a session hook writes only its own `sessions/<sid>.json`, and
    also that step 1 appends `{stop_delivered}`. Resolution: the hook writes its own state file and its own session's
    `{stop_delivered}` line, nothing else.
11. **HL_NO_SPAWN launch lines under tri-state liveness:** a fresh test line with no pid would be `unknown`, and every
    stage-1 `--force` test would start refusing. Resolution: such lines carry `no_spawn: true` and read as `gone` while they have no pid and no bg id (stage-1
    tests copy a test line and give it a live pid; that copy is judged normally).
12. **`prompt_file` and repeated fresh restarts:** saving the full prompt would stack RECOVERY prefixes. Resolution:
    `prompt_file` holds the base pointer prompt; the RECOVERY line is prepended at each launch.
13. **An `{incident}` with no `kill_intent`** resumes at step 5 (spec), and a failed kill is retried each tick. Both
    run detection again on the current transcript first: if the session is exempt or the incident's signature no longer
    fires, the ladder is cancelled (`{ladder_cancelled}` with the incident; the pending stop file is removed; the
    incident no longer blocks that signature, so it can re-arm), and nothing is killed.
14. **Where shared code lives:** `launch.mjs` is a CLI script with top-level side effects, so `recover.mjs` and
    `coord.mjs` cannot import it. Resolution: the new `live.mjs` (see "Decisions").
15. **The restart is run, not just spawned** (controller ruling, against the spec's "spawned detached before the tick
    records {restart}"): `spawnSync` with a 3-min timeout; `{restart}` only on exit 0, else `{restart_failed}` +
    `{lane_blocked}` + an alert, both terminal for the ladder. A launcher that fails or times out after registering its
    session is recorded as `{restart}` with `launcher_exit`, never blocked. A tick that dies mid-launch: the next tick
    resumes the pending ladder, and `afterKill` sees the new generation running (or starting) and appends
    `{restart_skipped}` (gap 17). `launch.mjs resume` refuses a lane whose newest launch is running or unknown.
16. **Background lanes always restart fresh** (controller ruling), as does a session with no recorded session id; the
    spec's "unless the probes show that --resume works with --bg" is dropped.
17. **Only the newest generation restarts:** when a newer generation of the lane has no `{closed}` line, `afterKill`
    never restarts the old one. Newer one running, starting or unknown → `{restart_skipped}` ("superseded by ..."). Newer
    one gone without a close → `{lane_blocked}` + alert, and `launch.mjs resume` relaunches from the newest line (the lane
    may have moved on to a later stage). Two sessions never share a worktree.
18. **Closes in report-only groups:** only the superseded N-1 close (the user's "all groups" decision); paused and
    incident windows close in `auto` mode only. Stage 6 (which creates `{paused}` lines) must decide whether a
    user-initiated pause overrides report mode.
19. **Grace and permission waits:** the hook keeps the last waits (`waits`) when a tool call clears `waiting_since`,
    and `graceElapsed` leaves them out, so a call that sat on a permission prompt is not killed right after approval.
20. **Idle sessions:** rule (a) does not judge a finished main turn with nothing outstanding; an undelivered ladder on
    such a session is cancelled by the normal "rule stopped firing" path; a stop request older than 60 min is marked
    handled and never injected.
21. **Stop files per reason class** (`<stem>.<ladder|close|manual>.stop.json`), so dedupe per (session, reason class)
    holds on disk too.
22. **A lone session's recovery mode** comes from its own launch line (the spec's wording), not the earliest line with
    its name.
