# Model Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `coordinator` command, typed in any terminal folder, opens a Claude Code session run by a cheap model
(provider set in one config file). The session only routes messages to running sessions, opens new Claude sessions,
reports status and reopens sessions that closed without finishing.

**Architecture:** A new skill folder `claude/skills/model-coordinator/` holds the launcher (`start.mjs`), the provider
config reader, the journal helper, the open-session helper and the routing prompt. It runs the real `claude` CLI in
the *current* console with provider env vars and a generated settings file that locks permissions. Session facts
come from the existing handoff-launch registry. A new `status-lib.mjs` classifies each lane, and a new
`coord.mjs status --json` exposes the result. A new `launch.mjs resume --closed` reopens closed lanes. The launcher
strips provider env vars from every child, so worker sessions stay on Claude.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Claude Code CLI flags (`--settings`, `--append-system-prompt-file`,
`--permission-mode`, `--model`, `-n`), Windows `cmd` shim.

**Spec:** `docs/specs/2026-10-07-model-coordinator-design.md` (R1-R8, T1-T6).

**Base:** branch `jev-coordinator` on top of `stage2-loop-recovery` (the deployed code). All `path:line` anchors
below are stage2 anchors.

## Global Constraints

- Model-agnostic. Nothing hard-codes DeepSeek. The provider comes from `<CFG>/coordinator/provider.json`
  `{ "baseUrl", "model", "displayName", "keyFile" }`, where `CFG` = `CLAUDE_CONFIG_DIR` or `~/.claude`.
- The window title is `<displayName> Coordinator`.
- The API key is read from `keyFile` at launch. It is never printed, logged, journaled or committed.
- Public repo: no personal paths, emails or keys in committed files. Paths are built at runtime from `os.homedir()` /
  `CFG`.
- Child sessions never inherit `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL` or `ANTHROPIC_DEFAULT_*`.
- The coordinator may write only under `<CFG>/coordinator/**`. It may run only the commands in `ALLOWED_COMMANDS`
  (Task 4). `Agent`, `Workflow`, `PowerShell`, `WebFetch`, `WebSearch` and `NotebookEdit` are denied.
- Tests: `node --test "claude/skills/<dir>/tests/*.test.mjs"`, using the `tests/helpers.mjs` `sandbox()` harness
  where a registry is needed (`HL_NO_SPAWN=1`, `HL_FAKE_CLAUDE=1`). No test opens a window.
- Every new flag is added to `KNOWN_FLAGS` (`claude/skills/handoff-launch/launch.mjs:98-101`).
- The word "coordinator" already names the tick system (`state/coord`). New code says "model coordinator" in
  identifiers (`MODEL_COORDINATOR`, `model-coordinator/`). The user-facing command stays `coordinator`.

## Review Focus

1. **A key leaking into a worker.** A session opened from the coordinator must run on Claude. Test: T3 in Task 1
   and `start.test.mjs` "child env" in Task 4.
2. **A hand-opened session that is not in the registry** (for example the user's own interactive sessions). Status
   must still show it, from `ListAgents` in the routing prompt and from GOAL.md files via `launch.mjs sessions`.
   It is never offered for `resume --closed`; the coordinator prints `claude --resume <sid>` instead. Test in
   Task 2: a hand GOAL with no registry entry is not in `closedUnfinished`.
3. **Goal gate and fence hooks firing in the coordinator.** The Stop goal-gate would nag it for a GOAL.md. Test:
   with `MODEL_COORDINATOR=1` the goal-gate's missing-nudge returns null (Task 4).
4. **Typing `coordinator` twice.** The second call must not start a second router. Test: the single-instance
   check in Task 4.
5. **A message that names no project, or matches two sessions.** The coordinator asks one question; it never
   guesses. This is pinned in the routing prompt and checked by the T6 live run in Task 6.

---

### Task 1: Children never inherit the provider env (T3)

**Files:**
- Modify: `claude/skills/handoff-launch/live.mjs:591-592` (`cleanEnv` filter)
- Modify: `claude/skills/handoff-launch/live.mjs:600` (PowerShell strip in `windowScript`)
- Test: `claude/skills/handoff-launch/tests/env-strip.test.mjs` (new)

**Interfaces:**
- Produces: `export const PROVIDER_ENV = /^ANTHROPIC_(BASE_URL|AUTH_TOKEN|API_KEY|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+)$/`
  in live.mjs. `cleanEnv()` drops matching keys. `windowScript()` text removes them.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as V from "../live.mjs";

const KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"];

test("cleanEnv drops provider env vars", () => {
  for (const k of KEYS) process.env[k] = "x";
  try {
    const env = V.cleanEnv();
    for (const k of KEYS) assert.equal(env[k], undefined, k);
    assert.ok("PATH" in env || "Path" in env);
  } finally { for (const k of KEYS) delete process.env[k]; }
});

test("windowScript strips provider env vars inside the window", () => {
  const ps = V.windowScript({ pidFile: "p", name: "n", workDir: ".", banner: "b", regId: "r", claudeLine: "claude" });
  assert.match(ps, /ANTHROPIC_/);
  for (const k of KEYS) assert.ok(V.PROVIDER_ENV.test(k), k);
});
```

- [ ] **Step 2: Run it.** `node --test claude/skills/handoff-launch/tests/env-strip.test.mjs`. Expected: FAIL
  (`PROVIDER_ENV` is undefined, and the env still has the keys).

- [ ] **Step 3: Implement.** In live.mjs, above `cleanEnv`:

```js
export const PROVIDER_ENV = /^ANTHROPIC_(BASE_URL|AUTH_TOKEN|API_KEY|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+)$/;
```

Then in the `cleanEnv` filter, add `&& !PROVIDER_ENV.test(k)` to the predicate. In `windowScript` (:600), extend
the `Where-Object` clause with `-or $_.Name -match '^ANTHROPIC_(BASE_URL|AUTH_TOKEN|API_KEY|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+)$'`.

- [ ] **Step 4: Run** the new test plus the whole suite:
  `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`. Expected: all PASS.

- [ ] **Step 5: Commit**
  `git add claude/skills/handoff-launch/live.mjs claude/skills/handoff-launch/tests/env-strip.test.mjs`
  `git commit -m "feat(launch): never pass provider env vars to child sessions"`

### Task 2: Lane status classifier and `coord.mjs status --json` (R4)

**Files:**
- Create: `claude/skills/handoff-launch/status-lib.mjs`
- Modify: `claude/hooks/coord.mjs:550-598` (add the `status` branch to `main`, and a usage line in the header :1-21)
- Test: `claude/skills/handoff-launch/tests/status.test.mjs` (new)

**Interfaces:**
- Consumes: `readRegistry()` (live.mjs:58) → `{lines, entries, closed, ...}`; `liveness(e, reg)` (live.mjs:310) →
  `{state}`; `goalOf(sid)` (live.mjs:457) → path|null; `parseGoal(text)` (recover-lib.mjs:627);
  `pausedLineOf(lines, e)` (pause-lib.mjs:49); `lanePauseKey(e)` (pause-lib.mjs:84).
- Produces:
  - `classify(e, { lines, closedIds, gone, doneMarker, goal })`, which returns `{ state, reason }`.
    - `state` is one of `"open"`, `"finished"`, `"paused"` or `"closed_unfinished"`.
  - `laneStatus(reg, { now, gone, readGoal, markerExists })`, which returns one row per lane.
    - A row is `{ id, name, repo, group, branch, state, reason, goal, launched_at, session_id }`.
    - Only the newest entry per `lanePauseKey` is included.
  - `closedUnfinished(rows)`, which returns `rows.filter(r => r.state === "closed_unfinished")`.
  - CLI: `node coord.mjs status [--json]`. JSON prints `{ at, lanes: rows }`. Text prints one line per lane:
    `<state> <name> (<repo>) - <reason> - <goal>`.

Classification rules, in order (the first match wins):
1. `gone(e)` is false: `open`, with reason `"running"`.
2. `doneMarker` exists, or the goal has items with `open === 0 && blocked === 0`, or a `{kill_intent: e.id, kind: "close"}` line exists:
   `finished`. The reason is `"done marker"`, `"goal complete"` or `"closed by coordinator: <why>"`.
3. `pausedLineOf(lines, e)` is truthy: `paused`, with reason `"paused: <reason>"`.
4. A `{closed}` line for e.id with why `"claude exited"`: `closed_unfinished`, reason `"claude exited"`.
5. A `{dead_start}` line for e.id: `closed_unfinished`, reason `"failed to start"`.
6. Not in `closedIds`: `closed_unfinished`, reason `"crashed or window closed"`.
7. Any other closed line: `finished`, reason `"closed: <why>"`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classify, laneStatus, closedUnfinished } from "../status-lib.mjs";

const e = (name, at, extra = {}) => ({ id: `${name}@${at}`, name, repo: "r", launched_at: at, ...extra });
const base = { lines: [], closedIds: new Set(), gone: () => true, doneMarker: false, goal: null };

test("running lane is open", () => {
  assert.equal(classify(e("a", "2026-10-07T00:00:00Z"), { ...base, gone: () => false }).state, "open");
});
test("gone without closed line is closed_unfinished", () => {
  assert.deepEqual(classify(e("a", "t"), base), { state: "closed_unfinished", reason: "crashed or window closed" });
});
test("goal fully ticked is finished", () => {
  const goal = { items: [{}], open: 0, blocked: 0 };
  assert.equal(classify(e("a", "t"), { ...base, goal }).state, "finished");
});
test("paused line wins over crash", () => {
  const x = e("a", "t");
  const lines = [{ paused: x.id, reason: "usage", at: "t" }];
  assert.equal(classify(x, { ...base, lines }).state, "paused");
});
test("claude exited is closed_unfinished", () => {
  const x = e("a", "t");
  const r = classify(x, { ...base, lines: [{ closed: "a", id: x.id, why: "claude exited" }], closedIds: new Set([x.id]) });
  assert.deepEqual(r, { state: "closed_unfinished", reason: "claude exited" });
});
test("coordinator close is finished", () => {
  const x = e("a", "t");
  const lines = [{ kill_intent: x.id, kind: "close", why: "idle" }, { closed: "a", id: x.id, why: "idle" }];
  assert.equal(classify(x, { ...base, lines, closedIds: new Set([x.id]) }).state, "finished");
});
test("laneStatus keeps only the newest entry per lane", () => {
  const reg = { lines: [], closed: new Set(), entries: [e("a", "2026-10-07T00:00:00Z"), e("a", "2026-10-07T01:00:00Z")] };
  const rows = laneStatus(reg, { gone: () => true, readGoal: () => null, markerExists: () => false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].launched_at, "2026-10-07T01:00:00Z");
  assert.equal(closedUnfinished(rows).length, 1);
});
```

- [ ] **Step 2: Run it.** `node --test claude/skills/handoff-launch/tests/status.test.mjs`. Expected: FAIL
  (module not found).

- [ ] **Step 3: Implement `status-lib.mjs`**

```js
// Lane status for the model coordinator: one row per lane (newest launch), classified open / finished / paused /
// closed_unfinished. Pure: callers pass liveness, goal and marker probes, so tests need no processes.
import { pausedLineOf, lanePauseKey } from "./pause-lib.mjs";

export function classify(e, { lines, closedIds, gone, doneMarker, goal }) {
  if (!gone(e)) return { state: "open", reason: "running" };
  const kill = [...lines].reverse().find((o) => o.kill_intent === e.id);
  if (doneMarker) return { state: "finished", reason: "done marker" };
  if (goal && goal.items?.length && goal.open === 0 && goal.blocked === 0) return { state: "finished", reason: "goal complete" };
  if (kill?.kind === "close") return { state: "finished", reason: `closed by coordinator: ${kill.why ?? "no reason"}` };
  const p = pausedLineOf(lines, e);
  if (p) return { state: "paused", reason: `paused: ${p.reason ?? p.source ?? "unknown"}` };
  const closed = [...lines].reverse().find((o) => o.closed && (o.id ?? o.closed) === e.id);
  if (closed?.why === "claude exited") return { state: "closed_unfinished", reason: "claude exited" };
  if (lines.some((o) => o.dead_start === e.id)) return { state: "closed_unfinished", reason: "failed to start" };
  if (!closedIds.has(e.id)) return { state: "closed_unfinished", reason: "crashed or window closed" };
  return { state: "finished", reason: `closed: ${closed?.why ?? "no reason"}` };
}

export function laneStatus(reg, { gone, readGoal, markerExists }) {
  const newest = new Map();
  for (const e of reg.entries) {
    const k = lanePauseKey(e), cur = newest.get(k);
    if (!cur || (Date.parse(cur.launched_at) || 0) <= (Date.parse(e.launched_at) || 0)) newest.set(k, e);
  }
  return [...newest.values()].map((e) => {
    const goal = readGoal(e);
    const { state, reason } = classify(e, { lines: reg.lines, closedIds: reg.closed, gone, doneMarker: markerExists(e), goal });
    return { id: e.id, name: e.name, repo: e.repo ?? null, group: e.group ?? null, branch: e.branch ?? null, state, reason,
      goal: goal?.goal ?? null, launched_at: e.launched_at, session_id: e.session_id ?? null };
  });
}

export const closedUnfinished = (rows) => rows.filter((r) => r.state === "closed_unfinished");
```

Before using it, check the `{dead_start}` line field name against `recover.mjs:936-939` and the `{paused}` reason
field against `pause-lib.mjs:45-55`. Adjust `classify` to match, and keep the tests passing.

- [ ] **Step 4: Add `status` to coord.mjs.** In `main(argv)`, add a branch before the final else:

```js
} else if (argv[0] === "status") {
  const V = await mod("live.mjs"), S = await mod("status-lib.mjs"), RL = await mod("recover-lib.mjs");
  const reg = V.readRegistry(); V.primeLiveness(reg.entries.filter((e) => !reg.closed.has(e.id)));
  const rows = S.laneStatus(reg, {
    gone: (e) => V.liveness(e, reg).state === "gone",
    readGoal: (e) => { const p = e.session_id && V.goalOf(e.session_id); try { return p ? RL.parseGoal(fs.readFileSync(p, "utf8")) : null; } catch { return null; } },
    markerExists: (e) => !!e.done_marker && fs.existsSync(e.done_marker),
  });
  if (argv.includes("--json")) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), lanes: rows }) + "\n");
  else for (const r of rows) process.stdout.write(`${r.state} ${r.name} (${r.repo}) - ${r.reason}${r.goal ? ` - ${r.goal}` : ""}\n`);
```

If `fs` is not imported in coord.mjs, import it at the top.

- [ ] **Step 5: CLI test.** Append to status.test.mjs, using `sandbox()`, `launchLane()` and `coordRun()` from
  `tests/helpers.mjs`:

```js
import { sandbox, launchLane, coordRun } from "./helpers.mjs";
test("coord status --json lists a launched lane", () => {
  const sb = sandbox({});
  launchLane(sb, null, "lane-a");
  const out = JSON.parse(coordRun(sb, ["status", "--json"]).stdout);
  assert.ok(out.lanes.some((r) => r.name === "lane-a"));
});
```

Check the real signatures of `sandbox`, `launchLane` and `coordRun` (helpers.mjs:13, :22, :71) and match them.

- [ ] **Step 6: Run** `node --test "claude/skills/handoff-launch/tests/*.test.mjs"`. Expected: all PASS.
- [ ] **Step 7: Commit** status-lib.mjs, coord.mjs and status.test.mjs by name:
  `feat(coord): lane status classifier and coord.mjs status --json`.

### Task 3: `launch.mjs resume --closed` (R5)

**Files:**
- Modify: `claude/skills/handoff-launch/launch.mjs:536-575` (the `resume` subcommand), `:98-101` (`KNOWN_FLAGS`), and
  the usage header `:2-28`
- Test: `claude/skills/handoff-launch/tests/resume-closed.test.mjs` (new)

**Interfaces:**
- Consumes: `laneStatus`, `closedUnfinished` (Task 2); `freshLaunchArgs(e, {model, effort, resumeNote, supersedes})`
  (recover-lib.mjs:298); `acquireTickLock` (recover.mjs:44); `launcherEnv()` (live.mjs:584).
- Produces: `node launch.mjs resume --closed (--all | --id <id>) [--dry-run]`. It prints one line per lane,
  `reopen <name> (<reason>)`. With `--dry-run` it prints `would reopen <name> (<reason>)` and launches nothing.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, launchLane, appendLine } from "./helpers.mjs";

test("resume --closed --dry-run lists only unfinished closed lanes", () => {
  const sb = sandbox({});
  const a = launchLane(sb, null, "crashed-lane");
  const b = launchLane(sb, null, "done-lane");
  appendLine(sb, { kill_intent: b.id, kind: "close", why: "idle", at: new Date().toISOString() });
  appendLine(sb, { closed: "done-lane", id: b.id, why: "idle", at: new Date().toISOString() });
  const out = sb.run("resume", "--closed", "--all", "--dry-run").stdout;
  assert.match(out, /would reopen crashed-lane/);
  assert.doesNotMatch(out, /done-lane/);
});
```

Check the helper signatures and return shapes (`launchLane` returning the entry or its id; `appendLine(sb, obj)`)
at helpers.mjs:71 and :118-120, and match them. Under `HL_NO_SPAWN`, a launched lane must read as gone. If the
fake does not report that, pass `gone` through the same path the `resume --paused` tests use, and say so in the
report.

- [ ] **Step 2: Run it.** Expected: FAIL (`--closed` is unknown and nothing is printed).
- [ ] **Step 3: Implement.** In the `resume` subcommand, add a `--closed` branch next to `--paused` that reuses
  its frame:
  - Take the tick lock with `acquireTickLock`.
  - Build `rows = closedUnfinished(laneStatus(reg, {...same probes as Task 2...}))`.
  - Filter by `--id` when it is given. Require `--all` or `--id` (exit 2 with a usage line otherwise).
  - Skip a lane with a `{starting}` line under 5 min old, the same guard as `pausedLanes` (pause-lib.mjs:95).
  - For each remaining row, find its entry `e` and spawn `launch.mjs` with
    `freshLaunchArgs(e, { model: e.model, effort: e.effort, resumeNote: "reopened after it closed unfinished (<reason>)", supersedes: e.id })`
    under `launcherEnv()`, exactly as `resume --paused` does at :566-568.
  - Do **not** apply the `pauseForNow` gate; the user asked for these lanes explicitly.
  - Add `"--closed"` to `KNOWN_FLAGS`, and a usage line to the header.
- [ ] **Step 4: Run** the full suite. Expected: all PASS, including `provenance.test.mjs`, which pins `KNOWN_FLAGS`.
  Update its expected list if it asserts the exact set.
- [ ] **Step 5: Commit** launch.mjs, resume-closed.test.mjs and any provenance test edit, by name:
  `feat(launch): resume --closed reopens lanes that closed unfinished`.

### Task 4: Model-coordinator launcher, permissions, journal, `coordinator` command (R1, R2, R6, R7, R8)

**Files:**
- Create: `claude/skills/model-coordinator/provider.mjs`. It reads and validates `provider.json` and the key.
- Create: `claude/skills/model-coordinator/settings.mjs`. It builds the locked settings object (pure).
- Create: `claude/skills/model-coordinator/journal.mjs`. CLI and lib: `append` and `tail`.
- Create: `claude/skills/model-coordinator/start.mjs`. The launcher: single instance, env, claude in this console.
- Create: `claude/skills/model-coordinator/coordinator.cmd`. The PATH shim.
- Create: `claude/skills/model-coordinator/provider.example.json`
- Modify: `claude/hooks/goal-gate.mjs:53` (also return null when `process.env.MODEL_COORDINATOR === "1"`), and the
  same opt-out at the top of the full gate path
- Test: `claude/skills/model-coordinator/tests/coordinator.test.mjs`

**Interfaces:**
- `provider.mjs`:
  - `readProvider(cfgDir)` returns `{ baseUrl, model, displayName, key }`.
  - It throws `Error("provider.json missing: <path> - copy provider.example.json")` when the file is missing.
  - It throws `Error("key file missing or empty")` when the key is absent.
  - It never includes the key in an error message.
- `settings.mjs`:
  - `ALLOWED_COMMANDS(paths)` returns string[] of Bash allow rules.
  - `coordinatorSettings({ paths, hooks })` returns the settings object.
  - `paths = { cfg, skills, hooks, stateDir }`, all with forward slashes.
- `journal.mjs`:
  - `appendEntry(stateDir, { message, decision, target })` writes one line,
    `- <ISO time> | <decision> | <target> | <message first 120 chars, newlines → space>`, to
    `<stateDir>/journal.md`.
  - `tailEntries(stateDir, n = 50)` returns string[].
  - CLI: `node journal.mjs append --decision sent|opened|asked|status|reopen --target <name> --message <text>`;
    `node journal.mjs tail [--n 50]`.
- `start.mjs`:
  - `buildLaunch({ cfgDir, provider, paths, env })` (pure, for tests) returns `{ args, env, title, cwd }`.
  - `main()` does the I/O.
- Env contract of the coordinator process:
  - It is built from `cleanEnv()`, then the provider vars are added: `ANTHROPIC_BASE_URL`,
    `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` (both set to `provider.model`).
  - It also sets `MODEL_COORDINATOR=1` and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`.
  - `CLAUDE_CONFIG_DIR` is kept.

Settings object (`coordinatorSettings`):

```js
export const ALLOWED_COMMANDS = ({ skills, hooks }) => [
  `Bash(node ${hooks}/coord.mjs status:*)`,
  `Bash(node ${skills}/model-coordinator/journal.mjs:*)`,
  `Bash(node ${skills}/model-coordinator/open-session.mjs:*)`,
  `Bash(node ${skills}/handoff-launch/launch.mjs resume --closed:*)`,
  `Bash(node ${skills}/handoff-launch/launch.mjs resume --paused:*)`,
  `Bash(node ${skills}/handoff-launch/launch.mjs sessions:*)`,
];

export function coordinatorSettings({ paths, hooks = undefined }) {
  const state = paths.stateDir; // forward slashes, e.g. C:/Users/<u>/.claude/coordinator
  const abs = "//" + state.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()); // Claude Code absolute-path rule form
  return {
    ...(hooks ? { hooks } : {}),
    permissions: {
      defaultMode: "dontAsk",
      allow: ["ListAgents", "SendMessage", "Read", "Grep", "Glob",
        `Edit(${abs}/**)`, `Write(${abs}/**)`, ...ALLOWED_COMMANDS(paths)],
      deny: ["Agent", "Workflow", "PowerShell", "WebFetch", "WebSearch", "NotebookEdit"],
    },
  };
}
```

Launch args (`buildLaunch`):

```js
args = ["--settings", settingsFile, "--permission-mode", "dontAsk", "--append-system-prompt-file", routingFile,
        "--model", provider.model, "-n", title]
title = `${provider.displayName} Coordinator`
cwd = stateDir   // <CFG>/coordinator, created if missing
```

`main()`:
1. Resolve `cfgDir` (`CLAUDE_CONFIG_DIR` or `~/.claude`) and `stateDir = <cfgDir>/coordinator`, then `mkdir -p`.
2. Single instance. If `<stateDir>/coordinator.pid` holds `{pid, start}` and `procStart(pid)` (live.mjs:222)
   equals `start`, print `Coordinator already open (pid <pid>). Use that window.` and exit 0. Otherwise write the
   pid file for `process.pid`, and remove it on exit, SIGINT and SIGTERM.
3. Call `readProvider`. On error, print the message (it never contains the key) and exit 1.
4. Write the settings JSON to `<stateDir>/settings.generated.json`. Copy the routing prompt (Task 5) to
   `<stateDir>/routing.md` when it exists in the skill folder.
5. Set the console title with `process.stdout.write("\x1b]0;" + title + "\x07")`.
6. Run `spawnSync(claudeCli(), args, { stdio: "inherit", env, cwd: stateDir })` (live.mjs:108 `claudeCli`), then
   exit with its status.

`coordinator.cmd`:

```bat
@echo off
node "%USERPROFILE%\.claude\skills\model-coordinator\start.mjs" %*
```

When `CLAUDE_CONFIG_DIR` is set, the install step writes that path instead.

- [ ] **Step 1: Write the failing tests** (no network, no window):

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { readProvider } from "../provider.mjs";
import { coordinatorSettings, ALLOWED_COMMANDS } from "../settings.mjs";
import { appendEntry, tailEntries } from "../journal.mjs";
import { buildLaunch } from "../start.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mc-"));
const paths = { cfg: "C:/u/.claude", skills: "C:/u/.claude/skills", hooks: "C:/u/.claude/hooks", stateDir: "C:/u/.claude/coordinator" };

test("readProvider: missing file names the example, never the key", () => {
  const d = tmp(); fs.mkdirSync(path.join(d, "coordinator"));
  assert.throws(() => readProvider(d), /provider\.json missing/);
});
test("readProvider: reads key from keyFile", () => {
  const d = tmp(); fs.mkdirSync(path.join(d, "coordinator"));
  fs.writeFileSync(path.join(d, "k"), "sk-test\n");
  fs.writeFileSync(path.join(d, "coordinator", "provider.json"), JSON.stringify({ baseUrl: "https://x", model: "m", displayName: "Fake", keyFile: path.join(d, "k") }));
  assert.deepEqual(readProvider(d), { baseUrl: "https://x", model: "m", displayName: "Fake", key: "sk-test" });
});
test("settings: dontAsk, edits only in state dir, Agent denied", () => {
  const s = coordinatorSettings({ paths });
  assert.equal(s.permissions.defaultMode, "dontAsk");
  assert.ok(s.permissions.allow.includes("Edit(//c/u/.claude/coordinator/**)"));
  assert.ok(s.permissions.deny.includes("Agent"));
  assert.ok(!s.permissions.allow.some((r) => r === "Bash" || r === "Edit" || r === "Write"));
  assert.equal(ALLOWED_COMMANDS(paths).every((r) => r.startsWith("Bash(node C:/u/.claude/")), true);
});
test("journal: one line per entry, message clipped, newlines flattened", () => {
  const d = tmp();
  appendEntry(d, { message: "fix\nlogin " + "x".repeat(200), decision: "sent", target: "cw-batchB" });
  const t = tailEntries(d);
  assert.equal(t.length, 1);
  assert.match(t[0], /\| sent \| cw-batchB \| fix login x+$/);
  assert.ok(t[0].length < 200);
});
test("buildLaunch: provider env set, title from displayName, key not in args", () => {
  const r = buildLaunch({ cfgDir: "C:/u/.claude", provider: { baseUrl: "https://x", model: "m", displayName: "Fake", key: "sk-test" }, paths, env: { PATH: "p", HL_SESSION_ID: "z", ANTHROPIC_API_KEY: "old" } });
  assert.equal(r.title, "Fake Coordinator");
  assert.equal(r.env.ANTHROPIC_BASE_URL, "https://x");
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, "sk-test");
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(r.env.HL_SESSION_ID, undefined);
  assert.equal(r.env.MODEL_COORDINATOR, "1");
  assert.ok(!r.args.join(" ").includes("sk-test"));
  assert.deepEqual(r.args.slice(-2), ["-n", "Fake Coordinator"]);
});
```

For the goal-gate opt-out, add a case to the existing goal-gate tests (`claude/skills/handoff-launch/tests/lane-hooks.test.mjs`
exercises goal-gate). Running goal-gate with `MODEL_COORDINATOR=1` and a stop input that would otherwise nudge must
print no block.

- [ ] **Step 2: Run.** `node --test "claude/skills/model-coordinator/tests/*.test.mjs"`. Expected: FAIL (modules
  missing).
- [ ] **Step 3: Implement** the four modules, the shim and `provider.example.json`
  (`{"baseUrl":"https://api.deepseek.com/anthropic","model":"deepseek-chat","displayName":"DeepSeek","keyFile":"<CFG>/secrets/coordinator.key"}`).
  - `buildLaunch` takes `env` explicitly. It applies the same filter as `cleanEnv` (import `cleanEnv` and
    `PROVIDER_ENV` from `../handoff-launch/live.mjs`; if `cleanEnv` only reads `process.env`, filter the passed
    `env` with the same predicate) and then adds the provider vars.
  - Add the goal-gate opt-out.
- [ ] **Step 4: Run** the model-coordinator tests and the handoff-launch suite. Expected: all PASS.
- [ ] **Step 5: Commit** the files by name: `feat(model-coordinator): launcher, locked settings, journal, coordinator command`.

### Task 5: Routing prompt and open-session helper (R3, spec section 3)

**Files:**
- Create: `claude/skills/model-coordinator/open-session.mjs`
- Create: `claude/skills/model-coordinator/routing.md`
- Test: append to `claude/skills/model-coordinator/tests/coordinator.test.mjs`

**Interfaces:**
- `open-session.mjs`:
  - CLI: `node open-session.mjs --repo <path> --name <lane-name> --message <text> [--dry-run]`.
  - It writes `<stateDir>/briefs/<name>-<stamp>.md` with the content `# <name>\n\n<message>\n\nOpened by the model coordinator.`
  - It then runs `node <skills>/handoff-launch/launch.mjs --handoff <brief> --repo <repo> --name <name> --model sonnet --effort medium --mode window`
    under `launcherEnv()` (live.mjs:584), with `PROVIDER_ENV` keys removed again for safety.
  - It prints `opened <name>`, or under `--dry-run`, `would open <name>: <argv joined>`.
  - It exits non-zero with the launcher's last stderr line on failure.
  - Pure export: `briefArgs({ skills, brief, repo, name })`, which returns the argv array.
- `routing.md` is the appended system prompt. Exact text:

```md
You are the Model Coordinator. You route; you never do the work.

Each user message:
1. Get the picture: call ListAgents, and run `node <HOOKS>/coord.mjs status --json`.
2. A status question ("what's going on", "which sessions") -> answer from that picture in a short list. Also run
   `node <SKILLS>/model-coordinator/journal.mjs tail --n 20` if history helps.
3. "Restart / reopen the closed sessions" -> list the status rows whose state is closed_unfinished or paused, ask
   "Reopen these? (yes/no)", and on yes run `node <SKILLS>/handoff-launch/launch.mjs resume --closed --all` and
   `node <SKILLS>/handoff-launch/launch.mjs resume --paused --all`. Hand-opened sessions that are not in the status
   list: print `claude --resume <session id>` for the user instead.
4. Otherwise route. If exactly one live session clearly owns the topic (same project, its name or current goal
   matches), SendMessage it the user's message word for word. If none matches, run
   `node <SKILLS>/model-coordinator/open-session.mjs --repo <repo> --name <short-kebab-name> --message "<message>"`.
   If two or more could own it, or the project is unclear, ask ONE short question naming the options. Never guess.
5. After acting, reply with one line: `→ sent to <name>`, `→ opened <name>`, `→ reopened <n> sessions` or the
   question. Then run `node <SKILLS>/model-coordinator/journal.mjs append --decision <sent|opened|asked|status|reopen> --target <name|-> --message "<message>"`.
You never edit code, never run other commands, never start subagents. You may write Markdown notes only under the
coordinator folder.
```

`start.mjs` substitutes `<HOOKS>` and `<SKILLS>` with the forward-slash paths when it copies the file to
`<stateDir>/routing.md`. `open-session.mjs` takes the repo path from the status row (`repo`), or from the user's
message when a new project is named.

- [ ] **Step 1: Failing tests.**
  - `briefArgs` returns argv containing `--handoff`, `--model sonnet` and `--mode window`.
  - `--dry-run` prints `would open` and writes the brief file.
  - Run `open-session.mjs` with `ANTHROPIC_AUTH_TOKEN=secret` in its env and `--dry-run`, and assert the argv and
    the brief do not contain `secret`.
  - The routing file that `start.mjs` writes has no `<HOOKS>` or `<SKILLS>` left.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `open-session.mjs` and `routing.md`, and wire the substitution into `start.mjs`.
- [ ] **Step 4: Run** all model-coordinator and handoff-launch tests. Expected: PASS.
- [ ] **Step 5: Commit** the files by name: `feat(model-coordinator): routing prompt and open-session helper`.

### Task 6: Install docs and live verification (T2, T4, T6). Needs the user's provider and key.

**Files:**
- Modify: `INSTALL_PROMPT.md`
  - Copy `claude/skills/model-coordinator/` to `CONFIG/skills/model-coordinator/`.
  - Copy `coordinator.cmd` into a folder on the user PATH (create `%USERPROFILE%\bin` and add it to the user PATH
    if no such folder exists).
  - Copy `provider.example.json` to `CONFIG/coordinator/provider.json` for the user to fill.
  - Never write a key.
- Modify: `claude/skills/model-coordinator/README.md` (new, short). It covers setup (provider.json, key file),
  switching models and an OpenAI-only provider through a local LiteLLM proxy (`baseUrl` = proxy URL).

- [ ] **Step 1:** Write the docs. Commit them.
- [ ] **Step 2 (gated on the user's key):** deploy to `~/.claude` (back up the changed files first, as earlier
  batches did under `~/.claude/backups/`). Fill `provider.json` with the user's provider.
- [ ] **Step 3: Live T2.** In a coordinator window, ask it to edit a file in a repo, run `dir`, and start a subagent.
  All three must be refused. Ask it to append a journal note; that must succeed.
- [ ] **Step 4: Live T4.** Close and reopen the coordinator from a different folder, then ask "what's going on".
  The answer must match `node coord.mjs status`.
- [ ] **Step 5: Live T6.** Send one message meant for an idle session. Check that it arrives verbatim, that the
  journal has the line, and that a session opened through it shows no `ANTHROPIC_BASE_URL` (check it with
  `node -e "console.log(process.env.ANTHROPIC_BASE_URL)"` inside that session).
- [ ] **Step 6:** Type `coordinator` a second time while it is open. It must print "already open".
