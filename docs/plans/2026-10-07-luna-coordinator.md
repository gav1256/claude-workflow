# Luna Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `coordinator` command opens a terminal REPL. A strict-JSON model ("Luna", `gpt-6-luna`) reads each user
line and routes it. A deterministic Node dispatcher validates every decision and is the only part that acts: it
messages, creates and reports on Claude workers (handoff-launch) and Codex workers (dispatching-codex). It never edits
project files.

**Architecture:** There is a new skill folder `claude/skills/model-coordinator/`. Each user line goes through these
steps:

1. A deterministic pre-pass (`resolve.mjs`). When routing is obvious, no model is called.
2. Otherwise a compact context (`context.mjs`) goes to `provider.decide()`.
3. The strict validator (`schema.mjs`, `validate.mjs`) checks the decision.
4. The dispatcher (`dispatcher.mjs`) acts, with idempotency keys.

Claude workers reuse `launch.mjs --mode bg`, the registry and a new `status-lib.mjs`. Codex workers reuse
`codex-run.mjs` and its `lib/locks.mjs`, `lib/usage.mjs` and `lib/binary.mjs`. One write module (`store.mjs`) holds
the file-write lock. State lives in JSONL ledgers under `<CFG>/state/model-coordinator/`.

**Tech Stack:** Node 24 ESM (`.mjs`), zero npm dependencies, `node:test`, `node:net` named pipes, global `fetch`
(OpenAI Responses API), Windows `cmd` shim.

**Spec:** `docs/specs/2026-10-07-luna-coordinator-request.md` is the user's request. Its Testing list is binding.
`docs/specs/2026-10-07-luna-coordinator-architecture.md` is the design. Its "Resolutions" A-G override the sections
above them. The old plan `docs/plans/2026-10-07-model-coordinator.md` contributes Tasks 1-3 here, with corrections.
Its Tasks 4-6 are obsolete.

**Base:** branch `jev-coordinator` on the `stage2-loop-recovery` tip. All `path:line` anchors below were re-checked
on this tip on 2026-10-07.

**Suites:**

- handoff-launch: `timeout 1800 node --test "claude/skills/handoff-launch/tests/*.test.mjs"`
- Codex: `timeout 900 node --test "optional/codex/skills/dispatching-codex/tests/*.test.mjs"`
- model-coordinator (new): `timeout 900 node --test "claude/skills/model-coordinator/tests/*.test.mjs"`

## Global Constraints

- **Never execute model output.** `worker_instruction` is only ever passed as text to a worker (a message file, a
  brief, or a `--bg --resume` prompt). It is never a path, a command or a file write.
- **Luna has no tools.** The OpenAI request carries no `tools` or `tool_choice`. Luna returns one strict
  `CoordinatorDecision` per call. Any extra field fails validation (`additionalProperties: false`).
- **Luna may write only `coordinator_records.md`.** This is enforced in code by `store.mjs`, the one write module of
  the coordinator process. It checks a path allowlist and compares real paths. Model-derived content
  (`record_update`) reaches only `coordinator_records.md`, through a renderer that takes no path.
- **Public repo.** No secrets, personal paths, real emails or account names in committed files. Tests use
  `...@example.com`. Paths are built at runtime from `os.homedir()` or `CLAUDE_CONFIG_DIR`.
- **Staging.** Stage files by name. Never `git add -A`.
- **Batch-B files are off limits (Resolution F).** Do not edit `claude/hooks/coord.mjs`, `recover*.mjs`,
  `pause-io.mjs`, `power.mjs`, `claude/skills/handoff-launch/SKILL.md`, `coordinator.md` or
  `claude/skills/handoff-launch/tests/helpers.mjs`. New test helpers go in new files. `live.mjs` and `launch.mjs`
  may be edited.
- **No paid OpenAI spend by default.** The default config is `provider: "none"`. `OpenAILunaProvider` refuses to
  start without a key, without `provider: "openai"`, or without a complete price table. The Codex `paid_api`
  fallback is not supported in V1: config validation refuses `codex.fallback: "paid_api"` (see Deferred).
- **Children never inherit credentials (Resolution E).** Every child the coordinator starts gets an env without
  `OPENAI_API_KEY`, `CODEX_API_KEY` or `CODEX_RUN_ENV_ALLOW`, matched case-insensitively. `env.mjs` (Task 6) has
  two builders:
  - `launchEnv()` is for `launch.mjs` and `launch.mjs resume --closed`. It is `launcherEnv()` (`live.mjs:584`): it
    keeps `HL_*` (`HL_REGISTRY_DIR`, `HL_NO_SPAWN`, `HL_FAKE_CLAUDE` and `HL_AGENTS_JSON` must reach the launcher in
    tests) and drops `HL_SESSION_ID` and `CLAUDE_CODE_SESSION_ID`. It also drops the three credential names.
    `launch.mjs` itself strips `HL_*` and `CLAUDE*` from the Claude session it starts (`cleanEnv`/`windowScript`).
  - `childEnv()` is for `codex-run.mjs` and the `claude --resume --bg` wake. It is the strict strip: the three
    names, `HL_*`, `CLAUDE*` except `CLAUDE_CONFIG_DIR`, `AI_AGENT` and `CLAUDE_CODE_SESSION_ID`.

  V1 has no paid-API exception: see Deferred.
- **Worker completion summaries use the spec's compact format:** `{session_id, provider, status, summary, changes[],
  blockers[], needs_user, files_changed[]}`. Full transcripts never reach Luna.
- **Tests start nothing real.** No test opens a window or makes a real API, Codex or `claude` call. They use
  `HL_NO_SPAWN=1`, `HL_FAKE_CLAUDE=1`, fake `claude agents --json` (`HL_AGENTS_JSON`), a fake Codex CLI, a fake
  `codex-run`, a fake `fetch`, and an injectable `claude` runner for `--bg --resume` and `claude stop`.
- **Naming.** "coordinator" already names the tick system (`state/coord`). New identifiers say `model-coordinator`
  or `mc`. The user-facing command is `coordinator`. The process marker is `HL_MODEL_COORDINATOR=1`.
- **Claude workers are opus/high by default** (config). `launch.mjs` refuses sonnet and haiku sessions
  (`launch.mjs:711-712`). Config validation refuses them too.
- **Concurrency.** `max_parallel_codex_jobs` defaults to 2 (config `codex.max_parallel_jobs`). There are 3
  machine-wide Codex slots, shared with every Claude lane's Codex runs (`lib/locks.mjs:57`).
- **Cost limits.** Monthly soft limit $7 and hard limit $10, both configurable. At the hard limit:
  - no provider calls;
  - shortcuts, status and running workers keep working;
  - every reply shows the condition.
- **Design default: a small company.** One machine, one user, JSONL ledgers. The large-org variant (a
  multi-user service with a DB-backed ledger and a secrets manager) is out of scope.

## Review Focus

These five conditions are not exercised by the spec's list but are the most likely to bite. Each line names the task
that pins it with a test.

1. **A very long or odd user line** (10k characters, Hebrew/RTL text, embedded backticks, a pasted stack trace).
   Expected: the context stays within the token budget, the message is truncated in the context with a marker, the
   validator rejects over-long model fields, and a deterministic `/to` delivers the full text. Pinned in Task 7
   (`context: a 10k message stays under max_tokens`) and Task 11 (`/to with 10k text delivers it whole`).
2. **`claude agents --json` failing or the registry missing.** Expected: workers show `unknown`, status still
   answers, and nothing crashes. Pinned in Task 9 (`status: agents probe failure gives unknown, not a throw`).
3. **OpenAI answers with something that is not a decision:** a refusal, `status: "incomplete"`, non-JSON text, or
   HTTP 400. Expected: one re-ask for a shape error, then a `clarify` reply, and no dispatch. Pinned in Task 12
   (`openai: refusal / incomplete / non-JSON raise ProviderError`) and Task 11 (`invalid twice -> clarify, nothing
   dispatched`).
4. **The month rolls over.** Expected: last month's spend does not count toward this month's limits. Pinned in Task 12
   (`cost: previous month's usage does not count`).
5. **The coordinator is killed during a Codex run and restarted.** Expected: the run is recovered from the out file
   or `runs.jsonl`, the own-cap reservation is rebuilt, and nothing is spawned twice. Pinned in Task 10b
   (`reconcile: a finished run is persisted, a live one is watched, an unknown one keeps its worktree`) and Task 10a
   (`start: a known request_id returns the existing attempt, no second spawn`).

## Open assumptions (verify where marked; none blocks the mock-provider build)

- **A1. `gpt-6-luna` prices are unknown.** Config has
  `pricing["gpt-6-luna"] = {input_per_mtok, cached_input_per_mtok, output_per_mtok}`, null by default. Without them
  the provider fails closed (Task 12). The user supplies the values with the key (Task 15).
- **A2. Responses API details.**
  - Verified by the plan reviewer against the official guide: strict mode accepts `["string","null"]` types, `enum`
    containing `null`, and `anyOf` when it is not at the schema root. So `DECISION_SCHEMA` stands as written.
    Fallback only if a live call still rejects it: flatten `record_update` to a non-null object with nullable
    fields (one-line change in `schema.mjs`).
  - `reasoning.effort: "none"` depends on the model: the guide says Astra and Sol reject `none` with HTTP 400.
    Config `openai.reasoning_effort` defaults to `"none"`, and `null` omits the `reasoning` field. A 400 whose body
    mentions `reasoning` is reported in the reply, naming this knob (Task 12). Whether `gpt-6-luna` accepts `none`
    is verified live in Task 15.
- **A3. `codex login status` output is assumed, not verified.** Assumed strings are "Logged in using ChatGPT",
  "Logged in using an API key" and "Not logged in". The classifier maps any unmatched output to `unknown`, which
  counts as unavailable (fail closed). Task 8 step 0 records the real wording once, by hand and outside the tests,
  with any account detail redacted.
- **A4. The copy-detection signal of `claude --resume <sid> --bg` is not documented beyond the `note:` line.**
  Detection uses either signal:
  - a `note:` line mentioning a copy or fork;
  - a new `claude agents --json` entry whose `sessionId` differs from the worker's.

  Verified live in Task 15.
- **A5. The `paid_api` fallback is deferred to V2** (see Deferred). As designed it cannot work: the gate requires a
  `chatgpt` login, and `codex-run.mjs:411-419` blocks on quota whatever key is present, so the fallback would loop on
  `blocked`.
- **A6. Deviations from the architecture note.** Each is listed so the plan reviewer can overrule it.
  - (a) Claude workers report state in a fenced ```` ```coordinator-state ```` JSON block at the end of each turn.
    The coordinator reads it from the transcript tail. This replaces `<STATE>/workers/<id>.json`, because a
    background session writing outside its worktree may hit a permission prompt nobody can answer.
  - (b) Message folders are keyed by lane name (`sha1(name)`), not registry id, so a restarted lane still gets its
    pending messages. The hook maps `HL_SESSION_ID` to the name through the registry.
  - (c) Only the three names from Resolution E are added to the child strip set. The coordinator is a plain Node
    process, so the old plan's `ANTHROPIC_*` strip has no source.
  - (d) A Codex worker owns its whole dedicated worktree (`Files you own: **`). Isolation is the worktree itself.

## Deferred

- **Paid-API Codex fallback (`codex.fallback: "paid_api"`).** Deferred to V2. Owner: the next coordinator wave.
  - What it needs: a `codex-run.mjs` quota opt-out flag for API-key runs, and a paid gate mode in
    `codex-resources.mjs`. Paid mode skips the `chatgpt` login and subscription-quota steps, keeps the own cap, slots
    and worktree steps, and passes `CODEX_API_KEY` to that one worker.
  - That change gets a Codex review.
  - V1 refuses the setting at config load, and the credential strip stays as specified.

---

### Task 1: Children never inherit OpenAI/Codex credentials (Resolution E)

Implementer: sonnet `worker-medium`. Reviewer: opus `worker-high`.

**Files:**
- Modify: `claude/skills/handoff-launch/live.mjs:591-594` (`cleanEnv`) and `:600` (the `windowScript` strip line)
- Test: `claude/skills/handoff-launch/tests/env-strip.test.mjs` (new)

**Interfaces:**
- Produces: `export const SECRET_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_RUN_ENV_ALLOW"]` in live.mjs.
  - `cleanEnv()` drops these names case-insensitively.
  - `windowScript()` removes them inside the window.

**MUST:**
- M1. `cleanEnv()` drops the three names in any letter case and keeps `PATH`/`Path`.
- M2. The PowerShell strip line removes them. This is proven by running that line in a hidden
  `powershell -NoProfile -NonInteractive` child and listing the remaining env names.
- M3. The existing strip behaviour is unchanged: `CLAUDE*` except `CLAUDE_CONFIG_DIR`, `AI_AGENT`, and `HL_*`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as V from "../live.mjs";

const NAMES = ["Openai_Api_Key", "codex_api_key", "CODEX_RUN_ENV_ALLOW"]; // mixed case on purpose
test("cleanEnv drops the credential names in any case", () => {
  for (const k of NAMES) process.env[k] = "x";
  process.env.HL_MODEL_COORDINATOR = "1";
  try {
    const env = V.cleanEnv();
    for (const k of Object.keys(env)) assert.ok(!V.SECRET_ENV.some((n) => n.toLowerCase() === k.toLowerCase()), k);
    assert.equal(env.HL_MODEL_COORDINATOR, undefined);
    assert.ok("PATH" in env || "Path" in env);
  } finally { for (const k of [...NAMES, "HL_MODEL_COORDINATOR"]) delete process.env[k]; }
});
test("the windowScript strip line removes them (run hidden)", () => {
  const ps = V.windowScript({ pidFile: "p", name: "n", workDir: ".", banner: "b", regId: "r", claudeLine: "x" });
  const strip = ps.split("\r\n").find((l) => l.startsWith("Get-ChildItem env:"));
  const env = { ...process.env, OPENAI_API_KEY: "x", Codex_Api_Key: "x", CODEX_RUN_ENV_ALLOW: "x", KEEP_ME: "1" };
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${strip}; Get-ChildItem env: | % Name`],
    { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
  const names = r.stdout.split(/\r?\n/).map((s) => s.trim().toLowerCase());
  for (const n of V.SECRET_ENV) assert.ok(!names.includes(n.toLowerCase()), n);
  assert.ok(names.includes("keep_me"));
});
```

- [ ] **Step 2: Run** `node --test claude/skills/handoff-launch/tests/env-strip.test.mjs`. Expected: FAIL
  (`SECRET_ENV` undefined; the keys survive).
- [ ] **Step 3: Implement.**
  - Add `SECRET_ENV` above `cleanEnv`.
  - Add `&& !SECRET_ENV.some((n) => n.toLowerCase() === k.toLowerCase())` to the `cleanEnv` filter.
  - In the `:600` `Where-Object`, append
    `-or @('OPENAI_API_KEY','CODEX_API_KEY','CODEX_RUN_ENV_ALLOW') -contains $_.Name`. `-contains` is
    case-insensitive.
- [ ] **Step 4: Run** the new test, then the handoff-launch suite. Expected: all PASS.
- [ ] **Step 5: Commit** `live.mjs` and `env-strip.test.mjs` by name:
  `feat(launch): never pass OpenAI/Codex credentials to child sessions`.

### Task 2: Lane status classifier `status-lib.mjs`

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/handoff-launch/status-lib.mjs`
- Test: `claude/skills/handoff-launch/tests/lane-status.test.mjs` (new; `tests/status.test.mjs` already exists)

Resolution F applies: no `coord.mjs status` subcommand. The coordinator and `launch.mjs` import this module directly.

**Interfaces:**
- Consumes:
  - `pausedLineOf(lines, e)` (`pause-lib.mjs:49`). It counts only `{paused: e.id, source: <string>}` lines at or
    after `e.launched_at`.
  - `lanePauseKey(e)` (`pause-lib.mjs:84`), which returns `repo|group|name`.
  - `readRegistry()` (`live.mjs:58`), which returns `{lines, entries, closed:Set, stops, merges}`.
  - `liveness(e, reg)` (`live.mjs:310`); `primeLiveness(entries)` (`live.mjs:304`); `goalOf(sid)` (`live.mjs:457`).
  - `parseGoal(text)` (`recover-lib.mjs:629`), which returns `{goal, items, done, open, blocked}`.
- Produces:
  - `classify(e, {lines, closedIds, gone, doneMarker, goal})` returns `{state, reason}`.
    - `state` is one of `open | unknown | finished | paused | closed_unfinished`.
  - `laneStatus(reg, {gone, readGoal, markerExists})` returns one row per lane (newest entry per `lanePauseKey`).
    - A row is `{id, name, repo, group, branch, mode, state, reason, goal, launched_at, session_id, bg_id,
      worktree}`.
  - `closedUnfinished(rows)`.
  - `liveLaneStatus()`: the impure wrapper. It reads the registry, primes liveness and passes the real probes:
    - `gone = e => liveness(e, reg).state`;
    - `readGoal` = parseGoal of `goalOf(e.session_id)`;
    - `markerExists` = `e.done_marker && fs.existsSync(e.done_marker)`.

Classification order (first match wins). Every real close writes `{kill_intent, kind: "close"}` first
(`live.mjs:500`), so a `kill_intent` alone never means finished.

1. Liveness `running` gives `open` with reason "running".
2. Liveness `unknown` gives `unknown` with reason "liveness unknown". It is never offered for a reopen.
3. The done marker exists, or the goal has items with `open === 0 && blocked === 0`, gives `finished` ("done marker"
   or "goal complete").
4. The newest `{closed}` line for `e.id` has `pause === true`, or `pausedLineOf` is truthy, gives `paused`.
5. A newest `{closed}` why matching `/^claude exited/` gives `closed_unfinished` ("claude exited"). A `{dead_start:
   e.id}` line (`recover.mjs:940`) gives `closed_unfinished` ("failed to start").
6. `e.id` not in `closedIds` gives `closed_unfinished` ("crashed or window closed").
7. Anything else gives `finished` ("closed: <why>").

**MUST:**
- M1. Each of the 7 rules has a test with a registry fragment in the real line shapes.
- M2. A paused line without `source` (a pre-B2 hand line) does not make a lane `paused`.
- M3. `laneStatus` keeps only the newest entry per lane.
- M4. `liveLaneStatus()` against a sandbox registry lists a lane launched with `launchLane()`.

- [ ] **Step 1: Write the failing test.** Take the old plan's `classify` tests (old plan lines 165-216), with these
  corrections:
  - Use ISO `at` and `launched_at` values (`"2026-10-07T00:00:00.000Z"` launch, later lines `T01:...`).
  - The paused-line test uses `{ paused: x.id, source: "pace", reason: "usage", at: "2026-10-07T01:00:00.000Z" }`.
  - Add a test that a `{paused}` line without `source` is not paused (M2).
  - Add a `dead_start` test.
  - M4:

```js
import { sandbox, launchLane } from "./helpers.mjs";
test("liveLaneStatus lists a launched lane (HL_NO_SPAWN: gone, crashed or window closed)", async () => {
  const sb = sandbox({});
  try {
    launchLane(sb, "g1", "lane-a");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { liveLaneStatus } from ${JSON.stringify(pathToFileURL(STATUS_LIB).href)}; console.log(JSON.stringify(liveLaneStatus()))`],
      { env: sb.env, encoding: "utf8", timeout: 60000 });
    const rows = JSON.parse(r.stdout);
    const row = rows.find((x) => x.name === "lane-a");
    assert.equal(row.state, "closed_unfinished");
    assert.equal(row.id, sb.registry().find((x) => x.name === "lane-a" && x.launched_at).id);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: Run** `node --test claude/skills/handoff-launch/tests/lane-status.test.mjs`. Expected: FAIL (module
  missing).
- [ ] **Step 3: Implement.** Use the old plan's `classify`/`laneStatus`/`closedUnfinished` code (old plan lines
  224-258). Add the extra row fields `mode, bg_id, worktree` and `liveLaneStatus()`. The child process in M4 is
  needed because `live.mjs` reads `HL_REGISTRY_DIR` at import.
- [ ] **Step 4: Run** the new test and the handoff-launch suite. Expected: PASS.
- [ ] **Step 5: Commit** `status-lib.mjs` and `lane-status.test.mjs`: `feat(launch): lane status classifier`.

### Task 3: `launch.mjs resume --closed`

Implementer: sonnet `worker-medium`. Reviewer: opus `worker-high`.

**Files:**
- Modify: `claude/skills/handoff-launch/launch.mjs`:
  - the new branch goes after the `--paused` branch, which ends at `:575`, and before `if (sub === "resume")` at
    `:576` (that branch exits 2 without `--group`);
  - `KNOWN_FLAGS` `:98-101` gains `"closed"`;
  - add a usage line near `:15`.
- Test: `claude/skills/handoff-launch/tests/resume-closed.test.mjs` (new)

**Interfaces:**
- Consumes:
  - `liveLaneStatus`, `closedUnfinished` (Task 2);
  - `freshLaunchArgs(e, {model, effort, resumeNote, supersedes})` (`recover-lib.mjs:300`), which keeps
    `--mode e.mode` (bg stays bg);
  - `acquireTickLock`/`releaseTickLock` (imported at `launch.mjs:84`);
  - `launcherEnv()` (`live.mjs:584`).
- Produces: `node launch.mjs resume --closed (--all | --id <registry id>) [--dry-run]`.
  - Each lane prints `reopen <name> (<reason>)`, or `would reopen ...` with `--dry-run`.
  - Exit 0; exit 1 if any relaunch failed; exit 3 on a session cap (same lines as `--paused`, `:571`).

**MUST:**
- M1. `--dry-run` lists crashed lanes only. It never lists done (idle close) or paused lanes.
- M2. Without `--all`/`--id` it exits 2 with a usage line.
- M3. Without `--dry-run`, under `HL_NO_SPAWN` it records a new launch line whose `supersedes` is the old id.
- M4. A lane with a `{starting}` line under 5 min old is skipped (the same guard as `pause-lib.mjs:95`).
- M5. `provenance.test.mjs` stays green (`KNOWN_FLAGS` matches the code).

- [ ] **Step 1: Write the failing test.** Use the old plan's test (old plan lines 322-337) with ids from
  `sb.registry().find((x) => x.name === n && x.launched_at).id` (`sb.registry()` is a plain array,
  `helpers.mjs:67`), plus these tests:

```js
test("resume --closed without a selector exits 2", () => {
  const sb = sandbox({});
  try { const r = sb.run("resume", "--closed"); assert.equal(r.code, 2); assert.match(r.err, /resume --closed needs --all or --id/); }
  finally { sb.cleanup(); }
});
test("resume --closed --id relaunches with supersedes", () => {
  const sb = sandbox({});
  try {
    launchLane(sb, "g1", "crashed-lane");
    const old = sb.registry().find((x) => x.name === "crashed-lane" && x.launched_at).id;
    const r = sb.run("resume", "--closed", "--id", old);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /reopen crashed-lane \(crashed or window closed\)/);
    assert.ok(sb.registry().some((x) => x.launched_at && x.supersedes === old));
  } finally { sb.cleanup(); }
});
```

  For M4, append `{starting: "x", name: "crashed-lane", group: "g1", at: <now ISO>}` and assert the output says
  `skipped crashed-lane (a launch is in flight)`.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.** Mirror the `--paused` frame (`:536-575`):
  - take the tick lock;
  - `rows = closedUnfinished(liveLaneStatus())`, filtered by `--id`;
  - apply the starting guard;
  - for each row:
    - find the entry;
    - spawn `launch.mjs` with `freshLaunchArgs(e, { model: e.model || "opus", effort: e.effort || "high",
      resumeNote: "reopened after it closed unfinished (<reason>)", supersedes: e.id })` under `launcherEnv()`;
    - read the cap with `capRefusal(...)`;
  - release the lock.

  No `pauseForNow` gate: the user asked explicitly.
- [ ] **Step 4: Run** the handoff-launch suite. Expected: PASS, including `provenance.test.mjs`.
- [ ] **Step 5: Commit** `launch.mjs` and `resume-closed.test.mjs`:
  `feat(launch): resume --closed reopens lanes that closed unfinished`.

### Task 4: t10 Codex fixes needed by the resource manager (Resolution G)

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high` + **Codex review**.

**Files:**
- Modify: `optional/codex/skills/dispatching-codex/lib/usage.mjs:107-126` (`latestReading`) and `:133-156`
  (`quotaDecision`)
- Modify: `optional/codex/skills/dispatching-codex/lib/locks.mjs:57-67` (`busySlots`) and `:300-321`
  (`acquireSlot`)
- Modify tests: `optional/codex/skills/dispatching-codex/tests/usage.test.mjs:137-138` (the existing assertion that a
  99 % reading without a reset runs changes) and `tests/locks.test.mjs` (append)

The notes file is `~/.claude/experiments/2026-10-02-parallel-sessions/codex-dual-gen2/t10-review-notes.md`. It is
not in the repo. The three in-scope items, quoted from its "M items" line (line 14):

- "busySlots spurious slots-full";
- "latestReading tree walk (prune by date folders)";
- "week_pct without week_resets_at runs at any pct".

Out of scope: everything else in that file. Those items stay with their recorded owner (the post-deploy Codex wave).

**Interfaces:**
- Produces:
  - `quotaDecision` returns `{action: "block", reason: "codex-quota-unknown-reset", notes}` when either:
    - a weekly reading has `week_resets_at === null` and effective week pct is 95 or more; or
    - `rate_limit_reached_type` is set and no reset is known at all (both resets null).
  - A past reset still counts 0 (unchanged).
  - `latestReading(now)` reads only the UTC day folders `today .. today-8` (9 folders) under
    `CODEX_HOME/sessions/YYYY/MM/DD`. It keeps the 8-day mtime filter and the `LAST_USAGE` fallback.
  - `busySlots()` re-probes a taken slot once after 150 ms before counting it busy.
  - `acquireSlot()`: when every slot was taken (none quarantined), it rescans up to 2 more times, 150 ms apart,
    before `{busy: true}`.

**MUST:**
- M1. A 99 % weekly reading with a null reset blocks with `codex-quota-unknown-reset`. 50 % with a null reset runs
  with the note `codex-quota-unknown`.
- M2. A reached type with both resets null blocks with `codex-quota-unknown-reset`. A reached type with a past reset
  still runs (`usage.test.mjs:167-168` stays).
- M3. A rollout in a folder dated 30 days back, with a fresh mtime and a newer event, is not read. Today's folder is
  read.
- M4. A slot held for 50 ms by another process (a child that listens on the pipe, prints `ready`, closes after 50 ms)
  is not counted by `busySlots()`. A slot held for the whole test is counted.
- M5. `acquireSlot()` succeeds when slot-3 is released 50 ms after the call starts, with slots 1-2 held. It returns
  `{busy: true}` when all 3 stay held.
- M6. The whole Codex suite passes.

- [ ] **Step 1: Write the failing tests.** In `usage.test.mjs` replace line 138 with
  `assert.deepEqual(dec(nullReset), { action: "block", reason: "codex-quota-unknown-reset", notes: ["codex-quota-unknown"] })`,
  then add:

```js
test("quotaDecision: no reset at all -> unknown-reset block only at high pct or a reached type", () => {
  const low = { ts: NOW, rl: { primary: { used_percent: 50, window_minutes: 10080, resets_at: null }, secondary: null } };
  assert.deepEqual(dec(low), { action: "run", notes: ["codex-quota-unknown"] });
  const reached = { ts: NOW, rl: { primary: { used_percent: 10, window_minutes: 10080, resets_at: null }, secondary: null, rate_limit_reached_type: "primary" } };
  assert.equal(dec(reached).reason, "codex-quota-unknown-reset");
});
test("latestReading: only the last 9 UTC day folders are walked", () => {
  putRollout("2026-09-06", "t-old", "rollout-both.jsonl"); // fresh mtime, newest event
  assert.equal(U.latestReading(NOW), null);
  putRollout("2026-10-06", "t-new", "rollout-weekly.jsonl");
  assert.equal(U.latestReading(NOW).ts, Date.parse("2026-10-06T09:02:00.000Z"));
});
```

  In `locks.test.mjs`, add a `holdPipe(name, ms)` helper. It spawns
  `node -e "<listen on \\\\.\\pipe\\<prefix><name>, print ready, close after ms>"` with `windowsHide`, the same
  `CODEX_RUN_PIPE_PREFIX`, and resolves on `ready`. Then:

```js
test("busySlots: a probe-length hold is not counted; a real hold is", async () => {
  const short = await holdPipe("slot-2", 50), long = await holdPipe("slot-1", 5000);
  assert.equal(await L.busySlots(), 1);
  long.kill(); await short.done;
});
test("acquireSlot: a slot freed during the scan is taken, not slots-full", async () => {
  const a = await holdPipe("slot-1", 5000), b = await holdPipe("slot-2", 5000), c = await holdPipe("slot-3", 50);
  const s = await L.acquireSlot({});
  assert.equal(s.n, 3); await L.releasePipe(s.server);
  a.kill(); b.kill(); await c.done;
});
```

- [ ] **Step 2: Run** `timeout 900 node --test optional/codex/skills/dispatching-codex/tests/usage.test.mjs
  optional/codex/skills/dispatching-codex/tests/locks.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - **`quotaDecision`.** In the `mw.week_resets_at === null` branch, compute
    `eff = (mw.week_pct ?? 0) + 2 * busySlots`. If `rl.rate_limit_reached_type && mw.resets_at === null`, or
    `mw.week_pct !== null && eff >= 95`, return the block. Otherwise run with the unknown note.
  - **`latestReading`.** Replace the recursive `listRollouts(sessions)` with a loop over
    `for (let d = 0; d <= 8; d++) dayDir(t - d * DAY_MS)`, reading only that folder's `rollout-*.jsonl` (no
    recursion).
  - **`busySlots`.** When `acquirePipe` returns null, `await sleep(150)` and try once more before `n++`.
  - **`acquireSlot`.** Wrap the scan in `for (let pass = 0; pass < 3; pass++)`. Break with `{busy: true,
    quarantined}` if any slot was quarantined or this is the last pass. Otherwise sleep 150 ms.
- [ ] **Step 4: Run** the full Codex suite (M6). Expected: PASS. If `locks.test.mjs:408` or `:666` flake (known,
  `t10-review-notes.md:9,25`), re-run that file alone and report both outputs.
- [ ] **Step 5: Commit** `usage.mjs`, `locks.mjs`, `usage.test.mjs` and `locks.test.mjs`:
  `fix(codex): unknown-reset quota blocks, pruned rollout walk, no spurious slots-full`.

### Task 5: Decision schema, strict validator, provider interface, mock provider

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/schema.mjs`, `validate.mjs`, `provider.mjs`
- Test: `claude/skills/model-coordinator/tests/validate.test.mjs`, `tests/provider.test.mjs`

**Interfaces:**
- Produces from `schema.mjs`:
  - `ACTIONS`, `PROVIDERS`, `LIMITS`, `LABEL_RE`, `ALIAS_RE`, `DECISION_SCHEMA`;
  - `emptyDecision(partial)`, which fills every field with its null or empty default;
  - `validateShape(d)`, which returns `{ok, errors: [{code, field, detail?}]}`.
- Produces from `validate.mjs`:
  - `validateDecision(d, {workers})`, which returns `{ok, errors}`;
  - `lowConfidence(d, min)`;
  - `MESSAGEABLE`, `FINISHED` (status sets).
- Produces from `provider.mjs`:
  - the interface: `decide(input: CoordinatorInput): Promise<CoordinatorDecision>`;
  - `class ProviderError extends Error {constructor(code, message, {retryable})}`;
  - `class MockCoordinatorProvider` with constructor `(script)`. `script` is an array of decisions or functions
    `input => decision`, or one function used for every call. It has `calls` (the inputs received), and
    `decide(input)`, which throws `ProviderError("mock-exhausted")` when the script runs out;
  - `class NullProvider`, which always throws `ProviderError("no-provider", "Luna is not configured ...")`.
- `WorkerSummary` (used from Task 7 on):
  `{id, provider, label, aliases, status, objective, current_task, last_result, blockers}`. Status is one of
  `starting | running | idle | waiting_for_user | queued | blocked | failed | unknown | finished | dead`.

**Full code (subtle).** `schema.mjs`:

```js
export const ACTIONS = ["respond", "message_session", "message_multiple", "create_session", "request_status", "clarify"];
export const PROVIDERS = ["claude", "codex"];
export const LIMITS = { reply: 2000, worker_instruction: 4000, label: 32, objective: 1000, clarification: 500, targets: 8,
  aliases: 8, session_id: 48, note: 300 };
export const LABEL_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const ALIAS_RE = /^[a-z][a-z0-9 -]{0,38}[a-z0-9]$/;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const nstr = { type: ["string", "null"] };
export const DECISION_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["action", "reply", "target_session_ids", "worker_instruction", "new_session", "confidence", "clarification", "record_update"],
  properties: {
    action: { type: "string", enum: ACTIONS },
    reply: { type: "string" },
    target_session_ids: { type: "array", items: { type: "string" } },
    worker_instruction: nstr,
    new_session: { type: "object", additionalProperties: false, required: ["needed", "provider", "label", "objective"],
      properties: { needed: { type: "boolean" }, provider: { type: ["string", "null"], enum: ["claude", "codex", null] }, label: nstr, objective: nstr } },
    confidence: { type: "number" },
    clarification: nstr,
    record_update: { anyOf: [{ type: "object", additionalProperties: false, required: ["aliases", "focus", "note"], properties: {
      aliases: { type: "array", items: { type: "object", additionalProperties: false, required: ["session_id", "alias"],
        properties: { session_id: { type: "string" }, alias: { type: "string" } } } },
      focus: nstr, note: nstr } }, { type: "null" }] },
  },
};
export const emptyDecision = (p = {}) => ({ action: "respond", reply: "", target_session_ids: [], worker_instruction: null,
  new_session: { needed: false, provider: null, label: null, objective: null }, confidence: 1, clarification: null, record_update: null,
  ...p, new_session: { needed: false, provider: null, label: null, objective: null, ...(p.new_session ?? {}) } });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function exactKeys(o, keys, at, errs) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push({ code: "unknown-field", field: at + k });
  for (const k of keys) if (!Object.hasOwn(o, k)) errs.push({ code: "missing-field", field: at + k });
}
function text(v, field, max, errs, { nullable = false, nonEmpty = false } = {}) {
  if (v === null && nullable) return;
  if (typeof v !== "string") return void errs.push({ code: "type", field });
  if (v.length > max) errs.push({ code: "too-long", field, detail: `${v.length} > ${max}` });
  if (CTRL.test(v)) errs.push({ code: "control-char", field });
  if (nonEmpty && !v.trim()) errs.push({ code: "empty", field });
}
export function validateShape(d) {
  const errs = [];
  if (!isObj(d)) return { ok: false, errors: [{ code: "type", field: "$" }] };
  exactKeys(d, DECISION_SCHEMA.required, "", errs);
  if (!ACTIONS.includes(d.action)) errs.push({ code: "enum", field: "action" });
  text(d.reply, "reply", LIMITS.reply, errs);
  const t = d.target_session_ids;
  if (!Array.isArray(t) || !t.every((s) => typeof s === "string" && s.length <= LIMITS.session_id)) errs.push({ code: "type", field: "target_session_ids" });
  else if (t.length > LIMITS.targets) errs.push({ code: "too-many", field: "target_session_ids" });
  else if (new Set(t).size !== t.length) errs.push({ code: "duplicate", field: "target_session_ids" });
  text(d.worker_instruction, "worker_instruction", LIMITS.worker_instruction, errs, { nullable: true });
  const ns = d.new_session;
  if (!isObj(ns)) errs.push({ code: "type", field: "new_session" });
  else {
    exactKeys(ns, ["needed", "provider", "label", "objective"], "new_session.", errs);
    if (typeof ns.needed !== "boolean") errs.push({ code: "type", field: "new_session.needed" });
    if (ns.provider !== null && !PROVIDERS.includes(ns.provider)) errs.push({ code: "enum", field: "new_session.provider" });
    text(ns.label, "new_session.label", LIMITS.label, errs, { nullable: true });
    if (typeof ns.label === "string" && !LABEL_RE.test(ns.label)) errs.push({ code: "pattern", field: "new_session.label" });
    text(ns.objective, "new_session.objective", LIMITS.objective, errs, { nullable: true });
  }
  if (typeof d.confidence !== "number" || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) errs.push({ code: "range", field: "confidence" });
  text(d.clarification, "clarification", LIMITS.clarification, errs, { nullable: true });
  const ru = d.record_update;
  if (ru !== null && Object.hasOwn(d, "record_update")) {
    if (!isObj(ru)) errs.push({ code: "type", field: "record_update" });
    else {
      exactKeys(ru, ["aliases", "focus", "note"], "record_update.", errs);
      if (!Array.isArray(ru.aliases) || ru.aliases.length > LIMITS.aliases) errs.push({ code: "type", field: "record_update.aliases" });
      else ru.aliases.forEach((a, i) => {
        const at = `record_update.aliases.${i}`;
        if (!isObj(a)) return void errs.push({ code: "type", field: at });
        exactKeys(a, ["session_id", "alias"], `${at}.`, errs);
        text(a.session_id, `${at}.session_id`, LIMITS.session_id, errs, { nonEmpty: true });
        if (typeof a.alias !== "string" || !ALIAS_RE.test(a.alias)) errs.push({ code: "pattern", field: `${at}.alias` });
      });
      text(ru.focus, "record_update.focus", LIMITS.session_id, errs, { nullable: true });
      text(ru.note, "record_update.note", LIMITS.note, errs, { nullable: true });
    }
  }
  return { ok: errs.length === 0, errors: errs };
}
```

`validate.mjs`:

```js
import { validateShape } from "./schema.mjs";
export const FINISHED = new Set(["finished", "dead"]);
export const MESSAGEABLE = new Set(["starting", "running", "idle", "waiting_for_user", "queued", "blocked", "failed", "unknown"]);
const DISPATCHING = new Set(["message_session", "message_multiple", "create_session"]);
export const lowConfidence = (d, min) => DISPATCHING.has(d.action) && d.confidence < min;

export function validateDecision(d, { workers }) {
  const shape = validateShape(d);
  if (!shape.ok) return shape;
  const errs = [], byId = new Map(workers.map((w) => [w.id, w])), t = d.target_session_ids, ns = d.new_session;
  const need = (ok, code, field, detail) => { if (!ok) errs.push({ code, field, ...(detail !== undefined ? { detail } : {}) }); };
  const messageable = (id, i) => {
    const w = byId.get(id), field = `target_session_ids.${i}`;
    if (!w) return need(false, "unknown-target", field, id);
    need(MESSAGEABLE.has(w.status), "target-not-messageable", field, `${id} is ${w.status}`);
  };
  const noTargets = () => need(t.length === 0, "targets-not-allowed", "target_session_ids");
  const noInstruction = () => need(d.worker_instruction === null, "instruction-not-allowed", "worker_instruction");
  const noNew = () => need(ns.needed === false, "new-session-not-allowed", "new_session.needed");
  switch (d.action) {
    case "respond": noTargets(); noInstruction(); noNew(); break;
    case "message_session":
    case "message_multiple":
      need(d.action === "message_session" ? t.length === 1 : t.length >= 2, "target-count", "target_session_ids", String(t.length));
      t.forEach(messageable);
      need(!!d.worker_instruction && !!d.worker_instruction.trim(), "instruction-required", "worker_instruction");
      noNew(); break;
    case "create_session":
      noTargets();
      need(ns.needed === true, "new-session-required", "new_session.needed");
      need(!!ns.label, "label-required", "new_session.label");
      need(!!ns.objective && !!ns.objective.trim(), "objective-required", "new_session.objective");
      need(![...byId.values()].some((w) => w.label === ns.label && !FINISHED.has(w.status)), "label-in-use", "new_session.label", ns.label);
      break;
    case "request_status": t.forEach((id, i) => need(byId.has(id), "unknown-target", `target_session_ids.${i}`, id)); noInstruction(); noNew(); break;
    case "clarify": noTargets(); noInstruction(); noNew(); need(!!d.clarification && !!d.clarification.trim(), "clarification-required", "clarification"); break;
  }
  if (d.record_update) {
    d.record_update.aliases.forEach((a, i) => {
      need(byId.has(a.session_id), "unknown-target", `record_update.aliases.${i}.session_id`, a.session_id);
      const clash = [...byId.values()].find((w) => w.id !== a.session_id && (w.id === a.alias || w.label === a.alias || (w.aliases ?? []).includes(a.alias)));
      need(!clash, "alias-clash", `record_update.aliases.${i}.alias`, clash?.id);
    });
    if (d.record_update.focus !== null) need(byId.has(d.record_update.focus), "unknown-target", "record_update.focus", d.record_update.focus);
  }
  return { ok: errs.length === 0, errors: errs };
}
```

**MUST:**
- M1. `emptyDecision()` passes `validateShape`. Every one of the 8 top-level fields missing gives `missing-field`.
- M2. An extra top-level field (`file_path`, `edit`, `tool_call`) or an extra nested field (`new_session.cwd`,
  `record_update.path`) gives `unknown-field`.
- M3. An action outside the enum (`"write_file"`, `"run_shell"`) gives `enum`.
- M4. Over-long `worker_instruction` (4001 characters) gives `too-long`. A NUL character in `reply` gives
  `control-char`. Confidence `1.2` or `NaN` gives `range`.
- M5. `message_session` to an unknown id gives `unknown-target`. To a `finished` or `dead` worker it gives
  `target-not-messageable`. `message_multiple` with 1 target gives `target-count`.
- M6. `create_session` with a label in use by a live worker gives `label-in-use`. The same label on a finished worker
  is OK.
- M7. An alias that equals another worker's id, label or alias gives `alias-clash`.
- M8. The validator and `DECISION_SCHEMA` agree:
  - every `required` key matches `Object.keys(properties)`;
  - every object in the schema has `additionalProperties: false`;
  - every property is listed as required (OpenAI strict rules).
- M9. `MockCoordinatorProvider` returns scripted decisions in order, records `calls`, and throws `mock-exhausted`.
  `NullProvider` throws `no-provider`.

- [ ] **Step 1: Write the failing tests** for M1-M9. Use one table-driven test per MUST:
  `for (const [name, mutate, code] of CASES) assert.ok(validateShape(mutate(emptyDecision())).errors.some(e => e.code === code), name)`.
  Build workers with `w = (id, status, extra) => ({ id, provider: "claude", label: id.replace(/-\d+$/, ""), aliases: [], status, ...extra })`.
  For M8, walk the schema recursively.
- [ ] **Step 2: Run** `timeout 900 node --test "claude/skills/model-coordinator/tests/*.test.mjs"`. Expected: FAIL
  (modules missing).
- [ ] **Step 3: Implement** `schema.mjs` and `validate.mjs` as above. `provider.mjs` is about 40 lines: the classes
  plus a JSDoc typedef of `CoordinatorInput`. `CoordinatorInput` is `{v: 1, instructions, project, workers:
  WorkerSummary[], focused_session_id, referents, exchanges, message, validation_errors?}`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** the five files: `feat(model-coordinator): decision schema, strict validator, mock provider`.

### Task 6: Store (the write lock), ledgers, worker table, `coordinator_records.md`

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/paths.mjs`, `store.mjs`, `workers.mjs`, `records.mjs`, `env.mjs`
- Test: `tests/store.test.mjs`, `tests/workers.test.mjs`, `tests/records.test.mjs`, `tests/write-surface.test.mjs`,
  `tests/env.test.mjs`, `tests/mc-helpers.mjs` (new helpers file)

`env.mjs` is here, not in Task 8, so Task 9 does not depend on Task 8.

**Interfaces:**
- `env.mjs` (see Global Constraints):
  - `CREDENTIAL_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_RUN_ENV_ALLOW"]`. Matching is case-insensitive.
  - `launchEnv({extra = {}} = {})` is for `launch.mjs` and `launch.mjs resume --closed` children. It returns
    `process.env` minus `HL_SESSION_ID`, `CLAUDE_CODE_SESSION_ID` and `CREDENTIAL_ENV`, then adds `extra`. It keeps
    every other `HL_*` (`HL_REGISTRY_DIR`, `HL_NO_SPAWN`, `HL_FAKE_CLAUDE`, `HL_AGENTS_JSON`) and
    `CLAUDE_CONFIG_DIR`. It is the same rule as `launcherEnv()` (`live.mjs:584-587`) plus the credential strip.
  - `childEnv({extra = {}} = {})` is for `codex-run.mjs` and the `claude --resume --bg` wake. It strips
    `CREDENTIAL_ENV`, `HL_*`, `CLAUDE*` (except `CLAUDE_CONFIG_DIR`), `AI_AGENT` and `CLAUDE_CODE_SESSION_ID`, then
    adds `extra`.
- `paths.mjs`:
  - `cfgDir()`: `CLAUDE_CONFIG_DIR` or `~/.claude`, read at call time.
  - `stateDir()`: `<cfg>/state/model-coordinator`.
  - `secretsDir()`: `<cfg>/secrets`.
  - `HL_DIR`: the sibling `../handoff-launch`.
  - `codexSkillDir()`: `MC_CODEX_SKILL_DIR`, else the sibling `../dispatching-codex` (deployed), else the repo layout
    `../../../optional/codex/skills/dispatching-codex`, else null.
  - `msgKey(laneName)`: `sha1(name).slice(0, 16)`.
- `store.mjs`, the only module of the coordinator process that writes files:
  - `resolveAllowed(rel)`: returns the absolute path or throws `StoreError`.
  - `appendJsonl(name, obj)`, where `name` is one of `exchanges | dispatch | usage | workers | codex-attempts`.
  - `writeAtomic(rel, text)` (temp file plus rename in the same verified folder).
  - `writeNew(rel, text)`: `wx`; returns `false` when the file exists (idempotency).
  - `openOut(rel)`: returns an fd for a child's stdio.
  - `rename(relFrom, relTo)`.
  - `writeRecords(markdown)`: only `coordinator_records.md`, at most 16 KiB.
  - `readJsonl(name)`, which returns parsed objects and skips torn lines.
- `workers.mjs`:
  - `foldWorkers(lines)` returns `Map<id, Worker>`.
  - A `Worker` is `{id, provider, label, aliases[], objective, repo, worktree, branch, lane, status, current_task,
    last_result, blockers[], needs_user, created_at, in_worktree_of?, fallback_of?}`.
  - Events in `workers.jsonl`:
    - `{ev: "created", ...}`;
    - `{ev: "alias", worker_id, alias}`;
    - `{ev: "status", worker_id, status, summary?, changes?, blockers?, needs_user?, files_changed?}`;
    - `{ev: "focus", worker_id | null}`;
    - `{ev: "ended", worker_id, why}`.
  - `nextWorkerId(label, workers)` returns `<label>-NN`, starting at 01 and unique forever.
  - `focusOf(lines)`.
  - `toSummary(worker)` returns a `WorkerSummary`, with field caps of 200/300/200 characters and 3 blockers.
- `records.mjs`: `renderRecords({workers, focus, notes})`, which returns Markdown. It is pure. Notes are the last 20
  notes, each with newlines collapsed, a leading `#` removed, and capped at 300 characters.
  - `## Task relationships` is derived from the worker table, not supplied by Luna. The producer is the dispatcher
    (Task 11): it writes `in_worktree_of` (a `/new codex ... --in <ref>` worker) and `fallback_of` (a Claude worker
    created because a Codex create fell back) on the `created` event. Lines look like `<id> works in <ref>'s
    worktree` and `<id> replaced a Codex request (fallback: <reason>)`.

**Full code (subtle): `store.mjs` core.**

```js
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.mjs";
export class StoreError extends Error {}
const LEDGERS = new Set(["exchanges", "dispatch", "usage", "workers", "codex-attempts"]);
const RULES = [
  /^coordinator_records\.md$/,
  /^(exchanges|dispatch|usage|workers|codex-attempts)\.jsonl$/,
  /^instance\.json$/,
  /^briefs\/[a-z0-9][a-z0-9.-]{0,79}\.md$/,
  /^messages\/[0-9a-f]{16}\/[0-9a-f]{32}(\.delivered)?\.json$/,
  /^codex-out\/[a-z0-9][a-z0-9.-]{0,79}\.(out|err)$/,
];
const win = process.platform === "win32";
const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
function root() {
  const s = stateDir();
  fs.mkdirSync(s, { recursive: true });
  return fs.realpathSync.native(s);
}
export function resolveAllowed(rel) {
  if (typeof rel !== "string" || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new StoreError(`bad path: ${JSON.stringify(rel)}`);
  }
  if (!RULES.some((r) => r.test(rel))) throw new StoreError(`not in the allowlist: ${rel}`);
  const base = root(), parts = rel.split("/");
  let cur = base;
  for (const part of parts.slice(0, -1)) {             // every folder below the root: a real folder, never a link
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== "ENOENT") throw e; fs.mkdirSync(cur); st = fs.lstatSync(cur); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new StoreError(`link or non-folder in path: ${rel}`);
    if (!same(fs.realpathSync.native(cur), cur)) throw new StoreError(`path escapes the state folder: ${rel}`);
  }
  const target = path.join(cur, parts.at(-1));
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new StoreError(`target is a link or not a file: ${rel}`);
    if (!same(fs.realpathSync.native(target), target)) throw new StoreError(`target escapes the state folder: ${rel}`);
  } catch (e) { if (e instanceof StoreError) throw e; if (e.code !== "ENOENT") throw e; }
  return target;
}
export function appendJsonl(name, obj) {
  if (!LEDGERS.has(name)) throw new StoreError(`unknown ledger ${name}`);
  fs.appendFileSync(resolveAllowed(`${name}.jsonl`), JSON.stringify(obj) + "\n");
}
export function writeAtomic(rel, text) {
  const f = resolveAllowed(rel), tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, f); return; } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
export function writeNew(rel, text) {
  try { fs.writeFileSync(resolveAllowed(rel), text, { flag: "wx" }); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; }
}
export const openOut = (rel) => fs.openSync(resolveAllowed(rel), "w");
export function rename(from, to) { fs.renameSync(resolveAllowed(from), resolveAllowed(to)); }
export function writeRecords(markdown) {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 16384) throw new StoreError("records too large");
  writeAtomic("coordinator_records.md", markdown);
}
export function readJsonl(name) {
  if (!LEDGERS.has(name)) throw new StoreError(`unknown ledger ${name}`);
  let t = ""; try { t = fs.readFileSync(path.join(stateDir(), `${name}.jsonl`), "utf8"); } catch { return []; }
  return t.split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}
```

**`tests/mc-helpers.mjs` (new; never edit `handoff-launch/tests/helpers.mjs`):**
- `mcEnv()`: a temp root with `cfg`, `codex-home`, `registry` and `temp`. It returns an env object (like
  `optional/codex/.../tests/helpers.mjs:29 tmpEnv`) with:
  - `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HL_REGISTRY_DIR`, `HL_NO_SPAWN=1`, `HL_FAKE_CLAUDE=1`;
  - `HL_AGENTS_JSON` pointing at `[]`;
  - `MC_PIPE_NAME=mc-test-<pid>-<n>` and a unique `CODEX_RUN_PIPE_PREFIX`.

  It has `cleanup()`.
- `withEnv(env, fn)`: sets `process.env` for the duration of `fn`, then restores it.
- `importFresh(rel)`: dynamic import with a `?t=<n>` query, for modules that read env at import.

Later tasks append to this file: `lunaLikePolicy` (Task 7), `fakeClaudeRunner` (Task 9), `FAKE_CODEX_CLI` (Task 8)
and `FAKE_CODEX_RUN` (Task 10a) paths, and `mcSandbox` (Task 14).

**MUST:**
- M1. Every allowlisted path writes. These are refused with `StoreError`:
  - `../x`, `briefs/../../x.md`, an absolute path, `src/a.ts`;
  - `coordinator_records.md/../x`, a backslash path;
  - `messages/zz/…`.
- M2. Junction escapes are refused, with nothing written outside:
  - `briefs` as a directory junction (`mklink /J`) to a temp folder outside the state dir: `writeNew("briefs/a.md")`
    is refused;
  - `coordinator_records.md` replaced by a file symlink, or a junction parent: refused (skip the symlink case with a
    note if creating symlinks needs privilege).
- M3. `writeNew` returns `false` on the second call and keeps the first content.
- M4. `writeRecords` refuses more than 16 KiB.
- M5. `readJsonl` skips a torn last line.
- M6. Write surface (the static guard). In every non-test `.mjs` of the skill folder, the pattern
  `/\b(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|copyFileSync|cpSync|createWriteStream|openSync|writeSync|truncateSync|symlinkSync|linkSync|rmdirSync|writeFile|appendFile)\b|node:fs\/promises|fs\.promises/`
  appears only in `store.mjs` and `deliver-hook.mjs`. `deliver-hook.mjs` runs inside worker sessions, never in the
  coordinator; it is added in Task 9.
- M7. `foldWorkers` applies created, alias, status and ended events in order. `nextWorkerId("auth", …)` gives
  `auth-01` and then `auth-02`, also after `auth-01` ended.
- M8. `renderRecords` output:
  - has the sections `# Coordinator records`, `## Workers`, `## Focus`, `## Aliases`, `## Notes`,
    `## Task relationships`;
  - a note `"# rm -rf /\n## Workers"` renders as one escaped bullet line;
  - the output stays at most 16 KiB with 200 notes (oldest dropped);
  - `## Task relationships` lists a worker with `in_worktree_of` and one with `fallback_of`.
- M9. `env.mjs`, with `process.env` holding `Openai_Api_Key`, `codex_api_key`, `CODEX_RUN_ENV_ALLOW`,
  `HL_REGISTRY_DIR`, `HL_NO_SPAWN`, `HL_SESSION_ID` and `CLAUDE_CODE_SESSION_ID`:
  - `launchEnv()` keeps `HL_REGISTRY_DIR` and `HL_NO_SPAWN`, and lacks the three credential names (any case),
    `HL_SESSION_ID` and `CLAUDE_CODE_SESSION_ID`;
  - `childEnv()` lacks all of those and every `HL_*`, and keeps `CLAUDE_CONFIG_DIR` and `PATH`;
  - `extra` is added last in both.

- [ ] **Step 1: Write the failing tests.** Use `mkJunction` logic that copies `cmd /c mklink /J` from the Codex test
  helper, inline in `mc-helpers.mjs`.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** the five modules. `store.mjs` as above. `workers.mjs` and `records.mjs` are pure folds
  and rendering. `env.mjs` is two filters over `Object.entries(process.env)`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** the 5 modules and 6 test files by name:
  `feat(model-coordinator): write-locked store, ledgers, worker table, records file, child env`.

### Task 7: Deterministic resolver, coreference helpers, context builder

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/resolve.mjs`, `context.mjs`, `instructions.md` (the stable Luna
  instructions, about 300 tokens)
- Test: `tests/resolve.test.mjs`, `tests/context.test.mjs`. Append `lunaLikePolicy` to `tests/mc-helpers.mjs`.

**Interfaces:**
- `parseCommand(text)` returns null or one of:
  - `{cmd: "to", targets: [names], text}` from `/to <ref>[,<ref>...] <text>`;
  - `{cmd: "status", targets}` from `/status [ref...]`;
  - `{cmd: "new", provider, label, objective, inWorktreeOf?}` from
    `/new claude|codex <label> [--in <ref>] <objective>`;
  - `{cmd: "alias", target, alias}` from `/alias <ref> <alias>`;
  - `{cmd: "restart-closed" | "workers" | "help" | "quit"}`.
- `matchRef(ref, workers)` returns `{id} | {ambiguous: [ids]} | {none: true}`. It checks, in order: exact id, exact
  label (unique among non-finished workers), alias.
- `referents({text, workers, focusedId, exchanges})` returns `{pronoun, singular, other, both, recent,
  last_instruction}`:
  - `pronoun`:
    - `"both"` for `/\b(both|each of them|all of them)\b/i`;
    - `"other"` for `/\bthe other (one|worker|session)\b/i`;
    - `"singular"` for `/\b(him|her|it|that one|this one|that worker|them)\b/i`;
    - else null.
  - `recent`: worker ids in order of last mention across the exchanges (newest first), messageable only.
  - `singular`: the focused id if messageable, else `recent[0]`, else null.
  - `other`: `recent.find(id => id !== singular)`, else null.
  - `both`: `recent.slice(0, 2)` when it has 2 entries, else null.
  - `last_instruction`: the newest exchange's `instruction`, else null.
- `resolveLine(text, {workers, focusedId, exchanges})` returns one of:
  - `{kind: "decision", decision, rule}`, where `rule` is `explicit-id | command | exact-name | alias |
    continue-single`;
  - `{kind: "command", command}`;
  - `{kind: "error", reply}`;
  - `{kind: "model", referents}`.
- `buildInput({cfg, project, workers, focusedId, referents, exchanges, message, validationErrors})` returns
  `CoordinatorInput`.
- `estimateTokens(obj)` is `Math.ceil(JSON.stringify(obj).length / 4)`.

**Key logic, `resolveLine`.** In order:

1. A command:
   - `/to` gives a `message_session` or `message_multiple` decision, with the instruction = the text verbatim;
   - `/status` gives `request_status`;
   - `/new` gives `create_session`;
   - `/alias` gives a `respond` decision with a `record_update`;
   - an unknown ref gives `{kind: "error", reply: "No worker named <ref>. Workers: ..."}`.
2. The line names exactly one worker by exact id, unique exact label or alias, as a whole word. It contains no
   pronoun class and no second worker name. This gives `message_session` to it, with the instruction = the whole line
   verbatim and rule `explicit-id`, `exact-name` or `alias`.
3. The whole line matches `/^(continue|keep going|go on|carry on|proceed)[.!]*$/i` and exactly one worker is
   messageable and not `queued`. This gives `message_session` with rule `continue-single`.
4. Else `{kind: "model", referents}`.

Deterministic decisions have confidence 1 and pass through the same validator.

**Context budget.** Defaults are `target_tokens: 2000` and `max_tokens: 3000`. The builder:

- includes the instructions, the project (repo, Codex state, cost state), all summaries of non-finished workers plus
  workers finished in the last 24 h (at most 12), the focused id, the referents, the last `cfg.context.exchanges`
  (5) exchanges, and the message;
- caps each exchange's user text at 500 characters, its reply at 300, and the message at 2000 characters with a
  `[... N chars cut]` marker;
- when over `max_tokens`, cuts in this order: drop exchanges down to 4, cut `last_result` to 100 characters, drop
  finished workers, drop exchanges down to 2. If it is still over, throw `Error("context-over-budget")`. With the caps
  above that cannot happen; the test proves it.

**`lunaLikePolicy(input)` (test helper only).** It emulates a well-behaved Luna, using only what the context provides:
- pronoun `both` and a message matching `/^do that/i` gives `message_multiple` to `referents.both` with
  `referents.last_instruction`;
- `both` otherwise gives `message_multiple` with the message;
- `other` gives `message_session` to `referents.other`;
- `singular` gives `message_session` to `referents.singular`;
- `/(make|start|create) (another|a new) worker for the (\w[\w-]*)/i` gives `create_session` (provider codex, label =
  the capture);
- `/what did the (\w[\w-]*) worker say/i` gives `request_status` on the matching label;
- an ambiguous `recent` with no focus gives `clarify`;
- else `message_session` to the focused id.

**MUST:**
- M1. `/to auth-01 keep going` gives a decision to `auth-01` with no model call. `/to ghost-9 hi` gives an error
  reply naming the workers.
- M2. An alias gives a decision: `"tell the login worker to retry"`, with the alias `login worker` on `auth-01`,
  routes to `auth-01` (rule `alias`).
- M3. `"continue"` with one messageable worker gives `continue-single`. With two it gives `kind: model`, and
  `referents.singular` is the focused one.
- M4. `"tell him not to change the backend"` (focus `auth-01`) gives `pronoun: singular, singular: auth-01`.
  `"that one"` gives the same. `"have the other one check it too"`, after `invoice-01` then `auth-01` were
  discussed, gives `other: invoice-01`. `"do that for both"` gives `both: [auth-01, invoice-01]` and
  `last_instruction` = the previous instruction.
- M5. A line naming two workers gives `kind: model`, never a guess.
- M6. Context:
  - a typical case (3 workers, 5 exchanges, a 200-character message) estimates 1000-3000 tokens;
  - 12 long workers + 10 exchanges + a 10k-character message stays at most 3000 tokens and keeps at least 2
    exchanges (Review Focus 1);
  - no field of the input holds a transcript (assert the input JSON has no key `transcript` and is at most 12 KiB).

- [ ] **Step 1: Write the failing tests** for M1-M6, with a fixed worker table: `auth-01` (claude, running, alias
  `login worker`), `invoice-01` (codex, waiting_for_user), `old-01` (finished).
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** `resolve.mjs`, `context.mjs` and `instructions.md`. The instructions name the actions,
  the rule "never invent ids; use only ids in `workers`", the coreference order from the spec, "clarify when
  materially ambiguous", and the fact that Luna has no tools.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** `resolve.mjs`, `context.mjs`, `instructions.md`, the two tests and `mc-helpers.mjs`:
  `feat(model-coordinator): deterministic resolver, coreference, context budget`.

### Task 8: Codex resource manager (`codex-resources.mjs`)

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high` + **Codex review**.

**Files:**
- Create: `claude/skills/model-coordinator/codex-resources.mjs`, `config.mjs` (`env.mjs` comes from Task 6)
- Create test fakes: `tests/fake-codex-cli.mjs`. It answers `login status` per `FAKE_LOGIN` =
  `chatgpt | api_key | none | garbage | hang`, prints to stdout or stderr, and exits 1 for `none`.
- Test: `tests/codex-resources.test.mjs`, `tests/config.test.mjs`

**Interfaces:**
- Consumes (dynamic import from `codexSkillDir()/lib/`; Codex is unavailable when the folder is absent):
  - `resolveCodex(env)` (`binary.mjs:24`), which returns `{cmd, args}` and honours `CODEX_RUN_BIN` and
    `CODEX_RUN_BIN_ARGS`;
  - `busySlots()` (`locks.mjs:57`);
  - `latestReading(now)` (`usage.mjs:108`), `mapWindows(rl)` (`:74`), and
    `quotaDecision({reading, now, busySlots, mode, model})` (`:133`), all fixed in Task 4.
- Consumes `childEnv` from `env.mjs` (Task 6).
- Produces from `config.mjs`:
  - `loadConfig()`. It merges `DEFAULTS` with `<state>/config.json` (read only; never written by the coordinator).
    It returns `{config, errors}`.
  - `DEFAULTS = {provider: "none", openai: {model: "gpt-6-luna", key_file: null, reasoning_effort: "none", timeout_ms:
    20000, max_retries: 2, max_output_tokens: 600}, pricing: {}, limits: {monthly_soft_usd: 7, monthly_hard_usd: 10},
    min_confidence: 0.6, codex: {max_parallel_jobs: 2, model: "sol", effort: "medium", queue_max: 4, fallback:
    "claude", login_cache_ms: 300000}, claude: {model: "opus", effort: "high"}, context: {target_tokens: 2000,
    max_tokens: 3000, exchanges: 5}}`.
  - Errors:
    - `claude.model` matching `/sonnet|haiku/i`;
    - `codex.fallback: "paid_api"` gives "paid_api fallback is not supported in V1 (deferred)";
    - `codex.fallback` otherwise not in `claude | refuse`;
    - `openai.reasoning_effort` not a non-empty string or null;
    - `openai.key_file` outside `secretsDir()` (real-path compare);
    - `max_parallel_jobs` not an integer in 1..3.
- Produces from `codex-resources.mjs`:
  - `loginStatus(bin, {env, timeoutMs = 15000})` returns `"chatgpt" | "api_key" | "none" | "unknown"`. It runs
    `bin.cmd [...bin.args, "login", "status"]` with `childEnv({extra: {CODEX_HOME}})` and `windowsHide`. Output is
    captured and never logged or returned.
  - `createLoginCache(probe, ttlMs, now)`.
  - `usageStatus(reading, {now, busySlots, lib, model})` returns `{status, why, blocks}`. `model` is
    `cfg.codex.model`, the model the wrapper will actually run.
  - `createAllowance(max)` returns `{withLock(fn), reserve(id), release(id), active(), rebuild(ids)}`.
  - `codexGate({cfg, lib, login, allowance, worktreeCheck, attemptId, now})` returns
    `{ok: true, state, bin} | {ok: false, kind, reason, state}`. `kind` is `unavailable | busy | exhausted | unknown
    | conflict`.
  - `fallbackFor(kind, cfg, {isNewWorker, queueLength})` returns `{action: "queue" | "claude" | "refuse" |
    "clarify", reason}`.
  - `resourceState(...)` returns `CodexResourceState {active_jobs, max_parallel_jobs, available,
    capacity_available, usage_status}`.

**Full code (subtle): usage status, the gate, the allowance.**

```js
export function usageStatus(reading, { now, busySlots, lib, model }) {
  if (!reading || !reading.rl) return { status: "unknown", why: "no-reading", blocks: false }; // first run makes one
  const mw = lib.mapWindows(reading.rl);
  const qd = lib.quotaDecision({ reading, now, busySlots, mode: "write", model }); // the configured model, never a constant
  if (qd.action === "block") {
    return qd.reason === "codex-quota-unknown-reset"
      ? { status: "unknown", why: qd.reason, blocks: true }
      : { status: "exhausted", why: qd.reason, blocks: true };
  }
  if (mw.week_pct !== null && mw.week_resets_at === null) return { status: "unknown", why: "no-reset", blocks: true }; // Resolution C
  if (mw.week_pct === null && mw.week_resets_at === null) return { status: "unknown", why: "no-weekly-window", blocks: false };
  // the wrapper's effective pct (usage.mjs:149-150); downgrade is sol-only, near_limit is not
  const eff = (mw.week_resets_at * 1000 <= now ? 0 : (mw.week_pct ?? 0)) + 2 * busySlots;
  if (qd.action === "downgrade" || eff >= 85) return { status: "near_limit", why: qd.reason ?? `week-pct ${eff}`, blocks: false };
  return { status: "ok", why: null, blocks: false };
}

export function createAllowance(max) {
  let held = new Set(), chain = Promise.resolve();
  const withLock = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  return {
    withLock,
    reserve: (id) => (held.size < max ? (held.add(id), true) : false), // call only inside withLock
    release: (id) => { held.delete(id); },
    active: () => held.size,
    rebuild: (ids) => { held = new Set(ids); },
  };
}

// Inside allowance.withLock: available -> own cap -> machine slots -> quota -> worktree; reserve on success.
export async function codexGate({ cfg, lib, login, allowance, worktreeCheck, attemptId, now = Date.now() }) {
  const state = { active_jobs: allowance.active(), max_parallel_jobs: cfg.codex.max_parallel_jobs,
    available: false, capacity_available: false, usage_status: "unknown" };
  const no = (kind, reason) => ({ ok: false, kind, reason, state });
  if (!lib) return no("unavailable", "codex-skill-absent");
  let bin;
  try { bin = lib.resolveCodex(); } catch { return no("unavailable", "codex-not-found"); }
  const who = await login(bin);
  if (who !== "chatgpt") return no("unavailable", `codex-login-${who}`); // api_key never used silently (Resolution E)
  state.available = true;
  if (allowance.active() >= cfg.codex.max_parallel_jobs) return no("busy", "codex-own-cap");
  let busy;
  try { busy = await lib.busySlots(); } catch { busy = 3; }              // a failed probe is the conservative side
  if (busy >= 3) return no("busy", "codex-slots-full");
  state.capacity_available = true;
  let reading = null;
  try { reading = lib.latestReading(now); } catch { /* none */ }
  const u = usageStatus(reading, { now, busySlots: busy, lib, model: cfg.codex.model });
  state.usage_status = u.status;
  if (u.blocks) return no(u.status === "exhausted" ? "exhausted" : "unknown", u.why);
  const w = worktreeCheck();
  if (!w.ok) return no("conflict", w.reason);
  if (!allowance.reserve(attemptId)) return no("busy", "codex-own-cap");
  state.active_jobs = allowance.active();
  return { ok: true, state, bin };
}

export function fallbackFor(kind, cfg, { isNewWorker, queueLength }) {
  if (kind === "conflict") return { action: "clarify", reason: "workspace conflict" };
  if (kind === "busy") return queueLength < cfg.codex.queue_max ? { action: "queue", reason: "Codex busy" } : policy();
  if (!isNewWorker) return { action: "refuse", reason: "an existing Codex worker is not moved to another provider" };
  return policy();
  function policy() {
    if (!isNewWorker) return { action: "refuse", reason: "Codex queue full" };
    if (cfg.codex.fallback === "refuse") return { action: "refuse", reason: "fallback policy: refuse" };
    return { action: "claude", reason: "fallback policy: Claude worker" };
  }
}
```

`loginStatus` classification:

```js
const t = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
if (r.error || r.status === null) return "unknown";      // timeout, spawn failure
if (/logged in using chatgpt/i.test(t)) return "chatgpt";
if (/api key/i.test(t)) return "api_key";
if (/not logged in/i.test(t)) return "none";
return "unknown";
```

**MUST:**
- M1. The `login status` probe's env (recorded by the fake CLI, which writes its env names to a file named by
  `FAKE_ENV_DUMP`) has no credential name in any case and no `HL_*`. It has `CODEX_HOME`.
- M2. `loginStatus` against `fake-codex-cli.mjs` (via `CODEX_RUN_BIN=node`, `CODEX_RUN_BIN_ARGS`) maps
  `chatgpt`/`api_key`/`none`/`garbage`/`hang` to `chatgpt`/`api_key`/`none`/`unknown`/`unknown`. The `hang` case
  uses `timeoutMs: 500`. The result object never carries the raw output.
- M3. The login cache calls the probe once within its TTL and again after it.
- M4. `usageStatus`:
  - null reading gives `unknown`, not blocking;
  - 99 % with a reset gives `exhausted`, blocking;
  - 88 % gives `near_limit`;
  - 99 % without a reset gives `unknown`, blocking;
  - 10 % gives `ok`;
  - 88 % with `model: "luna"` gives `near_limit` too (no downgrade). The `quotaDecision` spy receives the model passed
    in, never a hard-coded `"sol"`.
- M5. Gate order:
  - absent lib: `unavailable`;
  - login `api_key`: `unavailable`;
  - own cap full (2 reserved): `busy` / `codex-own-cap`;
  - `busySlots` 3: `busy` / `codex-slots-full`;
  - exhausted reading: `exhausted`;
  - a worktree check failure: `conflict`;
  - all fine: `ok`, and `allowance.active()` goes up by 1.
- M6. Concurrency: 5 gates run at once through `withLock` with max 2 give exactly 2 `ok`. `release` frees one, and
  the next gate gives `ok`.
- M7. `fallbackFor`:
  - `busy` with a queue below max gives `queue`; at max, a new worker gets policy `claude`;
  - `exhausted` for an existing worker gives `refuse`;
  - `unavailable` for a new worker with policy `refuse` gives `refuse`; with policy `claude` it gives `claude`.
- M8. `loadConfig` refuses:
  - `claude.model: "sonnet"`;
  - `codex.max_parallel_jobs: 5`;
  - `codex.fallback: "paid_api"`, with the error naming V1;
  - `openai.reasoning_effort: 3`;
  - an `openai.key_file` outside `secrets/` (a `..` path and a junction).

  `openai.reasoning_effort: null` is accepted.

- [ ] **Step 0 (manual, not a test):** with the user's OK, run `codex login status` once by hand. Record only the
  wording class ("Logged in using ChatGPT" or similar) in a comment in `codex-resources.mjs`. Redact everything else.
  If no OK is given, keep the assumed strings (A3).
- [ ] **Step 1: Write the failing tests** M1-M8. Use injected fake `lib` objects (`{resolveCodex, busySlots,
  latestReading, mapWindows, quotaDecision}`, the last two the real functions imported from the Codex `lib/`) so the
  gate tests take no pipes.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** the two modules.
- [ ] **Step 4: Run** the model-coordinator suite and the Codex suite. Expected: PASS.
- [ ] **Step 5: Commit** `codex-resources.mjs`, `config.mjs`, `fake-codex-cli.mjs` and the two tests:
  `feat(model-coordinator): Codex resource manager (login, own cap, slots, quota, fallback)`.
- [ ] **Step 6: Codex review.** The controller runs a `codex-run.mjs --mode review` on the commit diff. The focus is
  gate order, the quota mapping, `login status` handling and fallback.

### Task 9: Claude adapter (create via `launch.mjs --mode bg`, messages, delivery hook, idle wake)

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/claude-adapter.mjs`, `deliver-hook.mjs`
- Modify: `claude/skills/handoff-launch/live.mjs:548-557` (`sessionHooks`: add the delivery hook when the file exists)
- Test: `tests/claude-adapter.test.mjs`, `tests/deliver-hook.test.mjs`. Append `fakeClaudeRunner` to
  `tests/mc-helpers.mjs`.

**Interfaces:**
- Consumes:
  - `launch.mjs` CLI (bg mode `:1057-1085`; exit 3 = cap or occupancy, `:835-875`);
  - `launch.mjs profile-args --profile <p> --repo <dir>` (`:695-699`), which prints the `--settings` args with the
    session hooks;
  - `readRegistry`, `liveness`, `sessionState`, `agentsList`, `refreshAgents`, `listedAgent` (`live.mjs:58,310,411,
    234,250,253`);
  - `claudeCli()` and `claudeSpawn(argv, cli)` (`live.mjs:108-121`);
  - `liveLaneStatus` (Task 2); store, paths, `launchEnv` and `childEnv` (Task 6).
- Produces from `claude-adapter.mjs` (constructor `createClaudeAdapter({cfg, repo, deps})`, where `deps = {runNode,
  runClaude, spawnSync, claudeCli, now}`; `claudeCli` defaults to `live.mjs`'s):
  - `runNode(args, opts)` runs `launch.mjs`. The default spawns `process.execPath` with `env: launchEnv()`. That env
    keeps `HL_*`, so under test `HL_REGISTRY_DIR`, `HL_NO_SPAWN`, `HL_FAKE_CLAUDE` and `HL_AGENTS_JSON` reach the
    launcher and it never writes the real registry or starts a real `claude`. `launch.mjs` strips `HL_*` from the
    session itself.
  - `runClaude(args, opts)` returns `{code, stdout, stderr}`. The default is
    `const [file, argv, sh] = claudeSpawn(args)` followed by `deps.spawnSync(file, argv, {...opts, ...sh,
    windowsHide: true, encoding: "utf8", timeout: 120000})`. Every argument that carries model or user text goes
    through `clean(s)`, which is `s.replace(/"/g, "'").replace(/;/g, ",")`. That is the same rule as the local
    `clean` at `launch.mjs:979`; the adapter keeps its own copy, and a test pins that the two produce equal output.
  - `wakeSupported()` is `deps.claudeCli().exe !== null`. When it is false, `claudeSpawn` would fall back to one shell
    command string (`live.mjs:119-120`), so the idle wake is skipped (see Message).
  - `create({workerId, label, objective, instruction, requestId})` returns one of:
    - `{ok: true, lane, worktree, branch}`;
    - `{ok: false, kind: "cap" | "failed", reason}`.

    It writes `briefs/<workerId>.md` (`writeNew`). Then it runs `launch.mjs --repo <repo> --handoff <brief> --name
    <workerId> --worktree mc-<workerId> --model <cfg.claude.model> --effort <cfg.claude.effort> --mode bg` through
    `runNode` (`launchEnv()`) with a 4-minute timeout.
  - `message(worker, text, requestId)` returns `{ok: true, path}` or `{ok: false, kind: "dead", reason}`. `path` is
    one of `delivered-next-tool | woke-idle | queued-until-next-run | already-queued`.
  - `status(worker)` returns `{status, current_task, last_result, blockers, needs_user, files_changed}`.
  - `pendingMessages(worker)`.
- Produces from `deliver-hook.mjs` (hook process; stdin is the hook JSON):
  - With `HL_SESSION_ID` it finds the lane name in the registry, then claims each `messages/<msgKey(name)>/<rid>.json`
    by renaming it to `<rid>.delivered.json`. A lost race skips the file.
  - It prints `{"hookSpecificOutput": {"hookEventName": <input.hook_event_name>, "additionalContext": "Message from
    the user, relayed by the coordinator (request <rid>): <text>"}}`, at most 8 KiB in total. The rest stays pending.
  - It always exits 0. It prints nothing when there is nothing to deliver.

**Key logic.**
- **The brief.** It holds the objective and the first instruction, then this "Coordinator protocol" text: "End every
  turn with a fenced block ```` ```coordinator-state ```` holding one JSON object `{session_id, provider: "claude",
  status: running|waiting_for_user|done|blocked, summary, changes[], blockers[], needs_user, files_changed[]}`
  (summary at most 200 chars)." Then: "Never commit unless the user asks." The rest follows `handoff-launch`'s normal
  brief conventions.
- **Status.** Find the newest launch line named `worker.lane` (`latestLaunch`). Map `liveLaneStatus` and
  `sessionState`:
  - `open` and busy: `running`;
  - `open` and idle: `idle`;
  - `finished`: `finished`;
  - `closed_unfinished`: `dead`;
  - `paused`: `blocked` ("paused: …");
  - `unknown`: `unknown`.

  Parse the newest ```` ```coordinator-state ```` block from the transcript tail (last 256 KiB, read-only). Only
  entries with `type === "assistant"` count, and only their `text` content blocks. The brief and user prompts hold
  the same fence as an example, so user entries and tool results are never read. A valid block overrides the status
  with `waiting_for_user` or `done` and gives the summary fields.
- **Message.**
  1. If liveness is `gone`, return `{ok: false, kind: "dead"}` and write nothing.
  2. `writeNew("messages/<msgKey(lane)>/<rid>.json", {request_id, text, at})`. If it returns `false`, the message is
     already queued or delivered (a retry of the same request), so return at once with `{ok: true, path:
     "already-queued"}`. Never fall through to the wake: that is how a retry double-sends.
  3. If `!wakeSupported()` (no `claude.exe`, the shell-string fallback), skip the wake and return `{ok: true, path:
     "queued-until-next-run"}`. Model text never goes through a shell.
  4. A bg lane whose `claude agents --json` status is `idle` or `done`, or whose transcript turn is done with no
     pending tools (`sessionState().idle`):
     - claim the file (`store.rename` to `.delivered.json`);
     - `before = refreshAgents()`;
     - `runClaude(["--resume", sid, ...profileArgs, "--bg", clean("<relay text>")], {cwd: worktree, env:
       childEnv({extra: {HL_SESSION_ID: e.id}})})`. The relay text is one argv element, never a shell string;
     - `after = refreshAgents()`.
     - A copy is detected by a `/^note:.*\b(cop(y|ied)|fork(ed)?)\b/im` match on the output, or by a new entry in
       `after` whose `sessionId !== sid`. Then run `runClaude(["stop", copy.id])` for each copy, rename the file back
       (un-claim), and return `queued-until-next-run`.
     - A non-zero exit also un-claims and returns `queued-until-next-run`.
     - Success returns `woke-idle`.
  5. Otherwise (busy, or a window lane) return `delivered-next-tool`. The hook delivers at the next PostToolUse or
     UserPromptSubmit.
- **`live.mjs` change.** Add
  `const MC_DELIVER = path.resolve(HERE, "..", "model-coordinator", "deliver-hook.mjs")`. In `sessionHooks()`, when
  `fs.existsSync(MC_DELIVER)`, append a second matcher group:
  - `PostToolUse: [..., { matcher: "*", hooks: [{type: "command", command: `node "${fwd(MC_DELIVER)}"`, timeout:
    5}] }]`;
  - the same group, without a matcher, to `UserPromptSubmit`.

  Index 0 stays the coord.mjs hook (`tests/lane-hooks.test.mjs:380-385` keeps passing).

**MUST:**
- M1. `create` under `HL_NO_SPAWN` (sandbox) runs `launch.mjs` with `--mode bg --model opus --effort high` and a
  brief in `briefs/`. It returns `ok` with `lane === workerId`. The registry has the line.
- M2. A `launch.mjs` exit 3 (set `launch-config.json` `max_sessions: 0` in the sandbox registry folder) gives
  `{ok: false, kind: "cap"}`. Exit 1 gives `failed` with the last output lines.
- M3. A message to a busy bg lane writes exactly one message file. The second call with the same request id writes
  nothing, returns `already-queued` and calls no runner. The busy lane is made with
  `sessionLine(sb, {name, mode: "bg", bg_id: "b1", sid: "s1"})` (the sandbox comes first, `helpers.mjs:122`) plus
  `setAgents(sb, [{id: "b1", sessionId: "s1", name, status: "busy"}])`.
- M3b. Idempotent wake: on an idle lane, the second `message` call with the same request id (file already
  `.delivered.json`) returns `already-queued`, and the fake runner saw exactly one `--resume` call.
- M4. A message to an idle bg lane calls the fake runner with `--resume s1 … --bg` and returns `woke-idle`. The file
  ends up `.delivered.json`.
- M5. The idle wake detects a copy: the fake runner prints `note: started a copy (id b2)`, and fake agents gain `{id:
  "b2", sessionId: "s2"}`. Then `stop b2` is called and the message is back to pending (`queued-until-next-run`).
- M6. A message to a gone lane gives `{ok: false, kind: "dead"}` and writes no file.
- M7. Status:
  - a transcript whose last assistant text has a valid ```` ```coordinator-state ```` block gives `waiting_for_user`
    with the summary;
  - a malformed block is ignored;
  - a block inside a `type: "user"` entry (the brief or a user prompt) is ignored when no assistant entry has one;
  - `HL_FAKE_PROBE=fail` gives `unknown`, not a throw (Review Focus 2);
  - a finished lane (done marker) gives `finished`; a crashed lane gives `dead`.
- M8. Deliver hook:
  - with `HL_SESSION_ID` of a sandbox lane and two pending files, PostToolUse input prints one JSON with both texts
    and both files become `.delivered.json`;
  - a second run prints nothing;
  - with no `HL_SESSION_ID` it prints nothing and exits 0;
  - a 20 KiB backlog delivers at most 8 KiB and leaves the rest pending;
  - two hook processes racing deliver each message exactly once.
- M9. `sessionHooks()` keeps the coord.mjs hook at index 0 of `PostToolUse` and `UserPromptSubmit`. It includes the
  delivery hook when the file exists. The handoff-launch suite passes.
- M10. The write-surface test (Task 6 M6) still passes with `deliver-hook.mjs` as the only other writer.
- M11. `launch.mjs` child env (I1). With the default `runNode`, `create` in a sandbox whose `process.env` also holds
  `OPENAI_API_KEY=x`:
  - records the line in the sandbox registry (`HL_REGISTRY_DIR` reached the launcher), and the real registry file is
    untouched (its mtime and size are unchanged);
  - `HL_NO_SPAWN` was honoured (no `bg_id`);
  - the env recorded by a wrapping `runNode` spy has `HL_REGISTRY_DIR` and `HL_NO_SPAWN`, and no `OPENAI_API_KEY`
    in any case.
- M12. No shell for model text (I2):
  - With an injected `claudeCli` returning `{exe: "C:/fake/claude.exe"}` and a recording `deps.spawnSync`, a
    message text `tell it " & echo pwned ; x` reaches the recorded call as exactly one argv element, quotes turned
    to `'` and `;` to `,`, with `shell: false`.
  - With `claudeCli` returning `{exe: null}`, the idle wake records no spawn and returns `queued-until-next-run`.
  - The adapter's `clean` matches `launch.mjs`'s on 5 sample strings. The test extracts the source line
    `launch.mjs:979` by regex and evaluates it.

- [ ] **Step 1: Write the failing tests.** Use the handoff-launch `sandbox()` (import it from
  `../../handoff-launch/tests/helpers.mjs`; read-only use) for the registry, repo and agents file. Run adapter calls
  in a child process with `sb.env`, because `live.mjs` reads env at import. Use `fakeClaudeRunner(script)`, which
  records calls and returns scripted `{code, stdout, stderr}`.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** the adapter, the hook and the `live.mjs` change.
- [ ] **Step 4: Run** the model-coordinator suite and the handoff-launch suite. Expected: PASS.
- [ ] **Step 5: Commit** `claude-adapter.mjs`, `deliver-hook.mjs`, `live.mjs`, the two tests and `mc-helpers.mjs`:
  `feat(model-coordinator): Claude worker adapter and message delivery hook`.

### Task 10a: Codex adapter, part 1 (worktree, brief, spawn, poll, queue, quarantine)

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high` + **Codex review**.

**Files:**
- Create: `claude/skills/model-coordinator/codex-adapter.mjs`
- Create test fake: `tests/fake-codex-run.mjs`.
  - It parses the `codex-run` argv and reads the scenario JSON named by `FAKE_RUN_SCENARIO`: `{status, reason,
    delay_ms, files: {path: text}, die_without_line, run_id}`.
  - It writes files into `--cwd`, sleeps, and appends a summary line `{ts, run_id, task, mode, status}` to
    `<CLAUDE_CONFIG_DIR>/state/codex/runs.jsonl`.
  - It prints one JSON line `{run, status, reason, mode, model, model_downgraded: false, secs, files, checks: [],
    host_checks: [], codex_note, week_pct: 10, orphans: []}`.
  - It writes the names of its env vars to `FAKE_ENV_DUMP` when that is set.
- Test: `tests/codex-adapter.test.mjs`

**Interfaces:**
- Consumes:
  - the `codex-run.mjs` CLI (`:4-12`):
    - its JSON line is `{run, status: done|failed|blocked, reason, ...}`, and it always exits 0;
    - `--continue <run>` (`:393-400`) checks HEAD and residue (`lib/guards.mjs:107-120`); a mismatch gives
      `continue-mismatch: ...`;
    - `--cwd` must be a linked worktree (`:661`), and a fresh write run needs a clean tree (`:402-407`);
    - blocked reasons include `worktree-busy`, `worktree-quarantined: ...` and `codex-slots-full...` (`:669-682`).
  - the Codex ledger `<CFG>/state/codex/runs.jsonl` (`lib/paths.mjs:14`), with a `task` field (`codex-run.mjs:246`);
  - `codexGate`, `fallbackFor`, `createAllowance` (Task 8); store and `childEnv` (Task 6).
- Produces `createCodexAdapter({cfg, repo, lib, allowance, login, deps})`, where `deps = {spawn, codexRunPath, now,
  git}`. It has:
  - `ensureWorktree(worker)` returns `{ok, worktree, branch} | {ok: false, reason}`.
    - It creates `<repo>/.claude/worktrees/codex-<workerId>` on branch `codex-<workerId>` from `HEAD`
      (`git -C <repo> worktree add -b <branch> <path> HEAD`).
    - It is idempotent for the worker's own path, and refuses a path that exists but is not that worker's.
  - `start(worker, instruction, {requestId, mode = "fresh", prevRunId = null})` returns one of:
    - `{started: attemptId, existing?: true}`;
    - `{queued: attemptId, existing?: true}`;
    - `{blocked: kind, reason, fallback}`;
    - `{clarify: reason}`.

    In 10a `mode` is always `"fresh"` (10b adds `planRun`, which picks the mode).
  - `poll()` persists finished attempts and returns their events. It drains the queue (rechecking the full gate when a
    queued job actually starts, Resolution C).
  - `status(worker)`.
  - `quarantineHint(reason, worktree)`.
- Attempt lines in `codex-attempts.jsonl`:
  `{attempt_id, worker_id, request_id, seq, state, pid?, run_id?, head_before?, out: "codex-out/<attempt>.out",
  brief, result?, at}`.
  - `state` is one of `queued | reserved | spawned | done | failed | blocked | unknown`.
  - The newest line per `attempt_id` wins.
  - `attemptsByRequest(requestId)` returns the attempts recorded for one request.

**Key logic.**
- **Idempotency first (crash recovery, I4).** Before the gate, `start` looks up `codex-attempts.jsonl` for a line
  with this `request_id`. If one exists in any state, it returns that attempt (`{started|queued: attempt_id,
  existing: true}`, or its final state) and spawns nothing. Only a request with no attempt line reaches the gate.
- **Brief.** The fields follow `templates/write.md`:
  - `# Task <workerId>.<seq>: <label>`;
  - `Goal:` the original objective, the durable constraints and the prior validated result (`summary`,
    `files_changed`), then `New instruction: <text>`;
  - ``Files you own: `**` ``, then `Do not create or edit anything else.`;
  - `Builds on: <head_before or none>`;
  - `Done when: the new instruction is done; report what changed`;
  - `Constraints: never commit; never touch files outside this worktree; fake data uses ...@example.com`.

  It is written with `writeNew("briefs/<workerId>.<seq>.md")`. A `secret-in-brief` block is surfaced to the user
  as-is.
- **Spawn (Resolution B).** Hold `allowance.withLock` around the request-id lookup, the gate and the reservation.
  Then:
  1. Append `{state: "reserved", request_id, head_before}`.
  2. `fd = store.openOut(out)`, `fdErr = store.openOut(err)`.
  3. Spawn:

     ```js
     deps.spawn(process.execPath, [codexRunPath, "--brief", brief, "--cwd", wt, "--mode", "write",
       "--model", cfg.codex.model, "--effort", cfg.codex.effort, "--task", `${workerId}.${seq}`,
       ...(mode === "continue" ? ["--continue", prevRunId] : [])],
       { detached: true, windowsHide: true, stdio: ["ignore", fd, fdErr], env: childEnv() })
     ```

  4. `unref()`, then append `{state: "spawned", pid}`.

  A spawn error appends `blocked` and releases the reservation.

  `childEnv()` drops `HL_SESSION_ID` on purpose. `codex-run`'s lane check (`lib/guards.mjs:67-92`) then takes the
  hand-opened path, where any worktree is fine unless another live lane owns it. That is right for a dispatcher-made
  `codex-<id>` worktree that belongs to no registry lane. Do not pass a registry id in.
- **Poll.** For each `spawned` attempt, read the out file. On a complete JSON line:
  - append `{state: result.status, run_id: result.run, result: compact}` and release the reservation;
  - set the worker status:
    - `done` gives `waiting_for_user`, with the summary from `codex_note` (200 characters), `files_changed =
      result.files`, and blockers from failed checks;
    - `failed` gives `failed`;
    - `blocked` gives `blocked`. If the reason is `worktree-busy` or starts with `codex-slots-full`, the attempt is
      requeued (at most 3 requeues, then `blocked`). If the reason starts with `worktree-quarantined`, the blockers
      get `quarantineHint`, which is the text `node "<codexSkillDir>/codex-run.mjs" --clear-quarantine "<worktree>"`
      for the user. The dispatcher never runs it.

**MUST:**
- M1. `ensureWorktree` creates a linked worktree on `codex-<id>`; a second call is a no-op. A foreign existing path
  gives `{ok: false}`.
- M2. `start`, with the gate OK (injected `lib` with fake `busySlots` 0 and a null reading, `login` = `chatgpt`),
  spawns once:
  - it passes `detached: true`, `windowsHide: true` and stdio to the out file (an injected `deps.spawn` records the
    args);
  - its env has no credential name in any case, no `HL_SESSION_ID` and no other `HL_*`;
  - it appends `reserved`, then `spawned`;
  - `poll()` after the fake ends gives worker status `waiting_for_user`, with `files_changed` from the fake.
- M3. Worker failure: fake `{status: "failed", reason: "codex-exit 1"}` gives worker `failed` and the reservation is
  released (`allowance.active() === 0`).
- M4. Codex busy (Spec): with `max_parallel_jobs: 1` and one run in flight (`delay_ms: 1500`), a second worker's
  `start` returns `queued` and holds no slot. The first run is not touched. After it ends, `poll()` starts the queued
  one (the gate is rechecked).
- M5. Quarantine: fake `{status: "blocked", reason: "worktree-quarantined: head-moved"}` puts the hint in the worker
  blockers. No `--clear-quarantine` call is ever spawned (assert on the spawn log).
- M6. No double spawn on retry (I4):
  - `start` called twice with the same `requestId` (the second after the first spawned) gives the same
    `attempt_id` with `existing: true`, and the spawn log has one entry;
  - the same holds when the second call comes from a fresh adapter instance over the same state folder (a restart);
  - the same holds for a request that is still `queued`.

- [ ] **Step 1: Write the failing tests** with:
  - `mcEnv()` and a real temp repo (`git init`, one commit by `test@example.com`);
  - the fake `codex-run` as `deps.codexRunPath`;
  - real `child_process.spawn`, except where an arg-recording spawn is named.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** `codex-adapter.mjs` (part 1).
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** `codex-adapter.mjs`, `fake-codex-run.mjs`, `codex-adapter.test.mjs` and `mc-helpers.mjs`:
  `feat(model-coordinator): Codex worker adapter (worktree, spawn, poll, queue)`.
- [ ] **Step 6: Codex review** of the commit diff. Focus:
  - detached spawn and the out file;
  - request-id idempotency;
  - worktree isolation and the lane-check path;
  - quarantine handling.

### Task 10b: Codex adapter, part 2 (transitions, continuation, restart reconcile)

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high` + **Codex review**.

**Files:**
- Modify: `claude/skills/model-coordinator/codex-adapter.mjs` (add `planRun`, `reconcile`; `start` uses `planRun`)
- Test: `tests/codex-continue.test.mjs` (new)

**Interfaces:**
- Consumes: 10a's adapter, its attempts ledger and the fake `codex-run`.
- Produces:
  - `planRun(worker, attempts, {widen})` returns `"fresh" | "continue" | "queue" | "clarify"`.
  - `start` calls it when no attempt exists for the request:
    - `continue` passes `--continue <last run_id>`;
    - `queue` queues;
    - `clarify` returns `{clarify}`.
  - `reconcile()` runs at startup, before the first `poll()`.

**Key logic.**
- **Transitions (Resolution B), `planRun`:**
  1. A last attempt in `queued`, `reserved` or `spawned` gives `queue`.
  2. No last attempt, or a clean tree and HEAD equal to `head_before`, gives `fresh`.
  3. `widen` (an explicit `--own` request) on a dirty tree gives `clarify`.
  4. A dirty tree, HEAD equal to the last `head_before`, and a last attempt `done` with a `run_id` gives `continue`.
  5. A clean tree and HEAD moved (the user committed) gives `fresh` (new scope).
  6. Anything else gives `clarify`. That covers a dirty tree with HEAD moved, or a dirty tree after a failed or
     blocked run.

  HEAD and cleanliness come from `git -C <wt> rev-parse HEAD` and `git -C <wt> status --porcelain`.
- **Reconcile (Resolution B).**
  - A `reserved` attempt with no `spawned` line: append `blocked: not-spawned`.
  - A `spawned` attempt:
    - an out file with a JSON line: persist it;
    - else, if the pid is alive (`process.kill(pid, 0)`) and the attempt is younger than `timeout-min` (30) + 10 min,
      keep it reserved and watch it;
    - else, a Codex ledger line with `task === "<workerId>.<seq>"`: persist `{state: ledger.status, run_id}`;
    - else append `unknown`. The worker keeps its worktree and its status becomes `unknown`.
  - Rebuild the allowance from the reserved and spawned attempts that are still watched.
  - PID reuse is an accepted residual. `process.kill(pid, 0)` cannot tell a reused pid from the original. The
    40-minute age bound limits the damage: a reused pid at worst keeps one own-cap slot reserved, and the worker
    `running`, until the attempt passes 40 minutes. Then the ledger or `unknown` path takes over. No process is ever
    killed by pid. Large-org variant: record the process start time and compare it, as `live.mjs` `checkHost` does
    for window hosts.

**MUST:**
- M1. `planRun`: one test per transition rule (6 rules) on a real temp repo and worktree (`git` via
  `execFileSync`).
- M2. Continue:
  - after a `done` attempt that left residue, with HEAD unchanged, the next `start` passes `--continue <run_id>`;
  - after a commit in the worktree (clean and moved), the next `start` is `fresh`, without `--continue`;
  - a dirty tree with HEAD moved gives `{clarify}` and no spawn.
- M3. Reconcile (Review Focus 5):
  - a `spawned` attempt whose out file has the line is persisted;
  - one with a live pid (a `node -e "setTimeout(()=>{},3000)"` child) stays reserved and `active()` is 1;
  - one with a dead pid and a ledger line is persisted from the ledger;
  - one with neither becomes `unknown`, and the worker keeps its worktree;
  - a `reserved`-only attempt becomes `blocked: not-spawned`;
  - one with a live pid but older than 40 minutes (backdated `at`) is not watched; it takes the ledger or `unknown`
    path.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** `planRun` and `reconcile`, and wire `planRun` into `start`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** `codex-adapter.mjs` and `codex-continue.test.mjs`:
  `feat(model-coordinator): Codex continuation rules and restart reconcile`.
- [ ] **Step 6: Codex review** of the commit diff. Focus:
  - `--continue` preconditions against `continueCheck`;
  - reconcile against `runs.jsonl`;
  - the PID-reuse residual.

### Task 11: Dispatcher and turn loop (validate, idempotency, fallback, workspace conflict, dead/finished workers)

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/dispatcher.mjs`, `coordinator.mjs`
- Test: `tests/dispatcher.test.mjs`, `tests/coordinator.test.mjs`

**Interfaces:**
- `createDispatcher({cfg, store, claude, codex, workersView, now})` returns `{dispatch(decision, {turnId}), status(ids)}`:
  - `dispatch` returns `{reply, results: [{target?, ok, path?, reason?}], requestId, duplicate: boolean}`;
  - `workersView()` returns the live `Worker[]`. It is the fold from Task 6 merged with `claude.status` and
    `codex.status`.
- `requestIdOf(turnId, d)` is `sha256(turnId | action | sorted targets | worker_instruction ?? "" | label ?? "")`, as
  32 hex characters.
- `createCoordinator({cfg, store, provider, dispatcher, workersView, codexState, costState, now})` returns
  `{handleLine(text, {turnId}), focus()}`. `handleLine` returns `{reply, decision?, rule?, dispatched?, notices[]}`.

**Key logic.**
- **Idempotency.**
  1. Before acting, read `dispatch.jsonl`. A `done` line with this `request_id` means: return its stored result with
     `duplicate: true` and do nothing else.
  2. Otherwise append `{request_id, turn_id, action, targets, state: "intent", at}`, act, then append `{request_id,
     state: "done" | "failed", results}`.
  3. An `intent` line without a `done` line (crash recovery) acts again. The acts themselves are idempotent: message
     files use `writeNew` with the request id; create looks up the label in the worker table; Codex attempts are
     keyed by `request_id`.
- **Actions.**
  - `message_session` and `message_multiple` act per target (sub-id `<rid>:<target>`). For a Claude worker,
    `claude.message`. For a Codex worker, `codex.start`, which may answer queued or clarify. The reply has one line per
    target, naming the delivery path:
    - "delivered at its next tool call";
    - "woke the idle worker";
    - "queued until it next runs";
    - "queued behind its current Codex run".
  - `create_session`:
    1. The provider is `new_session.provider ?? "claude"`.
    2. Check workspace ownership (below).
    3. Write the `created` event. It carries `in_worktree_of` (from `/new ... --in <ref>`) and `fallback_of` (when
       this worker replaces a refused Codex request). These two fields are the producer of the records file's
       `## Task relationships`.
    4. For Claude, `claude.create`.
    5. For Codex:
       - `codex.ensureWorktree`, then `codex.start`.
       - On `blocked`, apply `fallbackFor`:
         - `claude` ends the Codex worker (`{ev: "ended", why: "fallback: <reason>"}`) and creates a Claude worker
           with the same label and objective and `fallback_of: <codex worker id>`. The reply says "Codex unavailable
           (<reason>): started a Claude worker instead".
         - `refuse` replies with the reason.
         - There is no `paid_api` path in V1 (see Deferred).
       - On `clarify`, reply.
    6. **A failed create never leaves a phantom.** If `claude.create`, `codex.ensureWorktree` or `codex.start`
       returns `{ok: false}` (cap, launcher failure, worktree refused), or the fallback is `refuse`, the same
       dispatch appends `{ev: "ended", worker_id, why: "<reason>"}`. That folds to status `dead`, which is in
       `FINISHED`, so the label is free again (`validate.mjs` `label-in-use` checks only non-finished workers). The
       reply names the reason.
  - `request_status` replies deterministically: `<id> (<provider>) <status> - <summary>; blockers: ...; needs you:
    ...`. With no targets it covers all workers.
  - `respond` and `clarify` reply only.
  - Every action applies `record_update`: alias events, a focus event, and re-rendering `coordinator_records.md`
    with notes. This is the only place model text reaches a file.
- **Workspace conflict (`WorkerWorkspace {worker_id, provider, worktree, branch, status}`).** Refuse with a
  `clarify` reply when any of these hold:
  - the new worktree path or branch equals one owned by a non-finished worker (any provider);
  - it equals the worktree of a registry lane whose liveness is not `gone`;
  - the request is `/new codex <label> --in <ref>` and `<ref>` is not finished. The clarify reply offers "a new
    worktree from its branch". When `<ref>` is finished, the Codex worker gets that worktree.
- **Turn loop (`handleLine`).**
  1. Run `resolveLine`.
  2. A `decision` result: `validateDecision`, then dispatch.
  3. A `model` result:
     - build the input and call `provider.decide`;
     - validate. Invalid: re-ask once with `validation_errors` (codes and fields only). Invalid again: reply with a
       `clarify` text listing the workers. Nothing is dispatched;
     - `lowConfidence(d, cfg.min_confidence)` turns the decision into a `clarify` reply from
       `d.clarification ?? "Which worker do you mean? ..."`;
     - Any `ProviderError` (Task 5, `provider.mjs`) gives the reply "Luna is unavailable (<code>: <message>). Use /to
       <id> <text>, /status, /new ...". Shortcuts keep working. This covers Task 12's `SpendBlocked`, which extends
       `ProviderError` with code `hard-limit`, and its `reasoning-unsupported` error. `coordinator.mjs` imports only
       `provider.mjs`, so Task 11 does not depend on Task 12. A thrown value that is not a `ProviderError` is a bug and
       propagates.
  4. Append `{turn_id, at, user, reply, action, targets, instruction, rule}` to `exchanges.jsonl`.
  5. Update the focus: the single target of a message, or the created worker.
  6. Add the cost and Codex notices to `notices[]`.

**MUST:**
- M1. Duplicate dispatch: the same decision and `turnId` dispatched twice gives one message file and one
  `claude.message` call, and the second result has `duplicate: true`. A crash simulated after `intent` (throw inside
  the act once) and re-dispatched gives exactly one message file.
- M2. Nonexistent session: a model decision targeting `ghost-01` is re-asked once. It is then a clarify reply, and
  the mock saw 2 calls with `validation_errors[0].code === "unknown-target"` on the second.
- M3. Completed worker: a message to a `finished` worker gives a clarify reply naming it as finished and suggesting
  `/new`. A message to a `dead` one suggests `/restart-closed`. No adapter is called.
- M4. Multiple targets: `message_multiple` to a Claude and a Codex worker gives one result each, with the right
  adapter call.
- M5. Claude fallback: a Codex create whose gate gives `exhausted` creates a Claude worker (fake adapters). The reply
  contains "started a Claude worker instead". An existing Codex worker's follow-up under `exhausted` is refused with
  no migration.
- M6. Workspace conflict:
  - `/new codex fix --in auth-01` while `auth-01` is running gives clarify with no worktree or attempt;
  - after `auth-01` is finished, the same command succeeds in `auth-01`'s worktree;
  - a create whose label equals a live worker's gives `label-in-use` and then clarify.
- M7. Invalid twice: clarify, nothing dispatched, `dispatch.jsonl` unchanged (Review Focus 3).
- M8. `/to auth-01 <10k chars>` delivers the whole text: the message file holds 10000 characters (Review Focus 1).
- M9. `record_update` with a valid alias re-renders `coordinator_records.md`, which lists the alias. A `record_update`
  whose note contains `"../../src/x.ts"` changes only `coordinator_records.md`: the repo `git status --porcelain`
  stays empty and a hash of the state folder shows only the ledgers and the records file changed.
- M10. The focus follows the last single target and the created worker.
- M11. A failed create leaves no phantom (I5). With a fake `claude.create` returning `{ok: false, kind: "cap"}`,
  `/new claude auth do x`:
  - replies with the cap reason;
  - the worker table has `auth-01` with status `dead`;
  - a second `/new claude auth do x` (fake now OK) creates `auth-02` with no `label-in-use`.

  The same holds for a Codex create whose `ensureWorktree` fails, and for a fallback `refuse`.
- M12. A `ProviderError("hard-limit")` thrown by the mock gives the "Luna is unavailable" reply, and a `/to`
  shortcut in the next line still dispatches. A plain `Error` thrown by the mock propagates.
- M13. Fallback relationships: after M5's fallback, the Codex worker is `dead` with why `fallback: …`, the Claude
  worker has `fallback_of`, and `coordinator_records.md` `## Task relationships` lists it.

- [ ] **Step 1: Write the failing tests** with fake `claude` and `codex` adapters (recording objects), the real store
  under `mcEnv()`, and `MockCoordinatorProvider`.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** `dispatcher.mjs` and `coordinator.mjs`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** the 2 modules and 2 tests: `feat(model-coordinator): validated dispatcher and turn loop`.

### Task 12: Cost ledger, soft and hard limits, `OpenAILunaProvider`

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/cost.mjs`, `openai-provider.mjs`
- Test: `tests/cost.test.mjs`, `tests/openai-provider.test.mjs`

**Interfaces:**
- `cost.mjs`:
  - `priceOf(cfg, model)` returns the price table or null.
  - `callCost(p, {input, cached, output})` and `worstCase(p, estInput, maxOut)` (USD).
  - `monthKey(ms)`, `monthSpend(lines, now)`.
  - `spendGate({spent, worst, limits})` returns `{allow, state: "ok" | "soft" | "hard", reason?}`.
  - `class SpendBlocked extends ProviderError` (imported from `provider.mjs`, Task 5), with code `hard-limit`. Task 11
    catches it as a `ProviderError`, so it needs no import from this task.
  - `createMeter({cfg, store, now})` returns `{check(estInputTokens), record(entry), state()}`. `state()` returns
    `{spent_usd, soft, hard, state}`.
- `openai-provider.mjs`:
  - `createOpenAILunaProvider({cfg, meter, fetch = globalThis.fetch, sleep, now, apiKey})` throws `ConfigError` when:
    - `cfg.provider !== "openai"`;
    - there is no key (from `OPENAI_API_KEY`, or `cfg.openai.key_file` inside `secretsDir()`);
    - `priceOf(cfg, cfg.openai.model)` is null.
  - It returns `{decide(input)}`.

**Full code (subtle): the limit.**

```js
export function priceOf(cfg, model) {
  const p = cfg.pricing?.[model];
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return p && ok(p.input_per_mtok) && ok(p.cached_input_per_mtok) && ok(p.output_per_mtok) ? p : null;
}
export const callCost = (p, { input, cached, output }) =>
  ((Math.max(0, input - cached)) * p.input_per_mtok + cached * p.cached_input_per_mtok + output * p.output_per_mtok) / 1e6;
export const worstCase = (p, estInput, maxOut) => (estInput * p.input_per_mtok + maxOut * p.output_per_mtok) / 1e6;
export const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7); // UTC month
export const monthSpend = (lines, now) => lines.filter((u) => u.month === monthKey(now)).reduce((s, u) => s + (Number(u.cost_usd) || 0), 0);
// import { ProviderError } from "./provider.mjs";  (Task 5: constructor(code, message, {retryable}))
export class SpendBlocked extends ProviderError { constructor(reason) { super("hard-limit", reason, { retryable: false }); } }
export function spendGate({ spent, worst, limits }) {
  if (spent >= limits.monthly_hard_usd) return { allow: false, state: "hard", reason: `monthly hard limit $${limits.monthly_hard_usd} reached ($${spent.toFixed(2)})` };
  if (spent + worst > limits.monthly_hard_usd) return { allow: false, state: "hard", reason: `this call could pass the hard limit ($${spent.toFixed(2)} + up to $${worst.toFixed(4)})` };
  return { allow: true, state: spent >= limits.monthly_soft_usd ? "soft" : "ok" };
}
export function createMeter({ cfg, store, now = Date.now }) {
  const p = priceOf(cfg, cfg.openai.model);
  const spent = () => monthSpend(store.readJsonl("usage"), now());
  return {
    check(estInputTokens) {                              // before EVERY attempt, retries included
      if (!p) throw new SpendBlocked("no price table: set pricing in config.json");
      const g = spendGate({ spent: spent(), worst: worstCase(p, estInputTokens, cfg.openai.max_output_tokens), limits: cfg.limits });
      if (!g.allow) throw new SpendBlocked(g.reason);
      return g;
    },
    // usage missing (timeout, network error after send, malformed body): charge the worst case, never 0
    record({ requestId, attempt, usage, estInputTokens, latencyMs, retries, outcome }) {
      const u = usage ?? null;
      const cost = u ? callCost(p, { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0 })
        : worstCase(p, estInputTokens, cfg.openai.max_output_tokens);
      store.appendJsonl("usage", { at: new Date(now()).toISOString(), month: monthKey(now()), model: cfg.openai.model, request_id: requestId,
        attempt, input_tokens: u?.input_tokens ?? null, cached_input_tokens: u?.input_tokens_details?.cached_tokens ?? null,
        output_tokens: u?.output_tokens ?? null, latency_ms: latencyMs, retries, cost_usd: cost, estimated: !u, outcome });
    },
    state() {
      const s = spent();
      return { spent_usd: s, soft: cfg.limits.monthly_soft_usd, hard: cfg.limits.monthly_hard_usd,
        state: s >= cfg.limits.monthly_hard_usd ? "hard" : s >= cfg.limits.monthly_soft_usd ? "soft" : "ok" };
    },
  };
}
```

**OpenAI provider logic.**
- **Request.** `POST https://api.openai.com/v1/responses` with headers `Authorization: Bearer <key>` and
  `Content-Type: application/json`. Body:

  ```js
  { model, store: false, max_output_tokens,
    ...(cfg.openai.reasoning_effort === null ? {} : { reasoning: { effort: cfg.openai.reasoning_effort } }), // default "none"
    input: [{ role: "developer", content: instructions }, { role: "user", content: JSON.stringify(inputWithoutInstructions) }],
    text: { format: { type: "json_schema", name: "coordinator_decision", strict: true, schema: DECISION_SCHEMA } } }
  ```

  The body has no `tools` and no `tool_choice`. `reasoning.effort: "none"` depends on the model: the official guide
  says Astra and Sol reject it with HTTP 400. Hence the config knob (A2).
- **Attempts.** There are `1 + max_retries` attempts. Each runs `meter.check(est)` first, then uses an
  `AbortController` timeout of `timeout_ms`.
  - Retryable: network errors, timeouts, 429, and 500/502/503/504.
  - The 429 wait is `retry-after` (seconds, capped at 20 s), else `500 * 2^n` ms. It uses the injectable `sleep`.
  - 400, 401, 403 and 404 throw `ProviderError("http-<status>", ..., {retryable: false})` at once.
  - A 400 whose body text mentions `reasoning` throws
    `ProviderError("reasoning-unsupported", "the model rejected reasoning.effort=<value>: set openai.reasoning_effort in config.json (null omits it)")`.
    The reply shows this message, so the user sees the knob.
  - Every attempt calls `meter.record(...)`.
- **Parse.**
  - `status !== "completed"` gives `ProviderError("incomplete")`.
  - The first `output[].type === "message"` content item is used. Type `refusal` gives `ProviderError("refusal")`.
    Type `output_text` is parsed with `JSON.parse`; a failure gives `ProviderError("not-json")`.
  - The parsed decision goes back to `coordinator.mjs`, which validates it (Task 11).

**MUST:**
- M1. `spendGate`:
  - spent 6.99, worst 0.001 gives `ok`;
  - spent 7.0 gives `soft`;
  - spent 9.999, worst 0.002 gives `hard` (it would pass the limit);
  - spent 10 gives `hard`.
- M2. Previous month: usage lines from `2026-09` do not count in `2026-10` (Review Focus 4).
- M3. Fail closed. The constructor throws without pricing, without a key, and with `provider: "none"`. The meter
  throws `SpendBlocked("no price table...")` when the price table is missing.
- M4. Request shape (fake fetch captures the request):
  - model `gpt-6-luna`, `reasoning.effort === "none"` by default;
  - with `openai.reasoning_effort: "low"`, the body has `reasoning.effort === "low"`; with `null`, the body has no
    `reasoning` key;
  - `text.format.strict === true`, `schema === DECISION_SCHEMA` (deep equal);
  - no `tools` or `tool_choice` keys;
  - the Authorization header holds the fake key;
  - `store === false`.
- M5. A 429 with `retry-after: 2` is followed by a 200. The fake sleep saw 2000 ms, two usage lines were recorded,
  and `retries` is 1 on the second.
- M6. Bounded: 3 straight 503s throw `ProviderError("http-503")` after exactly 3 fetches. A 401 throws after 1.
- M7. Timeout: the fake fetch never resolves (it honours the abort signal), so `ProviderError("timeout")` is thrown
  after `1 + max_retries` attempts, and each recorded the worst-case cost (`estimated: true`).
- M8. Hard limit before spend: with spent at $9.99 and a worst case above $0.01, `decide` throws `SpendBlocked` and
  the fake fetch was called 0 times. The coordinator reply (via Task 11 `handleLine`) says the hard limit is reached,
  and a `/to` shortcut still dispatches.
- M9. Refusal, `status: "incomplete"` and non-JSON `output_text` each give their `ProviderError` codes (Review
  Focus 3).
- M10. The usage line has `input_tokens`, `cached_input_tokens` (from `usage.input_tokens_details.cached_tokens`),
  `output_tokens`, `latency_ms`, `retries` and `cost_usd`, matching `callCost` for the fake usage.
- M11. A 400 with body `{"error": {"message": "Unsupported value: 'reasoning.effort' does not support 'none'"}}`
  throws `ProviderError("reasoning-unsupported")` after 1 fetch. Its message names `openai.reasoning_effort`.
  `SpendBlocked` is `instanceof ProviderError` with code `hard-limit`.

- [ ] **Step 1: Write the failing tests** with a fake `fetch(url, init)` driven by a script of responses: `{status,
  headers, json}`, `"hang"`, or `"network"`.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** `cost.mjs` and `openai-provider.mjs`.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** the 2 modules and 2 tests:
  `feat(model-coordinator): cost meter with hard limit, OpenAI Luna provider`.

### Task 13: CLI REPL, single instance, `coordinator.cmd`, restart closed sessions, status

Implementer: sonnet `worker-medium`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/cli.mjs`, `instance.mjs`, `coordinator.cmd`
- Test: `tests/cli.test.mjs`, `tests/instance.test.mjs`

**Interfaces:**
- `instance.mjs`:
  - `acquireInstance(name = process.env.MC_PIPE_NAME || "model-coordinator")` returns `{server} | {taken: {pid,
    started_at} | null}`. It listens on `\\.\pipe\<name>`, the same pattern as `lib/locks.mjs:36`.
  - On success it writes `instance.json` `{pid, started_at}` through the store.
- `cli.mjs [--repo <dir>] [--status [--json]] [--once "<line>"] [--yes | --no]`:
  - It sets `process.env.HL_MODEL_COORDINATOR = "1"`.
  - `repo` is `--repo`, else `git rev-parse --show-toplevel` of the cwd, else null. Creates then reply "start the
    coordinator inside a git repo or pass --repo".
  - It loads the config; config errors print and exit 2.
  - It acquires the instance. If taken, it prints `coordinator already running (pid <n>, since <t>)` and exits 1.
  - It builds the provider:
    - `none` gives `NullProvider`;
    - `openai` gives `createOpenAILunaProvider`. A `ConfigError` prints and falls back to `NullProvider` with a
      notice.
    - The mock is never selectable from config.
  - It runs `codex.reconcile()`.
  - It prints the worker status (`request_status` for all).
  - It lists `closedUnfinished(liveLaneStatus())`. If any exist, it asks `Restart closed sessions? (y/n)`; `--yes`
    or `--no` answers non-interactively. On yes it runs `launch.mjs resume --closed --all` under `launchEnv()` (Task
    6) and prints its output. `launchEnv()` keeps `HL_*`, so a test's `HL_REGISTRY_DIR` and `HL_NO_SPAWN` reach the
    launcher. Never use `childEnv()` here.
  - Then the REPL runs (`node:readline`). Lines are processed strictly in order, through a promise queue. A 5 s timer
    runs `codex.poll()` and prints worker completion notices above the prompt. Ctrl+C or `/quit` releases the pipe and
    exits 0 without touching workers.
  - `--status` prints the status and exits 0. `--once` processes one line, prints the reply and exits (tests).
- `coordinator.cmd`:

```bat
@echo off
setlocal
if defined CLAUDE_CONFIG_DIR (set "MC_CFG=%CLAUDE_CONFIG_DIR%") else (set "MC_CFG=%USERPROFILE%\.claude")
node "%MC_CFG%\skills\model-coordinator\cli.mjs" %*
```

**MUST:**
- M1. A second instance (the test holds the pipe and `instance.json`) prints `already running (pid …` and exits 1.
  The first instance is unaffected.
- M2. `--once "/to <id> hi"`, against a sandbox with a live fake bg lane, exits 0, prints a reply naming the delivery
  path, and leaves one message file.
- M3. `--status --json` prints workers and `{cost: {...}, codex: CodexResourceState}`.
- M4. Startup with a crashed lane and `--yes` runs `resume --closed --all`:
  - a new registry line with `supersedes` lands in the sandbox registry, and the real registry is untouched;
  - the run has `OPENAI_API_KEY=x` in the coordinator's env, and a `HL_FAKE_CLAUDE`-recorded launch shows it never
    reached the child.

  With `--no` nothing is launched.
- M5. With `provider: "none"`, an ambiguous line replies "Luna is unavailable (no-provider) ..." and a `/to` still
  works.
- M6. Config errors (sonnet as the Claude model) print the reason and exit 2.
- M7. `coordinator.cmd` contains no absolute personal path. A test asserts that it does not match
  `/[A-Z]:\\Users\\/i` and that it references `skills\model-coordinator\cli.mjs`.

- [ ] **Step 1: Write the failing tests.** Spawn `cli.mjs` with the sandbox env, `stdin: "ignore"`, `windowsHide`,
  and timeout 60 s.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Commit** the 3 files and 2 tests: `feat(model-coordinator): coordinator CLI, single instance, shim`.

### Task 14: End-to-end spec tests on the mock provider + docs

Implementer: sonnet `worker-high`. Reviewer: opus `worker-high`.

**Files:**
- Create: `claude/skills/model-coordinator/tests/e2e.test.mjs`, `claude/skills/model-coordinator/SKILL.md`
- Append `mcSandbox()` to `tests/mc-helpers.mjs`.
- Modify: `README.md` (one row in the skills table, after the `handoff-launch` row at `README.md:19`) and
  `INSTALL_PROMPT.md` (one install line and one verification line, next to the handoff-launch verification at
  `INSTALL_PROMPT.md:101`)

**Interfaces:**
- `mcSandbox()` combines the handoff-launch `sandbox()` (registry, repo, `CLAUDE_CONFIG_DIR`, agents file), a temp
  `CODEX_HOME`, `MC_PIPE_NAME`, `CODEX_RUN_PIPE_PREFIX`, `CODEX_RUN_BIN=node` with
  `CODEX_RUN_BIN_ARGS=[fake-codex-cli.mjs]`, `FAKE_LOGIN=chatgpt`, and the fake `codex-run` path. It has:
  - `makeLive(workerId, status)`, which appends a bg launch line for the lane and sets the agents list so the lane
    reads running or idle;
  - `coordinator(script)`, which builds `createCoordinator` with `MockCoordinatorProvider(script)` (default
    `lunaLikePolicy`), real store, real adapters, `fakeClaudeRunner`, and `codex.poll` exposed;
  - `say(line)`, which returns the reply.

**The spec's test list.** One named `test("spec: <item>")` per item:

| Spec item | Scenario and assertion |
|---|---|
| explicit worker reference | `say("auth-01: keep going")` gives a message file for `auth-01`, rule `explicit-id`, mock `calls.length === 0` |
| alias reference | `/alias auth-01 login worker`, then `say("tell the login worker to retry")` routes to `auth-01`, rule `alias` |
| focused-session follow-up | after `/to auth-01 ...`, `say("also add tests")` routes to `auth-01`; the mock saw `focused_session_id === "auth-01"` |
| "him" | `say("tell him not to change the backend")` gives `auth-01` (focused) |
| "that one" | `say("have that one rerun the tests")` gives `auth-01` |
| "the other one" | after messages to `invoice-01` then `auth-01`, `say("have the other one check it too")` gives `invoice-01` |
| "do that for both" | `say("do that for both")` gives `message_multiple` to both, instruction = the previous instruction |
| "continue" | one live worker: `say("continue")` dispatches with no model call; two live: the mock is called and routes to focused |
| new worker creation | `say("make another worker for the migration")` gives a Codex worker `migration-01`: worktree `codex-migration-01`, attempt spawned, fake run done gives `waiting_for_user` |
| multiple targets | `/to auth-01,invoice-01 rebase on main` gives two results with the right adapters |
| ambiguous target → clarification | two live, no focus, no recent: `say("tell him to stop")` gives a clarify reply, nothing dispatched |
| nonexistent session | `/to ghost-09 hi` gives "No worker named ghost-09"; a model decision for `ghost-09` gives a re-ask, then clarify |
| completed worker | `auth-01` lane done marker: `/to auth-01 more` gives a "finished" clarify, no file |
| duplicate dispatch retry | the same `turnId` handled twice gives one message file, the second says already dispatched |
| worker failure | fake run `failed` gives status `failed`, reply on `/status`; Claude `launch.mjs` exit 1 gives `failed` with reason |
| Codex busy | `max_parallel_jobs: 1`, one run in flight: a second Codex create is `queued`, the first untouched, the second starts after `poll()` |
| Codex exhausted | `CODEX_HOME` rollout with week 99 % and a future reset: the Codex create falls back per policy and the reply names `exhausted` |
| Codex unavailable | `FAKE_LOGIN=api_key` (and separately `none`): the Codex create gives fallback, reply `codex-login-api_key`; no `codex-run` spawned |
| Claude fallback | policy `claude` + exhausted gives a Claude worker created via `launch.mjs --mode bg` with the same label |
| parallel Claude/Codex work | a Claude worker (live) and a Codex worker running at once: `/to auth-01,mig-01 ...` delivers a Claude message file and queues the Codex follow-up; worktrees differ; main checkout `git status --porcelain` empty |
| workspace conflict | `/new codex review --in auth-01` while `auth-01` is live gives clarify, no worktree created |
| Luna attempting unauthorized file edit | mock returns `{...decision, edit: {path: "src/a.ts", content: "x"}}`, then `{action: "write_file"}`: both rejected (re-ask, clarify); repo tree byte-identical (hash of all files before and after) |
| Luna cannot modify anything except its own record | after a full scripted session (all decisions above, including `record_update` notes with paths): the repo is identical, and the state folder diff contains only ledgers, briefs, messages, codex-out, instance and `coordinator_records.md`; model-derived strings appear only in `coordinator_records.md` and in message/brief texts (as data, never as paths) |

**MUST:**
- M1. All 23 tests above exist with these names and pass.
- M2. `SKILL.md` covers:
  - what the coordinator is;
  - `coordinator` usage and the commands (`/to`, `/status`, `/new`, `/alias`, `/restart-closed`, `/workers`,
    `/quit`);
  - the config file location and fields;
  - the default `provider: "none"`;
  - how to enable OpenAI (key in env or `<CFG>/secrets/`, prices required);
  - cost limits;
  - Codex fallback policies (`claude`, `refuse`; `paid_api` is deferred to V2 and refused at load);
  - the Luna write rule;
  - the state folder layout.
- M3. The `README.md` row and the `INSTALL_PROMPT.md` lines are added. The verification command is
  `node "CONFIG/skills/model-coordinator/cli.mjs" --status` printing `workers:`.

- [ ] **Step 1: Write the failing e2e tests.**
- [ ] **Step 2: Run** them. Fix bugs only in the module that owns them, and report each fix with its file.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run all three suites.** Expected: PASS.
- [ ] **Step 5: Commit** `e2e.test.mjs`, `mc-helpers.mjs`, `SKILL.md`, `README.md`, `INSTALL_PROMPT.md` and any
  fixed modules, by name: `test(model-coordinator): spec test list end to end; docs`.

### Final review (before Task 15)

- [ ] **Fable whole-build review.** Reviewer: Fable `worker-high`. The diff is `git diff <base>..HEAD`, where
  `<base>` is the commit before Task 1. Focus:
  - the write lock and model-output paths;
  - the dispatcher's validation and idempotency;
  - the Codex gate, attempts and reconcile;
  - the cost hard limit;
  - the credential boundary;
  - the traceability table below (every row's test exists and asserts what the row says).

  It runs the three suites itself. Critical and Important findings get fixed and scoped re-reviewed by opus before
  Task 15.

### Task 15: Deploy to `~/.claude` (gated on the user's OK; a checklist, not run by the implementer)

Owner: the controller, after the user says go. Live runs: sonnet `worker-medium`; the results are reviewed by opus.

- [ ] Ask the user for OK. The deployed `handoff-launch` copy is shared with the batch-B lane, so agree ownership of
  the rebuild with that lane first.
- [ ] Copy:
  - `claude/skills/model-coordinator/` to `~/.claude/skills/model-coordinator/`;
  - `live.mjs`, `launch.mjs` and `status-lib.mjs` to `~/.claude/skills/handoff-launch/`;
  - `lib/usage.mjs` and `lib/locks.mjs` to `~/.claude/skills/dispatching-codex/lib/`;
  - `coordinator.cmd` to `~/.local/bin/`.
- [ ] Create `~/.claude/state/model-coordinator/config.json` with `{"provider": "none"}`. Run the three suites
  against the repo once more, then `coordinator --status` from a non-repo folder.
- [ ] Live check (a scratch repo, not a user project), each run in the foreground with a timeout:
  - `/new claude scratch-a write a hello.txt` gives a bg session (`claude agents --json` lists it);
  - `/to scratch-a-01 ...` while busy gives "delivered at its next tool call" (check the transcript for the
    additionalContext);
  - when idle, `woke the idle worker` (A4: confirm no copy, or that the copy was stopped);
  - `/new codex scratch-b ...` gives a `codex-run` result `done` and status `waiting_for_user`;
  - `/restart-closed` after closing a lane by hand;
  - stop the sessions started; remove the scratch worktrees.
- [ ] Only after the user supplies the key and the gpt-6-luna prices:
  - put the key in `~/.claude/secrets/openai-api-key` and the prices in config;
  - set `provider: "openai"`;
  - run 10 benchmark lines (the spec's coreference examples), check usage lines, then set the soft and hard limits.
  - Verify A2: the schema is accepted, and `gpt-6-luna` accepts `reasoning.effort: "none"`. On a
    `reasoning-unsupported` reply, set `openai.reasoning_effort` to the lowest accepted value, or to `null`.
- [ ] Rollback: delete `~/.claude/skills/model-coordinator`, `~/.local/bin/coordinator.cmd` and
  `~/.claude/state/model-coordinator`. Restore the three handoff-launch files and the two Codex lib files from git
  (the `stage2-loop-recovery` tip).

---

## Traceability: the spec's Testing list → tests

| # | Spec item | Proving test(s) |
|---|---|---|
| 1 | explicit worker reference | `e2e.test.mjs` "spec: explicit worker reference"; `resolve.test.mjs` M1 |
| 2 | alias reference | e2e "spec: alias reference"; `resolve.test.mjs` M2 |
| 3 | focused-session follow-up | e2e "spec: focused-session follow-up"; `dispatcher.test.mjs` M10 |
| 4 | "him" | e2e "spec: \"him\""; `resolve.test.mjs` M4 |
| 5 | "that one" | e2e "spec: \"that one\""; `resolve.test.mjs` M4 |
| 6 | "the other one" | e2e "spec: \"the other one\""; `resolve.test.mjs` M4 |
| 7 | "do that for both" | e2e "spec: \"do that for both\""; `resolve.test.mjs` M4 |
| 8 | "continue" | e2e "spec: \"continue\""; `resolve.test.mjs` M3 |
| 9 | new worker creation | e2e "spec: new worker creation"; `claude-adapter.test.mjs` M1, M11; `codex-adapter.test.mjs` (Task 10a) M1-M2 |
| 10 | multiple targets | e2e "spec: multiple targets"; `dispatcher.test.mjs` M4 |
| 11 | ambiguous target → clarification | e2e "spec: ambiguous target → clarification"; `resolve.test.mjs` M5; `dispatcher.test.mjs` M7 |
| 12 | nonexistent session | e2e "spec: nonexistent session"; `validate.test.mjs` M5; `dispatcher.test.mjs` M2 |
| 13 | completed worker | e2e "spec: completed worker"; `validate.test.mjs` M5; `dispatcher.test.mjs` M3 |
| 14 | duplicate dispatch retry | e2e "spec: duplicate dispatch retry"; `dispatcher.test.mjs` M1; `claude-adapter.test.mjs` M3, M3b; `codex-adapter.test.mjs` (Task 10a) M6; `codex-continue.test.mjs` (Task 10b) M3 |
| 15 | worker failure | e2e "spec: worker failure"; `codex-adapter.test.mjs` (Task 10a) M3; `claude-adapter.test.mjs` M2; `dispatcher.test.mjs` M11 |
| 16 | Codex busy | e2e "spec: Codex busy"; `codex-resources.test.mjs` M5-M6; `codex-adapter.test.mjs` (Task 10a) M4 |
| 17 | Codex exhausted | e2e "spec: Codex exhausted"; `codex-resources.test.mjs` M4-M5; Codex `usage.test.mjs` (Task 4 M1-M2) |
| 18 | Codex unavailable | e2e "spec: Codex unavailable"; `codex-resources.test.mjs` M2, M5 |
| 19 | Claude fallback | e2e "spec: Claude fallback"; `dispatcher.test.mjs` M5, M13; `codex-resources.test.mjs` M7 |
| 20 | parallel Claude/Codex work | e2e "spec: parallel Claude/Codex work" |
| 21 | workspace conflict | e2e "spec: workspace conflict"; `dispatcher.test.mjs` M6; `codex-adapter.test.mjs` (Task 10a) M1 |
| 22 | Luna attempting unauthorized file edit | e2e "spec: Luna attempting unauthorized file edit"; `validate.test.mjs` M2-M3; `store.test.mjs` M1-M2 |
| 23 | Luna cannot modify anything except its own record | e2e "spec: Luna cannot modify anything except its own record"; `write-surface.test.mjs` (Task 6 M6); `store.test.mjs` M1-M2; `env.test.mjs` (Task 6 M9); `dispatcher.test.mjs` M9; `claude-adapter.test.mjs` M12 (no shell); `openai-provider.test.mjs` M4 (no tools) |

## Task summary

| Task | Implementer | Reviewer |
|---|---|---|
| 1 env strip | sonnet worker-medium | opus worker-high |
| 2 status-lib | sonnet worker-high | opus worker-high |
| 3 resume --closed | sonnet worker-medium | opus worker-high |
| 4 t10 Codex fixes | sonnet worker-high | opus worker-high + Codex review |
| 5 schema/validator/mock | sonnet worker-high | opus worker-high |
| 6 store/ledgers/records/env | sonnet worker-high | opus worker-high |
| 7 resolver/context | sonnet worker-high | opus worker-high |
| 8 Codex resource manager | sonnet worker-high | opus worker-high + Codex review |
| 9 Claude adapter + hook | sonnet worker-high | opus worker-high |
| 10a Codex adapter part 1 | sonnet worker-high | opus worker-high + Codex review |
| 10b Codex continuation + reconcile | sonnet worker-high | opus worker-high + Codex review |
| 11 dispatcher + turn loop | sonnet worker-high | opus worker-high |
| 12 cost + OpenAI provider | sonnet worker-high | opus worker-high |
| 13 CLI + shim | sonnet worker-medium | opus worker-high |
| 14 e2e + docs | sonnet worker-high | opus worker-high |
| Final | - | Fable worker-high, whole build |
| 15 deploy | controller (gated) | opus reviews live results |

Fable reviews this plan before execution and the whole build once at the end (user rule, 2026-10-07). No per-task
Fable review.

Dependencies (a task starts only after every listed task is merged):

| Task | Needs | Why |
|---|---|---|
| 1 | - | |
| 2 | - | |
| 3 | 2 | `liveLaneStatus` |
| 4 | - | |
| 5 | - | |
| 6 | 5 | `WorkerSummary` and the status sets |
| 7 | 5, 6 | decisions, the worker table, `toSummary` |
| 8 | 4, 6 | fixed `quotaDecision`; `env.mjs`, `paths.mjs` |
| 9 | 1, 2, 6 | 1 and 9 both edit `live.mjs`; `liveLaneStatus`; store and env |
| 10a | 6, 8 | store and env; gate and allowance |
| 10b | 10a | |
| 11 | 5, 6, 7, 9, 10b | it catches `ProviderError` from Task 5, not Task 12 |
| 12 | 5, 6 | `ProviderError`, `DECISION_SCHEMA`; store, `secretsDir` |
| 13 | 3, 8, 11, 12 | `resume --closed`, `config.mjs`, the turn loop, the provider |
| 14 | all | |

Parallel lanes: 1, 2, 4 and 5 can run at once (disjoint files). Then 3 after 2, and 6 after 5. Then 7 and 8. Task 9
waits for 1. Task 12 can run beside 7-10b.
